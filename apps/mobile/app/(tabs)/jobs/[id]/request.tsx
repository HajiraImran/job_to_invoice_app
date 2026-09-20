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
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { createSetupIdempotencyKey } from "../../../../src/setup/idempotency.ts";
import { colors, space, type } from "../../../../src/theme.ts";

type Phase = "idle" | "withdraw_confirm" | "replace_confirm" | "replace_code";

export default function QuoteRequestScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const jobId = typeof params.id === "string" ? params.id : "";
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

  async function startReplace() {
    if (!request || actions.replaceLink !== "ready") {
      return;
    }
    setPhase("replace_code");
    setBanner(undefined);
    setError(undefined);
    const email = auth.emailDisplay || auth.snapshot.emailDisplay || "";
    if (email) {
      auth.setEmailDisplay(email);
    }
    auth.setCode("");
    await auth.sendCode();
  }

  async function confirmReplace() {
    if (!request || mutateLock.current) {
      return;
    }
    mutateLock.current = true;
    setSubmitting(true);
    setError(undefined);
    await auth.verifyCode();
    const grantResult = await runOwnerRequest<{ grant: string }>({
      path: "/v1/account/action-grants",
      method: "POST",
      body: { action: "replace_link" },
    });
    if (!grantResult.ok) {
      mutateLock.current = false;
      setSubmitting(false);
      setError({
        message: grantResult.error.message || copy.requestMutationError,
        retryable: grantResult.error.retryable || grantResult.error.status === 0,
        status: grantResult.error.status,
      });
      return;
    }
    const replaceResult = await runOwnerRequest({
      path: `/v1/requests/${request.request_id}/replace-link`,
      method: "POST",
      body: {},
      headers: {
        "Idempotency-Key": createSetupIdempotencyKey(),
        "X-Action-Grant": grantResult.data.grant,
      },
    });
    mutateLock.current = false;
    setSubmitting(false);
    if (!replaceResult.ok) {
      setError({
        message: replaceResult.error.message || copy.requestMutationError,
        retryable: replaceResult.error.retryable || replaceResult.error.status === 0,
        status: replaceResult.error.status,
      });
      return;
    }
    setPhase("idle");
    setBanner(copy.requestReplaceDone);
    await load();
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
          phase === "replace_code" ? (
            <>
              <Text style={styles.section}>{copy.requestReplaceConfirm}</Text>
              <Text style={styles.hint}>{copy.requestReplaceCode}</Text>
              <TextInput
                accessibilityLabel={copy.requestReplaceCode}
                value={auth.code}
                onChangeText={(value) => auth.setCode(value.replace(/\D/g, "").slice(0, 6))}
                keyboardType="number-pad"
                style={styles.input}
                editable={!submitting}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.requestContinueReplace}
                accessibilityState={{ disabled: submitting || auth.code.trim().length < 6 }}
                disabled={submitting || auth.code.trim().length < 6}
                onPress={() => void confirmReplace()}
                style={styles.primary}
              >
                <Text style={styles.primaryLabel}>
                  {submitting ? copy.requestReplaceBusy : copy.requestContinueReplace}
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
