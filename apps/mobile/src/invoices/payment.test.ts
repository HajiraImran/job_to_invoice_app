import { describe, expect, it } from "vitest";
import {
  formatLedgerDisplayDate,
  ledgerEntryTarget,
  paymentAfterBalanceConflict,
  paymentAfterRefresh,
  paymentAmountCents,
  paymentAnalyticsProperties,
  paymentBlockedReason,
  paymentCommercialVisible,
  paymentDateIssue,
  paymentEntryIssues,
  paymentIdempotencyAfterFailure,
  paymentImpliesPaidInFull,
  paymentImpliesPartial,
  paymentInitialAmount,
  paymentLoadKind,
  paymentOutcome,
  paymentRecordedNavigation,
  paymentRecordedResult,
  paymentRequestBody,
  paymentRequiresRefresh,
  paymentResultingCents,
  paymentReviewAllowed,
  refundEligible,
  refundRecordedPhase,
  paymentSafeSnapshot,
  paymentShouldSubmit,
  type PaymentDraft,
} from "./payment.ts";

const today = "2026-09-26";
const outstanding = 10000;

function draft(overrides: Partial<PaymentDraft> = {}): PaymentDraft {
  return {
    amount: "40.00",
    date: today,
    method: "cash",
    reference: "",
    note: "",
    confirmOverpay: false,
    ...overrides,
  };
}

function reviewInput(overrides: Partial<PaymentDraft> = {}, outstandingCents: number | undefined = outstanding) {
  return {
    kind: "payment" as const,
    draft: draft(overrides),
    outstandingCents,
    refundableCents: 0,
    todayYmd: today,
    offline: false,
    eligible: true,
  };
}

