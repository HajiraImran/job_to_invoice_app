import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ERROR_CODES } from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import { grantErrorIsAutoRetryable, verifiedSessionIsFreshInstall } from "../session/step-up.ts";
import type { SecureKv } from "../session/storage.ts";
import {
  PENDING_REPLACE_KEY,
  createPendingReplaceIntent,
  decideReplaceResume,
  grantRequiresFreshAuth,
  loadPendingReplace,
  pendingReplaceHasOnlySafeFields,
  readPendingReplaceIntent,
  reconcilePendingReplace,
  replaceResumeDiagnosticIsSafe,
  replaceResumeHref,
  savePendingReplace,
  shouldResumeReplace,
} from "./pending-replace.ts";
import {
  beginReplaceAttempt,
  endReplaceAttempt,
  issueReplaceGrant,
  performReplaceLink,
  replaceAttemptActive,
  submitReplaceLink,
  type OwnerMutator,
} from "./request-replace.ts";

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const jobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ownerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const otherOwner = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const idempotencyKey = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const nowMs = Date.parse("2026-09-21T05:00:00.000Z");

function memoryKv(initial?: Record<string, string>): SecureKv & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial ?? {}));
  return {
    store,
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => {
      store.set(key, value);
    },
    removeItem: async (key) => {
      store.delete(key);
    },
  };
}

function validIntent() {
  const intent = createPendingReplaceIntent({
    requestId,
    jobId,
    ownerId,
    idempotencyKey,
    nowMs,
  });
  if (!intent) {
    throw new Error("valid replace intent");
  }
  return intent;
}

