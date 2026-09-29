import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESEND_COOLDOWN_MS,
  analyticsPropertiesAreSafe,
  redactText,
  remainingResendSeconds,
  resendAvailableAt,
} from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import { canSubmitCode, routeAfterAuth } from "../session/logic.ts";
import { colors } from "../theme.ts";
import { WELCOME_HREF } from "../welcome/presentation.ts";
import {
  AUTH_BACK_HREF,
  AUTH_PRIMARY_ACTION,
  AUTH_PRIMARY_BUTTON_MIN_HEIGHT,
  AUTH_SIGN_IN_HREF,
  AUTH_VERIFY_HREF,
  authAnalyticsPropertiesAreSafe,
  presentCodeCells,
  presentEmailFieldError,
  presentMaskedEmail,
  presentOtpError,
  presentResendLabel,
  presentResendState,
  presentSignInScreen,
  presentVerifyReady,
  presentVerifyScreen,
  sanitizeOwnerCode,
} from "./presentation.ts";

describe("S02 owner email presentation", () => {
  it("renders the approved heading, passwordless copy, and send action", () => {
    const screen = presentSignInScreen();
    expect(screen.heading).toBe("Sign in");
    expect(screen.supportingText).toBe("We'll email a one-time code. There is no password.");
    expect(screen.primaryAction).toBe("Send code");
    expect(screen.context).toBe("Secure sign in");
    expect(screen.safetyLabel).toBe("One-time code. No password stored.");
    expect(screen.codeHint).toContain("six-digit");
    expect(screen.codeHint).toContain("ten minutes");
    expect(screen.backLabel).toBe("Back");
    expect(screen.backHref).toBe(WELCOME_HREF);
    expect(screen.backHref).toBe(AUTH_BACK_HREF);
    expect(screen.settingsVisible).toBe(false);
    expect(screen.termsAreLinks).toBe(false);
    expect(screen.enumeratesAccount).toBe(false);
  });

  it("uses navy 56-point primary action and keeps privacy copy unlinkable", () => {
    const screen = presentSignInScreen();
    expect(screen.primaryActionColor).toBe(AUTH_PRIMARY_ACTION);
    expect(screen.primaryActionColor).toBe(colors.navy);
    expect(screen.primaryActionColor).toBe("#17324D");
    expect(screen.primaryButtonMinHeight).toBe(AUTH_PRIMARY_BUTTON_MIN_HEIGHT);
    expect(screen.primaryButtonMinHeight).toBeGreaterThanOrEqual(48);
    expect(screen.privacyNote).toBe(copy.authPrivacyNote);
  });

  it("validates email without revealing account existence", () => {
    expect(presentEmailFieldError("")).toBeUndefined();
    expect(presentEmailFieldError("not-an-email")).toBe(copy.invalidEmail);
    expect(presentEmailFieldError(`${"a".repeat(250)}@x.co`)).toBe(copy.emailTooLong);
    expect(presentEmailFieldError("  Owner@Example.com ")).toBeUndefined();
  });
});