describe("S17 record payment", () => {
  it("parses integer cents and rejects zero, negative, and unsafe amounts", () => {
    expect(paymentAmountCents("40.00")).toEqual({ ok: true, cents: 4000 });
    expect(paymentAmountCents("$1,040.00")).toEqual({ ok: true, cents: 104000 });
    expect(paymentAmountCents("")).toEqual({ ok: false, code: "required" });
    expect(paymentAmountCents("0.00")).toEqual({ ok: false, code: "zero" });
    expect(paymentAmountCents("-1.00")).toEqual({ ok: false, code: "negative" });
    expect(paymentAmountCents("12.345")).toEqual({ ok: false, code: "invalid" });
    expect(paymentAmountCents("1000000.00")).toEqual({ ok: false, code: "limit" });
  });

  it("accepts a partial payment and an exact balance without marking paid in full locally", () => {
    expect(paymentResultingCents(outstanding, 4000)).toBe(6000);
    expect(paymentEntryIssues(reviewInput()).some((issue) => issue.code === "over_balance")).toBe(false);
    expect(paymentResultingCents(outstanding, 10000)).toBe(0);
    expect(paymentReviewAllowed(reviewInput({ amount: "100.00" }))).toBe(true);
    expect(paymentImpliesPaidInFull(undefined)).toBe(false);
    expect(paymentImpliesPartial("partially_paid")).toBe(true);
    expect(paymentImpliesPaidInFull("settled")).toBe(true);
    expect(paymentImpliesPaidInFull("partially_paid")).toBe(false);
  });

  it("requires explicit overpayment confirmation and does not cap the amount", () => {
    expect(paymentReviewAllowed(reviewInput({ amount: "120.00" }))).toBe(false);
    expect(paymentRequestBody(reviewInput({ amount: "120.00" }))).toBeUndefined();
    expect(paymentReviewAllowed(reviewInput({ amount: "120.00", confirmOverpay: true }))).toBe(true);
    const body = paymentRequestBody(reviewInput({ amount: "120.00", confirmOverpay: true }));
    expect(body).toMatchObject({ amount_cents: 12000, confirm_overpayment: true });
    expect(paymentResultingCents(outstanding, 12000)).toBe(-2000);
  });

  it("validates the date, method, reference, and note with the ledger rules", () => {
    expect(paymentDateIssue(today, today)).toBeUndefined();
    expect(paymentDateIssue("2026-09-27", today)).toBe("future");
    expect(paymentDateIssue("2020-09-26", today)).toBe("too_old");
    expect(paymentDateIssue("09/26/2026", today)).toBe("invalid");
    expect(paymentDateIssue("2026-02-31", today)).toBe("invalid");
    expect(paymentReviewAllowed(reviewInput({ method: "venmo" }))).toBe(false);
    expect(paymentReviewAllowed(reviewInput({ reference: ` ${"a".repeat(100)} ` }))).toBe(true);
    expect(paymentRequestBody(reviewInput({ reference: "  transfer  " }))).toMatchObject({ reference: "transfer" });
    expect(paymentReviewAllowed(reviewInput({ reference: "a".repeat(101) }))).toBe(false);
    expect(paymentReviewAllowed(reviewInput({ reference: "bad\u0000ref" }))).toBe(false);
    expect(paymentReviewAllowed(reviewInput({ note: "a".repeat(501) }))).toBe(false);
    expect(paymentRequestBody(reviewInput({ note: "  kept  " }))).toMatchObject({ note: "kept" });
    expect(paymentRequestBody(reviewInput())).not.toHaveProperty("reference");
  });

  it("keeps review from submitting and submits only one confirmed request", () => {
    expect(paymentShouldSubmit("entry", false)).toBe(false);
    expect(paymentShouldSubmit("review", false)).toBe(true);
    expect(paymentShouldSubmit("review", true)).toBe(false);
    expect(paymentShouldSubmit("recorded", false)).toBe(false);
    const body = paymentRequestBody(reviewInput());
    expect(body).toMatchObject({ amount_cents: 4000, effective_date: today, method: "cash", confirm_overpayment: false });
    expect(paymentRequestBody(reviewInput())).toEqual(body);
  });

  it("reuses an idempotency key after an ambiguous failure and rotates it after a mismatch", () => {
    expect(paymentIdempotencyAfterFailure("key-1", "UNAVAILABLE")).toBe("key-1");
    expect(paymentIdempotencyAfterFailure("key-1", "RATE_LIMITED")).toBe("key-1");
    expect(paymentIdempotencyAfterFailure("key-1", "VERSION_CONFLICT")).toBe("key-1");
    expect(paymentIdempotencyAfterFailure("key-1", "IDEMPOTENCY_MISMATCH")).toBeUndefined();
    expect(paymentOutcome(false, "OPERATION_PENDING")).toBe("pending");
    expect(paymentOutcome(false, "RATE_LIMITED")).toBe("rate");
    expect(paymentOutcome(false, "VERSION_CONFLICT")).toBe("conflict");
    expect(paymentOutcome(false, "AUTHENTICATION_FAILED")).toBe("auth");
    expect(paymentOutcome(false, "VALIDATION_FAILED")).toBe("invalid");
    expect(paymentOutcome(true)).toBe("success");
    expect(paymentOutcome(false, "OPERATION_PENDING")).not.toBe("success");
  });

  it("requires another review when the outstanding balance changes", () => {
    expect(paymentRequiresRefresh(10000, 8000)).toBe(true);
    expect(paymentRequiresRefresh(10000, 10000)).toBe(false);
    expect(paymentAfterBalanceConflict()).toEqual({ phase: "entry", confirmOverpay: false });
    expect(paymentReviewAllowed(reviewInput({ amount: "100.00" }, 8000))).toBe(false);
    expect(paymentInitialAmount({
      kind: "payment",
      current: "100.00",
      dirty: true,
      prefillDue: true,
      amountDueCents: 8000,
    })).toBe("100.00");
  });

  it("blocks offline, voided, and ineligible invoices and hides commercial data when access expires", () => {
    expect(paymentReviewAllowed({ ...reviewInput(), offline: true })).toBe(false);
    expect(paymentBlockedReason({ lifecycle: "voided", voided: true })).toBe("voided");
    expect(paymentBlockedReason({ lifecycle: "draft" })).toBe("ineligible");
    expect(paymentBlockedReason({ lifecycle: "issued" })).toBeUndefined();
    expect(paymentReviewAllowed({ ...reviewInput(), eligible: false })).toBe(false);
    expect(paymentLoadKind(404, "NOT_FOUND")).toBe("not_found");
    expect(paymentLoadKind(401, "AUTHENTICATION_FAILED")).toBe("unauthorized");
    expect(paymentCommercialVisible("access_expired", { number: "INV-9" })).toBeUndefined();
    expect(paymentAfterRefresh({ number: "INV-9" }, undefined, true)).toEqual({ number: "INV-9" });
  });

  it("uses the server payment result for status and routes success without another submit", () => {
    expect(paymentRecordedResult({
      amount_cents: 4000,
      payment_status: "partially_paid",
      balance_cents: 6000,
      amount_due_cents: 6000,
      amount_to_refund_cents: 0,
    })).toMatchObject({ payment_status: "partially_paid", balance_cents: 6000 });
    expect(paymentRecordedResult({
      amount_cents: 10000,
      payment_status: "settled",
      balance_cents: 0,
      amount_due_cents: 0,
      amount_to_refund_cents: 0,
    })?.payment_status).toBe("settled");
    expect(paymentRecordedResult({ amount_cents: 10.5, payment_status: "settled" })).toBeUndefined();
    expect(paymentRecordedNavigation("view_invoice")).toBe("s16");
    expect(paymentRecordedNavigation("back")).toBe("s16");
    expect(paymentRecordedNavigation("back_to_job")).toBe("s08");
    expect(paymentInitialAmount({
      kind: "payment",
      current: "",
      dirty: false,
      prefillDue: false,
      amountDueCents: 10000,
    })).toBe("");
    expect(paymentInitialAmount({
      kind: "payment",
      current: "",
      dirty: false,
      prefillDue: true,
      amountDueCents: 10000,
    })).toBe("100.00");
  });

  it("keeps analytics and snapshots free of commercial payment details", () => {
    expect(paymentAnalyticsProperties()).toEqual({});
    const snapshot = paymentSafeSnapshot({ phase: "review", offline: false, outcome: "retry" });
    expect(snapshot).toEqual({ phase: "review", offline: false, outcome: "retry" });
    expect(JSON.stringify(snapshot)).not.toContain("reference");
    expect(JSON.stringify(paymentAnalyticsProperties())).not.toContain("amount");
    const body = paymentRequestBody(reviewInput({ reference: "secret-ref", note: "secret-note" }));
    expect(JSON.stringify(paymentAnalyticsProperties())).not.toContain("secret-ref");
    expect(body).toMatchObject({ reference: "secret-ref", note: "secret-note" });
  });
});

