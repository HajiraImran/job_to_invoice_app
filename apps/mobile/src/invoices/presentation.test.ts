import { describe, expect, it } from "vitest";
import {
  canRecordRefund,
  canReplaceInvoice,
  canReverseLedgerEntry,
  canVoidInvoice,
  dueDateFromOption,
  presentInvoicePdf,
  presentInvoicePreview,
  presentInvoiceStatus,
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
