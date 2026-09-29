import { formatUsdCents, LINE_UNITS } from "@job-to-invoice/schemas";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../crypto/uuid.ts";
import { copy } from "../i18n/en.ts";
import { presentQuotePdf, presentQuotePdfRetry, type QuotePdfDownload } from "../quotes/presentation.ts";
import { retainOrCreateSetupIdempotencyKey } from "../setup/idempotency.ts";
import { useAuth } from "../session/AuthProvider.tsx";
import { colors } from "../theme.ts";
import { ChangeCustomerPreview } from "./customer-preview.tsx";
import {
  extraWorkAnalyticsProperties,
  extraWorkContinueDestination,
  extraWorkFieldErrors,
  beginChangePreviewRequest,
  beginChangePublishRequest,
  changeCustomerEmailPatch,
  changePreviewAfterFailure,
  changeRecipientPlan,
  presentChangeRecipient,
  createExtraWorkSaveGate,
  extraWorkIdempotencyAfterFailure,
  extraWorkLineMeta,
  extraWorkLineTotalCents,
  extraWorkPayload,
  extraWorkPreviewAllowed,
  extraWorkReviewBlocked,
  extraWorkSaveLabel,
  extraWorkTotals,
  presentBlockedChangePublish,
  presentChangePreviewFailure,
  presentChangePublishResponse,
  presentExtraWorkPublished,
  resolveChangeEditorSession,
  saveExtraWorkUntilQuiet,
  isExtraWorkUnit,
  presentChangeEditor,
  type ChangeDraftRecord,
  type ChangePreviewRecord,
  type ChangePublishNotice,
  type ExtraWorkLineForm,
  type ExtraWorkSaveState,
} from "./presentation.ts";
const PRIMARY = "#464B71";
const DANGER = "#B42318";
const SAVE_DEBOUNCE_MS = 500;

function centsToDollars(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = String(Math.abs(cents % 100)).padStart(2, "0");
  return `${whole}.${frac}`;
}

