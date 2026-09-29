import {
  dollarsStringToCents,
  LEDGER_METHODS,
  LEDGER_NOTE_MAX,
  LEDGER_REFERENCE_MAX,
  parseOptionalBoundedText,
  type LedgerMethod,
} from "@job-to-invoice/schemas";

export const PAYMENT_METHODS = LEDGER_METHODS;

export type PaymentKind = "payment" | "refund";

export type PaymentField = "amount" | "date" | "method" | "reference" | "note";

export type PaymentIssueCode =
  | "required"
  | "zero"
  | "negative"
  | "invalid"
  | "limit"
  | "over_balance"
  | "over_refund"
  | "future"
  | "too_old";

export type PaymentIssue = { field: PaymentField; code: PaymentIssueCode };

export type PaymentDraft = {
  amount: string;
  date: string;
  method: string;
  reference: string;
  note: string;
  confirmOverpay: boolean;
};

export type LedgerCommandResult = {
  amount_cents: number;
  payment_status: string;
  balance_cents: number;
  amount_due_cents: number;
  amount_to_refund_cents: number;
};

const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

function isCalendarDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const utc = Date.UTC(year, month - 1, day);
  const reconstructed = new Date(utc);
  return (
    reconstructed.getUTCFullYear() === year &&
    reconstructed.getUTCMonth() + 1 === month &&
    reconstructed.getUTCDate() === day
  );
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function paymentEarliestDate(todayYmd: string): string | undefined {
  if (!isCalendarDate(todayYmd)) {
    return undefined;
  }
  const year = Number(todayYmd.slice(0, 4)) - 5;
  const month = Number(todayYmd.slice(5, 7));
  const day = Number(todayYmd.slice(8, 10));
  const clamped = Math.min(day, lastDayOfMonth(year, month));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

export function centsToAmountInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = String(Math.abs(cents % 100)).padStart(2, "0");
  return `${whole}.${frac}`;
}

export function paymentAmountCents(
  input: string,
): { ok: true; cents: number } | { ok: false; code: "required" | "zero" | "negative" | "invalid" | "limit" } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, code: "required" };
  }
  if (trimmed.startsWith("-")) {
    return { ok: false, code: "negative" };
  }
  const normalized = trimmed.replace(/[$,\s]/g, "");
  if (normalized === "0" || normalized === "0.0" || normalized === "0.00") {
    return { ok: false, code: "zero" };
  }
  const parsed = dollarsStringToCents(normalized);
  if (parsed.ok) {
    return parsed.value >= 1 ? { ok: true, cents: parsed.value } : { ok: false, code: "zero" };
  }
  if (/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(normalized)) {
    return { ok: false, code: "limit" };
  }
  return { ok: false, code: "invalid" };
}

export function paymentOutstandingCents(invoice: {
  amount_due_cents?: number;
  total_cents?: number;
} | undefined): number | undefined {
  if (!invoice) {
    return undefined;
  }
  if (Number.isInteger(invoice.amount_due_cents)) {
    return invoice.amount_due_cents;
  }
  if (Number.isInteger(invoice.total_cents)) {
    return invoice.total_cents;
  }
  return undefined;
}

export function paymentResultingCents(outstandingCents: number, amountCents: number): number {
  return outstandingCents - amountCents;
}

export function paymentDateIssue(date: string, todayYmd: string): "invalid" | "future" | "too_old" | undefined {
  if (!isCalendarDate(date)) {
    return "invalid";
  }
  if (!isCalendarDate(todayYmd)) {
    return "invalid";
  }
  if (date > todayYmd) {
    return "future";
  }
  const earliest = paymentEarliestDate(todayYmd);
  if (earliest && date < earliest) {
    return "too_old";
  }
  return undefined;
}

export function paymentMethodAccepted(method: string): method is LedgerMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(method);
}

function optionalTextIssue(value: string, max: number, multiline: boolean): "invalid" | undefined {
  const parsed = parseOptionalBoundedText(value, { min: 1, max, multiline });
  return parsed.ok ? undefined : "invalid";
}

