import { EMAIL_MAX_LENGTH, formatUsdCents, parseOwnerEmail } from "@job-to-invoice/schemas";
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
import { jobDetailPath, jobQuotePath, jobRequestPath } from "../../../../src/jobs/routes.ts";
import type { JobDetail } from "../../../../src/jobs/presentation.ts";
import {
  presentCommercialSnapshot,
  presentPreviewGeneratedLabel,
  presentQuotePdf,
  presentQuotePdfRetry,
  presentQuoteReview,
  previewAfterPublishError,
  previewHashIsCurrent,
  quotePublishBackControls,
  quotePublishPlansPath,
  type PublishedQuoteRecord,
  type QuotePdfDownload,
  type QuotePreviewRecord,
} from "../../../../src/quotes/presentation.ts";
import { beginConfirmedQuotePublish, quotePublishSuccessPath } from "../../../../src/quotes/publish.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors } from "../../../../src/theme.ts";

export default function QuotePublishScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const jobId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? (params.id[0] ?? "") : "";
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
  const [receivedAt, setReceivedAt] = useState<number | undefined>();
  const [previewStale, setPreviewStale] = useState(false);
  const emailRef = useRef("");
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const pdfInFlight = useRef(false);
  const previewInFlight = useRef(false);
  const publishInFlight = useRef(false);
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number; code?: string } | undefined>();
  const publishKey = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!jobId) {
      setLoading(false);
      setError({ message: copy.jobNotFound, retryable: false, status: 404 });
      return;
    }
    if (previewInFlight.current) {
      return;
    }
    previewInFlight.current = true;
    if (!previewRef.current) {
      setLoading(true);
    }
    setError(undefined);
    try {
      const jobResult = await runOwnerRequest<JobDetail>({ path: `/v1/jobs/${jobId}` });
      if (!jobResult.ok) {
        setError({
          message: jobResult.error.status === 404 ? copy.jobNotFound : jobResult.error.message || copy.quotePreviewError,
          retryable: jobResult.error.retryable || jobResult.error.status === 0,
          status: jobResult.error.status,
          code: jobResult.error.code,
        });
        return;
      }
      if (jobResult.data.quote_draft) {
        const result = await runOwnerRequest<QuotePreviewRecord>({
          path: `/v1/drafts/${jobResult.data.quote_draft.id}/preview`,
          method: "POST",
          ifMatch: jobResult.data.quote_draft.version,
        });
        if (result.ok) {
          const previous = previewRef.current;
          setPreview(result.data);
          setPublished(undefined);
          setPdfDownload(undefined);
          setPreviewStale(false);
          const existing = result.data.snapshot.customer.email?.trim();
          if (existing && !emailRef.current) {
            emailRef.current = existing;
            setRecipientEmail(existing);
          }
          setReceivedAt(Date.now());
          if (previous && previous.preview_hash !== result.data.preview_hash) {
            setConfirming(false);
          }
          return;
        }
        setError({
          message:
            result.error.code === "VALIDATION_FAILED"
              ? copy.quotePreviewError
              : result.error.message || copy.quotePreviewError,
          retryable: result.error.retryable || result.error.status === 0,
          status: result.error.status,
          code: result.error.code,
        });
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
          setPreviewStale(false);
          setConfirming(false);
          return;
        }
        setError({
          message: doc.error.message || copy.quoteLoadError,
          retryable: doc.error.retryable || doc.error.status === 0,
          status: doc.error.status,
          code: doc.error.code,
        });
        return;
      }
      setError({ message: copy.quotePreviewError, retryable: false, status: 422 });
    } finally {
      previewInFlight.current = false;
      setLoading(false);
    }
  }, [jobId, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

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

  useEffect(() => {
    if (auth.snapshot.status !== "access_expired") {
      return;
    }
    emailRef.current = "";
    setRecipientEmail("");
    setConfirming(false);
    setPreview(undefined);
    setPreviewStale(false);
  }, [auth.snapshot.status]);

  const view = presentQuoteReview({
    authStatus: auth.snapshot.status,
    loading,
    confirming,
    publishing,
    published,
    preview,
    error,
  });
  const back = quotePublishBackControls(view.kind);
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
    if (previewStale || !previewHashIsCurrent(preview)) {
      return;
    }
    const started = beginConfirmedQuotePublish({
      confirming,
      preview,
      recipientEmail,
      inFlight: publishInFlight,
      idempotencyKey: publishKey.current,
    });
    if (started.kind === "ignored") {
      return;
    }
    if (started.kind === "invalid_email") {
      setError({
        message: copy.quoteRecipientRequired,
        retryable: false,
        status: 422,
      });
      return;
    }
    publishKey.current = started.idempotencyKey;
    setPublishing(true);
    setError(undefined);
    try {
      const result = await runOwnerRequest<PublishedQuoteRecord>({
        path: started.request.path,
        method: started.request.method,
        body: started.request.body,
        idempotencyKey: started.request.idempotencyKey,
        ifMatch: started.request.ifMatch,
      });
      if (result.ok) {
        setPublished(result.data);
        setPdfDownload({ state: result.data.pdf_state, url: null });
        setPdfError(undefined);
        setPdfStillPreparing(false);
        setError(undefined);
        setConfirming(false);
        router.replace(quotePublishSuccessPath(jobId));
        return;
      }
      if (result.error.code === "PREVIEW_CHANGED" || result.error.code === "VERSION_CONFLICT") {
        setPreview((current) => previewAfterPublishError(current, result.error.code));
        setPreviewStale(true);
        setConfirming(false);
      }
      if (result.error.code === "ENTITLEMENT_REQUIRED") {
        setConfirming(false);
      }
      if (result.error.code === "IDEMPOTENCY_MISMATCH") {
        publishKey.current = retainOrCreateSetupIdempotencyKey(undefined);
      }
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
    } finally {
      publishInFlight.current = false;
      setPublishing(false);
    }
  }

  const commercial = snapshot && view.kind !== "access_expired" ? presentCommercialSnapshot(snapshot) : undefined;
  const hashCurrent = previewHashIsCurrent(preview);
  const generatedLabel = !published && !previewStale ? presentPreviewGeneratedLabel(receivedAt, Date.now()) : undefined;
  const emailValid = parseOwnerEmail(recipientEmail).ok;
  const confirmationOpen =
    confirming && view.kind !== "entitlement" && view.kind !== "conflict" && view.kind !== "access_expired";
  const continueDisabled = !hashCurrent || previewStale || publishDisabled;
  const showReady = view.kind === "ready" && !previewStale && hashCurrent;
  const support =
    view.kind === "access_expired"
      ? copy.accessExpired
      : view.kind === "offline"
        ? copy.quoteOfflinePublish
        : view.kind === "entitlement"
          ? copy.slotRequiredSupport
          : previewStale || view.kind === "conflict"
            ? copy.previewChangedSupport
            : confirmationOpen
              ? copy.previewConfirmRecipient
              : view.kind === "published"
                ? copy.quotePublished
                : copy.previewConfirmDocument;
  const fieldError =
    confirmationOpen && error?.message
      ? error.message
      : recipientEmail.trim().length > 0 && !emailValid
        ? copy.quoteRecipientRequired
        : undefined;

  function cancelConfirmation() {
    if (publishing) {
      return;
    }
    setConfirming(false);
    setError(undefined);
  }

  function leavePreview() {
    if (auth.snapshot.status === "offline_cached") {
      router.replace(jobQuotePath(jobId));
      return;
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(jobDetailPath(jobId));
  }

  function onHeaderBack() {
    if (view.kind === "publishing" || publishing) {
      return;
    }
    if (back.cancelConfirmation || confirming) {
      cancelConfirmation();
      return;
    }
    if (view.kind === "entitlement") {
      setError(undefined);
      return;
    }
    leavePreview();
  }

  function continueToPublish() {
    if (continueDisabled) {
      return;
    }
    setError(undefined);
    setConfirming(true);
  }

  function onEmailChange(value: string) {
    emailRef.current = value;
    setRecipientEmail(value);
    if (error?.status === 422) {
      setError(undefined);
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={styles.atmosphere} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Pressable
          accessibilityLabel={copy.previewBack}
          accessibilityRole="button"
          accessibilityState={{ disabled: publishing }}
          disabled={publishing}
          onPress={onHeaderBack}
          style={styles.iconButton}
        >
          <Text style={styles.iconGlyph}>‹</Text>
        </Pressable>
        <Text style={styles.eyebrow}>{copy.previewPublishEyebrow}</Text>
        <Text accessibilityRole="header" style={styles.title}>
          {view.kind === "published" ? copy.quotePublishedTitle : copy.quotePublishTitle}
        </Text>
        <Text style={styles.support}>{support}</Text>

        {showReady ? (
          <View accessibilityLabel={copy.previewReady} style={styles.readyRow}>
            <Text style={styles.readyPill}>{copy.previewReady}</Text>
            {generatedLabel ? <Text style={styles.generated}>{generatedLabel}</Text> : null}
          </View>
        ) : null}

        {view.kind === "loading" && !commercial ? (
          <View accessibilityLabel={copy.requestLoading} style={styles.document}>
            <View style={styles.skeletonBar} />
            <View style={styles.skeletonBarShort} />
            <View style={styles.skeletonBlock} />
          </View>
        ) : null}

        {view.kind === "offline" ? (
          <View accessibilityLiveRegion="polite" style={styles.warningBanner}>
            <Text style={styles.warningTitle}>{copy.quoteOfflineTitle}</Text>
            <Text style={styles.warningBody}>{copy.quoteOfflinePublish}</Text>
          </View>
        ) : null}

        {view.kind === "access_expired" ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {copy.accessExpired}
          </Text>
        ) : null}

        {previewStale && commercial && !published ? (
          <View accessibilityLiveRegion="polite" style={styles.warningBanner}>
            <Text style={styles.warningTitle}>{copy.previewChangedTitle}</Text>
            <Text style={styles.warningBody}>{copy.previewChangedBody}</Text>
          </View>
        ) : null}

        {error &&
        view.kind !== "confirming" &&
        view.kind !== "publishing" &&
        view.kind !== "entitlement" &&
        view.kind !== "access_expired" &&
        error.code !== "PREVIEW_CHANGED" &&
        error.code !== "VERSION_CONFLICT" ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error.message}
          </Text>
        ) : null}

        {view.showRetry && view.kind !== "conflict" && view.kind !== "entitlement" && !previewStale ? (
          <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
            <Text style={styles.secondaryLabel}>{copy.retry}</Text>
          </Pressable>
        ) : null}

        {commercial && !published ? (
          <View
            accessible
            accessibilityLabel={`${copy.quoteDocumentKind}. ${copy.previewNotPublished}. ${commercial.customerName}. ${copy.quoteTotal} ${formatUsdCents(commercial.totalCents)}${commercial.notes ? `. ${copy.quoteNotes}` : ""}`}
            style={styles.document}
          >
            <View style={styles.documentHead}>
              <Text style={styles.businessName}>{commercial.businessName}</Text>
              <Text style={styles.documentKind}>{copy.quoteDocumentKind}</Text>
              <Text style={styles.unpublished}>{copy.previewNotPublished}</Text>
            </View>
            <View style={styles.identityRow}>
              <View style={styles.identityCol}>
                <Text style={styles.metaLabel}>{copy.previewPreparedFor}</Text>
                <Text style={styles.identityValue}>{commercial.customerName}</Text>
              </View>
              <View style={styles.identityCol}>
                <Text style={styles.metaLabel}>{copy.previewExpiresLabel}</Text>
                <Text style={styles.identityValue}>{copy.previewExpiresAfter.replace("{count}", String(commercial.expiryDays))}</Text>
              </View>
            </View>
            <View style={styles.lineHeader}>
              <Text style={styles.metaLabel}>{copy.previewDescription}</Text>
              <Text style={styles.metaLabel}>{copy.previewAmount}</Text>
            </View>
            {commercial.lines.map((line) => (
              <View key={`${line.position}-${line.description}`} style={styles.lineRow}>
                <View style={styles.lineCopy}>
                  <Text style={styles.lineDescription}>{line.description}</Text>
                  <Text style={styles.lineMeta}>
                    {line.quantity} {line.unit} × {formatUsdCents(line.unitPriceCents)}
                  </Text>
                </View>
                <Text style={styles.lineAmount}>{formatUsdCents(line.amountCents)}</Text>
              </View>
            ))}
            <MoneyRows commercial={commercial} showNet={commercial.showDiscount} />
            {commercial.notes ? (
              <View style={styles.noteBlock}>
                <Text style={styles.metaLabel}>{copy.quoteNotes}</Text>
                <Text style={styles.noteBody}>{commercial.notes}</Text>
              </View>
            ) : null}
            {commercial.terms ? (
              <View style={styles.noteBlock}>
                <Text style={styles.metaLabel}>{copy.quoteTerms}</Text>
                <Text style={styles.noteBody}>{commercial.terms}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {commercial && published ? (
          <View
            accessible
            accessibilityLabel={`${published.number}. ${quoteLifecycleLabel(published.lifecycle)}. ${copy.quoteTotal} ${formatUsdCents(commercial.totalCents)}`}
            style={styles.document}
          >
            <View style={styles.documentHead}>
              <Text style={styles.businessName}>{commercial.businessName}</Text>
              <Text style={styles.documentKind}>{published.number}</Text>
              <Text style={styles.unpublished}>
                {published.revision_label} · {quoteLifecycleLabel(published.lifecycle)}
              </Text>
            </View>
            <MoneyRows commercial={commercial} showNet={commercial.showDiscount} />
          </View>
        ) : null}
        {published && pdfView.kind === "preparing" ? (
          <Text accessibilityLiveRegion="polite" style={styles.warningBody}>
            {copy.quotePdfPreparing}
          </Text>
        ) : null}
        {published && pdfView.kind === "failed" ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {copy.quotePdfFailed}
          </Text>
        ) : null}
        {published && pdfError ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {pdfError}
          </Text>
        ) : null}
        {published && pdfRetry.acknowledgement ? (
          <Text accessibilityLiveRegion="polite" style={styles.warningBody}>
            {pdfRetry.acknowledgement}
          </Text>
        ) : null}

        {!published && commercial ? (
          <View style={styles.exactNote}>
            <Text style={styles.exactTitle}>{copy.previewExact}</Text>
          </View>
        ) : null}

        {(previewStale || view.kind === "conflict") && !published ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: loading, busy: loading }}
            disabled={loading}
            onPress={() => void load()}
            style={styles.secondary}
          >
            <Text style={styles.secondaryLabel}>{copy.previewRefresh}</Text>
          </Pressable>
        ) : null}

        {published ? (
          <>
            {pdfView.kind === "ready" ? (
              <Pressable accessibilityRole="button" onPress={() => void openOrRetryPdf()} style={styles.primary}>
                <Text style={styles.primaryLabel}>{copy.quotePdfDownload}</Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: pdfRetry.busy, busy: pdfChecking }}
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
      </ScrollView>

      {!published && view.kind !== "access_expired" && view.kind !== "loading" ? (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          {previewStale || view.kind === "conflict" ? (
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: true }} disabled style={styles.disabledButton}>
              <Text style={styles.primaryLabel}>{copy.publishUnavailable}</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: continueDisabled, busy: publishing }}
              disabled={continueDisabled}
              onPress={continueToPublish}
              style={continueDisabled ? styles.disabledButton : styles.primary}
            >
              <Text style={styles.primaryLabel}>{copy.previewContinue}</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      <Modal animationType="slide" onRequestClose={cancelConfirmation} transparent visible={confirmationOpen} accessibilityViewIsModal>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.sheetWrap}>
          <Pressable accessibilityLabel={copy.notNow} disabled={publishing} onPress={cancelConfirmation} style={styles.scrim} />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.handle} />
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              {copy.publishAndSend}
            </Text>
            <Text style={styles.sheetBody}>{copy.publishAndSendBody}</Text>
            <Text style={styles.fieldLabel}>{copy.quoteRecipientEmail}</Text>
            <View style={styles.emailRow}>
              <TextInput
                accessibilityHint={copy.quoteRecipientHint}
                accessibilityLabel={copy.quoteRecipientEmail}
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                editable={!publishing}
                keyboardType="email-address"
                maxLength={EMAIL_MAX_LENGTH}
                onChangeText={onEmailChange}
                style={styles.emailInput}
                textContentType="emailAddress"
                value={recipientEmail}
              />
              {emailValid ? <Text style={styles.emailValid}>✓</Text> : null}
            </View>
            {fieldError ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {fieldError}
              </Text>
            ) : null}
            <View style={styles.finalCard}>
              <Text style={styles.finalTitle}>{copy.publishOneFinal}</Text>
              <Text style={styles.finalBody}>{copy.publishOneFinalHint}</Text>
            </View>
            <Text style={styles.sheetHint}>{copy.quoteRecipientHint}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !emailValid || publishing || !hashCurrent, busy: publishing }}
              disabled={!emailValid || publishing || !hashCurrent}
              onPress={() => void confirmPublish()}
              style={!emailValid || publishing || !hashCurrent ? styles.disabledButton : styles.primary}
            >
              <Text style={styles.primaryLabel}>{publishing ? copy.quotePublishing : copy.publishAndSend}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: publishing }}
              disabled={publishing}
              onPress={cancelConfirmation}
              style={styles.sheetBack}
            >
              <Text style={styles.secondaryLabel}>{copy.back}</Text>
            </Pressable>
            <Text style={styles.privacy}>{copy.publishRecipientOnly}</Text>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        accessibilityViewIsModal
        animationType="slide"
        onRequestClose={() => setError(undefined)}
        transparent
        visible={view.kind === "entitlement"}
      >
        <View style={styles.sheetWrap}>
          <Pressable accessibilityLabel={copy.notNow} onPress={() => setError(undefined)} style={styles.scrim} />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.handle} />
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              {copy.slotRequiredTitle}
            </Text>
            <Text accessibilityLiveRegion="polite" style={styles.sheetBody}>
              {copy.slotRequiredBody}
            </Text>
            <View style={styles.finalCard}>
              <Text style={styles.finalTitle}>{copy.slotDraftSafe}</Text>
              <Text style={styles.finalBody}>{copy.slotDraftSafeBody}</Text>
            </View>
            {error?.message ? <Text style={styles.sheetHint}>{error.message}</Text> : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(quotePublishPlansPath())}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>{copy.viewPlans}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setError(undefined)} style={styles.sheetBack}>
              <Text style={styles.secondaryLabel}>{copy.notNow}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function MoneyRows({
  commercial,
  showNet,
}: {
  commercial: {
    subtotalCents: number;
    discountCents: number;
    showDiscount: boolean;
    netCents: number;
    taxCents: number;
    totalCents: number;
  };
  showNet: boolean;
}) {
  return (
    <View style={styles.totals}>
      <TotalRow label={copy.quoteSubtotal} value={formatUsdCents(commercial.subtotalCents)} />
      {commercial.showDiscount ? <TotalRow label={copy.quoteDiscountTotal} value={formatUsdCents(commercial.discountCents)} /> : null}
      {showNet ? <TotalRow label={copy.quoteNet} value={formatUsdCents(commercial.netCents)} /> : null}
      <TotalRow label={copy.quoteTaxTotal} value={formatUsdCents(commercial.taxCents)} />
      <TotalRow emphasis label={copy.quoteTotal} value={formatUsdCents(commercial.totalCents)} />
    </View>
  );
}

