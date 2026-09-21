import { describe, expect, it } from "vitest";
import { parseLedgerPayment, parseLedgerRefund, parseLedgerReverse } from "./ledger.ts";

describe("ledger request bodies", () => {
  it("requires integer cents, a calendar date, and a method", () => {
    expect(
      parseLedgerPayment({
        amount_cents: 4000,
        effective_date: "2026-09-21",
        method: "cash",
      }).ok,
    ).toBe(true);
    expect(parseLedgerPayment({ amount_cents: 12.5, effective_date: "2026-09-21", method: "cash" }).ok).toBe(false);
    expect(parseLedgerPayment({ amount_cents: 4000, effective_date: "09/21/2026", method: "cash" }).ok).toBe(false);
    expect(parseLedgerPayment({ amount_cents: 4000, effective_date: "2026-09-21", method: "venmo" }).ok).toBe(false);
    expect(
      parseLedgerPayment({
        amount_cents: 4000,
        effective_date: "2026-09-21",
        method: "cash",
        paid: true,
      }).ok,
    ).toBe(false);
  });

  it("defaults confirm_overpayment to false and rejects it on refunds", () => {
    const payment = parseLedgerPayment({
      amount_cents: 12000,
      effective_date: "2026-09-21",
      method: "check",
      reference: "1001",
    });
    expect(payment.ok && payment.value.confirm_overpayment).toBe(false);
    expect(
      parseLedgerRefund({
        amount_cents: 2000,
        effective_date: "2026-09-21",
        method: "bank_transfer",
        confirm_overpayment: true,
      }).ok,
    ).toBe(false);
  });

  it("requires a 5 to 500 character reversal reason and rejects unknown fields", () => {
    expect(parseLedgerReverse({ reason: "Typed wrong amount" }).ok).toBe(true);
    expect(parseLedgerReverse({ reason: "nope" }).ok).toBe(false);
    expect(parseLedgerReverse({ reason: "Typed wrong amount", amount_cents: 4000 }).ok).toBe(false);
  });
});
