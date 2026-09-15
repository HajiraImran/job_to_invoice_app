import { describe, expect, it } from "vitest";
import {
  MAX_LINES,
  applyIssuedCredit,
  applyPayment,
  applyReduction,
  applyRefund,
  applyReversal,
  calculateChangeOrder,
  calculateCredit,
  calculateDocument,
  calculateDraftDocument,
  calculateInvoiceFromResiduals,
  calculateLine,
  canonicalize,
  deriveLedger,
  emptyLedger,
  isDomainError,
  parseQuantity,
  usdCents,
} from "./index.ts";

function expectCode(error: unknown, code: string): void {
  expect(isDomainError(error)).toBe(true);
  if (isDomainError(error)) {
    expect(error.code).toBe(code);
  }
}

describe("quantity and amount boundaries", () => {
  it("rejects locale-formatted and over-precise quantities", () => {
    for (const quantity of ["1,000", "1.", ".5", "00.1", "1.0000", "2.5e1", "1 000", "-1", "0", "1000000", ""]) {
      expect(() => parseQuantity(quantity)).toThrow(/Quantity|quantity/i);
    }
  });

  it("accepts the maximum quantity and serializes three decimal places", () => {
    const line = calculateLine({
      quantity: "999999.999",
      unit_price_cents: 1,
      discount_cents: 0,
      tax_bp: 0,
    });
    expect(line.quantity).toBe("999999.999");
    expect(line.gross_cents).toBe(1000000);
  });

  it("accepts a free line but rejects a quote with no positive net", () => {
    const free = calculateLine({
      quantity: "1.000",
      unit_price_cents: 0,
      discount_cents: 0,
      tax_bp: 0,
    });
    expect(free.net_cents).toBe(0);
    expect(free.total_cents).toBe(0);
    expect(() =>
      calculateDocument([
        { quantity: "1", unit_price_cents: 0, discount_cents: 0, tax_bp: 0 },
      ]),
    ).toThrow(/positive net/);
    const mixed = calculateDocument([
      { quantity: "1", unit_price_cents: 0, discount_cents: 0, tax_bp: 0 },
      { quantity: "1", unit_price_cents: 100, discount_cents: 0, tax_bp: 0 },
    ]);
    expect(mixed.net_cents).toBe(100);
  });

  it("allows empty and zero-net drafts without changing publish-positive-net rules", () => {
    const empty = calculateDraftDocument([]);
    expect(empty.net_cents).toBe(0);
    expect(empty.total_cents).toBe(0);
    expect(empty.lines).toEqual([]);
    const freeDraft = calculateDraftDocument([{ quantity: "1", unit_price_cents: 0, discount_cents: 0, tax_bp: 0 }]);
    expect(freeDraft.net_cents).toBe(0);
    expect(freeDraft.total_cents).toBe(0);
  });

  it("rejects a discount above rounded gross and tax above 2500 bp", () => {
    expect(() =>
      calculateLine({ quantity: "1", unit_price_cents: 100, discount_cents: 101, tax_bp: 0 }),
    ).toThrow(/discount/i);
    expect(() =>
      calculateLine({ quantity: "1", unit_price_cents: 100, discount_cents: 0, tax_bp: 2501 }),
    ).toThrow(/basis points/i);
    const maxRate = calculateLine({ quantity: "1", unit_price_cents: 100, discount_cents: 0, tax_bp: 2500 });
    expect(maxRate.tax_cents).toBe(25);
  });

  it("rejects non-integer money inputs and branded float cents", () => {
    expect(() => usdCents(19.99)).toThrow(/integer cents/);
    expect(() =>
      calculateLine({ quantity: "1", unit_price_cents: 10.5, discount_cents: 0, tax_bp: 0 }),
    ).toThrow(/integer USD cents/);
  });

  it("rounds exact half cents up at tax and gross edges", () => {
    const halfTax = calculateLine({ quantity: "1", unit_price_cents: 2, discount_cents: 0, tax_bp: 2500 });
    expect(halfTax.tax_cents).toBe(1);
    const halfGross = calculateLine({ quantity: "0.001", unit_price_cents: 500, discount_cents: 0, tax_bp: 0 });
    expect(halfGross.gross_cents).toBe(1);
    const belowHalfGross = calculateLine({
      quantity: "0.001",
      unit_price_cents: 499,
      discount_cents: 0,
      tax_bp: 0,
    });
    expect(belowHalfGross.gross_cents).toBe(0);
  });

  it("rejects more than 100 lines and totals above 999999999 cents", () => {
    const lines = Array.from({ length: MAX_LINES + 1 }, () => ({
      quantity: "1",
      unit_price_cents: 1,
      discount_cents: 0,
      tax_bp: 0,
    }));
    expect(() => calculateDocument(lines)).toThrow(/100 lines/);
    const heavy = Array.from({ length: 100 }, () => ({
      quantity: "1",
      unit_price_cents: 10_000_000,
      discount_cents: 0,
      tax_bp: 0,
    }));
    expect(() => calculateDocument(heavy)).toThrow(/999999999/);
    const atCap = calculateDocument([
      { quantity: "10", unit_price_cents: 99_999_999, discount_cents: 0, tax_bp: 0 },
      { quantity: "1", unit_price_cents: 9, discount_cents: 0, tax_bp: 0 },
    ]);
    expect(atCap.total_cents).toBe(999_999_999);
  });

  it("uses integer cents for a quantity times price that would overflow Number", () => {
    expect(() =>
      calculateLine({
        quantity: "999999.999",
        unit_price_cents: 99_999_999,
        discount_cents: 0,
        tax_bp: 0,
      }),
    ).toThrow(/exceeds 999999999/);
  });
});

