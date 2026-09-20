import { describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({
  getRandomBytes: (byteCount: number) => new Uint8Array(byteCount).fill(1),
}));

import type { SecureKv } from "../session/storage.ts";
import { ownerDatabaseFileName, ownerDatabaseKeyName } from "./database-key.ts";
import {
  openOwnerEncryptedDatabase,
  wipeOwnerEncryptedDatabase,
  type EncryptedSqliteBridge,
  type EncryptedSqliteHandle,
} from "./encrypted-database.ts";
import { StorageError } from "./storage-error.ts";

/**
 * These tests mock native SQLite orchestration only.
 * They do NOT verify SQLCipher encryption, Keychain, or EAS binary behavior.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAPABLE = { supported: true, kind: "sqlcipher_native" } as const;
const UNSUPPORTED = { supported: false, code: "UNSUPPORTED_RUNTIME" } as const;

function memoryKv(initial?: Record<string, string>): SecureKv & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial ?? {}));
  return {
    store,
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => {
      store.set(key, value);
    },
    removeItem: async (key) => {
      store.delete(key);
    },
  };
}

function mockDb(options?: {
  failAfterKey?: boolean;
  failProbeWrite?: boolean;
}): EncryptedSqliteHandle & { execLog: string[]; closed: boolean; probe: string | null } {
  const state = { probe: null as string | null, closed: false, execLog: [] as string[] };
  return {
    get execLog() {
      return state.execLog;
    },
    get closed() {
      return state.closed;
    },
    get probe() {
      return state.probe;
    },
    execAsync: async (source: string) => {
      state.execLog.push(source);
    },
    runAsync: async (source: string, params?: unknown[]) => {
      if (options?.failProbeWrite) {
        throw new Error("write failed");
      }
      if (source.includes("sync01_probe") && params) {
        state.probe = String(params[0]);
      }
      return { changes: 1, lastInsertRowId: 1 };
    },
    getFirstAsync: async <T,>(source: string) => {
      if (options?.failAfterKey && source.includes("sqlite_master")) {
        throw new Error("file is not a database");
      }
      if (source.includes("sqlite_master")) {
        return { n: 0 } as T;
      }
      if (source.includes("sync01_probe")) {
        return (state.probe ? { value: state.probe } : null) as T | null;
      }
      return null;
    },
    closeAsync: async () => {
      state.closed = true;
    },
  };
}

function mockBridge(db: EncryptedSqliteHandle): EncryptedSqliteBridge & {
  deleted: string[];
  opened: string[];
} {
  const deleted: string[] = [];
  const opened: string[] = [];
  return {
    deleted,
    opened,
    openDatabaseAsync: async (name: string) => {
      opened.push(name);
      return db;
    },
    deleteDatabaseAsync: async (name: string) => {
      deleted.push(name);
    },
  };
}

describe("encrypted database orchestration (mocked native)", () => {
  it("refuses unsupported runtimes before opening a database", async () => {
    const kv = memoryKv();
    const bridge = mockBridge(mockDb());
    await expect(
      openOwnerEncryptedDatabase({
        ownerId: OWNER,
        storage: kv,
        bridge,
        capability: UNSUPPORTED,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_RUNTIME" });
    expect(bridge.opened).toHaveLength(0);
  });

  it("opens with key pragma, safety pragmas, and probe schema", async () => {
    const kv = memoryKv();
    const db = mockDb();
    const bridge = mockBridge(db);
    const handle = await openOwnerEncryptedDatabase({
      ownerId: OWNER,
      storage: kv,
      bridge,
      capability: CAPABLE,
      randomBytes: () => new Uint8Array(32).fill(9),
    });
    expect(bridge.opened).toEqual([ownerDatabaseFileName(OWNER)]);
    expect(db.execLog.some((sql) => sql.startsWith("PRAGMA key = \"x'"))).toBe(true);
    expect(db.execLog.some((sql) => sql.includes("sync01_probe"))).toBe(true);
    expect(db.execLog.some((sql) => sql.includes("secure_delete"))).toBe(true);
    await handle.writeProbe("phase0-ok");
    await expect(handle.readProbe()).resolves.toBe("phase0-ok");
    await handle.close();
    expect(db.closed).toBe(true);
    const serialized = JSON.stringify({ opened: bridge.opened, keyName: ownerDatabaseKeyName(OWNER) });
    expect(serialized).not.toMatch(/090909|PRAGMA key|Bearer /);
  });

  it("maps a wrong-key native failure to DATABASE_UNAVAILABLE without leaking payloads", async () => {
    const kv = memoryKv({ [ownerDatabaseKeyName(OWNER)]: "ab".repeat(32) });
    const bridge = mockBridge(mockDb({ failAfterKey: true }));
    try {
      await openOwnerEncryptedDatabase({
        ownerId: OWNER,
        storage: kv,
        bridge,
        capability: CAPABLE,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe("DATABASE_UNAVAILABLE");
      expect(JSON.stringify(error)).not.toMatch(/file is not a database|ababab|pragma/i);
    }
  });

  it("wipes database file and SecureStore key and requires both to succeed", async () => {
    const kv = memoryKv({ [ownerDatabaseKeyName(OWNER)]: "cd".repeat(32) });
    const db = mockDb();
    const bridge = mockBridge(db);
    const open = await openOwnerEncryptedDatabase({
      ownerId: OWNER,
      storage: kv,
      bridge,
      capability: CAPABLE,
      randomBytes: () => new Uint8Array(32).fill(3),
    });
    await wipeOwnerEncryptedDatabase({
      ownerId: OWNER,
      storage: kv,
      bridge,
      openDatabase: open,
      capability: CAPABLE,
    });
    expect(bridge.deleted).toEqual([ownerDatabaseFileName(OWNER)]);
    expect(await kv.getItem(ownerDatabaseKeyName(OWNER))).toBeNull();
    expect(db.closed).toBe(true);
  });

  it("does not claim wipe success when database delete fails", async () => {
    const kv = memoryKv({ [ownerDatabaseKeyName(OWNER)]: "ee".repeat(32) });
    const bridge: EncryptedSqliteBridge = {
      openDatabaseAsync: async () => mockDb(),
      deleteDatabaseAsync: async () => {
        throw new Error("unlink failed");
      },
    };
    await expect(
      wipeOwnerEncryptedDatabase({
        ownerId: OWNER,
        storage: kv,
        bridge,
        capability: CAPABLE,
      }),
    ).rejects.toMatchObject({ code: "WIPE_FAILED" });
    expect(await kv.getItem(ownerDatabaseKeyName(OWNER))).toBeNull();
  });

  it("does not claim wipe success when key delete fails after database delete", async () => {
    const store = new Map<string, string>([[ownerDatabaseKeyName(OWNER), "ff".repeat(32)]]);
    const kv: SecureKv = {
      getItem: async (key) => store.get(key) ?? null,
      setItem: async (key, value) => {
        store.set(key, value);
      },
      removeItem: async () => {
        throw new Error("securestore failed");
      },
    };
    const deleted: string[] = [];
    const bridge: EncryptedSqliteBridge = {
      openDatabaseAsync: async () => mockDb(),
      deleteDatabaseAsync: async (name) => {
        deleted.push(name);
      },
    };
    await expect(
      wipeOwnerEncryptedDatabase({
        ownerId: OWNER,
        storage: kv,
        bridge,
        capability: CAPABLE,
      }),
    ).rejects.toMatchObject({ code: "WIPE_FAILED" });
    expect(deleted).toEqual([ownerDatabaseFileName(OWNER)]);
  });

  it("does not invent commercial tables in the phase-0 probe schema", async () => {
    const kv = memoryKv();
    const db = mockDb();
    const bridge = mockBridge(db);
    await openOwnerEncryptedDatabase({
      ownerId: OWNER,
      storage: kv,
      bridge,
      capability: CAPABLE,
      randomBytes: () => new Uint8Array(32).fill(4),
    });
    const sql = db.execLog.join("\n");
    expect(sql).not.toMatch(/jobs|quotes|customers|document_drafts|outbox|token|email/i);
    expect(sql).toMatch(/sync01_probe/);
  });
});
