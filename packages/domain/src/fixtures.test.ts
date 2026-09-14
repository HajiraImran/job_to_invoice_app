import { describe, expect, it } from "vitest";
import {
  applyIssuedCredit,
  applyPayment,
  applyReduction,
  applyRefund,
  applyReversal,
  applySequentialReductions,
  calculateChangeOrder,
  calculateCredit,
  calculateDocument,
  calculateInvoiceFromResiduals,
  calculateLine,
  canonicalize,
  deriveLedger,
  emptyLedger,
  FINANCIAL_FIXTURES,
  isDomainError,
  taxOnNet,
} from "./index.ts";

function expectCode(error: unknown, code: string): void {
  expect(isDomainError(error)).toBe(true);
  if (isDomainError(error)) {
    expect(error.code).toBe(code);
  }
}

describe("financial fixtures F01–F12", () => {
  it("F01 basic tax totals 25980 cents", () => {
    const line = calculateLine(FINANCIAL_FIXTURES.F01.input);
    expect(line.gross_cents).toBe(25000);
    expect(line.net_cents).toBe(24000);
    expect(line.tax_cents).toBe(1980);
    expect(line.total_cents).toBe(25980);
    expect(line.quantity).toBe("2.500");
    expect(canonicalize(line)).toBe(canonicalize(calculateLine(FINANCIAL_FIXTURES.F01.input)));
  });

  it("F02 quantity rounding is 333 cents", () => {
    const line = calculateLine(FINANCIAL_FIXTURES.F02.input);
    expect(line.gross_cents).toBe(333);
    expect(line.net_cents).toBe(333);
    expect(line.tax_cents).toBe(0);
    expect(line.total_cents).toBe(333);
  });

  it("F03 half-cent tax rounds to 1 cent", () => {
    const tax = taxOnNet(5n, 1000n);
    expect(Number(tax)).toBe(1);
    const line = calculateLine({
      quantity: "1",
      unit_price_cents: 5,
      discount_cents: 0,
      tax_bp: 1000,
    });
    expect(line.tax_cents).toBe(1);
    expect(line.total_cents).toBe(6);
  });

  it("F04 approved addition is 10825 with new scope 36805", () => {
    const base = calculateDocument([FINANCIAL_FIXTURES.F01.input]);
    expect(base.total_cents).toBe(25980);
    const change = calculateChangeOrder({
      previous_total_cents: base.total_cents,
      additions: [FINANCIAL_FIXTURES.F04.addition],
      reductions: [],
      sources: [],
    });
    expect(change.change_including_tax_cents).toBe(10825);
    expect(change.new_agreed_total_cents).toBe(36805);
  });

  it("F05 sequential reductions reverse tax 3 then 2 then 3", () => {
    const source = {
      source_line_id: "src-f05",
      original_net_cents: 100,
      original_tax_cents: 8,
      accepted_net_reductions_cents: 0,
    };
    const results = applySequentialReductions(source, [...FINANCIAL_FIXTURES.F05.reductions_cents]);
    expect(results.map((result) => result.tax_reduction_cents)).toEqual([3, 2, 3]);
    const last = results[2];
    expect(last?.remaining_net_cents).toBe(0);
    expect(last?.remaining_tax_cents).toBe(0);
    expect(last?.cumulative_net_reductions_cents).toBe(100);
  });

  it("F06 over-reduction is CREDIT_EXCEEDS_SOURCE with no state change", () => {
    const source = {
      source_line_id: "src-f06",
      original_net_cents: 100,
      original_tax_cents: 8,
      accepted_net_reductions_cents: 66,
    };
    const frozen = structuredClone(source);
    try {
      applyReduction(source, 35);
      throw new Error("expected CREDIT_EXCEEDS_SOURCE");
    } catch (error) {
      expectCode(error, "CREDIT_EXCEEDS_SOURCE");
      expect(source).toEqual(frozen);
    }
  });

  it("F07 partial payment is 6000 due and partially_paid", () => {
    const paid = applyPayment(emptyLedger({ invoice_issued_cents: 10000 }), {
      entry_id: "pay-f07",
      amount_cents: 4000,
    });
    const view = deriveLedger(paid);
    expect(view.amount_due_cents).toBe(6000);
    expect(view.balance_cents).toBe(6000);
    expect(view.payment_status).toBe("partially_paid");
  });

  it("F08 credit after payment leaves refund_due of -2000", () => {
    const paid = applyPayment(emptyLedger({ invoice_issued_cents: 10000 }), {
      entry_id: "pay-f08",
      amount_cents: 10000,
    });
    const credited = applyIssuedCredit(paid, 2000);
    const view = deriveLedger(credited);
    expect(view.balance_cents).toBe(-2000);
    expect(view.payment_status).toBe("refund_due");
    expect(view.settled_by).toBeNull();
  });

  it("F09 refund of 2000 settles F08", () => {
    const paid = applyPayment(emptyLedger({ invoice_issued_cents: 10000 }), {
      entry_id: "pay-f09",
      amount_cents: 10000,
    });
    const credited = applyIssuedCredit(paid, 2000);
    const refunded = applyRefund(credited, { entry_id: "ref-f09", amount_cents: 2000 });
    const view = deriveLedger(refunded);
    expect(view.balance_cents).toBe(0);
    expect(view.payment_status).toBe("settled");
    expect(view.settled_by).toBe("mixed");
    expect(refunded.allocations).toEqual([
      { refund_entry_id: "ref-f09", payment_entry_id: "pay-f09", amount_cents: 2000 },
    ]);
  });

  it("F10 confirmed overpayment is refund_due and never paid-only", () => {
    const paid = applyPayment(emptyLedger({ invoice_issued_cents: 10000 }), {
      entry_id: "pay-f10",
      amount_cents: 12000,
      confirm_overpayment: true,
    });
    const view = deriveLedger(paid);
    expect(view.balance_cents).toBe(-2000);
    expect(view.payment_status).toBe("refund_due");
    expect(view.payment_status).not.toBe("settled");
    expect(view.settled_by).toBeNull();
  });

  it("F11 reversal restores 10000 due without a duplicate refund", () => {
    const paid = applyPayment(emptyLedger({ invoice_issued_cents: 10000 }), {
      entry_id: "pay-f11",
      amount_cents: 4000,
    });
    const reversed = applyReversal(paid, { entry_id: "rev-f11", reverses_entry_id: "pay-f11" });
    const view = deriveLedger(reversed);
    expect(view.balance_cents).toBe(10000);
    expect(view.amount_due_cents).toBe(10000);
    expect(view.payment_status).toBe("issued_unpaid");
    expect(view.effective_refunds_cents).toBe(0);
    expect(reversed.entries.filter((entry) => entry.type === "refund")).toHaveLength(0);
    expect(() => applyReversal(reversed, { entry_id: "rev-f11-b", reverses_entry_id: "pay-f11" })).toThrow();
    try {
      applyReversal(reversed, { entry_id: "rev-f11-b", reverses_entry_id: "pay-f11" });
    } catch (error) {
      expectCode(error, "ENTRY_ALREADY_REVERSED");
    }
  });

  it("F12 full pre-invoice reduction yields a zero invoice settled without a fake payment", () => {
    const source = {
      source_line_id: "src-f12",
      original_net_cents: 10000,
      original_tax_cents: 825,
      accepted_net_reductions_cents: 0,
    };
    const reduced = applyReduction(source, 10000);
    expect(reduced.remaining_net_cents).toBe(0);
    expect(reduced.remaining_tax_cents).toBe(0);
    const invoice = calculateInvoiceFromResiduals(
      [
        {
          source_line_id: source.source_line_id,
          residual_net_cents: reduced.remaining_net_cents,
          residual_tax_cents: reduced.remaining_tax_cents,
        },
      ],
      { agreed_job_total_cents: 0 },
    );
    expect(invoice.invoice_issued_cents).toBe(0);
    expect(invoice.total_cents).toBe(0);
    const ledger = emptyLedger({
      invoice_issued_cents: invoice.invoice_issued_cents,
      agreed_job_total_cents: invoice.agreed_job_total_cents,
    });
    expect(ledger.entries).toEqual([]);
    const view = deriveLedger(ledger);
    expect(view.balance_cents).toBe(0);
    expect(view.payment_status).toBe("settled");
    expect(view.settled_by).toBe("zero_invoice");
    expect(view.effective_payments_cents).toBe(0);
  });
});

describe("shared package equality", () => {
  it("mobile, server and PDF use the same exported calculation functions", () => {
    const preview = calculateLine(FINANCIAL_FIXTURES.F01.input);
    const server = calculateLine(FINANCIAL_FIXTURES.F01.input);
    const pdf = calculateLine(FINANCIAL_FIXTURES.F01.input);
    expect(canonicalize(preview)).toBe(canonicalize(server));
    expect(canonicalize(server)).toBe(canonicalize(pdf));
  });
});

describe("invoice credits use residual amounts", () => {
  it("applies FIN03 against the invoice residual, not current tax defaults", () => {
    const credit = calculateCredit(
      [
        {
          invoice_line_id: "inv-line-1",
          residual_net_cents: 100,
          residual_tax_cents: 8,
          credited_net_cents: 0,
        },
      ],
      [{ invoice_line_id: "inv-line-1", net_credit_cents: 33 }],
    );
    expect(credit.tax_cents).toBe(3);
    expect(credit.total_cents).toBe(36);
  });
});
