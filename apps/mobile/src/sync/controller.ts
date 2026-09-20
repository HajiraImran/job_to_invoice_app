import type { DraftSyncStatus } from "@job-to-invoice/schemas";
import type { SecureKv } from "../session/storage.ts";
import type { EncryptedStorageCapability } from "../storage/capability.ts";
import type { EncryptedSqliteBridge } from "../storage/encrypted-database.ts";
import { openOwnerSqliteSession, wipeOwnerSqliteSession, type OwnerSqliteSession } from "../storage/session.ts";
import { isStorageError, StorageError } from "../storage/storage-error.ts";
import { countUnsyncedWork } from "./outbox.ts";
import { drainOutbox, type OwnerRequestFn } from "../drafts/persist.ts";
import type { SyncConflictAnalyticsProps } from "./analytics.ts";
import { emitDrainDiagnostic } from "./drain-diagnostics.ts";

export type OwnerSyncController = {
  readonly ownerId: string | null;
  readonly workspaceId: string | null;
  ensureOpen: (ownerId: string, workspaceId: string) => Promise<OwnerSqliteSession>;
  getSession: () => OwnerSqliteSession | null;
  getStatus: () => Promise<DraftSyncStatus>;
  synchronize: (
    request: OwnerRequestFn,
    options?: { forceImmediate?: boolean },
  ) => Promise<{ ok: true } | { ok: false; reason: "conflict" | "failed" | "storage" }>;
  discardAndWipe: () => Promise<void>;
  close: () => Promise<void>;
  onConflict?: (props: SyncConflictAnalyticsProps) => void;
};

export function createOwnerSyncController(options: {
  storage: SecureKv;
  bridge: EncryptedSqliteBridge;
  capability: EncryptedStorageCapability;
  onConflict?: (props: SyncConflictAnalyticsProps) => void;
}): OwnerSyncController {
  let session: OwnerSqliteSession | null = null;
  let opening: Promise<OwnerSqliteSession> | null = null;
  let draining: Promise<{ ok: true } | { ok: false; reason: "conflict" | "failed" | "storage" }> | null =
    null;

  const controller: OwnerSyncController = {
    get ownerId() {
      return session?.ownerId ?? null;
    },
    get workspaceId() {
      return session?.workspaceId ?? null;
    },
    onConflict: options.onConflict,
    getSession: () => session,
    ensureOpen: async (ownerId, workspaceId) => {
      if (session && session.ownerId === ownerId && session.workspaceId === workspaceId) {
        return session;
      }
      if (session && (session.ownerId !== ownerId || session.workspaceId !== workspaceId)) {
        throw new StorageError("OWNER_MISMATCH");
      }
      if (opening) {
        return opening;
      }
      opening = (async () => {
        const next = await openOwnerSqliteSession({
          ownerId,
          workspaceId,
          storage: options.storage,
          bridge: options.bridge,
          capability: options.capability,
        });
        session = next;
        return next;
      })();
      try {
        return await opening;
      } finally {
        opening = null;
      }
    },
    getStatus: async () => {
      if (!options.capability.supported) {
        return { hasUnsyncedDrafts: false, synchronizeAvailable: false };
      }
      if (!session) {
        return { hasUnsyncedDrafts: false, synchronizeAvailable: false };
      }
      try {
        const count = await countUnsyncedWork(session.db);
        return {
          hasUnsyncedDrafts: count > 0,
          synchronizeAvailable: true,
        };
      } catch {
        return { hasUnsyncedDrafts: false, synchronizeAvailable: false };
      }
    },
    synchronize: async (request, syncOptions) => {
      if (!session) {
        emitDrainDiagnostic({ stage: "complete", outcome: "no_authenticated_session" });
        return { ok: false, reason: "storage" };
      }
      if (draining) {
        return draining;
      }
      const forceImmediate = syncOptions?.forceImmediate !== false;
      draining = (async () => {
        const open = session;
        if (!open) {
          emitDrainDiagnostic({ stage: "complete", outcome: "no_authenticated_session" });
          return { ok: false as const, reason: "storage" as const };
        }
        try {
          for (let i = 0; i < 50; i += 1) {
            const result = await drainOutbox(open.db, {
              request,
              onConflict: controller.onConflict,
              forceImmediate: forceImmediate && i === 0,
            });
            if (result.conflicts > 0 || result.outcome === "conflict") {
              return { ok: false as const, reason: "conflict" as const };
            }
            if (result.remaining === 0) {
              return { ok: true as const };
            }
            if (result.drained === 0) {
              // Empty executable set with remaining work: backoff, stuck, or request failed.
              // Do not report success merely because drain returned without throwing.
              return { ok: false as const, reason: "failed" as const };
            }
          }
          return { ok: false as const, reason: "failed" as const };
        } catch {
          return { ok: false as const, reason: "storage" as const };
        }
      })();
      try {
        return await draining;
      } finally {
        draining = null;
      }
    },
    discardAndWipe: async () => {
      const ownerId = session?.ownerId;
      if (!ownerId) {
        // Nothing bound — attempt is a no-op success for confirm paths without local DB.
        return;
      }
      try {
        await wipeOwnerSqliteSession({
          ownerId,
          storage: options.storage,
          bridge: options.bridge,
          capability: options.capability,
          openSession: session ?? undefined,
        });
      } catch (error) {
        if (isStorageError(error)) {
          throw error;
        }
        throw new StorageError("WIPE_FAILED");
      } finally {
        session = null;
      }
    },
    close: async () => {
      if (!session) {
        return;
      }
      try {
        await session.close();
      } finally {
        session = null;
      }
    },
  };
  return controller;
}
