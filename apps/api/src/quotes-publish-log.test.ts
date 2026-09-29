import { loadEnv } from "@job-to-invoice/config";
import { createJwtFixture } from "@job-to-invoice/testing";
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { createJwtVerifier } from "./jwt.ts";
import {
  quotePublishEventHasOnlySafeFields,
  type QuotePublishSafeEvent,
} from "./publish-log.ts";

const DRAFT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTH_SUB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HASH = "ab".repeat(32);

const FORBIDDEN = /customer@|Bearer |eyJ|APPROVAL_|token_hash|ciphertext|DATABASE_URL|idempotency-key|preview_hash/i;

function unusedPool(): Pool {
  return {
    connect: async () => {
      throw Object.assign(new Error("pool must not be acquired"), { code: "XX000" });
    },
  } as unknown as Pool;
}

function connectFailPool(): Pool {
  return {
    connect: async () => {
      throw Object.assign(new Error("could not connect to host.example.invalid"), { code: "08006" });
    },
  } as unknown as Pool;
}

function queryFailPool(code: string, message: string): Pool {
  return {
    connect: async () => {
      const client = {
        query: async (sql: string) => {
          for (const statement of sql.split(";")) {
            const normalized = statement.trim().toLowerCase();
            if (normalized === "begin" || normalized === "set local role api_app" || normalized === "commit") {
              continue;
            }
            if (normalized === "rollback") {
              continue;
            }
            throw Object.assign(new Error(message), { code });
          }
          return { rows: [] };
        },
        release: () => undefined,
      };
      return client as unknown as PoolClient;
    },
  } as unknown as Pool;
}

describe("quote publish observability", () => {
  const apps: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      await app?.close();
    }
  });

  async function publishApp(input: {
    env?: Record<string, string>;
    pool?: Pool;
    events: QuotePublishSafeEvent[];
  }) {
    const fixture = await createJwtFixture();
    const env = loadEnv({
      APP_ENV: "development",
      PORTAL_ORIGIN: "http://localhost:3000",
      ...input.env,
    });
    const app = buildApp({
      env,
      pool: input.pool,
      logOwnerMe: () => undefined,
      logQuotePublish: (event) => input.events.push(event),
      verifyJwt: createJwtVerifier({
        issuer: fixture.issuer,
        audience: fixture.audience,
        jwks: fixture.jwks,
      }),
    });
    apps.push(app);
    return { app, sign: fixture.sign };
  }

  async function postPublish(
    app: ReturnType<typeof buildApp>,
    token: string,
    extra?: { key?: string; hash?: string; email?: string },
  ) {
    return app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": extra?.key ?? KEY,
        "if-match": "4",
      },
      payload: {
        preview_hash: extra?.hash ?? HASH,
        recipient_email: extra?.email ?? "customer@example.com",
      },
    });
  }

  it("registers POST /v1/drafts/:draftId/publish and returns 401 rather than 404", async () => {
    const events: QuotePublishSafeEvent[] = [];
    const { app } = await publishApp({ pool: unusedPool(), events });
    const response = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/publish`,
      headers: { "content-type": "application/json" },
      payload: { preview_hash: HASH, recipient_email: "customer@example.com" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(events.map((event) => event.stage)).toEqual(["request_received", "jwt_rejected"]);
    expect(JSON.stringify(events)).not.toMatch(FORBIDDEN);
  });

  it("returns 503 configuration_unavailable when approval secrets are missing, before connecting", async () => {
    const events: QuotePublishSafeEvent[] = [];
    const { app, sign } = await publishApp({ pool: unusedPool(), events });
    const token = await sign({ sub: AUTH_SUB, email: "owner.p@example.com" });
    const response = await postPublish(app, token);
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("UNAVAILABLE");
    expect(response.json().error.message).toBe("Service unavailable.");
    expect(events.map((event) => event.stage)).toEqual([
      "request_received",
      "jwt_verified",
      "configuration_unavailable",
    ]);
    for (const event of events) {
      expect(quotePublishEventHasOnlySafeFields(event)).toBe(true);
    }
    expect(JSON.stringify(events)).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(events)).not.toContain(DRAFT_ID);
    expect(JSON.stringify(events)).not.toContain(AUTH_SUB);
  });

  it("returns 503 configuration_unavailable when approval secrets are present but unusable", async () => {
    const events: QuotePublishSafeEvent[] = [];
    const { app, sign } = await publishApp({
      env: {
        APPROVAL_TOKEN_HASH_KEY: "short",
        APPROVAL_DELIVERY_ENCRYPTION_KEY: "short",
      },
      pool: unusedPool(),
      events,
    });
    const token = await sign({ sub: AUTH_SUB, email: "owner.p@example.com" });
    const response = await postPublish(app, token);
    expect(response.statusCode).toBe(503);
    expect(events.map((event) => event.stage)).toEqual([
      "request_received",
      "jwt_verified",
      "configuration_unavailable",
    ]);
    expect(JSON.stringify(events)).not.toMatch(/short|APPROVAL_/);
  });

  it("emits validation_failed without a database connection", async () => {
    const events: QuotePublishSafeEvent[] = [];
    const { app, sign } = await publishApp({
      env: {
        APPROVAL_TOKEN_HASH_KEY: "token-key-material-ok",
        APPROVAL_DELIVERY_ENCRYPTION_KEY: "delivery-key-material-ok",
      },
      pool: unusedPool(),
      events,
    });
    const token = await sign({ sub: AUTH_SUB, email: "owner.p@example.com" });
    const response = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "if-match": "4",
      },
      payload: { preview_hash: HASH, recipient_email: "customer@example.com" },
    });
    expect(response.statusCode).toBe(422);
    expect(events.map((event) => event.stage)).toEqual(["request_received", "jwt_verified", "validation_failed"]);
  });

  it("classifies database_connect_failed with an allowlisted SQLSTATE category", async () => {
    const events: QuotePublishSafeEvent[] = [];
    const { app, sign } = await publishApp({
      env: {
        APPROVAL_TOKEN_HASH_KEY: "token-key-material-ok",
        APPROVAL_DELIVERY_ENCRYPTION_KEY: "delivery-key-material-ok",
      },
      pool: connectFailPool(),
      events,
    });
    const token = await sign({ sub: AUTH_SUB, email: "owner.p@example.com" });
    const response = await postPublish(app, token);
    expect(response.statusCode).toBe(503);
    expect(events.map((event) => event.stage)).toEqual([
      "request_received",
      "jwt_verified",
      "database_connect_failed",
    ]);
    expect(events.at(-1)?.sqlstate).toBe("08");
    expect(JSON.stringify(events)).not.toMatch(/host\.example|could not connect/i);
  });

  it("classifies publish_query_failed without logging SQL", async () => {
    const events: QuotePublishSafeEvent[] = [];
    const { app, sign } = await publishApp({
      env: {
        APPROVAL_TOKEN_HASH_KEY: "token-key-material-ok",
        APPROVAL_DELIVERY_ENCRYPTION_KEY: "delivery-key-material-ok",
      },
      pool: queryFailPool("42883", "function commercial.publish_quote_draft(uuid) does not exist"),
      events,
    });
    const token = await sign({ sub: AUTH_SUB, email: "owner.p@example.com" });
    const response = await postPublish(app, token);
    expect(response.statusCode).toBe(503);
    expect(events.map((event) => event.stage)).toEqual([
      "request_received",
      "jwt_verified",
      "publish_query_failed",
    ]);
    expect(events.at(-1)?.sqlstate).toBe("42");
    expect(JSON.stringify(events)).not.toMatch(/publish_quote_draft|does not exist|select /i);
  });
});
