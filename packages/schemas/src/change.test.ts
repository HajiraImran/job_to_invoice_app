import { describe, expect, it } from "vitest";
import { parseChangeDraft } from "./change.ts";

describe("parseChangeDraft", () => {
  it("accepts an addition-only extra-work draft", () => {
    const parsed = parseChangeDraft({
      reason: "Customer requested a second handle",
      expected_scope_version: 1,
      additions: [
        {
          client_line_id: "11111111-1111-4111-8111-111111111111",
          description: "Second handle",
          unit: "item",
          quantity: "1.000",
          unit_price_cents: 10000,
          discount_cents: 0,
          tax_bp: 825,
        },
      ],
      reductions: [],
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects a non-integer reduction amount", () => {
    const parsed = parseChangeDraft({
      reason: "Reduce unused labour",
      expected_scope_version: 1,
      additions: [],
      reductions: [{ source_line_id: "11111111-1111-4111-8111-111111111111", net_credit_cents: 19.99 }],
    });
    expect(parsed.ok).toBe(false);
  });
});