function refundReview(overrides: Partial<PaymentDraft> = {}, refundableCents: number | undefined = 64000) {
  return {
    kind: "refund" as const,
    draft: draft({ amount: "320.00", ...overrides }),
    outstandingCents: 0,
    refundableCents,
    todayYmd: today,
    offline: false,
    eligible: true,
  };
}

describe("S18 record refund", () => {
  it("uses the server refundable balance and does not prefill it", () => {
    expect(paymentInitialAmount({
      kind: "refund",
      current: "",
      dirty: false,
      prefillDue: false,
      amountToRefundCents: 64000,
    })).toBe("");
    expect(paymentInitialAmount({
      kind: "refund",
      current: "12.00",
      dirty: true,
      prefillDue: false,
      amountToRefundCents: 64000,
    })).toBe("12.00");
    expect(refundEligible({ lifecycle: "issued", amount_to_refund_cents: 64000 })).toBe(true);
    expect(refundEligible({ lifecycle: "voided", voided: true, amount_to_refund_cents: 64000 })).toBe(false);
    expect(refundEligible({ lifecycle: "issued", amount_to_refund_cents: 0 })).toBe(false);
    expect(refundEligible({ lifecycle: "draft", amount_to_refund_cents: 64000 })).toBe(false);
  });

  it("accepts a partial or exact refund and blocks an over-refund without capping it", () => {
    expect(paymentResultingCents(64000, 32000)).toBe(32000);
    expect(paymentReviewAllowed(refundReview())).toBe(true);
    expect(paymentResultingCents(64000, 64000)).toBe(0);
    expect(paymentReviewAllowed(refundReview({ amount: "640.00" }))).toBe(true);
    expect(paymentReviewAllowed(refundReview({ amount: "800.00" }))).toBe(false);
    expect(paymentRequestBody(refundReview({ amount: "800.00" }))).toBeUndefined();
    expect(paymentEntryIssues(refundReview({ amount: "800.00" })).some((issue) => issue.code === "over_refund")).toBe(true);
    expect(paymentAmountCents("0")).toEqual({ ok: false, code: "zero" });
    expect(paymentAmountCents("-5")).toEqual({ ok: false, code: "negative" });
    const body = paymentRequestBody(refundReview());
    expect(body).toMatchObject({ amount_cents: 32000, effective_date: today, method: "cash" });
    expect(body).not.toHaveProperty("confirm_overpayment");
  });

  it("validates refund date, method, reference, and note", () => {
    expect(formatLedgerDisplayDate(today)).toBe("Sep 26, 2026");
    expect(paymentDateIssue("2026-09-27", today)).toBe("future");
    expect(paymentReviewAllowed(refundReview({ method: "venmo" }))).toBe(false);
    expect(paymentRequestBody(refundReview({ reference: "  refund ref  " }))).toMatchObject({ reference: "refund ref" });
    expect(paymentReviewAllowed(refundReview({ reference: "a".repeat(101) }))).toBe(false);
    expect(paymentReviewAllowed(refundReview({ reference: "bad\u0000ref" }))).toBe(false);
    expect(paymentReviewAllowed(refundReview({ note: "a".repeat(501) }))).toBe(false);
    expect(paymentRequestBody(refundReview({ note: "  kept  " }))).toMatchObject({ note: "kept" });
  });

  it("reviews without posting, posts once, and keeps refunds distinct from reversals", () => {
    expect(paymentShouldSubmit("entry", false)).toBe(false);
    expect(paymentShouldSubmit("review", false)).toBe(true);
    expect(paymentShouldSubmit("review", true)).toBe(false);
    expect(ledgerEntryTarget("refund")).toBe("refunds");
    expect(ledgerEntryTarget("reversal")).toBe("reversals");
    expect(ledgerEntryTarget("payment")).toBe("payments");
    expect(ledgerEntryTarget("refund")).not.toBe(ledgerEntryTarget("reversal"));
  });

  it("reuses idempotency, blocks a changed refundable balance, and reads the server remainder", () => {
    expect(paymentIdempotencyAfterFailure("refund-key", "UNAVAILABLE")).toBe("refund-key");
    expect(paymentIdempotencyAfterFailure("refund-key", "IDEMPOTENCY_MISMATCH")).toBeUndefined();
    expect(paymentOutcome(false, "OPERATION_PENDING")).toBe("pending");
    expect(paymentOutcome(false, "RATE_LIMITED")).toBe("rate");
    expect(paymentRequiresRefresh(64000, 32000)).toBe(true);
    expect(paymentAfterBalanceConflict()).toEqual({ phase: "entry", confirmOverpay: false });
    expect(paymentReviewAllowed(refundReview({ amount: "640.00" }, 32000))).toBe(false);
    expect(paymentReviewAllowed({ ...refundReview(), offline: true })).toBe(false);
    expect(refundRecordedPhase(32000)).toBe("partial");
    expect(refundRecordedPhase(0)).toBe("full");
    expect(refundRecordedPhase(-1)).toBeUndefined();
    expect(paymentRecordedResult({
      amount_cents: 32000,
      payment_status: "refund_due",
      balance_cents: -32000,
      amount_due_cents: 0,
      amount_to_refund_cents: 32000,
    })).toMatchObject({ amount_cents: 32000, amount_to_refund_cents: 32000 });
    expect(paymentRecordedNavigation("view_invoice")).toBe("s16");
    expect(paymentRecordedNavigation("back_to_job")).toBe("s08");
    expect(paymentCommercialVisible("access_expired", { number: "INV-9" })).toBeUndefined();
    expect(paymentLoadKind(404, "NOT_FOUND")).toBe("not_found");
    expect(paymentLoadKind(403, "AUTHENTICATION_FAILED")).toBe("unauthorized");
    expect(paymentAnalyticsProperties()).toEqual({});
    const snapshot = paymentSafeSnapshot({ phase: "review", offline: true, outcome: "retry" });
    expect(JSON.stringify(snapshot)).not.toContain("refund ref");
    expect(JSON.stringify(snapshot)).not.toContain("32000");
  });
});
