import { formatUsdCents, type LedgerMethod } from "@job-to-invoice/schemas";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
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
import { copy } from "../../../../../src/i18n/en.ts";
import { presentInvoiceStatus, type IssuedInvoiceRecord } from "../../../../../src/invoices/presentation.ts";
import {
  PAYMENT_METHODS,
  paymentAfterBalanceConflict,
  paymentAfterRefresh,
  paymentAmountCents,
  paymentBlockedReason,
  paymentCommercialVisible,
  formatLedgerDisplayDate,
  paymentEntryIssues,
  paymentIdempotencyAfterFailure,
  paymentImpliesPaidInFull,
  paymentImpliesPartial,
  paymentInitialAmount,
  paymentLoadKind,
  paymentOutcome,
  paymentOutstandingCents,
  paymentRecordedNavigation,
  paymentRecordedResult,
  paymentRequestBody,
  paymentRequiresRefresh,
  paymentResultingCents,
  refundRecordedPhase,
  paymentReviewAllowed,
  paymentShouldSubmit,
  type PaymentDraft,
  type PaymentIssue,
  type LedgerCommandResult,
} from "../../../../../src/invoices/payment.ts";
import { jobDetailPath, jobInvoiceDetailPath } from "../../../../../src/jobs/routes.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../../src/session/AuthProvider.tsx";
import { colors, type } from "../../../../../src/theme.ts";

const PRIMARY = "#464B71";
const GUTTER = 20;

const METHOD_LABELS: Record<LedgerMethod, string> = {
  cash: copy.ledgerMethodCash,
  check: copy.ledgerMethodCheck,
  bank_transfer: copy.ledgerMethodBank,
  external_card: copy.ledgerMethodCard,
  other: copy.ledgerMethodOther,
};

