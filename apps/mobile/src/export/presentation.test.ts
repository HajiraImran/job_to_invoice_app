import {
  ACTION_GRANT_FRESH_AUTH_SECONDS,
  ACTION_GRANT_TTL_SECONDS,
  analyticsPropertiesAreSafe,
  isClientAnalyticsEvent,
  isServerOnlyAnalyticsEvent,
  parseActionGrantBody,
  parseExportRequest,
  redactText,
} from "@job-to-invoice/schemas";
import { describe, expect, it } from "vitest";
import { isForbiddenOutboxPath } from "../sync/outbox-rules.ts";
import { settingsAnalyticsProperties } from "../settings/presentation.ts";
import {
  APPLE_SUBSCRIPTIONS_URL,
  downloadLogIsSafe,
  exportCompletedPropertiesAreSafe,
  exportIdempotencyAfterFailure,
  exportPath,
  exportPollShouldStop,
  exportStatusLabel,
  nextExportRecord,
  presentExport,
  presentPrivacySurface,
  privacyCommandBlocked,
  privacyLogIsSafe,
  type ExportRecord,
} from "./presentation.ts";

function exportRecord(status: ExportRecord["status"]): ExportRecord {
  return {
    id: "e1",
    status,
    cutoff_at: null,
    created_at: null,
    download_until: null,
    delete_after: null,
    ready_at: null,
    schema_version: 1,
    part_count: 1,
    job_count: null,
    bytes: null,
    sha256: null,
    download_available: status === "ready",
    manifest: null,
    error_code: null,
  };
}

