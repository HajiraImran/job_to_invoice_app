import { describe, expect, it } from "vitest";
import {
  OWNER_ME_EVENT,
  OWNER_ME_SAFE_KEYS,
  allowlistedSqlstate,
  ownerMeEventHasOnlySafeFields,
  ownerMeSafeEvent,
  writeOwnerMeEvent,
} from "./me-log.ts";

const FORBIDDEN = [
  "stack",
  "cause",
  "authorization",
  "access_token",
  "refresh_token",
  "email",
  "user_id",
  "workspace_id",
  "headers",
  "body",
  "database_url",
  "password",
];

describe("owner /v1/me console events", () => {
  it("emits only allowlisted fields", () => {
    const event = ownerMeSafeEvent({
      request_id: "11111111-1111-4111-8111-111111111111",
      status: 401,
      stage: "jwt_rejected",
    });
    expect(ownerMeEventHasOnlySafeFields(event)).toBe(true);
    expect(Object.keys(event).sort()).toEqual([...OWNER_ME_SAFE_KEYS].sort());
    expect(event.event).toBe(OWNER_ME_EVENT);
    expect(event.request_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(event.status).toBe(401);
    expect(event.stage).toBe("jwt_rejected");
  });

  it("keeps an allowlisted SQLSTATE and drops anything else", () => {
    const kept = ownerMeSafeEvent({
      request_id: "33333333-3333-4333-8333-333333333333",
      status: 503,
      stage: "set_role_failed",
      sqlstate: "42501",
    });
    expect(kept.sqlstate).toBe("42501");
    expect(ownerMeEventHasOnlySafeFields(kept)).toBe(true);
    expect(allowlistedSqlstate("ECONNREFUSED")).toBeUndefined();
    expect(allowlistedSqlstate("permission denied")).toBeUndefined();
    const dropped = ownerMeSafeEvent({
      request_id: "44444444-4444-4444-8444-444444444444",
      status: 503,
      stage: "database_connect_failed",
      sqlstate: "ECONNREFUSED",
    });
    expect(dropped.sqlstate).toBeUndefined();
    expect(Object.keys(dropped)).not.toContain("sqlstate");
  });

  it("strips extra fields and never serializes an error object or stack", () => {
    const lines: string[] = [];
    writeOwnerMeEvent(
      {
        event: OWNER_ME_EVENT,
        request_id: "22222222-2222-4222-8222-222222222222",
        status: 503,
        stage: "database_or_provisioning_failed",
        message: "could not SET ROLE",
        stack: "Error: boom\n    at Object.<anonymous>",
        error: new Error("could not SET ROLE"),
        email: "owner@example.com",
        sqlstate: "not-a-sqlstate",
      } as never,
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0] ?? "{}");
    expect(ownerMeEventHasOnlySafeFields(parsed)).toBe(true);
    const serialized = lines[0] ?? "";
    expect(serialized).not.toMatch(/Error:|at Object|SET ROLE|owner@|Bearer |eyJ/i);
    expect(serialized).not.toContain("sqlstate");
    for (const key of FORBIDDEN) {
      expect(serialized.toLowerCase()).not.toContain(`"${key}"`);
    }
  });
});
