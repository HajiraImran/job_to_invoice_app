import { EMPTY_DRAFT_SYNC, type DraftSyncStatus } from "@job-to-invoice/schemas";
import type { OwnerSyncController } from "../sync/controller.ts";

/**
 * Production encrypted draft-sync adapter (SYNC01).
 * Bound to an OwnerSyncController by AuthProvider when a native SQLCipher session is available.
 */
export const LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED = true;

let bound: OwnerSyncController | null = null;

export function bindDraftSyncController(controller: OwnerSyncController | null): void {
  bound = controller;
}

export function getBoundDraftSyncController(): OwnerSyncController | null {
  return bound;
}

export async function getDraftSyncStatus(): Promise<DraftSyncStatus> {
  if (!bound) {
    return EMPTY_DRAFT_SYNC;
  }
  return bound.getStatus();
}

export async function discardLocalDrafts(): Promise<void> {
  if (!bound) {
    return;
  }
  await bound.discardAndWipe();
}

export async function synchronizeLocalDrafts(
  request: Parameters<OwnerSyncController["synchronize"]>[0],
  options?: { forceImmediate?: boolean },
): Promise<{ ok: true } | { ok: false; reason: "conflict" | "failed" | "storage" }> {
  if (!bound) {
    return { ok: false, reason: "storage" };
  }
  return bound.synchronize(request, options);
}
