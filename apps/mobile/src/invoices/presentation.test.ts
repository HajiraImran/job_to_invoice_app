import { formatUsdCents } from "@job-to-invoice/schemas";
import { describe, expect, it } from "vitest";
import { jobDetailPath } from "../jobs/routes.ts";
import {
  canRecordRefund,
  canReplaceInvoice,
  canReverseLedgerEntry,
  canVoidInvoice,
  dueDateFromOption,
  invoiceAllocatedNumber,
  invoiceAnalyticsProperties,
  invoiceContinueBlocked,
  invoiceDeliveryPhase,
  invoiceDetailActionVisibility,
  invoiceDetailActivity,
  invoiceDetailAfterRefresh,
  invoiceDetailAnalytics,
  invoiceDetailBadge,
  invoiceDetailLoadKind,
  invoiceDetailMutationBlocked,
  invoiceDetailRecipient,
  invoiceDetailTotalCents,
  invoiceDetailVisible,
  invoiceDiscountCents,
  invoiceIdempotencyAfterFailure,
  invoiceIssueBody,
  invoicePdfPhase,
  invoicePdfPollContinues,
  invoicePdfRetrySupported,
  invoicePreviewAfterRefresh,
  invoicePreviewMoney,
  invoiceRecipientEditable,
  invoiceRecipientReview,
  invoiceReplacementIsDistinct,
  invoiceResendSupported,
  invoiceUnresolvedAction,
  invoiceUnresolvedClientMessage,
  invoiceVisiblePreview,
  invoiceVoidKeepsOriginal,
  invoiceVoidReasonAccepted,
  presentInvoicePdf,
  presentInvoicePreview,
  presentInvoiceStatus,
  presentIssuedCreditNotes,
  presentInvoiceMoneyRows,
  creditNotePdfOpenKind,
} from "./presentation.ts";

