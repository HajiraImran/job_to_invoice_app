import { describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({
  getRandomBytes: (byteCount: number) => new Uint8Array(byteCount).fill(5),
}));

import type { SecureKv } from "../session/storage.ts";
import { classifyEncryptedStorageCapability } from "./capability.ts";
import {
  SQLITE_KEY_BYTE_LENGTH,
  encodeSqliteKeyMaterial,
  generateSqliteKeyMaterial,
  loadOrCreateSqliteKey,
  ownerDatabaseFileName,
  ownerDatabaseKeyName,
  sqlCipherKeyPragma,
  deleteSqliteKey,
} from "./database-key.ts";
import { StorageError } from "./storage-error.ts";

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

describe("encrypted storage capability", () => {
  it("rejects Expo Go and web", () => {
    expect(
      classifyEncryptedStorageCapability({
        platform: "ios",
        appOwnership: "expo",
        executionEnvironment: "storeClient",
      }),
    ).toEqual({ supported: false, code: "UNSUPPORTED_RUNTIME" });
    expect(
      classifyEncryptedStorageCapability({
        platform: "web",
        appOwnership: null,
        executionEnvironment: "bare",
      }),
    ).toEqual({ supported: false, code: "UNSUPPORTED_RUNTIME" });
  });

  it("accepts native development and standalone candidates", () => {
    expect(
      classifyEncryptedStorageCapability({
        platform: "ios",
        appOwnership: null,
        executionEnvironment: "storeClient",
      }),
    ).toEqual({ supported: true, kind: "sqlcipher_native" });
    expect(
      classifyEncryptedStorageCapability({
        platform: "android",
        appOwnership: null,
        executionEnvironment: "standalone",
      }),
    ).toEqual({ supported: true, kind: "sqlcipher_native" });
  });
});

describe("database key material", () => {
  it("generates 32 cryptographically supplied bytes as lowercase hex", () => {
    const bytes = new Uint8Array(SQLITE_KEY_BYTE_LENGTH);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = i;
    }
    const randomBytes = vi.fn(() => bytes);
    const material = generateSqliteKeyMaterial(randomBytes);
    expect(randomBytes).toHaveBeenCalledWith(32);
    expect(material).toHaveLength(64);
    expect(material).toBe(encodeSqliteKeyMaterial(bytes));
    expect(material).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects Math.random-sized or short buffers", () => {
    expect(() => generateSqliteKeyMaterial(() => new Uint8Array(16))).toThrow(StorageError);
    expect(() => encodeSqliteKeyMaterial(new Uint8Array(8))).toThrow(StorageError);
  });

  it("namespaces SecureStore keys per owner and isolates owners", () => {
    expect(ownerDatabaseKeyName(OWNER_A)).toBe(`jti.sqlite.key.${OWNER_A}`);
    expect(ownerDatabaseKeyName(OWNER_B)).toBe(`jti.sqlite.key.${OWNER_B}`);
    expect(ownerDatabaseKeyName(OWNER_A)).not.toBe(ownerDatabaseKeyName(OWNER_B));
    expect(ownerDatabaseFileName(OWNER_A)).toBe("jti_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa.sqlite");
    expect(ownerDatabaseFileName(OWNER_A)).not.toBe(ownerDatabaseFileName(OWNER_B));
  });

  it("rejects invalid owner IDs without echoing them", () => {
    for (const bad of ["not-a-uuid", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaZ"]) {
      try {
        ownerDatabaseKeyName(bad);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe("INVALID_OWNER");
        expect(JSON.stringify(error)).not.toContain(bad);
      }
    }
    expect(() => ownerDatabaseKeyName("")).toThrow(StorageError);
  });

  it("normalizes owner UUID case for key and file names", () => {
    expect(ownerDatabaseKeyName(OWNER_A.toUpperCase())).toBe(ownerDatabaseKeyName(OWNER_A));
    expect(ownerDatabaseFileName(OWNER_A.toUpperCase())).toBe(ownerDatabaseFileName(OWNER_A));
  });

  it("loads an existing key or creates one once", async () => {
    const kv = memoryKv();
    const bytes = new Uint8Array(32).fill(7);
    const first = await loadOrCreateSqliteKey({
      ownerId: OWNER_A,
      storage: kv,
      randomBytes: () => bytes,
    });
    expect(first.created).toBe(true);
    expect(first.keyMaterial).toHaveLength(64);
    const second = await loadOrCreateSqliteKey({
      ownerId: OWNER_A,
      storage: kv,
      randomBytes: () => {
        throw new Error("should not regenerate");
      },
    });
    expect(second.created).toBe(false);
    expect(second.keyMaterial).toBe(first.keyMaterial);
    expect(await kv.getItem(ownerDatabaseKeyName(OWNER_A))).toBe(first.keyMaterial);
  });

  it("isolates keys across owners", async () => {
    const kv = memoryKv();
    const a = await loadOrCreateSqliteKey({
      ownerId: OWNER_A,
      storage: kv,
      randomBytes: () => new Uint8Array(32).fill(1),
    });
    const b = await loadOrCreateSqliteKey({
      ownerId: OWNER_B,
      storage: kv,
      randomBytes: () => new Uint8Array(32).fill(2),
    });
    expect(a.keyMaterial).not.toBe(b.keyMaterial);
  });

  it("builds a SQLCipher pragma without exposing material in thrown errors", () => {
    const material = "ab".repeat(32);
    const pragma = sqlCipherKeyPragma(material);
    expect(pragma.startsWith("PRAGMA key = \"x'")).toBe(true);
    expect(pragma).toContain(material);
    try {
      sqlCipherKeyPragma("not-hex");
      expect.unreachable();
    } catch (error) {
      expect((error as StorageError).code).toBe("KEY_UNAVAILABLE");
      expect(JSON.stringify(error)).not.toContain("not-hex");
    }
  });

  it("deletes the SecureStore key", async () => {
    const kv = memoryKv({ [ownerDatabaseKeyName(OWNER_A)]: "ab".repeat(32) });
    await deleteSqliteKey({ ownerId: OWNER_A, storage: kv });
    expect(await kv.getItem(ownerDatabaseKeyName(OWNER_A))).toBeNull();
  });
});