describe("S03 owner code presentation", () => {
  it("renders the approved verify contract and routes back to S02", () => {
    const screen = presentVerifyScreen();
    expect(screen.heading).toBe("Check your email");
    expect(screen.context).toBe("Secure verification");
    expect(screen.safetyLabel).toBe("Safe");
    expect(screen.instruction).toBe("If that email can receive mail, we sent a code.");
    expect(screen.primaryAction).toBe("Verify code");
    expect(screen.resendLabel).toBe("Resend code");
    expect(screen.changeEmailLabel).toBe("Change email");
    expect(screen.changeEmailHref).toBe(AUTH_SIGN_IN_HREF);
    expect(screen.backHref).toBe(AUTH_SIGN_IN_HREF);
    expect(screen.backLabel).toBe("Back");
    expect(AUTH_VERIFY_HREF).toBe("/(public)/verify");
    expect(screen.otpLength).toBe(6);
    expect(screen.maxFailures).toBe(5);
    expect(screen.resendCooldownMs).toBe(60_000);
    expect(screen.autoSubmit).toBe(false);
    expect(screen.settingsVisible).toBe(false);
    expect(screen.pasteHint).toBe(copy.codePasteHint);
    expect(screen.expiryNote).toContain("ten minutes");
  });

  it("sanitizes pasted and typed input to six numeric digits", () => {
    expect(sanitizeOwnerCode("")).toBe("");
    expect(sanitizeOwnerCode("12ab34")).toBe("1234");
    expect(sanitizeOwnerCode("12-34 56")).toBe("123456");
    expect(sanitizeOwnerCode("123456789")).toBe("123456");
    expect(sanitizeOwnerCode("abcdef")).toBe("");
    expect(presentCodeCells("12")).toEqual(["1", "2", "", "", "", ""]);
    expect(presentCodeCells("12ab34")).toEqual(["1", "2", "3", "4", "", ""]);
    expect(presentCodeCells("123456789")).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("enables verify only for a complete unused six-digit code", () => {
    expect(presentVerifyReady("", 0, false)).toBe(false);
    expect(presentVerifyReady("12345", 0, false)).toBe(false);
    expect(presentVerifyReady("123456", 0, false)).toBe(true);
    expect(presentVerifyReady("123456", 0, true)).toBe(false);
    expect(presentVerifyReady("123456", 5, false)).toBe(false);
    expect(canSubmitCode("123456", 4, false)).toBe(true);
  });

  it("masks the destination email and never includes a raw OTP", () => {
    expect(presentMaskedEmail("owner@example.com")).toBe("o***@example.com");
    const announced = `${presentVerifyScreen().instruction} ${presentMaskedEmail("owner@example.com")}`;
    expect(announced).not.toContain("owner@example.com");
    expect(announced).not.toMatch(/\b\d{6}\b/);
    expect(presentVerifyScreen().codeLabel).toBe("6-digit code");
  });
});

describe("S03 resend countdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays disabled until 60 elapsed seconds and then becomes available", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    const sent = Date.now();
    const availableAt = resendAvailableAt(sent);
    expect(availableAt - sent).toBe(RESEND_COOLDOWN_MS);
    expect(presentResendState(sent + 1_000, availableAt, false)).toEqual({
      available: false,
      seconds: 59,
      label: "Resend in 59s",
    });
    vi.setSystemTime(new Date("2026-09-25T12:00:59.000Z"));
    expect(remainingResendSeconds(Date.now(), availableAt)).toBe(1);
    expect(presentResendState(Date.now(), availableAt, false).available).toBe(false);
    vi.setSystemTime(new Date("2026-09-25T12:01:00.000Z"));
    expect(presentResendState(Date.now(), availableAt, false)).toEqual({
      available: true,
      seconds: 0,
      label: "Resend code",
    });
    expect(presentResendState(Date.now(), availableAt, true).available).toBe(false);
    expect(presentResendLabel(0)).toBe("Resend code");
  });
});

describe("S03 errors and session transitions", () => {
  it("maps provider failures to safe copy and does not authenticate on failure", () => {
    expect(presentOtpError("incorrect")).toBe(copy.incorrectCode);
    expect(presentOtpError("expired")).toBe(copy.expiredCode);
    expect(presentOtpError("attempts")).toBe(copy.tooManyAttempts);
    expect(presentOtpError("network")).toBe(copy.networkError);
    expect(presentOtpError("throttled")).toBe(copy.throttled);
    expect(routeAfterAuth({ status: "awaiting_code" })).toBe("verify");
    expect(routeAfterAuth({ status: "awaiting_code" })).not.toBe("app");
    expect(routeAfterAuth({ status: "awaiting_code" })).not.toBe("onboarding");
    expect(routeAfterAuth({ status: "authenticated", setupCompleted: false })).toBe("onboarding");
    expect(routeAfterAuth({ status: "authenticated", setupCompleted: true })).toBe("app");
  });

  it("redacts OTP, email, and tokens from analytics and logs", () => {
    expect(redactText("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaa.bbbb owner@example.com 123456")).not.toMatch(
      /Bearer eyJ|owner@example.com|123456/,
    );
    expect(authAnalyticsPropertiesAreSafe({ acquisition_source: "unknown" })).toBe(true);
    expect(authAnalyticsPropertiesAreSafe({ email: "owner@example.com" })).toBe(false);
    expect(analyticsPropertiesAreSafe({ code: "123456" })).toBe(false);
  });
});
