import { formatUsdCents } from "@job-to-invoice/schemas";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
  Linking,
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
import {
  creditAfterRefresh,
  creditAnalyticsProperties,
  creditCommercialVisible,
  creditEligible,
  creditEntryIssues,
  creditIdempotencyAfterFailure,
  creditIssueBody,
  creditIssuedResult,
  creditLoadKind,
  creditOutcome,
  creditOverLineText,
  creditPdfPollContinues,
  creditPreviewBody,
  creditPreviewResult,
  creditRecordedPhase,
  creditResultDisplay,
  creditResultingCents,
  creditReviewAllowed,
  creditShouldIssue,
  type CreditIssue,
  type CreditPreviewSnapshot,
  type CreditSourceLine,
  type IssuedCreditRecord,
} from "../../../../src/invoices/credit-note.ts";
import { type IssuedInvoiceRecord } from "../../../../src/invoices/presentation.ts";
import { jobDetailPath, jobInvoiceDetailPath } from "../../../../src/jobs/routes.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors, type } from "../../../../src/theme.ts";

const PRIMARY = "#464B71";
const GUTTER = 20;
const PDF_POLL_MS = 3000;
const PDF_POLL_LIMIT = 20;

type CreditInvoice = IssuedInvoiceRecord & { credit_sources?: CreditSourceLine[] };

function firstParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? "") : "";
}

function issueMessage(issue: CreditIssue): string {
  if (issue.field === "reason") {
    return issue.code === "invalid" ? copy.creditReasonInvalid : copy.creditReasonShort;
  }
  if (issue.field === "allocations") {
    return copy.creditRequired;
  }
  if (issue.code === "over_line") {
    return copy.creditOver;
  }
  if (issue.code === "zero" || issue.code === "negative") {
    return copy.creditZero;
  }
  if (issue.code === "limit") {
    return copy.paymentAmountLimit;
  }
  return copy.paymentAmountInvalid;
}

