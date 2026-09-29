import { CREDIT_REASON_MAX, CREDIT_REASON_MIN, dollarsStringToCents, formatUsdCents, parseBoundedText } from "@job-to-invoice/schemas";

export type CreditSourceLine = {
  invoice_line_id: string;
  description: string;
  remaining_net_cents: number;
};

export type CreditField = "amount" | "reason" | "allocations";

export type CreditIssueCode =
  | "required"
  | "zero"
  | "negative"
  | "invalid"
  | "limit"
  | "over_line"
  | "too_short"
  | "too_long";

export type CreditIssue = { field: CreditField; lineId?: string; code: CreditIssueCode };

export type CreditPreviewSnapshot = {
  preview_hash: string;
  total_cents: number;
  net_cents: number;
  tax_cents: number;
  reason: string;
  invoice_number?: string;
  issue_date?: string;
};

export type IssuedCreditRecord = {
  id: string;
  number: string;
  total_cents: number;
  pdf_state: "preparing" | "ready" | "failed";
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function creditAmountCents(
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

export function creditLineIssues(input: string, remainingNetCents: number): CreditIssue[] {
  if (!input.trim()) {
    return [];
  }
  const amount = creditAmountCents(input);
  if (!amount.ok) {
    return [{ field: "amount", code: amount.code }];
  }
  if (!Number.isInteger(remainingNetCents) || amount.cents > remainingNetCents) {
    return [{ field: "amount", code: "over_line" }];
  }
  return [];
}

export function creditReasonIssue(reason: string): CreditIssue | undefined {
  const parsed = parseBoundedText(reason, { min: CREDIT_REASON_MIN, max: CREDIT_REASON_MAX, multiline: true });
  if (parsed.ok) {
    return undefined;
  }
  if (parsed.code === "too_short" || parsed.code === "required") {
    return { field: "reason", code: parsed.code === "required" ? "required" : "too_short" };
  }
  if (parsed.code === "too_long") {
    return { field: "reason", code: "too_long" };
  }
  return { field: "reason", code: "invalid" };
}

export function creditAllocations(
  sources: readonly CreditSourceLine[],
  amounts: Record<string, string>,
): { invoice_line_id: string; net_credit_cents: number }[] | undefined {
  const rows: { invoice_line_id: string; net_credit_cents: number }[] = [];
  for (const source of sources) {
    const raw = amounts[source.invoice_line_id] ?? "";
    if (!raw.trim()) {
      continue;
    }
    if (creditLineIssues(raw, source.remaining_net_cents).length > 0) {
      return undefined;
    }
    const amount = creditAmountCents(raw);
    if (!amount.ok) {
      return undefined;
    }
    rows.push({ invoice_line_id: source.invoice_line_id, net_credit_cents: amount.cents });
  }
  return rows.length > 0 ? rows : undefined;
}

export function creditEntryIssues(input: {
  sources: readonly CreditSourceLine[];
  amounts: Record<string, string>;
  reason: string;
}): CreditIssue[] {
  const issues: CreditIssue[] = [];
  let anyAmount = false;
  for (const source of input.sources) {
    const raw = input.amounts[source.invoice_line_id] ?? "";
    if (raw.trim()) {
      anyAmount = true;
    }
    for (const issue of creditLineIssues(raw, source.remaining_net_cents)) {
      issues.push({ ...issue, lineId: source.invoice_line_id });
    }
  }
  if (!anyAmount) {
    issues.push({ field: "allocations", code: "required" });
  }
  const reason = creditReasonIssue(input.reason);
  if (reason) {
    issues.push(reason);
  }
  return issues;
}

export function creditEligible(invoice: {
  lifecycle?: string;
  voided?: boolean;
  credit_sources?: readonly CreditSourceLine[];
} | undefined): boolean {
  if (!invoice || invoice.voided || invoice.lifecycle === "voided" || invoice.lifecycle !== "issued") {
    return false;
  }
  return (invoice.credit_sources ?? []).some((source) => Number.isInteger(source.remaining_net_cents) && source.remaining_net_cents > 0);
}

export function creditReviewAllowed(input: {
  sources: readonly CreditSourceLine[];
  amounts: Record<string, string>;
  reason: string;
  offline: boolean;
  eligible: boolean;
}): boolean {
  if (input.offline || !input.eligible) {
    return false;
  }
  return creditEntryIssues(input).length === 0;
}

export function creditPreviewBody(input: {
  sources: readonly CreditSourceLine[];
  amounts: Record<string, string>;
  reason: string;
}): { reason: string; allocations: { invoice_line_id: string; net_credit_cents: number }[] } | undefined {
  if (!creditReviewAllowed({ ...input, offline: false, eligible: true })) {
    return undefined;
  }
  const allocations = creditAllocations(input.sources, input.amounts);
  const reason = parseBoundedText(input.reason, { min: CREDIT_REASON_MIN, max: CREDIT_REASON_MAX, multiline: true });
  if (!allocations || !reason.ok) {
    return undefined;
  }
  return { reason: reason.value, allocations };
}

export function creditIssueBody(previewHash: string | undefined): { preview_hash: string } | undefined {
  if (!previewHash || !SHA256_HEX.test(previewHash)) {
    return undefined;
  }
  return { preview_hash: previewHash };
}

export function creditResultingCents(balanceCents: number, creditTotalCents: number): number {
  return balanceCents - creditTotalCents;
}

export function creditAllowsRefundDue(resultingCents: number): boolean {
  return Number.isInteger(resultingCents);
}

export function creditIdempotencyAfterFailure(current: string | undefined, code?: string): string | undefined {
  if (code === "IDEMPOTENCY_MISMATCH") {
    return undefined;
  }
  return current;
}

export function creditOutcome(
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
  if (code === "VALIDATION_FAILED" || code === "CREDIT_EXCEEDS_SOURCE") {
    return "invalid";
  }
  return "retry";
}

export function creditPreviewResult(data: unknown): CreditPreviewSnapshot | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const row = data as Record<string, unknown>;
  const hash = row.preview_hash;
  const snapshot = row.snapshot;
  if (typeof hash !== "string" || !SHA256_HEX.test(hash) || !snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const body = snapshot as Record<string, unknown>;
  const total = body.total_cents;
  const net = body.net_cents;
  const tax = body.tax_cents;
  const reason = body.reason;
  if (!Number.isInteger(total) || !Number.isInteger(net) || !Number.isInteger(tax) || typeof reason !== "string") {
    return undefined;
  }
  return {
    preview_hash: hash,
    total_cents: total as number,
    net_cents: net as number,
    tax_cents: tax as number,
    reason,
    invoice_number: typeof body.invoice_number === "string" ? body.invoice_number : undefined,
    issue_date: typeof body.issue_date === "string" ? body.issue_date : undefined,
  };
}

export function creditIssuedResult(data: unknown): IssuedCreditRecord | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const row = data as Record<string, unknown>;
  const id = row.id;
  const number = row.number;
  const total = row.total_cents;
  const pdf = row.pdf_state;
  if (typeof id !== "string" || id.length < 8 || typeof number !== "string" || number.length < 2 || number.length > 40) {
    return undefined;
  }
  if (!Number.isInteger(total) || (total as number) < 1) {
    return undefined;
  }
  if (pdf !== "preparing" && pdf !== "ready" && pdf !== "failed") {
    return undefined;
  }
  return { id, number, total_cents: total as number, pdf_state: pdf };
}

export function creditRecordedPhase(balanceCents: number | undefined): "partial" | "full" | "refund_due" | undefined {
  if (!Number.isInteger(balanceCents)) {
    return undefined;
  }
  if ((balanceCents as number) < 0) {
    return "refund_due";
  }
  return (balanceCents as number) > 0 ? "partial" : "full";
}

export function creditResultDisplay(resultingCents: number): { kind: "balance" | "refund_due"; cents: number } {
  if (resultingCents < 0) {
    return { kind: "refund_due", cents: -resultingCents };
  }
  return { kind: "balance", cents: resultingCents };
}

export function creditOverLineText(description: string, remainingNetCents: number): string {
  return `${description} credit cannot exceed ${formatUsdCents(remainingNetCents)}.`;
}

export function creditPdfPollContinues(state: string | undefined, ticks: number, limit = 20): boolean {
  return state === "preparing" && ticks < limit;
}

export function creditShouldIssue(phase: "entry" | "review" | "issued", saving: boolean): boolean {
  return phase === "review" && !saving;
}

export function creditNavigation(action: "back" | "invoice" | "job"): "s16" | "s08" {
  return action === "job" ? "s08" : "s16";
}

export function creditCommercialVisible<T>(authStatus: string, invoice?: T): T | undefined {
  if (authStatus === "access_expired") {
    return undefined;
  }
  return invoice;
}

export function creditAfterRefresh<T>(previous: T | undefined, next: T | undefined, failed: boolean): T | undefined {
  if (failed) {
    return previous;
  }
  return next ?? previous;
}

export function creditLoadKind(status: number, code?: string): "not_found" | "unauthorized" | "rate" | "error" {
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

export function creditCommandTarget(kind: "credit" | "refund" | "reversal" | "void"): "credits" | "refunds" | "reversals" | "void" {
  if (kind === "refund") {
    return "refunds";
  }
  if (kind === "reversal") {
    return "reversals";
  }
  if (kind === "void") {
    return "void";
  }
  return "credits";
}

export function creditAnalyticsProperties(): Record<string, never> {
  return {};
}

export function creditSafeSnapshot(input: { phase: string; offline: boolean; pdf?: string; outcome?: string }): {
  phase: string;
  offline: boolean;
  pdf?: string;
  outcome?: string;
} {
  const snapshot: { phase: string; offline: boolean; pdf?: string; outcome?: string } = {
    phase: input.phase,
    offline: input.offline,
  };
  if (input.pdf) {
    snapshot.pdf = input.pdf;
  }
  if (input.outcome) {
    snapshot.outcome = input.outcome;
  }
  return snapshot;
}
