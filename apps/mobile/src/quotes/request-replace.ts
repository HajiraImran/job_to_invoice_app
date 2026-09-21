import type { ApiError } from "../api/client.ts";
import {
  clearPendingReplace,
  createPendingReplaceIntent,
  emitReplaceResumeDiagnostic,
  grantRequiresFreshAuth,
  savePendingReplace,
  shouldResumeReplace,
  type PendingReplaceIntent,
} from "./pending-replace.ts";
import { grantErrorIsAutoRetryable } from "../session/step-up.ts";
import type { SecureKv } from "../session/storage.ts";

export type ReplaceGrantResult =
  | { ok: true; grant: string }
  | { ok: false; stepUp: true }
  | { ok: false; stepUp: false; error: ApiError };

export type ReplaceMutationResult = { ok: true } | { ok: false; error: ApiError };

export type ReplacePerformResult =
  | { ok: true }
  | { ok: false; stepUp: true }
  | { ok: false; stepUp: false; error: ApiError; stage: "grant_request_failed" | "replace_request_failed" };

export type OwnerMutator = <T>(options: {
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}) => Promise<{ ok: true; data: T } | { ok: false; error: ApiError }>;

let replaceInFlight = false;

export function beginReplaceAttempt(): boolean {
  if (replaceInFlight) {
    return false;
  }
  replaceInFlight = true;
  return true;
}

export function endReplaceAttempt(): void {
  replaceInFlight = false;
}

export function replaceAttemptActive(): boolean {
  return replaceInFlight;
}

export async function issueReplaceGrant(run: OwnerMutator): Promise<ReplaceGrantResult> {
  const result = await run<{ grant: string; action?: string }>({
    path: "/v1/account/action-grants",
    method: "POST",
    body: { action: "replace_link" },
  });
  if (result.ok && typeof result.data.grant === "string" && result.data.grant.length > 0) {
    return { ok: true, grant: result.data.grant };
  }
  if (!result.ok && grantRequiresFreshAuth(result.error)) {
    return { ok: false, stepUp: true };
  }
  return {
    ok: false,
    stepUp: false,
    error: result.ok
      ? { status: 500, code: "UNAVAILABLE", message: "Request failed.", retryable: true }
      : result.error,
  };
}

export async function submitReplaceLink(
  run: OwnerMutator,
  input: { requestId: string; grant: string; idempotencyKey: string },
): Promise<ReplaceMutationResult> {
  const result = await run({
    path: `/v1/requests/${input.requestId}/replace-link`,
    method: "POST",
    body: {},
    headers: {
      "Idempotency-Key": input.idempotencyKey,
      "X-Action-Grant": input.grant,
    },
  });
  if (result.ok) {
    return { ok: true };
  }
  return { ok: false, error: result.error };
}

export async function performReplaceLink(run: OwnerMutator, intent: PendingReplaceIntent): Promise<ReplacePerformResult> {
  emitReplaceResumeDiagnostic({ stage: "grant_request_started", outcome: "started" });
  const grantResult = await issueReplaceGrant(run);
  if (!grantResult.ok && grantResult.stepUp) {
    emitReplaceResumeDiagnostic({
      stage: "grant_request_failed",
      outcome: "step_up_required",
      status: 403,
      code: "ACTION_GRANT_REQUIRED",
    });
    return grantResult;
  }
  if (!grantResult.ok) {
    emitReplaceResumeDiagnostic({
      stage: "grant_request_failed",
      outcome: grantErrorIsAutoRetryable(grantResult.error) ? "retryable" : "error",
      status: grantResult.error.status,
      code: grantResult.error.code,
    });
    return { ok: false, stepUp: false, error: grantResult.error, stage: "grant_request_failed" };
  }
  emitReplaceResumeDiagnostic({ stage: "replace_request_started", outcome: "started" });
  const replaceResult = await submitReplaceLink(run, {
    requestId: intent.requestId,
    grant: grantResult.grant,
    idempotencyKey: intent.idempotencyKey,
  });
  if (!replaceResult.ok) {
    emitReplaceResumeDiagnostic({
      stage: "replace_request_failed",
      outcome: "error",
      status: replaceResult.error.status,
      code: replaceResult.error.code,
    });
    return { ok: false, stepUp: false, error: replaceResult.error, stage: "replace_request_failed" };
  }
  emitReplaceResumeDiagnostic({ stage: "replace_succeeded", outcome: "ok" });
  return { ok: true };
}

export async function persistReplaceIntent(
  storage: SecureKv,
  intent: PendingReplaceIntent,
): Promise<PendingReplaceIntent> {
  await savePendingReplace(storage, intent);
  return intent;
}

export async function forgetReplaceIntent(storage: SecureKv): Promise<void> {
  await clearPendingReplace(storage);
}

export function buildReplaceIntent(input: {
  requestId: string;
  jobId: string;
  ownerId: string;
  idempotencyKey: string;
  nowMs: number;
}): PendingReplaceIntent | undefined {
  return createPendingReplaceIntent(input);
}

export function canResumeStoredReplace(input: {
  authStatus: string;
  pending?: PendingReplaceIntent;
  jobId: string;
  requestId?: string;
  nowMs?: number;
}): boolean {
  return shouldResumeReplace(input);
}
