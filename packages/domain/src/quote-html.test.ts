import { describe, expect, it } from "vitest";
import {
  discountCentsTotal,
  escapeHtml,
  formatCalendarDate,
  formatTaxBp,
  originalPdfObjectKey,
  renderQuoteOriginalHtml,
} from "./quote-html.ts";
import { buildQuoteSnapshot } from "./snapshot.ts";

const LINE = {
  client_line_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  description: "Labour hour",
  unit: "hour" as const,
  custom_unit_label: null,
  quantity: "2.5",
  unit_price_cents: 10000,
  discount_cents: 1000,
  tax_bp: 825,
};

function f01Document() {
  const { snapshot } = buildQuoteSnapshot({
    business: {
      business_name: "Quote Co",
      legal_name: "Quote Co LLC",
      contact_name: "Owner",
      contact_email: "owner@example.com",
      contact_phone: "+12025550123",
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
    customer: { name: "Riley Chen", email: null, phone: null, billing_address: null },
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
    lines: [LINE],
  });
  return {
    number: "Q-000001",
    revision_no: 1,
    snapshot,
    lines: snapshot.lines.map((line) => ({
      position: line.position,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unit_price_cents: line.unit_price_cents,
      discount_cents: line.discount_cents,
      net_cents: line.net_cents,
      tax_bp: line.tax_bp,
      tax_cents: line.tax_cents,
      total_cents: line.total_cents,
    })),
    net_cents: snapshot.net_cents,
    tax_cents: snapshot.tax_cents,
    total_cents: snapshot.total_cents,
  };
}

describe("quote original HTML", () => {
  it("formats integer money, tax bp, and calendar dates without Date()", () => {
    expect(formatTaxBp(825)).toBe("8.25%");
    expect(formatTaxBp(0)).toBe("0.00%");
    expect(formatCalendarDate("2026-09-15")).toBe("September 15, 2026");
    expect(discountCentsTotal([{ discount_cents: 1000 } as never, { discount_cents: 250 } as never])).toBe(1250);
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("builds a deterministic A4 quote with FIN01 totals and no internal notes", () => {
    const html = renderQuoteOriginalHtml(f01Document());
    expect(html).toContain("lang=\"en\"");
    expect(html).toContain("size: A4 portrait");
    expect(html).toContain("margin: 18mm");
    expect(html).toContain("counter(page)");
    expect(html).toContain("Q-000001");
    expect(html).toContain("R1");
    expect(html).toContain("Quote Co");
    expect(html).toContain("Riley Chen");
    expect(html).toContain("Kitchen faucet");
    expect(html).toContain("$240.00");
    expect(html).toContain("$19.80");
    expect(html).toContain("$259.80");
    expect(html).toContain("$10.00");
    expect(html).toContain("8.25%");
    expect(html).toContain("September 15, 2026");
    expect(html).toContain("September 29, 2026");
    expect(html).toContain("Replace cartridge.");
    expect(html).toContain("Net 14.");
    expect(html).toContain("USD");
    expect(html).not.toMatch(/Rear hose|internal/i);
    expect(html).toBe(renderQuoteOriginalHtml(f01Document()));
  });

  it("uses the canonical private object key and rejects empty sources", () => {
    expect(
      originalPdfObjectKey({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        documentId: "22222222-2222-4222-8222-222222222222",
        revision: 1,
        artifactId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toBe(
      "workspaces/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222/revisions/1/original/33333333-3333-4333-8333-333333333333.pdf",
    );
    expect(() => renderQuoteOriginalHtml({ ...f01Document(), lines: [] })).toThrow(/at least one line/);
  });
});
