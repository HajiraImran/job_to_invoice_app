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

function setupBody(email: string) {
  return {
    business_name: "Export Co",
    legal_name: "Export Co LLC",
    contact_name: "Owner E",
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

describe("EXP01/EXP02 owner export", () => {
  let stop: (() => Promise<void>) | undefined;
  let pool: Pool | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  let sign: Awaited<ReturnType<typeof createJwtFixture>>["sign"];
  let admin: Client | undefined;
  let nowSec = Math.floor(Date.now() / 1000);

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
      APPROVAL_TOKEN_HASH_KEY: "token-key-material-ok",
      APPROVAL_DELIVERY_ENCRYPTION_KEY: "delivery-key-material-ok",
    });
    app = buildApp({
      env,
      pool,
      logOwnerMe: () => undefined,
      documentsStore: {
        presignGet: async (key, expiresIn) => `https://files.example.test/${key}?exp=${expiresIn ?? 300}`,
      },
      verifyJwt: createJwtVerifier({
        issuer: fixture.issuer,
        audience: fixture.audience,
        jwks: fixture.jwks,
      }),
      nowSec: () => nowSec,
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

  async function tokenFor(sub: string, email: string) {
    nowSec = Math.floor(Date.now() / 1000);
    return sign({ sub, email, authTime: nowSec });
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

  async function exportGrant(token: string) {
    return running().app.inject({
      method: "POST",
      url: "/v1/account/action-grants",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { action: "export" },
    });
  }

  it("issues export grants, reuses a 24h bundle, caps two new exports, and isolates tenants (QA56)", async () => {
    const { app: api, admin: db } = running();
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const emailA = "owner.export.a@example.com";
    const emailB = "owner.export.b@example.com";
    const tokenA = await tokenFor(ownerA, emailA);
    const tokenB = await tokenFor(ownerB, emailB);
    expect((await completeSetup(tokenA, emailA)).statusCode).toBe(200);
    expect((await completeSetup(tokenB, emailB)).statusCode).toBe(200);

    const stale = await sign({
      sub: ownerA,
      email: emailA,
      authTime: Math.floor(Date.now() / 1000) - 400,
    });
    expect(
      (
        await api.inject({
          method: "POST",
          url: "/v1/account/action-grants",
          headers: { authorization: `Bearer ${stale}`, "content-type": "application/json" },
          payload: { action: "export" },
        })
      ).statusCode,
    ).toBe(403);

    const deletion = await api.inject({
      method: "POST",
      url: "/v1/account/action-grants",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      payload: { action: "deletion" },
    });
    expect(deletion.statusCode).toBe(422);

    const missingGrant = await api.inject({
      method: "POST",
      url: "/v1/exports",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {},
    });
    expect(missingGrant.statusCode).toBe(403);
    expect(missingGrant.json().error.code).toBe("ACTION_GRANT_REQUIRED");

    const grant1 = await exportGrant(tokenA);
    expect(grant1.statusCode).toBe(201);
    const first = await api.inject({
      method: "POST",
      url: "/v1/exports",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-action-grant": grant1.json().data.grant,
      },
      payload: {},
    });
    expect(first.statusCode).toBe(202);
    const firstId = first.json().data.id as string;
    expect(first.json().data.status).toBe("queued");
    expect(first.json().data.reused).toBe(false);
    const latest = await api.inject({
      method: "GET",
      url: "/v1/exports/latest",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().data.export.id).toBe(firstId);

    const grantReuse = await exportGrant(tokenA);
    const reused = await api.inject({
      method: "POST",
      url: "/v1/exports",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-action-grant": grantReuse.json().data.grant,
      },
      payload: {},
    });
    expect(reused.statusCode).toBe(202);
    expect(reused.json().data.id).toBe(firstId);
    expect(reused.json().data.reused).toBe(true);

    const grantNewer = await exportGrant(tokenA);
    const newer = await api.inject({
      method: "POST",
      url: "/v1/exports",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-action-grant": grantNewer.json().data.grant,
      },
      payload: { newer: true },
    });
    expect(newer.statusCode).toBe(202);
    expect(newer.json().data.id).not.toBe(firstId);
    expect(newer.json().data.reused).toBe(false);

    const grantCap = await exportGrant(tokenA);
    const capped = await api.inject({
      method: "POST",
      url: "/v1/exports",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-action-grant": grantCap.json().data.grant,
      },
      payload: { newer: true },
    });
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error.code).toBe("EXPORT_LIMIT");

    const foreign = await api.inject({
      method: "GET",
      url: `/v1/exports/${firstId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(foreign.statusCode).toBe(404);

    await db.query("select * from commercial.claim_build_export()");
    await db.query(
      `select commercial.complete_export($1::uuid, $2, $3, $4::bigint, $5::jsonb, $6::integer, $7::integer)`,
      [firstId, `${firstId}/export-part-001.zip`, "ab".repeat(32), 128, JSON.stringify({ schema_version: 1 }), 0, 1],
    );

    const ready = await api.inject({
      method: "GET",
      url: `/v1/exports/${firstId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().data.status).toBe("ready");
    expect(ready.json().data.download_available).toBe(true);

    const download = await api.inject({
      method: "GET",
      url: `/v1/exports/${firstId}/download`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.json().data.url).toContain("export-part-001.zip");
    expect(download.json().data.url).not.toMatch(/INV-000001/);

    const payload = await db.query<{ export_workspace_payload: { jobs?: Array<Record<string, unknown>> } }>(
      `select commercial.export_workspace_payload(w.workspace_id, now())
       from commercial.workspaces w
       join identity.app_users u on u.id = w.owner_user_id
       where u.auth_user_id = $1`,
      [ownerA],
    );
    const snapshot = payload.rows[0]?.export_workspace_payload;
    expect(JSON.stringify(snapshot)).not.toContain("internal_notes");
  });
});
