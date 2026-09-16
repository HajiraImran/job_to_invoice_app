import { formatUsdCents } from "@job-to-invoice/schemas";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../../src/i18n/en.ts";
import { jobDetailPath, jobQuotePath, jobRequestPath } from "../../../../src/jobs/routes.ts";
import type { JobDetail } from "../../../../src/jobs/presentation.ts";
import { quotePublishBody } from "../../../../src/quotes/form.ts";
import {
  presentQuotePdf,
  presentQuotePdfRetry,
  presentQuoteReview,
  type PublishedQuoteRecord,
  type QuotePdfDownload,
  type QuotePreviewRecord,
} from "../../../../src/quotes/presentation.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../../src/theme.ts";

export default function QuotePublishScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const jobId = typeof params.id === "string" ? params.id : "";
  const [preview, setPreview] = useState<QuotePreviewRecord | undefined>();
  const [published, setPublished] = useState<PublishedQuoteRecord | undefined>();
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [pdfDownload, setPdfDownload] = useState<QuotePdfDownload | undefined>();
  const [pdfError, setPdfError] = useState<string | undefined>();
  const [pdfChecking, setPdfChecking] = useState(false);
  const [pdfStillPreparing, setPdfStillPreparing] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState("");
  const pdfInFlight = useRef(false);
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number; code?: string } | undefined>();
  const publishKey = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!jobId) {
      setLoading(false);
      setError({ message: copy.jobNotFound, retryable: false, status: 404 });
      return;
    }
    setLoading(true);
    setError(undefined);
    setConfirming(false);
    const jobResult = await runOwnerRequest<JobDetail>({ path: `/v1/jobs/${jobId}` });
    if (!jobResult.ok) {
      setError({
        message: jobResult.error.status === 404 ? copy.jobNotFound : jobResult.error.message || copy.quotePreviewError,
        retryable: jobResult.error.retryable || jobResult.error.status === 0,
        status: jobResult.error.status,
        code: jobResult.error.code,
      });
      setLoading(false);
      return;
    }
    if (jobResult.data.current_quote) {
      const doc = await runOwnerRequest<PublishedQuoteRecord>({
        path: `/v1/documents/${jobResult.data.current_quote.id}`,
      });
      if (doc.ok) {
        setPublished(doc.data);
        setPdfDownload({ state: doc.data.pdf_state, url: null });
        setPdfError(undefined);
        setPdfStillPreparing(false);
        setPreview(undefined);
        setLoading(false);
        return;
      }
      setError({
        message: doc.error.message || copy.quoteLoadError,
        retryable: doc.error.retryable || doc.error.status === 0,
        status: doc.error.status,
        code: doc.error.code,
      });
      setLoading(false);
      return;
    }
    if (!jobResult.data.quote_draft) {
      setError({ message: copy.quotePreviewError, retryable: false, status: 422 });
      setLoading(false);
      return;
    }
    const result = await runOwnerRequest<QuotePreviewRecord>({
      path: `/v1/drafts/${jobResult.data.quote_draft.id}/preview`,
      method: "POST",
      ifMatch: jobResult.data.quote_draft.version,
    });
    if (result.ok) {
      setPreview(result.data);
      setPublished(undefined);
      setPdfDownload(undefined);
      const existing = result.data.snapshot.customer.email?.trim();
      if (existing) {
        setRecipientEmail(existing);
      }
    } else {
      setError({
        message:
          result.error.code === "VALIDATION_FAILED"
            ? copy.quotePreviewError
            : result.error.message || copy.quotePreviewError,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
        code: result.error.code,
      });
    }
    setLoading(false);
  }, [jobId, runOwnerRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshPdf = useCallback(async (documentId: string) => {
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
  }, [runOwnerRequest]);

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

  const view = presentQuoteReview({
    authStatus: auth.snapshot.status,
    loading,
    confirming,
    publishing,
    published,
    preview,
    error,
  });
  const snapshot = published?.snapshot ?? preview?.snapshot;
  const publishDisabled = view.publishDisabled || publishing;
  const pdfView = presentQuotePdf(pdfDownload ?? (published ? { state: published.pdf_state, url: null } : undefined));
  const pdfRetry = presentQuotePdfRetry({ checking: pdfChecking, stillPreparing: pdfStillPreparing });

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

  async function confirmPublish() {
    if (!preview || publishDisabled) {
      return;
    }
    setPublishing(true);
    setConfirming(false);
    publishKey.current = retainOrCreateSetupIdempotencyKey(publishKey.current);
    const body = quotePublishBody(preview.preview_hash, recipientEmail);
    if (!body.ok) {
      setPublishing(false);
      setError({
        message: copy.quoteRecipientRequired,
        retryable: false,
        status: 422,
      });
      return;
    }
    const result = await runOwnerRequest<PublishedQuoteRecord>({
      path: `/v1/drafts/${preview.draft_id}/publish`,
      method: "POST",
      body: body.value,
      idempotencyKey: publishKey.current,
      ifMatch: preview.version,
    });
    if (result.ok) {
      setPublished(result.data);
      setPdfDownload({ state: result.data.pdf_state, url: null });
      setPdfError(undefined);
      setPdfStillPreparing(false);
      setError(undefined);
      setPublishing(false);
      return;
    }
    if (result.error.code === "IDEMPOTENCY_MISMATCH") {
      publishKey.current = retainOrCreateSetupIdempotencyKey(undefined);
    }
    setPublishing(false);
    setError({
      message:
        result.error.code === "ENTITLEMENT_REQUIRED"
          ? copy.quoteEntitlement
          : result.error.code === "DOCUMENT_IMMUTABLE"
            ? copy.quoteAlreadyPublished
            : result.error.code === "PREVIEW_CHANGED" || result.error.code === "VERSION_CONFLICT"
              ? copy.quoteStalePreview
              : result.error.message || copy.quotePublishError,
      retryable: result.error.retryable || result.error.status === 0,
      status: result.error.status,
      code: result.error.code,
    });
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>
          {view.kind === "published" ? copy.quotePublishedTitle : copy.quotePublishTitle}
        </Text>
        {auth.snapshot.status === "offline_cached" ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.quoteOfflinePublish}
          </Text>
        ) : null}
        {view.kind === "loading" || view.kind === "publishing" ? <ActivityIndicator color={colors.navy} /> : null}
        {view.kind === "error" || view.kind === "offline" || view.kind === "access_expired" || view.kind === "conflict" || view.kind === "entitlement" || view.kind === "already" ? (
          <>
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {view.kind === "access_expired"
                ? copy.accessExpired
                : view.kind === "offline"
                  ? copy.quoteOfflinePublish
                  : view.message ?? copy.quotePreviewError}
            </Text>
            {view.showRetry ? (
              <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.retry}</Text>
              </Pressable>
            ) : null}
            {view.kind === "conflict" ? (
              <Pressable accessibilityRole="button" onPress={() => router.replace(jobQuotePath(jobId))} style={styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.openQuote}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}

        {snapshot && (view.kind === "ready" || view.kind === "confirming" || view.kind === "published" || view.kind === "publishing") ? (
          <>
            <Text style={styles.section}>{copy.quoteNumber}</Text>
            <Text style={styles.body}>
              {published ? `${published.number} ${published.revision_label}` : preview?.number_label ?? copy.quoteEditorTitle}
            </Text>
            <Text style={styles.section}>{copy.quoteBusiness}</Text>
            <Text style={styles.body}>
              {[snapshot.business.business_name, snapshot.business.legal_name, snapshot.business.contact_name, snapshot.business.contact_email]
                .filter(Boolean)
                .join("\n")}
            </Text>
            <Text style={styles.section}>{copy.quoteCustomer}</Text>
            <Text style={styles.body}>{snapshot.customer.name}</Text>
            <Text style={styles.section}>{copy.jobTitle}</Text>
            <Text style={styles.body}>{snapshot.job.title}</Text>
            <Text style={styles.section}>{copy.jobSite}</Text>
            <Text style={styles.body}>
              {snapshot.job.no_site || !snapshot.job.site_address
                ? copy.noSiteAddress
                : `${snapshot.job.site_address.line1}\n${snapshot.job.site_address.city}, ${snapshot.job.site_address.state} ${snapshot.job.site_address.postal_code}`}
            </Text>
            {snapshot.lines.map((line) => (
              <View key={`${line.position}-${line.description}`} style={styles.card}>
                <Text style={styles.section}>
                  {copy.quoteLine} {line.position}
                </Text>
                <Text style={styles.body}>{line.description}</Text>
                <Text style={styles.hint}>
                  {line.quantity} · {formatUsdCents(line.unit_price_cents)}
                </Text>
                <Text style={styles.body}>{formatUsdCents(line.total_cents)}</Text>
              </View>
            ))}
            <Text style={styles.section}>{copy.quoteSubtotal}</Text>
            <Text style={styles.body}>{formatUsdCents(snapshot.net_cents)}</Text>
            <Text style={styles.section}>{copy.quoteDiscountTotal}</Text>
            <Text style={styles.body}>
              {formatUsdCents(snapshot.lines.reduce((sum, line) => sum + line.discount_cents, 0))}
            </Text>
            <Text style={styles.section}>{copy.quoteTaxTotal}</Text>
            <Text style={styles.body}>{formatUsdCents(snapshot.tax_cents)}</Text>
            <Text style={styles.section}>{copy.quoteTotal}</Text>
            <Text style={styles.body}>{formatUsdCents(snapshot.total_cents)}</Text>
            {snapshot.notes ? (
              <>
                <Text style={styles.section}>{copy.quoteNotes}</Text>
                <Text style={styles.body}>{snapshot.notes}</Text>
              </>
            ) : null}
            <Text style={styles.section}>{copy.quoteTerms}</Text>
            <Text style={styles.body}>{snapshot.terms || "—"}</Text>
            <Text style={styles.section}>{copy.quoteExpiry}</Text>
            <Text style={styles.body}>{snapshot.expiry_local_date}</Text>
            {view.kind === "published" ? (
              <>
                {pdfView.kind === "preparing" ? (
                  <Text accessibilityLiveRegion="polite" style={styles.banner}>
                    {copy.quotePdfPreparing}
                  </Text>
                ) : null}
                {pdfView.kind === "failed" ? (
                  <Text accessibilityLiveRegion="polite" style={styles.error}>
                    {copy.quotePdfFailed}
                  </Text>
                ) : null}
                {pdfError ? (
                  <Text accessibilityLiveRegion="polite" style={styles.error}>
                    {pdfError}
                  </Text>
                ) : null}
                {pdfRetry.acknowledgement ? (
                  <Text accessibilityLiveRegion="polite" style={styles.banner}>
                    {pdfRetry.acknowledgement}
                  </Text>
                ) : null}
                {pdfView.kind === "ready" ? (
                  <Pressable accessibilityRole="button" onPress={() => void openOrRetryPdf()} style={styles.primary}>
                    <Text style={styles.primaryLabel}>{copy.quotePdfDownload}</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: pdfRetry.busy }}
                    disabled={pdfRetry.busy}
                    onPress={() => void openOrRetryPdf()}
                    style={styles.secondary}
                  >
                    <Text style={styles.secondaryLabel}>{pdfRetry.label}</Text>
                  </Pressable>
                )}
                <Pressable accessibilityRole="button" onPress={() => router.push(jobRequestPath(jobId))} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{copy.viewRequestStatus}</Text>
                </Pressable>
              </>
            ) : null}
            {view.kind === "confirming" ? (
              <>
                <Text style={styles.section}>{copy.quoteRecipientEmail}</Text>
                <TextInput
                  value={recipientEmail}
                  onChangeText={setRecipientEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  accessibilityLabel={copy.quoteRecipientEmail}
                  style={styles.input}
                />
                <Text style={styles.hint}>{copy.quoteRecipientHint}</Text>
                <Text accessibilityLiveRegion="polite" style={styles.banner}>
                  {copy.quoteConfirmPublish}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: publishing || !preview || !quotePublishBody(preview.preview_hash, recipientEmail).ok }}
                  disabled={publishing || !preview || !quotePublishBody(preview.preview_hash, recipientEmail).ok}
                  onPress={() => void confirmPublish()}
                  style={styles.primary}
                >
                  <Text style={styles.primaryLabel}>{publishing ? copy.quotePublishing : copy.quoteConfirm}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => setConfirming(false)} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{copy.back}</Text>
                </Pressable>
              </>
            ) : null}
            {view.kind === "ready" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: publishDisabled }}
                disabled={publishDisabled}
                onPress={() => setConfirming(true)}
                style={styles.primary}
              >
                <Text style={styles.primaryLabel}>{copy.quoteReview}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}

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
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    paddingHorizontal: space.scale,
    color: colors.text,
    fontSize: type.body,
    backgroundColor: "#FFFFFF",
  },
  banner: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    padding: space.scale,
    backgroundColor: "#FFFFFF",
  },
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
