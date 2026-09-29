import {
  addCalendarDays,
  documentRevisionLabel,
  maskEmail,
  parseInvoiceVoid,
  parseOwnerEmail,
  unresolvedInvoiceMessage,
} from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import { jobChangePath } from "../jobs/routes.ts";

export type InvoicePreviewRecord = {
  draft_id: string;
  job_id: string;
  version: number;
  preview_hash: string;
  preview_expires_at: string;
  schema_version: number;
  number_label: string;
  snapshot: {
    business: { business_name: string };
    customer: { name: string; email?: string | null };
    job: { title: string };
    payment_instructions: string;
    issue_date: string;
    due_date: string;
    lines: Array<{
      position: number;
      description: string;
      quantity: string;
      unit: string;
      net_cents: number;
      tax_cents: number;
      total_cents: number;
      discount_cents?: number;
    }>;
    net_cents: number;
    tax_cents: number;
    total_cents: number;
    currency: string;
    origin?: "quote_based" | "direct";
    no_prior_approval?: boolean;
  };
};

export type IssuedInvoiceRecord = {
  id: string;
  job_id: string;
  number: string;
  revision_label: string;
  issued_at?: string;
  lifecycle: string;
  pdf_state: string;
  delivery_state: string | null;
  payment_status: string;
  due_date: string;
  snapshot: InvoicePreviewRecord["snapshot"];
  net_cents: number;
  tax_cents: number;
  total_cents: number;
  credits_cents?: number;
  effective_payments_cents?: number;
  effective_refunds_cents?: number;
  net_received_cents?: number;
  balance_cents?: number;
  amount_due_cents?: number;
  amount_to_refund_cents?: number;
  recorded_by?: string;
  entries?: Array<{
    id: string;
    type: string;
    amount_cents: number;
    effective_date: string;
    method: string | null;
    reverses_entry_id: string | null;
  }>;
  credit_sources?: Array<{
    invoice_line_id: string;
    description: string;
    residual_net_cents: number;
    residual_tax_cents: number;
    credited_net_cents: number;
    remaining_net_cents: number;
  }>;
  voided?: boolean;
  void_reason?: string | null;
};

export type InvoicePreviewKind =
  | "loading"
  | "error"
  | "offline"
  | "access_expired"
  | "empty"
  | "ready"
  | "confirming"
  | "issuing"
  | "conflict"
  | "unresolved";

function isInProgressChangeDraft(input: {
  changeDraft?: { id: string; additions_count?: number; reductions_count?: number } | null;
  latestChange?: { lifecycle?: string; request_state: string | null } | null;
}): boolean {
  if (!input.changeDraft) {
    return false;
  }
  const work =
    (input.changeDraft.additions_count ?? 0) + (input.changeDraft.reductions_count ?? 0);
  if (work > 0) {
    return true;
  }
  const approved =
    input.latestChange?.request_state === "approved" || input.latestChange?.lifecycle === "accepted";
  return !approved;
}

export function invoiceUnresolvedClientMessage(input: {
  changeDraft?: { id: string; additions_count?: number; reductions_count?: number } | null;
  latestChange?: {
    number: string;
    revision_no: number;
    lifecycle?: string;
    request_state: string | null;
  } | null;
  apiMessage?: string;
}): string {
  const inProgress = isInProgressChangeDraft(input);
  if (input.latestChange?.request_state === "pending") {
    const label = documentRevisionLabel(input.latestChange.number, input.latestChange.revision_no);
    if (inProgress) {
      return `This job has unpublished extra work, and ${label} is still waiting for the customer to approve it. Finish or discard the extra work, and wait for that decision, before invoicing.`;
    }
    return `${label} is still waiting for the customer to approve it. Wait for that decision before invoicing.`;
  }
  if (inProgress) {
    return unresolvedInvoiceMessage([{ kind: "change_draft" }]);
  }
  return input.apiMessage?.trim() || unresolvedInvoiceMessage([]);
}