export function paymentEntryIssues(input: {
  kind: PaymentKind;
  draft: PaymentDraft;
  outstandingCents: number | undefined;
  refundableCents: number | undefined;
  todayYmd: string;
}): PaymentIssue[] {
  const issues: PaymentIssue[] = [];
  const amount = paymentAmountCents(input.draft.amount);
  if (!amount.ok) {
    issues.push({ field: "amount", code: amount.code });
  } else if (input.kind === "payment") {
    if (!Number.isInteger(input.outstandingCents)) {
      issues.push({ field: "amount", code: "invalid" });
    } else if (amount.cents > (input.outstandingCents as number)) {
      issues.push({ field: "amount", code: "over_balance" });
    }
  } else if (!Number.isInteger(input.refundableCents) || amount.cents > (input.refundableCents as number)) {
    issues.push({ field: "amount", code: "over_refund" });
  }
  const dateIssue = paymentDateIssue(input.draft.date, input.todayYmd);
  if (dateIssue) {
    issues.push({ field: "date", code: dateIssue });
  }
  if (!paymentMethodAccepted(input.draft.method)) {
    issues.push({ field: "method", code: "invalid" });
  }
  if (optionalTextIssue(input.draft.reference, LEDGER_REFERENCE_MAX, false)) {
    issues.push({ field: "reference", code: "invalid" });
  }
  if (optionalTextIssue(input.draft.note, LEDGER_NOTE_MAX, true)) {
    issues.push({ field: "note", code: "invalid" });
  }
  return issues;
}

export function paymentReviewAllowed(input: {
  kind: PaymentKind;
  draft: PaymentDraft;
  outstandingCents: number | undefined;
  refundableCents: number | undefined;
  todayYmd: string;
  offline: boolean;
  eligible: boolean;
}): boolean {
  if (input.offline || !input.eligible) {
    return false;
  }
  const issues = paymentEntryIssues(input);
  return issues.every(
    (issue) => input.kind === "payment" && issue.field === "amount" && issue.code === "over_balance" && input.draft.confirmOverpay,
  );
}

export function paymentRequestBody(input: {
  kind: PaymentKind;
  draft: PaymentDraft;
  outstandingCents: number | undefined;
  refundableCents: number | undefined;
  todayYmd: string;
}): Record<string, unknown> | undefined {
  if (
    !paymentReviewAllowed({
      ...input,
      offline: false,
      eligible: true,
    })
  ) {
    return undefined;
  }
  const amount = paymentAmountCents(input.draft.amount);
  if (!amount.ok) {
    return undefined;
  }
  const reference = parseOptionalBoundedText(input.draft.reference, { min: 1, max: LEDGER_REFERENCE_MAX });
  const note = parseOptionalBoundedText(input.draft.note, { min: 1, max: LEDGER_NOTE_MAX, multiline: true });
  if (!reference.ok || !note.ok || !paymentMethodAccepted(input.draft.method)) {
    return undefined;
  }
  const overpay =
    input.kind === "payment" &&
    input.outstandingCents !== undefined &&
    amount.cents > input.outstandingCents;
  const body: Record<string, unknown> = {
    amount_cents: amount.cents,
    effective_date: input.draft.date,
    method: input.draft.method,
  };
  if (reference.value) {
    body.reference = reference.value;
  }
  if (note.value) {
    body.note = note.value;
  }
  if (input.kind === "payment") {
    body.confirm_overpayment = overpay && input.draft.confirmOverpay;
  }
  return body;
}

export function paymentInitialAmount(input: {
  kind: PaymentKind;
  current: string;
  dirty: boolean;
  prefillDue: boolean;
  amountDueCents?: number;
  amountToRefundCents?: number;
}): string {
  if (input.dirty || input.current.trim().length > 0) {
    return input.current;
  }
  if (
    input.kind === "refund" &&
    input.prefillDue &&
    Number.isInteger(input.amountToRefundCents) &&
    (input.amountToRefundCents ?? 0) > 0
  ) {
    return centsToAmountInput(input.amountToRefundCents as number);
  }
  if (input.kind === "payment" && input.prefillDue && Number.isInteger(input.amountDueCents)) {
    return centsToAmountInput(input.amountDueCents as number);
  }
  return input.current;
}

export function paymentIdempotencyAfterFailure(current: string | undefined, code?: string): string | undefined {
  if (code === "IDEMPOTENCY_MISMATCH") {
    return undefined;
  }
  return current;
}

export function paymentOutcome(
  ok: boolean,
  code?: string,
): "success" | "pending" | "rate" | "conflict" | "auth" | "invalid" | "retry" {
  if (ok) {
    return "success";
  }
  if (code === "OPERATION_PENDING") {
    return "pending";
  }
  if (code === "RATE_LIMITED") {
    return "rate";
  }
  if (code === "VERSION_CONFLICT" || code === "PREVIEW_CHANGED") {
    return "conflict";
  }
  if (code === "AUTHENTICATION_REQUIRED" || code === "AUTHENTICATION_FAILED") {
    return "auth";
  }
  if (code === "VALIDATION_FAILED") {
    return "invalid";
  }
  return "retry";
}

