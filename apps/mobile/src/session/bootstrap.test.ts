import { describe, expect, it, vi } from "vitest";
import { redactText } from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import { routeAfterAuth, snapshotFromBootstrap } from "./logic.ts";
import {
  bootstrapErrorCopy,
  classifyOwnerMeError,
  fetchOwnerMeWithOneRefresh,
  snapshotAfterBootstrapFailure,
} from "./bootstrap.ts";
import type { ApiError, OwnerBootstrap } from "../api/client.ts";

const OWNER: OwnerBootstrap = {
  user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "active", display_email: "owner@example.com" },
  workspace: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", version: 1, setup_completed: false },
  entitlement: { source: "unverified", can_publish: false },
  first_sign_in: true,
  analytics_alias_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

function fail(status: number, code: string): { ok: false; error: ApiError } {
  return {
    ok: false,
    error: { status, code, message: "Request failed.", retryable: status === 0 || status >= 500 },
  };
}

describe("owner bootstrap after OTP", () => {
  it("routes a successful /v1/me with incomplete setup to S04", () => {
    const snapshot = snapshotFromBootstrap(OWNER, "2026-09-15T12:00:00.000Z");
    expect(snapshot.status).toBe("authenticated");
    expect(snapshot.setupCompleted).toBe(false);
    expect(routeAfterAuth(snapshot)).toBe("onboarding");
  });

  it("keeps a network failure on S03 without expiring the session", () => {
    const snapshot = snapshotAfterBootstrapFailure({
      kind: "network",
      emailDisplay: "owner@example.com",
      nowMs: Date.parse("2026-09-15T12:00:00.000Z"),
      hasCachedBootstrap: false,
    });
    expect(snapshot.status).toBe("bootstrap_error");
    expect(routeAfterAuth(snapshot)).toBe("verify");
    expect(snapshot.status).not.toBe("signed_out");
    expect(snapshot.status).not.toBe("access_expired");
  });

  it("keeps a 503 on S03 so Retry can reuse the stored session", () => {
    const snapshot = snapshotAfterBootstrapFailure({
      kind: "unavailable",
      emailDisplay: "owner@example.com",
      nowMs: Date.parse("2026-09-15T12:00:00.000Z"),
      hasCachedBootstrap: false,
    });
    expect(snapshot.status).toBe("bootstrap_error");
    expect(routeAfterAuth(snapshot)).toBe("verify");
    expect(bootstrapErrorCopy("unavailable")).toBe("bootstrapUnavailable");
  });

  it("refreshes once and retries once on 401, then stops", async () => {
    const fetchMe = vi
      .fn()
      .mockResolvedValueOnce(fail(401, "AUTHENTICATION_FAILED"))
      .mockResolvedValueOnce({ ok: true, data: OWNER });
    const refresh = vi.fn().mockResolvedValue("next-access-token");
    const result = await fetchOwnerMeWithOneRefresh({
      accessToken: "first-access-token",
      fetchMe,
      refresh,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMe).toHaveBeenCalledTimes(2);
    expect(fetchMe).toHaveBeenNthCalledWith(2, "next-access-token");
    expect(result).toEqual({ ok: true, data: OWNER, refreshCount: 1 });
  });

  it("does not loop when 401 repeats after one refresh", async () => {
    const fetchMe = vi.fn().mockResolvedValue(fail(401, "AUTHENTICATION_FAILED"));
    const refresh = vi.fn().mockResolvedValue("next-access-token");
    const result = await fetchOwnerMeWithOneRefresh({
      accessToken: "first-access-token",
      fetchMe,
      refresh,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMe).toHaveBeenCalledTimes(2);
    expect(result.refreshCount).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(classifyOwnerMeError(result.error)).toBe("session");
    }
    const snapshot = snapshotAfterBootstrapFailure({
      kind: "session",
      nowMs: Date.parse("2026-09-15T12:00:00.000Z"),
      hasCachedBootstrap: false,
    });
    expect(snapshot.status).toBe("bootstrap_error");
    expect(bootstrapErrorCopy("session")).toBe("bootstrapSession");
  });

  it("does not refresh on 503 or status 0", async () => {
    const unavailable = await fetchOwnerMeWithOneRefresh({
      accessToken: "token",
      fetchMe: vi.fn().mockResolvedValue(fail(503, "UNAVAILABLE")),
      refresh: vi.fn(),
    });
    expect(unavailable.refreshCount).toBe(0);
    expect(unavailable.ok).toBe(false);
    const network = await fetchOwnerMeWithOneRefresh({
      accessToken: "token",
      fetchMe: vi.fn().mockResolvedValue(fail(0, "UNAVAILABLE")),
      refresh: vi.fn(),
    });
    expect(network.refreshCount).toBe(0);
    expect(classifyOwnerMeError({ status: 0, code: "UNAVAILABLE" })).toBe("network");
    expect(classifyOwnerMeError({ status: 503, code: "UNAVAILABLE" })).toBe("unavailable");
    expect(classifyOwnerMeError({ status: 401, code: "AUTHENTICATION_FAILED" })).toBe("session");
  });

  it("routes a successful retry with incomplete setup to S04", async () => {
    const fetchMe = vi
      .fn()
      .mockResolvedValueOnce(fail(503, "UNAVAILABLE"))
      .mockResolvedValueOnce({ ok: true, data: OWNER });
    const first = await fetchOwnerMeWithOneRefresh({
      accessToken: "token",
      fetchMe,
      refresh: vi.fn(),
    });
    expect(first.ok).toBe(false);
    const retry = await fetchOwnerMeWithOneRefresh({
      accessToken: "token",
      fetchMe,
      refresh: vi.fn(),
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(routeAfterAuth(snapshotFromBootstrap(retry.data, "2026-09-15T12:00:00.000Z"))).toBe("onboarding");
    }
  });

  it("does not put tokens, emails, or JWT fragments in bootstrap copy", () => {
    const combined = `${copy.bootstrapUnavailable} ${copy.bootstrapSession} ${copy.retry}`;
    const banned = ["service", "role"].join("_");
    expect(combined).not.toMatch(/Bearer |eyJ|@|postgres|access_token/i);
    expect(combined.toLowerCase()).not.toContain(banned);
    expect(redactText(combined)).toBe(combined);
  });
});
