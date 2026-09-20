import type { SecureKv } from "../session/storage.ts";
import type { EncryptedStorageCapability } from "./capability.ts";
import type { RandomBytesFn } from "./database-key.ts";
import {
  openEncryptedSqliteHandle,
  wipeOwnerEncryptedDatabase,
  type EncryptedSqliteBridge,
  type EncryptedSqliteHandle,
  type OwnerEncryptedDatabase,
} from "./encrypted-database.ts";
import { migrateOwnerDatabase, type OwnerWorkspaceBinding } from "./schema.ts";
import { StorageError } from "./storage-error.ts";

export type OwnerSqliteSession = {
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly db: EncryptedSqliteHandle;
  close: () => Promise<void>;
};

export async function openOwnerSqliteSession(options: {
  ownerId: string;
  workspaceId: string;
  storage: SecureKv;
  bridge: EncryptedSqliteBridge;
  capability: EncryptedStorageCapability;
  randomBytes?: RandomBytesFn;
  nowIso?: string;
}): Promise<OwnerSqliteSession> {
  if (typeof options.workspaceId !== "string" || options.workspaceId.length === 0) {
    throw new StorageError("INVALID_OWNER");
  }
  const binding: OwnerWorkspaceBinding = {
    ownerId: options.ownerId,
    workspaceId: options.workspaceId,
  };
  const { db } = await openEncryptedSqliteHandle(options);
  try {
    await migrateOwnerDatabase(db, binding, options.nowIso);
  } catch (error) {
    try {
      await db.closeAsync();
    } catch {
      /* ignore */
    }
    throw error;
  }

  let closed = false;
  return {
    ownerId: options.ownerId,
    workspaceId: options.workspaceId,
    db,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await db.closeAsync();
      } catch {
        throw new StorageError("DATABASE_UNAVAILABLE");
      }
    },
  };
}

export async function wipeOwnerSqliteSession(options: {
  ownerId: string;
  storage: SecureKv;
  bridge: EncryptedSqliteBridge;
  capability: EncryptedStorageCapability;
  openSession?: { close: () => Promise<void> };
}): Promise<void> {
  await wipeOwnerEncryptedDatabase({
    ownerId: options.ownerId,
    storage: options.storage,
    bridge: options.bridge,
    capability: options.capability,
    openDatabase: options.openSession as OwnerEncryptedDatabase | undefined,
  });
}
