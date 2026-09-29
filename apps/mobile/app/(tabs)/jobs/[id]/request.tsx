import { formatUsdCents } from "@job-to-invoice/schemas";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Linking,
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
import { copy } from "../../../../src/i18n/en.ts";
import { jobDetailPath, jobPublishPath } from "../../../../src/jobs/routes.ts";
import {
  presentApprovalReceipt,
  presentCalendarDate,
  presentDeliveryStatus,
  presentQuotePdf,
  presentRequestActions,
  presentRequestActivity,
  presentRequestDetail,
  presentRequestTimestamp,
  requestIdempotencyAfterFailure,
  requestMutationAllowed,
  type OwnerRequestRecord,
  type PublishedQuoteRecord,
  type QuotePdfDownload,
} from "../../../../src/quotes/presentation.ts";
import {
  decideReplaceResume,
  emitReplaceResumeDiagnostic,
  type PendingReplaceIntent,
} from "../../../../src/quotes/pending-replace.ts";
import {
  beginReplaceAttempt,
  buildReplaceIntent,
  endReplaceAttempt,
  performReplaceLink,
  replaceAttemptActive,
} from "../../../../src/quotes/request-replace.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { grantErrorIsAutoRetryable } from "../../../../src/session/step-up.ts";
import { createSetupIdempotencyKey, retainOrCreateSetupIdempotencyKey } from "../../../../src/setup/idempotency.ts";
import { colors } from "../../../../src/theme.ts";

type RequestFacts = {
  documentId: string;
  totalCents?: number;
  customerName?: string;
  expiryLocalDate?: string;
  pdfState?: string;
  issueDate?: string;
};

type Phase = "idle" | "withdraw_confirm" | "replace_confirm" | "replace_resume";

