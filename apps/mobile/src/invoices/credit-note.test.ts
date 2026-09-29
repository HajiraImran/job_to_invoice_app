import { describe, expect, it } from "vitest";
import {
  creditAfterRefresh,
  creditAllocations,
  creditAllowsRefundDue,
  creditAmountCents,
  creditAnalyticsProperties,
  creditCommercialVisible,
  creditCommandTarget,
  creditEligible,
  creditEntryIssues,
  creditIdempotencyAfterFailure,
  creditIssueBody,
  creditIssuedResult,
  creditLoadKind,
  creditNavigation,
  creditOutcome,
  creditPdfPollContinues,
  creditPreviewBody,
  creditPreviewResult,
  creditOverLineText,
  creditRecordedPhase,
  creditResultDisplay,
  creditResultingCents,
  creditReviewAllowed,
  creditSafeSnapshot,
  creditShouldIssue,
  type CreditSourceLine,
} from "./credit-note.ts";

const line: CreditSourceLine = {
  invoice_line_id: "11111111-1111-4111-8111-111111111111",
  description: "Fixture",
  remaining_net_cents: 10000,
};

const hash = "a".repeat(64);

function input(amounts: Record<string, string> = { [line.invoice_line_id]: "40.00" }, reason = "Scope removed") {
  return { sources: [line], amounts, reason, offline: false, eligible: true };
}

