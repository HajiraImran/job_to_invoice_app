import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_SUPPORT_CODES, redactText } from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import { routeAfterAuth, snapshotFromBootstrap } from "./logic.ts";
import {
  bootstrapErrorCopy,
  bootstrapFailureScreenCopy,
  classifyOwnerMeError,
  fetchOwnerMe,
  fetchOwnerMeWithOneRefresh,
  formatSupportCode,
  retryOwnerMe,
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("owner bootstrap after OTP", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes a successful /v1/me with incomplete setup to S04", () => {
    const snapshot = snapshotFromBootstrap(OWNER, "2026-09-15T12:00:00.000Z");
    expect(snapshot.status).toBe("authenticated");
    expect(snapshot.setupCompleted).toBe(false);
    expect(routeAfterAuth(snapshot)).toBe("onboarding");
  });

  it("maps each bootstrap support category from /v1/me outcomes", () => {
    expect(classifyOwnerMeError({ status: 0, code: "UNAVAILABLE" })).toBe("BOOTSTRAP_NETWORK");
    expect(classifyOwnerMeError({ status: 401, code: "AUTHENTICATION_FAILED" })).toBe("BOOTSTRAP_SESSION");
    expect(classifyOwnerMeError({ status: 503, code: "UNAVAILABLE" })).toBe("BOOTSTRAP_SERVICE");
    expect(classifyOwnerMeError({ status: 200, code: "INVALID_RESPONSE" })).toBe("BOOTSTRAP_RESPONSE");
    expect(classifyOwnerMeError({ status: 401, code: "AUTHENTICATION_REQUIRED" })).toBe("BOOTSTRAP_UNKNOWN");
    expect(classifyOwnerMeError({ status: 500, code: "UNAVAILABLE" })).toBe("BOOTSTRAP_UNKNOWN");
    expect(BOOTSTRAP_SUPPORT_CODES).toEqual([
      "BOOTSTRAP_NETWORK",
      "BOOTSTRAP_SESSION",
      "BOOTSTRAP_SERVICE",
      "BOOTSTRAP_RESPONSE",
      "BOOTSTRAP_UNKNOWN",
    ]);
  });

  it("renders the support code under the safe bootstrap error", () => {
    const network = bootstrapFailureScreenCopy("BOOTSTRAP_NETWORK");
    expect(network.message).toBe(copy.networkError);
    expect(network.supportLine).toBe("Support code: BOOTSTRAP_NETWORK");
    expect(formatSupportCode("BOOTSTRAP_SESSION")).toBe("Support code: BOOTSTRAP_SESSION");
    expect(formatSupportCode("BOOTSTRAP_SERVICE")).toBe("Support code: BOOTSTRAP_SERVICE");
    expect(formatSupportCode("BOOTSTRAP_RESPONSE")).toBe("Support code: BOOTSTRAP_RESPONSE");
    expect(formatSupportCode("BOOTSTRAP_UNKNOWN")).toBe("Support code: BOOTSTRAP_UNKNOWN");
    expect(bootstrapErrorCopy("BOOTSTRAP_SESSION")).toBe("bootstrapSession");
    expect(bootstrapErrorCopy("BOOTSTRAP_SERVICE")).toBe("bootstrapUnavailable");
  });

  it("keeps a network failure on S03 without expiring the session", () => {
    const snapshot = snapshotAfterBootstrapFailure({
      supportCode: "BOOTSTRAP_NETWORK",
      emailDisplay: "owner@example.com",
      nowMs: Date.parse("2026-09-15T12:00:00.000Z"),
      hasCachedBootstrap: false,
    });
    expect(snapshot.status).toBe("bootstrap_error");
    expect(snapshot.supportCode).toBe("BOOTSTRAP_NETWORK");
    expect(routeAfterAuth(snapshot)).toBe("verify");
    expect(snapshot.status).not.toBe("signed_out");
    expect(snapshot.status).not.toBe("access_expired");
  });

  it("keeps a 503 on S03 so Retry can reuse the stored session", () => {
    const snapshot = snapshotAfterBootstrapFailure({
      supportCode: "BOOTSTRAP_SERVICE",
      emailDisplay: "owner@example.com",
      nowMs: Date.parse("2026-09-15T12:00:00.000Z"),
      hasCachedBootstrap: false,
    });
    expect(snapshot.status).toBe("bootstrap_error");
    expect(routeAfterAuth(snapshot)).toBe("verify");
    expect(bootstrapErrorCopy("BOOTSTRAP_SERVICE")).toBe("bootstrapUnavailable");
  });

  it("classifies fetch failure as BOOTSTRAP_NETWORK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const result = await fetchOwnerMe({ apiBaseUrl: "http://api.example.invalid", accessToken: "token" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(0);
      expect(classifyOwnerMeError(result.error)).toBe("BOOTSTRAP_NETWORK");
    }
  });

  it("classifies a 200 with unusable data as BOOTSTRAP_RESPONSE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { data: { user: {} } })));
    const result = await fetchOwnerMe({ apiBaseUrl: "http://api.example.invalid", accessToken: "token" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_RESPONSE");
      expect(classifyOwnerMeError(result.error)).toBe("BOOTSTRAP_RESPONSE");
    }
  });

  it("classifies a successful HTTP response that is not JSON as BOOTSTRAP_RESPONSE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token");
          },
        }) as unknown as Response,
      ),
    );
    const result = await fetchOwnerMe({ apiBaseUrl: "http://api.example.invalid", accessToken: "token" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(classifyOwnerMeError(result.error)).toBe("BOOTSTRAP_RESPONSE");
    }
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
      expect(classifyOwnerMeError(result.error)).toBe("BOOTSTRAP_SESSION");
    }
    const snapshot = snapshotAfterBootstrapFailure({
      supportCode: "BOOTSTRAP_SESSION",
      nowMs: Date.parse("2026-09-15T12:00:00.000Z"),
      hasCachedBootstrap: false,
    });
    expect(snapshot.status).toBe("bootstrap_error");
    expect(bootstrapErrorCopy("BOOTSTRAP_SESSION")).toBe("bootstrapSession");
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
    expect(classifyOwnerMeError({ status: 0, code: "UNAVAILABLE" })).toBe("BOOTSTRAP_NETWORK");
    expect(classifyOwnerMeError({ status: 503, code: "UNAVAILABLE" })).toBe("BOOTSTRAP_SERVICE");
    expect(classifyOwnerMeError({ status: 401, code: "AUTHENTICATION_FAILED" })).toBe("BOOTSTRAP_SESSION");
  });

  it("Retry performs one /v1/me request and does not refresh", async () => {
    const fetchMe = vi.fn().mockResolvedValue(fail(503, "UNAVAILABLE"));
    const refresh = vi.fn();
    const result = await retryOwnerMe({
      accessToken: "stored-access-token",
      fetchMe,
    });
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(fetchMe).toHaveBeenCalledWith("stored-access-token");
    expect(refresh).not.toHaveBeenCalled();
    expect(result.refreshCount).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(classifyOwnerMeError(result.error)).toBe("BOOTSTRAP_SERVICE");
    }
  });

  it("routes a successful retry with incomplete setup to S04", async () => {
    const fetchMe = vi
      .fn()
      .mockResolvedValueOnce(fail(503, "UNAVAILABLE"))
      .mockResolvedValueOnce({ ok: true, data: OWNER });
    const first = await retryOwnerMe({
      accessToken: "token",
      fetchMe,
    });
    expect(first.ok).toBe(false);
    expect(fetchMe).toHaveBeenCalledTimes(1);
    const retry = await retryOwnerMe({
      accessToken: "token",
      fetchMe,
    });
    expect(fetchMe).toHaveBeenCalledTimes(2);
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(routeAfterAuth(snapshotFromBootstrap(retry.data, "2026-09-15T12:00:00.000Z"))).toBe("onboarding");
    }
  });

  it("does not put tokens, emails, or JWT fragments in bootstrap copy", () => {
    const combined = `${copy.bootstrapUnavailable} ${copy.bootstrapSession} ${copy.retry} ${copy.supportCodeLabel} ${BOOTSTRAP_SUPPORT_CODES.join(" ")}`;
    const banned = ["service", "role"].join("_");
    expect(combined).not.toMatch(/Bearer |eyJ|@|postgres|access_token/i);
    expect(combined.toLowerCase()).not.toContain(banned);
    expect(redactText(combined)).toBe(combined);
  });
});
