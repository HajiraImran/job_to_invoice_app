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
  });

  it("rejects an incorrect audience", async () => {
    const token = await sign({ sub: AUTH_A, email: "a@example.com", audience: "staff" });
    const response = await me(token);
    expect(response.statusCode).toBe(401);
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
});
