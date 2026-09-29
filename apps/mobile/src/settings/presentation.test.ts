import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT_SYNC, routeGroupFor } from "@job-to-invoice/schemas";
import { LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED } from "../drafts/sync.ts";
import { copy } from "../i18n/en.ts";
import { signOutChoiceProceeds, signOutFailureCopy } from "../session/sign-out.ts";
import {
  presentSettings,
  settingsAccount,
  settingsActionBlocked,
  settingsAnalyticsAreSafe,
  settingsAnalyticsProperties,
  settingsDisplayEmail,
  settingsExportPath,
  settingsHardwareBack,
  settingsPlanPath,
  settingsRouteAfterSignOut,
  settingsSheetStays,
  settingsSignOutSheet,
  settingsSupportPath,
  settingsSyncLabel,
} from "./presentation.ts";

const FIXTURE_EMAIL = "owner.fixture@example.com";

describe("S22 settings overview", () => {
  it("presents an authenticated overview with the production email", () => {
    const account = settingsAccount({
      authStatus: "authenticated",
      bootstrapEmail: FIXTURE_EMAIL,
      fallbackEmail: "fallback@example.com",
    });
    expect(account.email).toBe(FIXTURE_EMAIL);
    expect(account.initial).toBe("O");
    const view = presentSettings({
      authStatus: "authenticated",
      drafts: { hasUnsyncedDrafts: false, synchronizeAvailable: true },
      phase: "idle",
      statusKnown: true,
    });
    expect(view.showAccount).toBe(true);
    expect(view.showRows).toBe(true);
    expect(view.showSignOut).toBe(true);
    expect(view.syncKind).toBe("synchronized");
  });

  it("uses the safe display-email fallback only when bootstrap email is absent", () => {
    expect(
      settingsDisplayEmail({
        authStatus: "authenticated",
        bootstrapEmail: "  ",
        fallbackEmail: "saved@example.com",
      }),
    ).toBe("saved@example.com");
    expect(
      settingsDisplayEmail({
        authStatus: "offline_cached",
        fallbackEmail: "saved@example.com",
      }),
    ).toBe("saved@example.com");
  });

  it("hides the account email after access expiry", () => {
    const account = settingsAccount({
      authStatus: "access_expired",
      bootstrapEmail: FIXTURE_EMAIL,
      fallbackEmail: FIXTURE_EMAIL,
    });
    const view = presentSettings({
      authStatus: "access_expired",
      drafts: { hasUnsyncedDrafts: true, synchronizeAvailable: true },
      phase: "idle",
      statusKnown: true,
    });
    expect(account.email).toBeNull();
    expect(account.initial).toBe("");
    expect(view.showAccount).toBe(false);
    expect(view.showRows).toBe(false);
    expect(view.syncKind).toBe("hidden");
    expect(view.showSynchronize).toBe(false);
    expect(JSON.stringify({ account, view })).not.toContain(FIXTURE_EMAIL);
    expect(routeGroupFor({ status: "access_expired" })).toBe("public");
  });

  it("does not claim synchronized when no controller is bound", () => {
    const view = presentSettings({
      authStatus: "authenticated",
      drafts: EMPTY_DRAFT_SYNC,
      phase: "idle",
      statusKnown: true,
    });
    expect(LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED).toBe(true);
    expect(view.syncKind).toBe("unavailable");
    expect(view.showSynchronize).toBe(false);
    expect(settingsSyncLabel(view.syncKind)).toBe(copy.settingsSyncUnavailable);
    expect(settingsSyncLabel("synchronized")).toBe(copy.jobSyncedBadge);
  });

  it("shows unsynchronized status and a synchronize action when the controller can run", () => {
    const view = presentSettings({
      authStatus: "authenticated",
      drafts: { hasUnsyncedDrafts: true, synchronizeAvailable: true },
      phase: "idle",
      statusKnown: true,
    });
    expect(view.syncKind).toBe("unsynchronized");
    expect(view.showSynchronize).toBe(true);
    expect(settingsSyncLabel(view.syncKind)).toBe(copy.syncPendingCount);
  });

  it("hides synchronize until status is known and while synchronization is unavailable", () => {
    expect(
      presentSettings({
        authStatus: "authenticated",
        drafts: { hasUnsyncedDrafts: true, synchronizeAvailable: true },
        phase: "idle",
        statusKnown: false,
      }).showSynchronize,
    ).toBe(false);
    expect(
      presentSettings({
        authStatus: "authenticated",
        drafts: { hasUnsyncedDrafts: true, synchronizeAvailable: false },
        phase: "idle",
        statusKnown: true,
      }).showSynchronize,
    ).toBe(false);
  });

  it("locks synchronize while busy and keeps failure and conflict copy", () => {
    expect(settingsActionBlocked(true)).toBe(true);
    expect(settingsActionBlocked(false)).toBe(false);
    const syncing = presentSettings({
      authStatus: "authenticated",
      drafts: { hasUnsyncedDrafts: true, synchronizeAvailable: true },
      phase: "synchronizing",
      statusKnown: true,
    });
    expect(syncing.syncKind).toBe("synchronizing");
    expect(syncing.showSynchronize).toBe(true);
    const failed = presentSettings({
      authStatus: "authenticated",
      drafts: { hasUnsyncedDrafts: true, synchronizeAvailable: true },
      phase: "failed",
      statusKnown: true,
    });
    const conflict = presentSettings({
      authStatus: "authenticated",
      drafts: { hasUnsyncedDrafts: true, synchronizeAvailable: true },
      phase: "conflict",
      statusKnown: true,
    });
    expect(settingsSyncLabel(failed.syncKind)).toBe(copy.synchronizeFailed);
    expect(settingsSyncLabel(conflict.syncKind)).toBe("Resolve the draft conflict before signing out.");
    expect(failed.showSynchronize).toBe(true);
    expect(conflict.showSynchronize).toBe(true);
  });

  it("keeps saved account status offline without claiming a refresh", () => {
    const view = presentSettings({
      authStatus: "offline_cached",
      drafts: { hasUnsyncedDrafts: true, synchronizeAvailable: false },
      phase: "idle",
      statusKnown: true,
    });
    expect(view.offline).toBe(true);
    expect(view.showSignOut).toBe(true);
    expect(view.showSynchronize).toBe(false);
    expect(`${copy.settingsOfflineTitle}. ${copy.settingsOfflineBody}`).toBe(copy.offlineCached);
  });

  it("opens the standard confirmation when there are no unsynchronized drafts", () => {
    expect(settingsSignOutSheet(EMPTY_DRAFT_SYNC, true)).toBe("confirm");
    expect(settingsSheetStays("stay")).toBe(true);
    expect(signOutChoiceProceeds("stay")).toBe(false);
    expect(signOutChoiceProceeds("confirm")).toBe(true);
    expect(copy.signOutConfirm).toBe("Sign out of this device?");
    expect(copy.settingsSignOutBody).toContain("will not be deleted");
  });

  it("offers synchronize before sign-out only when drafts are unsynchronized and sync is available", () => {
    expect(
      settingsSignOutSheet({ hasUnsyncedDrafts: true, synchronizeAvailable: true }, LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED),
    ).toBe("unsynced");
    expect(settingsSignOutSheet({ hasUnsyncedDrafts: true, synchronizeAvailable: false }, true)).toBe("unavailable");
    expect(copy.settingsUnavailableSheetBody).not.toMatch(/synchronized/i);
    expect(copy.discardAndSignOut).toMatch(/discard/i);
  });

  it("keeps the owner signed in and shows the conflict sentence when synchronization cannot finish", () => {
    expect(signOutFailureCopy("synchronize", "conflict")).toBe(copy.synchronizeConflict);
    expect(signOutFailureCopy("synchronize", "failed")).toBe(copy.synchronizeFailed);
    expect(signOutFailureCopy("discard")).toBe(copy.discardFailed);
    expect(signOutFailureCopy("sign_out")).toBe(copy.signOutFailed);
    expect(signOutChoiceProceeds("synchronize")).toBe(true);
  });

  it("closes an open sheet on Android back without signing out", () => {
    expect(settingsHardwareBack(true)).toBe("close_sheet");
    expect(settingsHardwareBack(false)).toBe("leave");
    expect(settingsActionBlocked(true)).toBe(true);
  });

  it("keeps plan, support, and export on their existing routes", () => {
    expect(settingsPlanPath()).toBe("/(tabs)/settings/subscription");
    expect(settingsSupportPath()).toBe("/(tabs)/settings/support");
    expect(settingsExportPath()).toBe("/(tabs)/settings/data");
  });

  it("emits no analytics properties and no sensitive values", () => {
    const properties = settingsAnalyticsProperties();
    expect(properties).toEqual({});
    expect(settingsAnalyticsAreSafe()).toBe(true);
    expect(JSON.stringify(properties)).not.toMatch(/email|token|draft|workspace/i);
    expect(settingsRouteAfterSignOut()).toBe("public");
  });
});