function TotalRow({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <View style={styles.totalRow}>
      <Text style={emphasis ? styles.totalLabelStrong : styles.totalLabel}>{label}</Text>
      <Text style={emphasis ? styles.totalValueStrong : styles.totalValue}>{value}</Text>
    </View>
  );
}

function quoteLifecycleLabel(lifecycle: string): string {
  switch (lifecycle) {
    case "issued":
      return copy.quoteLifecycleIssued;
    case "accepted":
      return copy.quoteLifecycleAccepted;
    case "declined":
      return copy.quoteLifecycleDeclined;
    case "expired":
      return copy.quoteLifecycleExpired;
    case "superseded":
      return copy.quoteLifecycleSuperseded;
    case "withdrawn":
      return copy.quoteLifecycleWithdrawn;
    default:
      return lifecycle;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  atmosphere: {
    position: "absolute",
    top: -80,
    right: -70,
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: "#E4EAF6",
  },
  content: { padding: 20, gap: 12, paddingBottom: 128 },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  iconGlyph: { color: colors.text, fontSize: 28, lineHeight: 32 },
  eyebrow: { color: "#464B71", fontSize: 11, fontWeight: "600", letterSpacing: 0.6 },
  title: { color: colors.text, fontSize: 26, lineHeight: 34, fontWeight: "700" },
  support: { color: colors.secondary, fontSize: 15, lineHeight: 22 },
  readyRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  readyPill: {
    overflow: "hidden",
    backgroundColor: "#E7F8F3",
    color: "#1F7A4D",
    borderRadius: 13,
    paddingHorizontal: 10,
    paddingVertical: 5,
    fontSize: 12,
    fontWeight: "600",
  },
  generated: { color: colors.secondary, fontSize: 11 },
  document: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  documentHead: { backgroundColor: "#EDEEF6", padding: 16, gap: 4 },
  businessName: { color: colors.text, fontSize: 16, fontWeight: "700" },
  documentKind: { color: "#464B71", fontSize: 12, fontWeight: "700", letterSpacing: 0.8 },
  unpublished: { color: colors.secondary, fontSize: 13 },
  identityRow: { flexDirection: "row", gap: 12, padding: 16 },
  identityCol: { flex: 1, gap: 4 },
  identityValue: { color: colors.text, fontSize: 15, fontWeight: "600" },
  metaLabel: { color: colors.secondary, fontSize: 11, fontWeight: "600", letterSpacing: 0.4 },
  lineHeader: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 8 },
  lineRow: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  lineCopy: { flex: 1, gap: 2 },
  lineDescription: { color: colors.text, fontSize: 15, fontWeight: "600" },
  lineMeta: { color: colors.secondary, fontSize: 13 },
  lineAmount: { color: colors.text, fontSize: 15, fontWeight: "600" },
  totals: { padding: 16, gap: 8 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  totalLabel: { color: colors.secondary, fontSize: 14 },
  totalValue: { color: colors.text, fontSize: 14 },
  totalLabelStrong: { color: colors.text, fontSize: 16, fontWeight: "700" },
  totalValueStrong: { color: colors.text, fontSize: 16, fontWeight: "700" },
  noteBlock: { paddingHorizontal: 16, paddingBottom: 16, gap: 4 },
  noteBody: { color: colors.text, fontSize: 14, lineHeight: 20 },
  exactNote: { backgroundColor: "#EDEEF6", borderRadius: 14, padding: 12 },
  exactTitle: { color: "#464B71", fontSize: 13, fontWeight: "600" },
  warningBanner: { backgroundColor: "#FFF7E6", borderRadius: 15, padding: 12, gap: 4 },
  warningTitle: { color: colors.text, fontSize: 14, fontWeight: "700" },
  warningBody: { color: colors.secondary, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  skeletonBar: { height: 18, margin: 16, borderRadius: 8, backgroundColor: "#EDEEF6" },
  skeletonBarShort: { height: 12, width: "46%", marginHorizontal: 16, borderRadius: 8, backgroundColor: "#EDEEF6" },
  skeletonBlock: { height: 88, margin: 16, borderRadius: 12, backgroundColor: "#EDEEF6" },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  primary: {
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    backgroundColor: "#464B71",
    paddingHorizontal: 16,
  },
  disabledButton: {
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    backgroundColor: "#ABAFBE",
    paddingHorizontal: 16,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  secondary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#464B71",
    backgroundColor: colors.surface,
    paddingHorizontal: 16,
  },
  secondaryLabel: { color: "#464B71", fontSize: 16, fontWeight: "600" },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(23, 33, 43, 0.42)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 10,
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 6 },
  sheetTitle: { color: colors.text, fontSize: 22, lineHeight: 28, fontWeight: "700" },
  sheetBody: { color: colors.secondary, fontSize: 15, lineHeight: 22 },
  fieldLabel: { color: colors.text, fontSize: 13, fontWeight: "600" },
  emailRow: {
    minHeight: 54,
    borderRadius: 14,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
  },
  emailInput: { flex: 1, minHeight: 48, color: colors.text, fontSize: 16 },
  emailValid: { color: "#1F7A4D", fontSize: 16, fontWeight: "700" },
  finalCard: { backgroundColor: "#EDEEF6", borderRadius: 14, padding: 12, gap: 4 },
  finalTitle: { color: colors.text, fontSize: 14, fontWeight: "700" },
  finalBody: { color: colors.secondary, fontSize: 13, lineHeight: 18 },
  sheetHint: { color: colors.secondary, fontSize: 13, lineHeight: 18 },
  sheetBack: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  privacy: { color: colors.secondary, fontSize: 12, textAlign: "center" },
});
