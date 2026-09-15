import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../src/i18n/en.ts";
import { nextActionCopy, presentJobDetail, type JobDetail } from "../../../src/jobs/presentation.ts";
import { jobsIndexPath } from "../../../src/jobs/routes.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../src/theme.ts";

export default function JobDetailScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const jobId = typeof params.id === "string" ? params.id : "";
  const [job, setJob] = useState<JobDetail | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number } | undefined>();

  const load = useCallback(async () => {
    if (!jobId) {
      setLoading(false);
      setError({ message: copy.jobNotFound, retryable: false, status: 404 });
      return;
    }
    setLoading(true);
    setError(undefined);
    const result = await runOwnerRequest<JobDetail>({ path: `/v1/jobs/${jobId}` });
    if (result.ok) {
      setJob(result.data);
    } else {
      setError({
        message: result.error.status === 404 ? copy.jobNotFound : result.error.message || copy.jobLoadError,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
      });
    }
    setLoading(false);
  }, [jobId, runOwnerRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  const view = presentJobDetail({
    authStatus: auth.snapshot.status,
    loading,
    job,
    error,
  });
  const next = view.job ? nextActionCopy(view.job.mode, view.job.lifecycle) : "none";

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>
          {view.job?.title ?? copy.jobDetailTitle}
        </Text>
        {auth.snapshot.status === "offline_cached" ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.offlineCached}
          </Text>
        ) : null}

        {view.kind === "loading" ? <ActivityIndicator color={colors.navy} /> : null}

        {view.kind === "error" || view.kind === "offline" ? (
          <>
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {view.message ?? copy.jobLoadError}
            </Text>
            {view.showRetry ? (
              <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.retry}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}

        {view.kind === "missing" || view.kind === "access_expired" ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {view.kind === "access_expired" ? copy.accessExpired : copy.jobNotFound}
          </Text>
        ) : null}

        {view.job ? (
          <>
            <Text style={styles.section}>{copy.jobCurrentStep}</Text>
            <Text style={styles.body}>{lifecycleLabel(view.job.lifecycle)}</Text>
            <Text style={styles.section}>{copy.customerName}</Text>
            <Text style={styles.body}>{view.job.customer_name}</Text>
            <Text style={styles.section}>{copy.jobSite}</Text>
            <Text style={styles.body}>
              {view.job.no_site || !view.job.site_address
                ? copy.noSiteAddress
                : [
                    view.job.site_address.line1,
                    view.job.site_address.line2,
                    `${view.job.site_address.city}, ${view.job.site_address.state} ${view.job.site_address.postal_code}`,
                  ]
                    .filter(Boolean)
                    .join("\n")}
            </Text>
            <Text style={styles.section}>{copy.jobMode}</Text>
            <Text style={styles.body}>{view.job.mode === "direct_invoice" ? copy.modeDirect : copy.modeQuote}</Text>
            {view.job.internal_notes ? (
              <>
                <Text style={styles.section}>{copy.internalNotes}</Text>
                <Text style={styles.body}>{view.job.internal_notes}</Text>
              </>
            ) : null}
            {next === "quote" ? <Text style={styles.banner}>{copy.jobNextDraftQuote}</Text> : null}
            {next === "direct" ? <Text style={styles.banner}>{copy.jobNextDraftDirect}</Text> : null}
          </>
        ) : null}

        <Pressable accessibilityRole="button" onPress={() => router.replace(jobsIndexPath())} style={styles.secondary}>
          <Text style={styles.secondaryLabel}>{copy.back}</Text>
        </Pressable>
      </ScrollView>
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.gutter, gap: space.scale, paddingBottom: 48 },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  section: { color: colors.text, fontSize: type.section, fontWeight: "600", marginTop: space.scale },
  body: { color: colors.text, fontSize: type.body },
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