export default function CreditNoteScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string | string[]; invoiceId?: string | string[] }>();
  const jobId = firstParam(params.id);
  const invoiceId = firstParam(params.invoiceId);
  const [invoice, setInvoice] = useState<CreditInvoice | undefined>();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<CreditPreviewSnapshot | undefined>();
  const [issued, setIssued] = useState<IssuedCreditRecord | undefined>();
  const [updatedBalance, setUpdatedBalance] = useState<number | undefined>();
  const [phase, setPhase] = useState<"entry" | "review" | "issued">("entry");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [banner, setBanner] = useState<string | undefined>();
  const [loadIssue, setLoadIssue] = useState<"not_found" | "unauthorized" | "rate" | "error" | undefined>();
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfTicks, setPdfTicks] = useState(0);
  const key = useRef<string | undefined>(undefined);
  const submitLock = useRef(false);
  const amountsDirty = useRef(false);
  const reasonRef = useRef<TextInput>(null);
  const firstAmountRef = useRef<TextInput>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const offline = auth.snapshot.status === "offline_cached";
  const expired = auth.snapshot.status === "access_expired";
  const visible = creditCommercialVisible(auth.snapshot.status, invoice);

  useEffect(() => {
    if (!expired) {
      return;
    }
    setInvoice(undefined);
    setAmounts({});
    setReason("");
    setPreview(undefined);
    setIssued(undefined);
    setUpdatedBalance(undefined);
    setPdfUrl(null);
    setPhase("entry");
  }, [expired]);

  const load = useCallback(async () => {
    if (expired) {
      setLoading(false);
      return;
    }
    if (!invoiceId) {
      setLoading(false);
      setInvoice(undefined);
      setLoadIssue("not_found");
      setBanner(copy.jobNotFound);
      return;
    }
    setLoading(true);
    const result = await runOwnerRequest<CreditInvoice>({ path: `/v1/invoices/${invoiceId}/ledger` });
    if (result.ok) {
      setInvoice((previous) => creditAfterRefresh(previous, result.data, false));
      setLoadIssue(undefined);
      setBanner(undefined);
      if (!amountsDirty.current) {
        setAmounts((current) => {
          const next: Record<string, string> = {};
          for (const source of result.data.credit_sources ?? []) {
            next[source.invoice_line_id] = current[source.invoice_line_id] ?? "";
          }
          return next;
        });
      }
    } else {
      const issue = creditLoadKind(result.error.status, result.error.code);
      setLoadIssue(issue);
      if (issue === "not_found" || issue === "unauthorized") {
        setInvoice(undefined);
        setAmounts({});
        setReason("");
      } else {
        setInvoice((previous) => creditAfterRefresh(previous, undefined, true));
      }
      setBanner(result.error.message || copy.creditError);
    }
    setLoading(false);
  }, [expired, invoiceId, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      if (phaseRef.current === "issued") {
        return;
      }
      void load();
    }, [load]),
  );

  const sources = visible?.credit_sources ?? [];
  const balance = Number.isInteger(visible?.amount_due_cents)
    ? visible?.amount_due_cents
    : Number.isInteger(visible?.balance_cents)
      ? visible?.balance_cents
      : undefined;
  const eligible = creditEligible(visible);
  const issues = creditEntryIssues({ sources, amounts, reason });
  const canReview = creditReviewAllowed({
    sources,
    amounts,
    reason,
    offline: offline || expired || auth.snapshot.status !== "authenticated",
    eligible,
  });
  const visibleIssues = issues.filter((issue) => issue.code !== "required" || attempted);
  const reasonIssue = issues.find((issue) => issue.field === "reason");
  const allocationIssue = issues.find((issue) => issue.field === "allocations");
  const customerName = visible?.snapshot.customer.name?.trim() ?? "";
  const resulting =
    preview && Number.isInteger(balance) ? creditResultingCents(balance as number, preview.total_cents) : undefined;
  const resultDisplay = resulting !== undefined ? creditResultDisplay(resulting) : undefined;
  const recordedPhase = creditRecordedPhase(updatedBalance);
  const overLines = visibleIssues.filter((issue) => issue.code === "over_line");
  const amountEntered = Object.values(amounts).some((value) => value.trim().length > 0);
  const reasonVisible =
    Boolean(reasonIssue) &&
    (reasonIssue?.code === "invalid" || reasonIssue?.code === "too_long" || attempted || amountEntered);
  const allocationVisible = Boolean(allocationIssue) && (attempted || reason.trim().length > 0);

  const goBack = useCallback(() => {
    if (submitLock.current) {
      return;
    }
    if (phaseRef.current === "review") {
      setPhase("entry");
      requestAnimationFrame(() => {
        if (firstAmountRef.current) {
          firstAmountRef.current.focus();
          return;
        }
        reasonRef.current?.focus();
      });
      return;
    }
    if (invoiceId) {
      router.replace(jobInvoiceDetailPath(jobId, invoiceId));
      return;
    }
    router.replace(jobDetailPath(jobId));
  }, [invoiceId, jobId, router]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      goBack();
      return true;
    });
    return () => subscription.remove();
  }, [goBack]);

  useEffect(() => {
    if (phase !== "issued" || !issued || !creditPdfPollContinues(issued.pdf_state, pdfTicks, PDF_POLL_LIMIT)) {
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        setPdfTicks((current) => current + 1);
        await checkPdf();
      })();
    }, PDF_POLL_MS);
    return () => clearTimeout(timer);
  }, [issued, pdfTicks, phase, runOwnerRequest]);

  async function review() {
    setAttempted(true);
    if (!canReview || !invoiceId) {
      return;
    }
    const body = creditPreviewBody({ sources, amounts, reason });
    if (!body) {
      return;
    }
    setSaving(true);
    setBanner(undefined);
    const result = await runOwnerRequest({
      path: `/v1/invoices/${invoiceId}/credits/preview`,
      method: "POST",
      body,
    });
    setSaving(false);
    if (!result.ok) {
      const outcome = creditOutcome(false, result.error.code);
      if (outcome === "auth") {
        setInvoice(undefined);
        setAmounts({});
        setReason("");
      }
      setBanner(result.error.message || copy.creditError);
      return;
    }
    const confirmed = creditPreviewResult(result.data);
    if (!confirmed) {
      setBanner(copy.creditError);
      return;
    }
    setPreview(confirmed);
    setPhase("review");
  }

  async function issue() {
    if (!creditShouldIssue(phaseRef.current, submitLock.current) || !invoiceId || !preview) {
      return;
    }
    const body = creditIssueBody(preview.preview_hash);
    if (!body) {
      return;
    }
    submitLock.current = true;
    setSaving(true);
    setBanner(undefined);
    key.current = retainOrCreateSetupIdempotencyKey(key.current);
    const result = await runOwnerRequest({
      path: `/v1/invoices/${invoiceId}/credits`,
      method: "POST",
      idempotencyKey: key.current,
      body,
    });
    if (!result.ok) {
      const retained = creditIdempotencyAfterFailure(key.current, result.error.code);
      key.current = retained === undefined ? retainOrCreateSetupIdempotencyKey(undefined) : retained;
      const outcome = creditOutcome(false, result.error.code);
      if (outcome === "auth") {
        setInvoice(undefined);
        setAmounts({});
        setReason("");
        setPreview(undefined);
        setPhase("entry");
      } else if (outcome === "conflict") {
        setPreview(undefined);
        setPhase("entry");
      }
      setBanner(outcome === "pending" ? copy.creditPending : outcome === "conflict" ? copy.creditConflict : result.error.message || copy.creditError);
      submitLock.current = false;
      setSaving(false);
      return;
    }
    const confirmed = creditIssuedResult(result.data);
    if (!confirmed) {
      setBanner(copy.creditError);
      submitLock.current = false;
      setSaving(false);
      return;
    }
    setIssued(confirmed);
    setPdfTicks(0);
    setPdfUrl(null);
    const fresh = await runOwnerRequest<CreditInvoice>({ path: `/v1/invoices/${invoiceId}/ledger` });
    if (fresh.ok) {
      setInvoice(fresh.data);
      const nextBalance = Number.isInteger(fresh.data.amount_due_cents) ? fresh.data.amount_due_cents : fresh.data.balance_cents;
      if (Number.isInteger(nextBalance)) {
        setUpdatedBalance(nextBalance);
      }
    }
    setPhase("issued");
    key.current = undefined;
    submitLock.current = false;
    setSaving(false);
    creditAnalyticsProperties();
  }

  function openCredit() {
    if (issued?.pdf_state !== "ready" || !pdfUrl) {
      return;
    }
    void Linking.openURL(pdfUrl);
  }

  async function checkPdf() {
    if (!issued) {
      return;
    }
    const result = await runOwnerRequest<{ state: string; url: string | null }>({
      path: `/v1/documents/${issued.id}/download`,
    });
    if (!result.ok) {
      return;
    }
    const state = result.data.state === "ready" || result.data.state === "failed" ? result.data.state : "preparing";
    setIssued((current) => (current ? { ...current, pdf_state: state } : current));
    setPdfUrl(state === "ready" && result.data.url ? result.data.url : null);
  }

  const heading =
    phase === "issued"
      ? issued?.number
        ? `${copy.creditTitle} ${issued.number}`
        : copy.creditIssued
      : phase === "review"
        ? copy.creditReviewHeading
        : copy.creditHeading;
  const support = phase === "issued" ? copy.creditIssuedBody : phase === "review" ? copy.creditReviewSupport : copy.creditSupport;

  return (
    <View style={styles.screen}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
        <View style={{ paddingTop: insets.top + 8, paddingHorizontal: GUTTER }}>
          <Pressable accessibilityLabel={copy.back} accessibilityRole="button" onPress={goBack} style={styles.back}>
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
          <Text style={styles.eyebrow}>{copy.creditEyebrow}</Text>
          <Text accessibilityRole="header" style={styles.title}>
            {heading}
          </Text>
          <Text style={styles.support}>{support}</Text>
        </View>
        <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {loading && !visible ? (
            <View accessibilityLabel={copy.creditPreviewing} style={styles.card}>
              <ActivityIndicator color={PRIMARY} />
            </View>
          ) : null}
          {expired ? (
            <Text accessibilityLiveRegion="polite" style={styles.noticeBody}>
              {copy.accessExpired}
            </Text>
          ) : null}
          {!expired && !visible && !loading && loadIssue ? (
            <View style={styles.noticeBad}>
              <Text accessibilityLiveRegion="polite" style={styles.noticeTitleBad}>
                {loadIssue === "not_found" ? copy.jobNotFound : loadIssue === "unauthorized" ? copy.accessExpired : copy.creditError}
              </Text>
              {loadIssue === "error" || loadIssue === "rate" ? (
                <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondaryQuiet}>
                  <Text style={styles.secondaryLabel}>{copy.paymentRefresh}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {visible && phase !== "issued" ? (
            <View style={styles.balanceCard}>
              <Text style={styles.invoiceNumber}>
                {visible.number ? `${copy.invoiceDetailName} ${visible.number}` : copy.invoiceIssueTitle}
              </Text>
              {customerName ? <Text style={styles.customer}>{customerName}</Text> : null}
              <View style={styles.divider} />
              <View style={styles.balanceRow}>
                <Text style={styles.kicker}>{copy.creditBalance}</Text>
                <Text style={styles.balance}>{balance !== undefined ? formatUsdCents(balance) : ""}</Text>
              </View>
            </View>
          ) : null}
          {visible && phase === "entry" ? (
            <>
              <Text style={styles.sectionLabel}>{copy.creditLines}</Text>
              <View style={[styles.linesCard, overLines.length > 0 ? styles.linesInvalid : styles.linesReady]}>
                {sources.map((source, index) => {
                  const lineIssue = visibleIssues.find((issue) => issue.lineId === source.invoice_line_id);
                  const lineError =
                    lineIssue?.code === "over_line"
                      ? creditOverLineText(source.description, source.remaining_net_cents)
                      : lineIssue
                        ? issueMessage(lineIssue)
                        : undefined;
                  return (
                    <View key={source.invoice_line_id}>
                      {index > 0 ? <View style={styles.lineDivider} /> : null}
                      <View style={styles.lineRow}>
                        <View style={styles.lineCopy}>
                          <Text style={styles.lineTitle}>{source.description}</Text>
                          <Text style={styles.remaining}>
                            {copy.creditRemaining} {formatUsdCents(source.remaining_net_cents)}
                          </Text>
                        </View>
                        <TextInput
                          ref={index === 0 ? firstAmountRef : undefined}
                          accessibilityHint={lineError}
                          accessibilityLabel={`${source.description}. ${copy.creditAmountHint}. Remaining net ${formatUsdCents(source.remaining_net_cents)}`}
                          autoCorrect={false}
                          editable={!offline && !saving}
                          keyboardType="decimal-pad"
                          onChangeText={(value) => {
                            amountsDirty.current = true;
                            setAmounts((current) => ({ ...current, [source.invoice_line_id]: value }));
                            setPreview(undefined);
                          }}
                          style={[styles.lineInput, lineIssue ? styles.lineInputInvalid : null]}
                          value={amounts[source.invoice_line_id] ?? ""}
                        />
                      </View>
                      {lineError ? (
                        <Text accessibilityLiveRegion="polite" style={styles.fieldError}>
                          {lineError}
                        </Text>
                      ) : null}
                    </View>
                  );
                })}
              </View>
              {allocationVisible && allocationIssue ? (
                <Text accessibilityLiveRegion="polite" style={styles.fieldError}>
                  {issueMessage(allocationIssue)}
                </Text>
              ) : null}
              <Text style={styles.sectionLabel}>{copy.creditReasonLabel}</Text>
              <TextInput
                ref={reasonRef}
                accessibilityLabel={`${copy.creditReasonLabel}, required`}
                editable={!offline && !saving}
                multiline
                onChangeText={(value) => {
                  setReason(value);
                  setPreview(undefined);
                }}
                style={[styles.input, styles.reason, reasonVisible ? styles.inputInvalid : null]}
                value={reason}
              />
              {reasonVisible && reasonIssue ? (
                <Text accessibilityLiveRegion="polite" style={styles.fieldError}>
                  {issueMessage(reasonIssue)}
                </Text>
              ) : null}
            </>
          ) : null}
          {visible && phase === "review" && preview ? (
            <View accessibilityLiveRegion="polite" style={styles.card}>
              <Text style={styles.summaryTitle}>{copy.creditSummary}</Text>
              <SummaryRow label={copy.creditLineCredits} value={formatUsdCents(preview.net_cents)} />
              <SummaryRow label={copy.creditTaxCredit} value={formatUsdCents(preview.tax_cents)} />
              <SummaryRow label={copy.creditTotalCredit} value={formatUsdCents(preview.total_cents)} />
              {resultDisplay ? (
                <SummaryRow
                  label={copy.creditResult}
                  value={
                    resultDisplay.kind === "refund_due"
                      ? `${copy.creditRefundDue} ${formatUsdCents(resultDisplay.cents)}`
                      : formatUsdCents(resultDisplay.cents)
                  }
                />
              ) : null}
            </View>
          ) : null}
          {visible && phase === "issued" && issued ? (
            <>
              <View accessibilityLiveRegion="polite" style={styles.successCard}>
                <View style={styles.checkCircle}>
                  <Text style={styles.checkCircleMark}>✓</Text>
                </View>
                <Text style={styles.successTitle}>{copy.creditIssued}</Text>
                <Text style={styles.successAmount}>{`−${formatUsdCents(issued.total_cents)}`}</Text>
              </View>
              <View style={styles.balanceCard}>
                <Text style={styles.invoiceNumber}>
                  {visible.number ? `${copy.invoiceDetailName} ${visible.number}` : copy.invoiceIssueTitle}
                </Text>
                {recordedPhase ? (
                  <Text style={recordedPhase === "refund_due" ? styles.statusRefund : styles.statusGood}>
                    {recordedPhase === "refund_due" ? copy.creditRefundDue : recordedPhase === "full" ? copy.creditFull : copy.creditPartial}
                  </Text>
                ) : null}
                <View style={styles.divider} />
                <View style={styles.balanceRow}>
                  <Text style={styles.kicker}>
                    {recordedPhase === "refund_due" ? copy.creditRefundDueLabel : copy.creditRemainingLabel}
                  </Text>
                  <Text style={styles.balance}>
                    {updatedBalance !== undefined ? formatUsdCents(recordedPhase === "refund_due" ? -updatedBalance : updatedBalance) : ""}
                  </Text>
                </View>
              </View>
            </>
          ) : null}
          {offline && phase !== "issued" ? (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>{copy.creditOffline}</Text>
            </View>
          ) : null}
          {visible && !eligible && visible.voided ? (
            <View style={styles.noticeBad}>
              <Text style={styles.noticeTitleBad}>{copy.creditVoided}</Text>
            </View>
          ) : null}
          {visible && !eligible && !visible.voided ? (
            <View style={styles.noticeBad}>
              <Text style={styles.noticeTitleBad}>{copy.creditIneligible}</Text>
            </View>
          ) : null}
          {banner && phase !== "issued" ? (
            <View style={styles.noticeBad}>
              <Text accessibilityLiveRegion="polite" style={styles.noticeTitleBad}>
                {banner}
              </Text>
            </View>
          ) : null}
          {phase === "entry" && visible && overLines.length === 0 && !allocationVisible && !visibleIssues.some((issue) => issue.field === "amount") ? (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>{copy.creditTaxNotice}</Text>
            </View>
          ) : null}
          {phase === "review" ? (
            <View style={styles.noticeWarn}>
              <Text style={styles.noticeTitleWarn}>{copy.creditConfirmTitle}</Text>
              <Text style={styles.noticeBody}>{copy.creditConfirmBody}</Text>
              <Text style={styles.noticeBody}>{copy.creditIrreversible}</Text>
            </View>
          ) : null}
          {phase === "issued" ? (
            <View style={issued?.pdf_state === "failed" ? styles.noticeBad : styles.notice}>
              <Text style={issued?.pdf_state === "failed" ? styles.noticeTitleBad : styles.noticeTitle}>
                {issued?.pdf_state === "failed"
                  ? copy.creditPdfFailedTitle
                  : issued?.pdf_state === "ready"
                    ? copy.invoiceDetailPdfReady
                    : copy.creditPdfTitle}
              </Text>
              <Text style={styles.noticeBody}>
                {issued?.pdf_state === "failed"
                  ? copy.creditPdfFailed
                  : issued?.pdf_state === "ready"
                    ? copy.creditImmutableBody
                    : copy.creditPdfBody}
              </Text>
            </View>
          ) : null}
          {overLines.length > 0 && phase === "entry" ? (
            <View style={styles.noticeBad}>
              <Text accessibilityLiveRegion="polite" style={styles.noticeTitleBad}>
                {overLines.length === 1 ? copy.creditOverOne : copy.creditOverMany}
              </Text>
            </View>
          ) : null}
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          {phase === "issued" ? (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  if (issued?.pdf_state === "ready" && pdfUrl) {
                    openCredit();
                    return;
                  }
                  void checkPdf();
                }}
                style={styles.primary}
              >
                <Text style={styles.primaryLabel}>{issued?.pdf_state === "ready" && pdfUrl ? copy.creditView : copy.creditCheckPdf}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={goBack} style={styles.secondaryQuiet}>
                <Text style={styles.secondaryLabel}>{copy.creditBackInvoice}</Text>
              </Pressable>
            </>
          ) : phase === "review" ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: saving, disabled: saving || offline }}
                disabled={saving || offline}
                onPress={() => void issue()}
                style={[styles.primary, saving || offline ? styles.primaryDisabled : null]}
              >
                <Text style={styles.primaryLabel}>{saving ? copy.creditIssuing : copy.creditIssue}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={saving} onPress={goBack} style={styles.secondaryQuiet}>
                <Text style={styles.secondaryLabel}>{copy.creditBackEdit}</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canReview || saving || offline || expired || !eligible, busy: saving }}
              disabled={saving || offline || expired || !eligible || !canReview}
              onPress={() => void review()}
              style={[styles.primary, !canReview || saving || offline || expired || !eligible ? styles.primaryDisabled : null]}
            >
              <Text style={styles.primaryLabel}>{saving ? copy.creditPreviewing : copy.creditReview}</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  atmosphere: {
    position: "absolute",
    top: -56,
    right: -40,
    width: 170,
    height: 170,
    borderRadius: 85,
    backgroundColor: "#E8F1FF",
    opacity: 0.62,
  },
  content: { paddingHorizontal: GUTTER, gap: 12, paddingTop: 16, paddingBottom: 24 },
  back: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "#DADFE8",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  backGlyph: { color: "#181F30", fontSize: 28, lineHeight: 32 },
  eyebrow: { color: PRIMARY, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  title: { color: "#181F30", fontSize: 27, lineHeight: 34, fontWeight: "700", marginTop: 4 },
  support: { color: "#5B6577", fontSize: type.body, lineHeight: 24, marginTop: 8 },
  card: { backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: "#DADFE8", padding: 16, gap: 8 },
  balanceCard: { backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: "#DADFE8", padding: 15, gap: 6 },
  invoiceNumber: { color: "#181F30", fontSize: 13, fontWeight: "700" },
  customer: { color: "#5B6577", fontSize: 12 },
  sectionLabel: { color: "#181F30", fontSize: 16, fontWeight: "700" },
  linesCard: { backgroundColor: colors.surface, borderRadius: 15, borderWidth: 1.5, paddingHorizontal: 13, paddingVertical: 8 },
  linesReady: { borderColor: PRIMARY },
  linesInvalid: { borderColor: "#B8373E" },
  lineRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 8 },
  lineCopy: { flex: 1, gap: 2 },
  lineTitle: { color: "#1A2138", fontSize: 13, fontWeight: "700" },
  remaining: { color: "#59637D", fontSize: 12 },
  lineInput: {
    width: 92,
    minHeight: 38,
    borderWidth: 1.3,
    borderColor: "#4A4F7D",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: "#1A2138",
    backgroundColor: colors.surface,
    fontSize: 13,
  },
  lineInputInvalid: { borderColor: "#E03338" },
  lineDivider: { height: 1, backgroundColor: "#DBE0EB" },
  divider: { height: 1, backgroundColor: "#DADFE8", marginVertical: 6 },
  balanceRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  kicker: { color: "#5B6577", fontSize: 10, fontWeight: "700", letterSpacing: 0.6, flex: 1 },
  balance: { color: PRIMARY, fontSize: 18, fontWeight: "700" },
  label: { color: "#181F30", fontSize: 12, fontWeight: "700", marginTop: 4 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: "#DADFE8",
    borderRadius: 15,
    paddingHorizontal: 13,
    paddingVertical: 12,
    color: "#181F30",
    backgroundColor: colors.surface,
    fontSize: 14,
  },
  inputInvalid: { borderColor: "#B8373E" },
  reason: { minHeight: 76, textAlignVertical: "top" },
  fieldError: { color: "#B8373E", fontSize: 14, lineHeight: 20 },
  summaryTitle: { color: "#181F30", fontSize: 16, fontWeight: "700" },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  summaryLabel: { flex: 1, color: "#5B6577", fontSize: 15 },
  summaryValue: { flex: 1, color: "#181F30", fontSize: 15, fontWeight: "600", textAlign: "right" },
  successCard: { backgroundColor: "#E6F9F4", borderRadius: 22, paddingVertical: 22, paddingHorizontal: 16, alignItems: "center", gap: 8 },
  successTitle: { color: "#181F30", fontSize: 18, fontWeight: "700", textAlign: "center" },
  successAmount: { color: PRIMARY, fontSize: 23, fontWeight: "700", textAlign: "center" },
  checkCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#1BB99A",
    alignItems: "center",
    justifyContent: "center",
  },
  checkCircleMark: { color: "#FFFFFF", fontSize: 30, fontWeight: "700" },
  statusGood: { color: "#1BB99A", fontSize: 12, fontWeight: "700" },
  statusRefund: { color: "#AD700F", fontSize: 12, fontWeight: "700" },
  notice: { backgroundColor: "#E8F1FF", borderRadius: 16, padding: 14, gap: 4 },
  noticeWarn: { backgroundColor: "#FFF7E0", borderRadius: 16, padding: 14, gap: 4 },
  noticeBad: { backgroundColor: "#FFECED", borderRadius: 16, padding: 14, gap: 8 },
  noticeTitle: { color: "#3874CB", fontSize: 13, fontWeight: "700" },
  noticeTitleWarn: { color: "#AD700F", fontSize: 13, fontWeight: "700" },
  noticeTitleBad: { color: "#B8373E", fontSize: 13, fontWeight: "700" },
  noticeBody: { color: "#5B6577", fontSize: 14, lineHeight: 20 },
  footer: { paddingHorizontal: GUTTER, gap: 10, paddingTop: 8 },
  primary: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: PRIMARY,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  primaryDisabled: { opacity: 0.45 },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "700", textAlign: "center" },
  secondaryQuiet: {
    minHeight: 56,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#DADFE8",
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  secondaryLabel: { color: PRIMARY, fontSize: 16, fontWeight: "700", textAlign: "center" },
});
