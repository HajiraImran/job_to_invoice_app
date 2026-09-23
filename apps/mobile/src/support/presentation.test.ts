import { describe, expect, it } from "vitest";
import { categoryLabel, presentSupport, supportPath } from "./presentation.ts";

describe("S22 support presentation", () => {
  it("blocks offline and expired sessions and exposes the settings route", () => {
    expect(supportPath()).toBe("/(tabs)/settings/support");
    expect(presentSupport({ authStatus: "offline_cached", submitting: false })).toEqual({
      kind: "offline",
      submitDisabled: true,
    });
    expect(presentSupport({ authStatus: "access_expired", submitting: false }).kind).toBe("access_expired");
    expect(categoryLabel("billing")).toBe("Plan and billing");
  });

  it("shows submitted state after a case id returns", () => {
    expect(
      presentSupport({
        authStatus: "authenticated",
        submitting: false,
        submitted: {
          id: "c1",
          category: "billing",
          state: "open",
          content_access_granted: false,
          content_access_expires_at: null,
          created_at: "2026-09-23T00:00:00.000Z",
          support_url: null,
        },
      }).kind,
    ).toBe("submitted");
    expect(presentSupport({ authStatus: "authenticated", submitting: true }).kind).toBe("submitting");
  });
});
