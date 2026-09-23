import { describe, expect, it } from "vitest";
import { FREE_JOB_LIMIT, TRIAL_JOB_LIMIT, canPublishFromAllowance, parseTrialStart, trialIsActive } from "./index.ts";

describe("SUB03 trial start acknowledgement", () => {
  it("requires an explicit acknowledged true", () => {
    expect(parseTrialStart(undefined).ok).toBe(false);
    expect(parseTrialStart({}).ok).toBe(false);
    expect(parseTrialStart({ acknowledged: false }).ok).toBe(false);
    expect(parseTrialStart({ acknowledged: true, extra: true }).ok).toBe(false);
    expect(parseTrialStart({ acknowledged: true })).toEqual({ ok: true, value: { acknowledged: true } });
  });

  it("treats an active trial as publishable after free slots are used", () => {
    const now = Date.parse("2026-09-10T12:00:00.000Z");
    expect(
      canPublishFromAllowance({
        freeJobsConsumed: FREE_JOB_LIMIT,
        freeJobLimit: FREE_JOB_LIMIT,
        trialStartedAt: "2026-09-01T00:00:00.000Z",
        trialEndsAt: "2026-09-15T00:00:00.000Z",
        trialJobsConsumed: 1,
        nowMs: now,
      }),
    ).toBe(true);
    expect(
      trialIsActive({
        trialStartedAt: "2026-09-01T00:00:00.000Z",
        trialEndsAt: "2026-09-15T00:00:00.000Z",
        trialJobsConsumed: TRIAL_JOB_LIMIT,
        nowMs: now,
      }),
    ).toBe(false);
    expect(
      canPublishFromAllowance({
        freeJobsConsumed: FREE_JOB_LIMIT,
        freeJobLimit: FREE_JOB_LIMIT,
        trialStartedAt: "2026-09-01T00:00:00.000Z",
        trialEndsAt: "2026-09-08T00:00:00.000Z",
        trialJobsConsumed: 1,
        nowMs: now,
      }),
    ).toBe(false);
  });
});
