import { EMPTY_DRAFT_SYNC, type DraftSyncStatus } from "@job-to-invoice/schemas";

export async function getDraftSyncStatus(): Promise<DraftSyncStatus> {
  return EMPTY_DRAFT_SYNC;
}

export async function discardLocalDrafts(): Promise<void> {
  return undefined;
}
