import { describe, expect, it } from "vitest";
import { paywallViewedProperties, presentSubscription, subscriptionPath } from "./presentation.ts";

const ready: Parameters<typeof presentSubscription>[0]["subscription"] = {
  source: "free",
  can_publish: true,
  can_start_trial: true,
  free_jobs_consumed: 3,
  free_jobs_remaining: 0,
  trial: null,
};

describe("S21 trial presentation", () => {
  it("blocks start while offline or expired and allows an explicit start when eligible", () => {
    expect(presentSubscription({ authStatus: "offline_cached", loading: false, starting: false }).kind).toBe("offline");
    expect(presentSubscription({ authStatus: "access_expired", loading: false, starting: false }).startDisabled).toBe(true);
    expect(
      presentSubscription({
        authStatus: "authenticated",
        loading: false,
        starting: false,
        subscription: ready,
      }),
    ).toEqual({ kind: "ready", startDisabled: false, message: undefined });
    expect(
      presentSubscription({
        authStatus: "authenticated",
        loading: false,
        starting: false,
        subscription: { ...ready, can_start_trial: false },
      }).startDisabled,
    ).toBe(true);
  });

  it("emits a store-free paywall_viewed property set", () => {
    expect(paywallViewedProperties("publish")).toEqual({ entry_point: "publish" });
    expect(subscriptionPath()).toBe("/(tabs)/settings/subscription");
  });
});
