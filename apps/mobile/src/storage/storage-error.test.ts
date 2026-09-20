import { describe, expect, it } from "vitest";
import { StorageError, STORAGE_ERROR_CODES } from "./storage-error.ts";

describe("storage errors", () => {
  it("exposes only safe codes and messages", () => {
    expect(STORAGE_ERROR_CODES).toEqual([
      "UNSUPPORTED_RUNTIME",
      "INVALID_OWNER",
      "KEY_UNAVAILABLE",
      "DATABASE_UNAVAILABLE",
      "OWNER_MISMATCH",
      "OFFLINE_WINDOW_EXPIRED",
      "SYNC_PAUSED",
      "WIPE_FAILED",
    ]);
    for (const code of STORAGE_ERROR_CODES) {
      const error = new StorageError(code);
      const json = JSON.stringify(error.toJSON());
      expect(json).not.toMatch(/pragma|sqlite|Bearer |eyJ|@|keyMaterial|ownerId|jti_/i);
      expect(error.message).not.toMatch(/pragma|path|token|email/i);
      expect(error.code).toBe(code);
    }
  });
});
