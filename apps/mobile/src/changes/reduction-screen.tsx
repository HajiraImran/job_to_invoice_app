import { formatUsdCents } from "@job-to-invoice/schemas";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../i18n/en.ts";
import { retainOrCreateSetupIdempotencyKey } from "../setup/idempotency.ts";
import { useAuth } from "../session/AuthProvider.tsx";
import { colors } from "../theme.ts";
import { ChangeCustomerPreview } from "./customer-preview.tsx";
import {
  beginChangePreviewRequest,
  beginChangePublishRequest,
  changeCustomerEmailPatch,
  changePreviewAfterFailure,
  changeRecipientPlan,
  presentChangeRecipient,
  createExtraWorkSaveGate,
  formatDeductionCents,
  presentChangeEditor,
  presentBlockedChangePublish,
  presentChangePreviewFailure,
  presentChangePublishResponse,
  reductionAnalyticsProperties,
  reductionContinueDestination,
  reductionDraftIsCompatible,
  reductionFieldErrors,
  reductionIdempotencyAfterFailure,
  reductionPayload,
  reductionPreviewAllowed,
  reductionReviewBlocked,
  reductionTotals,
  resolveChangeEditorSession,
  saveExtraWorkUntilQuiet,
  type ChangeDraftRecord,
  type ChangePreviewRecord,
  type ChangePublishNotice,
  type ReductionAmountForm,
} from "./presentation.ts";

const PRIMARY = "#464B71";
const DANGER = "#B42318";
const SAVE_DEBOUNCE_MS = 500;

function centsToDollars(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = String(Math.abs(cents % 100)).padStart(2, "0");
  return `${whole}.${frac}`;
}