function todayYmd(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function firstParam(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  return Array.isArray(value) ? (value[0] ?? "") : "";
}

function issueMessage(issue: PaymentIssue, kind: "payment" | "refund"): string {
  if (issue.field === "date") {
    if (issue.code === "future") {
      return copy.paymentDateFuture;
    }
    if (issue.code === "too_old") {
      return copy.paymentDateOld;
    }
    return copy.paymentDateInvalid;
  }
  if (issue.field === "method") {
    return copy.paymentMethodRequired;
  }
  if (issue.field === "reference") {
    return copy.paymentReferenceInvalid;
  }
  if (issue.field === "note") {
    return copy.paymentNoteInvalid;
  }
  if (issue.code === "over_balance") {
    return copy.paymentOverBalance;
  }
  if (issue.code === "over_refund") {
    return copy.refundOverBalance;
  }
  if (issue.code === "required") {
    return kind === "refund" ? copy.paymentZero : copy.paymentAmountRequired;
  }
  if (issue.code === "zero" || issue.code === "negative") {
    return copy.paymentZero;
  }
  if (issue.code === "limit") {
    return copy.paymentAmountLimit;
  }
  return copy.paymentAmountInvalid;
}

export default function LedgerEntryScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    id?: string | string[];
    invoiceId?: string | string[];
    kind?: string | string[];
    prefill?: string | string[];
  }>();
  const jobId = firstParam(params.id);
  const invoiceId = firstParam(params.invoiceId);
  const kind = firstParam(params.kind) === "refund" ? "refund" : "payment";
  const prefillDue = firstParam(params.prefill) === "due";
  const [invoice, setInvoice] = useState<IssuedInvoiceRecord | undefined>();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayYmd);
  const [method, setMethod] = useState<LedgerMethod>("cash");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [confirmOverpay, setConfirmOverpay] = useState(false);
  const [phase, setPhase] = useState<"entry" | "review" | "recorded">("entry");
  const [recorded, setRecorded] = useState<LedgerCommandResult | undefined>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<string | undefined>();
  const [loadIssue, setLoadIssue] = useState<"not_found" | "unauthorized" | "rate" | "error" | undefined>();
  const [attempted, setAttempted] = useState(false);
  const [methodsOpen, setMethodsOpen] = useState(false);
  const amountDirty = useRef(false);
  const phaseRef = useRef(phase);
  const reviewedDue = useRef<number | undefined>(undefined);
  const submitLock = useRef(false);
  const goBackRef = useRef<() => void>(() => undefined);
  const amountRef = useRef<TextInput>(null);
  const key = useRef<string | undefined>(undefined);
  phaseRef.current = phase;
  const offline = auth.snapshot.status === "offline_cached";
  const expired = auth.snapshot.status === "access_expired";
  const visible = paymentCommercialVisible(auth.snapshot.status, invoice);

  useEffect(() => {
    if (!expired) {
      return;
    }
    setInvoice(undefined);
    setAmount("");
    setReference("");
    setNote("");
    setRecorded(undefined);
    setPhase("entry");
    setBanner(undefined);
    amountDirty.current = false;
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
    const result = await runOwnerRequest<IssuedInvoiceRecord>({ path: `/v1/invoices/${invoiceId}/ledger` });
    if (result.ok) {
      setInvoice((previous) => paymentAfterRefresh(previous, result.data, false));
      setLoadIssue(undefined);
      setBanner(undefined);
      setAmount((current) =>
        paymentInitialAmount({
          kind,
          current,
          dirty: amountDirty.current,
          prefillDue,
          amountDueCents: result.data.amount_due_cents,
          amountToRefundCents: result.data.amount_to_refund_cents,
        }),
      );
      if (phaseRef.current === "review") {
        const latest = kind === "refund" ? result.data.amount_to_refund_cents : paymentOutstandingCents(result.data);
        if (
          reviewedDue.current !== undefined &&
          Number.isInteger(latest) &&
          paymentRequiresRefresh(reviewedDue.current, latest as number)
        ) {
          const next = paymentAfterBalanceConflict();
          setPhase(next.phase);
          setConfirmOverpay(next.confirmOverpay);
          setBanner(copy.paymentConflict);
        }
      }
    } else {
      const issue = paymentLoadKind(result.error.status, result.error.code);
      setLoadIssue(issue);
      if (issue === "not_found" || issue === "unauthorized") {
        setInvoice(undefined);
        setAmount("");
        setReference("");
        setNote("");
      }
      setBanner(result.error.message || copy.ledgerError);
    }
    setLoading(false);
  }, [expired, invoiceId, kind, prefillDue, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      if (phaseRef.current === "recorded") {
        return;
      }
      void load();
    }, [load]),
  );

  const draft: PaymentDraft = { amount, date, method, reference, note, confirmOverpay };
  const outstanding = paymentOutstandingCents(visible);
  const refundable = Number.isInteger(visible?.amount_to_refund_cents) ? visible?.amount_to_refund_cents : undefined;
  const blocked = visible ? paymentBlockedReason(visible) : undefined;
  const refundBlocked = kind === "refund" && (refundable ?? 0) <= 0;
  const eligible = Boolean(visible) && !blocked && !refundBlocked;
  const issues = visible
    ? paymentEntryIssues({ kind, draft, outstandingCents: outstanding, refundableCents: refundable, todayYmd: todayYmd() })
    : [];
  const canReview = paymentReviewAllowed({
    kind,
    draft,
    outstandingCents: outstanding,
    refundableCents: refundable,
    todayYmd: todayYmd(),
    offline: offline || expired || auth.snapshot.status !== "authenticated",
    eligible,
  });
  const overpay = issues.some((issue) => issue.code === "over_balance");
  const visibleIssues = issues.filter((issue) => issue.code !== "required" || attempted);
  const amountIssue = visibleIssues.find((issue) => issue.field === "amount");
  const dateIssue = visibleIssues.find((issue) => issue.field === "date");
  const referenceIssue = visibleIssues.find((issue) => issue.field === "reference");
  const noteIssue = visibleIssues.find((issue) => issue.field === "note");
  const parsed = paymentAmountCents(amount);
  const resulting =
    outstanding !== undefined && parsed.ok ? paymentResultingCents(outstanding, parsed.cents) : undefined;

  function leaveToInvoice() {
    if (!invoiceId || paymentRecordedNavigation("view_invoice") !== "s16") {
      return;
    }
    router.replace(jobInvoiceDetailPath(jobId, invoiceId));
  }

  function leaveToJob() {
    if (paymentRecordedNavigation("back_to_job") !== "s08") {
      return;
    }
    router.replace(jobDetailPath(jobId));
  }

  function backToEditing() {
    setPhase("entry");
    setMethodsOpen(false);
    requestAnimationFrame(() => amountRef.current?.focus());
  }

  function goBack() {
    if (saving) {
      return;
    }
    if (methodsOpen) {
      setMethodsOpen(false);
      return;
    }
    if (phase === "review") {
      backToEditing();
      return;
    }
    if (phase === "recorded") {
      leaveToInvoice();
      return;
    }
    if (invoiceId) {
      router.replace(jobInvoiceDetailPath(jobId, invoiceId));
      return;
    }
    router.replace(jobDetailPath(jobId));
  }

  goBackRef.current = goBack;

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (submitLock.current) {
        return true;
      }
      goBackRef.current();
      return true;
    });
    return () => subscription.remove();
  }, []);

  function review() {
    setAttempted(true);
    if (!canReview || !visible) {
      return;
    }
    const basis = kind === "refund" ? refundable : outstanding;
    if (!Number.isInteger(basis)) {
      return;
    }
    reviewedDue.current = basis as number;
    setPhase("review");
    setBanner(undefined);
  }

  async function record() {
    if (!paymentShouldSubmit(phaseRef.current, submitLock.current) || !invoiceId || !visible) {
      return;
    }
    const body = paymentRequestBody({
      kind,
      draft,
      outstandingCents: outstanding,
      refundableCents: refundable,
      todayYmd: todayYmd(),
    });
    if (!body) {
      return;
    }
    submitLock.current = true;
    setSaving(true);
    setBanner(undefined);
    const fresh = await runOwnerRequest<IssuedInvoiceRecord>({ path: `/v1/invoices/${invoiceId}/ledger` });
    if (!fresh.ok) {
      const outcome = paymentOutcome(false, fresh.error.code);
      if (outcome === "auth") {
        setInvoice(undefined);
        setAmount("");
        setReference("");
        setNote("");
        setPhase("entry");
      }
      setBanner(fresh.error.message || copy.ledgerError);
      submitLock.current = false;
      setSaving(false);
      return;
    }
    const latest = kind === "refund" ? fresh.data.amount_to_refund_cents : paymentOutstandingCents(fresh.data);
    if (
      reviewedDue.current === undefined ||
      !Number.isInteger(latest) ||
      paymentRequiresRefresh(reviewedDue.current, latest as number)
    ) {
      setInvoice(fresh.data);
      const next = paymentAfterBalanceConflict();
      setPhase(next.phase);
      setConfirmOverpay(next.confirmOverpay);
      setBanner(copy.paymentConflict);
      submitLock.current = false;
      setSaving(false);
      return;
    }
    key.current = retainOrCreateSetupIdempotencyKey(key.current);
    const result = await runOwnerRequest({
      path: kind === "refund" ? `/v1/invoices/${invoiceId}/refunds` : `/v1/invoices/${invoiceId}/payments`,
      method: "POST",
      idempotencyKey: key.current,
      body,
    });
    if (!result.ok) {
      const retained = paymentIdempotencyAfterFailure(key.current, result.error.code);
      key.current = retained === undefined ? retainOrCreateSetupIdempotencyKey(undefined) : retained;
      const outcome = paymentOutcome(false, result.error.code);
      if (outcome === "auth") {
        setInvoice(undefined);
        setAmount("");
        setReference("");
        setNote("");
        setRecorded(undefined);
        setPhase("entry");
      } else if (outcome === "conflict" || outcome === "invalid") {
        const next = paymentAfterBalanceConflict();
        setPhase(next.phase);
        setConfirmOverpay(next.confirmOverpay);
      }
      setBanner(
        outcome === "pending"
          ? copy.paymentPending
          : outcome === "conflict"
            ? copy.paymentConflict
            : result.error.message || copy.ledgerError,
      );
      submitLock.current = false;
      setSaving(false);
      return;
    }
    const confirmed = paymentRecordedResult(result.data);
    if (!confirmed) {
      setBanner(copy.ledgerError);
      setPhase("entry");
      submitLock.current = false;
      setSaving(false);
      return;
    }
    setRecorded(confirmed);
    setInvoice((current) =>
      current
        ? {
            ...current,
            payment_status: confirmed.payment_status,
            amount_due_cents: confirmed.amount_due_cents,
            amount_to_refund_cents: confirmed.amount_to_refund_cents,
            balance_cents: confirmed.balance_cents,
          }
        : current,
    );
    setPhase("recorded");
    key.current = undefined;
    submitLock.current = false;
    setSaving(false);
  }

  const customerName = visible?.snapshot.customer.name?.trim() ?? "";
  const refundPhase = recorded ? refundRecordedPhase(recorded.amount_to_refund_cents) : undefined;
  const heading =
    phase === "recorded"
      ? kind === "refund"
        ? copy.paymentRefundRecorded
        : copy.paymentRecorded
      : phase === "review" && kind === "refund"
        ? copy.paymentRefundReview
        : kind === "refund"
          ? copy.ledgerRefundTitle
          : copy.paymentHeading;
  const support =
    phase === "recorded"
      ? kind === "refund"
        ? copy.paymentRefundRecordedBody
        : copy.paymentRecordedBody
      : phase === "review"
        ? kind === "refund"
          ? copy.refundReviewSupport
          : copy.paymentReviewSupport
        : kind === "refund"
          ? copy.refundSupport
          : copy.paymentSupport;
  const shownBalance = kind === "refund" && refundable !== undefined ? refundable : outstanding;
  const refundResult =
    kind === "refund" && refundable !== undefined && parsed.ok ? refundable - parsed.cents : undefined;

  return (
    <View style={styles.screen}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <View style={{ paddingTop: insets.top + 8, paddingHorizontal: GUTTER }}>
          <Pressable
            accessibilityLabel={copy.back}
            accessibilityRole="button"
            onPress={goBack}
            style={styles.back}
          >
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
          <Text style={styles.eyebrow}>{kind === "refund" ? copy.paymentRefundEyebrow : copy.paymentEyebrow}</Text>
          <Text accessibilityRole="header" style={styles.title}>
            {heading}
          </Text>
          <Text style={styles.support}>{support}</Text>
        </View>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: 24 }]}
          keyboardShouldPersistTaps="handled"
        >
          {loading && !visible ? (
            <View accessibilityLabel={copy.ledgerSaving} style={styles.card}>
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
                {loadIssue === "not_found" ? copy.jobNotFound : loadIssue === "unauthorized" ? copy.accessExpired : copy.ledgerError}
              </Text>
              {loadIssue === "error" || loadIssue === "rate" ? (
                <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{copy.paymentRefresh}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {visible && phase !== "recorded" ? (
            <View style={styles.balanceCard}>
              <Text style={styles.invoiceNumber}>
                {visible.number ? `${copy.invoiceDetailName} ${visible.number}` : copy.invoiceIssueTitle}
              </Text>
              {customerName ? <Text style={styles.customer}>{customerName}</Text> : null}
              <View style={styles.divider} />
              <View style={styles.balanceRow}>
                <Text style={styles.kicker}>{kind === "refund" ? copy.refundableLabel : copy.paymentOutstanding}</Text>
                <Text
                  accessibilityLabel={`${kind === "refund" ? copy.refundableLabel : copy.paymentOutstanding} ${
                    shownBalance !== undefined ? formatUsdCents(shownBalance) : ""
                  }`}
                  style={styles.balance}
                >
                  {shownBalance !== undefined ? formatUsdCents(shownBalance) : ""}
                </Text>
              </View>
            </View>
          ) : null}
          {visible && phase === "entry" ? (
            <View style={styles.card}>
              <Text style={styles.label}>{kind === "refund" ? copy.refundAmount : copy.paymentAmount}</Text>
              <TextInput
                ref={amountRef}
                accessibilityLabel={kind === "refund" ? copy.refundAmountHint : copy.paymentAmountHint}
                autoCorrect={false}
                keyboardType="decimal-pad"
                onChangeText={(value) => {
                  amountDirty.current = true;
                  setAmount(value);
                  if (confirmOverpay) {
                    setConfirmOverpay(false);
                  }
                }}
                style={[styles.input, amountIssue ? styles.inputInvalid : styles.inputReady]}
                value={amount}
              />
              {amountIssue ? (
                <Text accessibilityLiveRegion="polite" style={styles.fieldError}>
                  {issueMessage(amountIssue, kind)}
                </Text>
              ) : null}
              <Text style={styles.label}>{kind === "refund" ? copy.refundDate : copy.ledgerDate}</Text>
              <View style={[styles.field, dateIssue ? styles.inputInvalid : null]}>
                <TextInput
                  accessibilityLabel={kind === "refund" ? copy.refundDate : copy.ledgerDate}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setDate}
                  style={styles.fieldInput}
                  value={date}
                />
                <Text style={styles.chevron}>⌄</Text>
              </View>
              {dateIssue ? <Text style={styles.fieldError}>{issueMessage(dateIssue, kind)}</Text> : null}
              <Text style={styles.label}>{kind === "refund" ? copy.refundMethod : copy.ledgerMethod}</Text>
              <Pressable
                accessibilityLabel={kind === "refund" ? copy.refundMethod : copy.ledgerMethod}
                accessibilityRole="button"
                onPress={() => setMethodsOpen(true)}
                style={styles.field}
              >
                <Text style={styles.inputValue}>{METHOD_LABELS[method]}</Text>
                <Text style={styles.chevron}>⌄</Text>
              </Pressable>
              <Text style={styles.label}>{copy.ledgerReference}</Text>
              <TextInput
                accessibilityLabel={copy.ledgerReference}
                autoCorrect={false}
                onChangeText={setReference}
                style={[styles.input, referenceIssue ? styles.inputInvalid : null]}
                value={reference}
              />
              {referenceIssue ? <Text style={styles.fieldError}>{issueMessage(referenceIssue, kind)}</Text> : null}
              <Text style={styles.label}>{copy.ledgerNote}</Text>
              <TextInput
                accessibilityLabel={copy.ledgerNote}
                multiline
                onChangeText={setNote}
                style={[styles.input, styles.note, noteIssue ? styles.inputInvalid : null]}
                value={note}
              />
              {noteIssue ? <Text style={styles.fieldError}>{issueMessage(noteIssue, kind)}</Text> : null}
              {overpay ? (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: confirmOverpay }}
                  onPress={() => setConfirmOverpay((current) => !current)}
                  style={styles.checkRow}
                >
                  <View style={[styles.check, confirmOverpay ? styles.checkOn : null]}>
                    {confirmOverpay ? <Text style={styles.checkMark}>✓</Text> : null}
                  </View>
                  <Text style={styles.checkLabel}>{copy.ledgerOverpayConfirm}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {visible && phase === "review" ? (
            <View accessibilityLiveRegion="polite" style={styles.card}>
              <Text style={styles.summaryTitle}>{kind === "refund" ? copy.refundSummary : copy.paymentSummary}</Text>
              <SummaryRow
                label={kind === "refund" ? copy.refundAmountRow : copy.paymentAmount}
                value={parsed.ok ? formatUsdCents(parsed.cents) : ""}
              />
              <SummaryRow
                label={kind === "refund" ? copy.refundDateRow : copy.ledgerDate}
                value={kind === "refund" ? formatLedgerDisplayDate(date) : date}
              />
              <SummaryRow
                label={kind === "refund" ? copy.refundMethodRow : copy.ledgerMethod}
                value={METHOD_LABELS[method]}
              />
              {reference.trim() ? (
                <SummaryRow label={kind === "refund" ? copy.refundReferenceRow : copy.ledgerReference} value={reference.trim()} />
              ) : null}
              {note.trim() ? <SummaryRow label={copy.ledgerNote} value={note.trim()} /> : null}
              {kind === "payment" && outstanding !== undefined ? (
                <SummaryRow label={copy.paymentOutstanding} value={formatUsdCents(outstanding)} />
              ) : null}
              {kind === "refund" && refundResult !== undefined && refundResult >= 0 ? (
                <SummaryRow label={copy.refundResulting} value={formatUsdCents(refundResult)} />
              ) : null}
              {kind === "payment" && resulting !== undefined ? (
                <SummaryRow label={copy.paymentRemaining} value={formatUsdCents(resulting)} />
              ) : null}
            </View>
          ) : null}
          {visible && phase === "recorded" && recorded ? (
            <>
              <View accessibilityLiveRegion="polite" style={styles.successCard}>
                <View style={styles.checkCircle}>
                  <Text style={styles.checkCircleMark}>✓</Text>
                </View>
                <Text style={styles.successTitle}>{kind === "refund" ? copy.paymentRefundRecorded : copy.paymentRecorded}</Text>
                <Text style={styles.successAmount}>{formatUsdCents(recorded.amount_cents)}</Text>
              </View>
              <View style={styles.balanceCard}>
                <Text style={styles.invoiceNumber}>
                  {visible.number ? `${copy.invoiceDetailName} ${visible.number}` : copy.invoiceIssueTitle}
                </Text>
                <Text style={kind === "refund" ? (refundPhase ? styles.statusGood : styles.status) : paymentImpliesPaidInFull(recorded.payment_status) || paymentImpliesPartial(recorded.payment_status) ? styles.statusGood : styles.status}>
                  {kind === "refund"
                    ? refundPhase === "full"
                      ? copy.refundFull
                      : refundPhase === "partial"
                        ? copy.refundPartial
                        : presentInvoiceStatus(recorded.payment_status, false)
                    : paymentImpliesPaidInFull(recorded.payment_status)
                      ? copy.paymentPaidInFull
                      : paymentImpliesPartial(recorded.payment_status)
                        ? copy.invoiceStatusPartial
                        : presentInvoiceStatus(recorded.payment_status, false)}
                </Text>
                <View style={styles.divider} />
                <View style={styles.balanceRow}>
                  <Text style={styles.kicker}>{kind === "refund" ? copy.refundRemaining : copy.paymentRemaining}</Text>
                  <Text style={styles.balance}>
                    {formatUsdCents(kind === "refund" ? recorded.amount_to_refund_cents : recorded.balance_cents)}
                  </Text>
                </View>
              </View>
            </>
          ) : null}
          {offline && phase !== "recorded" ? (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>{copy.ledgerOffline}</Text>
            </View>
          ) : null}
          {blocked === "voided" ? (
            <View style={styles.noticeBad}>
              <Text style={styles.noticeTitleBad}>{kind === "refund" ? copy.refundVoided : copy.paymentVoided}</Text>
            </View>
          ) : null}
          {blocked === "ineligible" && visible ? (
            <View style={styles.noticeBad}>
              <Text style={styles.noticeTitleBad}>{kind === "refund" ? copy.refundIneligible : copy.paymentIneligible}</Text>
            </View>
          ) : null}
          {refundBlocked && visible ? (
            <View style={styles.noticeBad}>
              <Text style={styles.noticeTitleBad}>{copy.ledgerRefundBlocked}</Text>
            </View>
          ) : null}
          {banner && phase !== "recorded" ? (
            <View style={styles.noticeBad}>
              <Text accessibilityLiveRegion="polite" style={styles.noticeTitleBad}>
                {banner}
              </Text>
            </View>
          ) : null}
          {phase === "entry" && visible && !amountIssue ? (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>{copy.paymentManual}</Text>
              <Text style={styles.noticeBody}>{kind === "refund" ? copy.ledgerRefundWarning : copy.ledgerWarning}</Text>
            </View>
          ) : null}
          {phase === "review" ? (
            <View style={kind === "refund" ? styles.noticeWarn : styles.notice}>
              <Text style={kind === "refund" ? styles.noticeTitleWarn : styles.noticeTitle}>{copy.paymentConfirmTitle}</Text>
              <Text style={styles.noticeBody}>{kind === "refund" ? copy.refundConfirmBody : copy.paymentConfirmBody}</Text>
            </View>
          ) : null}
          {phase === "recorded" ? (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>{copy.paymentSaved}</Text>
              <Text style={styles.noticeBody}>{kind === "refund" ? copy.refundSavedBody : copy.paymentSavedBody}</Text>
            </View>
          ) : null}
          {amountIssue && phase === "entry" ? (
            <View style={styles.noticeBad}>
              <Text style={styles.noticeTitleBad}>{copy.paymentCheckAmount}</Text>
            </View>
          ) : null}
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          {phase === "recorded" ? (
            <>
              <Pressable accessibilityRole="button" onPress={leaveToInvoice} style={styles.primary}>
                <Text style={styles.primaryLabel}>{copy.paymentViewInvoice}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={leaveToJob} style={kind === "refund" ? styles.secondaryQuiet : styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.invoiceBackToJob}</Text>
              </Pressable>
            </>
          ) : phase === "review" ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: saving, disabled: saving || offline }}
                disabled={saving || offline}
                onPress={() => void record()}
                style={[styles.primary, saving || offline ? styles.primaryDisabled : null]}
              >
                <Text style={styles.primaryLabel}>{saving ? copy.ledgerSaving : kind === "refund" ? copy.invoiceRecordRefund : copy.paymentHeading}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={saving} onPress={backToEditing} style={kind === "refund" ? styles.secondaryQuiet : styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.paymentBackEdit}</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canReview }}
              onPress={review}
              style={[styles.primary, !canReview ? styles.primaryDisabled : null]}
            >
              <Text style={styles.primaryLabel}>{kind === "refund" ? copy.paymentRefundReview : copy.paymentReview}</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
      <Modal animationType="fade" onRequestClose={() => setMethodsOpen(false)} transparent visible={methodsOpen}>
        <Pressable accessibilityRole="button" onPress={() => setMethodsOpen(false)} style={styles.scrim}>
          <View style={styles.sheet}>
            {PAYMENT_METHODS.map((id) => (
              <Pressable
                accessibilityRole="button"
                key={id}
                onPress={() => {
                  setMethod(id);
                  setMethodsOpen(false);
                }}
                style={styles.sheetRow}
              >
                <Text style={styles.sheetLabel}>{METHOD_LABELS[id]}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
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
  content: { paddingHorizontal: GUTTER, gap: 12, paddingTop: 16 },
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
  divider: { height: 1, backgroundColor: "#DADFE8", marginVertical: 6 },
  balanceRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  kicker: { color: "#5B6577", fontSize: 10, fontWeight: "700", letterSpacing: 0.6 },
  balance: { color: PRIMARY, fontSize: 18, fontWeight: "700" },
  label: { color: "#181F30", fontSize: 12, fontWeight: "700", marginTop: 4 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: "#DADFE8",
    borderRadius: 15,
    paddingHorizontal: 13,
    paddingVertical: 14,
    color: "#181F30",
    backgroundColor: colors.surface,
    fontSize: 14,
  },
  inputReady: { borderColor: PRIMARY, borderWidth: 1.5 },
  inputInvalid: { borderColor: "#B8373E" },
  field: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: "#DADFE8",
    borderRadius: 15,
    paddingHorizontal: 13,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  fieldInput: { flex: 1, color: "#181F30", fontSize: 14, paddingVertical: 14 },
  chevron: { color: "#5B6577", fontSize: 18, fontWeight: "700" },
  inputValue: { flex: 1, color: "#181F30", fontSize: 14 },
  note: { minHeight: 88, textAlignVertical: "top" },
  fieldError: { color: "#B8373E", fontSize: 14, lineHeight: 20 },
  checkRow: { flexDirection: "row", gap: 12, alignItems: "flex-start", marginTop: 8, minHeight: 44 },
  check: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#DADFE8",
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  checkMark: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  checkLabel: { flex: 1, color: "#181F30", fontSize: 15, lineHeight: 22 },
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
  status: { color: "#5B6577", fontSize: 12, fontWeight: "700" },
  statusGood: { color: "#1BB99A", fontSize: 12, fontWeight: "700" },
  notice: { backgroundColor: "#E8F1FF", borderRadius: 16, padding: 14, gap: 4 },
  noticeBad: { backgroundColor: "#FFECED", borderRadius: 16, padding: 14, gap: 4 },
  noticeWarn: { backgroundColor: "#FFF7E0", borderRadius: 16, padding: 14, gap: 4 },
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
  secondary: {
    minHeight: 56,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: PRIMARY,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
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
  scrim: { flex: 1, backgroundColor: "rgba(23, 33, 43, 0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, gap: 8 },
  sheetRow: { minHeight: 48, justifyContent: "center" },
  sheetLabel: { color: "#181F30", fontSize: type.body },
});
