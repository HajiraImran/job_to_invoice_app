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
  const nowIso = input.nowIso ?? new Date().toISOString();

  if (input.choice === "keep_server") {
    await clearDraftConflict(db, input.draftId, {
      payloadJson: input.serverPayloadJson,
      baseVersion: input.serverVersion,
      serverVersion: input.serverVersion,
      syncState: "synced",
      nowIso,
    });
    await resumeOutboxAfterConflict(db, input.draftId, nowIso);
    // Drop paused ops for this resource after keep-server (local mutations discarded).
    try {
      await db.runAsync(
        "delete from outbox_ops where resource_id = ? and state in ('paused_conflict', 'pending', 'failed')",
        [input.draftId],
      );
    } catch {
      throw new StorageError("DATABASE_UNAVAILABLE");
    }
    return "kept_server";
  }

  if (!input.localCopy) {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
  // Keep server on original draft id, then insert local copy as a new dirty draft.
  await clearDraftConflict(db, input.draftId, {
    payloadJson: input.serverPayloadJson,
    baseVersion: input.serverVersion,
    serverVersion: input.serverVersion,
    syncState: "synced",
    nowIso,
  });
  try {
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
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
  return "saved_local_copy";
}
