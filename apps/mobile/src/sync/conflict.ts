import type { EncryptedSqliteHandle } from "../storage/encrypted-database.ts";
import { clearDraftConflict, getLocalDraft, shelfDraftConflict } from "../drafts/repository.ts";
import { markOutboxConflict, resumeOutboxAfterConflict } from "./outbox.ts";
import { buildSyncConflictAnalytics, type SyncConflictAnalyticsProps } from "./analytics.ts";
import { StorageError } from "../storage/storage-error.ts";

export type ConflictChoice = "keep_server" | "save_local_copy";

export async function pauseResourceForConflict(
  db: EncryptedSqliteHandle,
  input: {
    draftId: string;
    operationId: string;
    localJson: string;
    serverJson: string;
    nowIso?: string;
  },
): Promise<SyncConflictAnalyticsProps> {
  await shelfDraftConflict(db, {
    draftId: input.draftId,
    localJson: input.localJson,
    serverJson: input.serverJson,
    nowIso: input.nowIso,
  });
  await markOutboxConflict(db, input.operationId, input.nowIso ?? new Date().toISOString());
  const draft = await getLocalDraft(db, input.draftId);
  return buildSyncConflictAnalytics({
    resourceKind: "draft",
    clientVersion: String(draft?.baseVersion ?? 0),
  });
}