export function invoiceUnresolvedAction(input: {
  jobId: string;
  changeDraft?: { id: string; additions_count?: number; reductions_count?: number } | null;
  latestChange?: { lifecycle?: string; request_state: string | null } | null;
}): { label: string; path: string } | undefined {
  if (!isInProgressChangeDraft(input)) {
    return undefined;
  }
  return { label: copy.invoiceUnresolvedOpenDraft, path: jobChangePath(input.jobId) };
}

export function presentInvoicePreview(input: {
  authStatus: string;
  loading: boolean;
  confirming: boolean;
  issuing: boolean;
  preview?: InvoicePreviewRecord;
  error?: { message: string; retryable: boolean; status: number; code?: string };
}): { kind: InvoicePreviewKind; showRetry: boolean; message?: string; issueDisabled: boolean } {
  const offline = input.authStatus === "offline_cached";
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", showRetry: false, issueDisabled: true };
  }
  if (input.loading && !input.preview) {
    return { kind: "loading", showRetry: false, issueDisabled: true };
  }
  if (input.error && !input.preview) {
    if (input.error.status === 404) {
      return { kind: "empty", showRetry: false, message: input.error.message, issueDisabled: true };
    }
    if (input.error.code === "UNRESOLVED_CHANGES") {
      return { kind: "unresolved", showRetry: false, message: input.error.message, issueDisabled: true };
    }
    return {
      kind: offline ? "offline" : "error",
      showRetry: input.error.retryable,
      message: input.error.message,
      issueDisabled: true,
    };
  }
  if (!input.preview) {
    return { kind: "empty", showRetry: false, issueDisabled: true };
  }
  if (input.error?.code === "PREVIEW_CHANGED" || input.error?.code === "UNRESOLVED_CHANGES") {
    return {
      kind: input.error.code === "UNRESOLVED_CHANGES" ? "unresolved" : "conflict",
      showRetry: true,
      message: input.error.message,
      issueDisabled: true,
    };
  }
  if (input.issuing) {
    return { kind: "issuing", showRetry: false, issueDisabled: true };
  }
  if (input.confirming) {
    return { kind: "confirming", showRetry: false, issueDisabled: offline };
  }
  return { kind: offline ? "offline" : "ready", showRetry: false, issueDisabled: offline };
}

export function canVoidInvoice(invoice: {
  lifecycle: string;
  credits_cents?: number;
  effective_payments_cents?: number;
  effective_refunds_cents?: number;
}): boolean {
  return (
    invoice.lifecycle === "issued" &&
    (invoice.credits_cents ?? 0) === 0 &&
    (invoice.effective_payments_cents ?? 0) === 0 &&
    (invoice.effective_refunds_cents ?? 0) === 0
  );
}

export function canReplaceInvoice(invoice: { lifecycle: string }): boolean {
  return invoice.lifecycle === "voided";
}

export function presentInvoiceStatus(status: string, voided = false): string {
  if (voided) {
    return copy.invoiceStatusVoided;
  }
  switch (status) {
    case "issued_unpaid":
      return copy.invoiceStatusUnpaid;
    case "partially_paid":
      return copy.invoiceStatusPartial;
    case "settled":
      return copy.invoiceStatusSettled;
    case "overdue":
      return copy.invoiceStatusOverdue;
    case "refund_due":
      return copy.invoiceStatusRefundDue;
    default:
      return status;
  }
}

export function canRecordRefund(status: string, amountToRefundCents: number): boolean {
  return status === "refund_due" && amountToRefundCents > 0;
}

export function canReverseLedgerEntry(
  entry: { id: string; type: string },
  entries: Array<{ id: string; type: string; reverses_entry_id?: string | null }>,
): boolean {
  if (entry.type !== "payment" && entry.type !== "refund") {
    return false;
  }
  return !entries.some((item) => item.type === "reversal" && item.reverses_entry_id === entry.id);
}

export function presentLedgerKind(kind: string): string {
  if (kind === "refund") {
    return copy.ledgerRefundTitle;
  }
  if (kind === "reversal") {
    return copy.ledgerReverseTitle;
  }
  return copy.ledgerPaymentTitle;
}

export function presentInvoicePdf(state: string): { label: string; canShare: boolean } {
  if (state === "ready") {
    return { label: copy.invoicePdfReady, canShare: true };
  }
  if (state === "failed") {
    return { label: copy.invoicePdfFailed, canShare: false };
  }
  return { label: copy.invoicePdfPreparing, canShare: false };
}

