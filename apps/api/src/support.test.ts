import { loadEnv } from "@job-to-invoice/config";
import { createJwtFixture } from "@job-to-invoice/testing";
import { randomUUID } from "node:crypto";
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
const AUTH_A = "81818181-8181-4181-8181-818181818181";
const AUTH_B = "82828282-8282-4282-8282-828282828282";

function setupBody(email: string) {
  return {
    business_name: "Support Co",
    legal_name: "Support Co LLC",
    contact_name: "Owner S",
    contact_email: email,
    contact_phone: "+12025550123",
    address: { line1: "123 Main Street", city: "Austin", state: "TX", postal_code: "78701" },
    timezone: "America/Chicago",
    timezone_confirmed: true,
    trade: "handyman",
    default_tax_bp: 0,
    tax_zero_confirmed: true,
    default_due_days: 14,
    default_terms: "Net 14.",
    skip_logo: true,
  };
}

describe("DEC13 owner support case intake", () => {
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
    await admin.query("grant api_app, worker_app to current_user");
    pool = new Pool({ connectionString: resolved.url, max: 4 });
    const fixture = await createJwtFixture();
    sign = fixture.sign;
    const env = loadEnv({
      APP_ENV: "development",
      PORTAL_ORIGIN: "http://localhost:3000",
      SUPPORT_URL: "https://support.jobtoinvoice.test/help",
      APPROVAL_TOKEN_HASH_KEY: "token-key-material-ok",
      APPROVAL_DELIVERY_ENCRYPTION_KEY: "delivery-key-material-ok",
    });
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
    const tokenA = await sign({ sub: AUTH_A, email: "owner.a@example.com" });
    await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${tokenA}` } });
    const setupA = await app.inject({
      method: "POST",
      url: "/v1/workspace",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-match": "1",
      },
      payload: setupBody("owner.a@example.com"),
    });
    if (setupA.statusCode !== 200) {
      throw new Error(`owner A setup failed: ${setupA.statusCode}`);
    }
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

  async function completeSetup(token: string, email: string) {
    await running().app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    return running().app.inject({
      method: "POST",
      url: "/v1/workspace",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-match": "1",
      },
      payload: setupBody(email),
    });
  }

  function openCase(
    token: string,
    payload: { category: string; message: string; grant_content_access?: boolean },
    key = randomUUID(),
  ) {
    return running().app.inject({
      method: "POST",
      url: "/v1/support/cases",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      payload,
    });
  }

  it("creates an owner case with server analytics and no message in telemetry", async () => {
    const token = await sign({ sub: AUTH_A, email: "owner.a@example.com" });
    const me = await running().app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.json().data.support_url).toBe("https://support.jobtoinvoice.test/help");

    const created = await openCase(token, {
      category: "billing",
      message: "I cannot start a trial after three published jobs.",
      grant_content_access: true,
    });
    expect(created.statusCode).toBe(200);
    const data = created.json().data as {
      id: string;
      category: string;
      state: string;
      content_access_granted: boolean;
      content_access_expires_at: string;
      support_url: string;
      replayed: boolean;
    };
    expect(data.category).toBe("billing");
    expect(data.state).toBe("open");
    expect(data.content_access_granted).toBe(true);
    expect(data.replayed).toBe(false);
    expect(data.support_url).toBe("https://support.jobtoinvoice.test/help");
    const expires = Date.parse(data.content_access_expires_at);
    expect(expires - Date.parse(created.json().data.created_at)).toBe(24 * 60 * 60 * 1000);

    const stored = await running().admin.query<{
      message: string;
      category: string;
      properties: { category?: string; message?: string };
      audit: { category?: string; grant_content_access?: boolean; message?: string };
    }>(
      `select c.message, c.category,
              a.safe_properties_json as properties,
              u.safe_metadata_json as audit
       from commercial.support_cases c
       join commercial.analytics_events a on a.workspace_id = c.workspace_id and a.event_name = 'support_opened'
       join commercial.audit_events u on u.entity_id = c.id and u.action = 'support_case_opened'
       where c.id = $1`,
      [data.id],
    );
    expect(stored.rows[0]?.message).toBe("I cannot start a trial after three published jobs.");
    expect(stored.rows[0]?.properties).toEqual({ category: "billing" });
    expect(stored.rows[0]?.audit).toEqual({ category: "billing", grant_content_access: true });
  });

  it("replays the same idempotency key and rejects a different body", async () => {
    const token = await sign({ sub: AUTH_A, email: "owner.a@example.com" });
    const key = randomUUID();
    const first = await openCase(
      token,
      { category: "account", message: "Please help me recover this locked workspace." },
      key,
    );
    expect(first.statusCode).toBe(200);
    const replay = await openCase(
      token,
      { category: "account", message: "Please help me recover this locked workspace." },
      key,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(replay.json().data.replayed).toBe(true);
    const mismatch = await openCase(token, { category: "other", message: "Please help me recover this locked workspace." }, key);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("rejects unknown fields, invented categories, and missing keys", async () => {
    const token = await sign({ sub: AUTH_A, email: "owner.a@example.com" });
    const unknown = await openCase(token, {
      category: "billing",
      message: "Please look at this subscription question.",
      extra: true,
    } as never);
    expect(unknown.statusCode).toBe(422);
    const invented = await openCase(token, {
      category: "staff",
      message: "Please look at this subscription question.",
    });
    expect(invented.statusCode).toBe(422);
    const noKey = await running().app.inject({
      method: "POST",
      url: "/v1/support/cases",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { category: "access", message: "The review link is no longer available." },
    });
    expect(noKey.statusCode).toBe(422);
    const unauth = await openCase("not-a-token", {
      category: "access",
      message: "The review link is no longer available.",
    });
    expect(unauth.statusCode).toBe(401);
  });

  it("keeps cases tenant-scoped and allows a deleting owner to file one", async () => {
    const tokenB = await sign({ sub: AUTH_B, email: "owner.b@example.com" });
    expect((await completeSetup(tokenB, "owner.b@example.com")).statusCode).toBe(200);
    const created = await openCase(tokenB, {
      category: "documents",
      message: "A published quote PDF will not download on this phone.",
    });
    expect(created.statusCode).toBe(200);
    const caseId = created.json().data.id as string;
    const other = await running().admin.query<{ n: number }>(
      `select count(*)::int as n
       from commercial.support_cases c
       join commercial.workspaces w on w.id = c.workspace_id
       join identity.app_users u on u.id = w.owner_user_id
       where c.id = $1 and u.auth_user_id = $2`,
      [caseId, AUTH_A],
    );
    expect(other.rows[0]?.n).toBe(0);

    await running().admin.query("update identity.app_users set status = 'deleting' where auth_user_id = $1", [AUTH_B]);
    const whileDeleting = await openCase(tokenB, {
      category: "account",
      message: "Deletion is in progress and I need a status update.",
    });
    expect(whileDeleting.statusCode).toBe(200);
  });
});
