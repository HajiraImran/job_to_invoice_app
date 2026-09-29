import { formatUsdCents } from "@job-to-invoice/schemas";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../../src/i18n/en.ts";
import { getCachedJob, upsertCachedJob } from "../../../../src/jobs/cache.ts";
import {
  jobLifecycleActions,
  jobPermitsAction,
  nextActionCopy,
  presentCurrentStep,
  presentJobActivity,
  presentJobDetail,
  presentJobDocuments,
  presentModePill,
  presentReceivableCents,
  presentScopeTotalCents,
  presentUpdatedLabel,
  type JobDetail,
} from "../../../../src/jobs/presentation.ts";
import { createLinkedJobPath, jobQuotePath, jobPublishPath, jobRequestPath, jobInvoicePath, jobInvoiceDetailPath, jobInvoiceReplacePath, jobChangePath, jobReducePath, jobsIndexPath } from "../../../../src/jobs/routes.ts";
import { quoteActionLabel } from "../../../../src/quotes/presentation.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors, type } from "../../../../src/theme.ts";

export default function JobDetailScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const jobId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? (params.id[0] ?? "") : "";
  const [job, setJob] = useState<JobDetail | undefined>();
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number } | undefined>();
  const [actionError, setActionError] = useState<{ message: string; retryable: boolean; status: number } | undefined>();
  const openKey = useRef<string | undefined>(undefined);
  const mutateKey = useRef<string | undefined>(undefined);
  const jobRef = useRef<JobDetail | undefined>(undefined);
  const authRef = useRef(auth);
  authRef.current = auth;

  const rememberJob = useCallback((next?: JobDetail) => {
    jobRef.current = next;
    setJob(next);
  }, []);

  const load = useCallback(async () => {
    if (!jobId) {
      setLoading(false);
      setError({ message: copy.jobNotFound, retryable: false, status: 404 });
      return;
    }
    if (!jobRef.current) {
      const session = authRef.current.getSyncSessionDb();
      if (session) {
        try {
          const cached = await getCachedJob(session.db, jobId);
          if (cached) {
            rememberJob(JSON.parse(cached.payloadJson) as JobDetail);
          }
        } catch {
          // A cache miss still falls through to the network load.
        }
      }
    }
    const refreshing = Boolean(jobRef.current);
    if (!refreshing) {
      setLoading(true);
    }
    const result = await runOwnerRequest<JobDetail>({ path: `/v1/jobs/${jobId}` });
    if (result.ok) {
      rememberJob(result.data);
      setError(undefined);
      setActionError(undefined);
      setLoading(false);
      const session = authRef.current.getSyncSessionDb();
      if (session) {
        void upsertCachedJob(session.db, {
          jobId,
          payloadJson: JSON.stringify(result.data),
          listState: result.data.lifecycle,
        }).catch(() => undefined);
      }
      return;
    }
    if (!jobRef.current) {
      const session = authRef.current.getSyncSessionDb();
      if (session && (result.error.status === 0 || authRef.current.snapshot.status === "offline_cached")) {
        try {
          const cached = await getCachedJob(session.db, jobId);
          if (cached) {
            rememberJob(JSON.parse(cached.payloadJson) as JobDetail);
            setError({
              message: copy.offlineCached,
              retryable: true,
              status: 0,
            });
            setLoading(false);
            return;
          }
        } catch {
          // Fall through to the network error when the cache cannot be read.
        }
      }
    }
    setError({
      message:
        result.error.status === 404
          ? copy.jobNotFound
          : jobRef.current
            ? copy.jobRefreshFailed
            : result.error.message || copy.jobLoadError,
      retryable: result.error.retryable || result.error.status === 0,
      status: result.error.status,
    });
    setLoading(false);
  }, [jobId, rememberJob, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const view = presentJobDetail({
    authStatus: auth.snapshot.status,
    loading,
    job,
    error,
  });
  const next = view.job
    ? nextActionCopy(view.job.mode, view.job.lifecycle, view.job.current_quote?.lifecycle, Boolean(view.job.active_invoice))
    : "none";
  const activeInvoice = view.job?.active_invoice;
  const latestInvoice = view.job?.latest_invoice;
  const quoteAction = quoteActionLabel(Boolean(view.job?.quote_draft));
  const quoteDisabled =
    opening || auth.snapshot.status === "access_expired" || auth.snapshot.status === "offline_cached";
  const actions = view.job ? jobLifecycleActions(view.job) : undefined;
  const lifecycleDisabled =
    mutating || auth.snapshot.status === "access_expired" || auth.snapshot.status === "offline_cached";

  async function openQuote() {
    if (!jobId || quoteDisabled) {
      return;
    }
    setOpening(true);
    openKey.current = retainOrCreateSetupIdempotencyKey(openKey.current);
    const result = await runOwnerRequest({
      path: `/v1/jobs/${jobId}/quote`,
      method: "POST",
      idempotencyKey: openKey.current,
    });
    setOpening(false);
    if (result.ok) {
      router.push(jobQuotePath(jobId));
      return;
    }
    if (result.error.code === "IDEMPOTENCY_MISMATCH") {
      openKey.current = retainOrCreateSetupIdempotencyKey(undefined);
    }
    setActionError({
      message: result.error.message || copy.quoteLoadError,
      retryable: result.error.retryable || result.error.status === 0,
      status: result.error.status,
    });
  }

  async function deleteDraft() {
    if (!jobId || lifecycleDisabled) {
      return;
    }
    setMutating(true);
    mutateKey.current = retainOrCreateSetupIdempotencyKey(mutateKey.current);
    const result = await runOwnerRequest<{ id: string; deleted: boolean }>({
      path: `/v1/jobs/${jobId}`,
      method: "DELETE",
      idempotencyKey: mutateKey.current,
    });
    setMutating(false);
    if (result.ok) {
      router.replace(jobsIndexPath());
      return;
    }
    if (result.error.code === "IDEMPOTENCY_MISMATCH") {
      mutateKey.current = retainOrCreateSetupIdempotencyKey(undefined);
    }
    setActionError({
      message: result.error.message || copy.jobLifecycleActionError,
      retryable: result.error.retryable || result.error.status === 0,
      status: result.error.status,
    });
  }

  async function cancelJob() {
    if (!jobId || lifecycleDisabled) {
      return;
    }
    const reason = cancelReason.trim();
    if (!reason) {
      setActionError({ message: copy.cancelJobReason, retryable: false, status: 422 });
      return;
    }
    setMutating(true);
    mutateKey.current = retainOrCreateSetupIdempotencyKey(mutateKey.current);
    const result = await runOwnerRequest<JobDetail>({
      path: `/v1/jobs/${jobId}/cancel`,
      method: "POST",
      body: { reason },
      idempotencyKey: mutateKey.current,
    });
    setMutating(false);
    if (result.ok) {
      rememberJob(result.data);
      setCancelReason("");
      setMenuOpen(false);
      return;
    }
    if (result.error.code === "IDEMPOTENCY_MISMATCH") {
      mutateKey.current = retainOrCreateSetupIdempotencyKey(undefined);
    }
    setActionError({
      message: result.error.message || copy.jobLifecycleActionError,
      retryable: result.error.retryable || result.error.status === 0,
      status: result.error.status,
    });
  }

  async function archiveJob(archived: boolean) {
    if (!jobId || lifecycleDisabled) {
      return;
    }
    if (auth.snapshot.status === "offline_cached") {
      setActionError({ message: copy.archiveJobOffline, retryable: false, status: 0 });
      return;
    }
    setMutating(true);
    mutateKey.current = retainOrCreateSetupIdempotencyKey(mutateKey.current);
    const result = await runOwnerRequest<JobDetail>({
      path: `/v1/jobs/${jobId}/archive`,
      method: "POST",
      body: { archived },
      idempotencyKey: mutateKey.current,
    });
    setMutating(false);
    if (result.ok) {
      rememberJob(result.data);
      return;
    }
    if (result.error.code === "IDEMPOTENCY_MISMATCH") {
      mutateKey.current = retainOrCreateSetupIdempotencyKey(undefined);
    }
    setActionError({
      message: result.error.message || copy.jobLifecycleActionError,
      retryable: result.error.retryable || result.error.status === 0,
      status: result.error.status,
    });
  }

  async function finishJob() {
    if (!jobId || lifecycleDisabled) {
      return;
    }
    if (auth.snapshot.status === "offline_cached") {
      setActionError({ message: copy.finishJobOffline, retryable: false, status: 0 });
      return;
    }
    setMutating(true);
    mutateKey.current = retainOrCreateSetupIdempotencyKey(mutateKey.current);
    const result = await runOwnerRequest<JobDetail>({
      path: `/v1/jobs/${jobId}/finish`,
      method: "POST",
      body: {},
      idempotencyKey: mutateKey.current,
    });
    setMutating(false);
    if (result.ok) {
      rememberJob(result.data);
      return;
    }
    if (result.error.code === "IDEMPOTENCY_MISMATCH") {
      mutateKey.current = retainOrCreateSetupIdempotencyKey(undefined);
    }
    setActionError({
      message: result.error.message || copy.jobLifecycleActionError,
      retryable: result.error.retryable || result.error.status === 0,
      status: result.error.status,
    });
  }

  const detail = view.job;
  const step = detail ? presentCurrentStep(detail) : undefined;
  const scopeCents = detail ? presentScopeTotalCents(detail) : null;
  const receivableCents = detail ? presentReceivableCents(detail) : null;
  const documents = detail ? presentJobDocuments(detail) : [];
  const activity = detail ? presentJobActivity(detail) : [];
  const quoteLabel =
    opening
      ? copy.quoteSaving
      : detail?.current_quote && detail.current_quote.lifecycle !== "issued"
        ? copy.createRevision
        : quoteAction === "open"
          ? copy.openQuote
          : copy.createQuote;
  const overflow = [
    actions?.canDelete ? "delete" : "",
    actions?.canCancel ? "cancel" : "",
    actions?.canFinish ? "finish" : "",
    actions?.canArchive ? "archive" : "",
    actions?.canRestore ? "restore" : "",
    actions?.canCreateLinked && next !== "none" ? "linked" : "",
  ].filter(Boolean);
  const siteLines = detail
    ? detail.no_site || !detail.site_address
      ? null
      : [
          detail.site_address.line1,
          detail.site_address.line2,
          `${detail.site_address.city}, ${detail.site_address.state} ${detail.site_address.postal_code}`,
        ].filter(Boolean)
    : null;

  function goBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(jobsIndexPath());
  }

  function openDocument(action: "quote" | "request" | "invoice" | "change", targetId?: string) {
    if (action === "quote") {
      router.push(jobPublishPath(jobId));
      return;
    }
    if (action === "request") {
      router.push(jobRequestPath(jobId));
      return;
    }
    if (action === "change") {
      router.push(jobChangePath(jobId));
      return;
    }
    if (targetId) {
      router.push(jobInvoiceDetailPath(jobId, targetId));
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <Pressable
            accessibilityLabel={copy.jobBack}
            accessibilityRole="button"
            hitSlop={4}
            onPress={goBack}
            style={styles.iconButton}
          >
            <Text style={styles.iconGlyph}>{"\u2039"}</Text>
          </Pressable>
          {overflow.length > 0 ? (
            <Pressable
              accessibilityLabel={copy.jobMoreActions}
              accessibilityRole="button"
              accessibilityState={{ disabled: mutating, expanded: menuOpen }}
              disabled={mutating}
              hitSlop={4}
              onPress={() => setMenuOpen(true)}
              style={styles.iconButton}
            >
              <Text style={styles.moreGlyph}>...</Text>
            </Pressable>
          ) : (
            <View style={styles.iconSpacer} />
          )}
        </View>

        {view.kind === "loading" ? (
          <View accessibilityLabel={copy.jobDetailTitle} accessibilityRole="progressbar">
            <View style={styles.skeletonLine} />
            <View style={styles.skeletonTitle} />
            <View style={styles.skeletonCard} />
            <View style={styles.skeletonCard} />
          </View>
        ) : null}

        {view.kind === "error" || view.kind === "offline" ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {view.message ?? copy.jobLoadError}
          </Text>
        ) : null}
        {view.kind === "missing" || view.kind === "access_expired" ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {view.kind === "access_expired" ? copy.accessExpired : copy.jobNotFound}
          </Text>
        ) : null}
        {(view.kind === "error" || view.kind === "offline") && view.showRetry ? (
          <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
            <Text style={styles.secondaryLabel}>{copy.retry}</Text>
          </Pressable>
        ) : null}

        {detail && step ? (
          <>
            <Text style={styles.eyebrow}>{copy.jobOverviewEyebrow}</Text>
            <Text accessibilityRole="header" style={styles.title}>
              {detail.title}
            </Text>
            <View style={styles.metaRow}>
              <View style={styles.pills}>
                <Text style={[styles.pill, pillTone(detail.lifecycle)]}>{lifecycleLabel(detail.lifecycle)}</Text>
                <Text style={styles.modePill}>{presentModePill(detail)}</Text>
              </View>
              <Text style={styles.updated}>{presentUpdatedLabel(detail.updated_at)}</Text>
            </View>
            {auth.snapshot.status === "offline_cached" ? (
              <Text accessibilityLiveRegion="polite" style={styles.banner}>
                {copy.offlineCached}
              </Text>
            ) : null}
            {loading ? (
              <Text accessibilityLiveRegion="polite" style={styles.updated}>
                {copy.jobRefreshing}
              </Text>
            ) : null}
            {view.refreshFailed ? (
              <View accessibilityLiveRegion="polite">
                <Text style={styles.error}>{view.message}</Text>
                {view.showRetry ? (
                  <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
                    <Text style={styles.secondaryLabel}>{copy.retry}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {actionError ? (
              <Text accessibilityLiveRegion="assertive" style={styles.error}>
                {actionError.message}
              </Text>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={detail.customer_name}
              onPress={() => router.push(`/(tabs)/customers/${detail.customer_id}`)}
              style={styles.infoCard}
            >
              <View style={styles.infoIcon}>
                <View style={styles.personMark} />
              </View>
              <View style={styles.infoCopy}>
                <Text style={styles.infoTitle}>{detail.customer_name}</Text>
              </View>
              <Text style={styles.chevron}>{"\u203A"}</Text>
            </Pressable>
            <View accessibilityLabel={copy.jobSite} style={styles.infoCard}>
              <View style={styles.infoIcon}>
                <View style={styles.siteMark} />
              </View>
              <View style={styles.infoCopy}>
                <Text style={styles.infoTitle}>{siteLines ? siteLines[0] : copy.noSiteAddress}</Text>
                <Text style={styles.infoMeta}>{siteLines ? siteLines.slice(1).join("\n") : copy.jobNoSiteHint}</Text>
              </View>
            </View>

            <Text accessibilityRole="header" style={styles.section}>
              {copy.jobOverview}
            </Text>
            <View style={styles.metricRow}>
              {scopeCents === null ? null : (
                <View style={styles.metricCard}>
                  <Text style={styles.metricLabel}>{copy.jobScopeTotal}</Text>
                  <Text style={styles.metricValue}>{formatUsdCents(scopeCents)}</Text>
                </View>
              )}
              <View style={styles.metricCard}>
                <Text style={styles.metricLabel}>{copy.jobCurrentStep}</Text>
                <Text style={[styles.stepValue, stepTone(step.tone)]}>{step.label}</Text>
              </View>
            </View>
            {receivableCents !== null ? (
              <View style={styles.metricCard}>
                <Text style={styles.metricLabel}>{copy.canceledReceivable}</Text>
                <Text style={styles.metricValue}>{formatUsdCents(receivableCents)}</Text>
              </View>
            ) : null}
            {detail.lifecycle === "canceled" ? <Text style={styles.banner}>{copy.linkedJobHint}</Text> : null}
            {detail.internal_notes ? (
              <>
                <Text style={styles.metricLabel}>{copy.internalNotes}</Text>
                <Text style={styles.infoMeta}>{detail.internal_notes}</Text>
              </>
            ) : null}

            {next === "quote" ? (
              <View style={styles.actionPanel}>
                <Text style={styles.actionTitle}>{quoteAction === "open" ? copy.openQuote : copy.jobCreateTheQuote}</Text>
                <Text style={styles.actionHint}>{copy.jobCreateQuoteHint}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: quoteDisabled, busy: opening }}
                  disabled={quoteDisabled}
                  onPress={() => void openQuote()}
                  style={[styles.primary, quoteDisabled ? styles.disabled : null]}
                >
                  <Text style={styles.primaryLabel}>{quoteLabel}</Text>
                </Pressable>
              </View>
            ) : null}
            {next === "direct" ? (
              <View style={styles.actionPanel}>
                <Text style={styles.actionTitle}>{copy.createInvoice}</Text>
                <Text style={styles.actionHint}>{copy.jobCreateInvoiceHint}</Text>
                <Pressable
                  accessibilityLabel={copy.createInvoice}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: quoteDisabled }}
                  disabled={quoteDisabled}
                  onPress={() => router.push(jobInvoicePath(jobId))}
                  style={[styles.primary, quoteDisabled ? styles.disabled : null]}
                >
                  <Text style={styles.primaryLabel}>{copy.createInvoice}</Text>
                </Pressable>
              </View>
            ) : null}
            {next === "invoice" ? (
              <Pressable
                accessibilityLabel={copy.createInvoice}
                accessibilityRole="button"
                accessibilityState={{ disabled: quoteDisabled }}
                disabled={quoteDisabled}
                onPress={() => router.push(jobInvoicePath(jobId))}
                style={[styles.primary, quoteDisabled ? styles.disabled : null]}
              >
                <Text style={styles.primaryLabel}>{copy.createInvoice}</Text>
              </Pressable>
            ) : null}
            {next === "invoice" && jobPermitsAction(detail, "create_change") ? (
              <View style={styles.pair}>
                <Pressable accessibilityRole="button" onPress={() => router.push(jobChangePath(jobId))} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{copy.extraWork}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => router.push(jobReducePath(jobId))} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{copy.reduceScope}</Text>
                </Pressable>
              </View>
            ) : null}
            {next === "view_invoice" && activeInvoice ? (
              <Pressable
                accessibilityLabel={copy.viewInvoice}
                accessibilityRole="button"
                onPress={() => router.push(jobInvoiceDetailPath(jobId, activeInvoice.id))}
                style={styles.primary}
              >
                <Text style={styles.primaryLabel}>{copy.viewInvoice}</Text>
              </Pressable>
            ) : null}
            {next === "replace_invoice" && latestInvoice ? (
              <>
                <Pressable
                  accessibilityLabel={copy.viewInvoice}
                  accessibilityRole="button"
                  onPress={() => router.push(jobInvoiceDetailPath(jobId, latestInvoice.id))}
                  style={styles.secondary}
                >
                  <Text style={styles.secondaryLabel}>{copy.viewInvoice}</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={copy.invoiceReplace}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: quoteDisabled }}
                  disabled={quoteDisabled}
                  onPress={() => router.push(jobInvoiceReplacePath(jobId, latestInvoice.id))}
                  style={[styles.primary, quoteDisabled ? styles.disabled : null]}
                >
                  <Text style={styles.primaryLabel}>{copy.invoiceReplace}</Text>
                </Pressable>
              </>
            ) : null}
            {actions?.canCreateLinked && next === "none" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: quoteDisabled }}
                disabled={quoteDisabled}
                onPress={() => router.push(createLinkedJobPath(jobId))}
                style={[styles.primary, quoteDisabled ? styles.disabled : null]}
              >
                <Text style={styles.primaryLabel}>{copy.createLinkedJob}</Text>
              </Pressable>
            ) : null}

            <Text accessibilityRole="header" style={styles.section}>
              {copy.jobDocuments}
            </Text>
            {documents.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.infoTitle}>{copy.jobDocumentsEmpty}</Text>
                <Text style={styles.infoMeta}>
                  {detail.mode === "direct_invoice" ? copy.jobDocumentsEmptyDirect : copy.jobDocumentsEmptyHint}
                </Text>
              </View>
            ) : (
              documents.map((row) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${row.title}. ${row.subtitle}`}
                  key={row.key}
                  onPress={() => openDocument(row.action, row.targetId)}
                  style={styles.docCard}
                >
                  <View style={styles.infoCopy}>
                    <Text style={styles.infoTitle}>{row.title}</Text>
                    <Text style={styles.infoMeta}>{row.subtitle}</Text>
                  </View>
                  <Text style={styles.chevron}>{"\u203A"}</Text>
                </Pressable>
              ))
            )}

            <Text accessibilityRole="header" style={styles.section}>
              {copy.jobActivity}
            </Text>
            {activity.map((row) => (
              <View key={row.key} style={styles.activityRow}>
                <View style={styles.activityDot} />
                <View style={styles.infoCopy}>
                  <Text style={styles.infoTitle}>{row.title}</Text>
                  <Text style={styles.infoMeta}>{new Date(row.at).toLocaleString()}</Text>
                </View>
              </View>
            ))}
          </>
        ) : null}
      </ScrollView>

      <Modal animationType="slide" onRequestClose={() => setMenuOpen(false)} transparent visible={menuOpen}>
        <Pressable accessibilityLabel={copy.jobCloseActions} onPress={() => setMenuOpen(false)} style={styles.scrim}>
          <Pressable accessibilityViewIsModal style={styles.sheet} onPress={() => undefined}>
            <Text accessibilityRole="header" style={styles.actionTitle}>
              {copy.jobMoreActions}
            </Text>
            {actionError ? (
              <Text accessibilityLiveRegion="assertive" style={styles.error}>
                {actionError.message}
              </Text>
            ) : null}
            {actions?.canDelete ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: lifecycleDisabled }}
                disabled={lifecycleDisabled}
                onPress={() => {
                  setMenuOpen(false);
                  Alert.alert(copy.deleteDraftTitle, copy.deleteDraftConfirm, [
                    { text: copy.keepJob, style: "cancel" },
                    { text: copy.deleteDraft, style: "destructive", onPress: () => void deleteDraft() },
                  ]);
                }}
                style={styles.sheetAction}
              >
                <Text style={styles.destructive}>{copy.deleteDraft}</Text>
              </Pressable>
            ) : null}
            {actions?.canCancel ? (
              <View>
                <Text style={styles.banner}>{copy.cancelJobNotice}</Text>
                <TextInput
                  accessibilityLabel={copy.cancelJobReason}
                  editable={!lifecycleDisabled}
                  multiline
                  onChangeText={setCancelReason}
                  style={styles.input}
                  value={cancelReason}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: lifecycleDisabled, busy: mutating }}
                  disabled={lifecycleDisabled}
                  onPress={() => void cancelJob()}
                  style={styles.sheetAction}
                >
                  <Text style={styles.destructive}>{mutating ? copy.jobWorking : copy.cancelJobConfirm}</Text>
                </Pressable>
              </View>
            ) : null}
            {actions?.canFinish ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: lifecycleDisabled, busy: mutating }}
                disabled={lifecycleDisabled}
                onPress={() => {
                  setMenuOpen(false);
                  Alert.alert(copy.finishJobTitle, copy.finishJobConfirm, [
                    { text: copy.keepJob, style: "cancel" },
                    { text: copy.finishJob, onPress: () => void finishJob() },
                  ]);
                }}
                style={styles.sheetAction}
              >
                <Text style={styles.sheetLabel}>{copy.finishJob}</Text>
              </Pressable>
            ) : null}
            {actions?.canArchive ? (
              <Pressable
                accessibilityRole="button"
                disabled={lifecycleDisabled}
                onPress={() => {
                  setMenuOpen(false);
                  Alert.alert(copy.archiveJobTitle, copy.archiveJobConfirm, [
                    { text: copy.keepJob, style: "cancel" },
                    { text: copy.archiveJob, onPress: () => void archiveJob(true) },
                  ]);
                }}
                style={styles.sheetAction}
              >
                <Text style={styles.sheetLabel}>{copy.archiveJob}</Text>
              </Pressable>
            ) : null}
            {actions?.canRestore ? (
              <Pressable
                accessibilityRole="button"
                disabled={lifecycleDisabled}
                onPress={() => {
                  setMenuOpen(false);
                  Alert.alert(copy.restoreJobTitle, copy.restoreJobConfirm, [
                    { text: copy.keepJob, style: "cancel" },
                    { text: copy.restoreJob, onPress: () => void archiveJob(false) },
                  ]);
                }}
                style={styles.sheetAction}
              >
                <Text style={styles.sheetLabel}>{copy.restoreJob}</Text>
              </Pressable>
            ) : null}
            {actions?.canCreateLinked && next !== "none" ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setMenuOpen(false);
                  router.push(createLinkedJobPath(jobId));
                }}
                style={styles.sheetAction}
              >
                <Text style={styles.sheetLabel}>{copy.createLinkedJob}</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" onPress={() => setMenuOpen(false)} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.keepJob}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function lifecycleLabel(lifecycle: string): string {
  switch (lifecycle) {
    case "active":
      return copy.jobLifecycleActive;
    case "invoiced":
      return copy.jobLifecycleInvoiced;
    case "finished":
      return copy.jobLifecycleFinished;
    case "canceled":
      return copy.jobLifecycleCanceled;
    case "archived":
      return copy.jobLifecycleArchived;
    default:
      return copy.jobLifecycleDraft;
  }
}

function pillTone(lifecycle: string) {
  if (lifecycle === "canceled") {
    return { backgroundColor: "#F8E8E8", color: colors.danger };
  }
  if (lifecycle === "finished" || lifecycle === "invoiced") {
    return { backgroundColor: "#E7F8F3", color: "#1FBC96" };
  }
  if (lifecycle === "active") {
    return { backgroundColor: "#E7F8F3", color: "#1FBC96" };
  }
  return { backgroundColor: "#FFF7E6", color: "#C58427" };
}

function stepTone(tone: "draft" | "ready" | "attention" | "neutral") {
  if (tone === "ready") {
    return { color: "#1FBC96" };
  }
  if (tone === "attention") {
    return { color: colors.danger };
  }
  if (tone === "draft") {
    return { color: "#464B71" };
  }
  return { color: colors.text };
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
  content: { padding: 20, gap: 12, paddingBottom: 48 },
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
  iconSpacer: { width: 48, height: 48 },
  iconGlyph: { color: colors.text, fontSize: 28, lineHeight: 32, marginTop: -2 },
  moreGlyph: { color: colors.text, fontSize: 18, letterSpacing: 1, fontWeight: "700" },
  eyebrow: { color: "#464B71", fontSize: 11, fontWeight: "600", letterSpacing: 0.6, marginTop: 8 },
  title: { color: "#17212B", fontSize: 27, lineHeight: 34, fontWeight: "700" },
  metaRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 8, flex: 1 },
  pill: { overflow: "hidden", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, fontSize: 12, fontWeight: "600" },
  modePill: {
    overflow: "hidden",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 12,
    fontWeight: "600",
    backgroundColor: "#EDEEF6",
    color: "#464B71",
  },
  updated: { color: "#52606D", fontSize: 11, flexShrink: 1, textAlign: "right" },
  infoCard: {
    minHeight: 66,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    backgroundColor: "#FFFFFF",
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  infoIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#EDEEF6",
    alignItems: "center",
    justifyContent: "center",
  },
  personMark: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: "#464B71" },
  siteMark: { width: 12, height: 12, borderRadius: 2, backgroundColor: "#464B71" },
  infoCopy: { flex: 1, gap: 2 },
  infoTitle: { color: "#17212B", fontSize: 14, fontWeight: "600" },
  infoMeta: { color: "#52606D", fontSize: 12 },
  chevron: { color: "#52606D", fontSize: 22 },
  section: { color: "#17212B", fontSize: 16, fontWeight: "600", marginTop: 8 },
  metricRow: { flexDirection: "row", gap: 12 },
  metricCard: {
    flex: 1,
    minHeight: 76,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    backgroundColor: "#FFFFFF",
    padding: 12,
    justifyContent: "center",
    gap: 4,
  },
  metricLabel: { color: "#52606D", fontSize: 11, fontWeight: "500" },
  metricValue: { color: "#17212B", fontSize: 20, fontWeight: "700" },
  stepValue: { fontSize: 16, fontWeight: "600" },
  actionPanel: { backgroundColor: "#EDEEF6", borderRadius: 18, padding: 14, gap: 8 },
  actionTitle: { color: "#17212B", fontSize: 16, fontWeight: "600" },
  actionHint: { color: "#52606D", fontSize: 12 },
  primary: {
    minHeight: 56,
    borderRadius: 16,
    backgroundColor: "#464B71",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  secondary: {
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  secondaryLabel: { color: "#464B71", fontSize: 15, fontWeight: "600" },
  pair: { gap: 8 },
  disabled: { opacity: 0.5 },
  emptyCard: {
    minHeight: 70,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    backgroundColor: "#FFFFFF",
    padding: 14,
    gap: 4,
  },
  docCard: {
    minHeight: 64,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    backgroundColor: "#FFFFFF",
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  activityRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  activityDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#1FBC96" },
  banner: { color: "#464B71", fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  skeletonLine: { height: 14, width: 120, borderRadius: 7, backgroundColor: "#E6EAF0" },
  skeletonTitle: { height: 28, width: "70%", borderRadius: 8, backgroundColor: "#E6EAF0", marginTop: 12 },
  skeletonCard: { height: 72, borderRadius: 16, backgroundColor: "#E6EAF0", marginTop: 12 },
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
  destructive: { color: colors.danger, fontSize: 16, fontWeight: "700" },
  input: {
    minHeight: 88,
    borderWidth: 1,
    borderColor: "#D5DCE3",
    borderRadius: 16,
    padding: 12,
    color: colors.text,
    fontSize: type.body,
    textAlignVertical: "top",
  },
});
