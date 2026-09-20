import type { ApiError } from "../api/client.ts";
import type { EncryptedSqliteHandle } from "../storage/encrypted-database.ts";
import { setLocalDraftSyncState, upsertLocalDraft } from "./repository.ts";
import { ownerDraftPatchBodyFromStored } from "./patch-body.ts";
import {
  countPendingOutboxBlockedByRetry,
  enqueueOutboxOperation,
  listRunnableOutboxOperations,
  markOutboxDone,
  markOutboxFailed,
  markOutboxInFlight,
  markOutboxRetry,
  prepareOutboxForDrain,
} from "../sync/outbox.ts";
import { pauseResourceForConflict } from "../sync/conflict.ts";
import type { SyncConflictAnalyticsProps } from "../sync/analytics.ts";
import {
  emitDrainDiagnostic,
  type DrainDiagOutcome,
} from "../sync/drain-diagnostics.ts";

export type DraftPersistStatus =
  | "saving_locally"
  | "saved_on_device"
  | "synchronizing"
  | "synced"
  | "conflict"
  | "storage_failure";

export type OwnerRequestFn = (options: {
  path: string;
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string | number;
}) => Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: ApiError }>;

export type DrainOutboxResult = {
  drained: number;
  remaining: number;
  conflicts: number;
  /**
   * Distinguishes empty queue from a failed/blocked drain.
   * Manual sync uses forceImmediate so backoff alone cannot produce `ineligible_retry_time`.
   */
  outcome: DrainDiagOutcome;
};

export async function persistDraftLocally(
  db: EncryptedSqliteHandle,
  input: {
    draftId: string;
    jobId: string;
    kind: string;
    schemaVersion: number;
    baseVersion: number;
    serverVersion?: number | null;
    /** Full local snapshot for hydration (may include QuoteDraftRecord envelope). */
    payload: unknown;
    /**
     * Optional pre-mapped PATCH body. When omitted, derived from payload via
     * ownerDraftPatchBodyFromStored so outbox matches the online save contract.
     */
    patchBody?: unknown;
    operationId: string;
    idempotencyKey: string;
    nowIso?: string;
  },
): Promise<{ status: DraftPersistStatus }> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  try {
    const payloadJson = JSON.stringify(input.payload);
    const mapped =
      input.patchBody !== undefined
        ? ownerDraftPatchBodyFromStored(input.patchBody)
        : ownerDraftPatchBodyFromStored(input.payload);
    if (!mapped.ok) {
      return { status: "storage_failure" };
    }
    const bodyJson = JSON.stringify(mapped.value);
    await upsertLocalDraft(db, {
      draftId: input.draftId,
      jobId: input.jobId,
      kind: input.kind,
      baseVersion: input.baseVersion,
      serverVersion: input.serverVersion ?? null,
      schemaVersion: input.schemaVersion,
      payloadJson,
      syncState: "saving",
      localUpdatedAt: nowIso,
    });
    await upsertLocalDraft(db, {
      draftId: input.draftId,
      jobId: input.jobId,
      kind: input.kind,
      baseVersion: input.baseVersion,
      serverVersion: input.serverVersion ?? null,
      schemaVersion: input.schemaVersion,
      payloadJson,
      syncState: "dirty",
      localUpdatedAt: nowIso,
    });
    await enqueueOutboxOperation(db, {
      operationId: input.operationId,
      resourceKind: "draft",
      resourceId: input.draftId,
      method: "PATCH",
      path: `/v1/drafts/${input.draftId}`,
      bodyJson,
      baseVersion: input.baseVersion,
      idempotencyKey: input.idempotencyKey,
      nowIso,
    });
    await setLocalDraftSyncState(db, input.draftId, "queued", { nowIso });
    return { status: "saved_on_device" };
  } catch {
    return { status: "storage_failure" };
  }
}

