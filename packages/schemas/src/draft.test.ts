import { describe, expect, it } from "vitest";
import {
  dollarsStringToCents,
  formatUsdCents,
  parseDraftPayload,
} from "./draft.ts";

function validLine(overrides: Record<string, unknown> = {}) {
  return {
    client_line_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    description: "Labour hour",
    unit: "hour",
    quantity: "2.5",
    unit_price_cents: 10000,
    discount_cents: 1000,
    tax_bp: 825,
    ...overrides,
  };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    notes: "Scope note",
    terms: "Net 14.",
    expiry_days: 14,
    lines: [validLine()],
    ...overrides,
  };
}

describe("VAL03 draft payload", () => {
  it("accepts a complete quote line and trims notes", () => {
    const parsed = parseDraftPayload(validPayload({ notes: "  Scope  " }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.notes).toBe("Scope");
      expect(parsed.value.lines[0]?.quantity).toBe("2.5");
      expect(parsed.value.lines[0]?.unit_price_cents).toBe(10000);
    }
  });

  it("allows an empty draft and omitted optional notes", () => {
    const empty = parseDraftPayload({ lines: [] });
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value.lines).toEqual([]);
      expect(empty.value.expiry_days).toBe(14);
      expect(empty.value.notes).toBe("");
    }
  });

  it("rejects calculated totals, tenant fields, and unknown line fields", () => {
    const totals = parseDraftPayload(validPayload({ total_cents: 25980 }));
    expect(totals.ok).toBe(false);
    if (!totals.ok) {
      expect(totals.field_errors.some((item) => item.field === "total_cents")).toBe(true);
    }
    const tenant = parseDraftPayload(validPayload({ workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    expect(tenant.ok).toBe(false);
    const extra = parseDraftPayload(validPayload({ lines: [validLine({ gross_cents: 1 })] }));
    expect(extra.ok).toBe(false);
  });

  it("rejects description, unit, quantity, price, discount, tax, and line-count bounds", () => {
    expect(parseDraftPayload(validPayload({ lines: [validLine({ description: "" })] })).ok).toBe(false);
    expect(parseDraftPayload(validPayload({ lines: [validLine({ description: "A".repeat(501) })] })).ok).toBe(false);
    expect(parseDraftPayload(validPayload({ lines: [validLine({ unit: "box" })] })).ok).toBe(false);
    expect(parseDraftPayload(validPayload({ lines: [validLine({ quantity: "1,000" })] })).ok).toBe(false);
    expect(parseDraftPayload(validPayload({ lines: [validLine({ quantity: "0" })] })).ok).toBe(false);
    expect(parseDraftPayload(validPayload({ lines: [validLine({ unit_price_cents: 19.99 })] })).ok).toBe(false);
    expect(parseDraftPayload(validPayload({ lines: [validLine({ unit_price_cents: 100_000_000 })] })).ok).toBe(false);
    expect(parseDraftPayload(validPayload({ lines: [validLine({ discount_cents: -1 })] })).ok).toBe(false);
    expect(parseDraftPayload(validPayload({ lines: [validLine({ tax_bp: 2501 })] })).ok).toBe(false);
    expect(parseDraftPayload(validPayload({ expiry_days: 0 })).ok).toBe(false);
    expect(parseDraftPayload(validPayload({ expiry_days: 91 })).ok).toBe(false);
    expect(
      parseDraftPayload({
        lines: Array.from({ length: 101 }, (_, i) =>
          validLine({ client_line_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}` }),
        ),
      }).ok,
    ).toBe(false);
  });

  it("requires a custom unit label only for custom units and unique line ids", () => {
    const missing = parseDraftPayload(validPayload({ lines: [validLine({ unit: "custom" })] }));
    expect(missing.ok).toBe(false);
    const custom = parseDraftPayload(
      validPayload({ lines: [validLine({ unit: "custom", custom_unit_label: "sheet" })] }),
    );
    expect(custom.ok).toBe(true);
    const duplicate = parseDraftPayload({
      lines: [validLine(), validLine({ description: "Other" })],
    });
    expect(duplicate.ok).toBe(false);
  });
});

describe("integer cents display helpers", () => {
  it("converts dollar strings without floats and formats cents", () => {
    expect(dollarsStringToCents("100.00")).toEqual({ ok: true, value: 10000 });
    expect(dollarsStringToCents("10.5")).toEqual({ ok: true, value: 1050 });
    expect(dollarsStringToCents("19.99")).toEqual({ ok: true, value: 1999 });
    expect(dollarsStringToCents("19.9.9").ok).toBe(false);
    expect(formatUsdCents(25980)).toBe("$259.80");
    expect(formatUsdCents(0)).toBe("$0.00");
    expect(() => formatUsdCents(19.99)).toThrow(/integer cents/);
  });
});
