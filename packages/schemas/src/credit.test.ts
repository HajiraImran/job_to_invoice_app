import { describe, expect, it } from "vitest";
import { parseCreditIssue, parseCreditPreview } from "./credit.ts";

describe("credit request bodies", () => {
  it("requires a reason and integer-cent allocations", () => {
    const parsed = parseCreditPreview({
      reason: "Billing correction after overbilling labour",
      allocations: [{ invoice_line_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", net_credit_cents: 2000 }],
    });
    expect(parsed.ok).toBe(true);
    expect(parseCreditPreview({ reason: "nope", allocations: [{ invoice_line_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", net_credit_cents: 2000 }] }).ok).toBe(false);
    expect(
      parseCreditPreview({
        reason: "Billing correction after overbilling labour",
        allocations: [{ invoice_line_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", net_credit_cents: 20.5 }],
      }).ok,
    ).toBe(false);
    expect(parseCreditIssue({ preview_hash: "a".repeat(64) }).ok).toBe(true);
    expect(parseCreditIssue({ preview_hash: "a".repeat(64), extra: true }).ok).toBe(false);
  });
});
