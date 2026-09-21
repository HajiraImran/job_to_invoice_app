import { describe, expect, it } from "vitest";
import { renderCreditOriginalHtml } from "./credit-html.ts";
import { buildCreditSnapshot } from "./snapshot.ts";

describe("credit original HTML", () => {
  it("renders the issued credit number, reason, and no-refund wording", () => {
    const snapshot = buildCreditSnapshot({
      business: {
        business_name: "Invoice Co",
        legal_name: "Invoice Co LLC",
        contact_name: "Owner I",
        contact_email: "owner.i@example.com",
        contact_phone: "+12025550123",
        address: null,
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
      reason: "Billing correction after a scope change",
      issue_date: "2026-09-21",
      invoice_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      invoice_number: "INV-000002",
      lines: [
        {
          position: 1,
          invoice_line_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          description: "Labour hour",
          net_credit_cents: 2000,
          tax_credit_cents: 165,
          total_cents: 2165,
        },
      ],
      net_cents: 2000,
      tax_cents: 165,
      total_cents: 2165,
    });
    const html = renderCreditOriginalHtml({
      number: "CN-000001",
      revision_no: 1,
      snapshot,
      net_cents: 2000,
      tax_cents: 165,
      total_cents: 2165,
    });
    expect(html).toContain("Credit note CN-000001");
    expect(html).toContain("INV-000002");
    expect(html).toContain("Billing correction after a scope change");
    expect(html).toContain("does not confirm a refund");
  });
});
