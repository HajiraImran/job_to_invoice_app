import { analyticsPropertiesAreSafe, routeGroupFor, type RouteGroup } from "@job-to-invoice/schemas";
import type { DraftSyncStatus } from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import { exportPath } from "../export/presentation.ts";
import { signOutAlertSpec, type SignOutChoice } from "../session/sign-out.ts";
import { subscriptionPath } from "../subscription/presentation.ts";
import { supportPath } from "../support/presentation.ts";

export const SETTINGS_GUTTER = 20;
export const SETTINGS_TARGET_MIN = 44;
export const SETTINGS_ACTION_PT = 54;

export type SettingsSyncPhase = "idle" | "synchronizing" | "failed" | "conflict";

export type SettingsSyncKind =
  | "hidden"
  | "synchronized"
  | "unsynchronized"
  | "unavailable"
  | "synchronizing"
  | "failed"
  | "conflict";

export type SettingsSheet = "none" | "confirm" | "unsynced" | "unavailable";

export function settingsDisplayEmail(input: {
  authStatus: string;
  bootstrapEmail?: string | null;
  fallbackEmail?: string | null;
}): string | null {
  if (input.authStatus !== "authenticated" && input.authStatus !== "offline_cached") {
    return null;
  }
  const primary = input.bootstrapEmail?.trim();
  if (primary) {
    return primary;
  }
  const fallback = input.fallbackEmail?.trim();
  return fallback || null;
}

export function settingsAccountInitial(email: string | null): string {
  const local = email?.split("@")[0]?.trim() ?? "";
  const char = [...local][0];
  return char ? char.toLocaleUpperCase() : "";
}

export function presentSettings(input: {
  authStatus: string;
  drafts: DraftSyncStatus;
  phase: SettingsSyncPhase;
  statusKnown: boolean;
}): {
  showAccount: boolean;
  showRows: boolean;
  showSignOut: boolean;
  syncKind: SettingsSyncKind;
  showSynchronize: boolean;
  offline: boolean;
  accessExpired: boolean;
} {
  if (input.authStatus === "access_expired") {
    return {
      showAccount: false,
      showRows: false,
      showSignOut: true,
      syncKind: "hidden",
      showSynchronize: false,
      offline: false,
      accessExpired: true,
    };
  }
  const offline = input.authStatus === "offline_cached";
  if (!input.statusKnown) {
    return {
      showAccount: true,
      showRows: true,
      showSignOut: true,
      syncKind: "hidden",
      showSynchronize: false,
      offline,
      accessExpired: false,
    };
  }
  if (input.phase === "synchronizing") {
    return {
      showAccount: true,
      showRows: true,
      showSignOut: true,
      syncKind: "synchronizing",
      showSynchronize: true,
      offline,
      accessExpired: false,
    };
  }
  if (input.phase === "conflict") {
    return {
      showAccount: true,
      showRows: true,
      showSignOut: true,
      syncKind: "conflict",
      showSynchronize: input.drafts.synchronizeAvailable,
      offline,
      accessExpired: false,
    };
  }
  if (input.phase === "failed") {
    return {
      showAccount: true,
      showRows: true,
      showSignOut: true,
      syncKind: "failed",
      showSynchronize: input.drafts.synchronizeAvailable,
      offline,
      accessExpired: false,
    };
  }
  if (!input.drafts.synchronizeAvailable) {
    return {
      showAccount: true,
      showRows: true,
      showSignOut: true,
      syncKind: input.drafts.hasUnsyncedDrafts ? "unsynchronized" : "unavailable",
      showSynchronize: false,
      offline,
      accessExpired: false,
    };
  }
  return {
    showAccount: true,
    showRows: true,
    showSignOut: true,
    syncKind: input.drafts.hasUnsyncedDrafts ? "unsynchronized" : "synchronized",
    showSynchronize: true,
    offline,
    accessExpired: false,
  };
}

export function settingsSyncLabel(kind: SettingsSyncKind): string | undefined {
  if (kind === "synchronized") return copy.jobSyncedBadge;
  if (kind === "unsynchronized") return copy.syncPendingCount;
  if (kind === "unavailable") return copy.settingsSyncUnavailable;
  if (kind === "synchronizing") return copy.settingsSynchronizing;
  if (kind === "failed") return copy.synchronizeFailed;
  if (kind === "conflict") return copy.synchronizeConflict;
  return undefined;
}

export function settingsSignOutSheet(drafts: DraftSyncStatus, syncImplemented: boolean): SettingsSheet {
  const spec = signOutAlertSpec(drafts, syncImplemented);
  if (spec.kind === "confirm") {
    return "confirm";
  }
  return spec.offerSynchronize ? "unsynced" : "unavailable";
}

export function settingsSheetStays(choice: SignOutChoice): boolean {
  return choice === "stay";
}

export function settingsActionBlocked(busy: boolean): boolean {
  return busy;
}

export function settingsHardwareBack(sheetOpen: boolean): "close_sheet" | "leave" {
  return sheetOpen ? "close_sheet" : "leave";
}

export function settingsPlanPath(): string {
  return subscriptionPath();
}

export function settingsSupportPath(): string {
  return supportPath();
}

export function settingsExportPath(): string {
  return exportPath();
}

export function settingsAnalyticsProperties(): Record<string, never> {
  return {};
}

export function settingsAnalyticsAreSafe(): boolean {
  return analyticsPropertiesAreSafe(settingsAnalyticsProperties());
}

export function settingsRouteAfterSignOut(): RouteGroup {
  return routeGroupFor({ status: "signed_out" });
}

export function settingsAccount(input: {
  authStatus: string;
  bootstrapEmail?: string | null;
  fallbackEmail?: string | null;
}): { email: string | null; initial: string } {
  const email = settingsDisplayEmail(input);
  return { email, initial: settingsAccountInitial(email) };
}
