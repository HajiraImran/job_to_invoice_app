/**
 * Draft hydration rules (SYNC01): never let a later server read overwrite
 * unacknowledged local SQLCipher payloads.
 */

import type { LocalDraftRecord, LocalDraftSyncState } from "./repository.ts";

export type ServerDraftSnapshot = {
  id: string;
  job_id: string;
  kind: string;
  schema_version: number;
  version: number;
  /** Full server draft JSON for adoption / conflict shelf. */
  payloadJson: string;
};

export type DraftHydrationDecision =
  | { action: "adopt_server"; reason: "no_local" | "synced_server_newer" }
  | {
      action: "keep_local";
      reason: "unacknowledged" | "synced_server_not_newer";
      saveStatus: "saved_on_device" | "synced" | "conflict";
    }
  | {
      action: "enter_conflict";
      reason: "server_changed_while_local_pending";
      localPayloadJson: string;
      serverPayloadJson: string;
    };

const UNACKNOWLEDGED_SYNC_STATES: ReadonlySet<LocalDraftSyncState> = new Set([
  "dirty",
  "queued",
  "saving",
  "conflict",
]);

export function isUnacknowledgedDraftSyncState(syncState: LocalDraftSyncState): boolean {
  return UNACKNOWLEDGED_SYNC_STATES.has(syncState);
}

export function isLocalDraftUnacknowledged(
  local: LocalDraftRecord,
  hasOpenOutboxOperation: boolean,
): boolean {
  if (isUnacknowledgedDraftSyncState(local.syncState)) {
    return true;
  }
  return hasOpenOutboxOperation;
}

/**
 * Decide how a delayed/arriving server draft interacts with encrypted local state.
 * Callers must apply this before replacing UI or SQLCipher payload.
 */
export function decideDraftHydration(input: {
  local: LocalDraftRecord | null;
  server: ServerDraftSnapshot | null;
  hasOpenOutboxOperation: boolean;
}): DraftHydrationDecision {
  if (!input.server) {
    if (!input.local) {
      return { action: "keep_local", reason: "synced_server_not_newer", saveStatus: "synced" };
    }
    return {
      action: "keep_local",
      reason: isLocalDraftUnacknowledged(input.local, input.hasOpenOutboxOperation)
        ? "unacknowledged"
        : "synced_server_not_newer",
      saveStatus:
        input.local.syncState === "conflict"
          ? "conflict"
          : isLocalDraftUnacknowledged(input.local, input.hasOpenOutboxOperation)
            ? "saved_on_device"
            : "synced",
    };
  }

  if (!input.local) {
    return { action: "adopt_server", reason: "no_local" };
  }

  const unacked = isLocalDraftUnacknowledged(input.local, input.hasOpenOutboxOperation);
  if (unacked) {
    const localBase = input.local.baseVersion;
    if (input.server.version !== localBase) {
      return {
        action: "enter_conflict",
        reason: "server_changed_while_local_pending",
        localPayloadJson: input.local.payloadJson,
        serverPayloadJson: input.server.payloadJson,
      };
    }
    return { action: "keep_local", reason: "unacknowledged", saveStatus: "saved_on_device" };
  }

  const knownServer = input.local.serverVersion ?? input.local.baseVersion;
  if (input.server.version > knownServer) {
    return { action: "adopt_server", reason: "synced_server_newer" };
  }
  return { action: "keep_local", reason: "synced_server_not_newer", saveStatus: "synced" };
}
