import { describe, expect, it } from "vitest";
import {
  parseDirectInvoiceDraft,
  parseInvoiceIssue,
  parseInvoicePreview,
  parseInvoiceReplacementPreview,
  parseInvoiceVoid,
} from "./invoice.ts";

describe("invoice request bodies", () => {
  it("rejects unknown preview fields and invalid due dates", () => {
    expect(parseInvoicePreview({ due_date: "2026-09-21" }).ok).toBe(true);
    expect(parseInvoicePreview({ total_cents: 1 }).ok).toBe(false);
    expect(parseInvoicePreview({ due_date: "09/21/2026" }).ok).toBe(false);
    expect(parseInvoicePreview({ due_date: "2026-02-31" }).ok).toBe(false);
  });

  it("requires a preview hash on issue and rejects line writes", () => {
    expect(parseInvoiceIssue({ preview_hash: "a".repeat(64) }).ok).toBe(true);
    expect(parseInvoiceIssue({ preview_hash: "zz" }).ok).toBe(false);
    expect(parseInvoiceIssue({ preview_hash: "a".repeat(64), net_cents: 1 }).ok).toBe(false);
  });

  it("requires a void reason and rejects amount fields", () => {
    expect(parseInvoiceVoid({ reason: "Wrong customer email" }).ok).toBe(true);
    expect(parseInvoiceVoid({ reason: "nope" }).ok).toBe(false);
    expect(parseInvoiceVoid({ reason: "Wrong customer email", total_cents: 1 }).ok).toBe(false);
  });

  it("allows typographical replacement fields and rejects amount changes", () => {
    expect(parseInvoiceReplacementPreview({}).ok).toBe(true);
    expect(parseInvoiceReplacementPreview({ customer: { name: "Riley Chen", email: "new@example.com" } }).ok).toBe(true);
    expect(parseInvoiceReplacementPreview({ net_cents: 1 }).ok).toBe(false);
    expect(parseInvoiceReplacementPreview({ customer: { name: "Riley", total_cents: 1 } }).ok).toBe(false);
  });

  it("parses a direct invoice draft and rejects floats or missing acknowledgement", () => {
    const line = {
      client_line_id: "11111111-1111-4111-8111-111111111111",
      description: "Completed work",
      unit: "item",
      quantity: "1",
      unit_price_cents: 10000,
      discount_cents: 0,
      tax_bp: 0,
    };
    expect(
      parseDirectInvoiceDraft({
        direct_invoice: true,
        issue_acknowledgement: true,
        due_date: "2026-10-05",
        payment_instructions: "Due on receipt.",
        lines: [line],
      }).ok,
    ).toBe(true);
    expect(
      parseDirectInvoiceDraft({
        direct_invoice: true,
        issue_acknowledgement: true,
        due_date: "2026-10-05",
        payment_instructions: "Due on receipt.",
        lines: [{ ...line, unit_price_cents: 10.5 }],
      }).ok,
    ).toBe(false);
    expect(
      parseDirectInvoiceDraft({
        direct_invoice: true,
        due_date: "2026-10-05",
        payment_instructions: "Due on receipt.",
        lines: [line],
      }).ok,
    ).toBe(false);
    expect(parseDirectInvoiceDraft({ direct_invoice: true, issue_acknowledgement: true, total_cents: 1 }).ok).toBe(
      false,
    );
  });
});