describe("invoice presentation", () => {
  it("disables issue while offline and maps preview conflicts", () => {
    const preview = {
      draft_id: "d1",
      job_id: "j1",
      version: 1,
      preview_hash: "a".repeat(64),
      preview_expires_at: "2026-09-21T12:00:00.000Z",
      schema_version: 1,
      number_label: "Draft",
      snapshot: {
        business: { business_name: "Co" },
        customer: { name: "Riley" },
        job: { title: "Faucet" },
        payment_instructions: "Net 14.",
        issue_date: "2026-09-21",
        due_date: "2026-10-05",
        lines: [],
        net_cents: 24000,
        tax_cents: 1980,
        total_cents: 25980,
        currency: "USD",
      },
    };
    expect(presentInvoicePreview({ authStatus: "offline_cached", loading: false, confirming: false, issuing: false, preview }).issueDisabled).toBe(
      true,
    );
    expect(
      presentInvoicePreview({
        authStatus: "authenticated",
        loading: false,
        confirming: false,
        issuing: false,
        preview,
        error: { message: "changed", retryable: false, status: 409, code: "PREVIEW_CHANGED" },
      }).kind,
    ).toBe("conflict");
    expect(
      presentInvoicePreview({
        authStatus: "authenticated",
        loading: false,
        confirming: false,
        issuing: false,
        error: { message: "pending", retryable: false, status: 409, code: "UNRESOLVED_CHANGES" },
      }).kind,
    ).toBe("unresolved");
    expect(
      invoiceUnresolvedClientMessage({
        changeDraft: { id: "draft-1", additions_count: 1, reductions_count: 0 },
        latestChange: {
          number: "CO-000001",
          revision_no: 1,
          request_state: "approved",
        },
      }),
    ).toBe(
      "This job has unpublished extra work. Open Extra work to finish sending it for approval, or discard that draft before invoicing.",
    );
    expect(
      invoiceUnresolvedClientMessage({
        changeDraft: { id: "draft-1", additions_count: 0, reductions_count: 0 },
        latestChange: {
          number: "CO-000001",
          revision_no: 1,
          lifecycle: "accepted",
          request_state: "approved",
        },
      }),
    ).toBe("Resolve pending changes or approvals before issuing this invoice.");
    expect(
      invoiceUnresolvedClientMessage({
        latestChange: { number: "CO-000001", revision_no: 1, request_state: "pending" },
      }),
    ).toBe("CO-000001 R1 is still waiting for the customer to approve it. Wait for that decision before invoicing.");
    expect(
      invoiceUnresolvedAction({
        jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        changeDraft: { id: "draft-1", additions_count: 1 },
      }),
    ).toEqual({
      label: "Open extra work",
      path: "/(tabs)/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/change",
    });
    expect(
      invoiceUnresolvedAction({
        jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        changeDraft: { id: "draft-1", additions_count: 0, reductions_count: 0 },
        latestChange: { request_state: "approved", lifecycle: "accepted" },
      }),
    ).toBeUndefined();
  });

  it("derives due dates and status labels without ledger actions", () => {
    expect(dueDateFromOption("2026-09-21", "receipt")).toBe("2026-09-21");
    expect(dueDateFromOption("2026-09-21", "14")).toBe("2026-10-05");
    expect(presentInvoiceStatus("issued_unpaid")).toBe("Issued, unpaid");
    expect(presentInvoiceStatus("partially_paid")).toBe("Partially paid");
    expect(presentInvoiceStatus("settled")).toBe("Settled");
    expect(presentInvoiceStatus("refund_due")).toBe("Amount to refund");
    expect(presentInvoicePdf("preparing").canShare).toBe(false);
    expect(presentInvoicePdf("ready").canShare).toBe(true);
    expect(canRecordRefund("refund_due", 8020)).toBe(true);
    expect(canRecordRefund("partially_paid", 0)).toBe(false);
    const payment = { id: "p1", type: "payment", reverses_entry_id: null };
    const refund = { id: "r1", type: "refund", reverses_entry_id: null };
    const reversal = { id: "x1", type: "reversal", reverses_entry_id: "p1" };
    expect(canReverseLedgerEntry(payment, [payment])).toBe(true);
    expect(canReverseLedgerEntry(payment, [payment, reversal])).toBe(false);
    expect(canReverseLedgerEntry(reversal, [payment, reversal])).toBe(false);
    expect(canReverseLedgerEntry(refund, [payment, refund])).toBe(true);
    expect(presentInvoiceStatus("issued_unpaid", true)).toBe("Voided");
    expect(
      canVoidInvoice({
        lifecycle: "issued",
        credits_cents: 0,
        effective_payments_cents: 0,
        effective_refunds_cents: 0,
      }),
    ).toBe(true);
    expect(
      canVoidInvoice({
        lifecycle: "issued",
        credits_cents: 0,
        effective_payments_cents: 4000,
        effective_refunds_cents: 0,
      }),
    ).toBe(false);
    expect(canReplaceInvoice({ lifecycle: "voided" })).toBe(true);
    expect(canReplaceInvoice({ lifecycle: "issued" })).toBe(false);
  });
});

