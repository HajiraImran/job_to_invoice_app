import { parseDeletionRequest } from "@job-to-invoice/schemas";
import { describe, expect, it } from "vitest";
import { isForbiddenOutboxPath } from "../sync/outbox-rules.ts";
import { copy } from "../i18n/en.ts";
import {
  deletionBadge,
  deletionConfirmEnabled,
  deletionIdempotencyAfterFailure,
  deletionStatusLabel,
  presentDeletion,
  visibleRetentionCategories,
} from "./presentation.ts";

describe("S24 deletion presentation", () => {
  it("blocks offline, expired, and already locked accounts", () => {
    expect(presentDeletion({ authStatus: "offline_cached", requesting: false, stepUp: false, confirmation: "DELETE" })).toEqual({
      kind: "offline",
      confirmDisabled: true,
    });
    expect(
      presentDeletion({ authStatus: "access_expired", requesting: false, stepUp: false, confirmation: "DELETE" }).kind,
    ).toBe("access_expired");
    expect(
      presentDeletion({
        authStatus: "authenticated",
        accountStatus: "deleting",
        requesting: false,
        stepUp: false,
        confirmation: "DELETE",
      }).kind,
    ).toBe("locked");
    expect(deletionStatusLabel("locked")).toContain("locked");
  });

  it("requires the exact DELETE phrase before confirm", () => {
    expect(
      presentDeletion({
        authStatus: "authenticated",
        requesting: false,
        stepUp: false,
        confirmation: "delete",
      }),
    ).toEqual({ kind: "ready", confirmDisabled: true });
    expect(
      presentDeletion({
        authStatus: "authenticated",
        requesting: false,
        stepUp: false,
        confirmation: "DELETE",
      }),
    ).toEqual({ kind: "ready", confirmDisabled: false });
  });

  it("accepts only the exact DELETE phrase and reuses the deletion key", () => {
    expect(parseDeletionRequest({ confirmation: "DELETE" }).ok).toBe(true);
    expect(parseDeletionRequest({ confirmation: "delete" }).ok).toBe(false);
    expect(parseDeletionRequest({ confirmation: "DELETE", reason: "now" }).ok).toBe(false);
    expect(deletionConfirmEnabled("DELETE", false)).toBe(true);
    expect(deletionConfirmEnabled("delete", false)).toBe(false);
    expect(deletionConfirmEnabled(" DELETE ", false)).toBe(false);
    expect(deletionConfirmEnabled("DELETE", true)).toBe(false);
    expect(deletionIdempotencyAfterFailure("deletion-key", "OPERATION_PENDING")).toBe("deletion-key");
    expect(deletionIdempotencyAfterFailure("deletion-key", "IDEMPOTENCY_MISMATCH")).toBeUndefined();
    expect(isForbiddenOutboxPath("/v1/account/deletion")).toBe(true);
  });

  it("presents server deletion states without invented retention categories", () => {
    expect(deletionBadge("locked")).toBe("ACCOUNT LOCKED");
    expect(deletionBadge("purging")).toBe("REMOVING RECORDS");
    expect(deletionBadge("completed")).toBe("LIVE RECORDS REMOVED");
    expect(deletionBadge("exception")).toBe("NEEDS ATTENTION");
    expect(deletionStatusLabel("purging")).toContain("Removing");
    expect(deletionStatusLabel("completed")).toContain("removed");
    expect(deletionStatusLabel("exception")).toContain("support");
    expect(visibleRetentionCategories([])).toEqual([]);
    expect(visibleRetentionCategories(["tax_records"])).toEqual(["tax_records"]);
    expect(visibleRetentionCategories([""])).toEqual([]);
    expect(copy.accessExpired).toBe("Sign in again to refresh your account.");
    expect(copy.conflictSignInTitle).toBe("Sign in again");
    expect(copy.privacyCancelValue).toBe("Not available in app");
  });
});
