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
    business_name: "Delete Co",
    legal_name: "Delete Co LLC",
    contact_name: "Owner D",
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

describe("PRV03/PRV06 account deletion", () => {
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
    await admin.query("grant api_app, worker_app, purge_app to current_user");
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

  async function deletionGrant(token: string) {
    return running().app.inject({
      method: "POST",
      url: "/v1/account/action-grants",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { action: "deletion" },
    });
  }

  it("locks immediately, replays the same key, blocks cancel, and isolates tenants (QA57)", async () => {
    const { app: api, admin: db } = running();
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const emailA = "owner.delete.a@example.com";
    const emailB = "owner.delete.b@example.com";
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
          payload: { action: "deletion" },
        })
      ).statusCode,
    ).toBe(403);

    const missingGrant = await api.inject({
      method: "POST",
      url: "/v1/account/deletion",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { confirmation: "DELETE" },
    });
    expect(missingGrant.statusCode).toBe(403);
    expect(missingGrant.json().error.code).toBe("ACTION_GRANT_REQUIRED");

    const wrongPhrase = await api.inject({
      method: "POST",
      url: "/v1/account/deletion",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-action-grant": (await deletionGrant(tokenA)).json().data.grant,
      },
      payload: { confirmation: "delete" },
    });
    expect(wrongPhrase.statusCode).toBe(422);

    const grant1 = await deletionGrant(tokenA);
    expect(grant1.statusCode).toBe(201);
    const key = randomUUID();
    const first = await api.inject({
      method: "POST",
      url: "/v1/account/deletion",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "idempotency-key": key,
        "x-action-grant": grant1.json().data.grant,
      },
      payload: { confirmation: "DELETE" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.status).toBe("locked");
    expect(first.json().data.retained_categories).toEqual([]);
    const deletionId = first.json().data.id as string;

    const replay = await api.inject({
      method: "POST",
      url: "/v1/account/deletion",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "idempotency-key": key,
        "x-action-grant": grant1.json().data.grant,
      },
      payload: { confirmation: "DELETE" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(deletionId);
    expect(replay.json().data.replayed).toBe(true);

    const me = await api.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user.status).toBe("deleting");
    expect(me.json().data.entitlement.can_publish).toBe(false);

    const status = await api.inject({
      method: "GET",
      url: "/v1/account/deletion",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.deletion.id).toBe(deletionId);
    expect(status.json().data.deletion.status).toBe("locked");

    const second = await api.inject({
      method: "POST",
      url: "/v1/account/deletion",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-action-grant": grant1.json().data.grant,
      },
      payload: { confirmation: "DELETE" },
    });
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe("ACCOUNT_DELETING");

    const exportAfter = await api.inject({
      method: "POST",
      url: "/v1/exports",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-action-grant": "not-a-grant",
      },
      payload: {},
    });
    expect(exportAfter.statusCode).toBe(403);
    expect(exportAfter.json().error.code).toBe("ACCOUNT_DELETING");

    const other = await api.inject({
      method: "GET",
      url: "/v1/account/deletion",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().data.deletion).toBeNull();
    const meB = await api.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(meB.statusCode).toBe(200);
    expect(meB.json().data.user.status).toBe("active");

    const email = await db.query<{ status: string; template: string }>(
      `select status, payload_json->>'template_id' as template
       from commercial.outbox_tasks
       where payload_json->>'template_id' = 'EMAIL11'`,
    );
    expect(email.rows.some((row) => row.template === "EMAIL11" && row.status === "pending")).toBe(true);
  });
});
