import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize.ts";
import { buildQuoteSnapshot, formatDocumentNumber, lineCountBucket } from "./snapshot.ts";

const F01_LINE = {
  client_line_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  description: "Labour hour",
  unit: "hour",
  custom_unit_label: null,
  quantity: "2.5",
  unit_price_cents: 10000,
  discount_cents: 1000,
  tax_bp: 825,
};

describe("quote snapshot", () => {
  it("allocates canonical quote numbers and buckets line counts", () => {
    expect(formatDocumentNumber("quote", 1)).toBe("Q-000001");
    expect(formatDocumentNumber("quote", 12)).toBe("Q-000012");
    expect(lineCountBucket(1)).toBe("1");
    expect(lineCountBucket(4)).toBe("2_to_5");
    expect(lineCountBucket(20)).toBe("6_to_20");
    expect(lineCountBucket(21)).toBe("21_to_100");
  });

  it("freezes FIN01 totals and sorted canonical keys without a quote number", () => {
    const { snapshot, totals } = buildQuoteSnapshot({
      business: {
        business_name: "Quote Co",
        legal_name: "Quote Co LLC",
        contact_name: "Owner",
        contact_email: "owner@example.com",
        contact_phone: null,
        address: {
          line1: "123 Main Street",
          line2: null,
          city: "Austin",
          state: "TX",
          postal_code: "78701",
        },
        timezone: "America/Chicago",
        default_tax_bp: 0,
      },
      customer: {
        name: "Riley Chen",
        email: null,
        phone: null,
        billing_address: null,
      },
      job: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        title: "Kitchen faucet",
        site_address: null,
        no_site: true,
      },
      notes: "Replace cartridge.",
      terms: "Net 14.",
      expiry_days: 14,
      expiry_local_date: "2026-09-29",
      expiry_timezone: "America/Chicago",
      expires_at: "2026-09-30T04:59:59.000Z",
      issue_date: "2026-09-15",
      lines: [F01_LINE],
    });
    expect(totals.net_cents).toBe(24000);
    expect(totals.tax_cents).toBe(1980);
    expect(totals.total_cents).toBe(25980);
    expect(snapshot.currency).toBe("USD");
    expect(snapshot.lines[0]?.quantity).toBe("2.500");
    const json = canonicalize(snapshot);
    expect(json.startsWith("{")).toBe(true);
    expect(json.includes("\"kind\":\"quote\"")).toBe(true);
    expect(json.includes("Q-")).toBe(false);
    expect(json.includes("issued_at")).toBe(false);
  });

  it("rejects an empty quote snapshot", () => {
    expect(() =>
      buildQuoteSnapshot({
        business: {
          business_name: "Quote Co",
          legal_name: "Quote Co LLC",
          contact_name: "Owner",
          contact_email: "owner@example.com",
          contact_phone: null,
          address: null,
          timezone: "UTC",
          default_tax_bp: 0,
        },
        customer: { name: "Riley", email: null, phone: null, billing_address: null },
        job: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Job", site_address: null, no_site: true },
        notes: "",
        terms: "",
        expiry_days: 14,
        expiry_local_date: "2026-09-29",
        expiry_timezone: "UTC",
        expires_at: "2026-09-29T23:59:59.000Z",
        issue_date: "2026-09-15",
        lines: [],
      }),
    ).toThrow(/at least one line/);
  });
});
