import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  MONEY_ERROR_CODES,
  MONEY_SCHEMA_VERSION,
  OTP_MAX_FAILURES,
  RESEND_COOLDOWN_MS,
  SNAPSHOT_SCHEMA_VERSION,
  analyticsPropertiesAreSafe,
  BOOTSTRAP_SUPPORT_CODES,
  EMPTY_DRAFT_SYNC,
  canResend,
  isOfflineReadPermitted,
  maskEmail,
  parseOwnerEmail,
  publicRouteAllowed,
  redactRecord,
  redactText,
  remainingResendSeconds,
  resendAvailableAt,
  routeGroupFor,
  signOutClears,
} from "./index.ts";

describe("versioned money schemas", () => {
  it("publishes money schema v1 and quote snapshot schema v1", () => {
    expect(MONEY_SCHEMA_VERSION).toBe(1);
    expect(SNAPSHOT_SCHEMA_VERSION).toBe(1);
    expect(MONEY_ERROR_CODES.CREDIT_EXCEEDS_SOURCE).toBe("CREDIT_EXCEEDS_SOURCE");
    expect(MONEY_ERROR_CODES.REFUND_EXCEEDS_BALANCE).toBe("REFUND_EXCEEDS_BALANCE");
    expect(MONEY_ERROR_CODES.ENTRY_ALREADY_REVERSED).toBe("ENTRY_ALREADY_REVERSED");
  });
});

describe("VAL01 owner email", () => {
  it("trims display email and lowercases lookup without plus or dot rewriting", () => {
    const parsed = parseOwnerEmail("  Jane.Doe+tag@Example.COM ");
    expect(parsed).toEqual({
      ok: true,
      display: "Jane.Doe+tag@Example.COM",
      normalized: "jane.doe+tag@example.com",
    });
  });

  it("rejects invalid and overly long emails", () => {
    expect(parseOwnerEmail("not-an-email")).toEqual({ ok: false, code: "invalid" });
    expect(parseOwnerEmail(`${"a".repeat(250)}@x.co`)).toEqual({ ok: false, code: "too_long" });
  });

  it("masks local-part for S03 copy", () => {
    expect(maskEmail("owner@example.com")).toBe("o***@example.com");
  });
});

describe("auth state", () => {
  it("enforces a 60-second resend countdown", () => {
    const sent = 1_000_000;
    const available = resendAvailableAt(sent);
    expect(available - sent).toBe(RESEND_COOLDOWN_MS);
    expect(canResend(sent + 59_000, available)).toBe(false);
    expect(remainingResendSeconds(sent + 59_000, available)).toBe(1);
    expect(canResend(available, available)).toBe(true);
  });

  it("routes unauthenticated users to public screens and signed-in users by setup state", () => {
    expect(routeGroupFor({ status: "signed_out" })).toBe("public");
    expect(routeGroupFor({ status: "awaiting_code" })).toBe("verify");
    expect(routeGroupFor({ status: "bootstrap_error" })).toBe("verify");
    expect(routeGroupFor({ status: "bootstrap_error", supportCode: "BOOTSTRAP_NETWORK" })).toBe("verify");
    expect(routeGroupFor({ status: "authenticated", setupCompleted: false })).toBe("onboarding");
    expect(routeGroupFor({ status: "authenticated", setupCompleted: true })).toBe("app");
    expect(routeGroupFor({ status: "restoring" })).toBe("splash");
    expect(publicRouteAllowed("/(public)/sign-in")).toBe(true);
    expect(publicRouteAllowed("/(tabs)/jobs")).toBe(false);
  });

  it("permits cached offline reads only within seven days of last authentication", () => {
    const now = Date.parse("2026-09-14T12:00:00.000Z");
    expect(isOfflineReadPermitted("2026-09-10T12:00:00.000Z", now)).toBe(true);
    expect(isOfflineReadPermitted("2026-09-01T12:00:00.000Z", now)).toBe(false);
    expect(OTP_MAX_FAILURES).toBe(5);
    expect(BOOTSTRAP_SUPPORT_CODES).toContain("BOOTSTRAP_NETWORK");
    expect(BOOTSTRAP_SUPPORT_CODES).toHaveLength(5);
  });

  it("lists session material that sign-out must clear", () => {
    expect(signOutClears()).toEqual(
      expect.arrayContaining(["access_token", "refresh_token", "session", "in_memory_auth", "bootstrap"]),
    );
  });

  it("keeps the empty draft-sync status until local persistence exists", () => {
    expect(EMPTY_DRAFT_SYNC).toEqual({ hasUnsyncedDrafts: false, synchronizeAvailable: false });
    expect(publicRouteAllowed("/(tabs)/jobs")).toBe(false);
    expect(publicRouteAllowed("/(public)/welcome")).toBe(true);
  });
});

describe("redaction", () => {
  it("removes tokens, emails, and OTP codes from logs", () => {
    const text = redactText("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaa.bbbb owner@example.com code 123456");
    expect(text).not.toMatch(/example.com/i);
    expect(text).not.toContain("123456");
    expect(text).not.toContain("Bearer eyJ");
    expect(API_ERROR_CODES.AUTHENTICATION_REQUIRED).toBe("AUTHENTICATION_REQUIRED");
    expect(API_ERROR_CODES.ENTRY_ALREADY_REVERSED).toBe("ENTRY_ALREADY_REVERSED");
    expect(API_ERROR_CODES.LEDGER_BLOCKS_VOID).toBe("LEDGER_BLOCKS_VOID");
    expect(API_ERROR_CODES.JOB_NOT_DELETABLE).toBe("JOB_NOT_DELETABLE");
    expect(API_ERROR_CODES.JOB_NOT_CANCELABLE).toBe("JOB_NOT_CANCELABLE");
  });

  it("redacts nested sensitive keys and rejects unsafe analytics properties", () => {
    const redacted = redactRecord({
      authorization: "Bearer secret",
      nested: { email: "a@b.co", note: "ok" },
    }) as Record<string, unknown>;
    expect(redacted.authorization).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).email).toBe("[REDACTED]");
    expect(analyticsPropertiesAreSafe({ acquisition_source: "unknown" })).toBe(true);
    expect(analyticsPropertiesAreSafe({ email: "a@b.co" })).toBe(false);
  });
});
