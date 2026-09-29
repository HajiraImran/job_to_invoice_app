import {
  OTP_LENGTH,
  OTP_MAX_FAILURES,
  RESEND_COOLDOWN_MS,
  analyticsPropertiesAreSafe,
  canResend,
  maskEmail,
  parseOwnerEmail,
  remainingResendSeconds,
} from "@job-to-invoice/schemas";
import { canSubmitCode } from "../session/logic.ts";
import { colors } from "../theme.ts";
import { copy } from "../i18n/en.ts";
import { WELCOME_HREF } from "../welcome/presentation.ts";
import { otpErrorCopy, type OtpErrorKind } from "./errors.ts";

export const AUTH_SIGN_IN_HREF = "/(public)/sign-in";
export const AUTH_VERIFY_HREF = "/(public)/verify";
export const AUTH_BACK_HREF = WELCOME_HREF;
export const AUTH_PRIMARY_ACTION = colors.navy;
export const AUTH_PRIMARY_BUTTON_MIN_HEIGHT = 56;
export const AUTH_GUTTER = 24;
export const AUTH_HIT_TARGET = 44;

export type SignInPresentation = {
  context: string;
  safetyLabel: string;
  heading: string;
  supportingText: string;
  codeHint: string;
  emailLabel: string;
  primaryAction: string;
  sendingAction: string;
  privacyNote: string;
  backLabel: string;
  backHref: typeof AUTH_BACK_HREF;
  primaryActionColor: typeof AUTH_PRIMARY_ACTION;
  primaryButtonMinHeight: typeof AUTH_PRIMARY_BUTTON_MIN_HEIGHT;
  settingsVisible: false;
  termsAreLinks: false;
  enumeratesAccount: false;
};

export type VerifyPresentation = {
  context: string;
  safetyLabel: string;
  heading: string;
  instruction: string;
  codeHint: string;
  codeLabel: string;
  pasteHint: string;
  expiryNote: string;
  primaryAction: string;
  verifyingAction: string;
  resendLabel: string;
  changeEmailLabel: string;
  changeEmailHref: typeof AUTH_SIGN_IN_HREF;
  backLabel: string;
  backHref: typeof AUTH_SIGN_IN_HREF;
  otpLength: typeof OTP_LENGTH;
  maxFailures: typeof OTP_MAX_FAILURES;
  resendCooldownMs: typeof RESEND_COOLDOWN_MS;
  autoSubmit: false;
  settingsVisible: false;
};

export function presentSignInScreen(): SignInPresentation {
  return {
    context: copy.secureSignIn,
    safetyLabel: copy.signInSafety,
    heading: copy.signIn,
    supportingText: copy.passwordless,
    codeHint: copy.codeExpiryHint,
    emailLabel: copy.emailLabel,
    primaryAction: copy.sendCode,
    sendingAction: copy.sendingCode,
    privacyNote: copy.authPrivacyNote,
    backLabel: copy.back,
    backHref: AUTH_BACK_HREF,
    primaryActionColor: AUTH_PRIMARY_ACTION,
    primaryButtonMinHeight: AUTH_PRIMARY_BUTTON_MIN_HEIGHT,
    settingsVisible: false,
    termsAreLinks: false,
    enumeratesAccount: false,
  };
}

export function presentVerifyScreen(): VerifyPresentation {
  return {
    context: copy.secureVerification,
    safetyLabel: copy.safeBadge,
    heading: copy.verifyTitle,
    instruction: copy.codeSent,
    codeHint: copy.verifyHint,
    codeLabel: copy.codeLabel,
    pasteHint: copy.codePasteHint,
    expiryNote: copy.verifyExpiryNote,
    primaryAction: copy.verifyCode,
    verifyingAction: copy.verifying,
    resendLabel: copy.resend,
    changeEmailLabel: copy.changeEmail,
    changeEmailHref: AUTH_SIGN_IN_HREF,
    backLabel: copy.back,
    backHref: AUTH_SIGN_IN_HREF,
    otpLength: OTP_LENGTH,
    maxFailures: OTP_MAX_FAILURES,
    resendCooldownMs: RESEND_COOLDOWN_MS,
    autoSubmit: false,
    settingsVisible: false,
  };
}

export function sanitizeOwnerCode(input: string): string {
  return input.replace(/\D/g, "").slice(0, OTP_LENGTH);
}

export function presentCodeCells(code: string): readonly string[] {
  const digits = sanitizeOwnerCode(code);
  return Array.from({ length: OTP_LENGTH }, (_, index) => digits[index] ?? "");
}

export function presentVerifyReady(code: string, failures: number, submitting: boolean): boolean {
  return canSubmitCode(sanitizeOwnerCode(code), failures, submitting);
}

export function presentResendState(
  nowMs: number,
  availableAt: number | undefined,
  submitting: boolean,
): { available: boolean; seconds: number; label: string } {
  const seconds = remainingResendSeconds(nowMs, availableAt);
  return {
    available: canResend(nowMs, availableAt) && !submitting,
    seconds,
    label: presentResendLabel(seconds),
  };
}

export function presentMaskedEmail(display: string): string {
  return maskEmail(display);
}

export function presentResendLabel(seconds: number): string {
  if (seconds <= 0) {
    return copy.resend;
  }
  return copy.resendIn.replace("{seconds}", String(seconds));
}

export function presentEmailFieldError(value: string): string | undefined {
  const parsed = parseOwnerEmail(value);
  if (parsed.ok || value.trim().length === 0) {
    return undefined;
  }
  return parsed.code === "too_long" ? copy.emailTooLong : copy.invalidEmail;
}

export function presentOtpError(kind: OtpErrorKind): string {
  return otpErrorCopy(kind);
}

export function authAnalyticsPropertiesAreSafe(properties: Record<string, unknown>): boolean {
  return analyticsPropertiesAreSafe(properties);
}
