import type { DraftSyncStatus } from "@job-to-invoice/schemas";

export type SignOutChoice = "stay" | "confirm" | "discard" | "synchronize";

export type SignOutAlertSpec =
  | { kind: "confirm"; offerSynchronize: false }
  | { kind: "unsynced"; offerSynchronize: boolean };

export function signOutAlertSpec(
  status: DraftSyncStatus,
  syncImplemented: boolean,
): SignOutAlertSpec {
  if (!status.hasUnsyncedDrafts) {
    return { kind: "confirm", offerSynchronize: false };
  }
  return {
    kind: "unsynced",
    offerSynchronize: syncImplemented && status.synchronizeAvailable,
  };
}

export function signOutChoiceProceeds(
  choice: SignOutChoice,
): choice is "confirm" | "discard" | "synchronize" {
  return choice !== "stay";
}

export type SignOutStage = "discard" | "sign_out" | "synchronize";

export async function completeOwnerSignOut(options: {
  mode: "confirm" | "discard" | "synchronize";
  discardDrafts: () => Promise<void>;
  synchronizeDrafts?: () => Promise<{ ok: true } | { ok: false }>;
  providerSignOut: () => Promise<void>;
  clearStoredAuth: () => Promise<void>;
  clearMemory: () => void;
}): Promise<{ ok: true } | { ok: false; stage: SignOutStage }> {
  if (options.mode === "synchronize") {
    if (!options.synchronizeDrafts) {
      return { ok: false, stage: "synchronize" };
    }
    try {
      const synced = await options.synchronizeDrafts();
      if (!synced.ok) {
        return { ok: false, stage: "synchronize" };
      }
    } catch {
      return { ok: false, stage: "synchronize" };
    }
  }
  if (options.mode === "discard") {
    try {
      await options.discardDrafts();
    } catch {
      return { ok: false, stage: "discard" };
    }
  }
  try {
    await options.providerSignOut();
    await options.clearStoredAuth();
  } catch {
    return { ok: false, stage: "sign_out" };
  }
  options.clearMemory();
  return { ok: true };
}