describe("invoice preview send contract", () => {
  const preview = {
    draft_id: "draft-1",
    snapshot: {
      net_cents: 8000,
      tax_cents: 640,
      total_cents: 8640,
      lines: [
        { discount_cents: 0 },
        { discount_cents: 500 },
      ],
    },
  };

  it("uses server cents and hides a number until the server allocates one", () => {
    expect(invoicePreviewMoney(preview.snapshot)).toEqual({ netCents: 8000, taxCents: 640, totalCents: 8640 });
    expect(formatUsdCents(8640)).toBe("$86.40");
    expect(invoiceDiscountCents(preview.snapshot.lines)).toBe(500);
    expect(invoiceDiscountCents([{ discount_cents: 0 }])).toBeUndefined();
    expect(invoiceAllocatedNumber("Draft")).toBeUndefined();
    expect(invoiceAllocatedNumber(undefined)).toBeUndefined();
    expect(invoiceAllocatedNumber("INV-000003")).toBe("INV-000003");
    expect(invoicePreviewMoney({ net_cents: 1.5, tax_cents: 0, total_cents: 2 })).toBeUndefined();
  });

  it("requires confirmation data and rejects a recipient the server would not accept", () => {
    expect(invoiceRecipientEditable()).toBe(false);
    expect(invoiceIssueBody("a".repeat(64))).toEqual({ preview_hash: "a".repeat(64) });
    expect(invoiceRecipientReview("  owner@example.com ").ok).toBe(true);
    expect(invoiceRecipientReview("").ok).toBe(false);
    expect(invoiceRecipientReview("not-an-email").ok).toBe(false);
    expect(invoiceRecipientReview("bad\u0000@example.com").ok).toBe(false);
    expect(invoiceRecipientReview(`${"a".repeat(250)}@example.com`).ok).toBe(false);
    expect(invoiceContinueBlocked({ offline: true, accessExpired: false, issuing: false, hasPreview: true })).toBe(true);
    expect(invoiceContinueBlocked({ offline: false, accessExpired: false, issuing: true, hasPreview: true })).toBe(true);
    expect(invoiceContinueBlocked({ offline: false, accessExpired: false, issuing: false, hasPreview: true })).toBe(false);
  });

  it("reuses an idempotency key after an ambiguous failure and rotates only on mismatch", () => {
    expect(invoiceIdempotencyAfterFailure("key-1", "UNAVAILABLE")).toBe("key-1");
    expect(invoiceIdempotencyAfterFailure("key-1", "VERSION_CONFLICT")).toBe("key-1");
    expect(invoiceIdempotencyAfterFailure("key-1", "IDEMPOTENCY_MISMATCH")).toBeUndefined();
    expect(invoicePreviewAfterRefresh(preview, undefined, false)).toBe(preview);
    expect(invoiceVisiblePreview("access_expired", preview)).toBeUndefined();
    expect(invoiceVisiblePreview("authenticated", preview)).toBe(preview);
  });

  it("keeps PDF generation separate from email delivery and does not invent a retry", () => {
    expect(invoicePdfPhase("preparing")).toBe("preparing");
    expect(invoicePdfPhase(undefined)).toBe("preparing");
    expect(invoicePdfPhase("ready")).toBe("ready");
    expect(invoicePdfPhase("failed")).toBe("failed");
    expect(invoicePdfRetrySupported()).toBe(false);
    expect(presentInvoicePdf("ready").canShare).toBe(true);
    expect(presentInvoicePdf("failed").canShare).toBe(false);
    expect(invoiceDeliveryPhase("queued")).toBe("queued");
    expect(invoiceDeliveryPhase("accepted_by_provider")).toBe("accepted");
    expect(invoiceDeliveryPhase("delivered")).toBe("delivered");
    expect(invoiceDeliveryPhase("failed")).toBe("failed");
    expect(invoiceDeliveryPhase("not_requested")).toBe("not_requested");
    expect(invoiceAnalyticsProperties()).toEqual({});
    expect(jobDetailPath("job-1")).toBe("/(tabs)/jobs/job-1");
  });
});