export function dueDateFromOption(
  issueDate: string,
  option: "receipt" | "7" | "14" | "30" | "custom",
  customDate?: string,
): string {
  if (option === "receipt") {
    return issueDate;
  }
  if (option === "custom") {
    return customDate || issueDate;
  }
  return addCalendarDays(issueDate, Number(option));
}

export function invoiceAllocatedNumber(number?: string | null): string | undefined {
  if (!number || number === "Draft") {
    return undefined;
  }
  return number;
}

export function invoicePreviewMoney(snapshot: {
  net_cents: number;
  tax_cents: number;
  total_cents: number;
}): { netCents: number; taxCents: number; totalCents: number } | undefined {
  if (![snapshot.net_cents, snapshot.tax_cents, snapshot.total_cents].every((value) => Number.isInteger(value))) {
    return undefined;
  }
  return { netCents: snapshot.net_cents, taxCents: snapshot.tax_cents, totalCents: snapshot.total_cents };
}

export function invoiceIssueBody(previewHash: string): { preview_hash: string } {
  return { preview_hash: previewHash };
}

export function invoiceRecipientEditable(): false {
  return false;
}

export function invoicePdfRetrySupported(): false {
  return false;
}

export function invoiceIdempotencyAfterFailure(current: string | undefined, code?: string): string | undefined {
  if (code === "IDEMPOTENCY_MISMATCH") {
    return undefined;
  }
  return current;
}

export function invoicePdfPhase(state?: string | null): "preparing" | "ready" | "failed" {
  if (state === "ready" || state === "failed") {
    return state;
  }
  return "preparing";
}

export type InvoiceDeliveryPhase = "queued" | "accepted" | "delivered" | "failed" | "not_requested";

export function invoiceDeliveryPhase(state?: string | null): InvoiceDeliveryPhase | undefined {
  if (state === "queued") {
    return "queued";
  }
  if (state === "accepted_by_provider") {
    return "accepted";
  }
  if (state === "delivered") {
    return "delivered";
  }
  if (state === "failed" || state === "bounced" || state === "complained") {
    return "failed";
  }
  if (state === "not_requested") {
    return "not_requested";
  }
  return undefined;
}

export function invoiceDeliveryLabel(state?: string | null): string | undefined {
  const phase = invoiceDeliveryPhase(state);
  if (phase === "queued") {
    return copy.invoiceDeliveryQueued;
  }
  if (phase === "accepted") {
    return copy.requestAccepted;
  }
  if (phase === "delivered") {
    return copy.requestDelivered;
  }
  if (phase === "failed") {
    return copy.invoiceDeliveryFailed;
  }
  return undefined;
}

export function invoiceRecipientReview(email: string | null | undefined): { ok: true; display: string } | { ok: false } {
  const parsed = parseOwnerEmail(email ?? "");
  if (!parsed.ok) {
    return { ok: false };
  }
  return { ok: true, display: parsed.display };
}

export function invoiceDiscountCents(lines: Array<{ discount_cents?: number }>): number | undefined {
  let total = 0;
  let any = false;
  for (const line of lines) {
    if (line.discount_cents === undefined) {
      continue;
    }
    if (!Number.isInteger(line.discount_cents) || line.discount_cents < 0) {
      return undefined;
    }
    total += line.discount_cents;
    if (line.discount_cents > 0) {
      any = true;
    }
  }
  return any ? total : undefined;
}

export function invoiceVisiblePreview<T>(authStatus: string, preview?: T): T | undefined {
  if (authStatus === "access_expired") {
    return undefined;
  }
  return preview;
}

export function invoicePreviewAfterRefresh<T>(current: T | undefined, next: T | undefined, ok: boolean): T | undefined {
  if (ok && next) {
    return next;
  }
  return current;
}

export function invoiceAnalyticsProperties(): Record<string, never> {
  return {};
}

export function invoiceContinueBlocked(input: { offline: boolean; accessExpired: boolean; issuing: boolean; hasPreview: boolean }): boolean {
  return input.offline || input.accessExpired || input.issuing || !input.hasPreview;
}

