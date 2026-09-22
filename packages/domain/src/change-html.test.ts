import { describe, expect, it } from "vitest";
import { renderChangeOriginalHtml } from "./change-html.ts";
import type { ChangeSnapshotV1 } from "./snapshot.ts";

function snapshot(): ChangeSnapshotV1 {
  return {
    schema_version: 1,
    kind: "change",
    currency: "USD",
    business: {
      business_name: "Invoice Co",
      legal_name: "Invoice Co LLC",
      contact_name: "Owner",
      contact_email: "owner@example.com",
      contact_phone: null,
      address: null,
      timezone: "America/Chicago",
      default_tax_bp: 0,
    },
    customer: { name: "Riley Chen", email: "customer@example.com", phone: null, billing_address: null },
    job: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Kitchen", site_address: null, no_site: true },
    reason: "Customer requested a second handle",
    notes: "",
    terms: "Net 14.",
    expiry_days: 14,
    expiry_local_date: "2026-10-06",
    expiry_timezone: "America/Chicago",
    expires_at: "2026-10-07T04:59:59.000Z",
    issue_date: "2026-09-22",
    expected_scope_version: 1,
    previous_net_cents: 24000,
    previous_tax_cents: 1980,
    previous_total_cents: 25980,
    addition_net_cents: 10000,
    addition_tax_cents: 825,
    addition_total_cents: 10825,
    reduction_net_cents: 0,
    reduction_tax_cents: 0,
    reduction_total_cents: 0,
    change_including_tax_cents: 10825,
    new_agreed_total_cents: 36805,
    additions: [
      {
        position: 1,
        client_line_id: "11111111-1111-4111-8111-111111111111",
        description: "Second handle",
        unit: "item",
        custom_unit_label: null,
        quantity: "1.000",
        unit_price_cents: 10000,
        discount_cents: 0,
        tax_bp: 825,
        gross_cents: 10000,
        net_cents: 10000,
        tax_cents: 825,
        total_cents: 10825,
      },
    ],
    reductions: [],
    net_cents: 34000,
    tax_cents: 2805,
    total_cents: 36805,
  };
}

describe("change original HTML", () => {
  it("shows previous, change, and new totals for F04", () => {
    const html = renderChangeOriginalHtml({
      number: "CO-000001",
      revision_no: 1,
      snapshot: snapshot(),
      net_cents: 34000,
      tax_cents: 2805,
      total_cents: 36805,
    });
    expect(html).toContain("Previously agreed total");
    expect(html).toContain("Change including tax");
    expect(html).toContain("New agreed total");
    expect(html).toContain("Second handle");
    expect(html).toContain("CO-000001");
  });
});
