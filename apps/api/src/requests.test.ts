import {
  decryptDeliveryToken,
  encodeFragmentToken,
  loadEnv,
  parseVersionedSecret,
  RESEND_WEBHOOK_FIXTURE,
} from "@job-to-invoice/config";
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
const DELIVERY = parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", "delivery-key-material-ok");

function setupBody() {
  return {
    business_name: "Request Controls Co",
    legal_name: "Request Controls Co LLC",
    contact_name: "Owner R",
    contact_email: "owner.r@example.com",
    contact_phone: "+12025550199",
    address: { line1: "99 Main Street", city: "Austin", state: "TX", postal_code: "78701" },
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

describe("S12 owner request controls", () => {
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
    pool = new Pool({ connectionString: resolved.url, max: 8 });
    const fixture = await createJwtFixture();
    sign = fixture.sign;
    const env = loadEnv({
      APP_ENV: "development",
      PORTAL_ORIGIN: "http://localhost:3000",
      APPROVAL_TOKEN_HASH_KEY: "token-key-material-ok",
      APPROVAL_DELIVERY_ENCRYPTION_KEY: "delivery-key-material-ok",
      OTP_HASH_KEY: "otp-hash-key-material-ok",
      APPROVAL_EVIDENCE_ENCRYPTION_KEY: "evidence-key-material-ok",
      EMAIL_WEBHOOK_SECRET: RESEND_WEBHOOK_FIXTURE.secret,
    });
    app = buildApp({
      env,
      pool,
      nowSec: () => nowSec,
      logOwnerMe: () => undefined,
      logPortal: () => undefined,
      documentsStore: {
        presignGet: async (key) => `https://r2.invalid/original.pdf?key=${encodeURIComponent(key)}`,
      },
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
      throw new Error("request controls test app did not start");
    }
    return { app, admin };
  }

  async function freshToken(sub?: string, email?: string) {
    nowSec = Math.floor(Date.now() / 1000);
    const id = sub ?? randomUUID();
    return sign({ sub: id, email: email ?? `owner.${id.slice(0, 8)}@example.com`, authTime: nowSec });
  }

  async function tokenFor(sub: string, email: string) {
    nowSec = Math.floor(Date.now() / 1000);
    return sign({ sub, email, authTime: nowSec });
  }

  async function publishPending(token: string, contactEmail = `owner.${randomUUID().slice(0, 8)}@example.com`) {
    const { app: api } = running();
    await api.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    const setup = await api.inject({
      method: "POST",
      url: "/v1/workspace",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-match": "1",
      },
      payload: { ...setupBody(), contact_email: contactEmail },
    });
    expect(setup.statusCode).toBe(200);
    const jobId = randomUUID();
    const job = await api.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {
        id: jobId,
        customer_name: "Pat Lee",
        title: "Sink",
        no_site: true,
        mode: "quote",
      },
    });
    expect(job.statusCode).toBe(200);
    const opened = await api.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/quote`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    });
    expect(opened.statusCode).toBe(200);
    const draftId = opened.json().data.id as string;
    const openedVersion = opened.json().data.version as number;
    const saved = await api.inject({
      method: "PATCH",
      url: `/v1/drafts/${draftId}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-match": String(openedVersion),
      },
      payload: {
        notes: "n",
        terms: "t",
        expiry_days: 14,
        lines: [
          {
            client_line_id: randomUUID(),
            description: "Labour",
            unit: "hour",
            quantity: "1",
            unit_price_cents: 10000,
            discount_cents: 0,
            tax_bp: 0,
          },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    const version = saved.json().data.version as number;
    const previewed = await api.inject({
      method: "POST",
      url: `/v1/drafts/${draftId}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(version) },
    });
    expect(previewed.statusCode).toBe(200);
    const published = await api.inject({
      method: "POST",
      url: `/v1/drafts/${draftId}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-match": String(version),
      },
      payload: {
        preview_hash: previewed.json().data.preview_hash,
        recipient_email: "customer@example.com",
      },
    });
    expect(published.statusCode).toBe(202);
    return {
      jobId,
      requestId: published.json().data.request_id as string,
      documentId: published.json().data.id as string,
    };
  }

  async function fragmentFor(requestId: string, templateId = "EMAIL01") {
    const { admin: db } = running();
    const row = await db.query<{
      algorithm: string;
      key_version: number;
      nonce: Buffer;
      ciphertext: Buffer;
    }>(
      `select p.algorithm, p.key_version, p.nonce, p.ciphertext
       from commercial.delivery_attempts a
       join commercial.encrypted_delivery_payloads p on p.delivery_attempt_id = a.id
       where a.request_id = $1::uuid and a.template_id = $2
       order by a.created_at desc
       limit 1`,
      [requestId, templateId],
    );
    const payload = row.rows[0];
    if (!payload) {
      throw new Error(`missing ${templateId} payload`);
    }
    const raw = decryptDeliveryToken(
      {
        algorithm: "aes-256-gcm",
        keyVersion: payload.key_version,
        nonce: payload.nonce,
        ciphertext: payload.ciphertext,
      },
      DELIVERY,
    );
    return encodeFragmentToken(raw);
  }

  it("requires authentication and hides cross-tenant request ids", async () => {
    const { app: api } = running();
    const missing = await api.inject({ method: "POST", url: `/v1/requests/${randomUUID()}/resend`, payload: {} });
    expect(missing.statusCode).toBe(401);
    const ownerSub = randomUUID();
    const token = await tokenFor(ownerSub, `owner.${ownerSub.slice(0, 8)}@example.com`);
    const published = await publishPending(token, `owner.${ownerSub.slice(0, 8)}@example.com`);
    const otherSub = randomUUID();
    const other = await tokenFor(otherSub, `other.${otherSub.slice(0, 8)}@example.com`);
    await api.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${other}` } });
    await api.inject({
      method: "POST",
      url: "/v1/workspace",
      headers: {
        authorization: `Bearer ${other}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-match": "1",
      },
      payload: {
        ...setupBody(),
        contact_email: `other.${otherSub.slice(0, 8)}@example.com`,
        business_name: "Other Co",
        legal_name: "Other Co LLC",
      },
    });
    const cross = await api.inject({
      method: "POST",
      url: `/v1/requests/${published.requestId}/withdraw`,
      headers: {
        authorization: `Bearer ${other}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { reason: "cross" },
    });
    expect(cross.statusCode).toBe(404);
    expect(cross.json().error.code).toBe("NOT_FOUND");
  });

  it("resends with rotation, idempotent replay, and NTF04 cooldown", async () => {
    const { app: api, admin: db } = running();
    const token = await freshToken();
    const published = await publishPending(token);
    const oldToken = await fragmentFor(published.requestId);
    const key = randomUUID();
    const first = await api.inject({
      method: "POST",
      url: `/v1/requests/${published.requestId}/resend`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      payload: {},
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().data.delivery_state).toBe("queued");
    const replay = await api.inject({
      method: "POST",
      url: `/v1/requests/${published.requestId}/resend`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      payload: {},
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().data.replayed).toBe(true);
    const emails = await db.query(
      `select effect_key from commercial.delivery_attempts
       where request_id = $1::uuid and template_id = 'EMAIL01' and effect_key like '%:EMAIL01:resend:%'`,
      [published.requestId],
    );
    expect(emails.rowCount).toBe(1);
    const oldExchange = await api.inject({
      method: "POST",
      url: "/v1/portal/exchange",
      headers: { "content-type": "application/json" },
      payload: { token: oldToken },
    });
    expect(oldExchange.statusCode).toBe(404);
    const cooldown = await api.inject({
      method: "POST",
      url: `/v1/requests/${published.requestId}/resend`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {},
    });
    expect(cooldown.statusCode).toBe(429);
    expect(cooldown.headers["retry-after"]).toBeTruthy();
  });

  it("withdraws pending requests and rejects finalized repeats with safe conflicts", async () => {
    const { app: api } = running();
    const token = await freshToken();
    const published = await publishPending(token);
    const key = randomUUID();
    const withdrawn = await api.inject({
      method: "POST",
      url: `/v1/requests/${published.requestId}/withdraw`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      payload: { reason: "Wrong recipient" },
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().data.request_state).toBe("withdrawn");
    const replay = await api.inject({
      method: "POST",
      url: `/v1/requests/${published.requestId}/withdraw`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      payload: { reason: "Wrong recipient" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.replayed).toBe(true);
    const again = await api.inject({
      method: "POST",
      url: `/v1/requests/${published.requestId}/withdraw`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { reason: "Again" },
    });
    expect([409, 404]).toContain(again.statusCode);
    const tokenFragment = await fragmentFor(published.requestId).catch(() => undefined);
    if (tokenFragment) {
      const exchange = await api.inject({
        method: "POST",
        url: "/v1/portal/exchange",
        headers: { "content-type": "application/json" },
        payload: { token: tokenFragment },
      });
      expect(exchange.statusCode).toBe(404);
    }
  });

  it("requires a fresh replace_link grant and rotates without repeating on replay (QA17)", async () => {
    const { app: api } = running();
    const ownerSub = randomUUID();
    const email = "owner.replace@example.com";
    const stale = await sign({
      sub: ownerSub,
      email,
      authTime: Math.floor(Date.now() / 1000) - 400,
    });
    nowSec = Math.floor(Date.now() / 1000);
    const token = await tokenFor(ownerSub, email);
    const published = await publishPending(token);
    const staleGrant = await api.inject({
      method: "POST",
      url: "/v1/account/action-grants",
      headers: { authorization: `Bearer ${stale}`, "content-type": "application/json" },
      payload: { action: "replace_link" },
    });
    expect(staleGrant.statusCode).toBe(403);
    const amrFresh = await sign({
      sub: ownerSub,
      email,
      amr: [{ method: "otp", timestamp: nowSec }],
    });
    const amrGrant = await api.inject({
      method: "POST",
      url: "/v1/account/action-grants",
      headers: { authorization: `Bearer ${amrFresh}`, "content-type": "application/json" },
      payload: { action: "replace_link" },
    });
    expect(amrGrant.statusCode).toBe(201);
    const refreshOnly = await sign({
      sub: ownerSub,
      email,
      amr: [{ method: "token_refresh", timestamp: nowSec }],
    });
    const refreshGrant = await api.inject({
      method: "POST",
      url: "/v1/account/action-grants",
      headers: { authorization: `Bearer ${refreshOnly}`, "content-type": "application/json" },
      payload: { action: "replace_link" },
    });
    expect(refreshGrant.statusCode).toBe(403);
    expect(refreshGrant.json().error.code).toBe("ACTION_GRANT_REQUIRED");
    const fresh = await tokenFor(ownerSub, email);
    await api.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${fresh}` } });
    const grant = await api.inject({
      method: "POST",
      url: "/v1/account/action-grants",
      headers: { authorization: `Bearer ${fresh}`, "content-type": "application/json" },
      payload: { action: "replace_link" },
    });
    expect(grant.statusCode).toBe(201);
    const grantValue = grant.json().data.grant as string;
    expect(grantValue).toMatch(/^[A-Za-z0-9_-]+$/);
    const oldToken = await fragmentFor(published.requestId);
    const key = randomUUID();
    const replaced = await api.inject({
      method: "POST",
      url: `/v1/requests/${published.requestId}/replace-link`,
      headers: {
        authorization: `Bearer ${fresh}`,
        "content-type": "application/json",
        "idempotency-key": key,
        "x-action-grant": grantValue,
      },
      payload: {},
    });
    expect(replaced.statusCode).toBe(202);
    const replay = await api.inject({
      method: "POST",
      url: `/v1/requests/${published.requestId}/replace-link`,
      headers: {
        authorization: `Bearer ${fresh}`,
        "content-type": "application/json",
        "idempotency-key": key,
        "x-action-grant": grantValue,
      },
      payload: {},
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().data.replayed).toBe(true);
    const reused = await api.inject({
      method: "POST",
      url: `/v1/requests/${published.requestId}/replace-link`,
      headers: {
        authorization: `Bearer ${fresh}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-action-grant": grantValue,
      },
      payload: {},
    });
    expect(reused.statusCode).toBe(403);
    const oldExchange = await api.inject({
      method: "POST",
      url: "/v1/portal/exchange",
      headers: { "content-type": "application/json" },
      payload: { token: oldToken },
    });
    expect(oldExchange.statusCode).toBe(404);
    const newToken = await fragmentFor(published.requestId, "EMAIL08");
    const neu = await api.inject({
      method: "POST",
      url: "/v1/portal/exchange",
      headers: { "content-type": "application/json" },
      payload: { token: newToken },
    });
    expect(neu.statusCode).toBe(200);
  });

  it("rejects unknown fields and missing Idempotency-Key", async () => {
    const { app: api } = running();
    const token = await freshToken();
    const published = await publishPending(token);
    const bad = await api.inject({
      method: "POST",
      url: `/v1/requests/${published.requestId}/resend`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { extra: true },
    });
    expect(bad.statusCode).toBe(422);
    const noKey = await api.inject({
      method: "POST",
      url: `/v1/requests/${published.requestId}/withdraw`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { reason: "Missing key" },
    });
    expect(noKey.statusCode).toBe(422);
  });
});
