import { describe, expect, it } from "vitest";
import { canonicalizeToBytes } from "./canonicalize.ts";
import { calculateInvoiceFromResiduals } from "./invoice.ts";
import { renderInvoiceOriginalHtml } from "./invoice-html.ts";
import { buildInvoiceSnapshot, buildQuoteSnapshot } from "./snapshot.ts";

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

function quoteSnapshot() {
  return buildQuoteSnapshot({
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
    customer: { name: "Riley Chen", email: "customer@example.com", phone: null, billing_address: null },
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
  }).snapshot;
}

describe("invoice snapshot and original HTML", () => {
  it("builds residual invoice lines matching the accepted quote F01 totals", () => {
    const quote = quoteSnapshot();
    const residuals = calculateInvoiceFromResiduals(
      quote.lines.map((line) => ({
        source_line_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        residual_net_cents: line.net_cents,
        residual_tax_cents: line.tax_cents,
      })),
      { agreed_job_total_cents: quote.total_cents },
    );
    expect(residuals.net_cents).toBe(24000);
    expect(residuals.tax_cents).toBe(1980);
    expect(residuals.total_cents).toBe(25980);
    const snapshot = buildInvoiceSnapshot({
      business: quote.business,
      customer: quote.customer,
      job: quote.job,
      notes: quote.notes,
      payment_instructions: "Net 14.",
      issue_date: "2026-09-21",
      due_date: "2026-10-05",
      source_quote_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      source_quote_number: "Q-000001",
      lines: quote.lines.map((line, index) => ({
        ...line,
        source_line_id: residuals.lines[index]?.source_line_id ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        net_cents: residuals.lines[index]?.net_cents ?? line.net_cents,
        tax_cents: residuals.lines[index]?.tax_cents ?? line.tax_cents,
        total_cents: residuals.lines[index]?.total_cents ?? line.total_cents,
      })),
      net_cents: residuals.net_cents,
      tax_cents: residuals.tax_cents,
      total_cents: residuals.total_cents,
      tax_by_rate: quote.tax_by_rate,
    });
    expect(snapshot.kind).toBe("invoice");
    expect(JSON.stringify(snapshot)).not.toContain("INV-");
    const bytes = canonicalizeToBytes(snapshot);
    expect(bytes.byteLength).toBeGreaterThan(32);
    const html = renderInvoiceOriginalHtml({
      number: "INV-000001",
      revision_no: 1,
      snapshot,
      lines: snapshot.lines.map((line) => ({
        position: line.position,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        custom_unit_label: line.custom_unit_label,
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
    });
    expect(html).toContain("$259.80");
    expect(html).toContain("INV-000001");
    expect(html).toContain("Payment instructions");
    expect(html).not.toContain("Review quote");
  });
});