describe("reduction, credit and allocation boundaries", () => {
  it("rejects reducing a zero-net source and a job total below zero", () => {
    expect(() =>
      applyReduction(
        { source_line_id: "z", original_net_cents: 0, original_tax_cents: 0, accepted_net_reductions_cents: 0 },
        1,
      ),
    ).toThrow(/zero net/);
    expect(() =>
      calculateChangeOrder({
        previous_total_cents: 100,
        additions: [],
        reductions: [{ source_line_id: "src", net_credit_cents: 101 }],
        sources: [
          { source_line_id: "src", original_net_cents: 200, original_tax_cents: 0, accepted_net_reductions_cents: 0 },
        ],
      }),
    ).toThrow(/below zero/);
  });

  it("rejects a cross-document reduction or credit allocation", () => {
    expect(() =>
      calculateChangeOrder({
        previous_total_cents: 1000,
        additions: [],
        reductions: [{ source_line_id: "other-job", net_credit_cents: 1 }],
        sources: [
          { source_line_id: "this-job", original_net_cents: 1000, original_tax_cents: 0, accepted_net_reductions_cents: 0 },
        ],
      }),
    ).toThrow(/this job/);
    expect(() =>
      calculateCredit(
        [
          {
            invoice_line_id: "inv-a",
            residual_net_cents: 5000,
            residual_tax_cents: 0,
            credited_net_cents: 0,
          },
        ],
        [{ invoice_line_id: "inv-b", net_credit_cents: 1 }],
      ),
    ).toThrow(/this invoice/);
  });

  it("caps cumulative invoice credits and rejects a further 1 cent", () => {
    const line = {
      invoice_line_id: "inv-1",
      residual_net_cents: 10000,
      residual_tax_cents: 0,
      credited_net_cents: 0,
    };
    const first = calculateCredit([line], [{ invoice_line_id: "inv-1", net_credit_cents: 4000 }]);
    const second = calculateCredit(
      [{ ...line, credited_net_cents: 4000 }],
      [{ invoice_line_id: "inv-1", net_credit_cents: 4000 }],
    );
    const third = calculateCredit(
      [{ ...line, credited_net_cents: 8000 }],
      [{ invoice_line_id: "inv-1", net_credit_cents: 2000 }],
    );
    expect(first.net_cents + second.net_cents + third.net_cents).toBe(10000);
    try {
      calculateCredit(
        [{ ...line, credited_net_cents: 10000 }],
        [{ invoice_line_id: "inv-1", net_credit_cents: 1 }],
      );
      throw new Error("expected CREDIT_EXCEEDS_SOURCE");
    } catch (error) {
      expectCode(error, "CREDIT_EXCEEDS_SOURCE");
    }
  });

  it("rejects overpayment without confirmation, over-refund, and refund on a positive balance", () => {
    const invoice = emptyLedger({ invoice_issued_cents: 10000 });
    try {
      applyPayment(invoice, { entry_id: "p1", amount_cents: 12000 });
      throw new Error("expected validation");
    } catch (error) {
      expectCode(error, "VALIDATION_FAILED");
    }
    const paid = applyPayment(invoice, { entry_id: "p1", amount_cents: 10000 });
    const credited = applyIssuedCredit(paid, 2000);
    try {
      applyRefund(credited, { entry_id: "r1", amount_cents: 2001 });
      throw new Error("expected REFUND_EXCEEDS_BALANCE");
    } catch (error) {
      expectCode(error, "REFUND_EXCEEDS_BALANCE");
    }
    const partial = applyPayment(invoice, { entry_id: "p2", amount_cents: 4000 });
    try {
      applyRefund(partial, { entry_id: "r2", amount_cents: 1 });
      throw new Error("expected REFUND_EXCEEDS_BALANCE");
    } catch (error) {
      expectCode(error, "REFUND_EXCEEDS_BALANCE");
    }
  });

  it("allocates refunds oldest-first across two payments", () => {
    let state = emptyLedger({ invoice_issued_cents: 10000 });
    state = applyPayment(state, { entry_id: "p-old", amount_cents: 3000 });
    state = applyPayment(state, { entry_id: "p-new", amount_cents: 7000 });
    state = applyIssuedCredit(state, 4000);
    state = applyRefund(state, { entry_id: "r-split", amount_cents: 4000 });
    expect(state.allocations).toEqual([
      { refund_entry_id: "r-split", payment_entry_id: "p-old", amount_cents: 3000 },
      { refund_entry_id: "r-split", payment_entry_id: "p-new", amount_cents: 1000 },
    ]);
  });

  it("blocks reversing a payment that still has a dependent refund", () => {
    let state = applyPayment(emptyLedger({ invoice_issued_cents: 10000 }), {
      entry_id: "p-dep",
      amount_cents: 10000,
    });
    state = applyIssuedCredit(state, 2000);
    state = applyRefund(state, { entry_id: "r-dep", amount_cents: 2000 });
    expect(() => applyReversal(state, { entry_id: "rev-p", reverses_entry_id: "p-dep" })).toThrow(
      /dependent refunds/,
    );
    const afterRefundReversal = applyReversal(state, { entry_id: "rev-r", reverses_entry_id: "r-dep" });
    const afterPayReversal = applyReversal(afterRefundReversal, {
      entry_id: "rev-p",
      reverses_entry_id: "p-dep",
    });
    expect(deriveLedger(afterPayReversal).balance_cents).toBe(8000);
  });

  it("treats credit-to-zero as settled by credit, not paid", () => {
    const credited = applyIssuedCredit(emptyLedger({ invoice_issued_cents: 5000 }), 5000);
    const view = deriveLedger(credited);
    expect(view.balance_cents).toBe(0);
    expect(view.payment_status).toBe("settled");
    expect(view.settled_by).toBe("credit");
    expect(view.effective_payments_cents).toBe(0);
  });

  it("marks overdue only when a positive balance has a due date before as_of", () => {
    const state = emptyLedger({ invoice_issued_cents: 1000, due_date: "2026-09-13" });
    expect(deriveLedger(state, { as_of_date: "2026-09-13" }).payment_status).toBe("issued_unpaid");
    expect(deriveLedger(state, { as_of_date: "2026-09-14" }).payment_status).toBe("overdue");
  });

  it("never clamps a negative balance with max(0)", () => {
    const view = deriveLedger(
      applyPayment(emptyLedger({ invoice_issued_cents: 10000 }), {
        entry_id: "over",
        amount_cents: 12000,
        confirm_overpayment: true,
      }),
    );
    expect(view.balance_cents).toBe(-2000);
    expect(view.amount_due_cents).toBe(0);
    expect(view.amount_to_refund_cents).toBe(2000);
  });

  it("requires a written reason for a zero-value replacement change", () => {
    expect(() =>
      calculateChangeOrder({
        previous_total_cents: 1000,
        additions: [{ quantity: "1", unit_price_cents: 1000, discount_cents: 0, tax_bp: 0 }],
        reductions: [{ source_line_id: "src", net_credit_cents: 1000 }],
        sources: [
          { source_line_id: "src", original_net_cents: 1000, original_tax_cents: 0, accepted_net_reductions_cents: 0 },
        ],
      }),
    ).toThrow(/written reason/);
    const replacement = calculateChangeOrder({
      previous_total_cents: 1000,
      additions: [{ quantity: "1", unit_price_cents: 1000, discount_cents: 0, tax_bp: 0 }],
      reductions: [{ source_line_id: "src", net_credit_cents: 1000 }],
      sources: [
        { source_line_id: "src", original_net_cents: 1000, original_tax_cents: 0, accepted_net_reductions_cents: 0 },
      ],
      reason: "Replace handle with equivalent item",
    });
    expect(replacement.change_including_tax_cents).toBe(0);
    expect(replacement.new_agreed_total_cents).toBe(1000);
  });

  it("snapshots residual invoice amounts without recalculating from a new tax rate", () => {
    const invoice = calculateInvoiceFromResiduals(
      [{ source_line_id: "s1", residual_net_cents: 10000, residual_tax_cents: 1 }],
      { agreed_job_total_cents: 25980 },
    );
    expect(invoice.tax_cents).toBe(1);
    expect(invoice.agreed_job_total_cents).toBe(25980);
    expect(invoice.invoice_issued_cents).toBe(10001);
    expect(invoice.credits_cents).toBe(0);
  });

  it("serializes calculation results with sorted keys, three-place quantities and integer cents", () => {
    const line = calculateLine({
      quantity: "2.5",
      unit_price_cents: 10000,
      discount_cents: 1000,
      tax_bp: 825,
    });
    const json = canonicalize(line);
    const parsed: unknown = JSON.parse(json);
    expect(json).toContain('"quantity":"2.500"');
    expect(json).toContain('"total_cents":25980');
    expect(json.indexOf("client_line_id")).toBeLessThan(json.indexOf("discount_cents"));
    expect(parsed).toMatchObject({ schema_version: 1, total_cents: 25980, quantity: "2.500" });
    expect(Object.keys(parsed as object)).toEqual([...Object.keys(parsed as object)].sort());
  });
});