describe("invoice detail contract", () => {
  const issued = { id: "inv-1", number: "INV-000003", total_cents: 8640 };

  it("shows the server number and integer total without rewriting a void to zero", () => {
    expect(invoiceDetailTotalCents(8640)).toBe(8640);
    expect(formatUsdCents(8640)).toBe("$86.40");
    expect(invoiceDetailTotalCents(1.5)).toBeUndefined();
    expect(invoiceVoidKeepsOriginal(issued, { ...issued, lifecycle: "voided" } as typeof issued)).toBe(true);
    expect(invoiceDetailBadge({ lifecycle: "issued", deliveryState: "queued" })).toBe("issued");
    expect(invoiceDetailBadge({ lifecycle: "issued", deliveryState: "failed" })).toBe("delivery_failed");
    expect(invoiceDetailBadge({ lifecycle: "voided", voided: true, deliveryState: "failed" })).toBe("voided");
  });

  it("masks the recipient and keeps delivery distinct from a ready PDF", () => {
    expect(invoiceDetailRecipient("owner@example.com")).toBe("o***@example.com");
    expect(invoiceDetailRecipient("")).toBeUndefined();
    expect(invoiceDeliveryPhase("queued")).toBe("queued");
    expect(invoiceDeliveryPhase("delivered")).toBe("delivered");
    expect(invoiceDeliveryPhase("accepted_by_provider")).not.toBe("delivered");
    expect(invoicePdfPhase("ready")).toBe("ready");
    expect(invoicePdfPhase("failed")).toBe("failed");
    expect(invoicePdfPhase("preparing")).toBe("preparing");
    expect(invoicePdfPollContinues("preparing", 19)).toBe(true);
    expect(invoicePdfPollContinues("preparing", 20)).toBe(false);
    expect(invoicePdfPollContinues("ready", 0)).toBe(false);
  });

  it("shows only permitted actions and does not invent a resend", () => {
    expect(invoiceResendSupported()).toBe(false);
    expect(
      invoiceDetailActionVisibility({
        offline: false,
        accessExpired: false,
        voided: false,
        canVoid: true,
        canReplace: false,
        pdfReady: true,
      }),
    ).toEqual({ sendAgain: false, voidInvoice: true, createReplacement: false, viewPdf: true });
    expect(
      invoiceDetailActionVisibility({
        offline: true,
        accessExpired: false,
        voided: true,
        canVoid: false,
        canReplace: true,
        pdfReady: true,
      }).createReplacement,
    ).toBe(false);
    expect(
      invoiceDetailActionVisibility({
        offline: false,
        accessExpired: false,
        voided: true,
        canVoid: false,
        canReplace: true,
        pdfReady: false,
      }).createReplacement,
    ).toBe(true);
    expect(invoiceDetailMutationBlocked({ offline: false, busy: true, permitted: true })).toBe(true);
    expect(invoiceDetailMutationBlocked({ offline: true, busy: false, permitted: true })).toBe(true);
    expect(invoiceIdempotencyAfterFailure("key-1", "UNAVAILABLE")).toBe("key-1");
    expect(invoiceIdempotencyAfterFailure("key-1", "IDEMPOTENCY_MISMATCH")).toBeUndefined();
  });

  it("requires a void reason, keeps the original, and treats replacement as a different invoice", () => {
    expect(invoiceVoidReasonAccepted("Wrong customer email")).toBe(true);
    expect(invoiceVoidReasonAccepted("nope")).toBe(false);
    expect(invoiceVoidReasonAccepted("x".repeat(501))).toBe(false);
    expect(invoiceReplacementIsDistinct(issued, { id: "inv-2", number: "INV-000004" })).toBe(true);
    expect(invoiceReplacementIsDistinct(issued, issued)).toBe(false);
    expect(invoiceDetailActivity({ issuedAt: "2026-09-21T16:18:00.000Z", voided: true })).toEqual([
      { key: "voided" },
      { key: "issued", at: "2026-09-21T16:18:00.000Z" },
    ]);
    expect(invoiceDetailAfterRefresh(issued, undefined, false)).toBe(issued);
    expect(invoiceDetailVisible("access_expired", issued)).toBeUndefined();
    expect(
      presentIssuedCreditNotes([
        { id: "11111111-1111-4111-8111-111111111111", number: "CN-000001", revision_no: 1, total_cents: 2165, pdf_state: "ready" },
        { id: "bad", number: "CN", revision_no: 1, total_cents: 1, pdf_state: "ready" },
      ]),
    ).toEqual([
      { id: "11111111-1111-4111-8111-111111111111", number: "CN-000001", revision_no: 1, total_cents: 2165, pdf_state: "ready" },
    ]);
    expect(creditNotePdfOpenKind("ready", false)).toBe("ready");
    expect(creditNotePdfOpenKind("ready", true)).toBe("offline");
    expect(creditNotePdfOpenKind("failed", false)).toBe("failed");
    expect(creditNotePdfOpenKind("preparing", false)).toBe("preparing");
    expect(
      presentInvoiceMoneyRows({
        credits_cents: 2165,
        net_received_cents: 25980,
        effective_refunds_cents: 0,
        balance_cents: -2165,
      }).map((row) => row.key),
    ).toEqual(["credits", "received", "refunded", "balance"]);
    expect(invoiceDetailLoadKind(404, "NOT_FOUND")).toBe("not_found");
    expect(invoiceDetailLoadKind(403)).toBe("unauthorized");
    expect(invoiceDetailLoadKind(429, "RATE_LIMITED")).toBe("rate_limit");
    expect(invoiceDetailLoadKind(409, "VERSION_CONFLICT")).toBe("conflict");
    expect(invoiceDetailAnalytics()).toEqual({});
    expect(jobDetailPath("job-9")).toBe("/(tabs)/jobs/job-9");
  });
});
