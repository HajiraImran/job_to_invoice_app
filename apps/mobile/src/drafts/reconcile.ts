import type { EncryptedSqliteHandle } from "../storage/encrypted-database.ts";
import { StorageError } from "../storage/storage-error.ts";
import { decideDraftHydration, type ServerDraftSnapshot } from "./hydrate.ts";
import {
  getLocalDraft,
  getLocalDraftByJob,
  shelfDraftConflict,
  upsertLocalDraft,
  type LocalDraftRecord,
} from "./repository.ts";
import { getOpenOutboxForResource, type OutboxOperation } from "../sync/outbox.ts";

export type DraftHydrationResult = {
  visible: LocalDraftRecord;
  saveStatus: "saved_on_device" | "synced" | "conflict";
  openOutbox: OutboxOperation | null;
  adoptedServer: boolean;
  enteredConflict: boolean;
};

function recordFromServer(server: ServerDraftSnapshot, jobId: string): Omit<
  Parameters<typeof upsertLocalDraft>[1],
  "localUpdatedAt"
> {
  return {
    draftId: server.id,
    jobId,
    kind: server.kind,
    baseVersion: server.version,
    serverVersion: server.version,
    schemaVersion: server.schema_version,
    payloadJson: server.payloadJson,
    syncState: "synced",
  };
}

/**
 * Apply server snapshot against encrypted local draft using SYNC01 hydration rules.
 * Never replaces an unacknowledged local payload with a server read.
 */
export async function reconcileServerDraftWithLocal(
  db: EncryptedSqliteHandle,
  input: {
    jobId: string;
    server: ServerDraftSnapshot | null;
    nowIso?: string;
  },
): Promise<DraftHydrationResult | null> {
  const local = await getLocalDraftByJob(db, input.jobId);
  const openOutbox = local ? await getOpenOutboxForResource(db, local.draftId) : null;
  const decision = decideDraftHydration({
    local,
    server: input.server,
    hasOpenOutboxOperation: openOutbox !== null,
  });
  const nowIso = input.nowIso ?? new Date().toISOString();

  if (decision.action === "adopt_server") {
    if (!input.server) {
      throw new StorageError("DATABASE_UNAVAILABLE");
    }
    const saved = await upsertLocalDraft(db, {
      ...recordFromServer(input.server, input.jobId),
      localUpdatedAt: nowIso,
    });
    return {
      visible: saved,
      saveStatus: "synced",
      openOutbox: null,
      adoptedServer: true,
      enteredConflict: false,
    };
  }

  if (decision.action === "enter_conflict") {
    if (!local || !input.server) {
      throw new StorageError("DATABASE_UNAVAILABLE");
    }
    await shelfDraftConflict(db, {
      draftId: local.draftId,
      localJson: decision.localPayloadJson,
      serverJson: decision.serverPayloadJson,
      nowIso,
    });
    if (openOutbox) {
      try {
        await db.runAsync(
          "update outbox_ops set state = 'paused_conflict', updated_at = ?, last_error_code = ? where operation_id = ?",
          [nowIso, "VERSION_CONFLICT", openOutbox.operationId],
        );
      } catch {
        throw new StorageError("DATABASE_UNAVAILABLE");
      }
    }
    const shelved = await getLocalDraft(db, local.draftId);
    if (!shelved) {
      throw new StorageError("DATABASE_UNAVAILABLE");
    }
    return {
      visible: shelved,
      saveStatus: "conflict",
      openOutbox: openOutbox ? { ...openOutbox, state: "paused_conflict" } : null,
      adoptedServer: false,
      enteredConflict: true,
    };
  }

  // keep_local
  if (!local) {
    return null;
  }
  return {
    visible: local,
    saveStatus: decision.saveStatus,
    openOutbox,
    adoptedServer: false,
    enteredConflict: false,
  };
}
