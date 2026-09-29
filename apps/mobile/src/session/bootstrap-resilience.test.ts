import { describe, expect, it, vi } from "vitest";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import type { OwnerBootstrap } from "../api/client.ts";
import { createReachabilityCheck, refineNetworkFailure, requestFailureMessage } from "../api/reachability.ts";
import { copy } from "../i18n/en.ts";
import { customerIdempotencyAfterFailure } from "../customers/presentation.ts";
import { itemIdempotencyAfterFailure } from "../items/presentation.ts";
import {
  BOOTSTRAP_BACKGROUND_RETRY_MS,
  backgroundBootstrapRetryDelay,
  classifyOwnerMeError,
  fetchOwnerMe,
  fetchOwnerMeWithOneRefresh,
  fetchOwnerMeWithTransientRetry,
  sessionReadOutcome,
  shouldAutoRetryBootstrap,
  type FetchOwnerMeResult,
  type OwnerMeTimer,
} from "./bootstrap.ts";
import { createBootstrapGenerationGate, decideBootstrapApply } from "./recovery.ts";

const OWNER: OwnerBootstrap = {
  user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "active", display_email: "owner@example.com" },
  workspace: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", version: 3, setup_completed: true },
  entitlement: { source: "free", can_publish: true },
  first_sign_in: false,
  analytics_alias_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const RECENT_AUTH = "2026-09-27T12:00:00.000Z";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function throwingFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError("Network request failed");
  }) as unknown as typeof fetch;
}

function oneAttempt(fetchImpl: typeof fetch, startTimer?: OwnerMeTimer): () => Promise<FetchOwnerMeResult> {
  return () =>
    fetchOwnerMeWithOneRefresh({
      accessToken: "access-token",
      fetchMe: (accessToken) =>
        fetchOwnerMe({ apiBaseUrl: "http://api.test", accessToken, fetchImpl, startTimer }),
      refresh: async () => undefined,
    });
}

function applyFailure(result: FetchOwnerMeResult, cached: OwnerBootstrap | null) {
  if (result.ok) {
    throw new Error("expected failure");
  }
  const gate = createBootstrapGenerationGate();
  return decideBootstrapApply({
    generation: gate.begin(),
    gate,
    result,
    authenticatedAt: new Date(NOW).toISOString(),
    lastAuthenticatedAt: RECENT_AUTH,
    cachedBootstrap: cached,
    nowMs: NOW,
    supportCode: classifyOwnerMeError(result.error),
  });
}

describe("delayed bootstrap", () => {
  it("times out once, does not stack in-flight retries, and keeps cached data with background retry", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    const fireImmediately: OwnerMeTimer = (onTimeout) => {
      onTimeout();
      return () => undefined;
    };
    const sleep = vi.fn(async () => undefined);
    const result = await fetchOwnerMeWithTransientRetry({ attempt: oneAttempt(fetchImpl, fireImmediately), sleep });

    expect(result.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.network).toBe("timeout");
    }
    const decision = applyFailure(result, OWNER);
    expect(decision.action).toBe("apply_failure");
    if (decision.action === "apply_failure") {
      expect(decision.snapshot.status).toBe("offline_cached");
      expect(decision.bootstrap).toEqual(OWNER);
      expect(shouldAutoRetryBootstrap(decision.snapshot)).toBe(true);
    }
  });

  it("backs off background retries and caps the delay", () => {
    expect(BOOTSTRAP_BACKGROUND_RETRY_MS.map((_, i) => backgroundBootstrapRetryDelay(i))).toEqual([
      5_000, 15_000, 30_000, 60_000,
    ]);
    expect(backgroundBootstrapRetryDelay(40)).toBe(60_000);
  });
});

