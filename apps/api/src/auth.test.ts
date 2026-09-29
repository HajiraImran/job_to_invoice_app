import { loadEnv } from "@job-to-invoice/config";
import { createJwtFixture } from "@job-to-invoice/testing";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error test harness is outside the API package
import { applyCleanMigrations } from "../../scripts/db-admin.mjs";
// @ts-expect-error test harness is outside the API package
import { resolveMigrationsUrl } from "../../scripts/postgres-url.mjs";
import { buildApp } from "./app.ts";
import { createJwtVerifier } from "./jwt.ts";
import { ownerMeEventHasOnlySafeFields, type OwnerMeSafeEvent } from "./me-log.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const AUTH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("owner authentication API", () => {
  let stop: (() => Promise<void>) | undefined;
  let pool: Pool | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  let sign: Awaited<ReturnType<typeof createJwtFixture>>["sign"];
  let fixture: Awaited<ReturnType<typeof createJwtFixture>>;
  let admin: Client | undefined;

  beforeAll(async () => {
    const resolved = await resolveMigrationsUrl();
    stop = resolved.stop;
    admin = new Client({ connectionString: resolved.url });
    await admin.connect();
    await applyCleanMigrations(admin, repoRoot);
    await admin.query("grant api_app to current_user");
    pool = new Pool({ connectionString: resolved.url, max: 4 });
    fixture = await createJwtFixture();
    sign = fixture.sign;
    const env = loadEnv({ APP_ENV: "development", PORTAL_ORIGIN: "http://localhost:3000" });
    app = buildApp({
      env,
      pool,
      logOwnerMe: () => undefined,
      verifyJwt: createJwtVerifier({
        issuer: fixture.issuer,
        audience: fixture.audience,
        jwks: fixture.jwks,
      }),
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.end();
    await stop?.();
  });

  function running() {
    if (!app || !admin) {
      throw new Error("API test app did not start");
    }
    return { app, admin };
  }

  async function me(token?: string, extraHeaders?: Record<string, string>) {
    return running().app.inject({
      method: "GET",
      url: "/v1/me",
      headers: token ? { authorization: `Bearer ${token}`, ...extraHeaders } : extraHeaders,
    });
  }

  it("serves health without exposing tokens", async () => {
    const response = await running().app.inject({ method: "GET", url: "/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("ok");
    expect(JSON.stringify(response.json())).not.toMatch(/Bearer |eyJ/);
  });

  it("rejects missing JWT", async () => {
    const response = await me();
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("rejects an invalid JWT", async () => {
    const response = await me("not-a-jwt");
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTHENTICATION_FAILED");
    expect(JSON.stringify(response.json())).not.toContain("not-a-jwt");
  });

  it("rejects an expired JWT", async () => {
    const token = await sign({ sub: AUTH_A, email: "a@example.com", expired: true });
    const response = await me(token);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects an incorrect issuer", async () => {
    const token = await sign({
      sub: AUTH_A,
      email: "a@example.com",
      issuer: "https://other.example.invalid/auth/v1",
    });
    const response = await me(token);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects an incorrect audience", async () => {
    const token = await sign({ sub: AUTH_A, email: "a@example.com", audience: "staff" });
    const response = await me(token);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects a JWT without an email or with an invalid subject", async () => {
    const missingEmail = await me(await sign({ sub: AUTH_A, email: "" }));
    expect(missingEmail.statusCode).toBe(401);
    expect(missingEmail.json().error.code).toBe("AUTHENTICATION_FAILED");
    const invalidSub = await me(await sign({ sub: "not-a-uuid", email: "a@example.com" }));
    expect(invalidSub.statusCode).toBe(401);
    expect(invalidSub.json().error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects a staff role on owner routes", async () => {
    const token = await sign({ sub: AUTH_A, email: "a@example.com", role: "staff" });
    const response = await me(token);
    expect(response.statusCode).toBe(401);
  });

  it("provisions a new owner once and returns the same workspace on retry", async () => {
    const token = await sign({ sub: AUTH_A, email: "Owner.A@Example.com" });
    const first = await me(token);
    expect(first.statusCode).toBe(200);
    const created = first.json().data;
    expect(created.user.status).toBe("active");
    expect(created.workspace.setup_completed).toBe(false);
    expect(created.first_sign_in).toBe(true);
    const second = await me(token);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.user.id).toBe(created.user.id);
    expect(second.json().data.workspace.id).toBe(created.workspace.id);
    expect(second.json().data.first_sign_in).toBe(false);
    const count = await running().admin.query("select count(*)::int as n from commercial.workspaces where owner_user_id = $1", [
      created.user.id,
    ]);
    expect(count.rows[0]?.n).toBe(1);
    const signup = await running().admin.query(
      `select event_name, safe_properties_json, pseudonymous_owner_id
       from commercial.analytics_events
       where workspace_id = $1 and event_name = 'signup_verified'`,
      [created.workspace.id],
    );
    expect(signup.rows).toHaveLength(1);
    expect(signup.rows[0]?.event_name).toBe("signup_verified");
    const properties = signup.rows[0]?.safe_properties_json;
    expect(typeof properties === "string" ? JSON.parse(properties) : properties).toEqual({
      acquisition_source: "unknown",
    });
    expect(JSON.stringify(signup.rows[0])).not.toMatch(/Owner\.A@|example\.com/i);
    expect(signup.rows[0]?.pseudonymous_owner_id).toBe(created.analytics_alias_id);
  });

  it("does not let workspace B appear in workspace A responses", async () => {
    const tokenA = await sign({ sub: AUTH_A, email: "Owner.A@Example.com" });
    const tokenB = await sign({ sub: AUTH_B, email: "owner.b@example.com" });
    const a = (await me(tokenA)).json().data;
    const b = (await me(tokenB)).json().data;
    expect(a.workspace.id).not.toBe(b.workspace.id);
    expect(a.user.id).not.toBe(b.user.id);
  });

  it("rejects mutations for a suspended account", async () => {
    const token = await sign({ sub: AUTH_A, email: "Owner.A@Example.com" });
    const meBody = (await me(token)).json().data;
    await running().admin.query("update identity.app_users set status = 'suspended' where id = $1", [meBody.user.id]);
    const stillReads = await me(token);
    expect(stillReads.statusCode).toBe(200);
    expect(stillReads.json().data.user.status).toBe("suspended");
    const mutation = await running().app.inject({
      method: "POST",
      url: "/v1/analytics/batch",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "11111111-1111-4111-8111-111111111111",
        "content-type": "application/json",
      },
      payload: {
        events: [
          {
            event_id: "22222222-2222-4222-8222-222222222222",
            event_name: "support_opened",
            schema_version: 1,
            occurred_at: new Date().toISOString(),
            properties: { category: "billing" },
          },
        ],
      },
    });
    expect(mutation.statusCode).toBe(403);
    expect(mutation.json().error.code).toBe("ACCOUNT_SUSPENDED");
    await running().admin.query("update identity.app_users set status = 'active' where id = $1", [meBody.user.id]);
  });

  it("rejects a deleted account on /v1/me", async () => {
    const token = await sign({ sub: AUTH_B, email: "owner.b@example.com" });
    const meBody = (await me(token)).json().data as { user: { id: string } };
    await running().admin.query("update identity.app_users set status = 'deleted' where id = $1", [meBody.user.id]);
    const response = await me(token);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ACCOUNT_DELETING");
    await running().admin.query("update identity.app_users set status = 'active' where id = $1", [meBody.user.id]);
  });

  it("rejects client analytics that enumerate emails or server-only events", async () => {
    const token = await sign({ sub: AUTH_B, email: "owner.b@example.com" });
    const emailLeak = await running().app.inject({
      method: "POST",
      url: "/v1/analytics/batch",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "33333333-3333-4333-8333-333333333333",
        "content-type": "application/json",
      },
      payload: {
        events: [
          {
            event_id: "44444444-4444-4444-8444-444444444444",
            event_name: "support_opened",
            schema_version: 1,
            occurred_at: new Date().toISOString(),
            properties: { email: "owner.b@example.com" },
          },
        ],
      },
    });
    expect(emailLeak.statusCode).toBe(422);
    const serverOnly = await running().app.inject({
      method: "POST",
      url: "/v1/analytics/batch",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "55555555-5555-4555-8555-555555555555",
        "content-type": "application/json",
      },
      payload: {
        events: [
          {
            event_id: "66666666-6666-4666-8666-666666666666",
            event_name: "signup_verified",
            schema_version: 1,
            occurred_at: new Date().toISOString(),
            properties: { acquisition_source: "unknown" },
          },
        ],
      },
    });
    expect(serverOnly.statusCode).toBe(422);
  });

  it("returns 503 when provisioning throws after a valid JWT", async () => {
    const token = await sign({ sub: AUTH_A, email: "a@example.com" });
    const env = loadEnv({ APP_ENV: "development", PORTAL_ORIGIN: "http://localhost:3000" });
    const events: OwnerMeSafeEvent[] = [];
    const failing = buildApp({
      env,
      pool: {
        connect: async () => {
          throw new Error("could not SET ROLE");
        },
      } as unknown as Pool,
      logOwnerMe: (event) => {
        events.push(event);
      },
      verifyJwt: createJwtVerifier({
        issuer: fixture.issuer,
        audience: fixture.audience,
        jwks: fixture.jwks,
      }),
    });
    const response = await failing.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("UNAVAILABLE");
    const body = JSON.stringify(response.json());
    expect(body).not.toMatch(/SET ROLE/i);
    expect(body).not.toContain(token);
    expect(body).not.toContain("a@example.com");
    expect(events.map((event) => event.stage)).toEqual([
      "request_received",
      "jwt_verified",
      "database_connect_failed",
    ]);
    expect(events.at(-1)?.status).toBe(503);
    for (const event of events) {
      expect(ownerMeEventHasOnlySafeFields(event)).toBe(true);
    }
    const logged = JSON.stringify(events);
    expect(logged).not.toMatch(/SET ROLE|Error:|at Object|stack|a@example.com/i);
    expect(logged).not.toContain(token);
    await failing.close();
  });

  it("keeps missing and invalid JWTs as 401", async () => {
    const missing = await me();
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("AUTHENTICATION_REQUIRED");
    const invalid = await me("not-a-jwt");
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error.code).toBe("AUTHENTICATION_FAILED");
    expect(JSON.stringify(invalid.json())).not.toContain("not-a-jwt");
  });

  it("emits allowlisted /v1/me console events without changing status", async () => {
    const events: OwnerMeSafeEvent[] = [];
    const env = loadEnv({ APP_ENV: "development", PORTAL_ORIGIN: "http://localhost:3000" });
    const loggedApp = buildApp({
      env,
      pool,
      logOwnerMe: (event) => {
        events.push(event);
      },
      verifyJwt: createJwtVerifier({
        issuer: fixture.issuer,
        audience: fixture.audience,
        jwks: fixture.jwks,
      }),
    });
    const missing = await loggedApp.inject({ method: "GET", url: "/v1/me" });
    expect(missing.statusCode).toBe(401);
    expect(events.map((event) => event.stage)).toEqual(["request_received", "jwt_rejected"]);
    expect(events.at(-1)?.status).toBe(401);

    events.length = 0;
    const invalid = await loggedApp.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(invalid.statusCode).toBe(401);
    expect(events.map((event) => event.stage)).toEqual(["request_received", "jwt_rejected"]);
    expect(JSON.stringify(events)).not.toContain("not-a-jwt");

    events.length = 0;
    const health = await loggedApp.inject({ method: "GET", url: "/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(events).toEqual([]);

    events.length = 0;
    const token = await sign({ sub: AUTH_B, email: "owner.b@example.com" });
    const ok = await loggedApp.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(events.map((event) => event.stage)).toEqual(["request_received", "jwt_verified", "response_sent"]);
    expect(events.at(-1)?.status).toBe(200);
    for (const event of events) {
      expect(ownerMeEventHasOnlySafeFields(event)).toBe(true);
      expect(Object.keys(event).sort()).toEqual(["event", "request_id", "stage", "status"]);
    }
    const logged = JSON.stringify(events);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain("owner.b@example.com");
    expect(logged).not.toMatch(/Error:|stack|Bearer |authorization|SET ROLE|DATABASE_URL/i);
    await loggedApp.close();
  });

  it("does not change /v1/me status when diagnostics throw", async () => {
    const env = loadEnv({ APP_ENV: "development", PORTAL_ORIGIN: "http://localhost:3000" });
    const noisy = buildApp({
      env,
      pool,
      logOwnerMe: () => {
        throw new Error("logger boom");
      },
      verifyJwt: createJwtVerifier({
        issuer: fixture.issuer,
        audience: fixture.audience,
        jwks: fixture.jwks,
      }),
    });
    const invalid = await noisy.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error.code).toBe("AUTHENTICATION_FAILED");
    const token = await sign({ sub: AUTH_A, email: "a@example.com" });
    const failingPool = buildApp({
      env,
      pool: {
        connect: async () => {
          throw new Error("could not SET ROLE");
        },
      } as unknown as Pool,
      logOwnerMe: () => {
        throw new Error("logger boom");
      },
      verifyJwt: createJwtVerifier({
        issuer: fixture.issuer,
        audience: fixture.audience,
        jwks: fixture.jwks,
      }),
    });
    const unavailable = await failingPool.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe("UNAVAILABLE");
    await noisy.close();
    await failingPool.close();
  });

  it("emits a distinct /v1/me stage for each database failure without raw errors", async () => {
    const env = loadEnv({ APP_ENV: "development", PORTAL_ORIGIN: "http://localhost:3000" });
    const token = await sign({ sub: AUTH_A, email: "a@example.com" });

    async function probe(stage: string, poolImpl: Pool, sqlstate?: string, code = "UNAVAILABLE") {
      const events: OwnerMeSafeEvent[] = [];
      const app = buildApp({
        env,
        pool: poolImpl,
        logOwnerMe: (event) => {
          events.push(event);
        },
        verifyJwt: createJwtVerifier({
          issuer: fixture.issuer,
          audience: fixture.audience,
          jwks: fixture.jwks,
        }),
      });
      const response = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe(code);
      expect(events.map((event) => event.stage)).toEqual(["request_received", "jwt_verified", stage]);
      const failure = events.at(-1);
      expect(failure?.status).toBe(503);
      expect(failure?.sqlstate).toBe(sqlstate);
      const logged = JSON.stringify(events);
      const body = JSON.stringify(response.json());
      expect(logged).not.toMatch(/permission denied|does not exist|SET ROLE|host\.example|Error:|at Object/i);
      expect(body).not.toMatch(/permission denied|does not exist|SET ROLE|host\.example|Error:/i);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain("a@example.com");
      await app.close();
    }

    function pgError(code: string, message: string): Error {
      const error = new Error(message);
      (error as Error & { code: string }).code = code;
      return error;
    }

    function poolFrom(script: {
      connect?: unknown;
      begin?: unknown;
      setRole?: unknown;
      query?: unknown;
      rows?: unknown[];
    }): Pool {
      return {
        connect: async () => {
          if (script.connect) {
            throw script.connect;
          }
          const run = async (sql: string) => {
            const normalized = sql.trim().toLowerCase();
            if (normalized === "begin") {
              if (script.begin) {
                throw script.begin;
              }
              return { rows: [] };
            }
            if (normalized === "set local role api_app") {
              if (script.setRole) {
                throw script.setRole;
              }
              return { rows: [] };
            }
            if (normalized === "commit" || normalized === "rollback") {
              return { rows: [] };
            }
            if (script.query) {
              throw script.query;
            }
            return { rows: script.rows ?? [] };
          };
          return {
            query: async (sql: string) => {
              let last: { rows: unknown[] } = { rows: [] };
              for (const statement of sql.split(";")) {
                last = await run(statement);
              }
              return last;
            },
            release: () => undefined,
          };
        },
      } as unknown as Pool;
    }

    await probe(
      "database_connect_failed",
      poolFrom({ connect: pgError("08006", "could not connect to host.example.invalid") }),
      "08006",
      "DATABASE_UNAVAILABLE",
    );
    await probe(
      "database_connect_failed",
      poolFrom({ connect: new Error("timeout exceeded when trying to connect") }),
      "08006",
      "DATABASE_TIMEOUT",
    );
    await probe("transaction_start_failed", poolFrom({ begin: pgError("25P02", "current transaction is aborted") }), "25P02");
    await probe(
      "set_role_failed",
      poolFrom({ setRole: pgError("42501", 'permission denied to set role "api_app"') }),
      "42501",
    );
    await probe(
      "provision_owner_failed",
      poolFrom({ query: pgError("42883", "function identity.provision_owner(uuid, text, text) does not exist") }),
      "42883",
    );
    await probe("bootstrap_query_failed", poolFrom({ rows: [] }));
  });
});
