import type { SecureKv } from "../session/storage.ts";
import type { EncryptedStorageCapability } from "./capability.ts";
import {
  deleteSqliteKey,
  loadOrCreateSqliteKey,
  ownerDatabaseFileName,
  sqlCipherKeyPragma,
  type RandomBytesFn,
} from "./database-key.ts";
import { StorageError } from "./storage-error.ts";

export type SqliteStatementResult = { changes: number; lastInsertRowId: number };

export type EncryptedSqliteHandle = {
  execAsync: (source: string) => Promise<void>;
  runAsync: (source: string, params?: unknown[]) => Promise<SqliteStatementResult>;
  getFirstAsync: <T>(source: string, params?: unknown[]) => Promise<T | null>;
  getAllAsync: <T>(source: string, params?: unknown[]) => Promise<T[]>;
  closeAsync: () => Promise<void>;
};

export type EncryptedSqliteBridge = {
  openDatabaseAsync: (databaseName: string) => Promise<EncryptedSqliteHandle>;
  deleteDatabaseAsync: (databaseName: string) => Promise<void>;
};

export type OwnerEncryptedDatabase = {
  /** Opaque handle — never log databasePath or owner identity. */
  readonly ownerId: string;
  close: () => Promise<void>;
  writeProbe: (value: string) => Promise<void>;
  readProbe: () => Promise<string | null>;
};

const PROBE_TABLE = `create table if not exists sync01_probe (
  id integer primary key not null check (id = 1),
  value text not null,
  updated_at text not null
)`;

const SAFETY_PRAGMAS = [
  "PRAGMA cipher_memory_security = ON;",
  "PRAGMA foreign_keys = ON;",
  "PRAGMA busy_timeout = 5000;",
  "PRAGMA secure_delete = ON;",
];

function requireSupportedCapability(capability: EncryptedStorageCapability): void {
  if (!capability.supported) {
    throw new StorageError("UNSUPPORTED_RUNTIME");
  }
}

async function applyKeyAndVerify(db: EncryptedSqliteHandle, keyMaterial: string): Promise<void> {
  try {
    await db.execAsync(sqlCipherKeyPragma(keyMaterial));
    for (const pragma of SAFETY_PRAGMAS) {
      await db.execAsync(pragma);
    }
    // Forces SQLCipher to decrypt the header; wrong key fails here.
    await db.getFirstAsync<{ n: number }>("select count(*) as n from sqlite_master");
  } catch (error) {
    try {
      await db.closeAsync();
    } catch {
      /* ignore close after failed key */
    }
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

async function ensureProbeSchema(db: EncryptedSqliteHandle): Promise<void> {
  try {
    await db.execAsync(PROBE_TABLE);
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }
}

/** Opens and unlocks the per-owner SQLCipher database. Caller owns migration/binding. */
export async function openEncryptedSqliteHandle(options: {
  ownerId: string;
  storage: SecureKv;
  bridge: EncryptedSqliteBridge;
  capability: EncryptedStorageCapability;
  randomBytes?: RandomBytesFn;
}): Promise<{ db: EncryptedSqliteHandle; fileName: string }> {
  requireSupportedCapability(options.capability);

  const fileName = ownerDatabaseFileName(options.ownerId);
  const { keyMaterial } = await loadOrCreateSqliteKey({
    ownerId: options.ownerId,
    storage: options.storage,
    randomBytes: options.randomBytes,
  });

  let db: EncryptedSqliteHandle;
  try {
    db = await options.bridge.openDatabaseAsync(fileName);
  } catch {
    throw new StorageError("DATABASE_UNAVAILABLE");
  }

  await applyKeyAndVerify(db, keyMaterial);
  return { db, fileName };
}

export async function openOwnerEncryptedDatabase(options: {
  ownerId: string;
  storage: SecureKv;
  bridge: EncryptedSqliteBridge;
  capability: EncryptedStorageCapability;
  randomBytes?: RandomBytesFn;
}): Promise<OwnerEncryptedDatabase> {
  const { db } = await openEncryptedSqliteHandle(options);
  await ensureProbeSchema(db);

  let closed = false;
  const handle: OwnerEncryptedDatabase = {
    ownerId: options.ownerId,
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
    writeProbe: async (value: string) => {
      if (closed) {
        throw new StorageError("DATABASE_UNAVAILABLE");
      }
      if (typeof value !== "string" || value.length === 0 || value.length > 200) {
        throw new StorageError("DATABASE_UNAVAILABLE");
      }
      try {
        await db.runAsync(
          "insert into sync01_probe (id, value, updated_at) values (1, ?, ?) on conflict(id) do update set value = excluded.value, updated_at = excluded.updated_at",
          [value, new Date().toISOString()],
        );
      } catch {
        throw new StorageError("DATABASE_UNAVAILABLE");
      }
    },
    readProbe: async () => {
      if (closed) {
        throw new StorageError("DATABASE_UNAVAILABLE");
      }
      try {
        const row = await db.getFirstAsync<{ value: string }>("select value from sync01_probe where id = 1");
        return row && typeof row.value === "string" ? row.value : null;
      } catch {
        throw new StorageError("DATABASE_UNAVAILABLE");
      }
    },
  };
  return handle;
}

export async function wipeOwnerEncryptedDatabase(options: {
  ownerId: string;
  storage: SecureKv;
  bridge: EncryptedSqliteBridge;
  capability: EncryptedStorageCapability;
  openDatabase?: OwnerEncryptedDatabase;
}): Promise<void> {
  requireSupportedCapability(options.capability);

  const fileName = ownerDatabaseFileName(options.ownerId);
  let databaseRemoved = false;
  let keyRemoved = false;

  if (options.openDatabase) {
    try {
      await options.openDatabase.close();
    } catch {
      /* continue wipe; close failure alone is not success */
    }
  }

  try {
    await options.bridge.deleteDatabaseAsync(fileName);
    databaseRemoved = true;
  } catch {
    /* leave databaseRemoved false */
  }

  try {
    await deleteSqliteKey({ ownerId: options.ownerId, storage: options.storage });
    keyRemoved = true;
  } catch {
    /* leave keyRemoved false */
  }

  if (!databaseRemoved || !keyRemoved) {
    throw new StorageError("WIPE_FAILED");
  }
}