describe("unreachable API", () => {
  it("retries a fast network failure in flight and recovers without an error screen", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValueOnce(jsonResponse(200, { data: OWNER })) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);
    const result = await fetchOwnerMeWithTransientRetry({ attempt: oneAttempt(fetchImpl), sleep });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("reports an unreachable API when the internet works, and offline when it does not", async () => {
    const result = await fetchOwnerMeWithTransientRetry({
      attempt: oneAttempt(throwingFetch()),
      sleep: async () => undefined,
    });
    expect(result.attempts).toBe(3);
    if (result.ok) {
      throw new Error("expected failure");
    }
    const online = await refineNetworkFailure(result.error, async () => "online");
    const offline = await refineNetworkFailure(result.error, async () => "offline");
    expect(classifyOwnerMeError(online)).toBe("BOOTSTRAP_NETWORK");
    expect(classifyOwnerMeError(offline)).toBe("BOOTSTRAP_OFFLINE");
    expect(requestFailureMessage(online)).toBe(copy.apiUnreachable);
    expect(requestFailureMessage(offline)).toBe(copy.apiOffline);
    expect(requestFailureMessage({ ...online, network: "timeout" })).toBe(copy.apiTimedOut);
  });

  it("never signs out on an unreachable API: no cache stays on the retry screen", async () => {
    const result = await fetchOwnerMeWithTransientRetry({
      attempt: oneAttempt(throwingFetch()),
      sleep: async () => undefined,
    });
    const decision = applyFailure(result, null);
    expect(decision.action).toBe("apply_failure");
    if (decision.action === "apply_failure") {
      expect(decision.snapshot.status).toBe("bootstrap_error");
      expect(decision.snapshot.supportCode).toBe("BOOTSTRAP_NETWORK");
      expect(shouldAutoRetryBootstrap(decision.snapshot)).toBe(true);
    }
  });

  it("probes reachability once per cache window", async () => {
    let now = 0;
    const probe = vi.fn(async () => "online" as const);
    const check = createReachabilityCheck(probe, { cacheMs: 10_000, now: () => now });
    await Promise.all([check(), check()]);
    now = 5_000;
    await check();
    expect(probe).toHaveBeenCalledTimes(1);
    now = 20_000;
    await check();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe("database timeout", () => {
  const dbTimeout = {
    error: { code: "DATABASE_TIMEOUT", message: "The database took too long to respond. Try again.", retryable: true },
    meta: { request_id: "11111111-1111-4111-8111-111111111111" },
  };

  it("classifies a 503 DATABASE_TIMEOUT distinctly and keeps the server request id", async () => {
    const result = await fetchOwnerMe({
      apiBaseUrl: "http://api.test",
      accessToken: "access-token",
      fetchImpl: vi.fn(async () => jsonResponse(503, dbTimeout)) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(classifyOwnerMeError(result.error)).toBe("BOOTSTRAP_DATABASE");
      expect(result.error.requestId).toBe("11111111-1111-4111-8111-111111111111");
      expect(requestFailureMessage(result.error)).toBe(copy.apiDatabase);
    }
  });

  it("retries a database timeout and then applies the successful bootstrap", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, dbTimeout))
      .mockResolvedValueOnce(jsonResponse(503, dbTimeout))
      .mockResolvedValueOnce(jsonResponse(200, { data: OWNER })) as unknown as typeof fetch;
    const sleep = vi.fn(async (_ms: number) => undefined);
    const result = await fetchOwnerMeWithTransientRetry({ attempt: oneAttempt(fetchImpl), sleep });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1_000, 3_000]);
  });

  it("keeps idempotency keys when a create hits a database failure", () => {
    for (const code of ["DATABASE_TIMEOUT", "DATABASE_UNAVAILABLE", "UNAVAILABLE"]) {
      expect(customerIdempotencyAfterFailure("key-1", code)).toBe("key-1");
      expect(itemIdempotencyAfterFailure("key-1", code)).toBe("key-1");
    }
  });

  it("does not retry a session failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: { code: "AUTHENTICATION_FAILED", message: "Sign in again." } }),
    ) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);
    const result = await fetchOwnerMeWithTransientRetry({ attempt: oneAttempt(fetchImpl), sleep });
    expect(result.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    const decision = applyFailure(result, OWNER);
    if (decision.action === "apply_failure") {
      expect(decision.snapshot.status).toBe("bootstrap_error");
      expect(decision.snapshot.supportCode).toBe("BOOTSTRAP_SESSION");
      expect(shouldAutoRetryBootstrap(decision.snapshot)).toBe(false);
    }
  });

  it("stops in-flight retries when a newer bootstrap started", async () => {
    let current = true;
    const attempt = vi.fn(async (): Promise<FetchOwnerMeResult> => {
      current = false;
      return { ok: false, error: { status: 503, code: "DATABASE_TIMEOUT", message: "x", retryable: true }, refreshCount: 0 };
    });
    const result = await fetchOwnerMeWithTransientRetry({
      attempt,
      sleep: async () => undefined,
      shouldContinue: () => current,
    });
    expect(result.attempts).toBe(1);
  });
});

describe("app restart", () => {
  it("treats an expired token whose refresh could not reach auth as a network failure, not a sign-out", () => {
    const retryable = Object.assign(new Error("Failed to fetch"), { name: "AuthRetryableFetchError", status: 0 });
    // supabase-js recognises its own error class; a plain Error must not be mistaken for it.
    expect(isAuthRetryableFetchError(retryable)).toBe(false);
    const isRetryable = (error: unknown) => error === retryable;
    expect(sessionReadOutcome({ hasSession: false, error: retryable, isRetryableFetchError: isRetryable })).toBe(
      "network_failure",
    );
    expect(sessionReadOutcome({ hasSession: true, error: retryable, isRetryableFetchError: isRetryable })).toBe("session");
    expect(
      sessionReadOutcome({ hasSession: false, error: new Error("invalid refresh"), isRetryableFetchError: isRetryable }),
    ).toBe("signed_out");
    expect(sessionReadOutcome({ hasSession: false, isRetryableFetchError: isRetryable })).toBe("signed_out");
  });

  it("restarts into cached data when the API is down and replaces it on the next success", async () => {
    const gate = createBootstrapGenerationGate();
    const failed = gate.begin();
    const failure = decideBootstrapApply({
      generation: failed,
      gate,
      result: { ok: false, error: { status: 0, code: "UNAVAILABLE" } },
      authenticatedAt: new Date(NOW).toISOString(),
      lastAuthenticatedAt: RECENT_AUTH,
      cachedBootstrap: OWNER,
      nowMs: NOW,
      supportCode: "BOOTSTRAP_NETWORK",
    });
    expect(failure.action === "apply_failure" && failure.snapshot.status).toBe("offline_cached");
    expect(failure.action === "apply_failure" && failure.snapshot.supportCode).toBe("BOOTSTRAP_NETWORK");
    gate.markApplied(failed);

    const retried = gate.begin();
    const success = decideBootstrapApply({
      generation: retried,
      gate,
      result: { ok: true, data: OWNER },
      authenticatedAt: new Date(NOW + 5_000).toISOString(),
      lastAuthenticatedAt: RECENT_AUTH,
      cachedBootstrap: OWNER,
      nowMs: NOW + 5_000,
      supportCode: "BOOTSTRAP_UNKNOWN",
    });
    expect(success.action).toBe("apply_success");
    if (success.action === "apply_success") {
      expect(success.snapshot.status).toBe("authenticated");
      expect(shouldAutoRetryBootstrap(success.snapshot)).toBe(false);
    }
  });
});