export type InvoiceDetailBadge = "issued" | "delivery_failed" | "voided";

export function invoiceResendSupported(): false {
  return false;
}

export function invoiceDetailBadge(input: { lifecycle?: string; voided?: boolean; deliveryState?: string | null }): InvoiceDetailBadge {
  if (input.voided || input.lifecycle === "voided") {
    return "voided";
  }
  if (invoiceDeliveryPhase(input.deliveryState) === "failed") {
    return "delivery_failed";
  }
  return "issued";
}

export function invoiceDetailTotalCents(totalCents: number): number | undefined {
  if (!Number.isInteger(totalCents)) {
    return undefined;
  }
  return totalCents;
}

export function invoiceDetailRecipient(email?: string | null): string | undefined {
  const trimmed = email?.trim();
  if (!trimmed) {
    return undefined;
  }
  const masked = maskEmail(trimmed);
  return masked === "***" ? undefined : masked;
}

export function invoiceDetailActionVisibility(input: {
  offline: boolean;
  accessExpired: boolean;
  voided: boolean;
  canVoid: boolean;
  canReplace: boolean;
  pdfReady: boolean;
}): { sendAgain: false; voidInvoice: boolean; createReplacement: boolean; viewPdf: boolean } {
  if (input.offline || input.accessExpired) {
    return { sendAgain: false, voidInvoice: false, createReplacement: false, viewPdf: false };
  }
  return {
    sendAgain: false,
    voidInvoice: input.canVoid && !input.voided,
    createReplacement: input.canReplace && input.voided,
    viewPdf: input.pdfReady,
  };
}

export function invoiceDetailActivity(input: { issuedAt?: string | null; voided?: boolean }): Array<{ key: "issued" | "voided"; at?: string }> {
  const items: Array<{ key: "issued" | "voided"; at?: string }> = [];
  if (input.voided) {
    items.push({ key: "voided" });
  }
  if (input.issuedAt && !Number.isNaN(Date.parse(input.issuedAt))) {
    items.push({ key: "issued", at: input.issuedAt });
  }
  return items;
}

export function invoiceDetailAfterRefresh<T>(current: T | undefined, next: T | undefined, ok: boolean): T | undefined {
  if (ok && next) {
    return next;
  }
  return current;
}

export function invoiceDetailVisible<T>(authStatus: string, invoice?: T): T | undefined {
  if (authStatus === "access_expired") {
    return undefined;
  }
  return invoice;
}

export function invoiceDetailAnalytics(): Record<string, never> {
  return {};
}

export function invoiceDetailMutationBlocked(input: { offline: boolean; busy: boolean; permitted: boolean }): boolean {
  return input.offline || input.busy || !input.permitted;
}

export function invoiceVoidReasonAccepted(reason: string): boolean {
  return parseInvoiceVoid({ reason }).ok;
}

export function invoiceVoidKeepsOriginal(
  before: { id: string; number: string; total_cents: number },
  after: { id: string; number: string; total_cents: number },
): boolean {
  return before.id === after.id && before.number === after.number && before.total_cents === after.total_cents;
}

export function invoiceReplacementIsDistinct(original: { id: string; number: string }, replacement: { id: string; number: string }): boolean {
  return original.id !== replacement.id && original.number !== replacement.number && original.number.length > 0 && replacement.number.length > 0;
}

export function invoiceDetailLoadKind(status: number, code?: string): "not_found" | "unauthorized" | "rate_limit" | "conflict" | "error" {
  if (status === 404 || code === "NOT_FOUND") {
    return "not_found";
  }
  if (status === 401 || status === 403) {
    return "unauthorized";
  }
  if (status === 429 || code === "RATE_LIMITED") {
    return "rate_limit";
  }
  if (code === "VERSION_CONFLICT" || code === "PREVIEW_CHANGED") {
    return "conflict";
  }
  return "error";
}

export function invoicePdfPollContinues(state: string | undefined, ticks: number, limit = 20): boolean {
  return invoicePdfPhase(state) === "preparing" && ticks < limit;
}
