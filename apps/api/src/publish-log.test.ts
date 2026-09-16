import { describe, expect, it } from "vitest";
import { ApiTransactionError } from "./db.ts";
import {
  QUOTE_PUBLISH_EVENT,
  QUOTE_PUBLISH_SAFE_KEYS,
  quotePublishDatabaseStage,
  quotePublishEventHasOnlySafeFields,
  quotePublishSafeEvent,
  quotePublishSqlstate,
  sqlstateCategory,
  writeQuotePublishEvent,
} from "./publish-log.ts";

const FORBIDDEN = [
  "stack",
  "cause",
  "authorization",
  "access_token",
  "refresh_token",
  "email",
  "recipient_email",
  "user_id",
  "workspace_id",
  "draft_id",
  "job_id",
  "document_id",
  "headers",
  "body",
  "idempotency",
  "preview_hash",
  "token",
  "ciphertext",
  "database_url",
  "password",
  "host",
];

describe("quote publish console events", () => {
  it("emits only allowlisted fields", () => {
    const event = quotePublishSafeEvent({
      status: 503,
      stage: "configuration_unavailable",
    });
    expect(quotePublishEventHasOnlySafeFields(event)).toBe(true);
    expect(Object.keys(event).sort()).toEqual([...QUOTE_PUBLISH_SAFE_KEYS].sort());
    expect(event.event).toBe(QUOTE_PUBLISH_EVENT);
    expect(event.status).toBe(503);
    expect(event.stage).toBe("configuration_unavailable");
    expect(event).not.toHaveProperty("request_id");
  });

  it("keeps an allowlisted SQLSTATE class and drops anything else", () => {
    expect(sqlstateCategory("08006")).toBe("08");
    expect(sqlstateCategory("42883")).toBe("42");
    expect(sqlstateCategory("P0001")).toBe("P0");
    expect(sqlstateCategory("08")).toBe("08");
    expect(sqlstateCategory("ECONNREFUSED")).toBeUndefined();
    expect(sqlstateCategory("permission denied")).toBeUndefined();
    const kept = quotePublishSafeEvent({
      status: 503,
      stage: "set_role_failed",
      sqlstate: "42501",
    });
    expect(kept.sqlstate).toBe("42");
    expect(quotePublishEventHasOnlySafeFields(kept)).toBe(true);
    const dropped = quotePublishSafeEvent({
      status: 503,
      stage: "database_connect_failed",
      sqlstate: "ECONNREFUSED",
    });
    expect(dropped.sqlstate).toBeUndefined();
    expect(Object.keys(dropped)).not.toContain("sqlstate");
  });

  it("maps transaction stages without copying error text", () => {
    expect(quotePublishDatabaseStage(new ApiTransactionError("database_connect_failed", "08006"))).toBe(
      "database_connect_failed",
    );
    expect(quotePublishDatabaseStage(new ApiTransactionError("transaction_start_failed", "25P02"))).toBe(
      "transaction_start_failed",
    );
    expect(quotePublishDatabaseStage(new ApiTransactionError("set_role_failed", "42501"))).toBe("set_role_failed");
    expect(quotePublishDatabaseStage(new ApiTransactionError("tenant_context_failed", "42501"))).toBe(
      "tenant_context_failed",
    );
    expect(quotePublishDatabaseStage(new ApiTransactionError("session_query_failed", "42883"))).toBe(
      "publish_query_failed",
    );
    expect(quotePublishDatabaseStage(new Error("function commercial.publish_quote_draft does not exist"))).toBe(
      "publish_query_failed",
    );
    expect(quotePublishSqlstate(new ApiTransactionError("session_query_failed", "42883"))).toBe("42");
    expect(JSON.stringify(new ApiTransactionError("session_query_failed", "42883"))).not.toMatch(
      /publish_quote_draft|does not exist/i,
    );
  });

  it("strips extra fields and never serializes secrets, SQL, or identities", () => {
    const lines: string[] = [];
    writeQuotePublishEvent(
      {
        event: QUOTE_PUBLISH_EVENT,
        status: 503,
        stage: "configuration_unavailable",
        message: "missing APPROVAL_TOKEN_HASH_KEY",
        stack: "Error: boom\n    at Object.<anonymous>",
        error: new Error("could not SET ROLE"),
        email: "customer@example.com",
        recipient_email: "customer@example.com",
        draft_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sqlstate: "not-a-sqlstate",
      } as never,
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0] ?? "{}");
    expect(quotePublishEventHasOnlySafeFields(parsed)).toBe(true);
    const serialized = lines[0] ?? "";
    expect(serialized).not.toMatch(/Error:|at Object|SET ROLE|customer@|Bearer |eyJ|APPROVAL_|ciphertext|token_hash/i);
    expect(serialized).not.toContain("sqlstate");
    for (const key of FORBIDDEN) {
      expect(serialized.toLowerCase()).not.toContain(`"${key}"`);
    }
  });
});