export function paymentRecordedResult(data: unknown): LedgerCommandResult | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const row = data as Record<string, unknown>;
  const amount = row.amount_cents;
  const due = row.amount_due_cents;
  const refund = row.amount_to_refund_cents;
  const balance = row.balance_cents;
  const status = row.payment_status;
  if (!Number.isInteger(amount) || (amount as number) < 1) {
    return undefined;
  }
  if (!Number.isInteger(due) || !Number.isInteger(refund) || !Number.isInteger(balance)) {
    return undefined;
  }
  if (typeof status !== "string" || status.length === 0 || status.length > 40) {
    return undefined;
  }
  return {
    amount_cents: amount as number,
    payment_status: status,
    balance_cents: balance as number,
    amount_due_cents: due as number,
    amount_to_refund_cents: refund as number,
  };
}

export function paymentImpliesPaidInFull(serverStatus?: string): boolean {
  return serverStatus === "settled";
}

export function paymentImpliesPartial(serverStatus?: string): boolean {
  return serverStatus === "partially_paid";
}

const LEDGER_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function formatLedgerDisplayDate(ymd: string): string {
  if (paymentDateIssue(ymd, ymd)) {
    return ymd;
  }
  const month = Number(ymd.slice(5, 7));
  const day = Number(ymd.slice(8, 10));
  return `${LEDGER_MONTHS[month - 1]} ${day}, ${ymd.slice(0, 4)}`;
}

export function refundRecordedPhase(amountToRefundCents: number): "partial" | "full" | undefined {
  if (!Number.isInteger(amountToRefundCents) || amountToRefundCents < 0) {
    return undefined;
  }
  return amountToRefundCents === 0 ? "full" : "partial";
}

export function refundEligible(invoice: {
  lifecycle?: string;
  voided?: boolean;
  amount_to_refund_cents?: number;
} | undefined): boolean {
  if (paymentBlockedReason(invoice)) {
    return false;
  }
  return Number.isInteger(invoice?.amount_to_refund_cents) && (invoice?.amount_to_refund_cents as number) > 0;
}

export function ledgerEntryTarget(kind: "payment" | "refund" | "reversal"): "payments" | "refunds" | "reversals" {
  if (kind === "refund") {
    return "refunds";
  }
  if (kind === "reversal") {
    return "reversals";
  }
  return "payments";
}

export function paymentRequiresRefresh(reviewedDueCents: number, latestDueCents: number): boolean {
  return reviewedDueCents !== latestDueCents;
}

export function paymentAfterBalanceConflict(): { phase: "entry"; confirmOverpay: false } {
  return { phase: "entry", confirmOverpay: false };
}

export function paymentShouldSubmit(phase: "entry" | "review" | "recorded", saving: boolean): boolean {
  return phase === "review" && !saving;
}

export function paymentRecordedNavigation(action: "view_invoice" | "back_to_job" | "back"): "s16" | "s08" {
  return action === "back_to_job" ? "s08" : "s16";
}

export function paymentBlockedReason(invoice: { lifecycle?: string; voided?: boolean } | undefined): "voided" | "ineligible" | undefined {
  if (!invoice) {
    return "ineligible";
  }
  if (invoice.voided || invoice.lifecycle === "voided") {
    return "voided";
  }
  if (invoice.lifecycle !== "issued") {
    return "ineligible";
  }
  return undefined;
}

export function paymentLoadKind(status: number, code?: string): "not_found" | "unauthorized" | "rate" | "error" {
  if (status === 404 || code === "NOT_FOUND") {
    return "not_found";
  }
  if (status === 401 || status === 403 || code === "AUTHENTICATION_REQUIRED" || code === "AUTHENTICATION_FAILED") {
    return "unauthorized";
  }
  if (status === 429 || code === "RATE_LIMITED") {
    return "rate";
  }
  return "error";
}

export function paymentCommercialVisible<T>(authStatus: string, invoice?: T): T | undefined {
  if (authStatus === "access_expired") {
    return undefined;
  }
  return invoice;
}

export function paymentAfterRefresh<T>(previous: T | undefined, next: T | undefined, failed: boolean): T | undefined {
  if (failed) {
    return previous;
  }
  return next ?? previous;
}

export function paymentAnalyticsProperties(): Record<string, never> {
  return {};
}

export function paymentSafeSnapshot(input: { phase: string; offline: boolean; outcome?: string }): {
  phase: string;
  offline: boolean;
  outcome?: string;
} {
  const snapshot: { phase: string; offline: boolean; outcome?: string } = {
    phase: input.phase,
    offline: input.offline,
  };
  if (input.outcome) {
    snapshot.outcome = input.outcome;
  }
  return snapshot;
}
