/**
 * Local SQLCipher schema for SYNC01 commercial persistence.
 * Never store access tokens, refresh tokens, OTPs, or encryption keys in SQLite.
 */

import type { EncryptedSqliteHandle } from "./encrypted-database.ts";
import { StorageError } from "./storage-error.ts";

export const LOCAL_SCHEMA_VERSION = 1;

export type OwnerWorkspaceBinding = {
  ownerId: string;
  workspaceId: string;
};

const MIGRATION_V1 = `
create table if not exists schema_meta (
  id integer primary key not null check (id = 1),
  version integer not null,
  owner_id text not null,
  workspace_id text not null,
  bound_at text not null
);

create table if not exists jobs_cache (
  job_id text primary key not null,
  payload_json text not null,
  list_state text not null,
  sync_badge text not null default 'synced',
  server_confirmed integer not null default 1 check (server_confirmed in (0, 1)),
  pinned integer not null default 0 check (pinned in (0, 1)),
  updated_at text not null,
  last_accessed_at text not null
);

create table if not exists local_drafts (
  draft_id text primary key not null,
  job_id text not null,
  kind text not null,
  base_version integer not null,
  server_version integer,
  schema_version integer not null,
  payload_json text not null,
  sync_state text not null,
  local_updated_at text not null,
  conflict_server_json text,
  conflict_local_json text
);

create index if not exists local_drafts_job_id_idx on local_drafts(job_id);

create table if not exists outbox_ops (
  operation_id text primary key not null,
  resource_kind text not null,
  resource_id text not null,
  method text not null,
  path text not null,
  body_json text,
  base_version integer,
  idempotency_key text not null,
  dependency_ids_json text not null default '[]',
  state text not null,
  attempts integer not null default 0,
  next_attempt_at text not null,
  last_error_code text,
  created_at text not null,
  updated_at text not null
);

create index if not exists outbox_ops_state_next_idx on outbox_ops(state, next_attempt_at);
create index if not exists outbox_ops_resource_idx on outbox_ops(resource_id, state);

create table if not exists sync_meta (
  key text primary key not null,
  value text not null
);
`;

export async function readSchemaMeta(
  db: EncryptedSqliteHandle,
): Promise<{ version: number; ownerId: string; workspaceId: string } | null> {
  try {
    const row = await db.getFirstAsync<{ version: number; owner_id: string; workspace_id: string }>(
      "select version, owner_id, workspace_id from schema_meta where id = 1",
    );
    if (!row) {
      return null;
    }
    return { version: row.version, ownerId: row.owner_id, workspaceId: row.workspace_id };
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function migrateOwnerDatabase(
  db: EncryptedSqliteHandle,
  binding: OwnerWorkspaceBinding,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  try {
    await db.execAsync(MIGRATION_V1);
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }

  const existing = await readSchemaMeta(db);
  if (!existing) {
    try {
      await db.runAsync(
        "insert into schema_meta (id, version, owner_id, workspace_id, bound_at) values (1, ?, ?, ?, ?)",
        [LOCAL_SCHEMA_VERSION, binding.ownerId, binding.workspaceId, nowIso],
      );
    } catch {
      throw new StorageError("DATABASE_UNAVAILABLE");
    }
    return;
  }

  if (existing.ownerId !== binding.ownerId || existing.workspaceId !== binding.workspaceId) {
    throw new StorageError("OWNER_MISMATCH");
  }

  if (existing.version > LOCAL_SCHEMA_VERSION) {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }

  if (existing.version < LOCAL_SCHEMA_VERSION) {
    try {
      await db.runAsync("update schema_meta set version = ? where id = 1", [LOCAL_SCHEMA_VERSION]);
    } catch {
      throw new StorageError("DATABASE_UNAVAILABLE");
    }
  }
}
