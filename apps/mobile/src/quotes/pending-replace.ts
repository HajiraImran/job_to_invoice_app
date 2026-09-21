import { ACTION_GRANT_FRESH_AUTH_SECONDS, API_ERROR_CODES, isClientUuid } from "@job-to-invoice/schemas";
import { jobRequestPath } from "../jobs/routes.ts";
import { PENDING_REPLACE_KEY, type SecureKv } from "../session/storage.ts";

export { PENDING_REPLACE_KEY };
export const PENDING_REPLACE_TTL_MS = ACTION_GRANT_FRESH_AUTH_SECONDS * 1000;

export const PENDING_REPLACE_FIELDS = [
  "action",
  "requestId",
  "jobId",
  "returnRoute",
  "createdAt",
  "expiresAt",
  "ownerId",
  "idempotencyKey",
] as const;

export type PendingReplaceIntent = {
  action: "replace_link";
  requestId: string;
  jobId: string;
  returnRoute: string;
  createdAt: string;
  expiresAt: string;
  ownerId: string;
  idempotencyKey: string;
};

export type PendingReplaceRead =
  | { ok: true; value: PendingReplaceIntent }
  | { ok: false; reason: "missing" | "invalid" | "expired" | "owner_mismatch" };

export type ReplaceResumeStage =
  | "pending_loaded"
  | "pending_rejected"
  | "resume_waiting_for_auth"
  | "step_up_started"
  | "step_up_verified"
  | "fresh_session_ready"
  | "grant_request_started"
  | "grant_request_failed"
  | "retry_suppressed"
  | "replace_request_started"
  | "replace_request_failed"
  | "replace_succeeded";

export type ReplaceResumeAction = "wait" | "run" | "skip" | "reject";

export type ReplaceResumeDecision = {
  action: ReplaceResumeAction;
  stage: Extract<
    ReplaceResumeStage,
    "pending_loaded" | "pending_rejected" | "resume_waiting_for_auth" | "retry_suppressed"
  >;
  outcome: string;
};

export type ReplaceResumeDiagnostic = {
  stage: ReplaceResumeStage;
  outcome: string;
  status?: number;
  code?: string;
};

const SENSITIVE = /otp|access_token|refresh_token|grant|authorization|portal|@/i;
const REPLACE_DIAG_ALLOWED = new Set(["stage", "outcome", "status", "code"]);

export function ownerIdsMatch(left?: string, right?: string): boolean {
  if (!left || !right) {
    return true;
  }
  return left.toLowerCase() === right.toLowerCase();
}

export function replaceResumeHref(jobId: string): string | undefined {
  if (!isClientUuid(jobId)) {
    return undefined;
  }
  return jobRequestPath(jobId);
}

export function parseReplaceResumeHref(href: string): { jobId: string } | undefined {
  const match = href.match(/^\/\(tabs\)\/jobs\/([0-9a-fA-F-]{36})\/request$/);
  if (!match || !isClientUuid(match[1])) {
    return undefined;
  }
  return { jobId: match[1] };
}

export function isSafeReplaceResumeHref(href: string | undefined): href is string {
  return Boolean(href && parseReplaceResumeHref(href));
}

export function segmentsMatchReplaceResume(segments: readonly string[], href: string): boolean {
  const parsed = parseReplaceResumeHref(href);
  if (!parsed) {
    return false;
  }
  return (
    segments[0] === "(tabs)" &&
    segments[1] === "jobs" &&
    segments[2] === parsed.jobId &&
    segments[3] === "request"
  );
}

export function createPendingReplaceIntent(input: {
  requestId: string;
  jobId: string;
  ownerId: string;
  idempotencyKey: string;
  nowMs: number;
}): PendingReplaceIntent | undefined {
  const returnRoute = replaceResumeHref(input.jobId);
  if (
    !returnRoute ||
    !isClientUuid(input.requestId) ||
    !isClientUuid(input.ownerId) ||
    !isClientUuid(input.idempotencyKey)
  ) {
    return undefined;
  }
  return {
    action: "replace_link",
    requestId: input.requestId,
    jobId: input.jobId,
    returnRoute,
    createdAt: new Date(input.nowMs).toISOString(),
    expiresAt: new Date(input.nowMs + PENDING_REPLACE_TTL_MS).toISOString(),
    ownerId: input.ownerId,
    idempotencyKey: input.idempotencyKey,
  };
}

export function readPendingReplaceIntent(
  raw: string | null | undefined,
  nowMs: number,
  ownerId?: string,
): PendingReplaceRead {
  if (raw == null || raw === "") {
    return { ok: false, reason: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid" };
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(PENDING_REPLACE_FIELDS as readonly string[]).includes(key))) {
    return { ok: false, reason: "invalid" };
  }
  if (record.action !== "replace_link") {
    return { ok: false, reason: "invalid" };
  }
  const returnRoute = typeof record.returnRoute === "string" ? record.returnRoute : "";
  const resume = parseReplaceResumeHref(returnRoute);
  if (
    !isClientUuid(record.requestId) ||
    !isClientUuid(record.jobId) ||
    !isClientUuid(record.ownerId) ||
    !isClientUuid(record.idempotencyKey) ||
    !resume ||
    resume.jobId !== record.jobId ||
    typeof record.createdAt !== "string" ||
    typeof record.expiresAt !== "string"
  ) {
    return { ok: false, reason: "invalid" };
  }
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return { ok: false, reason: "expired" };
  }
  if (ownerId && !ownerIdsMatch(ownerId, record.ownerId)) {
    return { ok: false, reason: "owner_mismatch" };
  }
  return {
    ok: true,
    value: {
      action: "replace_link",
      requestId: record.requestId,
      jobId: record.jobId,
      returnRoute,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      ownerId: record.ownerId,
      idempotencyKey: record.idempotencyKey,
    },
  };
}

