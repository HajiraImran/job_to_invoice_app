import type { ApiError } from "../api/client.ts";
import type { EncryptedSqliteHandle } from "../storage/encrypted-database.ts";
import { getLocalDraft, setLocalDraftSyncState, upsertLocalDraft } from "./repository.ts";
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
  rebasePendingOutboxVersions,
  resumeOutboxAfterConflict,
} from "../sync/outbox.ts";
import { isStorageError, type StorageErrorCode } from "../storage/storage-error.ts";
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

export type LocalPersistStage = "map_patch_body" | "read_existing" | "upsert_draft" | "enqueue_outbox" | "mark_queued";

export type LocalPersistFailureCode = "MAP_FAILED" | "OUTBOX_FORBIDDEN" | StorageErrorCode;

function persistFailureCode(error: unknown): LocalPersistFailureCode | undefined {
  if (isStorageError(error)) {
    return error.code;
  }
  if (error instanceof Error && error.message === "OUTBOX_FORBIDDEN") {
    return "OUTBOX_FORBIDDEN";
  }
  return undefined;
}

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
): Promise<{ status: DraftPersistStatus; stage?: LocalPersistStage; code?: LocalPersistFailureCode }> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  let stage: LocalPersistStage = "read_existing";
  try {
    const existingDraft = await getLocalDraft(db, input.draftId);
    const keptServerVersion =
      existingDraft &&
      existingDraft.syncState !== "conflict" &&
      existingDraft.serverVersion != null &&
      (input.serverVersion == null || existingDraft.serverVersion > input.serverVersion)
        ? existingDraft.serverVersion
        : (input.serverVersion ?? null);
    const baseVersion =
      keptServerVersion != null && keptServerVersion > input.baseVersion ? keptServerVersion : input.baseVersion;
    const payloadJson = JSON.stringify(input.payload);
    stage = "map_patch_body";
    const mapped =
      input.patchBody !== undefined
        ? ownerDraftPatchBodyFromStored(input.patchBody)
        : ownerDraftPatchBodyFromStored(input.payload);
    if (!mapped.ok) {
      return { status: "storage_failure", stage, code: "MAP_FAILED" };
    }
    const bodyJson = JSON.stringify(mapped.value);
    stage = "upsert_draft";
    await upsertLocalDraft(db, {
      draftId: input.draftId,
      jobId: input.jobId,
      kind: input.kind,
      baseVersion,
      serverVersion: keptServerVersion,
      schemaVersion: input.schemaVersion,
      payloadJson,
      syncState: "saving",
      localUpdatedAt: nowIso,
    });
    await upsertLocalDraft(db, {
      draftId: input.draftId,
      jobId: input.jobId,
      kind: input.kind,
      baseVersion,
      serverVersion: keptServerVersion,
      schemaVersion: input.schemaVersion,
      payloadJson,
      syncState: "dirty",
      localUpdatedAt: nowIso,
    });
    stage = "enqueue_outbox";
    await resumeOutboxAfterConflict(db, input.draftId, nowIso);
    await enqueueOutboxOperation(db, {
      operationId: input.operationId,
      resourceKind: "draft",
      resourceId: input.draftId,
      method: "PATCH",
      path: `/v1/drafts/${input.draftId}`,
      bodyJson,
      baseVersion,
      idempotencyKey: input.idempotencyKey,
      nowIso,
    });
    stage = "mark_queued";
    await setLocalDraftSyncState(db, input.draftId, "queued", { nowIso });
    return { status: "saved_on_device", stage };
  } catch (error) {
    return { status: "storage_failure", stage, code: persistFailureCode(error) };
  }
}

async function ifMatchForOperation(
  db: EncryptedSqliteHandle,
  op: { resourceKind: string; resourceId: string; baseVersion: number | null },
): Promise<number | undefined> {
  if (op.baseVersion == null) {
    return undefined;
  }
  if (op.resourceKind !== "draft") {
    return op.baseVersion;
  }
  const local = await getLocalDraft(db, op.resourceId);
  if (
    local &&
    local.syncState !== "conflict" &&
    local.serverVersion != null &&
    local.serverVersion > op.baseVersion
  ) {
    return local.serverVersion;
  }
  return op.baseVersion;
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

const drainTails = new WeakMap<EncryptedSqliteHandle, Promise<void>>();

export async function drainOutbox(
  db: EncryptedSqliteHandle,
  options: Parameters<typeof drainOutboxOnce>[1],
): Promise<DrainOutboxResult> {
  const previous = drainTails.get(db) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  drainTails.set(
    db,
    previous.then(
      () => gate,
      () => gate,
    ),
  );
  await previous.catch(() => undefined);
  try {
    return await drainOutboxOnce(db, options);
  } finally {
    release();
  }
}

async function drainOutboxOnce(
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

  let passes = 0;
  while (passes < 20) {
    passes += 1;
    const runnable = await listRunnableOutboxOperations(db, nowIso);
    if (runnable.length === 0) {
      if (passes > 1) {
        break;
      }
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

    let drainedThisPass = 0;
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
        ifMatch: await ifMatchForOperation(db, op),
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
        const ackedAt = new Date().toISOString();
        await markOutboxDone(db, op.operationId, ackedAt);
        if (op.resourceKind === "draft") {
          const version =
            typeof result.data.version === "number" ? result.data.version : (op.baseVersion ?? 0) + 1;
          await rebasePendingOutboxVersions(db, op.resourceId, version, ackedAt);
          const successor = await db.getFirstAsync<{ operation_id: string }>(
            `select operation_id from outbox_ops
             where resource_id = ? and state in ('pending', 'failed')
             limit 1`,
            [op.resourceId],
          );
          await setLocalDraftSyncState(db, op.resourceId, successor ? "queued" : "synced", {
            baseVersion: version,
            serverVersion: version,
            payloadJson: successor ? undefined : JSON.stringify(result.data),
            nowIso: ackedAt,
          });
        }
        drained += 1;
        drainedThisPass += 1;
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
    if (drainedThisPass === 0) {
      break;
    }
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
