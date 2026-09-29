import { formatUsdCents } from "@job-to-invoice/schemas";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
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
import { DirectInvoiceScreen } from "../../../../src/invoices/direct-screen.tsx";
import {
  dueDateFromOption,
  invoiceAllocatedNumber,
  invoiceAnalyticsProperties,
  invoiceDeliveryLabel,
  invoiceDiscountCents,
  invoiceIdempotencyAfterFailure,
  invoiceIssueBody,
  invoicePdfPhase,
  invoicePdfRetrySupported,
  invoicePreviewAfterRefresh,
  invoiceRecipientReview,
  invoiceUnresolvedAction,
  invoiceUnresolvedClientMessage,
  invoiceVisiblePreview,
  presentInvoicePdf,
  presentInvoicePreview,
  type InvoicePreviewRecord,
  type IssuedInvoiceRecord,
} from "../../../../src/invoices/presentation.ts";
import { jobDetailPath, jobInvoiceDetailPath } from "../../../../src/jobs/routes.ts";
import type { JobDetail } from "../../../../src/jobs/presentation.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../../src/theme.ts";

const PRIMARY = "#464B71";
const PRIMARY_PRESSED = "#3A3E5E";
const GUTTER = 20;
const PDF_POLL_MS = 3000;
const PDF_POLL_LIMIT = 20;

type DueOption = "receipt" | "7" | "14" | "30" | "custom";
type ScreenError = { message: string; retryable: boolean; status: number; code?: string; field?: string };

