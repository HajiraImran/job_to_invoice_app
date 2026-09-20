import { describe, expect, it } from "vitest";
import { presentRequestActions, requestStateLabel } from "./presentation.ts";

describe("S12 request actions", () => {
  const pending = {
    request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    document_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    job_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    number: "Q-000001",
    revision_label: "R1",
    revision_no: 1,
    template_id: "EMAIL01",
    delivery_state: "delivered",
    recipient_email_masked: "c***@example.com",
    last_event_at: new Date().toISOString(),
    retry_count: 0,
    retryable: false,
    terminal: true,
    request_state: "pending",
    can_resend: true,
    can_withdraw: true,
    can_replace_link: true,
  };

  it("hides mutations when offline and never treats them as queueable", () => {
    const actions = presentRequestActions({ authStatus: "offline_cached", request: pending });
    expect(actions.resend).toBe("offline");
    expect(actions.withdraw).toBe("offline");
    expect(actions.replaceLink).toBe("offline");
  });

  it("disables resend while cooling down and hides actions after withdraw", () => {
    const cooling = presentRequestActions({
      authStatus: "authenticated",
      request: {
        ...pending,
        can_resend: false,
        resend_available_at: new Date(Date.now() + 60_000).toISOString(),
      },
      nowMs: Date.now(),
    });
    expect(cooling.resend).toBe("disabled");
    expect(cooling.withdraw).toBe("ready");
    const withdrawn = presentRequestActions({
      authStatus: "authenticated",
      request: { ...pending, request_state: "withdrawn", can_resend: false, can_withdraw: false, can_replace_link: false },
    });
    expect(withdrawn.resend).toBe("hidden");
    expect(requestStateLabel("withdrawn")).toMatch(/withdrew/i);
  });

  it("marks actions busy while a mutation is in flight", () => {
    const busy = presentRequestActions({ authStatus: "authenticated", request: pending, submitting: true });
    expect(busy.resend).toBe("busy");
    expect(busy.withdraw).toBe("busy");
    expect(busy.replaceLink).toBe("busy");
  });
});
