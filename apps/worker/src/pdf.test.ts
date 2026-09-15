import { describe, expect, it, vi } from "vitest";

vi.mock("playwright", () => ({
  chromium: {
    launch: async () => {
      throw new Error("Chromium must not launch in unit tests");
    },
  },
}));

import { buildQuoteSnapshot, renderQuoteOriginalHtml } from "@job-to-invoice/domain";
import { embedInterFonts } from "./pdf.ts";

describe("quote PDF fonts", () => {
  it("embeds Inter Regular, Medium, and Bold as data URIs", () => {
    const { snapshot } = buildQuoteSnapshot({
      business: {
        business_name: "Quote Co",
        legal_name: "Quote Co LLC",
        contact_name: "Owner",
        contact_email: "owner@example.com",
        contact_phone: null,
        address: null,
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
      notes: "",
      terms: "Net 14.",
      expiry_days: 14,
      expiry_local_date: "2026-09-29",
      expiry_timezone: "America/Chicago",
      expires_at: "2026-09-30T04:59:59.000Z",
      issue_date: "2026-09-15",
      lines: [
        {
          client_line_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          description: "Labour hour",
          unit: "hour",
          custom_unit_label: null,
          quantity: "2.5",
          unit_price_cents: 10000,
          discount_cents: 1000,
          tax_bp: 825,
        },
      ],
    });
    const html = embedInterFonts(
      renderQuoteOriginalHtml({
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
      }),
    );
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).toContain("font-weight: 400");
    expect(html).toContain("font-weight: 500");
    expect(html).toContain("font-weight: 700");
    expect(html).not.toMatch(/https?:\/\//);
  });
});