export default function InvoicePreviewScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const jobId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? (params.id[0] ?? "") : "";
  const [mode, setMode] = useState<string | undefined>();
  const [jobMeta, setJobMeta] = useState<Pick<JobDetail, "change_draft" | "latest_change"> | undefined>();
  const [preview, setPreview] = useState<InvoicePreviewRecord | undefined>();
  const [issued, setIssued] = useState<IssuedInvoiceRecord | undefined>();
  const [pdfState, setPdfState] = useState<string | undefined>();
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [dueOption, setDueOption] = useState<DueOption>("14");
  const [customDue, setCustomDue] = useState("");
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [checkingPdf, setCheckingPdf] = useState(false);
  const [error, setError] = useState<ScreenError | undefined>();
  const [entitlementOpen, setEntitlementOpen] = useState(false);
  const issueKey = useRef<string | undefined>(undefined);
  const issuingRef = useRef(false);
  const previewRef = useRef<InvoicePreviewRecord | undefined>(undefined);
  const issuedRef = useRef<IssuedInvoiceRecord | undefined>(undefined);
  const pollTicks = useRef(0);

  const leaveToJob = useCallback(() => {
    setConfirming(false);
    router.replace(jobDetailPath(jobId));
  }, [jobId, router]);

  const load = useCallback(async () => {
    if (issuedRef.current) {
      return;
    }
    if (!jobId) {
      setLoading(false);
      setError({ message: copy.jobNotFound, retryable: false, status: 404 });
      return;
    }
    const hadPreview = previewRef.current !== undefined;
    if (!hadPreview) {
      setLoading(true);
    }
    const jobResult = await runOwnerRequest<JobDetail>({ path: `/v1/jobs/${jobId}` });
    if (issuedRef.current) {
      return;
    }
    if (!jobResult.ok) {
      if (!hadPreview) {
        setError({
          message: jobResult.error.status === 404 ? copy.jobNotFound : jobResult.error.message || copy.invoicePreviewError,
          retryable: jobResult.error.retryable || jobResult.error.status === 0,
          status: jobResult.error.status,
          code: jobResult.error.code,
        });
      }
      setLoading(false);
      return;
    }
    if (jobResult.data.active_invoice) {
      router.replace(jobInvoiceDetailPath(jobId, jobResult.data.active_invoice.id));
      return;
    }
    setMode(jobResult.data.mode);
    setJobMeta({ change_draft: jobResult.data.change_draft, latest_change: jobResult.data.latest_change });
    if (jobResult.data.mode === "direct_invoice") {
      setLoading(false);
      return;
    }
    const result = await runOwnerRequest<InvoicePreviewRecord>({
      path: `/v1/jobs/${jobId}/invoice-preview`,
      method: "POST",
      body: {},
    });
    if (issuedRef.current) {
      return;
    }
    const nextPreview = invoicePreviewAfterRefresh(previewRef.current, result.ok ? result.data : undefined, result.ok);
    previewRef.current = nextPreview;
    setPreview(nextPreview);
    if (result.ok && result.data) {
      setInstructions(result.data.snapshot.payment_instructions);
      setCustomDue(result.data.snapshot.due_date);
      setError(undefined);
    } else if (!result.ok) {
      const field = result.error.field_errors?.[0];
      setError({
        message:
          result.error.code === "UNRESOLVED_CHANGES"
            ? invoiceUnresolvedClientMessage({
                changeDraft: jobResult.data.change_draft,
                latestChange: jobResult.data.latest_change,
                apiMessage: result.error.message,
              })
            : field?.message || result.error.message || copy.invoicePreviewError,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
        code: result.error.code,
        field: field?.field,
      });
    }
    setLoading(false);
  }, [jobId, router, runOwnerRequest]);

  const refreshIssued = useCallback(
    async (invoiceId: string) => {
      setCheckingPdf(true);
      const document = await runOwnerRequest<IssuedInvoiceRecord>({ path: `/v1/documents/${invoiceId}` });
      if (document.ok) {
        issuedRef.current = document.data;
        setIssued(document.data);
        setPdfState(document.data.pdf_state);
      }
      const download = await runOwnerRequest<{ state: string; url: string | null }>({
        path: `/v1/documents/${invoiceId}/download`,
      });
      if (download.ok) {
        setPdfState(download.data.state);
        setPdfUrl(download.data.state === "ready" ? download.data.url : null);
      }
      setCheckingPdf(false);
    },
    [runOwnerRequest],
  );

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    if (auth.snapshot.status !== "access_expired") {
      return;
    }
    previewRef.current = undefined;
    issuedRef.current = undefined;
    setPreview(undefined);
    setIssued(undefined);
    setPdfUrl(null);
    setPdfState(undefined);
    setConfirming(false);
    setInstructions("");
  }, [auth.snapshot.status]);

  useEffect(() => {
    if (!confirming) {
      return;
    }
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setConfirming(false);
      return true;
    });
    return () => subscription.remove();
  }, [confirming]);

  useEffect(() => {
    const invoiceId = issued?.id;
    if (!invoiceId || invoicePdfPhase(pdfState) !== "preparing") {
      return;
    }
    pollTicks.current = 0;
    const timer = setInterval(() => {
      pollTicks.current += 1;
      if (pollTicks.current > PDF_POLL_LIMIT) {
        clearInterval(timer);
        return;
      }
      void refreshIssued(invoiceId);
    }, PDF_POLL_MS);
    return () => clearInterval(timer);
  }, [issued?.id, pdfState, refreshIssued]);

  if (mode === "direct_invoice" && !issued) {
    return <DirectInvoiceScreen jobId={jobId} />;
  }

  const visiblePreview = invoiceVisiblePreview(auth.snapshot.status, preview);
  const view = presentInvoicePreview({
    authStatus: auth.snapshot.status,
    loading,
    confirming,
    issuing,
    preview: visiblePreview,
    error,
  });
  const unresolvedAction = invoiceUnresolvedAction({
    jobId,
    changeDraft: jobMeta?.change_draft,
    latestChange: jobMeta?.latest_change,
  });
  const phase = issued ? invoicePdfPhase(pdfState ?? issued.pdf_state) : undefined;
  const allocatedNumber = invoiceAllocatedNumber(issued?.number);
  const snapshot = issued?.snapshot ?? visiblePreview?.snapshot;
  const moneySource = issued
    ? { net_cents: issued.net_cents, tax_cents: issued.tax_cents, total_cents: issued.total_cents }
    : snapshot;
  const discountCents = snapshot ? invoiceDiscountCents(snapshot.lines) : undefined;
  const dueDate =
    issued?.due_date ??
    (visiblePreview
      ? dueDateFromOption(visiblePreview.snapshot.issue_date, dueOption, customDue || visiblePreview.snapshot.due_date)
      : undefined);
  const recipient = invoiceRecipientReview(snapshot?.customer.email);
  const deliveryLabel = invoiceDeliveryLabel(issued?.delivery_state);
  const pdf = presentInvoicePdf(phase ?? "preparing");
  const heading =
    phase === "failed" ? copy.invoiceAttentionHeading : phase === "preparing" ? copy.invoicePreparingHeading : copy.invoiceReviewHeading;
  const support =
    phase === "failed" ? copy.invoiceAttentionSupport : phase === "preparing" ? copy.invoicePreparingSupport : copy.invoiceReviewSupport;

  async function issue() {
    if (issuingRef.current || !visiblePreview || view.issueDisabled || !recipient.ok) {
      return;
    }
    issuingRef.current = true;
    setIssuing(true);
    setError(undefined);
    const nextDue = dueDateFromOption(visiblePreview.snapshot.issue_date, dueOption, customDue || visiblePreview.snapshot.due_date);
    const refreshed = await runOwnerRequest<InvoicePreviewRecord>({
      path: `/v1/jobs/${jobId}/invoice-preview`,
      method: "POST",
      body: {
        due_date: nextDue,
        payment_instructions: instructions.trim() || undefined,
      },
    });
    if (!refreshed.ok) {
      issuingRef.current = false;
      setIssuing(false);
      const field = refreshed.error.field_errors?.[0];
      if (refreshed.error.code === "ENTITLEMENT_REQUIRED") {
        setEntitlementOpen(true);
      }
      setError({
        message:
          refreshed.error.code === "PREVIEW_CHANGED"
            ? copy.invoiceStalePreview
            : refreshed.error.code === "UNRESOLVED_CHANGES"
              ? invoiceUnresolvedClientMessage({
                  changeDraft: jobMeta?.change_draft,
                  latestChange: jobMeta?.latest_change,
                  apiMessage: refreshed.error.message,
                })
              : field?.message || refreshed.error.message || copy.invoicePreviewError,
        retryable: refreshed.error.retryable || refreshed.error.status === 0,
        status: refreshed.error.status,
        code: refreshed.error.code,
        field: field?.field,
      });
      return;
    }
    previewRef.current = refreshed.data;
    setPreview(refreshed.data);
    issueKey.current = retainOrCreateSetupIdempotencyKey(issueKey.current);
    const result = await runOwnerRequest<{ id: string }>({
      path: `/v1/jobs/${jobId}/issue-invoice`,
      method: "POST",
      idempotencyKey: issueKey.current,
      body: invoiceIssueBody(refreshed.data.preview_hash),
    });
    issuingRef.current = false;
    setIssuing(false);
    if (result.ok) {
      setConfirming(false);
      setError(undefined);
      invoiceAnalyticsProperties();
      issuedRef.current = {
        id: result.data.id,
        job_id: jobId,
        number: "",
        revision_label: "",
        lifecycle: "issued",
        pdf_state: "preparing",
        delivery_state: null,
        payment_status: "",
        due_date: refreshed.data.snapshot.due_date,
        snapshot: refreshed.data.snapshot,
        net_cents: refreshed.data.snapshot.net_cents,
        tax_cents: refreshed.data.snapshot.tax_cents,
        total_cents: refreshed.data.snapshot.total_cents,
      };
      setIssued(issuedRef.current);
      setPdfState("preparing");
      await refreshIssued(result.data.id);
      return;
    }
    issueKey.current = invoiceIdempotencyAfterFailure(issueKey.current, result.error.code);
    if (result.error.code === "IDEMPOTENCY_MISMATCH") {
      issueKey.current = retainOrCreateSetupIdempotencyKey(undefined);
    }
    if (result.error.code === "ENTITLEMENT_REQUIRED") {
      setEntitlementOpen(true);
    }
    const field = result.error.field_errors?.[0];
    setError({
      message:
        result.error.code === "PREVIEW_CHANGED"
          ? copy.invoiceStalePreview
          : result.error.code === "UNRESOLVED_CHANGES"
            ? invoiceUnresolvedClientMessage({
                changeDraft: jobMeta?.change_draft,
                latestChange: jobMeta?.latest_change,
                apiMessage: result.error.message,
              })
            : result.error.code === "DOCUMENT_IMMUTABLE"
              ? copy.invoiceDuplicate
              : field?.message || result.error.message || copy.invoiceIssueError,
      retryable: result.error.retryable || result.error.status === 0,
      status: result.error.status,
      code: result.error.code,
      field: field?.field,
    });
  }

  const badge =
    phase === "failed"
      ? copy.invoicePdfFailedBadge
      : phase === "preparing"
        ? copy.invoicePreparingBadge
        : phase === "ready"
          ? pdf.label
          : copy.invoicePreviewReady;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable
            accessibilityLabel={copy.back}
            accessibilityRole="button"
            hitSlop={4}
            onPress={leaveToJob}
            style={styles.back}
          >
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
          <Text style={styles.eyebrow}>{copy.invoicePreviewEyebrow}</Text>
          <Text accessibilityRole="header" style={styles.title}>
            {heading}
          </Text>
          <Text style={styles.support}>{support}</Text>
          {view.kind === "loading" ? (
            <View accessibilityLabel={copy.requestLoading} style={styles.skeleton}>
              <ActivityIndicator color={PRIMARY} />
            </View>
          ) : null}
          {view.kind === "offline" ? (
            <Text accessibilityLiveRegion="polite" style={styles.banner}>
              {copy.invoiceOffline}
            </Text>
          ) : null}
          {view.kind === "access_expired" ? (
            <Text accessibilityLiveRegion="polite" style={styles.banner}>
              {copy.accessExpired}
            </Text>
          ) : null}
          {view.message ? (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {view.message}
            </Text>
          ) : null}
          {error && !view.message && view.kind !== "access_expired" ? (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {error.message}
            </Text>
          ) : null}
          {view.kind === "unresolved" && unresolvedAction ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(unresolvedAction.path)}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{unresolvedAction.label}</Text>
            </Pressable>
          ) : null}
          {view.showRetry ? (
            <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.retry}</Text>
            </Pressable>
          ) : null}
          {snapshot && moneySource && view.kind !== "access_expired" ? (
            <>
              <Text accessibilityLiveRegion="polite" style={[styles.badge, badgeStyle(phase)]}>
                {badge}
              </Text>
              <View style={styles.card}>
                <Text style={styles.docType}>{copy.invoiceDocumentType}</Text>
                <Text style={styles.business}>{snapshot.business.business_name}</Text>
                {allocatedNumber ? <Text style={styles.docMeta}>{allocatedNumber}</Text> : null}
                {snapshot.job.title ? <Text style={styles.docMeta}>{snapshot.job.title}</Text> : null}
                <Text style={styles.billTo}>{copy.invoiceBillTo}</Text>
                <Text style={styles.customer}>{snapshot.customer.name}</Text>
                {recipient.ok ? <Text style={styles.docMeta}>{recipient.display}</Text> : null}
                {snapshot.lines.map((line) => (
                  <View key={`${line.position}-${line.description}`} style={styles.line}>
                    <Text style={styles.lineBody}>
                      {line.description}
                      {line.quantity ? ` · ${line.quantity} ${line.unit}` : ""}
                    </Text>
                    <Text style={styles.lineAmount}>{formatUsdCents(line.total_cents)}</Text>
                  </View>
                ))}
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>{copy.invoiceSubtotal}</Text>
                  <Text style={styles.totalValue}>{formatUsdCents(moneySource.net_cents)}</Text>
                </View>
                {discountCents !== undefined ? (
                  <View style={styles.totalRow}>
                    <Text style={styles.totalLabel}>{copy.invoiceDiscount}</Text>
                    <Text style={styles.totalValue}>{formatUsdCents(discountCents)}</Text>
                  </View>
                ) : null}
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>{copy.invoiceTax}</Text>
                  <Text style={styles.totalValue}>{formatUsdCents(moneySource.tax_cents)}</Text>
                </View>
                <View style={styles.totalRow}>
                  <Text style={styles.grandLabel}>{copy.invoiceTotalLabel}</Text>
                  <Text style={styles.grandValue}>{formatUsdCents(moneySource.total_cents)}</Text>
                </View>
                {dueDate ? (
                  <Text style={styles.docMeta}>
                    {copy.invoiceDueDate}: {dueDate}
                  </Text>
                ) : null}
              </View>
              {deliveryLabel ? (
                <Text accessibilityLiveRegion="polite" style={styles.banner}>
                  {deliveryLabel}
                </Text>
              ) : null}
              {!issued ? (
                <>
                  <Text style={styles.section}>{copy.invoiceDueDate}</Text>
                  <View style={styles.dueRow}>
                    {(
                      [
                        ["receipt", copy.invoiceDueReceipt],
                        ["7", copy.invoiceDue7],
                        ["14", copy.invoiceDue14],
                        ["30", copy.invoiceDue30],
                        ["custom", copy.invoiceDueCustom],
                      ] as const
                    ).map(([option, label]) => (
                      <Pressable
                        key={option}
                        accessibilityRole="button"
                        accessibilityState={{ selected: dueOption === option, disabled: view.issueDisabled }}
                        disabled={view.issueDisabled}
                        onPress={() => setDueOption(option)}
                        style={[styles.dueChip, dueOption === option ? styles.dueChipSelected : null]}
                      >
                        <Text style={[styles.dueChipLabel, dueOption === option ? styles.dueChipLabelSelected : null]}>{label}</Text>
                      </Pressable>
                    ))}
                  </View>
                  {dueOption === "custom" ? (
                    <TextInput
                      accessibilityLabel={copy.invoiceDueCustom}
                      autoCapitalize="none"
                      editable={!view.issueDisabled}
                      onChangeText={setCustomDue}
                      placeholder="YYYY-MM-DD"
                      style={styles.input}
                      value={customDue}
                    />
                  ) : null}
                  <Text style={styles.section}>{copy.invoicePaymentInstructions}</Text>
                  <TextInput
                    accessibilityLabel={copy.invoicePaymentInstructions}
                    editable={!view.issueDisabled}
                    multiline
                    onChangeText={setInstructions}
                    style={styles.input}
                    value={instructions}
                  />
                  <View style={styles.notice}>
                    <Text style={styles.noticeTitle}>{copy.invoiceServerPreview}</Text>
                    <Text style={styles.noticeBody}>{copy.invoiceServerPreviewBody}</Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: view.issueDisabled || !recipient.ok, busy: issuing }}
                    disabled={view.issueDisabled || !recipient.ok}
                    onPress={() => setConfirming(true)}
                    style={({ pressed }) => [styles.primary, pressed ? styles.primaryPressed : null, view.issueDisabled || !recipient.ok ? styles.disabled : null]}
                  >
                    <Text style={styles.primaryLabel}>{copy.invoiceContinueSend}</Text>
                  </Pressable>
                  {!recipient.ok ? (
                    <Text accessibilityLiveRegion="polite" style={styles.error}>
                      {copy.invoiceEmailInvalid}
                    </Text>
                  ) : null}
                </>
              ) : null}
              {phase === "preparing" ? (
                <View style={styles.notice}>
                  <Text style={styles.noticeTitle}>{copy.invoicePreparingNotice}</Text>
                  <Text style={styles.noticeBody}>{copy.invoicePreparingBody}</Text>
                </View>
              ) : null}
              {phase === "failed" ? (
                <View style={styles.noticeWarn}>
                  <Text style={styles.noticeWarnTitle}>{copy.invoicePdfFailedNotice}</Text>
                  <Text style={styles.noticeBody}>{copy.invoicePdfFailedBody}</Text>
                </View>
              ) : null}
              {issued && phase !== "ready" && !invoicePdfRetrySupported() ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: checkingPdf || auth.snapshot.status === "offline_cached", busy: checkingPdf }}
                  disabled={checkingPdf || auth.snapshot.status === "offline_cached"}
                  onPress={() => {
                    pollTicks.current = 0;
                    void refreshIssued(issued.id);
                  }}
                  style={({ pressed }) => [styles.primary, pressed ? styles.primaryPressed : null]}
                >
                  <Text style={styles.primaryLabel}>{copy.invoiceCheckAgain}</Text>
                </Pressable>
              ) : null}
              {issued && phase === "ready" && pdf.canShare && pdfUrl ? (
                <Pressable accessibilityRole="button" onPress={() => void Linking.openURL(pdfUrl)} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{copy.invoiceShare}</Text>
                </Pressable>
              ) : null}
              {issued ? (
                <Pressable accessibilityRole="button" onPress={leaveToJob} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{copy.invoiceBackToJob}</Text>
                </Pressable>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
      <Modal animationType="slide" accessibilityViewIsModal onRequestClose={() => setConfirming(false)} transparent visible={confirming && !issued}>
        <View style={styles.sheetWrap}>
          <Pressable accessibilityLabel={copy.requestCancel} onPress={() => setConfirming(false)} style={styles.scrim} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.handle} />
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              {copy.invoiceSendTitle}
            </Text>
            <Text style={styles.support}>{copy.invoiceSendBody}</Text>
            <Text style={styles.section}>{copy.invoiceEmailReadOnly}</Text>
            {recipient.ok ? (
              <Text style={styles.emailValue}>{recipient.display}</Text>
            ) : (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {copy.invoiceEmailMissing}
              </Text>
            )}
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>{copy.invoiceSendReady}</Text>
              <Text style={styles.noticeBody}>
                {moneySource ? formatUsdCents(moneySource.total_cents) : ""}
                {dueDate ? ` · ${dueDate}` : ""}
              </Text>
            </View>
            {error ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {error.message}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: view.issueDisabled || issuing || !recipient.ok, busy: issuing }}
              disabled={view.issueDisabled || issuing || !recipient.ok}
              onPress={() => void issue()}
              style={({ pressed }) => [styles.primary, pressed ? styles.primaryPressed : null, view.issueDisabled || !recipient.ok ? styles.disabled : null]}
            >
              <Text style={styles.primaryLabel}>{issuing ? copy.invoiceIssuing : copy.invoiceSendTitle}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setConfirming(false)} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.requestCancel}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <Modal accessibilityViewIsModal animationType="fade" onRequestClose={() => setEntitlementOpen(false)} transparent visible={entitlementOpen}>
        <View style={styles.sheetWrap}>
          <Pressable accessibilityLabel={copy.notNow} onPress={() => setEntitlementOpen(false)} style={styles.scrim} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              {copy.viewPlans}
            </Text>
            <Text style={styles.support}>{error?.message}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setEntitlementOpen(false);
                router.push("/(tabs)/settings/subscription");
              }}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>{copy.viewPlans}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setEntitlementOpen(false)} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.notNow}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function badgeStyle(phase: "preparing" | "ready" | "failed" | undefined) {
  if (phase === "failed") {
    return styles.badgeFailed;
  }
  if (phase === "preparing") {
    return styles.badgePreparing;
  }
  if (phase === "ready") {
    return styles.badgeReady;
  }
  return styles.badgeReady;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  atmosphere: {
    position: "absolute",
    top: -80,
    right: -70,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "#E8F1FF",
    opacity: 0.62,
  },
  content: { paddingHorizontal: GUTTER, gap: 12 },
  back: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  backGlyph: { color: colors.text, fontSize: 28, lineHeight: 32, fontWeight: "500" },
  eyebrow: { color: PRIMARY, fontSize: 12, fontWeight: "700", letterSpacing: 1.1 },
  title: { color: "#181F30", fontSize: 32, lineHeight: 38, fontWeight: "700" },
  support: { color: "#5B6577", fontSize: type.body, lineHeight: 24 },
  skeleton: { minHeight: 160, alignItems: "center", justifyContent: "center" },
  badge: { alignSelf: "flex-start", overflow: "hidden", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, fontWeight: "700" },
  badgeReady: { backgroundColor: "#E6F9F4", color: "#1BB99A" },
  badgePreparing: { backgroundColor: "#FFF7E0", color: "#AD700F" },
  badgeFailed: { backgroundColor: "#FFECED", color: "#B8373E" },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#DADFE8",
    padding: 18,
    gap: 8,
  },
  docType: { color: PRIMARY, fontSize: 12, fontWeight: "700", letterSpacing: 1 },
  business: { color: "#181F30", fontSize: 20, fontWeight: "700" },
  docMeta: { color: "#5B6577", fontSize: type.secondary },
  billTo: { color: "#8A94A6", fontSize: 12, fontWeight: "700", letterSpacing: 0.8, marginTop: 8 },
  customer: { color: colors.text, fontSize: type.body, fontWeight: "600" },
  line: { flexDirection: "row", gap: 12, alignItems: "flex-start", marginTop: 8 },
  lineBody: { flex: 1, color: colors.text, fontSize: type.body },
  lineAmount: { color: colors.text, fontSize: type.body, fontWeight: "600" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  totalLabel: { color: "#5B6577", fontSize: type.secondary },
  totalValue: { color: colors.text, fontSize: type.secondary },
  grandLabel: { color: "#181F30", fontSize: type.body, fontWeight: "700" },
  grandValue: { color: "#181F30", fontSize: type.body, fontWeight: "700" },
  section: { color: colors.text, fontSize: type.secondary, fontWeight: "700", marginTop: 8 },
  banner: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: "#DADFE8",
    borderRadius: 14,
    padding: space.scale,
    color: colors.text,
    fontSize: type.body,
    backgroundColor: colors.surface,
  },
  dueRow: { flexDirection: "row", flexWrap: "wrap", gap: space.scale },
  dueChip: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#DADFE8",
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  dueChipSelected: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  dueChipLabel: { color: PRIMARY, fontSize: type.secondary, fontWeight: "600" },
  dueChipLabelSelected: { color: "#FFFFFF" },
  notice: { backgroundColor: "#E8F1FF", borderRadius: 16, padding: 14, gap: 4 },
  noticeTitle: { color: "#3874CB", fontSize: type.secondary, fontWeight: "700" },
  noticeBody: { color: "#3D4C63", fontSize: type.secondary, lineHeight: 21 },
  noticeWarn: { backgroundColor: "#FFECED", borderRadius: 16, padding: 14, gap: 4 },
  noticeWarnTitle: { color: "#B8373E", fontSize: type.secondary, fontWeight: "700" },
  primary: {
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: PRIMARY,
  },
  primaryPressed: { backgroundColor: PRIMARY_PRESSED },
  primaryLabel: { color: "#FFFFFF", fontSize: type.body, fontWeight: "700" },
  disabled: { opacity: 0.45 },
  secondary: {
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#DADFE8",
    backgroundColor: colors.surface,
  },
  secondaryLabel: { color: "#181F30", fontSize: type.body, fontWeight: "700" },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(19,25,39,0.38)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: GUTTER,
    paddingTop: 12,
    gap: 12,
  },
  handle: { alignSelf: "center", width: 44, height: 5, borderRadius: 3, backgroundColor: "#D5DCE3" },
  sheetTitle: { color: "#181F30", fontSize: 24, fontWeight: "700" },
  emailValue: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: "#DADFE8",
    borderRadius: 14,
    padding: 12,
    color: colors.text,
    fontSize: type.body,
    backgroundColor: colors.background,
  },
});
