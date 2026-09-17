import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../../src/i18n/en.ts";
import { jobDetailPath, jobPublishPath } from "../../../../src/jobs/routes.ts";
import { presentDeliveryStatus, requestStateLabel, type OwnerRequestRecord } from "../../../../src/quotes/presentation.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../../src/theme.ts";

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
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number } | undefined>();
  const inFlight = useRef(false);

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
        {request ? (
          <>
            <Text style={styles.section}>{copy.quoteNumber}</Text>
            <Text style={styles.body}>
              {request.number} {request.revision_label}
            </Text>
            <Text style={styles.section}>{copy.quoteRecipientEmail}</Text>
            <Text style={styles.body}>{request.recipient_email_masked}</Text>
            {requestStateLabel(request.request_state) ? (
              <Text style={styles.body}>{requestStateLabel(request.request_state)}</Text>
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