function classifyRequestFailure(error: ApiError): DrainDiagOutcome {
  if (error.status === 0) {
    return "offline";
  }
  if (error.status === 401 || error.code === "AUTHENTICATION_REQUIRED") {
    return "no_authenticated_session";
  }
  if (error.code === "AUTH_REFRESH_FAILED") {
    return "auth_refresh_failure";
  }
  if (error.status === 422 || error.code === "VALIDATION_FAILED") {
    return "validation_failure";
  }
  if (error.status >= 500 || error.retryable) {
    return "server_failure";
  }
  return "request_failure";
}

export async function drainOutbox(
  db: EncryptedSqliteHandle,
  options: {
    request: OwnerRequestFn;
    nowMs?: number;
    random?: () => number;
    onConflict?: (props: SyncConflictAnalyticsProps) => void;
    /**
     * User-requested Synchronize / sign-out synchronize.
     * Overrides SYNC05 next_attempt_at and reclaims all in_flight rows.
     * Automatic reconnect must leave this false so backoff still applies.
     */
    forceImmediate?: boolean;
  },
): Promise<DrainOutboxResult> {
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const forceImmediate = options.forceImmediate === true;
  let drained = 0;
  let conflicts = 0;
  let lastFailure: DrainDiagOutcome | null = null;

  const prepared = await prepareOutboxForDrain(db, { nowIso, forceImmediate, nowMs });
  if (forceImmediate && (prepared.reclaimedInFlight > 0 || prepared.forcedPending > 0)) {
    emitDrainDiagnostic({
      stage: "prepare",
      outcome: "forced_immediate",
      drained: prepared.reclaimedInFlight,
      remaining: prepared.forcedPending,
    });
  } else if (prepared.reclaimedInFlight > 0) {
    emitDrainDiagnostic({
      stage: "prepare",
      outcome: "forced_immediate",
      drained: prepared.reclaimedInFlight,
    });
  }

  const runnable = await listRunnableOutboxOperations(db, nowIso);
  if (runnable.length === 0) {
    const remainingRows = await db.getFirstAsync<{ n: number }>(
      "select count(*) as n from outbox_ops where state in ('pending', 'in_flight', 'paused_conflict', 'failed')",
    );
    const remaining = remainingRows?.n ?? 0;
    if (remaining === 0) {
      emitDrainDiagnostic({ stage: "complete", outcome: "empty", drained: 0, remaining: 0 });
      return { drained: 0, remaining: 0, conflicts: 0, outcome: "empty" };
    }
    const blocked = await countPendingOutboxBlockedByRetry(db, nowIso);
    const outcome: DrainDiagOutcome =
      blocked > 0 ? "ineligible_retry_time" : "no_executable_operation";
    emitDrainDiagnostic({ stage: "select", outcome, drained: 0, remaining });
    return { drained: 0, remaining, conflicts: 0, outcome };
  }

  for (const op of runnable) {
    await markOutboxInFlight(db, op.operationId, nowIso);
    let parsedBody: unknown;
    try {
      parsedBody = op.bodyJson ? JSON.parse(op.bodyJson) : undefined;
    } catch {
      await markOutboxFailed(db, op.operationId, "INVALID_BODY", nowIso);
      lastFailure = "validation_failure";
      emitDrainDiagnostic({
        stage: "retry",
        outcome: "validation_failure",
        operationKind: op.resourceKind === "job" ? "job" : "draft",
      });
      continue;
    }

    let body = parsedBody;
    if (op.resourceKind === "draft") {
      const mapped = ownerDraftPatchBodyFromStored(parsedBody);
      if (!mapped.ok) {
        await markOutboxFailed(db, op.operationId, "VALIDATION_FAILED", nowIso);
        lastFailure = "validation_failure";
        emitDrainDiagnostic({
          stage: "retry",
          outcome: "validation_failure",
          operationKind: "draft",
          httpStatus: 422,
        });
        continue;
      }
      body = mapped.value;
    }

    let result: { ok: true; data: Record<string, unknown> } | { ok: false; error: ApiError };
    try {
      result = await options.request({
        path: op.path,
        method: op.method,
        body,
        idempotencyKey: op.idempotencyKey,
        ifMatch: op.baseVersion ?? undefined,
      });
    } catch {
      await markOutboxRetry(db, op.operationId, op.attempts + 1, "UNAVAILABLE", Date.now(), options.random);
      lastFailure = "request_failure";
      emitDrainDiagnostic({
        stage: "request",
        outcome: "request_failure",
        operationKind: op.resourceKind === "job" ? "job" : "draft",
      });
      continue;
    }

    if (result.ok) {
      try {
        await markOutboxDone(db, op.operationId, new Date().toISOString());
        if (op.resourceKind === "draft") {
          const version =
            typeof result.data.version === "number" ? result.data.version : (op.baseVersion ?? 0) + 1;
          await setLocalDraftSyncState(db, op.resourceId, "synced", {
            baseVersion: version,
            serverVersion: version,
            payloadJson: JSON.stringify(result.data),
            nowIso: new Date().toISOString(),
          });
        }
        drained += 1;
        emitDrainDiagnostic({
          stage: "ack",
          outcome: "drained",
          operationKind: op.resourceKind === "job" ? "job" : "draft",
          httpStatus: 200,
        });
      } catch {
        await markOutboxRetry(db, op.operationId, op.attempts + 1, "LOCAL_ACK_FAILED", Date.now(), options.random);
        lastFailure = "local_ack_failure";
        emitDrainDiagnostic({
          stage: "ack",
          outcome: "local_ack_failure",
          operationKind: op.resourceKind === "job" ? "job" : "draft",
        });
      }
      continue;
    }

    if (result.error.code === "VERSION_CONFLICT" || result.error.status === 409) {
      const analytics = await pauseResourceForConflict(db, {
        draftId: op.resourceId,
        operationId: op.operationId,
        localJson: op.bodyJson ?? "{}",
        serverJson: JSON.stringify({ code: "VERSION_CONFLICT" }),
        nowIso: new Date().toISOString(),
      });
      options.onConflict?.(analytics);
      conflicts += 1;
      lastFailure = "conflict";
      emitDrainDiagnostic({
        stage: "conflict",
        outcome: "conflict",
        operationKind: op.resourceKind === "job" ? "job" : "draft",
        httpStatus: 409,
      });
      continue;
    }

    if (result.error.status === 422 || result.error.code === "VALIDATION_FAILED") {
      await markOutboxFailed(db, op.operationId, result.error.code || "VALIDATION_FAILED", new Date().toISOString());
      lastFailure = "validation_failure";
      emitDrainDiagnostic({
        stage: "retry",
        outcome: "validation_failure",
        operationKind: op.resourceKind === "job" ? "job" : "draft",
        httpStatus: 422,
      });
      continue;
    }

    const failure = classifyRequestFailure(result.error);
    lastFailure = failure;
    await markOutboxRetry(
      db,
      op.operationId,
      op.attempts + 1,
      result.error.code || "FAILED",
      Date.now(),
      options.random,
    );
    emitDrainDiagnostic({
      stage: "retry",
      outcome: failure,
      operationKind: op.resourceKind === "job" ? "job" : "draft",
      httpStatus: result.error.status,
    });
  }

  const remainingRows = await db.getFirstAsync<{ n: number }>(
    "select count(*) as n from outbox_ops where state in ('pending', 'in_flight', 'paused_conflict', 'failed')",
  );
  const remaining = remainingRows?.n ?? 0;
  const outcome: DrainDiagOutcome =
    conflicts > 0
      ? "conflict"
      : remaining === 0
        ? "drained"
        : lastFailure ?? (drained > 0 ? "drained" : "no_executable_operation");
  emitDrainDiagnostic({ stage: "complete", outcome, drained, remaining });
  return { drained, remaining, conflicts, outcome };
}
