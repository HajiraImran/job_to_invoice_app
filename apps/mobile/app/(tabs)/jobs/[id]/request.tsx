import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
  presentDeliveryStatus,
  presentRequestActions,
  requestStateLabel,
  type OwnerRequestRecord,
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
import { createSetupIdempotencyKey } from "../../../../src/setup/idempotency.ts";
import { colors, space, type } from "../../../../src/theme.ts";

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
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number } | undefined>();
  const inFlight = useRef(false);
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
    setError(undefined);
    const result = await runOwnerRequest<OwnerRequestRecord>({ path: `/v1/jobs/${jobId}/request` });
    inFlight.current = false;
    setChecking(false);
    setLoading(false);
    if (result.ok) {
      setRequest(result.data);
      return;
    }
    setError({
      message: result.error.status === 404 ? copy.jobNotFound : result.error.message || copy.jobLoadError,
      retryable: result.error.retryable || result.error.status === 0,
      status: result.error.status,
    });
  }, [jobId, runOwnerRequest]);

  useEffect(() => {
    void load();
  }, [load]);

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
    },
  ) {
    if (mutateLock.current || auth.snapshot.status === "offline_cached") {
      return;
    }
    mutateLock.current = true;
    setSubmitting(true);
    setBanner(undefined);
    setError(undefined);
    const result = await runOwnerRequest({
      path,
      method: "POST",
      body: options.body ?? {},
      headers: {
        "Idempotency-Key": createSetupIdempotencyKey(),
        ...(options.headers ?? {}),
      },
    });
    mutateLock.current = false;
    setSubmitting(false);
    if (!result.ok) {
      setError({
        message: result.error.message || copy.requestMutationError,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
      });
      return;
    }
    setPhase("idle");
    setBanner(options.successMessage);
    await load();
  }

  async function onResend() {
    if (!request || actions.resend !== "ready") {
      return;
    }
    await runMutation(`/v1/requests/${request.request_id}/resend`, {
      successMessage: copy.requestResendDone,
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

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>
          {copy.requestTitle}
        </Text>
        {view.kind === "loading" ? <ActivityIndicator color={colors.navy} /> : null}
        {view.kind === "offline" || view.kind === "error" ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {view.label}
          </Text>
        ) : null}
        {error && request ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error.message}
          </Text>
        ) : null}
        {banner ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {banner}
          </Text>
        ) : null}
        {request ? (
          <>
            <Text style={styles.section}>{copy.quoteNumber}</Text>
            <Text style={styles.body}>
              {request.number} {request.revision_label}
            </Text>
            <Text style={styles.section}>{copy.quoteRecipientEmail}</Text>
            <Text style={styles.body}>{request.recipient_email_masked}</Text>
            {requestStateLabel(request.request_state) ? (
              <Text accessibilityLiveRegion="polite" style={styles.body}>
                {requestStateLabel(request.request_state)}
              </Text>
            ) : null}
            <Text style={styles.section}>{copy.quotePublished}</Text>
            <Text accessibilityLiveRegion="polite" style={view.kind === "delivered" ? styles.body : styles.banner}>
              {view.label}
            </Text>
            {view.acceptedNotDelivered ? (
              <Text style={styles.hint}>{copy.requestAccepted}</Text>
            ) : null}
          </>
        ) : null}

        {actions.resend !== "hidden" ? (
          <>
            {actions.resendHint ? <Text style={styles.hint}>{actions.resendHint}</Text> : null}
            {actions.resend === "offline" ? <Text style={styles.hint}>{copy.requestActionOffline}</Text> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.requestResend}
              accessibilityState={{ disabled: actions.resend !== "ready" || submitting }}
              disabled={actions.resend !== "ready" || submitting}
              onPress={() => void onResend()}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>
                {actions.resend === "busy" || submitting ? copy.requestResendBusy : copy.requestResend}
              </Text>
            </Pressable>
          </>
        ) : null}

        {actions.withdraw !== "hidden" ? (
          phase === "withdraw_confirm" ? (
            <>
              <Text style={styles.section}>{copy.requestWithdrawConfirm}</Text>
              <TextInput
                accessibilityLabel={copy.requestWithdrawReason}
                value={withdrawReason}
                onChangeText={setWithdrawReason}
                style={styles.input}
                editable={!submitting}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.requestWithdraw}
                accessibilityState={{ disabled: submitting || actions.withdraw !== "ready" }}
                disabled={submitting || actions.withdraw !== "ready"}
                onPress={() => void onWithdraw()}
                style={styles.danger}
              >
                <Text style={styles.primaryLabel}>
                  {submitting ? copy.requestWithdrawBusy : copy.requestWithdraw}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={submitting}
                onPress={() => setPhase("idle")}
                style={styles.secondary}
              >
                <Text style={styles.secondaryLabel}>{copy.back}</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.requestWithdraw}
              accessibilityState={{ disabled: actions.withdraw !== "ready" || submitting }}
              disabled={actions.withdraw !== "ready" || submitting}
              onPress={() => setPhase("withdraw_confirm")}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.requestWithdraw}</Text>
            </Pressable>
          )
        ) : null}

        {actions.replaceLink !== "hidden" ? (
          phase === "replace_resume" ? (
            <>
              <Text style={styles.section}>{copy.requestReplaceConfirm}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.requestContinueReplace}
                accessibilityState={{ disabled: submitting }}
                disabled={submitting}
                onPress={() => {
                  attemptedKey.current = undefined;
                  grantBlocked.current = false;
                  void completeReplace(auth.pendingReplace, "resume");
                }}
                style={styles.primary}
              >
                <Text style={styles.primaryLabel}>
                  {submitting ? copy.requestReplaceBusy : copy.requestContinueReplace}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={submitting}
                onPress={() => void cancelReplace()}
                style={styles.secondary}
              >
                <Text style={styles.secondaryLabel}>{copy.back}</Text>
              </Pressable>
            </>
          ) : phase === "replace_confirm" ? (
            <>
              <Text style={styles.section}>{copy.requestReplaceConfirm}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.requestReplaceLink}
                disabled={submitting}
                onPress={() => void startReplace()}
                style={styles.primary}
              >
                <Text style={styles.primaryLabel}>{copy.requestReplaceLink}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={submitting}
                onPress={() => setPhase("idle")}
                style={styles.secondary}
              >
                <Text style={styles.secondaryLabel}>{copy.back}</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.requestReplaceLink}
              accessibilityState={{ disabled: actions.replaceLink !== "ready" || submitting }}
              disabled={actions.replaceLink !== "ready" || submitting}
              onPress={() => setPhase("replace_confirm")}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.requestReplaceLink}</Text>
            </Pressable>
          )
        ) : null}

        {view.showRetry ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: view.retryBusy }}
            disabled={view.retryBusy}
            onPress={() => void load()}
            style={styles.secondary}
          >
            <Text style={styles.secondaryLabel}>{view.retryBusy ? copy.requestChecking : copy.requestRetry}</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" onPress={() => router.replace(jobPublishPath(jobId))} style={styles.secondary}>
          <Text style={styles.secondaryLabel}>{copy.viewPublishedQuote}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => router.replace(jobDetailPath(jobId))} style={styles.secondary}>
          <Text style={styles.secondaryLabel}>{copy.back}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.gutter, gap: space.scale, paddingBottom: 48 },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  section: { color: colors.text, fontSize: type.section, fontWeight: "600", marginTop: space.scale },
  body: { color: colors.text, fontSize: type.body },
  hint: { color: colors.secondary, fontSize: type.secondary },
  banner: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.navy,
    borderRadius: space.radius,
    paddingHorizontal: 12,
    color: colors.text,
    fontSize: type.body,
  },
  primary: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: space.radius,
    backgroundColor: colors.navy,
    marginTop: space.gutter,
  },
  danger: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: space.radius,
    backgroundColor: colors.danger,
    marginTop: space.gutter,
  },
  primaryLabel: { color: colors.background, fontSize: type.body, fontWeight: "600" },
  secondary: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: space.radius,
    borderWidth: 1,
    borderColor: colors.navy,
    marginTop: space.gutter,
  },
  secondaryLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
});