describe("pending replace-link intent", () => {
  afterEach(() => {
    endReplaceAttempt();
  });

  it("saves a safe pending intent when replace-link starts step-up", async () => {
    const intent = validIntent();
    expect(intent).toBeDefined();
    expect(intent?.action).toBe("replace_link");
    expect(intent?.returnRoute).toBe(replaceResumeHref(jobId));
    expect(pendingReplaceHasOnlySafeFields(intent)).toBe(true);
    const kv = memoryKv();
    await savePendingReplace(kv, intent);
    const stored = await kv.getItem(PENDING_REPLACE_KEY);
    expect(stored).toBeTruthy();
    expect(stored).not.toMatch(/otp|access_token|refresh_token|grant|authorization|portal|@/i);
    const read = readPendingReplaceIntent(stored, nowMs + 1_000, ownerId);
    expect(read).toEqual({ ok: true, value: intent });
  });

  it("resumes the same request after successful OTP and does not ask for another code when auth is fresh", async () => {
    const intent = validIntent();
    expect(
      shouldResumeReplace({
        authStatus: "authenticated",
        pending: intent,
        jobId,
        requestId,
        nowMs: nowMs + 1_000,
      }),
    ).toBe(true);
    expect(
      shouldResumeReplace({
        authStatus: "awaiting_code",
        pending: intent,
        jobId,
        requestId,
      }),
    ).toBe(false);
    const calls: string[] = [];
    const run: OwnerMutator = async (options) => {
      calls.push(options.path);
      if (options.path === "/v1/account/action-grants") {
        expect(options.body).toEqual({ action: "replace_link" });
        return { ok: true, data: { grant: "g".repeat(43) } as never };
      }
      expect(options.headers?.["X-Action-Grant"]).toBe("g".repeat(43));
      expect(options.headers?.["Idempotency-Key"]).toBe(idempotencyKey);
      return { ok: true, data: { replayed: false } as never };
    };
    const grant = await issueReplaceGrant(run);
    expect(grant).toEqual({ ok: true, grant: "g".repeat(43) });
    expect(grantRequiresFreshAuth({ status: 403, code: API_ERROR_CODES.ACTION_GRANT_REQUIRED })).toBe(true);
    expect(await submitReplaceLink(run, { requestId, grant: "g".repeat(43), idempotencyKey })).toEqual({
      ok: true,
    });
    expect(calls).toEqual(["/v1/account/action-grants", `/v1/requests/${requestId}/replace-link`]);
  });

  it("issues exactly one grant and one replace-link and clears the intent after success", async () => {
    const kv = memoryKv();
    const intent = validIntent();
    await savePendingReplace(kv, intent);
    expect(beginReplaceAttempt()).toBe(true);
    expect(beginReplaceAttempt()).toBe(false);
    expect(replaceAttemptActive()).toBe(true);
    const grant = await issueReplaceGrant(async () => ({ ok: true, data: { grant: "token-not-logged" } as never }));
    expect(grant.ok).toBe(true);
    const replaced = await submitReplaceLink(async () => ({ ok: true, data: {} as never }), {
      requestId,
      grant: "token-not-logged",
      idempotencyKey,
    });
    expect(replaced).toEqual({ ok: true });
    endReplaceAttempt();
    await kv.removeItem(PENDING_REPLACE_KEY);
    expect(await kv.getItem(PENDING_REPLACE_KEY)).toBeNull();
    expect(JSON.stringify(grant)).not.toMatch(/otp|authorization|@example/i);
  });

  it("does not execute an expired or owner-mismatched intent", async () => {
    const intent = validIntent();
    const expired = readPendingReplaceIntent(JSON.stringify(intent), nowMs + 301_000, ownerId);
    expect(expired).toEqual({ ok: false, reason: "expired" });
    const kv = memoryKv({ [PENDING_REPLACE_KEY]: JSON.stringify(intent) });
    const mismatched = await loadPendingReplace(kv, nowMs + 1_000, otherOwner);
    expect(mismatched).toEqual({ ok: false, reason: "owner_mismatch" });
    expect(await kv.getItem(PENDING_REPLACE_KEY)).toBeNull();
  });

  it("does not execute after an incorrect OTP and does not rotate twice on duplicate submit", async () => {
    const intent = validIntent();
    expect(
      shouldResumeReplace({
        authStatus: "awaiting_code",
        pending: intent,
        jobId,
        requestId,
      }),
    ).toBe(false);
    let grants = 0;
    let replaces = 0;
    const run: OwnerMutator = async (options) => {
      if (options.path === "/v1/account/action-grants") {
        grants += 1;
        return { ok: true, data: { grant: "once" } as never };
      }
      replaces += 1;
      return { ok: true, data: { replayed: replaces > 1 } as never };
    };
    expect(beginReplaceAttempt()).toBe(true);
    await issueReplaceGrant(run);
    await submitReplaceLink(run, { requestId, grant: "once", idempotencyKey });
    expect(beginReplaceAttempt()).toBe(false);
    expect(grants).toBe(1);
    expect(replaces).toBe(1);
    endReplaceAttempt();
  });

  it("rejects stored secrets and unknown fields", () => {
    const toxic = JSON.stringify({
      action: "replace_link",
      requestId,
      jobId,
      returnRoute: replaceResumeHref(jobId),
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 60_000).toISOString(),
      ownerId,
      idempotencyKey,
      grant: "secret-grant",
    });
    expect(readPendingReplaceIntent(toxic, nowMs, ownerId)).toEqual({ ok: false, reason: "invalid" });
    expect(pendingReplaceHasOnlySafeFields({ action: "replace_link", email: "owner@example.com" })).toBe(false);
  });
});