export default function QuoteRequestScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const jobId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? (params.id[0] ?? "") : "";
  const [request, setRequest] = useState<OwnerRequestRecord | undefined>();
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [withdrawReason, setWithdrawReason] = useState("Owner withdrew pending request");
  const [banner, setBanner] = useState<string | undefined>();
  const [facts, setFacts] = useState<RequestFacts | undefined>();
  const [loadedAt, setLoadedAt] = useState<string | undefined>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number; code?: string } | undefined>();
  const inFlight = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const resendKey = useRef<string | undefined>(undefined);
  const withdrawKey = useRef<string | undefined>(undefined);
  const mutateLock = useRef(false);
  const attemptedKey = useRef<string | undefined>(undefined);
  const grantBlocked = useRef(false);
  const completeReplaceRef = useRef<
    (
      intent: PendingReplaceIntent | undefined,
      source: "user" | "resume",
      options?: { alreadyLocked?: boolean },
    ) => Promise<void>
  >(async () => undefined);

  const load = useCallback(async () => {
    if (!jobId || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setChecking(true);
    if (!requestRef.current) {
      setLoading(true);
    }
    const result = await runOwnerRequest<OwnerRequestRecord>({ path: `/v1/jobs/${jobId}/request` });
    if (!result.ok) {
      inFlight.current = false;
      setChecking(false);
      setLoading(false);
      setError({
        message: result.error.status === 404 ? copy.jobNotFound : result.error.message || copy.requestRefreshFailed,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
        code: result.error.code,
      });
      return;
    }
    setRequest(result.data);
    setLoadedAt(new Date().toISOString());
    setError(undefined);
    setFacts((current) => (current?.documentId === result.data.document_id ? current : undefined));
    const document = await runOwnerRequest<PublishedQuoteRecord>({ path: `/v1/documents/${result.data.document_id}` });
    if (document.ok && typeof document.data.total_cents === "number") {
      const name = document.data.snapshot?.customer?.name?.trim();
      setFacts({
        documentId: result.data.document_id,
        totalCents: document.data.total_cents,
        customerName: name || undefined,
        expiryLocalDate: document.data.snapshot?.expiry_local_date,
        pdfState: document.data.pdf_state,
        issueDate: document.data.snapshot?.issue_date,
      });
    }
    inFlight.current = false;
    setChecking(false);
    setLoading(false);
  }, [jobId, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    const pending = auth.pendingReplace;
    const decision = decideReplaceResume({
      authStatus: auth.snapshot.status,
      pending,
      jobId,
      requestId: request?.request_id,
      requestLoaded: Boolean(request),
      inFlight: replaceAttemptActive() || submitting,
      attemptedKey: attemptedKey.current,
      grantBlocked: grantBlocked.current,
      ownerId: auth.bootstrap?.user.id,
      nowMs: Date.now(),
    });
    if (decision.outcome !== "missing") {
      emitReplaceResumeDiagnostic({ stage: decision.stage, outcome: decision.outcome });
    }
    if (decision.action === "wait" || decision.action === "skip") {
      return;
    }
    if (decision.action === "reject") {
      attemptedKey.current = undefined;
      grantBlocked.current = false;
      void auth.forgetPendingReplace();
      setPhase("idle");
      setBanner(undefined);
      setError({
        message: decision.outcome === "expired" ? copy.requestReplaceExpired : copy.requestReplaceInvalid,
        retryable: false,
        status: 409,
      });
      return;
    }
    if (!pending) {
      return;
    }
    attemptedKey.current = pending.idempotencyKey;
    void completeReplaceRef.current(pending, "resume");
  }, [auth.bootstrap?.user.id, auth.forgetPendingReplace, auth.pendingReplace, auth.snapshot.status, jobId, request, submitting]);

  useEffect(() => {
    if (auth.snapshot.status !== "access_expired") {
      return;
    }
    setRequest(undefined);
    setFacts(undefined);
    setBanner(undefined);
    setMenuOpen(false);
    setPhase("idle");
  }, [auth.snapshot.status]);

  const view = presentDeliveryStatus({
    authStatus: auth.snapshot.status,
    loading,
    checking,
    request,
    error,
  });
  const actions = presentRequestActions({
    authStatus: auth.snapshot.status,
    request,
    submitting,
  });

  async function runMutation(
    path: string,
    options: {
      method?: "POST";
      body?: unknown;
      headers?: Record<string, string>;
      successMessage: string;
      keyRef: { current: string | undefined };
    },
  ) {
    if (!requestMutationAllowed({
      inFlight: mutateLock.current,
      offline: auth.snapshot.status === "offline_cached",
      action: "ready",
    })) {
      return;
    }
    const idempotencyKey = retainOrCreateSetupIdempotencyKey(options.keyRef.current);
    options.keyRef.current = idempotencyKey;
    mutateLock.current = true;
    setSubmitting(true);
    setBanner(undefined);
    setError(undefined);
    const result = await runOwnerRequest({
      path,
      method: "POST",
      body: options.body ?? {},
      headers: {
        "Idempotency-Key": idempotencyKey,
        ...(options.headers ?? {}),
      },
    });
    mutateLock.current = false;
    setSubmitting(false);
    if (!result.ok) {
      if (requestIdempotencyAfterFailure(result.error.code) === "rotate") {
        options.keyRef.current = undefined;
      }
      setError({
        message: result.error.message || copy.requestMutationError,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
        code: result.error.code,
      });
      return;
    }
    options.keyRef.current = undefined;
    setPhase("idle");
    setMenuOpen(false);
    setBanner(options.successMessage);
    await load();
  }

  async function onResend() {
    if (!request || actions.resend !== "ready") {
      return;
    }
    await runMutation(`/v1/requests/${request.request_id}/resend`, {
      successMessage: copy.requestResendDone,
      keyRef: resendKey,
    });
  }

  async function onWithdraw() {
    if (!request || actions.withdraw !== "ready") {
      return;
    }
    const reason = withdrawReason.trim();
    if (reason.length < 1) {
      setError({ message: copy.requestWithdrawReason, retryable: false, status: 422 });
      return;
    }
    await runMutation(`/v1/requests/${request.request_id}/withdraw`, {
      body: { reason },
      successMessage: copy.requestWithdrawDone,
      keyRef: withdrawKey,
    });
  }

  async function completeReplace(
    intent: PendingReplaceIntent | undefined,
    source: "user" | "resume",
    options?: { alreadyLocked?: boolean },
  ) {
    if (!intent) {
      return;
    }
    if (!options?.alreadyLocked && !beginReplaceAttempt()) {
      emitReplaceResumeDiagnostic({ stage: "resume_waiting_for_auth", outcome: "in_flight" });
      return;
    }
    mutateLock.current = true;
    setSubmitting(true);
    setBanner(undefined);
    setError(undefined);
    try {
      const result = await performReplaceLink(runOwnerRequest, intent);
      if (!result.ok && result.stepUp) {
        if (source === "user") {
          emitReplaceResumeDiagnostic({ stage: "step_up_started", outcome: "required" });
          const email = auth.emailDisplay || auth.snapshot.emailDisplay || "";
          if (email) {
            auth.setEmailDisplay(email);
          }
          auth.setCode("");
          await auth.sendCode();
          return;
        }
        grantBlocked.current = true;
        emitReplaceResumeDiagnostic({
          stage: "retry_suppressed",
          outcome: "action_grant_required",
          status: 403,
          code: "ACTION_GRANT_REQUIRED",
        });
        setPhase("replace_resume");
        setError({
          message: copy.requestReplaceFreshAuth,
          retryable: false,
          status: 403,
        });
        return;
      }
      if (!result.ok) {
        const retryable = grantErrorIsAutoRetryable(result.error);
        if (!retryable) {
          grantBlocked.current = result.error.status === 403 || result.error.status === 401 || result.error.status === 422;
        }
        setPhase("replace_resume");
        setError({
          message: result.error.message || copy.requestMutationError,
          retryable,
          status: result.error.status,
        });
        return;
      }
      attemptedKey.current = undefined;
      grantBlocked.current = false;
      await auth.forgetPendingReplace();
      setPhase("idle");
      setBanner(copy.requestReplaceDone);
      await load();
    } finally {
      mutateLock.current = false;
      setSubmitting(false);
      endReplaceAttempt();
    }
  }
  completeReplaceRef.current = completeReplace;

  async function startReplace() {
    if (!request || auth.snapshot.status === "offline_cached") {
      return;
    }
    const ownerId = auth.bootstrap?.user.id;
    if (!ownerId) {
      return;
    }
    const intent = buildReplaceIntent({
      requestId: request.request_id,
      jobId,
      ownerId,
      idempotencyKey: createSetupIdempotencyKey(),
      nowMs: Date.now(),
    });
    if (!intent) {
      return;
    }
    if (!beginReplaceAttempt()) {
      emitReplaceResumeDiagnostic({ stage: "resume_waiting_for_auth", outcome: "in_flight" });
      return;
    }
    attemptedKey.current = undefined;
    grantBlocked.current = false;
    await auth.rememberPendingReplace(intent);
    await completeReplace(intent, "user", { alreadyLocked: true });
  }

  async function cancelReplace() {
    attemptedKey.current = undefined;
    grantBlocked.current = false;
    await auth.forgetPendingReplace();
    setPhase("idle");
    setError(undefined);
  }

  const visibleRequest = view.kind === "access_expired" ? undefined : request;
  const matchedFacts = facts?.documentId === visibleRequest?.document_id ? facts : undefined;
  const detail = presentRequestDetail(visibleRequest);
  const activity = presentRequestActivity(visibleRequest, { quoteIssuedOn: matchedFacts?.issueDate });
  const amount = typeof matchedFacts?.totalCents === "number" ? formatUsdCents(matchedFacts.totalCents) : undefined;
  const customerName = matchedFacts?.customerName;
  const createdLabel = presentRequestTimestamp(visibleRequest?.created_at);
  const expiryLabel = presentCalendarDate(matchedFacts?.expiryLocalDate);
  const receipt = presentApprovalReceipt({
    requestState: visibleRequest?.request_state,
    decidedAt: visibleRequest?.decided_at,
    pdfState: matchedFacts?.pdfState,
  });
  const showOverflow = actions.withdraw !== "hidden" || actions.replaceLink !== "hidden";
  const loadedLabel = error && visibleRequest ? presentRequestTimestamp(loadedAt) : undefined;

  function goToJob() {
    setMenuOpen(false);
    router.replace(jobDetailPath(jobId));
  }

  async function openReceipt() {
    if (!visibleRequest || !receipt.visible || receipt.pdf === "hidden" || mutateLock.current) {
      return;
    }
    const result = await runOwnerRequest<QuotePdfDownload>({
      path: `/v1/documents/${visibleRequest.document_id}/download`,
    });
    if (!result.ok) {
      setError({
        message: result.error.message || copy.requestReceiptUnavailable,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
        code: result.error.code,
      });
      return;
    }
    const pdf = presentQuotePdf(result.data);
    if (pdf.kind === "ready" && pdf.url) {
      try {
        await Linking.openURL(pdf.url);
      } catch {
        setError({ message: copy.quotePdfOpenError, retryable: true, status: 0 });
      }
      return;
    }
    setBanner(pdf.kind === "failed" ? copy.quotePdfFailed : copy.requestReceiptPreparing);
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={styles.atmosphere} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Pressable accessibilityLabel={copy.requestBackToJob} accessibilityRole="button" onPress={goToJob} style={styles.iconButton}>
            <Text style={styles.iconGlyph}>‹</Text>
          </Pressable>
          <View style={styles.titleBlock}>
            <Text style={styles.eyebrow}>{copy.requestDetailEyebrow}</Text>
            <Text accessibilityRole="header" style={styles.title}>
              {copy.requestDetailTitle}
            </Text>
          </View>
          {showOverflow ? (
            <Pressable
              accessibilityLabel={copy.requestMore}
              accessibilityRole="button"
              accessibilityState={{ expanded: menuOpen }}
              onPress={() => setMenuOpen(true)}
              style={styles.iconButton}
            >
              <Text style={styles.moreGlyph}>•••</Text>
            </Pressable>
          ) : (
            <View style={styles.iconSpacer} />
          )}
        </View>
        <Text style={styles.support}>{view.kind === "access_expired" ? copy.accessExpired : detail.support}</Text>

        {view.kind === "loading" && !visibleRequest ? (
          <View accessibilityLabel={copy.requestLoading}>
            <View style={styles.skeletonPill} />
            <View style={styles.skeletonCard} />
            <View style={styles.skeletonCard} />
          </View>
        ) : null}

        {view.kind === "offline" ? (
          <View accessibilityLiveRegion="polite" style={styles.offlineBanner}>
            <Text style={styles.offlineTitle}>{copy.quoteOfflineTitle}</Text>
            <Text style={styles.offlineBody}>{copy.requestOffline}</Text>
          </View>
        ) : null}

        {view.kind === "access_expired" ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {copy.accessExpired}
          </Text>
        ) : null}

        {error && !visibleRequest && view.kind !== "access_expired" ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error.message}
          </Text>
        ) : null}

        {visibleRequest && detail.badge ? (
          <View
            accessibilityLabel={detail.badge}
            style={[
              styles.badge,
              detail.tone === "failed" ? styles.badgeFailed : detail.tone === "accepted" ? styles.badgeAccepted : detail.tone === "pending" ? styles.badgePending : styles.badgeNeutral,
            ]}
          >
            <View
              style={[
                styles.badgeDot,
                detail.tone === "failed" ? styles.dotFailed : detail.tone === "accepted" ? styles.dotAccepted : detail.tone === "pending" ? styles.dotPending : styles.dotNeutral,
              ]}
            />
            <Text
              style={[
                styles.badgeLabel,
                detail.tone === "failed" ? styles.textFailed : detail.tone === "accepted" ? styles.textAccepted : detail.tone === "pending" ? styles.textPending : styles.textNeutral,
              ]}
            >
              {detail.badge}
            </Text>
          </View>
        ) : null}

        {detail.deliveryFailed && visibleRequest ? (
          <View accessibilityLiveRegion="polite" style={styles.alert}>
            <Text style={styles.alertTitle}>{copy.requestFailedBadge}</Text>
            <Text style={styles.alertBody}>{copy.requestDeliveryAlert}</Text>
          </View>
        ) : null}

        {receipt.visible && receipt.decidedAt ? (
          <View style={styles.acceptedCard}>
            <Text style={styles.acceptedTitle}>{copy.requestQuoteAccepted}</Text>
            <Text style={styles.acceptedTime}>{presentRequestTimestamp(receipt.decidedAt)}</Text>
          </View>
        ) : null}

        {visibleRequest ? (
          <View style={styles.card}>
            <Text style={styles.metaLabel}>{copy.requestSentTo}</Text>
            <Text style={styles.email}>{visibleRequest.recipient_email_masked}</Text>
            {customerName ? <Text style={styles.customer}>{customerName}</Text> : null}
            <Text style={styles.delivery}>{view.label}</Text>
            {view.acceptedNotDelivered ? <Text style={styles.metaHint}>{copy.requestAccepted}</Text> : null}
          </View>
        ) : null}

        {visibleRequest ? (
          <View style={styles.card}>
            <Text style={styles.metaLabel}>{copy.requestQuoteLabel}</Text>
            <View style={styles.summaryRow}>
              <Text style={styles.quoteNumber}>
                {visibleRequest.number} {visibleRequest.revision_label}
              </Text>
              {amount ? <Text style={styles.amount}>{amount}</Text> : null}
            </View>
            <View style={styles.divider} />
            {createdLabel ? <Text style={styles.metaHint}>{copy.requestCreatedOn.replace("{date}", createdLabel)}</Text> : null}
            {expiryLabel ? <Text style={styles.metaHint}>{copy.requestExpiresOn.replace("{date}", expiryLabel)}</Text> : null}
            {visibleRequest.request_state === "pending" ? <Text style={styles.metaHint}>{copy.requestSecureLink}</Text> : null}
          </View>
        ) : null}

        {visibleRequest && activity.length > 0 ? (
          <View>
            <Text style={styles.activityLabel}>{copy.requestActivity}</Text>
            {activity.map((item, index) => (
              <View key={item.key} style={styles.activityRow}>
                <View style={styles.rail}>
                  <View style={[styles.railDot, index === 0 ? styles.dotAccepted : styles.dotNeutral]} />
                  {index < activity.length - 1 ? <View style={styles.railLine} /> : null}
                </View>
                <View style={styles.activityCopy}>
                  <Text style={styles.activityTitle}>{item.title}</Text>
                  <Text style={styles.metaHint}>{item.on ? presentCalendarDate(item.on) : presentRequestTimestamp(item.at)}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {error && visibleRequest ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error.message}
            {loadedLabel ? ` ${loadedLabel}` : ""}
          </Text>
        ) : null}
        {banner ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {banner}
          </Text>
        ) : null}

        {view.showRetry && !visibleRequest ? (
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: view.retryBusy, busy: view.retryBusy }} disabled={view.retryBusy} onPress={() => void load()} style={styles.secondary}>
            <Text style={styles.secondaryLabel}>{view.retryBusy ? copy.requestChecking : copy.requestRetry}</Text>
          </Pressable>
        ) : null}
        {visibleRequest ? (
          <Pressable accessibilityRole="button" onPress={() => router.push(jobPublishPath(jobId))} style={styles.textButton}>
            <Text style={styles.secondaryLabel}>{copy.viewPublishedQuote}</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {visibleRequest ? (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          {actions.resend !== "hidden" ? (
            <>
              {actions.resendHint ? <Text style={styles.footerHint}>{actions.resendHint}</Text> : null}
              {actions.resend === "offline" ? <Text style={styles.footerHint}>{copy.requestActionOffline}</Text> : null}
              <Pressable
                accessibilityLabel={copy.requestResend}
                accessibilityRole="button"
                accessibilityState={{ disabled: actions.resend !== "ready" || submitting, busy: actions.resend === "busy" || submitting }}
                disabled={actions.resend !== "ready" || submitting}
                onPress={() => void onResend()}
                style={actions.resend === "ready" && !submitting ? styles.primary : styles.disabledButton}
              >
                <Text style={styles.primaryLabel}>{actions.resend === "busy" || submitting ? copy.requestResendBusy : copy.requestResend}</Text>
              </Pressable>
              {actions.resend === "ready" ? <Text style={styles.footerHint}>{copy.requestResendRotate}</Text> : null}
            </>
          ) : null}
          {detail.deliveryFailed && actions.replaceLink !== "hidden" ? (
            <Pressable
              accessibilityLabel={copy.requestReplaceLink}
              accessibilityRole="button"
              accessibilityState={{ disabled: actions.replaceLink !== "ready" || submitting, busy: submitting }}
              disabled={actions.replaceLink !== "ready" || submitting}
              onPress={() => setPhase("replace_confirm")}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.requestReplaceLink}</Text>
            </Pressable>
          ) : null}
          {receipt.visible ? (
            <Pressable
              accessibilityLabel={copy.requestViewReceipt}
              accessibilityRole="button"
              accessibilityState={{ disabled: receipt.pdf === "hidden" || receipt.pdf === "preparing", busy: false }}
              disabled={receipt.pdf === "hidden" || receipt.pdf === "preparing"}
              onPress={() => void openReceipt()}
              style={receipt.pdf === "ready" || receipt.pdf === "failed" ? styles.primary : styles.disabledButton}
            >
              <Text style={styles.primaryLabel}>
                {receipt.pdf === "preparing" ? copy.requestReceiptPreparing : copy.requestViewReceipt}
              </Text>
            </Pressable>
          ) : null}
          {detail.accepted ? (
            <Pressable accessibilityLabel={copy.requestBackToJob} accessibilityRole="button" onPress={goToJob} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.requestBackToJob}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <Modal accessibilityViewIsModal animationType="slide" onRequestClose={() => setMenuOpen(false)} transparent visible={menuOpen}>
        <View style={styles.sheetWrap}>
          <Pressable accessibilityLabel={copy.requestCancel} onPress={() => setMenuOpen(false)} style={styles.scrim} />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.handle} />
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              {copy.requestActionsTitle}
            </Text>
            <Text style={styles.sheetBody}>{copy.requestActionsSupport}</Text>
            {actions.replaceLink !== "hidden" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: actions.replaceLink !== "ready" || submitting }}
                disabled={actions.replaceLink !== "ready" || submitting}
                onPress={() => {
                  setMenuOpen(false);
                  setPhase("replace_confirm");
                }}
                style={styles.sheetReplace}
              >
                <Text style={styles.sheetActionTitle}>{copy.requestReplaceLink}</Text>
                <Text style={styles.sheetActionBody}>{copy.requestReplaceHint}</Text>
              </Pressable>
            ) : null}
            {actions.withdraw !== "hidden" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: actions.withdraw !== "ready" || submitting }}
                disabled={actions.withdraw !== "ready" || submitting}
                onPress={() => {
                  setMenuOpen(false);
                  setPhase("withdraw_confirm");
                }}
                style={styles.sheetWithdraw}
              >
                <Text style={styles.sheetWithdrawTitle}>{copy.requestWithdraw}</Text>
                <Text style={styles.sheetWithdrawBody}>{copy.requestWithdrawHint}</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" onPress={() => setMenuOpen(false)} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.requestCancel}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        accessibilityViewIsModal
        animationType="slide"
        onRequestClose={() => {
          if (!submitting) {
            setPhase("idle");
          }
        }}
        transparent
        visible={phase === "withdraw_confirm"}
      >
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.sheetWrap}>
          <Pressable accessibilityLabel={copy.requestCancel} disabled={submitting} onPress={() => setPhase("idle")} style={styles.scrim} />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.handle} />
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              {copy.requestWithdraw}
            </Text>
            <Text style={styles.sheetBody}>{copy.requestWithdrawConfirm}</Text>
            <TextInput
              accessibilityLabel={copy.requestWithdrawReason}
              editable={!submitting}
              onChangeText={setWithdrawReason}
              style={styles.input}
              value={withdrawReason}
            />
            <Pressable
              accessibilityLabel={copy.requestWithdraw}
              accessibilityRole="button"
              accessibilityState={{ disabled: submitting || actions.withdraw !== "ready", busy: submitting }}
              disabled={submitting || actions.withdraw !== "ready"}
              onPress={() => void onWithdraw()}
              style={styles.danger}
            >
              <Text style={styles.primaryLabel}>{submitting ? copy.requestWithdrawBusy : copy.requestWithdraw}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={submitting} onPress={() => setPhase("idle")} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.requestCancel}</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        accessibilityViewIsModal
        animationType="slide"
        onRequestClose={() => {
          if (!submitting && phase === "replace_confirm") {
            setPhase("idle");
          }
        }}
        transparent
        visible={phase === "replace_confirm" || phase === "replace_resume"}
      >
        <View style={styles.sheetWrap}>
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.handle} />
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              {copy.requestReplaceLink}
            </Text>
            <Text accessibilityLiveRegion="polite" style={styles.sheetBody}>
              {copy.requestReplaceConfirm}
            </Text>
            {error ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {error.message}
              </Text>
            ) : null}
            <Pressable
              accessibilityLabel={phase === "replace_resume" ? copy.requestContinueReplace : copy.requestReplaceLink}
              accessibilityRole="button"
              accessibilityState={{ disabled: submitting, busy: submitting }}
              disabled={submitting}
              onPress={() => {
                if (phase === "replace_resume") {
                  attemptedKey.current = undefined;
                  grantBlocked.current = false;
                  void completeReplace(auth.pendingReplace, "resume");
                  return;
                }
                void startReplace();
              }}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>
                {submitting
                  ? copy.requestReplaceBusy
                  : phase === "replace_resume"
                    ? copy.requestContinueReplace
                    : copy.requestReplaceLink}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={submitting}
              onPress={() => void cancelReplace()}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.requestCancel}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
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
  content: { padding: 20, gap: 14, paddingBottom: 160 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 },
  titleBlock: { flex: 1, gap: 1 },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "#DDE2EA",
    alignItems: "center",
    justifyContent: "center",
  },
  iconSpacer: { width: 48, height: 48 },
  iconGlyph: { color: "#17324D", fontSize: 28, lineHeight: 32 },
  moreGlyph: { color: "#17324D", fontSize: 16, fontWeight: "700", letterSpacing: 1 },
  eyebrow: { color: "#626C7E", fontSize: 11, fontWeight: "600" },
  title: { color: "#17324D", fontSize: 22, lineHeight: 28, fontWeight: "700" },
  support: { color: "#626C7E", fontSize: 13, lineHeight: 18 },
  badge: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  badgePending: { backgroundColor: "#FFF4DC" },
  badgeFailed: { backgroundColor: "#FCEAEB" },
  badgeAccepted: { backgroundColor: "#E2F8F1" },
  badgeNeutral: { backgroundColor: "#EDEEF6" },
  badgeDot: { width: 8, height: 8, borderRadius: 4 },
  dotPending: { backgroundColor: "#B7741E" },
  dotFailed: { backgroundColor: "#B73E43" },
  dotAccepted: { backgroundColor: "#1F7A4D" },
  dotNeutral: { backgroundColor: "#626C7E" },
  badgeLabel: { fontSize: 12, fontWeight: "600" },
  textPending: { color: "#B7741E" },
  textFailed: { color: "#B73E43" },
  textAccepted: { color: "#1F7A4D" },
  textNeutral: { color: "#464B71" },
  alert: { backgroundColor: "#FCEAEB", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 13, gap: 2 },
  alertTitle: { color: "#B73E43", fontSize: 13, fontWeight: "600" },
  alertBody: { color: "#B73E43", fontSize: 12, lineHeight: 16 },
  acceptedCard: { backgroundColor: "#E2F8F1", borderRadius: 18, paddingHorizontal: 16, paddingVertical: 15, gap: 2 },
  acceptedTitle: { color: "#17324D", fontSize: 15, fontWeight: "600" },
  acceptedTime: { color: "#626C7E", fontSize: 12 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: "#DDE2EA", borderRadius: 18, padding: 16, gap: 8 },
  metaLabel: { color: "#626C7E", fontSize: 10, fontWeight: "600", letterSpacing: 0.4 },
  email: { color: "#17324D", fontSize: 15, fontWeight: "600" },
  customer: { color: "#626C7E", fontSize: 13 },
  delivery: { color: "#17324D", fontSize: 13, fontWeight: "600" },
  metaHint: { color: "#626C7E", fontSize: 12, lineHeight: 16 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  quoteNumber: { color: "#17324D", fontSize: 16, fontWeight: "700", flex: 1 },
  amount: { color: "#17324D", fontSize: 16, fontWeight: "700" },
  divider: { height: 1, backgroundColor: "#DDE2EA" },
  activityLabel: { color: "#626C7E", fontSize: 11, fontWeight: "600", marginBottom: 8 },
  activityRow: { flexDirection: "row", gap: 10, minHeight: 44 },
  rail: { width: 10, alignItems: "center" },
  railDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  railLine: { width: 1, flex: 1, backgroundColor: "#DDE2EA", marginTop: 2 },
  activityCopy: { flex: 1, paddingBottom: 10 },
  activityTitle: { color: "#17324D", fontSize: 13, fontWeight: "500" },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  banner: { color: "#464B71", fontSize: 13, lineHeight: 18 },
  offlineBanner: { backgroundColor: "#FFF7E6", borderRadius: 15, padding: 12, gap: 2 },
  offlineTitle: { color: "#17212B", fontSize: 13, fontWeight: "600" },
  offlineBody: { color: "#52606D", fontSize: 12 },
  skeletonPill: { width: 140, height: 28, borderRadius: 14, backgroundColor: "#EDEEF6" },
  skeletonCard: { height: 96, borderRadius: 18, backgroundColor: "#EDEEF6", marginTop: 12 },
  footer: { borderTopWidth: 1, borderTopColor: "#DDE2EA", backgroundColor: "#F7F8FA", paddingHorizontal: 20, paddingTop: 12, gap: 8 },
  footerHint: { color: "#626C7E", fontSize: 11, textAlign: "center" },
  primary: { minHeight: 56, borderRadius: 16, backgroundColor: "#464B71", alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  disabledButton: { minHeight: 56, borderRadius: 16, backgroundColor: "#ABAFBE", alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  primaryLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  secondary: { minHeight: 56, borderRadius: 16, borderWidth: 1, borderColor: "#DDE2EA", backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  secondaryLabel: { color: "#464B71", fontSize: 15, fontWeight: "600" },
  textButton: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  danger: { minHeight: 56, borderRadius: 16, backgroundColor: "#B73E43", alignItems: "center", justifyContent: "center" },
  input: { minHeight: 48, borderWidth: 1, borderColor: "#DDE2EA", borderRadius: 14, paddingHorizontal: 12, color: "#17324D", backgroundColor: "#F7F8FA" },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(14, 25, 40, 0.48)" },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 10, gap: 10 },
  handle: { alignSelf: "center", width: 44, height: 4, borderRadius: 2, backgroundColor: "#DDE2EA" },
  sheetTitle: { color: "#17324D", fontSize: 20, fontWeight: "700" },
  sheetBody: { color: "#626C7E", fontSize: 13, lineHeight: 18 },
  sheetReplace: { minHeight: 54, borderRadius: 16, backgroundColor: "#E8F1FC", paddingHorizontal: 16, paddingVertical: 10, justifyContent: "center" },
  sheetActionTitle: { color: "#464B71", fontSize: 14, fontWeight: "600" },
  sheetActionBody: { color: "#626C7E", fontSize: 12 },
  sheetWithdraw: { minHeight: 54, borderRadius: 16, backgroundColor: "#FCEAEB", paddingHorizontal: 16, paddingVertical: 10, justifyContent: "center" },
  sheetWithdrawTitle: { color: "#B73E43", fontSize: 14, fontWeight: "600" },
  sheetWithdrawBody: { color: "#B73E43", fontSize: 12 },
});