function taxLabel(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const frac = basisPoints % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`.replace(/0$/, "");
}

function linesFromDraft(draft: ChangeDraftRecord): ExtraWorkLineForm[] {
  return draft.additions.map((line) => ({
    client_line_id: line.client_line_id,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unit_price: centsToDollars(line.unit_price_cents),
    tax_percent: taxLabel(line.tax_bp),
  }));
}

type ExtraWorkJobRecord = {
  customer_id?: string;
  current_quote?: { number?: string } | null;
  latest_change?: {
    id: string;
    number?: string;
    revision_no?: number;
    lifecycle: string;
    request_state: string | null;
    additions?: Array<{ description: string; total_cents: number }>;
  } | null;
  change_draft?: {
    id: string;
    additions_count?: number;
    reductions_count?: number;
  } | null;
};

type PublishedChangeRecord = {
  id: string;
  number: string;
  revision_no: number;
  lifecycle: string;
  request_state: string | null;
  pdf_state?: string;
  additions: Array<{ description: string; total_cents: number }>;
};

export function ExtraWorkScreen(props: { jobId: string }) {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<ChangeDraftRecord | undefined>();
  const [published, setPublished] = useState<PublishedChangeRecord | undefined>();
  const [pdfDownload, setPdfDownload] = useState<QuotePdfDownload | undefined>();
  const [pdfError, setPdfError] = useState<string | undefined>();
  const [pdfChecking, setPdfChecking] = useState(false);
  const [pdfStillPreparing, setPdfStillPreparing] = useState(false);
  const [quoteNumber, setQuoteNumber] = useState<string | undefined>();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [recipient, setRecipient] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<ExtraWorkLineForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"list" | "edit" | "review" | "preview" | "confirm">("list");
  const [preview, setPreview] = useState<ChangePreviewRecord | undefined>();
  const [publishing, setPublishing] = useState(false);
  const [operationNotice, setOperationNotice] = useState<ChangePublishNotice | undefined>();
  const [editingId, setEditingId] = useState<string | undefined>();
  const [saveState, setSaveState] = useState<ExtraWorkSaveState>("idle");
  const [showValidation, setShowValidation] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number; code?: string }>();
  const openKey = useRef<string | undefined>(undefined);
  const saveKey = useRef<string | undefined>(undefined);
  const keyFingerprint = useRef<string | undefined>(undefined);
  const publishKey = useRef<string | undefined>(undefined);
  const previewInFlight = useRef(false);
  const publishInFlight = useRef(false);
  const pdfInFlight = useRef(false);
  const startAnother = useRef(false);
  const dirty = useRef(false);
  const lastSaved = useRef<string | undefined>(undefined);
  const saveGate = useRef(createExtraWorkSaveGate());
  const draftRef = useRef<ChangeDraftRecord | undefined>(undefined);
  const publishedRef = useRef<PublishedChangeRecord | undefined>(undefined);
  const reasonRef = useRef(reason);
  const linesRef = useRef(lines);
  const offline = auth.snapshot.status === "offline_cached";
  const accessExpired = auth.snapshot.status === "access_expired";
  reasonRef.current = reason;
  linesRef.current = lines;
  draftRef.current = draft;
  publishedRef.current = published;

  const applyDraft = useCallback((next: ChangeDraftRecord) => {
    const nextLines = linesFromDraft(next);
    lastSaved.current = JSON.stringify({ reason: next.reason, lines: nextLines });
    draftRef.current = next;
    setDraft(next);
    setReason(next.reason);
    setLines(nextLines);
    dirty.current = false;
  }, []);

  const load = useCallback(async () => {
    if (dirty.current && draftRef.current) {
      return;
    }
    if (!props.jobId) {
      setLoading(false);
      setError({ message: copy.jobNotFound, retryable: false, status: 404 });
      return;
    }
    if (!draftRef.current && !publishedRef.current) {
      setLoading(true);
    }
    setError(undefined);
    const job = await runOwnerRequest<ExtraWorkJobRecord>({
      path: `/v1/jobs/${props.jobId}`,
    });
    if (!job.ok) {
      setLoading(false);
      setError({
        message: job.error.status === 404 ? copy.jobNotFound : job.error.message || copy.changeLoadError,
        retryable: job.error.retryable || job.error.status === 0,
        status: job.error.status,
        code: job.error.code,
      });
      return;
    }
    if (typeof job.data.current_quote?.number === "string") {
      setQuoteNumber(job.data.current_quote.number);
    }
    if (typeof job.data.customer_id === "string") {
      setCustomerId(job.data.customer_id);
    }
    const forceStart = startAnother.current;
    startAnother.current = false;
    const session = forceStart
      ? { kind: "resume" as const }
      : resolveChangeEditorSession({
          intent: "extra",
          latestChange: job.data.latest_change ?? null,
          changeDraft: job.data.change_draft
            ? {
                id: job.data.change_draft.id,
                additionsCount: job.data.change_draft.additions_count ?? 0,
                reductionsCount: job.data.change_draft.reductions_count ?? 0,
              }
            : null,
        });
    if (session.kind === "published") {
      const loaded = await runOwnerRequest<{
        id: string;
        number: string;
        revision_no: number;
        lifecycle: string;
        pdf_state?: string;
        snapshot?: { additions?: Array<{ description: string; total_cents: number }> };
      }>({
        path: `/v1/documents/${session.changeId}`,
      });
      const latest = job.data.latest_change;
      const additions =
        (loaded.ok ? loaded.data.snapshot?.additions : undefined) ?? latest?.additions ?? [];
      if (!loaded.ok) {
        setLoading(false);
        setError({
          message: loaded.error.message || copy.changeLoadError,
          retryable: loaded.error.retryable || loaded.error.status === 0,
          status: loaded.error.status,
          code: loaded.error.code,
        });
        return;
      }
      setPublished({
        id: loaded.data.id,
        number: loaded.data.number,
        revision_no: loaded.data.revision_no,
        lifecycle: loaded.data.lifecycle,
        request_state: session.request_state,
        pdf_state: loaded.data.pdf_state,
        additions,
      });
      setDraft(undefined);
      draftRef.current = undefined;
      setPdfDownload(loaded.data.pdf_state ? { state: loaded.data.pdf_state, url: null } : undefined);
      setPdfError(undefined);
      setLoading(false);
      setSaveState("saved");
      return;
    }
    openKey.current = retainOrCreateSetupIdempotencyKey(openKey.current);
    const opened = await runOwnerRequest<ChangeDraftRecord>({
      path: `/v1/jobs/${props.jobId}/changes`,
      method: "POST",
      idempotencyKey: openKey.current,
    });
    if (!opened.ok) {
      setLoading(false);
      openKey.current = extraWorkIdempotencyAfterFailure(openKey.current, opened.error.code);
      if (opened.error.code === "IDEMPOTENCY_MISMATCH") {
        openKey.current = undefined;
      }
      setError({
        message: opened.error.status === 404 ? copy.jobNotFound : opened.error.message || copy.changeLoadError,
        retryable: opened.error.retryable || opened.error.status === 0,
        status: opened.error.status,
        code: opened.error.code,
      });
      return;
    }
    setPublished(undefined);
    setPdfDownload(undefined);
    applyDraft(opened.data);
    setLoading(false);
    setSaveState("saved");
  }, [applyDraft, props.jobId, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      if (accessExpired) {
        return;
      }
      void load();
    }, [accessExpired, load]),
  );

  const refreshPdf = useCallback(
    async (documentId: string) => {
      const result = await runOwnerRequest<QuotePdfDownload>({
        path: `/v1/documents/${documentId}/download`,
      });
      if (!result.ok) {
        setPdfError(result.error.message || copy.quotePdfOpenError);
        return result;
      }
      setPdfError(undefined);
      setPdfDownload(result.data);
      return result;
    },
    [runOwnerRequest],
  );

  useEffect(() => {
    if (!published?.id) {
      return;
    }
    let cancelled = false;
    let settled = false;
    const timer = setInterval(() => {
      if (settled || cancelled || pdfInFlight.current) {
        return;
      }
      void refreshPdf(published.id).then((result) => {
        if (cancelled || !result.ok) {
          return;
        }
        if (result.data.state === "ready" || result.data.state === "failed") {
          settled = true;
          clearInterval(timer);
        }
      });
    }, 3000);
    void refreshPdf(published.id).then((result) => {
      if (cancelled || !result.ok) {
        return;
      }
      if (result.data.state === "ready" || result.data.state === "failed") {
        settled = true;
        clearInterval(timer);
      }
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [published?.id, refreshPdf]);

  useEffect(() => {
    if (!accessExpired) {
      return;
    }
    setDraft(undefined);
    setPublished(undefined);
    setPdfDownload(undefined);
    setLines([]);
    setReason("");
    setQuoteNumber(undefined);
    setShowValidation(false);
    draftRef.current = undefined;
  }, [accessExpired]);

  const persist = useCallback(async (): Promise<boolean> => {
    return saveGate.current(async () => {
      const current = draftRef.current;
      if (!current || offline || accessExpired) {
        setSaveState(offline ? "offline" : "failed");
        return false;
      }
      let lastRecord: ChangeDraftRecord | undefined;
      const result = await saveExtraWorkUntilQuiet({
        version: current.version,
        savedFingerprint: lastSaved.current ?? "",
        readFingerprint: () => JSON.stringify({ reason: reasonRef.current, lines: linesRef.current }),
        createKey: () => retainOrCreateSetupIdempotencyKey(undefined),
        initialKey: saveKey.current,
        initialKeyFingerprint: keyFingerprint.current,
        send: async (request) => {
          const draft = draftRef.current;
          if (!draft) {
            return { ok: false, status: 0, code: "LOCAL_INVALID" };
          }
          const reasonNow = reasonRef.current;
          const linesNow = linesRef.current;
          if (
            extraWorkFieldErrors({
              reason: reasonNow,
              expectedScopeVersion: draft.expected_scope_version,
              expiryDays: draft.expiry_days,
              lines: linesNow,
            }).length > 0
          ) {
            return { ok: false, status: 422, code: "LOCAL_INVALID" };
          }
          const saved = await runOwnerRequest<ChangeDraftRecord>({
            path: `/v1/drafts/${draft.id}`,
            method: "PATCH",
            idempotencyKey: request.idempotencyKey,
            ifMatch: request.ifMatch,
            body: extraWorkPayload({
              reason: reasonNow,
              expectedScopeVersion: draft.expected_scope_version,
              expiryDays: draft.expiry_days,
              lines: linesNow,
            }),
          });
          if (!saved.ok) {
            return { ok: false, status: saved.error.status, code: saved.error.code ?? "" };
          }
          lastRecord = saved.data;
          return { ok: true, version: saved.data.version };
        },
      });
      saveKey.current = result.idempotencyKey;
      keyFingerprint.current = result.keyFingerprint;
      const latest = JSON.stringify({ reason: reasonRef.current, lines: linesRef.current });
      if (result.invalid) {
        setSaveState("invalid");
        return false;
      }
      if (result.conflict) {
        if (draftRef.current && result.version !== draftRef.current.version) {
          const next = { ...draftRef.current, version: result.version };
          draftRef.current = next;
          setDraft(next);
        }
        lastSaved.current = result.savedFingerprint;
        saveKey.current = undefined;
        keyFingerprint.current = undefined;
        setConflict(true);
        setSaveState("failed");
        setError({
          message: copy.extraWorkConflict,
          retryable: false,
          status: result.conflict.status,
          code: result.conflict.code,
        });
        return false;
      }
      if (result.failure) {
        if (draftRef.current && result.version !== draftRef.current.version) {
          const next = { ...draftRef.current, version: result.version };
          draftRef.current = next;
          lastSaved.current = result.savedFingerprint;
          setDraft(next);
        }
        saveKey.current = extraWorkIdempotencyAfterFailure(result.idempotencyKey, result.failure.code);
        if (result.failure.code === "IDEMPOTENCY_MISMATCH") {
          keyFingerprint.current = undefined;
        }
        setSaveState("failed");
        setError({
          message: copy.extraWorkSaveFailed,
          retryable: result.failure.status === 0 || result.failure.status >= 500,
          status: result.failure.status,
          code: result.failure.code,
        });
        return false;
      }
      if (lastRecord && result.savedFingerprint === latest) {
        applyDraft(lastRecord);
      } else if (draftRef.current) {
        const next = { ...draftRef.current, version: result.version };
        draftRef.current = next;
        lastSaved.current = result.savedFingerprint;
        setDraft(next);
      }
      setConflict(false);
      setSaveState(result.savedFingerprint === latest ? "saved" : "saving");
      setError(undefined);
      return result.savedFingerprint === latest;
    });
  }, [accessExpired, applyDraft, offline, runOwnerRequest]);

  async function reloadServerDraft(mode: "refresh" | "reapply") {
    const current = draftRef.current;
    if (!current) {
      return;
    }
    const loaded = await runOwnerRequest<ChangeDraftRecord>({ path: `/v1/drafts/${current.id}` });
    if (!loaded.ok) {
      setError({
        message: loaded.error.message || copy.changeLoadError,
        retryable: loaded.error.retryable || loaded.error.status === 0,
        status: loaded.error.status,
        code: loaded.error.code,
      });
      return;
    }
    if (mode === "refresh") {
      dirty.current = false;
      setConflict(false);
      applyDraft(loaded.data);
      setSaveState("saved");
      setError(undefined);
      return;
    }
    const next = {
      ...current,
      version: loaded.data.version,
      expected_scope_version: loaded.data.expected_scope_version,
      previous_total_cents: loaded.data.previous_total_cents,
    };
    draftRef.current = next;
    setDraft(next);
    saveKey.current = undefined;
    keyFingerprint.current = undefined;
    setConflict(false);
    dirty.current = true;
    await persist();
  }

  const fingerprint = JSON.stringify({ reason, lines });
  useEffect(() => {
    if (!draft || lastSaved.current === undefined || lastSaved.current === fingerprint) {
      return;
    }
    dirty.current = true;
    if (offline) {
      setSaveState("offline");
      return;
    }
    setSaveState("saving");
    const timer = setTimeout(() => {
      void persist();
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, fingerprint, offline, persist]);

  function fieldErrors() {
    if (!draft) {
      return [];
    }
    return extraWorkFieldErrors({
      reason,
      expectedScopeVersion: draft.expected_scope_version,
      expiryDays: draft.expiry_days,
      lines,
    });
  }

  const errors = draft ? fieldErrors() : [];
  const reviewBlocked = extraWorkReviewBlocked({
    offline,
    busy,
    accessExpired,
    lineCount: lines.length,
    fieldErrorCount: errors.length,
  });
  const totals = draft ? extraWorkTotals(draft.previous_total_cents, lines) : undefined;
  const editing = lines.find((line) => line.client_line_id === editingId);
  const publishedView = published
    ? presentExtraWorkPublished({
        number: published.number,
        revision_no: published.revision_no,
        lifecycle: published.lifecycle,
        request_state: published.request_state,
        additions: published.additions,
      })
    : undefined;
  const pdfView = presentQuotePdf(pdfDownload ?? (published?.pdf_state ? { state: published.pdf_state, url: null } : undefined));
  const pdfRetry = presentQuotePdfRetry({ checking: pdfChecking, stillPreparing: pdfStillPreparing });
  const view =
    published && !accessExpired
      ? { kind: "loaded" as const, showRetry: false }
      : presentChangeEditor({
          authStatus: auth.snapshot.status,
          loading,
          draft: accessExpired ? undefined : draft,
          error,
        });

  function updateLine(id: string, patch: Partial<ExtraWorkLineForm>) {
    setLines((current) => current.map((line) => (line.client_line_id === id ? { ...line, ...patch } : line)));
  }

  function leave() {
    if (dirty.current && saveState !== "saved") {
      setLeaveConfirm(true);
      return;
    }
    router.replace(extraWorkContinueDestination(props.jobId));
  }

  async function openOrRetryPdf() {
    if (!published || pdfInFlight.current) {
      return;
    }
    pdfInFlight.current = true;
    setPdfChecking(true);
    setPdfStillPreparing(false);
    try {
      const result = await refreshPdf(published.id);
      if (result.ok && result.data.url) {
        setPdfStillPreparing(false);
        try {
          await Linking.openURL(result.data.url);
        } catch {
          setPdfError(copy.quotePdfOpenError);
        }
        return;
      }
      if (result.ok && result.data.state === "preparing") {
        setPdfStillPreparing(true);
      }
    } finally {
      pdfInFlight.current = false;
      setPdfChecking(false);
    }
  }

  function startAnotherExtraWork() {
    startAnother.current = true;
    setPublished(undefined);
    setPdfDownload(undefined);
    setDraft(undefined);
    draftRef.current = undefined;
    openKey.current = undefined;
    void load();
  }

  async function continueToPreview() {
    const current = draftRef.current;
    if (!current) {
      return;
    }
    const started = beginChangePreviewRequest({
      draftId: current.id,
      version: current.version,
      allowed: extraWorkPreviewAllowed({ offline, accessExpired, reviewBlocked }),
      inFlight: previewInFlight,
    });
    if (started.kind === "ignored") {
      return;
    }
    setBusy(true);
    setOperationNotice(undefined);
    try {
      const saved = await persist();
      const latest = draftRef.current;
      if (!saved || !latest) {
        return;
      }
      const previewed = await runOwnerRequest<ChangePreviewRecord>({
        path: `/v1/drafts/${latest.id}/preview`,
        method: "POST",
        ifMatch: latest.version,
      });
      if (!previewed.ok) {
        setOperationNotice(presentChangePreviewFailure(previewed.error));
        return;
      }
      setPreview(previewed.data);
      setRecipient((current) => (current.trim().length > 0 ? current : (previewed.data.snapshot.customer.email ?? "")));
      setPhase("preview");
    } finally {
      previewInFlight.current = false;
      setBusy(false);
    }
  }

  async function saveRecipientAndPreview() {
    const plan = changeRecipientPlan({
      previewEmail: preview?.snapshot.customer.email,
      enteredEmail: recipient,
    });
    if (plan.kind !== "needs_preview") {
      const blocked = presentChangeRecipient(plan);
      if (blocked) {
        setOperationNotice(blocked);
      }
      return;
    }
    const jobId = customerId;
    if (!jobId) {
      setOperationNotice(presentChangeRecipient({ kind: "missing" }));
      return;
    }
    setBusy(true);
    setOperationNotice(undefined);
    try {
      const loaded = await runOwnerRequest<{ id: string; version: number; email: string | null }>({
        path: `/v1/customers/${jobId}`,
      });
      if (!loaded.ok) {
        setOperationNotice({
          message: loaded.error.message || copy.changeRecipientInvalid,
          showRetry: false,
          retryLabel: copy.retry,
          showCheck: false,
          checkLabel: copy.changePublishCheck,
          recovery: "none",
        });
        return;
      }
      const patch = changeCustomerEmailPatch(plan.email);
      if (!patch.ok) {
        setOperationNotice(presentChangeRecipient({ kind: "invalid" }));
        return;
      }
      const saved = await runOwnerRequest<{ version: number; email: string | null }>({
        path: `/v1/customers/${loaded.data.id}`,
        method: "PATCH",
        idempotencyKey: retainOrCreateSetupIdempotencyKey(undefined),
        ifMatch: loaded.data.version,
        body: { email: patch.value.email },
      });
      if (!saved.ok) {
        setOperationNotice({
          message: saved.error.message || copy.changeRecipientInvalid,
          showRetry: false,
          retryLabel: copy.retry,
          showCheck: false,
          checkLabel: copy.changePublishCheck,
          recovery: "none",
        });
        return;
      }
    } finally {
      setBusy(false);
    }
    await continueToPreview();
  }

  async function publishChange(confirming = false) {
    const plan = changeRecipientPlan({
      previewEmail: preview?.snapshot.customer.email,
      enteredEmail: recipient,
    });
    if (plan.kind !== "ready") {
      const blocked = presentChangeRecipient(plan);
      if (blocked) {
        setOperationNotice(blocked);
      }
      setPhase("preview");
      return;
    }
    const started = beginChangePublishRequest({
      confirming,
      preview,
      inFlight: publishInFlight,
      idempotencyKey: publishKey.current,
    });
    if (started.kind === "ignored") {
      return;
    }
    if (started.kind !== "request") {
      setPreview((current) => (started.kind === "stale_preview" ? changePreviewAfterFailure(current, "PREVIEW_CHANGED") : current));
      setOperationNotice(presentBlockedChangePublish(started.kind));
      setPhase("preview");
      return;
    }
    publishKey.current = started.idempotencyKey;
    setBusy(true);
    setPublishing(true);
    setOperationNotice(undefined);
    try {
      const published = await runOwnerRequest<{ id?: string }>({
        path: started.path,
        method: started.method,
        idempotencyKey: started.idempotencyKey,
        ifMatch: started.ifMatch,
        body: started.body,
      });
      if (!published.ok) {
        const notice = presentChangePublishResponse({
          ok: false,
          status: published.error.status,
          code: published.error.code,
          message: published.error.message,
          retryable: published.error.retryable,
        });
        if (notice.recovery !== "check_draft") {
          publishKey.current = extraWorkIdempotencyAfterFailure(publishKey.current, published.error.code);
        }
        if (notice.recovery === "refresh_preview") {
          setPreview((current) => changePreviewAfterFailure(current, published.error.code));
        }
        setOperationNotice(notice);
        setPhase("preview");
        return;
      }
      const publishedId = typeof published.data?.id === "string" ? published.data.id : "";
      if (!publishedId) {
        setOperationNotice(presentChangePublishResponse({ ok: true, status: 202 }));
        setPhase("preview");
        return;
      }
      extraWorkAnalyticsProperties();
      router.replace(extraWorkContinueDestination(props.jobId));
    } finally {
      publishInFlight.current = false;
      setBusy(false);
      setPublishing(false);
    }
  }

  async function checkPublishResult() {
    const current = draftRef.current;
    if (!current) {
      return;
    }
    const loaded = await runOwnerRequest<ChangeDraftRecord>({ path: `/v1/drafts/${current.id}` });
    if (!loaded.ok) {
      const notice = presentChangePublishResponse({
        ok: false,
        status: loaded.error.status,
        code: loaded.error.code,
        message: loaded.error.message,
        retryable: false,
      });
      setOperationNotice(notice.recovery === "check_draft" ? notice : { ...notice, recovery: "check_draft", showRetry: false, showCheck: true });
      return;
    }
    if (loaded.data.draft_state === "published") {
      router.replace(extraWorkContinueDestination(props.jobId));
      return;
    }
    setOperationNotice({
      message: copy.changePublishStillDraft,
      showRetry: false,
      retryLabel: copy.retry,
      showCheck: false,
      checkLabel: copy.changePublishCheck,
      recovery: "none",
    });
  }

  function retryOperation() {
    if (!operationNotice) {
      return;
    }
    if (operationNotice.recovery === "refresh_preview") {
      void continueToPreview();
      return;
    }
    if (operationNotice.recovery === "publish_same_key") {
      void publishChange(true);
      return;
    }
    if (operationNotice.recovery === "check_draft") {
      void checkPublishResult();
    }
  }

  const attention = errors.filter((item) => item.field.startsWith("additions")).length;

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel={copy.extraWorkBack} onPress={leave} style={styles.back}>
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>{copy.extraWorkEyebrow}</Text>
            <Text accessibilityRole="header" style={styles.heading}>
              {copy.extraWorkHeading}
            </Text>
            <Text accessibilityLiveRegion="polite">
              {publishedView ? publishedView.status : extraWorkSaveLabel(offline ? "offline" : saveState)}
            </Text>
          </View>
        </View>

        {view.kind === "loading" ? (
          <View accessibilityLabel={copy.extraWorkDraft}>
            <View style={styles.skeleton} />
            <View style={styles.skeleton} />
          </View>
        ) : null}

        {view.kind === "access_expired" || (view.kind === "offline" && !draft && !published) || view.kind === "error" || view.kind === "blocked" ? (
          <View>
            <Text accessibilityLiveRegion="polite" style={styles.errorText}>
              {view.kind === "blocked" ? copy.extraWorkUnavailable : view.message}
            </Text>
            {view.showRetry ? (
              <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.retry}</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" onPress={() => router.replace(extraWorkContinueDestination(props.jobId))} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.extraWorkBack}</Text>
            </Pressable>
          </View>
        ) : null}

        {published && publishedView && !accessExpired ? (
          <View>
            <Text style={styles.support}>{copy.extraWorkSentSupport}</Text>
            <View style={styles.accepted}>
              <View style={styles.row}>
                <Text style={styles.acceptedLabel}>{publishedView.title}</Text>
                <Text style={styles.quoteNumber}>{publishedView.status}</Text>
              </View>
            </View>
            <Text style={styles.section}>{copy.extraWorkItems}</Text>
            {publishedView.lines.length === 0 ? <Text style={styles.support}>{copy.extraWorkEmpty}</Text> : null}
            {publishedView.lines.map((line, index) => (
              <View key={`${published.id}-${index}`} style={styles.item}>
                <View style={styles.itemCopy}>
                  <Text style={styles.itemTitle}>{line.description}</Text>
                </View>
                <Text style={styles.itemAmount}>{line.amount}</Text>
              </View>
            ))}
            {pdfError ? (
              <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                {pdfError}
              </Text>
            ) : null}
            {pdfView.kind === "preparing" ? (
              <Text style={styles.support}>{copy.extraWorkPdfPreparing}</Text>
            ) : null}
            {pdfView.kind === "failed" ? (
              <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                {copy.quotePdfFailed}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ busy: pdfRetry.busy }}
              disabled={offline || busy || pdfRetry.busy}
              onPress={() => void openOrRetryPdf()}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>
                {pdfRetry.busy ? copy.quotePdfChecking : copy.extraWorkOpenPdf}
              </Text>
            </Pressable>
            {publishedView.canStartAnother ? (
              <Pressable
                accessibilityRole="button"
                disabled={offline || busy}
                onPress={startAnotherExtraWork}
                style={styles.secondary}
              >
                <Text style={styles.secondaryLabel}>{copy.extraWorkAddAnother}</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => router.replace(extraWorkContinueDestination(props.jobId))}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.extraWorkBack}</Text>
            </Pressable>
          </View>
        ) : null}

        {draft && !accessExpired && (phase === "preview" || phase === "confirm") && preview ? (
          <ChangeCustomerPreview
            snapshot={preview.snapshot}
            confirming={phase === "confirm"}
            busy={busy}
            publishing={publishing}
            notice={operationNotice}
            enteredEmail={recipient}
            onChangeEmail={setRecipient}
            onSaveEmail={() => void saveRecipientAndPreview()}
            onReviewPublish={() => {
              const plan = changeRecipientPlan({
                previewEmail: preview?.snapshot.customer.email,
                enteredEmail: recipient,
              });
              const blocked = presentChangeRecipient(plan);
              if (blocked) {
                setOperationNotice(blocked);
                return;
              }
              setOperationNotice(undefined);
              setPhase("confirm");
            }}
            onConfirmPublish={() => void publishChange(true)}
            onCancelConfirm={() => setPhase("preview")}
            onBack={() => {
              setPhase("review");
              setOperationNotice(undefined);
            }}
            onRetry={retryOperation}
            onCheck={() => void checkPublishResult()}
          />
        ) : null}

        {draft && !accessExpired && phase !== "edit" && phase !== "preview" && phase !== "confirm" ? (
          <View>
            {phase === "list" ? <Text style={styles.support}>{copy.extraWorkSupport}</Text> : null}
            {showValidation && errors.length > 0 ? (
              <View accessibilityLiveRegion="polite" style={styles.alert}>
                <Text style={styles.alertTitle}>{copy.extraWorkCheck}</Text>
                <Text style={styles.alertBody}>{errors[0]?.message || copy.extraWorkCheckBody}</Text>
              </View>
            ) : null}
            {phase === "review" && errors.length === 0 ? (
              <View style={styles.ready}>
                <Text style={styles.readyTitle}>{copy.extraWorkReadyTitle}</Text>
                <Text style={styles.support}>{copy.extraWorkReadyBody}</Text>
              </View>
            ) : null}
            {operationNotice && phase === "review" ? (
              <View>
                <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                  {operationNotice.message}
                </Text>
                {operationNotice.showRetry ? (
                  <Pressable accessibilityRole="button" onPress={retryOperation} style={styles.secondary}>
                    <Text style={styles.secondaryLabel}>{operationNotice.retryLabel}</Text>
                  </Pressable>
                ) : null}
                {operationNotice.showCheck ? (
                  <Pressable accessibilityRole="button" onPress={() => void checkPublishResult()} style={styles.secondary}>
                    <Text style={styles.secondaryLabel}>{operationNotice.checkLabel}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {conflict ? (
              <View>
                <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                  {copy.extraWorkConflict}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void reloadServerDraft("reapply")}
                  style={styles.secondary}
                >
                  <Text style={styles.secondaryLabel}>{copy.extraWorkReapply}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void reloadServerDraft("refresh")}
                  style={styles.secondary}
                >
                  <Text style={styles.secondaryLabel}>{copy.extraWorkRefresh}</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.accepted}>
              <View style={styles.row}>
                <Text style={styles.acceptedLabel}>{copy.extraWorkAccepted}</Text>
                {quoteNumber ? <Text style={styles.quoteNumber}>{quoteNumber}</Text> : null}
              </View>
              <View style={styles.row}>
                <Text style={styles.support}>{copy.extraWorkOriginal}</Text>
                <Text style={styles.amount}>{formatUsdCents(draft.previous_total_cents)}</Text>
              </View>
            </View>
            <Text style={styles.section}>{phase === "review" ? copy.extraWorkAdditions : copy.extraWorkItems}</Text>
            {lines.length === 0 ? <Text style={styles.support}>{copy.extraWorkEmpty}</Text> : null}
            {lines.map((line) => {
              const lineErrors = errors.filter((item) => item.field.includes(line.client_line_id) || item.field.startsWith("additions"));
              const invalid = showValidation && lineErrors.length > 0 && (line.description.trim().length === 0 || extraWorkLineTotalCents(line) === undefined);
              const total = extraWorkLineTotalCents(line);
              return (
                <View key={line.client_line_id} style={[styles.item, invalid ? styles.itemInvalid : null]}>
                  <View style={styles.itemCopy}>
                    <Text style={styles.itemTitle}>{line.description.trim() || copy.extraWorkDescription}</Text>
                    <Text style={invalid ? styles.errorText : styles.meta}>
                      {invalid ? lineErrors[0]?.message || copy.extraWorkCheckBody : extraWorkLineMeta(line)}
                    </Text>
                  </View>
                  <Text style={invalid ? styles.errorText : styles.itemAmount}>{total === undefined ? "" : formatUsdCents(total)}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${copy.extraWorkDone} ${line.description}`}
                    onPress={() => {
                      setEditingId(line.client_line_id);
                      setPhase("edit");
                    }}
                    style={styles.edit}
                  >
                    <Text style={styles.editGlyph}>✎</Text>
                  </Pressable>
                </View>
              );
            })}
            {phase === "list" ? (
              <Pressable
                accessibilityRole="button"
                disabled={offline || busy}
                onPress={() => {
                  const id = secureRandomUUID();
                  setLines((current) => [
                    ...current,
                    { client_line_id: id, description: "", quantity: "1", unit: "item", unit_price: "", tax_percent: "0" },
                  ]);
                  setEditingId(id);
                  setPhase("edit");
                }}
                style={styles.secondary}
              >
                <Text style={styles.secondaryLabel}>{copy.extraWorkAdd}</Text>
              </Pressable>
            ) : null}
            {totals ? (
              <View style={styles.totals}>
                <View style={styles.row}>
                  <Text style={styles.support}>{copy.extraWorkAcceptedRow}</Text>
                  <Text style={styles.meta}>{formatUsdCents(totals.acceptedCents)}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.support}>{copy.extraWorkRow}</Text>
                  <Text style={styles.meta}>{formatUsdCents(totals.extraCents)}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.revised}>{copy.extraWorkRevised}</Text>
                  <Text style={styles.revisedAmount}>{formatUsdCents(totals.revisedCents)}</Text>
                </View>
              </View>
            ) : null}
            <Text style={styles.fieldLabel}>
              {copy.extraWorkNote} {copy.extraWorkNoteHint}
            </Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              maxLength={500}
              editable={!offline && !busy}
              style={styles.input}
            />
            {phase === "review" ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: reviewBlocked || busy, busy }}
                  disabled={reviewBlocked || busy}
                  onPress={() => void continueToPreview()}
                  style={styles.primary}
                >
                  <Text style={styles.primaryLabel}>{busy ? copy.changePreviewOpening : copy.extraWorkContinue}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => setPhase("list")} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{copy.extraWorkBackEdit}</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: reviewBlocked }}
                  disabled={offline || busy || accessExpired}
                  onPress={() => {
                    if (reviewBlocked) {
                      setShowValidation(true);
                      return;
                    }
                    setShowValidation(false);
                    setPhase("review");
                  }}
                  style={[styles.primary, reviewBlocked ? styles.primaryDisabled : null]}
                >
                  <Text style={[styles.primaryLabel, reviewBlocked ? styles.primaryDisabledLabel : null]}>{copy.extraWorkReview}</Text>
                </Pressable>
                <Text style={errors.length > 0 && showValidation ? styles.errorText : styles.support}>
                  {errors.length > 0 && showValidation ? `${attention || 1} ${copy.extraWorkNeedsAttention}` : copy.extraWorkReviewNote}
                </Text>
              </>
            )}
          </View>
        ) : null}

        {draft && editing && phase === "edit" ? (
          <View>
            <Text style={styles.support}>{copy.extraWorkEditSupport}</Text>
            <Text style={styles.editing}>{copy.extraWorkEditing}</Text>
            <Text style={styles.fieldLabel}>{copy.extraWorkDescription}</Text>
            <TextInput
              value={editing.description}
              onChangeText={(value) => updateLine(editing.client_line_id, { description: value })}
              maxLength={500}
              editable={!offline && !busy}
              style={styles.input}
            />
            <Text style={styles.fieldLabel}>{copy.extraWorkQuantity}</Text>
            <TextInput
              value={editing.quantity}
              onChangeText={(value) => updateLine(editing.client_line_id, { quantity: value })}
              keyboardType="decimal-pad"
              editable={!offline && !busy}
              style={styles.input}
            />
            <Text style={styles.fieldLabel}>{copy.extraWorkUnit}</Text>
            <View style={styles.units}>
              {LINE_UNITS.filter((unit) => unit !== "custom").map((unit) => (
                <Pressable
                  key={unit}
                  accessibilityRole="button"
                  accessibilityState={{ selected: editing.unit === unit }}
                  onPress={() => updateLine(editing.client_line_id, { unit })}
                  style={[styles.unit, editing.unit === unit ? styles.unitSelected : null]}
                >
                  <Text>{unit.replaceAll("_", " ")}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.fieldLabel}>{copy.extraWorkPrice}</Text>
            <TextInput
              value={editing.unit_price}
              onChangeText={(value) => updateLine(editing.client_line_id, { unit_price: value })}
              keyboardType="decimal-pad"
              editable={!offline && !busy}
              style={styles.input}
            />
            <Text style={styles.fieldLabel}>{copy.extraWorkTax}</Text>
            <TextInput
              value={editing.tax_percent}
              onChangeText={(value) => updateLine(editing.client_line_id, { tax_percent: value })}
              keyboardType="decimal-pad"
              editable={!offline && !busy}
              style={styles.input}
            />
            <View style={styles.lineTotal}>
              <Text style={styles.support}>{copy.extraWorkLineTotal}</Text>
              <Text style={styles.revisedAmount}>
                {extraWorkLineTotalCents(editing) === undefined ? "" : formatUsdCents(extraWorkLineTotalCents(editing) ?? 0)}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (!isExtraWorkUnit(editing.unit)) {
                  setShowValidation(true);
                  return;
                }
                setPhase("list");
                setEditingId(undefined);
              }}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>{copy.extraWorkDone}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.extraWorkRemove}
              onPress={() => {
                setLines((current) => current.filter((line) => line.client_line_id !== editing.client_line_id));
                setPhase("list");
                setEditingId(undefined);
              }}
              style={styles.remove}
            >
              <Text style={styles.removeLabel}>{copy.extraWorkRemove}</Text>
            </Pressable>
          </View>
        ) : null}

        {leaveConfirm ? (
          <View>
            <Text style={styles.support}>{copy.extraWorkSaveFailed}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.replace(extraWorkContinueDestination(props.jobId))}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.extraWorkBack}</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 20, paddingTop: 22, gap: 12 },
  header: { flexDirection: "row", gap: 10, alignItems: "center" },
  back: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  backGlyph: { color: colors.text, fontSize: 28, lineHeight: 30 },
  headerCopy: { flex: 1, gap: 1 },
  eyebrow: { color: colors.secondary, fontSize: 10, fontWeight: "600" },
  heading: { color: colors.text, fontSize: 22, fontWeight: "700" },
  support: { color: colors.secondary, fontSize: 13 },
  accepted: { backgroundColor: colors.infoTint, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, gap: 3 },
  acceptedLabel: { color: colors.success, fontSize: 10, fontWeight: "600" },
  quoteNumber: { color: colors.secondary, fontSize: 11 },
  amount: { color: colors.text, fontSize: 15, fontWeight: "700" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  section: { color: colors.secondary, fontSize: 11, fontWeight: "600" },
  item: {
    minHeight: 78,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  itemInvalid: { borderColor: DANGER, borderWidth: 1.5 },
  itemCopy: { flex: 1, gap: 2 },
  itemTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  itemAmount: { color: colors.text, fontSize: 14, fontWeight: "700" },
  meta: { color: colors.secondary, fontSize: 12 },
  edit: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.infoTint,
    alignItems: "center",
    justifyContent: "center",
  },
  editGlyph: { color: colors.navy, fontSize: 16 },
  totals: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 7,
  },
  revised: { color: colors.text, fontSize: 14, fontWeight: "600" },
  revisedAmount: { color: colors.text, fontSize: 17, fontWeight: "700" },
  fieldLabel: { color: colors.text, fontSize: 12, fontWeight: "500" },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 13,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 14,
  },
  primary: {
    minHeight: 56,
    borderRadius: 16,
    backgroundColor: PRIMARY,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryDisabled: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, opacity: 0.7 },
  primaryLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  primaryDisabledLabel: { color: colors.secondary },
  secondary: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryLabel: { color: colors.navy, fontSize: 14, fontWeight: "600" },
  alert: { borderWidth: 1, borderColor: DANGER, borderRadius: 16, padding: 14, backgroundColor: colors.surface, gap: 2 },
  alertTitle: { color: DANGER, fontSize: 13, fontWeight: "600" },
  alertBody: { color: DANGER, fontSize: 11 },
  errorText: { color: DANGER, fontSize: 12 },
  ready: { backgroundColor: colors.infoTint, borderRadius: 16, padding: 14, gap: 2 },
  readyTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  editing: { backgroundColor: colors.infoTint, borderRadius: 12, minHeight: 42, paddingHorizontal: 12, textAlignVertical: "center", color: colors.navy, fontWeight: "600", fontSize: 11 },
  lineTotal: {
    minHeight: 64,
    borderRadius: 14,
    backgroundColor: colors.infoTint,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  units: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  unit: { minHeight: 44, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, justifyContent: "center" },
  unitSelected: { borderColor: PRIMARY },
  remove: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  removeLabel: { color: DANGER, fontSize: 14, fontWeight: "600" },
  skeleton: { height: 70, borderRadius: 16, backgroundColor: colors.infoTint },
});