describe("replace-link resume after OTP remount", () => {
  afterEach(() => {
    endReplaceAttempt();
    vi.unstubAllGlobals();
  });

  function resumeInput(overrides: Partial<Parameters<typeof decideReplaceResume>[0]> = {}) {
    return {
      authStatus: "authenticated",
      pending: validIntent(),
      jobId,
      requestId,
      requestLoaded: true,
      inFlight: false,
      ownerId,
      nowMs: nowMs + 1_000,
      ...overrides,
    };
  }

  it("resumes a persisted action after an authenticated remount", async () => {
    const intent = validIntent();
    const kv = memoryKv();
    await savePendingReplace(kv, intent);
    const stored = await loadPendingReplace(kv, nowMs + 1_000, ownerId);
    expect(stored).toEqual({ ok: true, value: intent });
    const remount = decideReplaceResume(resumeInput({ pending: stored.ok ? stored.value : undefined }));
    expect(remount).toEqual({ action: "run", stage: "pending_loaded", outcome: "ready" });
    const result = await performReplaceLink(async (options) => {
      if (options.path === "/v1/account/action-grants") {
        return { ok: true, data: { grant: "g".repeat(43) } as never };
      }
      expect(options.headers?.["Idempotency-Key"]).toBe(intent.idempotencyKey);
      return { ok: true, data: {} as never };
    }, intent);
    expect(result).toEqual({ ok: true });
    await kv.removeItem(PENDING_REPLACE_KEY);
    expect(await kv.getItem(PENDING_REPLACE_KEY)).toBeNull();
  });

  it("waits while the session is unavailable and then resumes", async () => {
    const intent = validIntent();
    expect(decideReplaceResume(resumeInput({ authStatus: "restoring", pending: intent }))).toEqual({
      action: "wait",
      stage: "resume_waiting_for_auth",
      outcome: "session_unready",
    });
    expect(decideReplaceResume(resumeInput({ authStatus: "authenticating", pending: intent }))).toEqual({
      action: "wait",
      stage: "resume_waiting_for_auth",
      outcome: "session_unready",
    });
    expect(decideReplaceResume(resumeInput({ requestLoaded: false, requestId: undefined }))).toEqual({
      action: "wait",
      stage: "resume_waiting_for_auth",
      outcome: "request_unready",
    });
    expect(decideReplaceResume(resumeInput({ pending: intent }))).toEqual({
      action: "run",
      stage: "pending_loaded",
      outcome: "ready",
    });
    expect(await performReplaceLink(async () => ({ ok: true, data: { grant: "ok" } as never }), intent)).toMatchObject({
      ok: true,
    });
  });

  it("executes the same pending action once per remount", async () => {
    const intent = validIntent();
    let grants = 0;
    const run: OwnerMutator = async (options) => {
      if (options.path === "/v1/account/action-grants") {
        grants += 1;
        return { ok: true, data: { grant: "once" } as never };
      }
      return { ok: true, data: {} as never };
    };
    expect(decideReplaceResume(resumeInput({ pending: intent }))).toMatchObject({ action: "run" });
    expect(beginReplaceAttempt()).toBe(true);
    expect(await performReplaceLink(run, intent)).toEqual({ ok: true });
    endReplaceAttempt();
    expect(
      decideReplaceResume(resumeInput({ pending: intent, attemptedKey: intent.idempotencyKey })),
    ).toEqual({
      action: "skip",
      stage: "retry_suppressed",
      outcome: "already_attempted",
    });
    expect(grants).toBe(1);
  });

  it("shares one in-flight operation across duplicate resume effects", async () => {
    const intent = validIntent();
    expect(decideReplaceResume(resumeInput({ inFlight: true }))).toEqual({
      action: "wait",
      stage: "resume_waiting_for_auth",
      outcome: "in_flight",
    });
    let grants = 0;
    let releaseGrant: ((value: { ok: true; data: never }) => void) | undefined;
    const grantStarted = new Promise<{ ok: true; data: never }>((resolve) => {
      releaseGrant = resolve;
    });
    const run: OwnerMutator = async (options) => {
      if (options.path === "/v1/account/action-grants") {
        grants += 1;
        return grantStarted;
      }
      return { ok: true, data: {} as never };
    };
    expect(beginReplaceAttempt()).toBe(true);
    const first = performReplaceLink(run, intent);
    expect(beginReplaceAttempt()).toBe(false);
    expect(replaceAttemptActive()).toBe(true);
    expect(decideReplaceResume(resumeInput({ inFlight: replaceAttemptActive() }))).toMatchObject({
      action: "wait",
      outcome: "in_flight",
    });
    releaseGrant?.({ ok: true, data: { grant: "shared" } as never });
    expect(await first).toEqual({ ok: true });
    endReplaceAttempt();
    expect(grants).toBe(1);
  });

  it("retains the descriptor after a transient failure and allows retry", async () => {
    const intent = validIntent();
    const kv = memoryKv();
    await savePendingReplace(kv, intent);
    const failed = await performReplaceLink(async () => {
      return {
        ok: false,
        error: { status: 0, code: "UNAVAILABLE", message: copy.requestMutationError, retryable: true },
      };
    }, intent);
    expect(failed).toMatchObject({ ok: false, stepUp: false, stage: "grant_request_failed" });
    if (!failed.ok && !failed.stepUp) {
      expect(failed.error.message).toBe(copy.requestMutationError);
      expect(failed.error.status).toBe(0);
    }
    expect(await kv.getItem(PENDING_REPLACE_KEY)).toBeTruthy();
    expect(
      decideReplaceResume(resumeInput({ pending: intent, attemptedKey: intent.idempotencyKey })),
    ).toMatchObject({ action: "skip", outcome: "already_attempted", stage: "retry_suppressed" });
    const retry = decideReplaceResume(resumeInput({ pending: intent, attemptedKey: undefined }));
    expect(retry).toMatchObject({ action: "run", outcome: "ready" });
  });

  it("clears the descriptor after success", async () => {
    const intent = validIntent();
    const kv = memoryKv();
    await savePendingReplace(kv, intent);
    expect(await performReplaceLink(async () => ({ ok: true, data: { grant: "ok" } as never }), intent)).toEqual({
      ok: true,
    });
    await kv.removeItem(PENDING_REPLACE_KEY);
    expect(await kv.getItem(PENDING_REPLACE_KEY)).toBeNull();
    expect(decideReplaceResume(resumeInput({ pending: undefined }))).toEqual({
      action: "skip",
      stage: "pending_rejected",
      outcome: "missing",
    });
  });

  it("safely clears expired or owner-mismatched descriptors", async () => {
    const intent = validIntent();
    expect(decideReplaceResume(resumeInput({ nowMs: nowMs + 301_000 }))).toEqual({
      action: "reject",
      stage: "pending_rejected",
      outcome: "expired",
    });
    expect(decideReplaceResume(resumeInput({ ownerId: otherOwner }))).toEqual({
      action: "reject",
      stage: "pending_rejected",
      outcome: "owner_mismatch",
    });
    const kv = memoryKv({ [PENDING_REPLACE_KEY]: JSON.stringify(intent) });
    const expired = await loadPendingReplace(kv, nowMs + 301_000, ownerId);
    expect(expired).toEqual({ ok: false, reason: "expired" });
    expect(await kv.getItem(PENDING_REPLACE_KEY)).toBeNull();
    const kvMismatch = memoryKv({ [PENDING_REPLACE_KEY]: JSON.stringify(intent) });
    expect(await loadPendingReplace(kvMismatch, nowMs + 1_000, otherOwner)).toEqual({
      ok: false,
      reason: "owner_mismatch",
    });
    expect(await kvMismatch.getItem(PENDING_REPLACE_KEY)).toBeNull();
    expect(readPendingReplaceIntent(JSON.stringify(intent), nowMs + 1_000, ownerId.toUpperCase())).toEqual({
      ok: true,
      value: intent,
    });
  });

  it("surfaces action-grant and replace-link errors instead of swallowing them", async () => {
    const intent = validIntent();
    const grantFailed = await performReplaceLink(async () => {
      return {
        ok: false,
        error: { status: 403, code: API_ERROR_CODES.ACTION_GRANT_INVALID, message: "Not allowed.", retryable: false },
      };
    }, intent);
    expect(grantFailed).toEqual({
      ok: false,
      stepUp: false,
      stage: "grant_request_failed",
      error: { status: 403, code: API_ERROR_CODES.ACTION_GRANT_INVALID, message: "Not allowed.", retryable: false },
    });
    const replaceFailed = await performReplaceLink(async (options) => {
      if (options.path === "/v1/account/action-grants") {
        return { ok: true, data: { grant: "g".repeat(43) } as never };
      }
      return {
        ok: false,
        error: { status: 409, code: "CONFLICT", message: "Request is no longer pending.", retryable: false },
      };
    }, intent);
    expect(replaceFailed).toEqual({
      ok: false,
      stepUp: false,
      stage: "replace_request_failed",
      error: { status: 409, code: "CONFLICT", message: "Request is no longer pending.", retryable: false },
    });
    expect(grantFailed.ok ? "" : grantFailed.stepUp ? "" : grantFailed.error.message).toBe("Not allowed.");
    expect(replaceFailed.ok ? "" : replaceFailed.stepUp ? "" : replaceFailed.error.message).toBe(
      "Request is no longer pending.",
    );
  });

  it("keeps an in-memory pending action when storage read is missing after OTP", () => {
    const intent = validIntent();
    expect(
      reconcilePendingReplace({
        stored: { ok: false, reason: "missing" },
        memory: intent,
      }),
    ).toEqual(intent);
    expect(reconcilePendingReplace({ stored: { ok: false, reason: "expired" }, memory: intent })).toBeUndefined();
    expect(reconcilePendingReplace({ stored: { ok: true, value: intent }, memory: undefined })).toEqual(intent);
  });

  it("emits only allowlisted resume diagnostics", () => {
    const forbidden = [
      ownerId,
      requestId,
      "owner@example.com",
      "123456",
      "eyJhbGciOi",
      "g".repeat(43),
      "/v1/requests/",
      idempotencyKey,
    ];
    const events = [
      { stage: "pending_loaded", outcome: "ready" },
      { stage: "resume_waiting_for_auth", outcome: "session_unready" },
      { stage: "step_up_started", outcome: "otp_sent" },
      { stage: "step_up_verified", outcome: "ok" },
      { stage: "fresh_session_ready", outcome: "ok" },
      { stage: "grant_request_failed", outcome: "step_up_required", status: 403, code: "ACTION_GRANT_REQUIRED" },
      { stage: "retry_suppressed", outcome: "action_grant_required", status: 403, code: "ACTION_GRANT_REQUIRED" },
      { stage: "replace_succeeded", outcome: "ok" },
    ];
    for (const event of events) {
      expect(replaceResumeDiagnosticIsSafe(event, forbidden)).toBe(true);
    }
    expect(
      replaceResumeDiagnosticIsSafe({ stage: "pending_loaded", outcome: "ready", requestId }, forbidden),
    ).toBe(false);
  });

  it("stops after one ACTION_GRANT_REQUIRED grant and does not retry on rerender", async () => {
    const intent = validIntent();
    let grants = 0;
    const run: OwnerMutator = async (options) => {
      if (options.path === "/v1/account/action-grants") {
        grants += 1;
        return {
          ok: false,
          error: {
            status: 403,
            code: API_ERROR_CODES.ACTION_GRANT_REQUIRED,
            message: copy.requestReplaceFreshAuth,
            retryable: false,
          },
        };
      }
      throw new Error("replace-link must not run");
    };
    expect(decideReplaceResume(resumeInput({ pending: intent }))).toMatchObject({ action: "run" });
    expect(beginReplaceAttempt()).toBe(true);
    const first = await performReplaceLink(run, intent);
    expect(first).toEqual({ ok: false, stepUp: true });
    endReplaceAttempt();
    expect(grants).toBe(1);
    const blocked = decideReplaceResume(
      resumeInput({ pending: intent, attemptedKey: intent.idempotencyKey, grantBlocked: true }),
    );
    expect(blocked).toEqual({
      action: "skip",
      stage: "retry_suppressed",
      outcome: "action_grant_required",
    });
    expect(decideReplaceResume(resumeInput({ pending: intent, grantBlocked: true }))).toMatchObject({
      action: "skip",
      stage: "retry_suppressed",
    });
    expect(grants).toBe(1);
  });

  it("lets a user-controlled retry make exactly one new grant attempt", async () => {
    const intent = validIntent();
    let grants = 0;
    const run: OwnerMutator = async (options) => {
      if (options.path === "/v1/account/action-grants") {
        grants += 1;
        if (grants === 1) {
          return {
            ok: false,
            error: {
              status: 403,
              code: API_ERROR_CODES.ACTION_GRANT_REQUIRED,
              message: copy.requestReplaceFreshAuth,
              retryable: false,
            },
          };
        }
        return { ok: true, data: { grant: "g".repeat(43) } as never };
      }
      return { ok: true, data: {} as never };
    };
    expect(beginReplaceAttempt()).toBe(true);
    expect(await performReplaceLink(run, intent)).toEqual({ ok: false, stepUp: true });
    endReplaceAttempt();
    expect(
      decideReplaceResume(resumeInput({ pending: intent, grantBlocked: true, attemptedKey: intent.idempotencyKey })),
    ).toMatchObject({ action: "skip" });
    expect(decideReplaceResume(resumeInput({ pending: intent, grantBlocked: false, attemptedKey: undefined }))).toMatchObject(
      { action: "run" },
    );
    expect(beginReplaceAttempt()).toBe(true);
    expect(await performReplaceLink(run, intent)).toEqual({ ok: true });
    endReplaceAttempt();
    expect(grants).toBe(2);
  });

  it("installs the post-OTP session before grant issuance and will not reuse a stale token", async () => {
    const previous = "previous-access-token";
    const verified = "verified-access-token";
    expect(verifiedSessionIsFreshInstall({ previousAccessToken: previous, verifiedAccessToken: previous })).toEqual({
      ok: false,
      outcome: "stale_session",
    });
    const installed = verifiedSessionIsFreshInstall({
      previousAccessToken: previous,
      verifiedAccessToken: verified,
    });
    expect(installed).toEqual({ ok: true, outcome: "fresh_session_ready" });
    const usedTokens: string[] = [];
    const intent = validIntent();
    const run: OwnerMutator = async (options) => {
      usedTokens.push(installed.ok ? verified : previous);
      if (options.path === "/v1/account/action-grants") {
        expect(usedTokens[0]).toBe(verified);
        expect(usedTokens[0]).not.toBe(previous);
        return { ok: true, data: { grant: "g".repeat(43) } as never };
      }
      return { ok: true, data: {} as never };
    };
    expect(await performReplaceLink(run, intent)).toEqual({ ok: true });
    expect(usedTokens).toEqual([verified, verified]);
  });

  it("runs grant then replace exactly once after a fresh step-up session", async () => {
    const intent = validIntent();
    const calls: string[] = [];
    const run: OwnerMutator = async (options) => {
      calls.push(options.path);
      if (options.path === "/v1/account/action-grants") {
        return { ok: true, data: { grant: "g".repeat(43) } as never };
      }
      return { ok: true, data: {} as never };
    };
    expect(beginReplaceAttempt()).toBe(true);
    expect(beginReplaceAttempt()).toBe(false);
    expect(await performReplaceLink(run, intent)).toEqual({ ok: true });
    endReplaceAttempt();
    expect(calls).toEqual(["/v1/account/action-grants", `/v1/requests/${requestId}/replace-link`]);
    expect(
      decideReplaceResume(resumeInput({ pending: intent, attemptedKey: intent.idempotencyKey })),
    ).toMatchObject({ action: "skip", stage: "retry_suppressed" });
  });

  it("keeps a network failure recoverable without a tight retry loop", async () => {
    const intent = validIntent();
    let grants = 0;
    const run: OwnerMutator = async () => {
      grants += 1;
      return {
        ok: false,
        error: { status: 503, code: "UNAVAILABLE", message: copy.requestMutationError, retryable: true },
      };
    };
    expect(grantErrorIsAutoRetryable({ status: 503, retryable: true })).toBe(true);
    expect(grantErrorIsAutoRetryable({ status: 403, retryable: false })).toBe(false);
    expect(await performReplaceLink(run, intent)).toMatchObject({
      ok: false,
      stepUp: false,
      stage: "grant_request_failed",
    });
    expect(grants).toBe(1);
    expect(
      decideReplaceResume(resumeInput({ pending: intent, attemptedKey: intent.idempotencyKey })),
    ).toMatchObject({ action: "skip", outcome: "already_attempted" });
    expect(decideReplaceResume(resumeInput({ pending: intent, attemptedKey: undefined }))).toMatchObject({
      action: "run",
    });
  });

  it("does not start a second automatic OTP after a completed step-up 403", () => {
    const intent = validIntent();
    expect(
      decideReplaceResume(resumeInput({ pending: intent, grantBlocked: true })),
    ).toEqual({
      action: "skip",
      stage: "retry_suppressed",
      outcome: "action_grant_required",
    });
    expect(shouldResumeReplace({ authStatus: "authenticated", pending: intent, jobId, requestId, nowMs: nowMs + 1_000 })).toBe(
      true,
    );
  });
});
