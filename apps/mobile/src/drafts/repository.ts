import type { EncryptedSqliteHandle } from "../storage/encrypted-database.ts";
import { StorageError } from "../storage/storage-error.ts";

export type LocalDraftSyncState = "dirty" | "queued" | "synced" | "conflict" | "saving";

export type LocalDraftRecord = {
  draftId: string;
  jobId: string;
  kind: string;
  baseVersion: number;
  serverVersion: number | null;
  schemaVersion: number;
  payloadJson: string;
  syncState: LocalDraftSyncState;
  localUpdatedAt: string;
  conflictServerJson: string | null;
  conflictLocalJson: string | null;
};

function mapDraft(row: Record<string, unknown>): LocalDraftRecord {
  return {
    draftId: String(row.draft_id),
    jobId: String(row.job_id),
    kind: String(row.kind),
    baseVersion: Number(row.base_version),
    serverVersion: row.server_version === null || row.server_version === undefined ? null : Number(row.server_version),
    schemaVersion: Number(row.schema_version),
    payloadJson: String(row.payload_json),
    syncState: String(row.sync_state) as LocalDraftSyncState,
    localUpdatedAt: String(row.local_updated_at),
    conflictServerJson:
      row.conflict_server_json === null || row.conflict_server_json === undefined
        ? null
        : String(row.conflict_server_json),
    conflictLocalJson:
      row.conflict_local_json === null || row.conflict_local_json === undefined
        ? null
        : String(row.conflict_local_json),
  };
}

export async function upsertLocalDraft(
  db: EncryptedSqliteHandle,
  input: {
    draftId: string;
    jobId: string;
    kind: string;
    baseVersion: number;
    serverVersion?: number | null;
    schemaVersion: number;
    payloadJson: string;
    syncState: LocalDraftSyncState;
    localUpdatedAt?: string;
  },
): Promise<LocalDraftRecord> {
  const nowIso = input.localUpdatedAt ?? new Date().toISOString();
  try {
    await db.runAsync(
      `insert into local_drafts (
        draft_id, job_id, kind, base_version, server_version, schema_version,
        payload_json, sync_state, local_updated_at, conflict_server_json, conflict_local_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, null)
      on conflict(draft_id) do update set
        job_id = excluded.job_id,
        kind = excluded.kind,
        base_version = excluded.base_version,
        server_version = excluded.server_version,
        schema_version = excluded.schema_version,
        payload_json = excluded.payload_json,
        sync_state = excluded.sync_state,
        local_updated_at = excluded.local_updated_at,
        conflict_server_json = null,
        conflict_local_json = null`,
      [
        input.draftId,
        input.jobId,
        input.kind,
        input.baseVersion,
        input.serverVersion ?? null,
        input.schemaVersion,
        input.payloadJson,
        input.syncState,
        nowIso,
      ],
    );
    const row = await getLocalDraft(db, input.draftId);
    if (!row) {
      throw new StorageError("DATABASE_UNAVAILABLE");
    }
    return row;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function getLocalDraft(db: EncryptedSqliteHandle, draftId: string): Promise<LocalDraftRecord | null> {
  try {
    const row = await db.getFirstAsync<Record<string, unknown>>(
      "select * from local_drafts where draft_id = ?",
      [draftId],
    );
    return row ? mapDraft(row) : null;
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function getLocalDraftByJob(
  db: EncryptedSqliteHandle,
  jobId: string,
): Promise<LocalDraftRecord | null> {
  try {
    const row = await db.getFirstAsync<Record<string, unknown>>(
      `select * from local_drafts where job_id = ?
       order by case sync_state when 'conflict' then 0 else 1 end,
         case when server_version is null then 1 else 0 end,
         local_updated_at desc
       limit 1`,
      [jobId],
    );
    return row ? mapDraft(row) : null;
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function setLocalDraftSyncState(
  db: EncryptedSqliteHandle,
  draftId: string,
  syncState: LocalDraftSyncState,
  extras?: {
    baseVersion?: number;
    serverVersion?: number | null;
    payloadJson?: string;
    nowIso?: string;
  },
): Promise<void> {
  const nowIso = extras?.nowIso ?? new Date().toISOString();
  try {
    await db.runAsync(
      `update local_drafts set
        sync_state = ?,
        base_version = coalesce(?, base_version),
        server_version = coalesce(?, server_version),
        payload_json = coalesce(?, payload_json),
        local_updated_at = ?
       where draft_id = ?`,
      [
        syncState,
        extras?.baseVersion ?? null,
        extras?.serverVersion === undefined ? null : extras.serverVersion,
        extras?.payloadJson ?? null,
        nowIso,
        draftId,
      ],
    );
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function shelfDraftConflict(
  db: EncryptedSqliteHandle,
  input: {
    draftId: string;
    localJson: string;
    serverJson: string;
    nowIso?: string;
  },
): Promise<void> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  try {
    await db.runAsync(
      `update local_drafts set
        sync_state = 'conflict',
        conflict_local_json = ?,
        conflict_server_json = ?,
        local_updated_at = ?
       where draft_id = ?`,
      [input.localJson, input.serverJson, nowIso, input.draftId],
    );
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function clearDraftConflict(
  db: EncryptedSqliteHandle,
  draftId: string,
  next: {
    payloadJson: string;
    baseVersion: number;
    serverVersion: number;
    syncState: LocalDraftSyncState;
    nowIso?: string;
  },
): Promise<void> {
  const nowIso = next.nowIso ?? new Date().toISOString();
  try {
    await db.runAsync(
      `update local_drafts set
        payload_json = ?,
        base_version = ?,
        server_version = ?,
        sync_state = ?,
        conflict_local_json = null,
        conflict_server_json = null,
        local_updated_at = ?
       where draft_id = ?`,
      [next.payloadJson, next.baseVersion, next.serverVersion, next.syncState, nowIso, draftId],
    );
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}
