import { dollarsStringToCents, formatUsdCents, LINE_UNITS, NOTES_MAX, TERMS_MAX, type LineUnit } from "@job-to-invoice/schemas";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../../../../src/crypto/uuid.ts";
import { copy } from "../../../../src/i18n/en.ts";
import { jobDetailPath, jobPublishPath } from "../../../../src/jobs/routes.ts";
import {
  emptyQuoteLine,
  firstQuoteFieldError,
  formFromDraft,
  liveTotals,
  moveLine,
  payloadFromForm,
  quoteTotalsBreakdown,
  type QuoteDraftRecord,
  type QuoteFormValues,
  type QuoteLineForm,
} from "../../../../src/quotes/form.ts";
import { QuoteConflictScreen } from "../../../../src/quotes/conflict-screen.tsx";
import { presentConflictRecovery } from "../../../../src/quotes/conflict-presentation.ts";
import {
  decideQuoteAutosave,
  decideQuoteDraftOpen,
  emitQuotePersistDiagnostic,
  persistResultIsCurrent,
  quoteFormFingerprint,
  quoteFormIsUserEdited,
} from "../../../../src/quotes/autosave.ts";
import { presentQuoteEditor, presentQuoteSaveLabel, quoteReviewBlocked, type QuoteSaveStatus } from "../../../../src/quotes/presentation.ts";
import { lineFromCatalogueItem } from "../../../../src/items/form.ts";
import { CatalogueItemPicker } from "../../../../src/items/picker.tsx";
import { persistDraftLocally, drainOutbox } from "../../../../src/drafts/persist.ts";
import { getLocalDraft, getLocalDraftByJob } from "../../../../src/drafts/repository.ts";
import { getCachedJob } from "../../../../src/jobs/cache.ts";
import { reconcileServerDraftWithLocal } from "../../../../src/drafts/reconcile.ts";
import { getOpenOutboxForResource } from "../../../../src/sync/outbox.ts";
import { canUseCachedCommercialData } from "../../../../src/sync/offline-gate.ts";
import { isOfflineReadPermitted } from "@job-to-invoice/schemas";
import { retainOrCreateSetupIdempotencyKey } from "../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors, type } from "../../../../src/theme.ts";

const SAVE_DEBOUNCE_MS = 500;

function unitLabel(unit: LineUnit): string {
  switch (unit) {
    case "hour":
      return copy.unitHour;
    case "day":
      return copy.unitDay;
    case "square_foot":
      return copy.unitSquareFoot;
    case "linear_foot":
      return copy.unitLinearFoot;
    case "custom":
      return copy.unitCustom;
    default:
      return copy.unitItem;
  }
}

