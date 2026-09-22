import { describe, expect, it } from "vitest";
import { changeStatusLabel, presentChangeEditor, type ChangeDraftRecord } from "./presentation.ts";

const draft: ChangeDraftRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  job_id: "22222222-2222-4222-8222-222222222222",
  kind: "change",
  draft_state: "editing",
  version: 1,
  reason: "Extra handle",
  expected_scope_version: 1,
  expiry_days: 14,
  additions: [],
  reductions: [],
  sources: [],
  previous_total_cents: 25980,
  change_including_tax_cents: 0,
  new_agreed_total_cents: 25980,
  default_tax_bp: 0,
};

describe("change editor presentation", () => {
  it("shows loading, empty, offline, blocked and retry states", () => {
    expect(presentChangeEditor({ authStatus: "authenticated", loading: true }).kind).toBe("loading");
    expect(presentChangeEditor({ authStatus: "authenticated", loading: false, draft }).kind).toBe("empty");
    expect(presentChangeEditor({ authStatus: "offline_cached", loading: false }).kind).toBe("offline");
    expect(
      presentChangeEditor({
        authStatus: "authenticated",
        loading: false,
        error: { message: "blocked", retryable: false, status: 422, code: "VALIDATION_FAILED" },
      }).kind,
    ).toBe("blocked");
    expect(
      presentChangeEditor({
        authStatus: "authenticated",
        loading: false,
        error: { message: "down", retryable: true, status: 0 },
      }).showRetry,
    ).toBe(true);
    expect(
      presentChangeEditor({
        authStatus: "authenticated",
        loading: false,
        draft: {
          ...draft,
          additions: [
            {
              client_line_id: "33333333-3333-4333-8333-333333333333",
              description: "Handle",
              unit: "item",
              custom_unit_label: null,
              quantity: "1",
              unit_price_cents: 1000,
              discount_cents: 0,
              tax_bp: 0,
            },
          ],
        },
      }).kind,
    ).toBe("loaded");
  });

  it("labels pending, approved and declined change orders", () => {
    expect(changeStatusLabel("issued", "pending")).toContain("pending");
    expect(changeStatusLabel("accepted", "approved")).toContain("approved");
    expect(changeStatusLabel("declined", "declined")).toContain("declined");
  });
});