export async function resolveDraftConflict(
  db: EncryptedSqliteHandle,
  input: {
    draftId: string;
    choice: ConflictChoice;
    /** When saving local as a new copy, caller supplies the new draft identity + payload. */
    localCopy?: {
      draftId: string;
      jobId: string;
      kind: string;
      schemaVersion: number;
      payloadJson: string;
      baseVersion: number;
    };
    serverPayloadJson: string;
    serverVersion: number;
    nowIso?: string;
  },
): Promise<"kept_server" | "saved_local_copy"> {
  const existing = await getLocalDraft(db, input.draftId);
  if (!existing || existing.syncState !== "conflict") {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
  if (isVersionConflictStub(input.serverPayloadJson)) {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
  const nowIso = input.nowIso ?? new Date().toISOString();
  try {
    await db.execAsync("begin immediate");
    if (input.choice === "keep_server") {
      await clearDraftConflict(db, input.draftId, {
        payloadJson: input.serverPayloadJson,
        baseVersion: input.serverVersion,
        serverVersion: input.serverVersion,
        syncState: "synced",
        nowIso,
      });
      await resumeOutboxAfterConflict(db, input.draftId, nowIso);
      await db.runAsync(
        "delete from outbox_ops where resource_id = ? and state in ('paused_conflict', 'pending', 'failed')",
        [input.draftId],
      );
      await db.execAsync("commit");
      return "kept_server";
    }
    if (!input.localCopy) {
      throw new StorageError("DATABASE_UNAVAILABLE");
    }
    await clearDraftConflict(db, input.draftId, {
      payloadJson: input.serverPayloadJson,
      baseVersion: input.serverVersion,
      serverVersion: input.serverVersion,
      syncState: "synced",
      nowIso,
    });
    await db.runAsync(
      "delete from outbox_ops where resource_id = ? and state in ('paused_conflict', 'pending', 'failed')",
      [input.draftId],
    );
    await db.runAsync(
      `insert into local_drafts (
        draft_id, job_id, kind, base_version, server_version, schema_version,
        payload_json, sync_state, local_updated_at, conflict_server_json, conflict_local_json
      ) values (?, ?, ?, ?, ?, ?, ?, 'dirty', ?, null, null)`,
      [
        input.localCopy.draftId,
        input.localCopy.jobId,
        input.localCopy.kind,
        input.localCopy.baseVersion,
        null,
        input.localCopy.schemaVersion,
        input.localCopy.payloadJson,
        nowIso,
      ],
    );
    await db.execAsync("commit");
    return "saved_local_copy";
  } catch (error) {
    try {
      await db.execAsync("rollback");
    } catch {
      /* The in-memory test handle ignores transaction statements. */
    }
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export function readFullServerDraft(payload: unknown): { payloadJson: string; version: number } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const row = payload as Record<string, unknown>;
  if (row.code === "VERSION_CONFLICT") {
    return null;
  }
  if (typeof row.id !== "string" || typeof row.job_id !== "string" || typeof row.version !== "number") {
    return null;
  }
  if (typeof row.kind !== "string") {
    return null;
  }
  return { payloadJson: JSON.stringify(payload), version: row.version };
}

export function shelvedServerVersion(conflictServerJson: string | null): number | null {
  if (!conflictServerJson) {
    return null;
  }
  try {
    return readFullServerDraft(JSON.parse(conflictServerJson))?.version ?? null;
  } catch {
    return null;
  }
}

export function recoverableLocalJson(row: { payloadJson: string; conflictLocalJson: string | null }): string | null {
  const shelved = row.conflictLocalJson;
  if (shelved && !isVersionConflictStub(shelved)) {
    return shelved;
  }
  if (!isVersionConflictStub(row.payloadJson)) {
    return row.payloadJson;
  }
  return null;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function isVersionConflictStub(value: string): boolean {
  const parsed = safeParse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const row = parsed as Record<string, unknown>;
  return row.code === "VERSION_CONFLICT" && Object.keys(row).length === 1;
}

export async function noteServerDraftChanged(
  db: EncryptedSqliteHandle,
  input: { draftId: string; serverPayloadJson: string; serverVersion: number; nowIso?: string },
): Promise<"ready" | "server_changed"> {
  const existing = await getLocalDraft(db, input.draftId);
  if (!existing || existing.syncState !== "conflict") {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
  const shelved = shelvedServerVersion(existing.conflictServerJson);
  if (shelved !== null && shelved !== input.serverVersion) {
    await shelfDraftConflict(db, {
      draftId: input.draftId,
      localJson: existing.conflictLocalJson ?? existing.payloadJson,
      serverJson: input.serverPayloadJson,
      nowIso: input.nowIso,
    });
    return "server_changed";
  }
  return "ready";
}

export async function saveRecoverableLocalCopy(
  db: EncryptedSqliteHandle,
  input: {
    sourceDraftId: string;
    copyDraftId: string;
    nowIso?: string;
  },
): Promise<{ draftId: string; created: boolean }> {
  const existing = await getLocalDraft(db, input.sourceDraftId);
  if (!existing || existing.syncState !== "conflict") {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
  const payloadJson = recoverableLocalJson(existing);
  if (!payloadJson) {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
  const nowIso = input.nowIso ?? new Date().toISOString();
  try {
    await db.execAsync("begin immediate");
    const copies = await db.getAllAsync<Record<string, unknown>>(
      "select draft_id, payload_json from local_drafts where job_id = ? and draft_id != ? and server_version is null and sync_state = 'dirty'",
      [existing.jobId, existing.draftId],
    );
    const prior = copies.find((row) => String(row.payload_json) === payloadJson);
    if (prior) {
      await db.execAsync("commit");
      return { draftId: String(prior.draft_id), created: false };
    }
    await db.runAsync(
      `insert into local_drafts (
        draft_id, job_id, kind, base_version, server_version, schema_version,
        payload_json, sync_state, local_updated_at, conflict_server_json, conflict_local_json
      ) values (?, ?, ?, ?, ?, ?, ?, 'dirty', ?, null, null)`,
      [
        input.copyDraftId,
        existing.jobId,
        existing.kind,
        1,
        null,
        existing.schemaVersion,
        payloadJson,
        nowIso,
      ],
    );
    await db.execAsync("commit");
  } catch (error) {
    try {
      await db.execAsync("rollback");
    } catch {
      /* The in-memory test handle ignores transaction statements. */
    }
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
  const original = await getLocalDraft(db, input.sourceDraftId);
  if (!original || original.syncState !== "conflict" || original.conflictLocalJson !== existing.conflictLocalJson) {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
  return { draftId: input.copyDraftId, created: true };
}
