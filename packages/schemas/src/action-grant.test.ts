import { describe, expect, it } from "vitest";
import {
  ACTION_GRANT_FRESH_AUTH_SECONDS,
  ACTION_GRANT_TTL_SECONDS,
  parseActionGrantBody,
  parseEmptyObjectBody,
  parseWithdrawBody,
} from "./action-grant.ts";

describe("action-grant and S12 request body parsers", () => {
  it("exports ACC02A fresh-auth and grant TTL constants", () => {
    expect(ACTION_GRANT_FRESH_AUTH_SECONDS).toBe(300);
    expect(ACTION_GRANT_TTL_SECONDS).toBe(300);
  });

  it("accepts inventory actions and rejects unknown fields", () => {
    expect(parseActionGrantBody({ action: "replace_link" })).toEqual({
      ok: true,
      value: { action: "replace_link" },
    });
    expect(parseActionGrantBody({ action: "export" }).ok).toBe(true);
    expect(parseActionGrantBody({ action: "replace_link", extra: true }).ok).toBe(false);
    expect(parseActionGrantBody({ action: "not-an-action" }).ok).toBe(false);
  });

  it("requires a trimmed withdraw reason of 1..500 characters", () => {
    expect(parseWithdrawBody({ reason: " Customer cancelled " })).toEqual({
      ok: true,
      value: { reason: "Customer cancelled" },
    });
    expect(parseWithdrawBody({ reason: "" }).ok).toBe(false);
    expect(parseWithdrawBody({ reason: "x", note: "no" }).ok).toBe(false);
    expect(parseWithdrawBody({ reason: "a".repeat(501) }).ok).toBe(false);
  });

  it("allows empty bodies for resend and replace-link", () => {
    expect(parseEmptyObjectBody(undefined)).toEqual({ ok: true, value: {} });
    expect(parseEmptyObjectBody({})).toEqual({ ok: true, value: {} });
    expect(parseEmptyObjectBody({ noop: true }).ok).toBe(false);
  });
});
