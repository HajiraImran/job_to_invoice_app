import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT_SYNC, publicRouteAllowed } from "@job-to-invoice/schemas";
import { jobsIndexPath } from "../jobs/routes.ts";
import {
  APP_JOBS_HREF,
  SIGNED_OUT_WELCOME_HREF,
  resolveOwnerGuard,
  routeAfterAuth,
} from "./logic.ts";

describe("protected route resolution while signed out", () => {
  it("sends a cold-start jobs deep link to welcome without a replace loop", () => {
    expect(jobsIndexPath()).toBe("/(tabs)/jobs");
    expect(publicRouteAllowed("/(tabs)/jobs")).toBe(false);
    expect(APP_JOBS_HREF).toBe("/(tabs)/jobs");

    const restoring = resolveOwnerGuard({
      snapshot: { status: "restoring" },
      segments: ["(tabs)", "jobs"],
    });
    expect(restoring).toEqual({ action: "hold" });
    expect(routeAfterAuth({ status: "restoring" })).toBe("splash");

    const signedOutJobs = resolveOwnerGuard({
      snapshot: { status: "signed_out" },
      segments: ["(tabs)", "jobs"],
    });
    expect(signedOutJobs).toEqual({ action: "replace", href: SIGNED_OUT_WELCOME_HREF });
    expect(routeAfterAuth({ status: "signed_out" })).toBe("public");

    const afterReplace = resolveOwnerGuard({
      snapshot: { status: "signed_out" },
      segments: ["(public)", "welcome"],
    });
    expect(afterReplace).toEqual({ action: "stay" });

    const signIn = resolveOwnerGuard({
      snapshot: { status: "signed_out" },
      segments: ["(public)", "sign-in"],
    });
    expect(signIn).toEqual({ action: "stay" });
  });

  it("does not navigate onto jobs while authenticating or restoring", () => {
    expect(
      resolveOwnerGuard({
        snapshot: { status: "authenticating" },
        segments: ["(tabs)", "jobs"],
      }),
    ).toEqual({ action: "hold" });
    expect(
      resolveOwnerGuard({
        snapshot: { status: "restoring" },
        segments: ["(tabs)", "jobs", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      }),
    ).toEqual({ action: "hold" });
  });

  it("does not treat empty draft status as a reason to keep protected routes", () => {
    expect(EMPTY_DRAFT_SYNC.hasUnsyncedDrafts).toBe(false);
    expect(
      resolveOwnerGuard({
        snapshot: { status: "signed_out" },
        segments: ["(tabs)", "jobs", "new"],
      }),
    ).toEqual({ action: "replace", href: SIGNED_OUT_WELCOME_HREF });
  });

  it("does not invent a magic-link verify route for signed-out jobs", () => {
    const decision = resolveOwnerGuard({
      snapshot: { status: "signed_out" },
      segments: ["(tabs)", "jobs"],
    });
    expect(decision.action === "replace" ? decision.href : "").not.toBe("/(public)/verify");
  });
});