describe("S18 credit note", () => {
  it("parses integer cents and rejects zero, negative, and unsafe amounts", () => {
    expect(creditAmountCents("40.00")).toEqual({ ok: true, cents: 4000 });
    expect(creditAmountCents("$1,040.00")).toEqual({ ok: true, cents: 104000 });
    expect(creditAmountCents("")).toEqual({ ok: false, code: "required" });
    expect(creditAmountCents("0.00")).toEqual({ ok: false, code: "zero" });
    expect(creditAmountCents("-1.00")).toEqual({ ok: false, code: "negative" });
    expect(creditAmountCents("12.345")).toEqual({ ok: false, code: "invalid" });
  });

  it("accepts one cent under and the exact line remainder, and rejects one cent over", () => {
    expect(creditReviewAllowed(input({ [line.invoice_line_id]: "99.99" }))).toBe(true);
    expect(creditReviewAllowed(input({ [line.invoice_line_id]: "100.00" }))).toBe(true);
    expect(creditReviewAllowed(input({ [line.invoice_line_id]: "100.01" }))).toBe(false);
    expect(creditEntryIssues(input({ [line.invoice_line_id]: "100.01" })).some((issue) => issue.code === "over_line")).toBe(true);
    expect(creditPreviewBody(input({ [line.invoice_line_id]: "100.01" }))).toBeUndefined();
    expect(creditAllocations([line], { [line.invoice_line_id]: "100.01" })).toBeUndefined();
    expect(creditPreviewBody(input({ [line.invoice_line_id]: "40.00" }))).toMatchObject({
      allocations: [{ invoice_line_id: line.invoice_line_id, net_credit_cents: 4000 }],
    });
  });

  it("keeps a credit that creates refund due when the line remainder allows it", () => {
    expect(creditResultingCents(0, 2000)).toBe(-2000);
    expect(creditAllowsRefundDue(-2000)).toBe(true);
    expect(creditReviewAllowed(input({ [line.invoice_line_id]: "20.00" }))).toBe(true);
    expect(creditRecordedPhase(32000)).toBe("partial");
    expect(creditRecordedPhase(0)).toBe("full");
    expect(creditRecordedPhase(-2000)).toBe("refund_due");
    expect(creditResultDisplay(-2080)).toEqual({ kind: "refund_due", cents: 2080 });
    expect(creditResultDisplay(32000)).toEqual({ kind: "balance", cents: 32000 });
    expect(creditOverLineText("Timber framing", 26000)).toBe("Timber framing credit cannot exceed $260.00.");
  });

  it("requires a reason and rejects length and control-character failures", () => {
    expect(creditReviewAllowed(input(undefined, "no"))).toBe(false);
    expect(creditReviewAllowed(input(undefined, ""))).toBe(false);
    expect(creditReviewAllowed(input(undefined, "a".repeat(501)))).toBe(false);
    expect(creditReviewAllowed(input(undefined, "bad\u0000reason"))).toBe(false);
    expect(creditPreviewBody(input(undefined, "  Scope removed  "))?.reason).toBe("Scope removed");
    expect(creditEntryIssues(input({}, "Scope removed")).some((issue) => issue.field === "allocations")).toBe(true);
  });

  it("reviews through preview and issues only the preview hash once", () => {
    expect(creditShouldIssue("entry", false)).toBe(false);
    expect(creditShouldIssue("review", false)).toBe(true);
    expect(creditShouldIssue("review", true)).toBe(false);
    expect(creditIssueBody(undefined)).toBeUndefined();
    expect(creditIssueBody(hash)).toEqual({ preview_hash: hash });
    expect(Object.keys(creditIssueBody(hash) ?? {})).toEqual(["preview_hash"]);
    const preview = creditPreviewResult({
      preview_hash: hash,
      snapshot: { reason: "Scope removed", invoice_number: "INV-9", issue_date: "2026-09-26", net_cents: 4000, tax_cents: 0, total_cents: 4000 },
    });
    expect(preview?.total_cents).toBe(4000);
    expect(creditPreviewResult({ preview_hash: "short", snapshot: {} })).toBeUndefined();
  });

  it("reuses an idempotency key, rotates on mismatch, and treats pending as pending", () => {
    expect(creditIdempotencyAfterFailure("key-1", "UNAVAILABLE")).toBe("key-1");
    expect(creditIdempotencyAfterFailure("key-1", "IDEMPOTENCY_MISMATCH")).toBeUndefined();
    expect(creditOutcome(false, "OPERATION_PENDING")).toBe("pending");
    expect(creditOutcome(false, "RATE_LIMITED")).toBe("rate");
    expect(creditOutcome(false, "PREVIEW_CHANGED")).toBe("conflict");
    expect(creditOutcome(false, "CREDIT_EXCEEDS_SOURCE")).toBe("invalid");
    expect(creditOutcome(true)).toBe("success");
    expect(creditOutcome(false, "OPERATION_PENDING")).not.toBe("success");
  });

  it("blocks voided and ineligible invoices and hides data when access expires", () => {
    expect(creditEligible({ lifecycle: "issued", credit_sources: [line] })).toBe(true);
    expect(creditEligible({ lifecycle: "voided", voided: true, credit_sources: [line] })).toBe(false);
    expect(creditEligible({ lifecycle: "issued", credit_sources: [{ ...line, remaining_net_cents: 0 }] })).toBe(false);
    expect(creditEligible({ lifecycle: "draft", credit_sources: [line] })).toBe(false);
    expect(creditReviewAllowed({ ...input(), eligible: false })).toBe(false);
    expect(creditReviewAllowed({ ...input(), offline: true })).toBe(false);
    expect(creditLoadKind(404, "NOT_FOUND")).toBe("not_found");
    expect(creditLoadKind(401, "AUTHENTICATION_FAILED")).toBe("unauthorized");
    expect(creditLoadKind(429, "RATE_LIMITED")).toBe("rate");
    expect(creditCommercialVisible("access_expired", { number: "INV-9" })).toBeUndefined();
    expect(creditAfterRefresh({ number: "INV-9" }, undefined, true)).toEqual({ number: "INV-9" });
  });

  it("uses the server credit number and keeps credits distinct from refunds, reversals, and voids", () => {
    expect(creditIssuedResult({ id: "22222222-2222-4222-8222-222222222222", number: "CN-000001", total_cents: 4000, pdf_state: "preparing" })?.number).toBe("CN-000001");
    expect(creditIssuedResult({ id: "22222222-2222-4222-8222-222222222222", number: "CN-000001", total_cents: 10.5, pdf_state: "ready" })).toBeUndefined();
    expect(creditPdfPollContinues("preparing", 19)).toBe(true);
    expect(creditPdfPollContinues("preparing", 20)).toBe(false);
    expect(creditPdfPollContinues("ready", 0)).toBe(false);
    expect(creditPdfPollContinues("failed", 0)).toBe(false);
    expect(creditCommandTarget("credit")).toBe("credits");
    expect(creditCommandTarget("refund")).toBe("refunds");
    expect(creditCommandTarget("reversal")).toBe("reversals");
    expect(creditCommandTarget("void")).toBe("void");
    expect(creditNavigation("invoice")).toBe("s16");
    expect(creditNavigation("back")).toBe("s16");
    expect(creditNavigation("job")).toBe("s08");
  });

  it("keeps analytics and snapshots free of commercial credit details", () => {
    expect(creditAnalyticsProperties()).toEqual({});
    const snapshot = creditSafeSnapshot({ phase: "review", offline: false, pdf: "preparing", outcome: "retry" });
    expect(snapshot).toEqual({ phase: "review", offline: false, pdf: "preparing", outcome: "retry" });
    expect(JSON.stringify(snapshot)).not.toContain("Scope");
    expect(JSON.stringify(snapshot)).not.toContain(hash);
    expect(JSON.stringify(creditAnalyticsProperties())).not.toContain("4000");
  });
});
