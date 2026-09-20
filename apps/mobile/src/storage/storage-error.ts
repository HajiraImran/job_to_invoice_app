/**
 * Safe encrypted-storage error boundary for Phase 0 (SYNC01).
 * Never attach keys, owner IDs, paths, SQL, tokens, emails, or native payloads.
 */

export const STORAGE_ERROR_CODES = [
  "UNSUPPORTED_RUNTIME",
  "INVALID_OWNER",
  "KEY_UNAVAILABLE",
  "DATABASE_UNAVAILABLE",
  "OWNER_MISMATCH",
  "OFFLINE_WINDOW_EXPIRED",
  "SYNC_PAUSED",
  "WIPE_FAILED",
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

const MESSAGES: Record<StorageErrorCode, string> = {
  UNSUPPORTED_RUNTIME: "Encrypted local storage requires a native development build.",
  INVALID_OWNER: "Encrypted local storage is not available for this account.",
  KEY_UNAVAILABLE: "Encrypted local storage key is unavailable.",
  DATABASE_UNAVAILABLE: "Encrypted local storage is unavailable.",
  OWNER_MISMATCH: "Encrypted local storage belongs to a different account.",
  OFFLINE_WINDOW_EXPIRED: "Sign in again to use saved work on this device.",
  SYNC_PAUSED: "Synchronization is paused until you resolve a conflict.",
  WIPE_FAILED: "Could not securely erase encrypted local storage.",
};

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode) {
    super(MESSAGES[code]);
    this.name = "StorageError";
    this.code = code;
  }

  toJSON(): { name: string; code: StorageErrorCode; message: string } {
    return { name: this.name, code: this.code, message: this.message };
  }
}

export function isStorageError(error: unknown): error is StorageError {
  return error instanceof StorageError;
}

export function storageErrorCode(error: unknown): StorageErrorCode | undefined {
  return isStorageError(error) ? error.code : undefined;
}
