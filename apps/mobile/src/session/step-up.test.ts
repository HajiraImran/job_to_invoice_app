import { describe, expect, it } from "vitest";
import {
  grantErrorIsAutoRetryable,
  ownerSignInOtpOptions,
  ownerVerifyOtpParams,
  verifiedSessionIsFreshInstall,
} from "./step-up.ts";

describe("owner OTP step-up", () => {
  it("uses the same email OTP verify type as standard owner login", () => {
    expect(ownerSignInOtpOptions()).toEqual({ shouldCreateUser: true });
    expect(ownerVerifyOtpParams("  owner@example.com ", "123456")).toEqual({
      email: "owner@example.com",
      token: "123456",
      type: "email",
    });
    expect(ownerVerifyOtpParams("owner@example.com", "123456").type).not.toBe("reauthentication");
  });

  it("installs a new post-OTP access token and rejects reusing the previous session", () => {
    expect(
      verifiedSessionIsFreshInstall({
        previousAccessToken: "old-session",
        verifiedAccessToken: "new-session",
      }),
    ).toEqual({ ok: true, outcome: "fresh_session_ready" });
    expect(
      verifiedSessionIsFreshInstall({
        previousAccessToken: "old-session",
        verifiedAccessToken: "old-session",
      }),
    ).toEqual({ ok: false, outcome: "stale_session" });
    expect(verifiedSessionIsFreshInstall({ previousAccessToken: "old-session" })).toEqual({
      ok: false,
      outcome: "missing_session",
    });
    expect(verifiedSessionIsFreshInstall({ verifiedAccessToken: "first-login" })).toEqual({
      ok: true,
      outcome: "fresh_session_ready",
    });
  });

  it("allows bounded retry only for network and 5xx failures", () => {
    expect(grantErrorIsAutoRetryable({ status: 0, retryable: true })).toBe(true);
    expect(grantErrorIsAutoRetryable({ status: 503, retryable: true })).toBe(true);
    expect(grantErrorIsAutoRetryable({ status: 403, retryable: true })).toBe(false);
    expect(grantErrorIsAutoRetryable({ status: 401, retryable: false })).toBe(false);
    expect(grantErrorIsAutoRetryable({ status: 422, retryable: false })).toBe(false);
    expect(grantErrorIsAutoRetryable({ status: 500, retryable: false })).toBe(false);
  });
});
