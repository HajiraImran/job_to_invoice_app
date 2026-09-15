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
const AUTH_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AUTH_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const KEY_1 = "11111111-1111-4111-8111-111111111111";
const KEY_2 = "22222222-2222-4222-8222-222222222222";

function setupBody(overrides: Record<string, unknown> = {}) {
  return {
    business_name: "José's Handyman",
    legal_name: "José's Handyman LLC",
    contact_name: "José García",
    contact_email: "Owner.Plus+tag@Example.COM",
    contact_phone: "+12025550123",
    address: {
      line1: "123 Main Street",
      city: "Austin",
      state: "TX",
      postal_code: "78701",
    },
    timezone: "America/Chicago",
    timezone_confirmed: true,
    trade: "handyman",
    default_tax_bp: 0,
    tax_zero_confirmed: true,
    default_due_days: 14,
    default_terms: "Net 14.",
    skip_logo: true,
    ...overrides,
  };
}

describe("workspace setup API", () => {
  let stop: (() => Promise<void>) | undefined;
  let pool: Pool | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  let sign: Awaited<ReturnType<typeof createJwtFixture>>["sign"];
  let admin: Client | undefined;

  beforeAll(async () => {
    const resolved = await resolveMigrationsUrl();
    stop = resolved.stop;
    admin = new Client({ connectionString: resolved.url });
    await admin.connect();
    await applyCleanMigrations(admin, repoRoot);
    await admin.query("grant api_app to current_user");
    pool = new Pool({ connectionString: resolved.url, max: 4 });
    const fixture = await createJwtFixture();
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

  async function me(token: string) {
    return running().app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function complete(
    token: string,
    body: unknown,
    headers?: Record<string, string>,
  ) {
    return running().app.inject({
      method: "POST",
      url: "/v1/workspace",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY_1,
        "if-match": "1",
        ...headers,
      },
      payload: body as object,
    });
  }

  it("completes setup, assigns setup_completed_at, and does not create a second workspace", async () => {
    const token = await sign({ sub: AUTH_C, email: "Owner.C@Example.com" });
    const before = await me(token);
    expect(before.statusCode).toBe(200);
    expect(before.json().data.workspace.setup_completed).toBe(false);
    expect(before.json().data.workspace.version).toBe(1);
    const response = await complete(token, setupBody());
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.workspace.setup_completed).toBe(true);
    expect(data.workspace.version).toBe(2);
    expect(data.workspace.id).toBe(before.json().data.workspace.id);
    const row = await running().admin.query(
      `select setup_completed_at, currency, version, default_tax_bp, timezone
       from commercial.workspaces where owner_user_id = $1`,
      [data.user.id],
    );
    const count = await running().admin.query(
      "select count(*)::int as n from commercial.workspaces where owner_user_id = $1",
      [data.user.id],
    );
    expect(count.rows[0]?.n).toBe(1);
    expect(row.rows[0]?.setup_completed_at).toBeTruthy();
    expect(row.rows[0]?.currency).toBe("USD");
    expect(row.rows[0]?.default_tax_bp).toBe(0);
    expect(row.rows[0]?.timezone).toBe("America/Chicago");
    const analytics = await running().admin.query(
      `select event_name, safe_properties_json from commercial.analytics_events
       where workspace_id = $1 and event_name = 'onboarding_completed'`,
      [data.workspace.id],
    );
    expect(analytics.rows).toHaveLength(1);
    expect(JSON.stringify(analytics.rows[0]?.safe_properties_json)).not.toMatch(/José|Austin|Example\.COM|12025550123/i);
    expect(analytics.rows[0]?.safe_properties_json).toMatchObject({ trade: "handyman" });
    const allowances = await running().admin.query(
      "select count(*)::int as n from commercial.job_allowances where workspace_id = $1",
      [data.workspace.id],
    );
    expect(allowances.rows[0]?.n).toBe(1);
    const audit = await running().admin.query(
      "select action, safe_metadata_json from commercial.audit_events where workspace_id = $1",
      [data.workspace.id],
    );
    expect(audit.rows[0]?.action).toBe("workspace_setup_completed");
    expect(JSON.stringify(audit.rows[0]?.safe_metadata_json)).not.toMatch(/José|Austin/i);
  });

  it("replays the same idempotency key without a second mutation", async () => {
    const token = await sign({ sub: AUTH_C, email: "Owner.C@Example.com" });
    const first = await complete(token, setupBody());
    const second = await complete(token, setupBody());
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.workspace.version).toBe(first.json().data.workspace.version);
    const versions = await running().admin.query(
      "select version from commercial.workspaces where id = $1",
      [first.json().data.workspace.id],
    );
    expect(versions.rows[0]?.version).toBe(2);
  });

  it("returns 409 when the same idempotency key is reused with a different body", async () => {
    const token = await sign({ sub: AUTH_C, email: "Owner.C@Example.com" });
    const mismatch = await complete(token, setupBody({ business_name: "Other Name" }));
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("rejects invalid fields, unknown fields, and missing headers with the standard envelope", async () => {
    const token = await sign({ sub: AUTH_D, email: "owner.d@example.com" });
    await me(token);
    const invalid = await complete(token, setupBody({ business_name: "A" }), { "idempotency-key": KEY_2 });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe("VALIDATION_FAILED");
    expect(invalid.json().error.field_errors.some((item: { field: string }) => item.field === "business_name")).toBe(
      true,
    );
    expect(JSON.stringify(invalid.json())).not.toMatch(/sql|stack|postgres/i);
    const unknown = await complete(token, setupBody({ owner_user_id: AUTH_D }), { "idempotency-key": KEY_2 });
    expect(unknown.statusCode).toBe(422);
    const injected = await complete(
      token,
      setupBody({ workspace_id: "11111111-1111-4111-8111-111111111111" }),
      { "idempotency-key": KEY_2 },
    );
    expect(injected.statusCode).toBe(422);
    const missingKey = await running().app.inject({
      method: "POST",
      url: "/v1/workspace",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "if-match": "1" },
      payload: setupBody(),
    });
    expect(missingKey.statusCode).toBe(422);
    const missingMatch = await running().app.inject({
      method: "POST",
      url: "/v1/workspace",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY_2,
      },
      payload: setupBody(),
    });
    expect(missingMatch.statusCode).toBe(422);
  });

  it("rejects missing authentication and staff tokens", async () => {
    const unauth = await running().app.inject({
      method: "POST",
      url: "/v1/workspace",
      headers: { "content-type": "application/json", "idempotency-key": KEY_2, "if-match": "1" },
      payload: setupBody(),
    });
    expect(unauth.statusCode).toBe(401);
    const staff = await sign({ sub: AUTH_D, email: "owner.d@example.com", role: "staff" });
    const forbidden = await complete(staff, setupBody(), { "idempotency-key": KEY_2 });
    expect(forbidden.statusCode).toBe(401);
  });

  it("rejects a stale workspace version", async () => {
    const token = await sign({ sub: AUTH_D, email: "owner.d@example.com" });
    await me(token);
    const stale = await complete(token, setupBody(), { "idempotency-key": KEY_2, "if-match": "9" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("VERSION_CONFLICT");
  });

  it("rejects mutations for a suspended account", async () => {
    const token = await sign({ sub: AUTH_D, email: "owner.d@example.com" });
    const meBody = (await me(token)).json().data;
    await running().admin.query("update identity.app_users set status = 'suspended' where id = $1", [meBody.user.id]);
    const response = await complete(token, setupBody(), { "idempotency-key": KEY_2 });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ACCOUNT_SUSPENDED");
    await running().admin.query("update identity.app_users set status = 'active' where id = $1", [meBody.user.id]);
  });

  it("rejects client onboarding_completed analytics", async () => {
    const token = await sign({ sub: AUTH_D, email: "owner.d@example.com" });
    const response = await running().app.inject({
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
            event_name: "onboarding_completed",
            schema_version: 1,
            occurred_at: new Date().toISOString(),
            properties: { trade: "handyman" },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
  });
});
