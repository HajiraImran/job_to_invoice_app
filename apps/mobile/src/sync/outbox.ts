import type { EncryptedSqliteHandle } from "../storage/encrypted-database.ts";
import { StorageError } from "../storage/storage-error.ts";
import { assertOutboxOperationAllowed, type OutboxResourceKind } from "./outbox-rules.ts";
import {
  OUTBOX_IN_FLIGHT_LEASE_MS,
  OUTBOX_MAX_IN_FLIGHT,
  nextAttemptAtIso,
  type RandomUnitFn,
} from "./retry.ts";

export type OutboxOpState = "pending" | "in_flight" | "paused_conflict" | "done" | "failed";

export type OutboxOperation = {
  operationId: string;
  resourceKind: OutboxResourceKind;
  resourceId: string;
  method: string;
  path: string;
  bodyJson: string | null;
  baseVersion: number | null;
  idempotencyKey: string;
  dependencyIds: string[];
  state: OutboxOpState;
  attempts: number;
  nextAttemptAt: string;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

function parseDeps(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function mapRow(row: Record<string, unknown>): OutboxOperation {
  return {
    operationId: String(row.operation_id),
    resourceKind: row.resource_kind as OutboxResourceKind,
    resourceId: String(row.resource_id),
    method: String(row.method),
    path: String(row.path),
    bodyJson: row.body_json === null || row.body_json === undefined ? null : String(row.body_json),
    baseVersion: row.base_version === null || row.base_version === undefined ? null : Number(row.base_version),
    idempotencyKey: String(row.idempotency_key),
    dependencyIds: parseDeps(String(row.dependency_ids_json ?? "[]")),
    state: String(row.state) as OutboxOpState,
    attempts: Number(row.attempts),
    nextAttemptAt: String(row.next_attempt_at),
    lastErrorCode: row.last_error_code === null || row.last_error_code === undefined ? null : String(row.last_error_code),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function getOpenOutboxForResource(
  db: EncryptedSqliteHandle,
  resourceId: string,
): Promise<OutboxOperation | null> {
  try {
    const row = await db.getFirstAsync<Record<string, unknown>>(
      "select * from outbox_ops where resource_id = ? and state in ('pending', 'in_flight', 'paused_conflict', 'failed') order by created_at asc limit 1",
      [resourceId],
    );
    return row ? mapRow(row) : null;
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function countUnsyncedWork(db: EncryptedSqliteHandle): Promise<number> {
  try {
    const outbox = await db.getFirstAsync<{ n: number }>(
      "select count(*) as n from outbox_ops where state in ('pending', 'in_flight', 'paused_conflict', 'failed')",
    );
    const drafts = await db.getFirstAsync<{ n: number }>(
      "select count(*) as n from local_drafts where sync_state in ('dirty', 'queued', 'conflict', 'saving')",
    );
    const jobs = await db.getFirstAsync<{ n: number }>(
      "select count(*) as n from jobs_cache where sync_badge = 'pending' and server_confirmed = 0",
    );
    return (outbox?.n ?? 0) + (drafts?.n ?? 0) + (jobs?.n ?? 0);
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function enqueueOutboxOperation(
  db: EncryptedSqliteHandle,
  input: {
    operationId: string;
    resourceKind: OutboxResourceKind;
    resourceId: string;
    method: string;
    path: string;
    bodyJson?: string | null;
    baseVersion?: number | null;
    idempotencyKey: string;
    dependencyIds?: string[];
    nowIso?: string;
  },
): Promise<OutboxOperation> {
  assertOutboxOperationAllowed({
    method: input.method,
    path: input.path,
    resourceKind: input.resourceKind,
  });

  const nowIso = input.nowIso ?? new Date().toISOString();
  try {
    const existingForResource = await db.getFirstAsync<{ operation_id: string; state: string }>(
      "select operation_id, state from outbox_ops where resource_id = ? and state in ('pending', 'in_flight', 'paused_conflict', 'failed') order by updated_at desc limit 1",
      [input.resourceId],
    );
    if (existingForResource && existingForResource.operation_id !== input.operationId) {
      // Replace open body for same resource by updating the existing op when not in flight.
      if (existingForResource.state === "in_flight" || existingForResource.state === "paused_conflict") {
        throw new StorageError("SYNC_PAUSED");
      }
      await db.runAsync(
        `update outbox_ops set
          method = ?, path = ?, body_json = ?, base_version = ?, idempotency_key = ?,
          dependency_ids_json = ?, state = 'pending', next_attempt_at = ?, updated_at = ?, last_error_code = null
         where operation_id = ?`,
        [
          input.method.toUpperCase(),
          input.path,
          input.bodyJson ?? null,
          input.baseVersion ?? null,
          input.idempotencyKey,
          JSON.stringify(input.dependencyIds ?? []),
          nowIso,
          nowIso,
          existingForResource.operation_id,
        ],
      );
      // Drop any older duplicate open rows for this resource (keeps one op per resource).
      await db.runAsync(
        `update outbox_ops set state = 'done', updated_at = ?, last_error_code = ?
         where resource_id = ? and operation_id != ? and state in ('pending', 'failed')`,
        [nowIso, "SUPERSEDED", input.resourceId, existingForResource.operation_id],
      );
      const row = await db.getFirstAsync<Record<string, unknown>>(
        "select * from outbox_ops where operation_id = ?",
        [existingForResource.operation_id],
      );
      if (!row) {
        throw new StorageError("DATABASE_UNAVAILABLE");
      }
      return mapRow(row);
    }

    await db.runAsync(
      `insert into outbox_ops (
        operation_id, resource_kind, resource_id, method, path, body_json, base_version,
        idempotency_key, dependency_ids_json, state, attempts, next_attempt_at, last_error_code, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, null, ?, ?)
      on conflict(operation_id) do update set
        body_json = excluded.body_json,
        base_version = excluded.base_version,
        idempotency_key = excluded.idempotency_key,
        dependency_ids_json = excluded.dependency_ids_json,
        state = 'pending',
        next_attempt_at = excluded.next_attempt_at,
        updated_at = excluded.updated_at,
        last_error_code = null`,
      [
        input.operationId,
        input.resourceKind,
        input.resourceId,
        input.method.toUpperCase(),
        input.path,
        input.bodyJson ?? null,
        input.baseVersion ?? null,
        input.idempotencyKey,
        JSON.stringify(input.dependencyIds ?? []),
        nowIso,
        nowIso,
        nowIso,
      ],
    );
    const row = await db.getFirstAsync<Record<string, unknown>>(
      "select * from outbox_ops where operation_id = ?",
      [input.operationId],
    );
    if (!row) {
      throw new StorageError("DATABASE_UNAVAILABLE");
    }
    return mapRow(row);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

/**
 * Prepare the outbox for a drain pass.
 *
 * - Manual / user-requested (`forceImmediate`): reclaim every `in_flight` row and
 *   set `next_attempt_at = now` on pending rows. Manual sync must not stay blocked
 *   by SYNC05 backoff; idempotency keys and operation_ids are preserved.
 * - Automatic: reclaim only stale `in_flight` rows older than the lease so a hung
 *   fetch cannot permanently block reconnect drain; still respect `next_attempt_at`.
 * - Always coalesce duplicate open ops per resource (keep newest pending/failed).
 */
export async function prepareOutboxForDrain(
  db: EncryptedSqliteHandle,
  options: { nowIso: string; forceImmediate: boolean; nowMs: number },
): Promise<{ reclaimedInFlight: number; forcedPending: number; superseded: number }> {
  try {
    const superseded = await coalesceOpenOutboxOperations(db, options.nowIso);
    let reclaimedInFlight = 0;
    let forcedPending = 0;
    if (options.forceImmediate) {
      const inFlight = await db.getAllAsync<Record<string, unknown>>(
        "select operation_id from outbox_ops where state = 'in_flight'",
      );
      for (const row of inFlight) {
        await db.runAsync(
          "update outbox_ops set state = 'pending', next_attempt_at = ?, updated_at = ? where operation_id = ? and state = 'in_flight'",
          [options.nowIso, options.nowIso, String(row.operation_id)],
        );
        reclaimedInFlight += 1;
      }
      const pending = await db.getAllAsync<Record<string, unknown>>(
        "select operation_id from outbox_ops where state = 'pending' and next_attempt_at > ?",
        [options.nowIso],
      );
      for (const row of pending) {
        await db.runAsync(
          "update outbox_ops set next_attempt_at = ?, updated_at = ? where operation_id = ? and state = 'pending'",
          [options.nowIso, options.nowIso, String(row.operation_id)],
        );
        forcedPending += 1;
      }
      return { reclaimedInFlight, forcedPending, superseded };
    }

    const staleBefore = new Date(options.nowMs - OUTBOX_IN_FLIGHT_LEASE_MS).toISOString();
    const stale = await db.getAllAsync<Record<string, unknown>>(
      "select operation_id from outbox_ops where state = 'in_flight' and updated_at <= ?",
      [staleBefore],
    );
    for (const row of stale) {
      await db.runAsync(
        "update outbox_ops set state = 'pending', next_attempt_at = ?, updated_at = ? where operation_id = ? and state = 'in_flight'",
        [options.nowIso, options.nowIso, String(row.operation_id)],
      );
      reclaimedInFlight += 1;
    }
    return { reclaimedInFlight, forcedPending, superseded };
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

/**
 * One open operation per resource: keep the newest pending/failed row, mark older as done/SUPERSEDED.
 * Does not touch in_flight or paused_conflict (those must finish or resolve explicitly).
 */
export async function coalesceOpenOutboxOperations(
  db: EncryptedSqliteHandle,
  nowIso: string,
): Promise<number> {
  try {
    const resources = await db.getAllAsync<{ resource_id: string; n: number }>(
      `select resource_id, count(*) as n from outbox_ops
       where state in ('pending', 'failed')
       group by resource_id
       having count(*) > 1`,
    );
    let superseded = 0;
    for (const group of resources) {
      const rows = await db.getAllAsync<Record<string, unknown>>(
        `select operation_id from outbox_ops
         where resource_id = ? and state in ('pending', 'failed')
         order by updated_at desc, created_at desc`,
        [String(group.resource_id)],
      );
      const [, ...older] = rows;
      for (const row of older) {
        await db.runAsync(
          "update outbox_ops set state = 'done', updated_at = ?, last_error_code = ? where operation_id = ?",
          [nowIso, "SUPERSEDED", String(row.operation_id)],
        );
        superseded += 1;
      }
    }
    return superseded;
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function listRunnableOutboxOperations(
  db: EncryptedSqliteHandle,
  nowIso: string,
): Promise<OutboxOperation[]> {
  try {
    const inFlight = await db.getFirstAsync<{ n: number }>(
      "select count(*) as n from outbox_ops where state = 'in_flight'",
    );
    const slots = OUTBOX_MAX_IN_FLIGHT - (inFlight?.n ?? 0);
    if (slots <= 0) {
      return [];
    }
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `select * from outbox_ops
       where state = 'pending' and next_attempt_at <= ?
       order by created_at asc
       limit ?`,
      [nowIso, slots],
    );
    const ops = rows.map(mapRow);
    const runnable: OutboxOperation[] = [];
    const claimedResources = new Set<string>();
    for (const op of ops) {
      if (claimedResources.has(op.resourceId)) {
        continue;
      }
      const busy = await db.getFirstAsync<{ n: number }>(
        "select count(*) as n from outbox_ops where resource_id = ? and state in ('in_flight', 'paused_conflict')",
        [op.resourceId],
      );
      if ((busy?.n ?? 0) > 0) {
        continue;
      }
      const depsDone = await dependenciesSatisfied(db, op.dependencyIds);
      if (!depsDone) {
        continue;
      }
      claimedResources.add(op.resourceId);
      runnable.push(op);
    }
    return runnable;
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function countPendingOutboxBlockedByRetry(
  db: EncryptedSqliteHandle,
  nowIso: string,
): Promise<number> {
  try {
    const row = await db.getFirstAsync<{ n: number }>(
      "select count(*) as n from outbox_ops where state = 'pending' and next_attempt_at > ?",
      [nowIso],
    );
    return row?.n ?? 0;
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

async function dependenciesSatisfied(db: EncryptedSqliteHandle, dependencyIds: string[]): Promise<boolean> {
  for (const dep of dependencyIds) {
    const row = await db.getFirstAsync<{ state: string }>(
      "select state from outbox_ops where operation_id = ?",
      [dep],
    );
    if (!row || row.state !== "done") {
      return false;
    }
  }
  return true;
}

export async function markOutboxInFlight(db: EncryptedSqliteHandle, operationId: string, nowIso: string): Promise<void> {
  try {
    await db.runAsync(
      "update outbox_ops set state = 'in_flight', updated_at = ? where operation_id = ? and state = 'pending'",
      [nowIso, operationId],
    );
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function markOutboxDone(db: EncryptedSqliteHandle, operationId: string, nowIso: string): Promise<void> {
  try {
    await db.runAsync(
      "update outbox_ops set state = 'done', updated_at = ?, last_error_code = null where operation_id = ?",
      [nowIso, operationId],
    );
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function markOutboxConflict(db: EncryptedSqliteHandle, operationId: string, nowIso: string): Promise<void> {
  try {
    await db.runAsync(
      "update outbox_ops set state = 'paused_conflict', updated_at = ?, last_error_code = ? where operation_id = ?",
      [nowIso, "VERSION_CONFLICT", operationId],
    );
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function markOutboxRetry(
  db: EncryptedSqliteHandle,
  operationId: string,
  attempts: number,
  errorCode: string,
  nowMs: number,
  random: RandomUnitFn = Math.random,
): Promise<void> {
  const next = nextAttemptAtIso(attempts, nowMs, random);
  try {
    await db.runAsync(
      "update outbox_ops set state = 'pending', attempts = ?, next_attempt_at = ?, last_error_code = ?, updated_at = ? where operation_id = ?",
      [attempts, next, errorCode, new Date(nowMs).toISOString(), operationId],
    );
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

/** Terminal client/server validation failure: keep row for recovery, do not schedule retries. */
export async function markOutboxFailed(
  db: EncryptedSqliteHandle,
  operationId: string,
  errorCode: string,
  nowIso: string,
): Promise<void> {
  try {
    await db.runAsync(
      "update outbox_ops set state = 'failed', last_error_code = ?, updated_at = ? where operation_id = ?",
      [errorCode, nowIso, operationId],
    );
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function resumeOutboxAfterConflict(
  db: EncryptedSqliteHandle,
  resourceId: string,
  nowIso: string,
): Promise<void> {
  try {
    await db.runAsync(
      "update outbox_ops set state = 'pending', next_attempt_at = ?, updated_at = ?, last_error_code = null where resource_id = ? and state = 'paused_conflict'",
      [nowIso, nowIso, resourceId],
    );
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}
