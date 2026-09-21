import { describe, expect, it } from "vitest";
import { ACTION_GRANT_FRESH_AUTH_SECONDS } from "@job-to-invoice/schemas";
import { createJwtFixture } from "@job-to-invoice/testing";
import { createJwtVerifier, readAccessAuthTime } from "./jwt.ts";
import { decodeJwt } from "jose";

describe("access token authentication time", () => {
  it("reads auth_time in unix seconds when present", async () => {
    const fixture = await createJwtFixture();
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await fixture.sign({
      sub: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "owner@example.com",
      authTime: nowSec - 12,
    });
    expect(readAccessAuthTime(decodeJwt(token))).toBe(nowSec - 12);
    const access = await createJwtVerifier(fixture)(token);
    expect(access.authTime).toBe(nowSec - 12);
    expect(nowSec - (access.authTime ?? 0)).toBeLessThanOrEqual(ACTION_GRANT_FRESH_AUTH_SECONDS);
  });

  it("treats a fresh otp AMR timestamp as authentication time when auth_time is absent", async () => {
    const fixture = await createJwtFixture();
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await fixture.sign({
      sub: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "owner@example.com",
      amr: [
        { method: "token_refresh", timestamp: nowSec },
        { method: "otp", timestamp: nowSec - 8 },
      ],
    });
    expect(readAccessAuthTime(decodeJwt(token))).toBe(nowSec - 8);
    const access = await createJwtVerifier(fixture)(token);
    expect(access.authTime).toBe(nowSec - 8);
  });

  it("does not treat refresh-only AMR as fresh authentication", async () => {
    const fixture = await createJwtFixture();
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await fixture.sign({
      sub: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "owner@example.com",
      amr: [{ method: "token_refresh", timestamp: nowSec }],
    });
    expect(readAccessAuthTime(decodeJwt(token))).toBeUndefined();
    const access = await createJwtVerifier(fixture)(token);
    expect(access.authTime).toBeUndefined();
  });

  it("rejects a stale otp AMR older than five minutes", async () => {
    const fixture = await createJwtFixture();
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await fixture.sign({
      sub: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "owner@example.com",
      amr: [{ method: "otp", timestamp: nowSec - 400 }],
    });
    const authTime = readAccessAuthTime(decodeJwt(token));
    expect(authTime).toBe(nowSec - 400);
    expect(nowSec - (authTime ?? 0)).toBeGreaterThan(ACTION_GRANT_FRESH_AUTH_SECONDS);
  });
});