describe("S24 export presentation", () => {
  it("blocks offline and expired sessions and exposes the settings route", () => {
    expect(exportPath()).toBe("/(tabs)/settings/data");
    expect(presentExport({ authStatus: "offline_cached", loading: false, requesting: false, stepUp: false })).toEqual({
      kind: "offline",
      exportDisabled: true,
    });
    expect(presentExport({ authStatus: "access_expired", loading: false, requesting: false, stepUp: false }).kind).toBe(
      "access_expired",
    );
    expect(exportStatusLabel("ready")).toBe("Export ready");
  });

  it("shows step-up and working states before download", () => {
    expect(
      presentExport({ authStatus: "authenticated", loading: false, requesting: false, stepUp: true }).kind,
    ).toBe("step_up");
    expect(
      presentExport({
        authStatus: "authenticated",
        loading: false,
        requesting: false,
        stepUp: false,
        record: {
          id: "e1",
          status: "queued",
          cutoff_at: null,
          created_at: null,
          download_until: null,
          delete_after: null,
          ready_at: null,
          schema_version: 1,
          part_count: 1,
          job_count: null,
          bytes: null,
          sha256: null,
          download_available: false,
          manifest: null,
          error_code: null,
        },
      }).kind,
    ).toBe("working");
  });

  it("keeps a failed refresh and stops polling only at a terminal export", () => {
    const ready = exportRecord("ready");
    expect(nextExportRecord(ready, { ok: false })).toBe(ready);
    expect(nextExportRecord(ready, { ok: true, record: null })).toBeNull();
    expect(exportPollShouldStop("queued")).toBe(false);
    expect(exportPollShouldStop("running")).toBe(false);
    expect(exportPollShouldStop("ready")).toBe(true);
    expect(exportPollShouldStop("failed")).toBe(true);
    expect(exportPollShouldStop("expired")).toBe(true);
  });

  it("reuses an export key and rotates it only after an idempotency mismatch", () => {
    expect(exportIdempotencyAfterFailure("export-key", "EXPORT_LIMIT")).toBe("export-key");
    expect(exportIdempotencyAfterFailure("export-key", "OPERATION_PENDING")).toBe("export-key");
    expect(exportIdempotencyAfterFailure("export-key", "IDEMPOTENCY_MISMATCH")).toBeUndefined();
    expect(parseExportRequest({})).toEqual({ ok: true, value: { newer: false } });
    expect(parseExportRequest({ newer: true })).toEqual({ ok: true, value: { newer: true } });
  });

  it("blocks duplicate, offline, and expired commands without logging a download URL", () => {
    expect(privacyCommandBlocked({ offline: true, expired: false, busy: false, locked: false })).toBe(true);
    expect(privacyCommandBlocked({ offline: false, expired: true, busy: false, locked: false })).toBe(true);
    expect(privacyCommandBlocked({ offline: false, expired: false, busy: true, locked: false })).toBe(true);
    expect(privacyCommandBlocked({ offline: false, expired: false, busy: false, locked: true })).toBe(true);
    expect(downloadLogIsSafe("download opened", "https://files.example/export.zip")).toBe(true);
    expect(downloadLogIsSafe("https://files.example/export.zip", "https://files.example/export.zip")).toBe(false);
    expect(isForbiddenOutboxPath("/v1/exports")).toBe(true);
    expect(isForbiddenOutboxPath("/v1/account/action-grants")).toBe(true);
  });

  it("selects the approved privacy surface and hides commands after access expiry", () => {
    expect(
      presentPrivacySurface({
        authStatus: "access_expired",
        loading: false,
        hasExport: true,
        exportStatus: "ready",
        requesting: false,
        deletionLocked: true,
        confirmingDeletion: true,
      }),
    ).toBe("access_expired");
    expect(
      presentPrivacySurface({
        authStatus: "offline_cached",
        loading: false,
        hasExport: true,
        exportStatus: "ready",
        requesting: false,
        deletionLocked: false,
        confirmingDeletion: false,
      }),
    ).toBe("offline");
    expect(
      presentPrivacySurface({
        authStatus: "authenticated",
        loading: false,
        hasExport: true,
        exportStatus: "queued",
        requesting: false,
        deletionLocked: false,
        confirmingDeletion: false,
      }),
    ).toBe("preparing");
    expect(
      presentPrivacySurface({
        authStatus: "authenticated",
        loading: false,
        hasExport: true,
        exportStatus: "ready",
        requesting: false,
        deletionLocked: false,
        confirmingDeletion: false,
      }),
    ).toBe("ready");
    expect(
      presentPrivacySurface({
        authStatus: "authenticated",
        loading: false,
        hasExport: false,
        requesting: false,
        deletionLocked: false,
        confirmingDeletion: false,
      }),
    ).toBe("overview");
    expect(
      presentPrivacySurface({
        authStatus: "authenticated",
        loading: false,
        hasExport: true,
        exportStatus: "failed",
        requesting: false,
        deletionLocked: false,
        confirmingDeletion: false,
      }),
    ).toBe("overview");
  });

  it("keeps export analytics server-owned and redacts grant material", () => {
    expect(isServerOnlyAnalyticsEvent("export_completed")).toBe(true);
    expect(isClientAnalyticsEvent("export_completed")).toBe(false);
    expect(settingsAnalyticsProperties()).toEqual({});
    expect(analyticsPropertiesAreSafe(settingsAnalyticsProperties())).toBe(true);
    expect(exportCompletedPropertiesAreSafe({ size_bucket: "0_1mb", job_count_bucket: "1_10" })).toBe(true);
    expect(exportCompletedPropertiesAreSafe({ size_bucket: "0_1mb", email: "owner@example.com" })).toBe(false);
    expect(parseActionGrantBody({ action: "export" })).toEqual({ ok: true, value: { action: "export" } });
    expect(parseActionGrantBody({ action: "deletion" })).toEqual({ ok: true, value: { action: "deletion" } });
    expect(parseActionGrantBody({ action: "export", grant: "secret" }).ok).toBe(false);
    expect(ACTION_GRANT_FRESH_AUTH_SECONDS).toBe(300);
    expect(ACTION_GRANT_TTL_SECONDS).toBe(300);
    const logged = redactText("code 123456 grant eyJaaaaaaaaaa.bbbbbbbbbbb.ccccccccccc owner@example.com");
    expect(privacyLogIsSafe(logged, ["123456", "owner@example.com", "eyJaaaaaaaaaa.bbbbbbbbbbb.ccccccccccc"])).toBe(true);
    expect(APPLE_SUBSCRIPTIONS_URL).toBe("https://apps.apple.com/account/subscriptions");
  });
});
