import { describe, expect, it } from "vitest";
import { mapAuthError } from "./errors.ts";
import { attemptsExceeded, canSubmitCode, snapshotAfterRefreshFailure } from "../session/logic.ts";
import { clearAuthMaterial, type SecureKv } from "../session/storage.ts";

describe("OTP error mapping", () => {
  it("maps throttle, expiry, attempts, and network without exposing provider payloads", () => {
    expect(mapAuthError({ status: 429, message: "over_email_send_rate_limit" })).toBe("throttled");
    expect(mapAuthError({ message: "otp_expired" })).toBe("expired");
    expect(mapAuthError({ message: "max attempts" })).toBe("attempts");
    expect(mapAuthError({ name: "AuthRetryableFetchError" })).toBe("network");
    expect(mapAuthError({ message: "invalid" })).toBe("incorrect");
  });
});

describe("code submission", () => {
  it("requires six digits and stops after five failures", () => {
    expect(canSubmitCode("123456", 0, false)).toBe(true);
    expect(canSubmitCode("12345", 0, false)).toBe(false);
    expect(canSubmitCode("123456", 5, false)).toBe(false);
    expect(attemptsExceeded(5)).toBe(true);
  });
});

describe("session recovery", () => {
  it("uses the seven-day window then expires", () => {
    const now = Date.parse("2026-09-14T12:00:00.000Z");
    expect(snapshotAfterRefreshFailure("2026-09-10T12:00:00.000Z", now).status).toBe("offline_cached");
    expect(snapshotAfterRefreshFailure("2026-09-01T12:00:00.000Z", now).status).toBe("access_expired");
  });
});

describe("sign-out cleanup", () => {
  it("removes session, bootstrap, and last-auth keys", async () => {
    const store = new Map<string, string>();
    const kv: SecureKv = {
      getItem: async (key) => store.get(key) ?? null,
      setItem: async (key, value) => {
        store.set(key, value);
      },
      removeItem: async (key) => {
        store.delete(key);
      },
    };
    await kv.setItem("jti.supabase.session", "session-json");
    await kv.setItem("jti.auth.last_success_at", "2026-09-14T00:00:00.000Z");
    await kv.setItem("jti.auth.bootstrap", "{}");
    await kv.setItem("jti.pending.replace_link", '{"action":"replace_link"}');
    await clearAuthMaterial(kv);
    expect(await kv.getItem("jti.supabase.session")).toBeNull();
    expect(await kv.getItem("jti.auth.last_success_at")).toBeNull();
    expect(await kv.getItem("jti.auth.bootstrap")).toBeNull();
    expect(await kv.getItem("jti.pending.replace_link")).toBeNull();
  });
});
