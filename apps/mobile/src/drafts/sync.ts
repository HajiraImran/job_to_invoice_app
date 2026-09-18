import { EMPTY_DRAFT_SYNC, type DraftSyncStatus } from "@job-to-invoice/schemas";

/**
 * Encrypted per-owner local drafts (SYNC01) are not implemented.
 * This adapter stays explicitly empty: no fabricated records, no Synchronize success.
 */
export const LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED = false;

export async function getDraftSyncStatus(): Promise<DraftSyncStatus> {
  return EMPTY_DRAFT_SYNC;
}

export async function discardLocalDrafts(): Promise<void> {
  return undefined;
}
