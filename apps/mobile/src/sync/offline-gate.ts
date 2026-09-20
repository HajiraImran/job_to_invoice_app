import { isOfflineReadPermitted } from "@job-to-invoice/schemas";
import { StorageError } from "../storage/storage-error.ts";

/** ACC02 seven-day offline gate for cached commercial reads/edits. */
export function requireOfflineCommercialAccess(lastAuthenticatedAt: string | undefined, nowMs: number): void {
  if (!isOfflineReadPermitted(lastAuthenticatedAt, nowMs)) {
    throw new StorageError("OFFLINE_WINDOW_EXPIRED");
  }
}

export function canUseCachedCommercialData(
  authStatus: string,
  lastAuthenticatedAt: string | undefined,
  nowMs: number,
): boolean {
  if (authStatus === "authenticated") {
    return true;
  }
  if (authStatus === "offline_cached") {
    return isOfflineReadPermitted(lastAuthenticatedAt, nowMs);
  }
  return false;
}
