import { describe, expect, it } from "vitest";
import { calculateInvoiceFromResiduals } from "./invoice.ts";

describe("invoice residuals", () => {
  it("includes a $100 extra once and totals $185.68", () => {
    const totals = calculateInvoiceFromResiduals(
      [
        { source_line_id: "quote-hhj", residual_net_cents: 300, residual_tax_cents: 18 },
        { source_line_id: "quote-testing", residual_net_cents: 7500, residual_tax_cents: 750 },
        { source_line_id: "change-hjk", residual_net_cents: 10000, residual_tax_cents: 0 },
      ],
      { agreed_job_total_cents: 18568 },
    );
    expect(totals.lines).toHaveLength(3);
    expect(totals.lines.filter((line) => line.net_cents === 10000)).toHaveLength(1);
    expect(totals.lines[2]).toMatchObject({
      source_line_id: "change-hjk",
      net_cents: 10000,
      tax_cents: 0,
      total_cents: 10000,
    });
    expect(totals.net_cents).toBe(17800);
    expect(totals.tax_cents).toBe(768);
    expect(totals.total_cents).toBe(18568);
  });
});
