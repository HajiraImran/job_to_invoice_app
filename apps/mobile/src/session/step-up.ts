/**
 * Owner step-up uses the same hosted email OTP as sign-in.
 * supabase-js 2.116.0 has no verifyOtp type "reauthentication".
 * auth.reauthenticate() emails a nonce for updateUser() and does not issue a new access JWT.
 */
export const OWNER_OTP_VERIFY_TYPE = "email" as const;

export function ownerSignInOtpOptions(): { shouldCreateUser: true } {
  return { shouldCreateUser: true };
}

export function ownerVerifyOtpParams(email: string, token: string): {
  email: string;
  token: string;
  type: typeof OWNER_OTP_VERIFY_TYPE;
} {
  return { email: email.trim(), token: token.trim(), type: OWNER_OTP_VERIFY_TYPE };
}

export function verifiedSessionIsFreshInstall(input: {
  previousAccessToken?: string;
  verifiedAccessToken?: string;
}): { ok: true; outcome: "fresh_session_ready" } | { ok: false; outcome: "missing_session" | "stale_session" } {
  if (!input.verifiedAccessToken) {
    return { ok: false, outcome: "missing_session" };
  }
  if (input.previousAccessToken && input.previousAccessToken === input.verifiedAccessToken) {
    return { ok: false, outcome: "stale_session" };
  }
  return { ok: true, outcome: "fresh_session_ready" };
}

export function grantErrorIsAutoRetryable(error: { status: number; retryable?: boolean }): boolean {
  if (error.status === 401 || error.status === 403 || error.status === 422) {
    return false;
  }
  return error.retryable === true && (error.status === 0 || error.status >= 500);
}
