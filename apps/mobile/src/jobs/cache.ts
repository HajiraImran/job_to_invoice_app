import type { EncryptedSqliteHandle } from "../storage/encrypted-database.ts";
import { StorageError } from "../storage/storage-error.ts";

export type JobCacheBadge = "synced" | "pending" | "conflict";

export type CachedJobRow = {
  jobId: string;
  payloadJson: string;
  listState: string;
  syncBadge: JobCacheBadge;
  serverConfirmed: boolean;
  pinned: boolean;
  updatedAt: string;
  lastAccessedAt: string;
};

const MAX_CACHED_JOBS = 500;

function mapJob(row: Record<string, unknown>): CachedJobRow {
  return {
    jobId: String(row.job_id),
    payloadJson: String(row.payload_json),
    listState: String(row.list_state),
    syncBadge: String(row.sync_badge) as JobCacheBadge,
    serverConfirmed: Number(row.server_confirmed) === 1,
    pinned: Number(row.pinned) === 1,
    updatedAt: String(row.updated_at),
    lastAccessedAt: String(row.last_accessed_at),
  };
}

type CachedJobInput = {
  jobId: string;
  payloadJson: string;
  listState: string;
  syncBadge?: JobCacheBadge;
  serverConfirmed?: boolean;
  pinned?: boolean;
  nowIso?: string;
};

export async function upsertCachedJob(db: EncryptedSqliteHandle, input: CachedJobInput): Promise<void> {
  try {
    await writeCachedJob(db, input);
    await evictConfirmedJobsIfNeeded(db);
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

/** Writes a page of server-confirmed jobs with a single eviction pass. */
export async function upsertCachedJobs(db: EncryptedSqliteHandle, inputs: CachedJobInput[]): Promise<void> {
  if (inputs.length === 0) {
    return;
  }
  try {
    for (const input of inputs) {
      await writeCachedJob(db, input);
    }
    await evictConfirmedJobsIfNeeded(db);
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

async function writeCachedJob(db: EncryptedSqliteHandle, input: CachedJobInput): Promise<void> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  await db.runAsync(
    `insert into jobs_cache (
      job_id, payload_json, list_state, sync_badge, server_confirmed, pinned, updated_at, last_accessed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(job_id) do update set
      payload_json = excluded.payload_json,
      list_state = excluded.list_state,
      sync_badge = excluded.sync_badge,
      server_confirmed = excluded.server_confirmed,
      pinned = excluded.pinned,
      updated_at = excluded.updated_at,
      last_accessed_at = excluded.last_accessed_at`,
    [
      input.jobId,
      input.payloadJson,
      input.listState,
      input.syncBadge ?? "synced",
      input.serverConfirmed === false ? 0 : 1,
      input.pinned ? 1 : 0,
      nowIso,
      nowIso,
    ],
  );
}

export async function getCachedJob(db: EncryptedSqliteHandle, jobId: string): Promise<CachedJobRow | null> {
  try {
    const row = await db.getFirstAsync<Record<string, unknown>>("select * from jobs_cache where job_id = ?", [
      jobId,
    ]);
    return row ? mapJob(row) : null;
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function listCachedJobs(
  db: EncryptedSqliteHandle,
  input: { listState: string; search?: string },
): Promise<CachedJobRow[]> {
  try {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      "select * from jobs_cache where list_state = ? order by updated_at desc",
      [input.listState],
    );
    const mapped = rows.map(mapJob);
    const needle = input.search?.trim().toLowerCase();
    if (!needle) {
      return mapped;
    }
    return mapped.filter((row) => {
      try {
        const payload = JSON.parse(row.payloadJson) as { customer_name?: string; title?: string };
        const hay = `${payload.customer_name ?? ""} ${payload.title ?? ""}`.toLowerCase();
        return hay.includes(needle);
      } catch {
        return false;
      }
    });
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

export async function setJobCacheBadge(
  db: EncryptedSqliteHandle,
  jobId: string,
  syncBadge: JobCacheBadge,
): Promise<void> {
  try {
    await db.runAsync("update jobs_cache set sync_badge = ? where job_id = ?", [syncBadge, jobId]);
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

/** Evict only server-confirmed cache rows; never auto-evict unsynced work (SYNC06). */
export async function evictConfirmedJobsIfNeeded(db: EncryptedSqliteHandle): Promise<void> {
  try {
    const count = await db.getFirstAsync<{ n: number }>("select count(*) as n from jobs_cache");
    const total = count?.n ?? 0;
    if (total <= MAX_CACHED_JOBS) {
      return;
    }
    const overflow = total - MAX_CACHED_JOBS;
    await db.runAsync(
      `delete from jobs_cache where job_id in (
        select job_id from jobs_cache
        where server_confirmed = 1 and sync_badge = 'synced' and pinned = 0
        order by last_accessed_at asc
        limit ?
      )`,
      [overflow],
    );
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}
