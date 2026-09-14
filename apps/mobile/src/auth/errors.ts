export type OtpErrorKind = "throttled" | "network" | "expired" | "incorrect" | "attempts" | "generic";

const THROTTLE = /rate|too many|60|cooldown|over_email_send_rate_limit/i;
const EXPIRED = /expired|otp_expired|token_expired/i;
const ATTEMPTS = /attempt|max|too many invalid/i;
const NETWORK = /network|fetch|timeout|offline|failed to fetch|internet/i;

export function mapAuthError(input: { message?: string; status?: number; name?: string }): OtpErrorKind {
  const message = input.message ?? "";
  if (input.status === 429 || THROTTLE.test(message)) {
    return "throttled";
  }
  if (NETWORK.test(message) || input.name === "AuthRetryableFetchError") {
    return "network";
  }
  if (EXPIRED.test(message)) {
    return "expired";
  }
  if (ATTEMPTS.test(message)) {
    return "attempts";
  }
  if (message.length > 0) {
    return "incorrect";
  }
  return "generic";
}

import { copy } from "../i18n/en.ts";

export function otpErrorCopy(kind: OtpErrorKind): string {
  switch (kind) {
    case "throttled":
      return copy.throttled;
    case "network":
      return copy.networkError;
    case "expired":
      return copy.expiredCode;
    case "attempts":
      return copy.tooManyAttempts;
    case "incorrect":
      return copy.incorrectCode;
    default:
      return copy.networkError;
  }
}
