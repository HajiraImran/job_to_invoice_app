import { copy } from "../i18n/en.ts";

export type ConflictSurface = "editor" | "conflict" | "offline_conflict" | "access_expired";

export function presentConflictRecovery(input: {
  authStatus: string;
  saveStatus: string;
  errorCode?: string;
  hasDraft: boolean;
  storageAvailable: boolean;
}): {
  surface: ConflictSurface;
  sentence: string;
  keepServerEnabled: boolean;
  saveLocalEnabled: boolean;
  showCommercialContent: boolean;
} {
  if (input.authStatus === "access_expired") {
    return {
      surface: "access_expired",
      sentence: copy.accessExpired,
      keepServerEnabled: false,
      saveLocalEnabled: false,
      showCommercialContent: false,
    };
  }
  const conflicted = input.saveStatus === "conflict" || input.errorCode === "VERSION_CONFLICT";
  if (!conflicted) {
    return {
      surface: "editor",
      sentence: "",
      keepServerEnabled: false,
      saveLocalEnabled: false,
      showCommercialContent: input.hasDraft,
    };
  }
  const offline = input.authStatus === "offline_cached";
  return {
    surface: offline ? "offline_conflict" : "conflict",
    sentence: copy.conflictBody,
    keepServerEnabled: !offline,
    saveLocalEnabled: input.storageAvailable,
    showCommercialContent: false,
  };
}

export function conflictHardwareBack(surface: ConflictSurface): "job" | "stay" {
  return surface === "access_expired" ? "stay" : "job";
}

export function conflictActionBlocked(busy: boolean): boolean {
  return busy;
}
