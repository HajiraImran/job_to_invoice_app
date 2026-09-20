import { isClientUuid } from "@job-to-invoice/schemas";
import { getRandomBytes } from "expo-crypto";
import type { SecureKv } from "../session/storage.ts";
import { StorageError } from "./storage-error.ts";

/** 256-bit key material for SQLCipher (SYNC01). */
export const SQLITE_KEY_BYTE_LENGTH = 32;

const KEY_PREFIX = "jti.sqlite.key.";

export type RandomBytesFn = (byteCount: number) => Uint8Array;

export function normalizeOwnerId(ownerId: string): string {
  if (!isClientUuid(ownerId)) {
    throw new StorageError("INVALID_OWNER");
  }
  return ownerId.toLowerCase();
}

export function ownerDatabaseKeyName(ownerId: string): string {
  return `${KEY_PREFIX}${normalizeOwnerId(ownerId)}`;
}

/** Database filename uses a compact owner token; never log this value. */
export function ownerDatabaseFileName(ownerId: string): string {
  return `jti_${normalizeOwnerId(ownerId).replace(/-/g, "")}.sqlite`;
}

export function encodeSqliteKeyMaterial(bytes: Uint8Array): string {
  if (bytes.byteLength !== SQLITE_KEY_BYTE_LENGTH) {
    throw new StorageError("KEY_UNAVAILABLE");
  }
  let hex = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const byte = bytes.at(i);
    if (byte === undefined) {
      throw new StorageError("KEY_UNAVAILABLE");
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function generateSqliteKeyMaterial(randomBytes: RandomBytesFn = getRandomBytes): string {
  const bytes = randomBytes(SQLITE_KEY_BYTE_LENGTH);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== SQLITE_KEY_BYTE_LENGTH) {
    throw new StorageError("KEY_UNAVAILABLE");
  }
  return encodeSqliteKeyMaterial(bytes);
}

export async function loadOrCreateSqliteKey(options: {
  ownerId: string;
  storage: SecureKv;
  randomBytes?: RandomBytesFn;
}): Promise<{ keyMaterial: string; created: boolean }> {
  const name = ownerDatabaseKeyName(options.ownerId);
  let existing: string | null;
  try {
    existing = await options.storage.getItem(name);
  } catch {
    throw new StorageError("KEY_UNAVAILABLE");
  }
  if (typeof existing === "string" && /^[0-9a-f]{64}$/i.test(existing)) {
    return { keyMaterial: existing.toLowerCase(), created: false };
  }
  if (existing !== null && existing !== undefined && existing !== "") {
    throw new StorageError("KEY_UNAVAILABLE");
  }
  const keyMaterial = generateSqliteKeyMaterial(options.randomBytes);
  try {
    await options.storage.setItem(name, keyMaterial);
  } catch {
    throw new StorageError("KEY_UNAVAILABLE");
  }
  return { keyMaterial, created: true };
}

export async function deleteSqliteKey(options: {
  ownerId: string;
  storage: SecureKv;
}): Promise<void> {
  const name = ownerDatabaseKeyName(options.ownerId);
  try {
    await options.storage.removeItem(name);
  } catch {
    throw new StorageError("WIPE_FAILED");
  }
}

/** Builds a SQLCipher PRAGMA statement. Never log the result. */
export function sqlCipherKeyPragma(keyMaterial: string): string {
  if (!/^[0-9a-f]{64}$/i.test(keyMaterial)) {
    throw new StorageError("KEY_UNAVAILABLE");
  }
  return `PRAGMA key = "x'${keyMaterial.toLowerCase()}'";`;
}