export function ReductionScreen(props: { jobId: string }) {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<ChangeDraftRecord | undefined>();
  const [quoteNumber, setQuoteNumber] = useState<string | undefined>();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [recipient, setRecipient] = useState("");
  const [reason, setReason] = useState("");
  const [amounts, setAmounts] = useState<ReductionAmountForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"list" | "edit" | "review" | "preview" | "confirm">("list");
  const [preview, setPreview] = useState<ChangePreviewRecord | undefined>();
  const [publishing, setPublishing] = useState(false);
  const [operationNotice, setOperationNotice] = useState<ChangePublishNotice | undefined>();
  const [editingId, setEditingId] = useState<string | undefined>();
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed" | "offline" | "invalid">("idle");
  const [showValidation, setShowValidation] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [incompatible, setIncompatible] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number; code?: string }>();
  const openKey = useRef<string | undefined>(undefined);
  const saveKey = useRef<string | undefined>(undefined);
  const publishKey = useRef<string | undefined>(undefined);
  const previewInFlight = useRef(false);
  const publishInFlight = useRef(false);
  const keyFingerprint = useRef<string | undefined>(undefined);
  const dirty = useRef(false);
  const lastSaved = useRef<string | undefined>(undefined);
  const saveGate = useRef(createExtraWorkSaveGate());
  const draftRef = useRef<ChangeDraftRecord | undefined>(undefined);
  const reasonRef = useRef(reason);
  const amountsRef = useRef(amounts);
  const offline = auth.snapshot.status === "offline_cached";
  const accessExpired = auth.snapshot.status === "access_expired";
  reasonRef.current = reason;
  amountsRef.current = amounts;
  draftRef.current = draft;

  const applyDraft = useCallback((next: ChangeDraftRecord) => {
    const nextAmounts = next.reductions.map((line) => ({
      source_line_id: line.source_line_id,
      amount: centsToDollars(line.net_credit_cents),
    }));
    lastSaved.current = JSON.stringify({ reason: next.reason, amounts: nextAmounts });
    draftRef.current = next;
    setDraft(next);
    setReason(next.reason);
    setAmounts(nextAmounts);
    setIncompatible(!reductionDraftIsCompatible(next));
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
    if (!draftRef.current) {
      setLoading(true);
    }
    setError(undefined);
    const job = await runOwnerRequest<{
      customer_id?: string;
      current_quote?: { number?: string } | null;
      latest_change?: { id: string; lifecycle: string; request_state: string | null } | null;
      change_draft?: { id: string; additions_count?: number; reductions_count?: number } | null;
    }>({
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
    const session = resolveChangeEditorSession({
      intent: "reduce",
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
      setLoading(false);
      setError({
        message: copy.changePending,
        retryable: false,
        status: 409,
        code: "UNRESOLVED_CHANGES",
      });
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
      openKey.current = reductionIdempotencyAfterFailure(openKey.current, opened.error.code);
      setError({
        message: opened.error.status === 404 ? copy.jobNotFound : opened.error.message || copy.changeLoadError,
        retryable: opened.error.retryable || opened.error.status === 0,
        status: opened.error.status,
        code: opened.error.code,
      });
      return;
    }
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

  useEffect(() => {
    if (!accessExpired) {
      return;
    }
    setDraft(undefined);
    setAmounts([]);
    setReason("");
    setQuoteNumber(undefined);
    setShowValidation(false);
    draftRef.current = undefined;
  }, [accessExpired]);

  const persist = useCallback(async (): Promise<boolean> => {
    return saveGate.current(async () => {
      const current = draftRef.current;
      if (!current || offline || accessExpired || !reductionDraftIsCompatible(current)) {
        setSaveState(offline ? "offline" : "failed");
        return false;
      }
      let lastRecord: ChangeDraftRecord | undefined;
      const result = await saveExtraWorkUntilQuiet({
        version: current.version,
        savedFingerprint: lastSaved.current ?? "",
        readFingerprint: () => JSON.stringify({ reason: reasonRef.current, amounts: amountsRef.current }),
        createKey: () => retainOrCreateSetupIdempotencyKey(undefined),
        initialKey: saveKey.current,
        initialKeyFingerprint: keyFingerprint.current,
        send: async (request) => {
          const draft = draftRef.current;
          if (!draft || !reductionDraftIsCompatible(draft)) {
            return { ok: false, status: 0, code: "LOCAL_INVALID" };
          }
          if (
            reductionFieldErrors({
              reason: reasonRef.current,
              expectedScopeVersion: draft.expected_scope_version,
              expiryDays: draft.expiry_days,
              sources: draft.sources,
              amounts: amountsRef.current,
            }).length > 0
          ) {
            return { ok: false, status: 422, code: "LOCAL_INVALID" };
          }
          const saved = await runOwnerRequest<ChangeDraftRecord>({
            path: `/v1/drafts/${draft.id}`,
            method: "PATCH",
            idempotencyKey: request.idempotencyKey,
            ifMatch: request.ifMatch,
            body: reductionPayload({
              reason: reasonRef.current,
              expectedScopeVersion: draft.expected_scope_version,
              expiryDays: draft.expiry_days,
              amounts: amountsRef.current,
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
      const latest = JSON.stringify({ reason: reasonRef.current, amounts: amountsRef.current });
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
        saveKey.current = reductionIdempotencyAfterFailure(result.idempotencyKey, result.failure.code);
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
      sources: loaded.data.sources,
    };
    draftRef.current = next;
    setDraft(next);
    saveKey.current = undefined;
    keyFingerprint.current = undefined;
    setConflict(false);
    dirty.current = true;
    await persist();
  }

  const fingerprint = JSON.stringify({ reason, amounts });
  useEffect(() => {
    if (!draft || incompatible || lastSaved.current === undefined || lastSaved.current === fingerprint) {
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
  }, [draft, fingerprint, incompatible, offline, persist]);

  const errors =
    draft && !incompatible
      ? reductionFieldErrors({
          reason,
          expectedScopeVersion: draft.expected_scope_version,
          expiryDays: draft.expiry_days,
          sources: draft.sources,
          amounts,
        })
      : [];
  const reviewBlocked = reductionReviewBlocked({
    offline,
    busy,
    accessExpired,
    incompatible,
    fieldErrorCount: errors.length,
    lineCount: amounts.length,
  });
  const totals = draft ? reductionTotals({ previousCents: draft.previous_total_cents, sources: draft.sources, amounts }) : undefined;
  const exceeds = Boolean(totals?.exceedsAccepted || totals && totals.revisedCents < 0);
  const editing = draft?.sources.find((source) => source.source_line_id === editingId);
  const editingAmount = amounts.find((line) => line.source_line_id === editingId);
  const view = presentChangeEditor({
    authStatus: auth.snapshot.status,
    loading,
    draft: accessExpired ? undefined : draft,
    error,
  });
  const saveLabel =
    offline ? copy.extraWorkOfflineStatus : saveState === "saving" ? copy.extraWorkSaving : saveState === "saved" ? copy.extraWorkSaved : saveState === "failed" ? copy.extraWorkSaveFailed : saveState === "invalid" ? copy.extraWorkNotSaved : copy.extraWorkDraft;

  function leave() {
    if (dirty.current && saveState !== "saved") {
      setLeaveConfirm(true);
      return;
    }
    router.replace(reductionContinueDestination(props.jobId));
  }

  async function continueToPreview() {
    const current = draftRef.current;
    if (!current) {
      return;
    }
    const started = beginChangePreviewRequest({
      draftId: current.id,
      version: current.version,
      allowed: reductionPreviewAllowed({ offline, accessExpired, reviewBlocked }),
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
    if (!customerId) {
      setOperationNotice(presentChangeRecipient({ kind: "missing" }));
      return;
    }
    setBusy(true);
    setOperationNotice(undefined);
    try {
      const loaded = await runOwnerRequest<{ id: string; version: number; email: string | null }>({
        path: `/v1/customers/${customerId}`,
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
          publishKey.current = reductionIdempotencyAfterFailure(publishKey.current, published.error.code);
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
      reductionAnalyticsProperties();
      router.replace(reductionContinueDestination(props.jobId));
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
      setOperationNotice(
        notice.recovery === "check_draft"
          ? notice
          : { ...notice, recovery: "check_draft", showRetry: false, showCheck: true },
      );
      return;
    }
    if (loaded.data.draft_state === "published") {
      router.replace(reductionContinueDestination(props.jobId));
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

  return (
    <KeyboardAvoidingView style={[styles.screen, { paddingTop: insets.top }]} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel={copy.extraWorkBack} onPress={leave} style={styles.back}>
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>{copy.reductionEyebrow}</Text>
            <Text accessibilityRole="header" style={styles.heading}>
              {copy.reductionHeading}
            </Text>
            <Text accessibilityLiveRegion="polite">{saveLabel}</Text>
          </View>
        </View>
        {view.kind === "loading" ? (
          <View accessibilityLabel={copy.extraWorkDraft}>
            <View style={styles.skeleton} />
            <View style={styles.skeleton} />
          </View>
        ) : null}
        {view.kind === "access_expired" || (view.kind === "offline" && !draft) || view.kind === "error" || view.kind === "blocked" ? (
          <View>
            <Text accessibilityLiveRegion="polite" style={styles.errorText}>
              {view.kind === "blocked" ? copy.reductionUnavailable : view.message}
            </Text>
            {view.showRetry ? (
              <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.retry}</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" onPress={() => router.replace(reductionContinueDestination(props.jobId))} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.extraWorkBack}</Text>
            </Pressable>
          </View>
        ) : null}
        {draft && !accessExpired && incompatible ? (
          <View>
            <Text accessibilityLiveRegion="polite" style={styles.errorText}>
              {copy.reductionIncompatible}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => router.replace(reductionContinueDestination(props.jobId))} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.extraWorkBack}</Text>
            </Pressable>
          </View>
        ) : null}
        {draft && !accessExpired && !incompatible && (phase === "preview" || phase === "confirm") && preview ? (
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

        {draft && !accessExpired && !incompatible && phase !== "edit" && phase !== "preview" && phase !== "confirm" ? (
          <View>
            {phase === "list" ? <Text style={styles.support}>{copy.reductionSupport}</Text> : null}
            {showValidation && (errors.length > 0 || exceeds) ? (
              <View accessibilityLiveRegion="polite" style={styles.alert}>
                <Text style={styles.alertTitle}>{copy.reductionCheck}</Text>
                <Text style={styles.alertBody}>{errors[0]?.message || copy.reductionCheckBody}</Text>
              </View>
            ) : null}
            {phase === "review" && errors.length === 0 ? (
              <View style={styles.ready}>
                <Text style={styles.readyTitle}>{copy.reductionReadyTitle}</Text>
                <Text style={styles.support}>{copy.reductionReadyBody}</Text>
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
                <Pressable accessibilityRole="button" onPress={() => void reloadServerDraft("reapply")} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{copy.extraWorkReapply}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => void reloadServerDraft("refresh")} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{copy.extraWorkRefresh}</Text>
                </Pressable>
              </View>
            ) : null}
            {error && draft ? (
              <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                {error.message}
                {draft.updated_at ? ` ${draft.updated_at}` : ""}
              </Text>
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
            <Text style={styles.section}>{phase === "review" ? copy.reductionDeductions : copy.reductionItems}</Text>
            {amounts.length === 0 ? <Text style={styles.support}>{copy.reductionEmpty}</Text> : null}
            {amounts.map((line) => {
              const source = draft.sources.find((item) => item.source_line_id === line.source_line_id);
              const lineErrors = errors.filter((item) => item.field.includes(line.source_line_id) || item.field.startsWith("reductions"));
              const invalid = showValidation && lineErrors.length > 0;
              const lineTotals = reductionTotals({
                previousCents: draft.previous_total_cents,
                sources: draft.sources,
                amounts: [line],
              });
              const shown = lineTotals?.reductionCents;
              return (
                <View key={line.source_line_id} style={[styles.item, invalid ? styles.itemInvalid : null]}>
                  <View style={styles.itemCopy}>
                    <Text style={styles.itemTitle}>{source?.description || copy.reductionDescription}</Text>
                    <Text style={invalid ? styles.errorText : styles.meta}>
                      {invalid ? lineErrors[0]?.message || copy.reductionCheckBody : copy.reductionRemaining}
                    </Text>
                  </View>
                  <Text accessibilityLabel={shown === undefined ? undefined : `Deduction ${formatDeductionCents(shown)}`} style={styles.deduction}>
                    {shown === undefined ? "" : formatDeductionCents(shown)}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${copy.reductionEdit}: ${source?.description ?? ""}`}
                    onPress={() => {
                      setEditingId(line.source_line_id);
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
                disabled={offline || busy || draft.sources.every((source) => amounts.some((line) => line.source_line_id === source.source_line_id))}
                onPress={() => {
                  const next = draft.sources.find((source) => !amounts.some((line) => line.source_line_id === source.source_line_id));
                  if (!next) {
                    return;
                  }
                  setAmounts((current) => [...current, { source_line_id: next.source_line_id, amount: "" }]);
                  setEditingId(next.source_line_id);
                  setPhase("edit");
                }}
                style={styles.secondary}
              >
                <Text style={styles.secondaryLabel}>{copy.reductionAdd}</Text>
              </Pressable>
            ) : null}
            {totals ? (
              <View style={styles.totals}>
                <View style={styles.row}>
                  <Text style={styles.support}>{copy.extraWorkAcceptedRow}</Text>
                  <Text style={styles.meta}>{formatUsdCents(totals.acceptedCents)}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={exceeds ? styles.errorText : styles.support}>{copy.reductionRow}</Text>
                  <Text style={styles.deduction}>{formatDeductionCents(totals.reductionCents)}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={exceeds ? styles.errorText : styles.revised}>{copy.extraWorkRevised}</Text>
                  <Text style={exceeds ? styles.errorText : styles.revisedAmount}>
                    {totals.revisedCents < 0 ? formatDeductionCents(totals.revisedCents) : formatUsdCents(totals.revisedCents)}
                  </Text>
                </View>
              </View>
            ) : null}
            <Text style={styles.fieldLabel}>
              {copy.reductionReason} {copy.reductionReasonHint}
            </Text>
            <TextInput value={reason} onChangeText={setReason} maxLength={500} editable={!offline && !busy} style={styles.input} />
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
                  <Text style={[styles.primaryLabel, reviewBlocked ? styles.primaryDisabledLabel : null]}>{copy.reductionReview}</Text>
                </Pressable>
                <Text style={showValidation && (errors.length > 0 || exceeds) ? styles.errorText : styles.support}>
                  {showValidation && (errors.length > 0 || exceeds) ? copy.reductionContinueHint : copy.reductionReviewNote}
                </Text>
              </>
            )}
          </View>
        ) : null}
        {draft && editing && editingAmount && phase === "edit" ? (
          <View>
            <Text style={styles.support}>{copy.reductionEditSupport}</Text>
            <Text style={styles.editing}>{copy.reductionEditing}</Text>
            <Text style={styles.fieldLabel}>{copy.reductionDescription}</Text>
            <Text style={styles.readOnly}>{editing.description}</Text>
            <Text style={styles.fieldLabel}>{copy.reductionRemaining}</Text>
            <Text style={styles.readOnly}>{formatUsdCents(editing.remaining_net_cents + editing.remaining_tax_cents)}</Text>
            <Text style={styles.fieldLabel}>{copy.reductionNet}</Text>
            <TextInput
              value={editingAmount.amount}
              onChangeText={(value) =>
                setAmounts((current) => current.map((line) => (line.source_line_id === editing.source_line_id ? { ...line, amount: value } : line)))
              }
              keyboardType="decimal-pad"
              editable={!offline && !busy}
              style={styles.input}
            />
            <View style={styles.lineTotal}>
              <Text style={styles.support}>{copy.reductionTotal}</Text>
              <Text style={styles.deduction}>
                {(() => {
                  const lineTotals = reductionTotals({
                    previousCents: draft.previous_total_cents,
                    sources: draft.sources,
                    amounts: [editingAmount],
                  });
                  return lineTotals ? formatDeductionCents(lineTotals.reductionCents) : "";
                })()}
              </Text>
            </View>
            <Pressable accessibilityRole="button" onPress={() => { setPhase("list"); setEditingId(undefined); }} style={styles.primary}>
              <Text style={styles.primaryLabel}>{copy.extraWorkDone}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${copy.reductionRemove}: ${editing.description}`}
              onPress={() => {
                setAmounts((current) => current.filter((line) => line.source_line_id !== editing.source_line_id));
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
            <Pressable accessibilityRole="button" onPress={() => router.replace(reductionContinueDestination(props.jobId))} style={styles.secondary}>
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
  back: { width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
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
  item: { minHeight: 78, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  itemInvalid: { borderColor: DANGER, borderWidth: 1.5 },
  itemCopy: { flex: 1, gap: 2 },
  itemTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  deduction: { color: DANGER, fontSize: 14, fontWeight: "700" },
  meta: { color: colors.secondary, fontSize: 12 },
  edit: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.infoTint, alignItems: "center", justifyContent: "center" },
  editGlyph: { color: colors.navy, fontSize: 16 },
  totals: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, gap: 7 },
  revised: { color: colors.text, fontSize: 14, fontWeight: "600" },
  revisedAmount: { color: colors.text, fontSize: 17, fontWeight: "700" },
  fieldLabel: { color: colors.text, fontSize: 12, fontWeight: "500" },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 13, backgroundColor: colors.surface, color: colors.text, fontSize: 14 },
  readOnly: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 14, backgroundColor: colors.surface, color: colors.text, fontSize: 14 },
  primary: { minHeight: 56, borderRadius: 16, backgroundColor: PRIMARY, alignItems: "center", justifyContent: "center" },
  primaryDisabled: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, opacity: 0.7 },
  primaryLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  primaryDisabledLabel: { color: colors.secondary },
  secondary: { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  secondaryLabel: { color: colors.navy, fontSize: 14, fontWeight: "600" },
  alert: { borderWidth: 1, borderColor: DANGER, borderRadius: 16, padding: 14, backgroundColor: colors.surface, gap: 2 },
  alertTitle: { color: DANGER, fontSize: 13, fontWeight: "600" },
  alertBody: { color: DANGER, fontSize: 11 },
  errorText: { color: DANGER, fontSize: 12 },
  ready: { backgroundColor: colors.infoTint, borderRadius: 16, padding: 14, gap: 2 },
  readyTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  editing: { backgroundColor: colors.infoTint, borderRadius: 12, minHeight: 42, paddingHorizontal: 12, color: colors.navy, fontWeight: "600", fontSize: 11 },
  lineTotal: { minHeight: 64, borderRadius: 14, backgroundColor: colors.infoTint, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  remove: { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  removeLabel: { color: DANGER, fontSize: 14, fontWeight: "600" },
  skeleton: { height: 70, borderRadius: 16, backgroundColor: colors.infoTint },
});