export function pendingReplaceHasOnlySafeFields(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(PENDING_REPLACE_FIELDS as readonly string[]).includes(key))) {
    return false;
  }
  return !SENSITIVE.test(JSON.stringify(record));
}

export function grantRequiresFreshAuth(error: { status: number; code?: string } | undefined): boolean {
  return error?.status === 403 && error.code === API_ERROR_CODES.ACTION_GRANT_REQUIRED;
}

export function shouldResumeReplace(input: {
  authStatus: string;
  pending?: PendingReplaceIntent;
  jobId: string;
  requestId?: string;
  nowMs?: number;
}): boolean {
  return decideReplaceResume({ ...input, requestLoaded: true }).action === "run";
}

export function reconcilePendingReplace(input: {
  stored: PendingReplaceRead;
  memory?: PendingReplaceIntent;
}): PendingReplaceIntent | undefined {
  if (input.stored.ok) {
    return input.stored.value;
  }
  if (input.stored.reason === "missing") {
    return input.memory;
  }
  return undefined;
}

export function decideReplaceResume(input: {
  authStatus: string;
  pending?: PendingReplaceIntent;
  jobId: string;
  requestId?: string;
  requestLoaded?: boolean;
  inFlight?: boolean;
  attemptedKey?: string;
  grantBlocked?: boolean;
  ownerId?: string;
  nowMs?: number;
}): ReplaceResumeDecision {
  if (input.inFlight) {
    return { action: "wait", stage: "resume_waiting_for_auth", outcome: "in_flight" };
  }
  if (!input.pending) {
    return { action: "skip", stage: "pending_rejected", outcome: "missing" };
  }
  if (input.grantBlocked) {
    return { action: "skip", stage: "retry_suppressed", outcome: "action_grant_required" };
  }
  const nowMs = input.nowMs ?? Date.now();
  const expiresAt = Date.parse(input.pending.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return { action: "reject", stage: "pending_rejected", outcome: "expired" };
  }
  if (!ownerIdsMatch(input.ownerId, input.pending.ownerId)) {
    return { action: "reject", stage: "pending_rejected", outcome: "owner_mismatch" };
  }
  if (input.pending.jobId !== input.jobId) {
    return { action: "skip", stage: "pending_rejected", outcome: "job_mismatch" };
  }
  if (
    input.authStatus === "restoring" ||
    input.authStatus === "authenticating" ||
    input.authStatus === "awaiting_code"
  ) {
    return { action: "wait", stage: "resume_waiting_for_auth", outcome: "session_unready" };
  }
  if (input.authStatus === "offline_cached") {
    return { action: "skip", stage: "pending_rejected", outcome: "offline" };
  }
  if (input.authStatus !== "authenticated") {
    return { action: "skip", stage: "pending_rejected", outcome: "not_authenticated" };
  }
  if (input.requestLoaded === false) {
    return { action: "wait", stage: "resume_waiting_for_auth", outcome: "request_unready" };
  }
  if (input.requestId && input.pending.requestId !== input.requestId) {
    return { action: "skip", stage: "pending_rejected", outcome: "request_mismatch" };
  }
  if (input.attemptedKey && input.attemptedKey === input.pending.idempotencyKey) {
    return { action: "skip", stage: "retry_suppressed", outcome: "already_attempted" };
  }
  return { action: "run", stage: "pending_loaded", outcome: "ready" };
}

export function emitReplaceResumeDiagnostic(event: ReplaceResumeDiagnostic): void {
  if (typeof __DEV__ === "undefined" || !__DEV__) {
    return;
  }
  const payload: Record<string, unknown> = { stage: event.stage, outcome: event.outcome };
  if (typeof event.status === "number") {
    payload.status = event.status;
  }
  if (typeof event.code === "string" && event.code.length > 0) {
    payload.code = event.code;
  }
  console.info("[replace.resume]", JSON.stringify(payload));
}

export function replaceResumeDiagnosticIsSafe(
  event: Record<string, unknown>,
  forbiddenFragments: readonly string[],
): boolean {
  for (const key of Object.keys(event)) {
    if (!REPLACE_DIAG_ALLOWED.has(key)) {
      return false;
    }
  }
  const serialized = JSON.stringify(event);
  return !forbiddenFragments.some((fragment) => fragment.length > 0 && serialized.includes(fragment));
}

export async function loadPendingReplace(
  storage: SecureKv,
  nowMs: number,
  ownerId?: string,
): Promise<PendingReplaceRead> {
  const raw = await storage.getItem(PENDING_REPLACE_KEY);
  const read = readPendingReplaceIntent(raw, nowMs, ownerId);
  if (!read.ok && read.reason !== "missing") {
    await storage.removeItem(PENDING_REPLACE_KEY);
  }
  return read;
}

export async function savePendingReplace(storage: SecureKv, intent: PendingReplaceIntent): Promise<void> {
  await storage.setItem(PENDING_REPLACE_KEY, JSON.stringify(intent));
}

export async function clearPendingReplace(storage: SecureKv): Promise<void> {
  await storage.removeItem(PENDING_REPLACE_KEY);
}
