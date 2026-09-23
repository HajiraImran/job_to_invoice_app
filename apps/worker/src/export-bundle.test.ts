import { describe, expect, it } from "vitest";
import { buildExportBundle } from "./export-bundle.ts";

describe("export ZIP bundle", () => {
  it("writes formula-safe CSV, cents columns, and excludes internal notes (QA55)", () => {
    const bundle = buildExportBundle({
      payload: {
        schema_version: 1,
        timezone: "America/Chicago",
        cutoff_at: "2026-09-23T12:00:00.000Z",
        customers: [{ id: "c1", name: "=HYPERLINK(1)", email: "pat@example.com" }],
        jobs: [{ id: "j1", title: "+bonus", customer_id: "c1", internal_notes: "secret staff note" }],
        documents: [
          {
            id: "d1",
            job_id: "j1",
            kind: "quote",
            number: "Q-000009",
            revision_no: 1,
            currency: "USD",
            net_cents: 1000,
            tax_cents: 80,
            total_cents: 1080,
            snapshot_json: { total_cents: 1080 },
          },
        ],
        ledger: [{ id: "l1", amount_cents: 500, type: "payment" }],
        approvals: [{ id: "a1", decision: "approve", signer_name: "Pat" }],
        images: [],
      },
    });
    const text = bundle.zip.toString("utf8");
    expect(text).toContain("SCHEMA_VERSION");
    expect(text).toContain("customers.csv");
    expect(text).toContain("'=HYPERLINK(1)");
    expect(text).toContain("'+bonus");
    expect(text).toContain("net_cents,tax_cents,total_cents,total_usd");
    expect(text).toContain("1080,USD");
    expect(text).not.toContain("secret staff note");
    expect(text).not.toContain("internal_notes");
    expect(bundle.jobCount).toBe(1);
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
