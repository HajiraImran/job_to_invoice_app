import { formatUsdCents } from "@job-to-invoice/schemas";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../../src/i18n/en.ts";
import { nextActionCopy, presentJobDetail, quoteLifecycleLabel, type JobDetail } from "../../../../src/jobs/presentation.ts";
import { jobQuotePath, jobPublishPath, jobRequestPath, jobsIndexPath } from "../../../../src/jobs/routes.ts";
import { quoteActionLabel } from "../../../../src/quotes/presentation.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../../src/theme.ts";

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
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number } | undefined>();
  const openKey = useRef<string | undefined>(undefined);

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
    ? nextActionCopy(view.job.mode, view.job.lifecycle, view.job.current_quote?.lifecycle)
    : "none";
  const quoteAction = quoteActionLabel(Boolean(view.job?.quote_draft));
  const quoteDisabled =
    opening || auth.snapshot.status === "access_expired" || auth.snapshot.status === "offline_cached";

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
    setError({
      message: result.error.message || copy.quoteLoadError,
      retryable: result.error.retryable || result.error.status === 0,
      status: result.error.status,
    });
  }

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
            {view.job.quote_draft ? (
              <>
                <Text style={styles.section}>{copy.quoteTotal}</Text>
                <Text style={styles.body}>{formatUsdCents(view.job.quote_draft.total_cents)}</Text>
              </>
            ) : null}
            {view.job.internal_notes ? (
              <>
                <Text style={styles.section}>{copy.internalNotes}</Text>
                <Text style={styles.body}>{view.job.internal_notes}</Text>
              </>
            ) : null}
            {next === "quote" ? <Text style={styles.banner}>{copy.jobNextDraftQuote}</Text> : null}
            {next === "direct" ? <Text style={styles.banner}>{copy.jobNextDraftDirect}</Text> : null}
            {next === "published" ? <Text style={styles.banner}>{copy.jobNextPublished}</Text> : null}
            {next === "quote" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: quoteDisabled }}
                disabled={quoteDisabled}
                onPress={() => void openQuote()}
                style={styles.primary}
              >
                <Text style={styles.primaryLabel}>
                  {opening
                    ? copy.quoteSaving
                    : view.job?.current_quote && view.job.current_quote.lifecycle !== "issued"
                      ? copy.createRevision
                      : quoteAction === "open"
                        ? copy.openQuote
                        : copy.createQuote}
                </Text>
              </Pressable>
            ) : null}
            {view.job?.current_quote ? (
              <>
                <Text style={styles.section}>{copy.quoteNumber}</Text>
                <Text style={styles.body}>{view.job.current_quote.number}</Text>
                <Text style={styles.body}>{quoteLifecycleLabel(view.job.current_quote.lifecycle)}</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.push(jobPublishPath(jobId))}
                  style={styles.primary}
                >
                  <Text style={styles.primaryLabel}>{copy.viewPublishedQuote}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.push(jobRequestPath(jobId))}
                  style={styles.secondary}
                >
                  <Text style={styles.secondaryLabel}>{copy.viewRequestStatus}</Text>
                </Pressable>
              </>
            ) : null}
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
  primary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: space.radius,
    backgroundColor: colors.navy,
    marginTop: space.gutter,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: type.body, fontWeight: "700" },
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