export default function QuoteEditorScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const jobId = typeof params.id === "string" ? params.id : "";
  const [draft, setDraft] = useState<QuoteDraftRecord | undefined>();
  const [values, setValues] = useState<QuoteFormValues>({ notes: "", terms: "", expiry_days: "14", lines: [] });
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<QuoteSaveStatus>("idle");
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number; code?: string } | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [notesOpen, setNotesOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [jobLabel, setJobLabel] = useState<{ title: string; customerName: string }>({ title: "", customerName: "" });
  const fieldRefs = useRef<Record<string, TextInput | null>>({});
  const reviewingRef = useRef(false);
  const openKey = useRef<string | undefined>(undefined);
  const saveKey = useRef<string | undefined>(undefined);
  const versionRef = useRef(1);
  const dirtyRef = useRef(false);
  const lastSavedRef = useRef<string | undefined>(undefined);
  const generationRef = useRef(0);
  const persistInFlight = useRef(false);
  const openedJobRef = useRef<string | undefined>(undefined);
  const draftRef = useRef<QuoteDraftRecord | undefined>(undefined);
  draftRef.current = draft;

  const load = useCallback(async (options?: { forceReload?: boolean }) => {
    if (!jobId) {
      setLoading(false);
      setError({ message: copy.jobNotFound, retryable: false, status: 404 });
      return;
    }
    const generation = generationRef.current;
    const stillCurrent = () => generation === generationRef.current;
    if (!draftRef.current || draftRef.current.job_id !== jobId) {
      setLoading(true);
    }
    setError(undefined);
    setSaveStatus((current) => (current === "conflict" ? current : "idle"));

    const session = auth.getSyncSessionDb();
    if (session) {
      try {
        const cachedJob = await getCachedJob(session.db, jobId);
        if (!stillCurrent()) {
          return;
        }
        if (cachedJob) {
          const payload = JSON.parse(cachedJob.payloadJson) as { title?: unknown; customer_name?: unknown };
          setJobLabel({
            title: typeof payload.title === "string" ? payload.title : "",
            customerName: typeof payload.customer_name === "string" ? payload.customer_name : "",
          });
        }
      } catch {
        // A missing job cache still leaves the quote editor usable.
      }
    }
    const offlineAllowed = canUseCachedCommercialData(
      auth.snapshot.status,
      auth.snapshot.lastAuthenticatedAt,
      Date.now(),
    );

    const applyLocalRecord = async (
      local: Awaited<ReturnType<typeof getLocalDraftByJob>>,
      status: QuoteSaveStatus,
    ) => {
      if (!local || !stillCurrent()) {
        return;
      }
      const parsed = JSON.parse(local.payloadJson) as QuoteDraftRecord;
      const record: QuoteDraftRecord = {
        ...parsed,
        id: local.draftId,
        job_id: local.jobId,
        version: local.baseVersion,
        schema_version: local.schemaVersion,
      };
      const form = formFromDraft(record);
      setDraft(record);
      setValues(form);
      lastSavedRef.current = quoteFormFingerprint(form);
      versionRef.current = local.baseVersion;
      dirtyRef.current = false;
      setSaveStatus(status);
      const openOp = session ? await getOpenOutboxForResource(session.db, local.draftId) : null;
      if (openOp) {
        saveKey.current = openOp.idempotencyKey;
      }
    };

    // 1) Always hydrate encrypted local draft first (survives force-close).
    let hadLocal = false;
    if (session && (auth.snapshot.status === "offline_cached" || auth.snapshot.status === "authenticated")) {
      try {
        const local = await getLocalDraftByJob(session.db, jobId);
        if (local) {
          hadLocal = true;
          const openOp = await getOpenOutboxForResource(session.db, local.draftId);
          await applyLocalRecord(
            local,
            local.syncState === "synced" && !openOp
              ? "synced"
              : local.syncState === "conflict"
                ? "conflict"
                : "saved_on_device",
          );
          if (!stillCurrent()) {
            return;
          }
          setLoading(false);
          if (auth.snapshot.status === "offline_cached") {
            openedJobRef.current = jobId;
            return;
          }
        }
      } catch {
        emitQuotePersistDiagnostic({ stage: "hydrate", outcome: "storage_failure" });
        /* fall through to network */
      }
    }

    if (auth.snapshot.status === "offline_cached") {
      setLoading(false);
      if (!offlineAllowed) {
        setError({ message: copy.accessExpired, retryable: false, status: 401 });
      } else if (!hadLocal) {
        setError({ message: copy.quoteLoadError, retryable: true, status: 0 });
      }
      return;
    }

    const openDecision = decideQuoteDraftOpen({
      jobId,
      openedJobId: openedJobRef.current,
      hasVisibleDraft: draftRef.current?.job_id === jobId,
      forceReload: options?.forceReload === true,
    });
    if (openDecision === "skip") {
      setLoading(false);
      return;
    }

    openKey.current = retainOrCreateSetupIdempotencyKey(openKey.current);
    emitQuotePersistDiagnostic({ stage: "open_draft", outcome: "ok" });
    const result = await runOwnerRequest<QuoteDraftRecord>({
      path: `/v1/jobs/${jobId}/quote`,
      method: "POST",
      idempotencyKey: openKey.current,
    });
    if (!stillCurrent()) {
      return;
    }
    if (result.ok) {
      setFieldErrors({});
      const adoptForm = (record: QuoteDraftRecord) => {
        const form = formFromDraft(record);
        setDraft(record);
        setValues(form);
        lastSavedRef.current = quoteFormFingerprint(form);
        versionRef.current = record.version;
        dirtyRef.current = false;
        setSaveStatus("synced");
      };
      if (!session) {
        adoptForm(result.data);
        openedJobRef.current = jobId;
        setLoading(false);
        return;
      }
      try {
        const reconciled = await reconcileServerDraftWithLocal(session.db, {
          jobId,
          server: {
            id: result.data.id,
            job_id: result.data.job_id,
            kind: result.data.kind,
            schema_version: result.data.schema_version,
            version: result.data.version,
            payloadJson: JSON.stringify(result.data),
          },
        });
        if (!stillCurrent()) {
          return;
        }
        if (!reconciled) {
          adoptForm(result.data);
        } else if (reconciled.adoptedServer) {
          await applyLocalRecord(reconciled.visible, "synced");
          dirtyRef.current = false;
        } else if (reconciled.enteredConflict) {
          await applyLocalRecord(reconciled.visible, "conflict");
          setError({
            message: copy.quoteConflict,
            retryable: true,
            status: 409,
            code: "VERSION_CONFLICT",
          });
        } else {
          await applyLocalRecord(reconciled.visible, reconciled.saveStatus);
        }
        openedJobRef.current = jobId;
      } catch {
        emitQuotePersistDiagnostic({ stage: "hydrate", outcome: "storage_failure" });
        if (!hadLocal && stillCurrent()) {
          adoptForm(result.data);
          openedJobRef.current = jobId;
        }
      }
    } else if (!hadLocal) {
      setError({
        message:
          result.error.code === "VALIDATION_FAILED" && result.error.field_errors?.some((item) => item.field === "mode")
            ? copy.quoteDirectBlocked
            : result.error.message || copy.quoteLoadError,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
        code: result.error.code,
      });
    }
    if (stillCurrent()) {
      setLoading(false);
    }
  }, [auth.getSyncSessionDb, auth.snapshot.lastAuthenticatedAt, auth.snapshot.status, jobId, runOwnerRequest]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    generationRef.current += 1;
    persistInFlight.current = false;
    openedJobRef.current = undefined;
    draftRef.current = undefined;
    lastSavedRef.current = undefined;
    dirtyRef.current = false;
    saveKey.current = undefined;
    openKey.current = undefined;
    setDraft(undefined);
    setValues({ notes: "", terms: "", expiry_days: "14", lines: [] });
    setSaveStatus("idle");
    setError(undefined);
    setFieldErrors({});
    void loadRef.current({ forceReload: true });
    return () => {
      generationRef.current += 1;
      persistInFlight.current = false;
    };
  }, [jobId]);

  const persist = useCallback(
    async (reason: "debounce" | "button") => {
      if (!draft) {
        return false;
      }
      const startedGeneration = generationRef.current;
      const apply = () =>
        persistResultIsCurrent({
          startedGeneration,
          currentGeneration: generationRef.current,
          draftJobId: draft.job_id,
          screenJobId: jobId,
        });
      if (!apply()) {
        emitQuotePersistDiagnostic({ stage: "upsert_draft", outcome: "stale" });
        return false;
      }
      if (auth.snapshot.status === "access_expired") {
        setSaveStatus("offline");
        return false;
      }
      if (
        auth.snapshot.status === "offline_cached" &&
        !isOfflineReadPermitted(auth.snapshot.lastAuthenticatedAt, Date.now())
      ) {
        setSaveStatus("offline");
        return false;
      }
      const fingerprintAtSave = quoteFormFingerprint(values);
      if (reason === "debounce" && !quoteFormIsUserEdited(fingerprintAtSave, lastSavedRef.current)) {
        emitQuotePersistDiagnostic({ stage: "upsert_draft", outcome: "skipped" });
        return false;
      }
      const parsed = payloadFromForm(values);
      if (!parsed.ok) {
        const next: Record<string, string> = {};
        for (const item of parsed.field_errors) {
          next[item.field] = item.message;
        }
        setFieldErrors(next);
        setSaveStatus("validation");
        return false;
      }
      const live = liveTotals(values);
      if (!live.ok) {
        const next: Record<string, string> = {};
        for (const item of live.field_errors) {
          next[item.field] = item.message;
        }
        setFieldErrors(next);
        setSaveStatus("validation");
        return false;
      }
      persistInFlight.current = true;
      setSaveStatus("saving_locally");
      setFieldErrors({});
      const session = auth.getSyncSessionDb();
      const localPayload = {
        ...draft,
        ...parsed.value,
        version: versionRef.current,
      };

      const finishStale = (stage: Parameters<typeof emitQuotePersistDiagnostic>[0]["stage"]) => {
        emitQuotePersistDiagnostic({ stage, outcome: "stale" });
        return false;
      };

      try {
        if (session) {
        if (!apply()) {
          return finishStale("upsert_draft");
        }
        const existingOp = await getOpenOutboxForResource(session.db, draft.id);
        const stableKey =
          existingOp?.idempotencyKey ??
          retainOrCreateSetupIdempotencyKey(reason === "button" ? undefined : saveKey.current);
        saveKey.current = stableKey;
        const operationId = existingOp?.operationId ?? stableKey;
        if (!apply()) {
          return finishStale("upsert_draft");
        }
        const local = await persistDraftLocally(session.db, {
          draftId: draft.id,
          jobId: draft.job_id,
          kind: draft.kind,
          schemaVersion: draft.schema_version,
          baseVersion: versionRef.current,
          serverVersion: draft.version,
          payload: localPayload,
          patchBody: parsed.value,
          operationId,
          idempotencyKey: stableKey,
        });
        if (!apply()) {
          return finishStale(local.stage ?? "upsert_draft");
        }
        if (local.status === "storage_failure") {
          emitQuotePersistDiagnostic({
            stage: local.stage ?? "upsert_draft",
            outcome: "storage_failure",
            code: local.code,
          });
          setSaveStatus("storage_failure");
          setError({
            message: copy.quoteStorageFailure,
            retryable: true,
            status: 0,
          });
          return false;
        }
        dirtyRef.current = false;
        lastSavedRef.current = fingerprintAtSave;
        setError(undefined);
        setSaveStatus("saved_on_device");
        if (auth.snapshot.status === "offline_cached") {
          return true;
        }
        if (!apply()) {
          return finishStale("enqueue_outbox");
        }
        setSaveStatus("synchronizing");
        const drained = await drainOutbox(session.db, {
          request: (options) => runOwnerRequest(options),
          forceImmediate: true,
        });
        if (!apply()) {
          return finishStale("mark_queued");
        }
        if (drained.conflicts > 0) {
          setSaveStatus("conflict");
          setError({
            message: copy.quoteConflict,
            retryable: true,
            status: 409,
            code: "VERSION_CONFLICT",
          });
          return false;
        }
        const saved = await getLocalDraft(session.db, draft.id);
        if (!apply()) {
          return finishStale("mark_queued");
        }
        if (saved?.serverVersion != null) {
          versionRef.current = saved.serverVersion;
        }
        if (drained.remaining === 0) {
          setSaveStatus("synced");
          return true;
        }
        setSaveStatus("saved_on_device");
        return true;
      }

      // Fallback when encrypted storage is unavailable: preserve prior online-only PATCH path.
      saveKey.current = retainOrCreateSetupIdempotencyKey(reason === "button" ? undefined : saveKey.current);
      if (auth.snapshot.status === "offline_cached") {
        emitQuotePersistDiagnostic({ stage: "upsert_draft", outcome: "storage_failure" });
        setSaveStatus("storage_failure");
        setError({
          message: copy.quoteStorageFailure,
          retryable: true,
          status: 0,
        });
        return false;
      }
      if (!apply()) {
        return finishStale("upsert_draft");
      }
      const result = await runOwnerRequest<QuoteDraftRecord>({
        path: `/v1/drafts/${draft.id}`,
        method: "PATCH",
        body: parsed.value,
        idempotencyKey: saveKey.current,
        ifMatch: versionRef.current,
      });
      if (!apply()) {
        return finishStale("upsert_draft");
      }
      if (result.ok) {
        setDraft(result.data);
        versionRef.current = result.data.version;
        dirtyRef.current = false;
        lastSavedRef.current = fingerprintAtSave;
        setError(undefined);
        setSaveStatus("synced");
        return true;
      }
      if (result.error.code === "VERSION_CONFLICT") {
        setSaveStatus("conflict");
        setError({
          message: copy.quoteConflict,
          retryable: true,
          status: result.error.status,
          code: result.error.code,
        });
        return false;
      }
      if (result.error.code === "IDEMPOTENCY_MISMATCH") {
        saveKey.current = retainOrCreateSetupIdempotencyKey(undefined);
      }
      if (result.error.field_errors) {
        const next: Record<string, string> = {};
        for (const item of result.error.field_errors) {
          next[item.field] = item.message;
        }
        setFieldErrors(next);
        setSaveStatus("validation");
        return false;
      }
      setSaveStatus("error");
      setError({
        message: result.error.message || copy.quoteSaveError,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
        code: result.error.code,
      });
      return false;
      } finally {
        persistInFlight.current = false;
      }
    },
    [auth, draft, jobId, runOwnerRequest, values],
  );

  useEffect(() => {
    const action = decideQuoteAutosave({
      hasDraft: Boolean(draft),
      userEdited: quoteFormIsUserEdited(quoteFormFingerprint(values), lastSavedRef.current),
      saveStatus,
      totalsOk: liveTotals(values).ok,
      inFlight: persistInFlight.current,
    });
    if (action === "skip") {
      return;
    }
    const handle = setTimeout(() => {
      void persist("debounce");
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [draft, persist, saveStatus, values]);

  function updateForm(next: QuoteFormValues) {
    dirtyRef.current = true;
    saveKey.current = retainOrCreateSetupIdempotencyKey(undefined);
    setValues(next);
    if (saveStatus === "conflict" || saveStatus === "storage_failure" || saveStatus === "error") {
      return;
    }
    setSaveStatus("idle");
  }

  function updateLine(index: number, patch: Partial<QuoteLineForm>) {
    updateForm({
      ...values,
      lines: values.lines.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)),
    });
  }

  function focusField(name: string | undefined) {
    if (!name) {
      return;
    }
    fieldRefs.current[name]?.focus();
  }

  function closeLine(index: number) {
    const parsed = payloadFromForm(values);
    const live = liveTotals(values);
    const problems = !parsed.ok ? parsed.field_errors : !live.ok ? live.field_errors : [];
    const next: Record<string, string> = {};
    for (const item of problems) {
      if (item.field === "lines" || item.field.startsWith(`lines.${index}.`)) {
        next[item.field] = item.message;
      }
    }
    if (Object.keys(next).length > 0) {
      setFieldErrors((current) => ({ ...current, ...next }));
      focusField(firstQuoteFieldError(next));
      return;
    }
    setEditingId(undefined);
  }

  async function reviewQuote() {
    const breakdown = quoteTotalsBreakdown(values);
    const blocked = quoteReviewBlocked({
      lineCount: values.lines.length,
      totalsOk: breakdown.ok,
      netCents: breakdown.ok ? breakdown.netCents : 0,
      offline: auth.snapshot.status === "offline_cached",
      busy: reviewing || saveStatus === "saving_locally" || saveStatus === "synchronizing" || saveStatus === "conflict",
      accessExpired: auth.snapshot.status === "access_expired",
      formUnsaved: quoteFormIsUserEdited(quoteFormFingerprint(values), lastSavedRef.current),
      saveStatus,
    });
    if (reviewingRef.current || reviewing || blocked) {
      return;
    }
    reviewingRef.current = true;
    setReviewing(true);
    if (dirtyRef.current || quoteFormIsUserEdited(quoteFormFingerprint(values), lastSavedRef.current)) {
      const saved = await persist("button");
      if (!saved) {
        reviewingRef.current = false;
        setReviewing(false);
        return;
      }
    }
    reviewingRef.current = false;
    setReviewing(false);
    router.push(jobPublishPath(jobId));
  }

  const view = presentQuoteEditor({
    authStatus: auth.snapshot.status,
    loading,
    draft,
    error,
    saveStatus,
  });
  if (view.kind === "access_expired" || view.kind === "conflict") {
    const recovery = presentConflictRecovery({
      authStatus: auth.snapshot.status,
      saveStatus,
      errorCode: error?.code,
      hasDraft: Boolean(draft),
      storageAvailable: Boolean(auth.getSyncSessionDb()),
    });
    return (
      <QuoteConflictScreen
        jobId={jobId}
        draftId={draft?.id}
        surface={recovery.surface === "editor" ? "conflict" : recovery.surface}
        onReload={() => load({ forceReload: true })}
      />
    );
  }
  const saveDisabled =
    saveStatus === "saving_locally" ||
    saveStatus === "synchronizing" ||
    saveStatus === "conflict" ||
    auth.snapshot.status === "access_expired";
  const breakdown = quoteTotalsBreakdown(values);
  const offline = auth.snapshot.status === "offline_cached";
  const formUnsaved = quoteFormIsUserEdited(quoteFormFingerprint(values), lastSavedRef.current);
  const reviewBlocked = quoteReviewBlocked({
    lineCount: values.lines.length,
    totalsOk: breakdown.ok,
    netCents: breakdown.ok ? breakdown.netCents : 0,
    offline,
    busy: reviewing || saveDisabled,
    accessExpired: auth.snapshot.status === "access_expired",
    formUnsaved,
    saveStatus,
  });
  const saveLabel =
    saveStatus === "storage_failure" || saveStatus === "error"
      ? ""
      : saveStatus === "synced"
      ? copy.quoteSavedJustNow
      : saveStatus === "saving_locally" || saveStatus === "synchronizing"
        ? copy.quoteSavingChanges
        : presentQuoteSaveLabel(saveStatus);
  const saveColor =
    saveStatus === "saved_on_device" || saveStatus === "validation" || saveStatus === "error" || saveStatus === "storage_failure"
      ? "#C58427"
      : saveStatus === "conflict"
        ? colors.danger
        : saveStatus === "synced"
          ? "#1FBC96"
          : "#464B71";

  function lineAmount(index: number): string | undefined {
    if (!breakdown.ok) {
      return undefined;
    }
    const line = breakdown.lines[index];
    return line ? formatUsdCents(line.total_cents) : undefined;
  }

  function lineSummary(line: QuoteLineForm): string {
    const price = dollarsStringToCents(line.unit_price);
    const unit = line.unit === "custom" && line.custom_unit_label.trim() ? line.custom_unit_label.trim() : unitLabel(line.unit);
    return `${line.quantity || "0"} × ${price.ok ? formatUsdCents(price.value) : line.unit_price} • ${unit}`;
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View pointerEvents="none" style={styles.atmosphere} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <Pressable
            accessibilityLabel={copy.quoteBackToJob}
            accessibilityRole="button"
            onPress={() => router.replace(jobDetailPath(jobId))}
            style={styles.iconButton}
          >
            <Text style={styles.iconGlyph}>{"\u2039"}</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={copy.quoteMoreActions}
            accessibilityRole="button"
            accessibilityState={{ expanded: menuOpen }}
            onPress={() => setMenuOpen(true)}
            style={styles.iconButton}
          >
            <Text style={styles.moreGlyph}>...</Text>
          </Pressable>
        </View>

        {view.kind === "loading" ? (
          <View accessibilityLabel={copy.quoteEditorTitle} accessibilityRole="progressbar">
            <View style={styles.skeletonLine} />
            <View style={styles.skeletonTitle} />
            <View style={styles.skeletonCard} />
            <View style={styles.skeletonCard} />
          </View>
        ) : null}

        {view.kind === "error" || view.kind === "offline" || view.kind === "missing" ? (
          <>
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {view.message ?? copy.quoteLoadError}
            </Text>
            {view.showRetry ? (
              <Pressable accessibilityRole="button" onPress={() => void load({ forceReload: true })} style={styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.retry}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}

        {draft && view.kind === "ready" ? (
          <>
            <Text style={styles.eyebrow}>{copy.quoteEditorEyebrow}</Text>
            <Text accessibilityRole="header" style={styles.title}>
              {jobLabel.title || copy.quoteEditorTitle}
            </Text>
            {saveLabel ? (
              <Text accessibilityLiveRegion="polite" style={[styles.saveStatus, { color: saveColor }]}>
                {saveLabel}
              </Text>
            ) : null}
            {offline ? (
              <View style={styles.offlineBanner}>
                <Text style={styles.offlineTitle}>{copy.quoteOfflineTitle}</Text>
                <Text style={styles.offlineBody}>{copy.quoteOfflineBody}</Text>
              </View>
            ) : null}
            {editingId ? (
              <View style={styles.metaRow}>
                <Text style={styles.pillMuted}>{copy.quoteEditingItem}</Text>
                <Text style={styles.metaHint}>{copy.quoteAutosaveHint}</Text>
              </View>
            ) : (
              <View style={styles.metaRow}>
                <View style={styles.pills}>
                  <Text style={styles.pillDraft}>{copy.jobLifecycleDraft}</Text>
                  <Text style={styles.pillMuted}>
                    {values.lines.length} {values.lines.length === 1 ? "item" : "items"}
                  </Text>
                </View>
                {jobLabel.customerName ? <Text style={styles.customer}>{jobLabel.customerName}</Text> : null}
              </View>
            )}

            {fieldErrors.lines ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {fieldErrors.lines}
              </Text>
            ) : null}
            {saveStatus === "error" || saveStatus === "storage_failure" ? (
              <View accessibilityLiveRegion="assertive">
                <Text style={styles.error}>{error?.message ?? copy.quoteStorageFailure}</Text>
                <Pressable accessibilityRole="button" onPress={() => void persist("button")} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{copy.retry}</Text>
                </Pressable>
              </View>
            ) : null}

            <View style={styles.sectionRow}>
              <Text accessibilityRole="header" style={styles.section}>
                {copy.quoteLineItems}
              </Text>
              <Text style={styles.metaHint}>{copy.quoteReorderWithButtons}</Text>
            </View>

            {values.lines.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.lineTitle}>{copy.quoteEmptyTitle}</Text>
                <Text style={styles.lineMeta}>{copy.quoteEmptyHint}</Text>
              </View>
            ) : null}

            {values.lines.map((line, index) => {
              const expanded = editingId === line.client_line_id;
              const amount = lineAmount(index);
              const summary = lineSummary(line);
              if (!expanded) {
                return (
                  <View key={line.client_line_id} style={styles.lineCard}>
                    <View style={styles.lineCopy}>
                      <Text style={styles.lineTitle}>{line.description || copy.quoteDescription}</Text>
                      <Text style={styles.lineMeta}>{summary}</Text>
                    </View>
                    <View style={styles.lineSide}>
                      {amount ? <Text style={styles.lineAmount}>{amount}</Text> : null}
                      <Pressable
                        accessibilityLabel={`${copy.quoteEditLineAction}. ${line.description}. ${summary}${amount ? `. ${amount}` : ""}`}
                        accessibilityRole="button"
                        onPress={() => setEditingId(line.client_line_id)}
                        style={styles.editHit}
                      >
                        <Text style={styles.editGlyph}>✎</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              }
              return (
                <View key={line.client_line_id} style={styles.editorCard}>
                  <Text style={styles.editorTitle}>{copy.quoteEditLine}</Text>
                  <Text style={styles.fieldLabel}>{copy.quoteDescription}</Text>
                  <TextInput
                    ref={(node) => {
                      fieldRefs.current[`lines.${index}.description`] = node;
                    }}
                    accessibilityLabel={copy.quoteDescription}
                    onChangeText={(value) => updateLine(index, { description: value })}
                    style={styles.input}
                    value={line.description}
                  />
                  {fieldErrors[`lines.${index}.description`] ? (
                    <Text accessibilityLiveRegion="polite" style={styles.error}>
                      {fieldErrors[`lines.${index}.description`]}
                    </Text>
                  ) : null}
                  <View style={styles.fieldRow}>
                    <View style={styles.fieldGrow}>
                      <Text style={styles.fieldLabel}>{copy.quoteQuantity}</Text>
                      <TextInput
                        ref={(node) => {
                          fieldRefs.current[`lines.${index}.quantity`] = node;
                        }}
                        accessibilityLabel={copy.quoteQuantity}
                        keyboardType="decimal-pad"
                        onChangeText={(value) => updateLine(index, { quantity: value })}
                        style={styles.input}
                        value={line.quantity}
                      />
                    </View>
                    <View style={styles.fieldGrow}>
                      <Text style={styles.fieldLabel}>{copy.quoteUnit}</Text>
                      <Text style={styles.inputStatic}>{line.unit === "custom" ? copy.unitCustom : unitLabel(line.unit)}</Text>
                    </View>
                    <View style={styles.fieldGrow}>
                      <Text style={styles.fieldLabel}>{copy.quoteUnitPrice}</Text>
                      <TextInput
                        ref={(node) => {
                          fieldRefs.current[`lines.${index}.unit_price_cents`] = node;
                        }}
                        accessibilityLabel={copy.quoteUnitPrice}
                        keyboardType="decimal-pad"
                        onChangeText={(value) => updateLine(index, { unit_price: value.replace(/^-/, "") })}
                        style={styles.input}
                        value={line.unit_price}
                      />
                    </View>
                  </View>
                  <View style={styles.chips}>
                    {LINE_UNITS.map((unit) => (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: line.unit === unit }}
                        key={unit}
                        onPress={() =>
                          updateLine(index, { unit, custom_unit_label: unit === "custom" ? line.custom_unit_label : "" })
                        }
                        style={[styles.chip, line.unit === unit ? styles.chipOn : null]}
                      >
                        <Text style={line.unit === unit ? styles.chipOnLabel : styles.chipLabel}>{unitLabel(unit)}</Text>
                      </Pressable>
                    ))}
                  </View>
                  {line.unit === "custom" ? (
                    <TextInput
                      ref={(node) => {
                        fieldRefs.current[`lines.${index}.custom_unit_label`] = node;
                      }}
                      accessibilityLabel={copy.quoteCustomUnit}
                      maxLength={20}
                      onChangeText={(value) => updateLine(index, { custom_unit_label: value })}
                      style={styles.input}
                      value={line.custom_unit_label}
                    />
                  ) : null}
                  <View style={styles.fieldRow}>
                    <View style={styles.fieldHalf}>
                      <Text style={styles.fieldLabel}>{copy.quoteDiscount}</Text>
                      <TextInput
                        ref={(node) => {
                          fieldRefs.current[`lines.${index}.discount_cents`] = node;
                        }}
                        accessibilityLabel={copy.quoteDiscount}
                        keyboardType="decimal-pad"
                        onChangeText={(value) => updateLine(index, { discount: value.replace(/^-/, "") })}
                        style={styles.input}
                        value={line.discount}
                      />
                    </View>
                    <View style={styles.fieldHalf}>
                      <Text style={styles.fieldLabel}>{copy.quoteTax}</Text>
                      <TextInput
                        ref={(node) => {
                          fieldRefs.current[`lines.${index}.tax_bp`] = node;
                        }}
                        accessibilityLabel={copy.quoteTax}
                        keyboardType="decimal-pad"
                        onChangeText={(value) => updateLine(index, { tax_percent: value.replace(/^-/, "") })}
                        style={styles.input}
                        value={line.tax_percent}
                      />
                    </View>
                  </View>
                  {["quantity", "unit", "unit_price_cents", "discount_cents", "tax_bp", "custom_unit_label"].map((name) =>
                    fieldErrors[`lines.${index}.${name}`] ? (
                      <Text accessibilityLiveRegion="polite" key={name} style={styles.error}>
                        {fieldErrors[`lines.${index}.${name}`]}
                      </Text>
                    ) : null,
                  )}
                  <View style={styles.lineTotal}>
                    <Text style={styles.fieldLabel}>{copy.quoteLineTotal}</Text>
                    <Text style={styles.lineTotalValue}>{amount ?? ""}</Text>
                  </View>
                  <View style={styles.reorderRow}>
                    <Pressable
                      accessibilityLabel={copy.quoteMoveUp}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: index === 0 }}
                      disabled={index === 0}
                      onPress={() => updateForm({ ...values, lines: moveLine(values.lines, index, -1) })}
                      style={styles.reorderButton}
                    >
                      <Text style={styles.secondaryLabel}>{copy.quoteMoveUp}</Text>
                    </Pressable>
                    <Pressable
                      accessibilityLabel={copy.quoteMoveDown}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: index === values.lines.length - 1 }}
                      disabled={index === values.lines.length - 1}
                      onPress={() => updateForm({ ...values, lines: moveLine(values.lines, index, 1) })}
                      style={styles.reorderButton}
                    >
                      <Text style={styles.secondaryLabel}>{copy.quoteMoveDown}</Text>
                    </Pressable>
                  </View>
                  <Pressable accessibilityRole="button" onPress={() => closeLine(index)} style={styles.primary}>
                    <Text style={styles.primaryLabel}>{copy.quoteDone}</Text>
                  </Pressable>
                </View>
              );
            })}

            {editingId ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  const index = values.lines.findIndex((line) => line.client_line_id === editingId);
                  if (index >= 0) {
                    updateForm({ ...values, lines: values.lines.filter((_, lineIndex) => lineIndex !== index) });
                  }
                  setEditingId(undefined);
                }}
                style={styles.removeHit}
              >
                <Text style={styles.removeLabel}>{copy.quoteRemoveLine}</Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  const created = emptyQuoteLine(secureRandomUUID(), draft.default_tax_bp);
                  updateForm({ ...values, lines: [...values.lines, created] });
                  setEditingId(created.client_line_id);
                }}
                style={styles.addButton}
              >
                <Text style={styles.addLabel}>+ {copy.quoteAddLine}</Text>
              </Pressable>
            )}

            {breakdown.ok && values.lines.length > 0 ? (
              <View style={styles.totalsCard}>
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>{copy.quoteSubtotal}</Text>
                  <Text style={styles.totalValue}>{formatUsdCents(breakdown.grossCents)}</Text>
                </View>
                {breakdown.discountCents > 0 ? (
                  <View style={styles.totalRow}>
                    <Text style={styles.totalLabel}>{copy.quoteDiscountTotal}</Text>
                    <Text style={styles.totalValue}>{formatUsdCents(breakdown.discountCents)}</Text>
                  </View>
                ) : null}
                {breakdown.discountCents > 0 ? (
                  <View style={styles.totalRow}>
                    <Text style={styles.totalLabel}>{copy.quoteNet}</Text>
                    <Text style={styles.totalValue}>{formatUsdCents(breakdown.netCents)}</Text>
                  </View>
                ) : null}
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>{copy.quoteTaxTotal}</Text>
                  <Text style={styles.totalValue}>{formatUsdCents(breakdown.taxCents)}</Text>
                </View>
                <View style={styles.totalDivider} />
                <View style={styles.totalRow}>
                  <Text style={styles.totalStrong}>{copy.quoteTotal}</Text>
                  <Text style={styles.totalStrongValue}>{formatUsdCents(breakdown.totalCents)}</Text>
                </View>
              </View>
            ) : null}

            {!editingId ? (
              <>
                <View style={styles.optionRow}>
                  <Pressable accessibilityRole="button" onPress={() => setNotesOpen((open) => !open)} style={styles.optionButton}>
                    <Text style={styles.optionLabel}>{copy.quoteNotes}</Text>
                    <Text style={styles.chevron}>{notesOpen ? "\u2039" : "\u203A"}</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" onPress={() => setTermsOpen((open) => !open)} style={styles.optionButton}>
                    <Text style={styles.optionLabel}>{copy.quoteTerms}</Text>
                    <Text style={styles.chevron}>{termsOpen ? "\u2039" : "\u203A"}</Text>
                  </Pressable>
                </View>
                {notesOpen ? (
                  <TextInput
                    ref={(node) => {
                      fieldRefs.current.notes = node;
                    }}
                    accessibilityLabel={copy.quoteNotes}
                    maxLength={NOTES_MAX}
                    multiline
                    onChangeText={(notes) => updateForm({ ...values, notes })}
                    style={[styles.input, styles.multiline]}
                    value={values.notes}
                  />
                ) : null}
                {fieldErrors.notes ? <Text style={styles.error}>{fieldErrors.notes}</Text> : null}
                {termsOpen ? (
                  <TextInput
                    ref={(node) => {
                      fieldRefs.current.terms = node;
                    }}
                    accessibilityLabel={copy.quoteTerms}
                    maxLength={TERMS_MAX}
                    multiline
                    onChangeText={(terms) => updateForm({ ...values, terms })}
                    style={[styles.input, styles.multiline]}
                    value={values.terms}
                  />
                ) : null}
                {fieldErrors.terms ? <Text style={styles.error}>{fieldErrors.terms}</Text> : null}
                <Pressable accessibilityRole="button" onPress={() => setExpiryOpen((open) => !open)} style={styles.expiryCard}>
                  <View style={styles.lineCopy}>
                    <Text style={styles.fieldLabel}>{copy.quoteExpiry}</Text>
                    <Text style={styles.lineTitle}>{copy.quoteExpiryAfter.replace("{count}", values.expiry_days || "14")}</Text>
                  </View>
                  <Text style={styles.chevron}>{"\u203A"}</Text>
                </Pressable>
                {expiryOpen ? (
                  <TextInput
                    ref={(node) => {
                      fieldRefs.current.expiry_days = node;
                    }}
                    accessibilityLabel={copy.quoteExpiry}
                    keyboardType="number-pad"
                    onChangeText={(expiry_days) => updateForm({ ...values, expiry_days })}
                    style={styles.input}
                    value={values.expiry_days}
                  />
                ) : null}
                {fieldErrors.expiry_days ? <Text style={styles.error}>{fieldErrors.expiry_days}</Text> : null}
              </>
            ) : null}
            <Text style={styles.currency}>{copy.quoteCurrency}</Text>
          </>
        ) : null}
      </ScrollView>

      {draft && view.kind === "ready" ? (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: reviewBlocked, busy: reviewing }}
            disabled={reviewBlocked}
            onPress={() => void reviewQuote()}
            style={[styles.review, reviewBlocked ? styles.disabled : null]}
          >
            <Text style={styles.primaryLabel}>{reviewing ? copy.quoteSavingChanges : copy.quoteReview}</Text>
          </Pressable>
        </View>
      ) : null}

      <CatalogueItemPicker
        onClose={() => setPickerOpen(false)}
        onPick={(item) => {
          const created = lineFromCatalogueItem(item, secureRandomUUID());
          updateForm({ ...values, lines: [...values.lines, created] });
          setEditingId(created.client_line_id);
        }}
        visible={pickerOpen}
      />
      <Modal animationType="slide" onRequestClose={() => setMenuOpen(false)} transparent visible={menuOpen}>
        <Pressable accessibilityLabel={copy.quoteCloseActions} onPress={() => setMenuOpen(false)} style={styles.scrim}>
          <Pressable accessibilityViewIsModal onPress={() => undefined} style={styles.sheet}>
            <Text accessibilityRole="header" style={styles.editorTitle}>
              {copy.quoteMoreActions}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setMenuOpen(false);
                setPickerOpen(true);
              }}
              style={styles.sheetAction}
            >
              <Text style={styles.sheetLabel}>{copy.quoteUseSavedItem}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: saveDisabled, busy: saveStatus === "saving_locally" || saveStatus === "synchronizing" }}
              disabled={saveDisabled}
              onPress={() => {
                setMenuOpen(false);
                void persist("button");
              }}
              style={styles.sheetAction}
            >
              <Text style={styles.sheetLabel}>{copy.quoteSave}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setMenuOpen(false)} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.keepJob}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#F7F8FA" },
  atmosphere: {
    position: "absolute",
    top: -80,
    right: -70,
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: "#E4EAF6",
  },
  content: { padding: 20, gap: 12, paddingBottom: 120 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#D5DCE3",
    alignItems: "center",
    justifyContent: "center",
  },
  iconGlyph: { color: "#17212B", fontSize: 28, lineHeight: 32 },
  moreGlyph: { color: "#17212B", fontSize: 18, fontWeight: "700", letterSpacing: 1 },
  eyebrow: { color: "#464B71", fontSize: 11, fontWeight: "600", letterSpacing: 0.6 },
  title: { color: "#17212B", fontSize: 26, lineHeight: 34, fontWeight: "700" },
  saveStatus: { fontSize: 12, fontWeight: "500" },
  metaRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  pills: { flexDirection: "row", gap: 8 },
  pillDraft: {
    overflow: "hidden",
    backgroundColor: "#FFF7E6",
    color: "#C58427",
    borderRadius: 13,
    paddingHorizontal: 10,
    paddingVertical: 5,
    fontSize: 11,
    fontWeight: "600",
  },
  pillMuted: {
    overflow: "hidden",
    backgroundColor: "#EDEEF6",
    color: "#464B71",
    borderRadius: 13,
    paddingHorizontal: 10,
    paddingVertical: 5,
    fontSize: 11,
    fontWeight: "600",
  },
  customer: { color: "#52606D", fontSize: 11, fontWeight: "500", flexShrink: 1 },
  metaHint: { color: "#52606D", fontSize: 11 },
  offlineBanner: { backgroundColor: "#FFF7E6", borderRadius: 15, padding: 12, gap: 2 },
  offlineTitle: { color: "#17212B", fontSize: 13, fontWeight: "600" },
  offlineBody: { color: "#52606D", fontSize: 11 },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  section: { color: "#17212B", fontSize: 17, fontWeight: "600" },
  lineCard: {
    minHeight: 70,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  lineCopy: { flex: 1, gap: 2 },
  lineTitle: { color: "#17212B", fontSize: 14, fontWeight: "600" },
  lineMeta: { color: "#52606D", fontSize: 11 },
  lineSide: { alignItems: "flex-end", gap: 2 },
  lineAmount: { color: "#17212B", fontSize: 14, fontWeight: "600" },
  editHit: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  editGlyph: { color: "#464B71", fontSize: 16 },
  editorCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    backgroundColor: "#FFFFFF",
    padding: 14,
    gap: 8,
  },
  editorTitle: { color: "#17212B", fontSize: 17, fontWeight: "600" },
  fieldLabel: { color: "#52606D", fontSize: 11, fontWeight: "500" },
  fieldRow: { flexDirection: "row", gap: 8 },
  fieldGrow: { flex: 1, gap: 4 },
  fieldHalf: { flex: 1, gap: 4 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    borderRadius: 13,
    backgroundColor: "#F7F8FA",
    paddingHorizontal: 12,
    color: "#17212B",
    fontSize: 14,
  },
  inputStatic: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    borderRadius: 13,
    backgroundColor: "#F7F8FA",
    paddingHorizontal: 12,
    color: "#17212B",
    fontSize: 14,
    textAlignVertical: "center",
    lineHeight: 48,
  },
  multiline: { minHeight: 88, textAlignVertical: "top", paddingTop: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  chipOn: { backgroundColor: "#464B71", borderColor: "#464B71" },
  chipLabel: { color: "#464B71", fontSize: 13, fontWeight: "600" },
  chipOnLabel: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
  lineTotal: {
    minHeight: 58,
    borderRadius: 14,
    backgroundColor: "#EDEEF6",
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  lineTotalValue: { color: "#464B71", fontSize: 18, fontWeight: "700" },
  reorderRow: { flexDirection: "row", gap: 8 },
  reorderButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  primary: {
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: "#464B71",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  removeHit: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  removeLabel: { color: "#B73E3E", fontSize: 14, fontWeight: "600" },
  addButton: {
    minHeight: 48,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: "#464B71",
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  addLabel: { color: "#464B71", fontSize: 15, fontWeight: "600" },
  emptyCard: {
    minHeight: 70,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    backgroundColor: "#FFFFFF",
    padding: 14,
    gap: 4,
  },
  totalsCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    backgroundColor: "#FFFFFF",
    padding: 14,
    gap: 8,
  },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  totalLabel: { color: "#52606D", fontSize: 12 },
  totalValue: { color: "#17212B", fontSize: 12, fontWeight: "500" },
  totalDivider: { height: 1, backgroundColor: "#E7EBEF" },
  totalStrong: { color: "#17212B", fontSize: 15, fontWeight: "600" },
  totalStrongValue: { color: "#17212B", fontSize: 19, fontWeight: "700" },
  optionRow: { flexDirection: "row", gap: 12 },
  optionButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  optionLabel: { color: "#17212B", fontSize: 12, fontWeight: "600" },
  chevron: { color: "#52606D", fontSize: 18 },
  expiryCard: {
    minHeight: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 14,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
  },
  currency: { color: "#52606D", fontSize: 11 },
  footer: {
    borderTopWidth: 1,
    borderTopColor: "#D5DCE3",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  review: {
    minHeight: 56,
    borderRadius: 16,
    backgroundColor: "#464B71",
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.45 },
  secondary: {
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  secondaryLabel: { color: "#464B71", fontSize: 15, fontWeight: "600" },
  error: { color: colors.danger, fontSize: type.secondary },
  skeletonLine: { height: 14, width: 120, borderRadius: 7, backgroundColor: "#E6EAF0" },
  skeletonTitle: { height: 28, width: "70%", borderRadius: 8, backgroundColor: "#E6EAF0" },
  skeletonCard: { height: 72, borderRadius: 16, backgroundColor: "#E6EAF0" },
  scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(18,30,43,0.38)" },
  sheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    gap: 8,
    paddingBottom: 32,
  },
  sheetAction: { minHeight: 48, justifyContent: "center" },
  sheetLabel: { color: "#17212B", fontSize: 16, fontWeight: "600" },
});
