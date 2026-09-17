import {
  decryptDeliveryToken,
  decryptUtf8,
  encodeFragmentToken,
  loadEnv,
  parseVersionedSecret,
  RESEND_WEBHOOK_FIXTURE,
} from "@job-to-invoice/config";
import { originalPdfObjectKey } from "@job-to-invoice/domain";
import { createJwtFixture } from "@job-to-invoice/testing";
import { createHash, randomUUID } from "node:crypto";
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
const AUTH = "41414141-4141-4141-8141-414141414141";
const KEYS = {
  setup: "42424242-4242-4242-8242-424242424241",
  job: "42424242-4242-4242-8242-424242424242",
  open: "42424242-4242-4242-8242-424242424243",
  save: "42424242-4242-4242-8242-424242424244",
  publish: "42424242-4242-4242-8242-424242424245",
  open2: "42424242-4242-4242-8242-424242424246",
  decide: "43434343-4343-4343-8343-434343434341",
  decide2: "43434343-4343-4343-8343-434343434342",
};
const JOB = "44444444-4444-4444-8444-444444444441";
const DELIVERY = parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", "delivery-key-material-ok");

describe("portal quote review", () => {
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
      nowSec: () => 1_731_705_121,
      logOwnerMe: () => undefined,
      logPortal: () => undefined,
      documentsStore: {
        presignGet: async (key) => `https://r2.invalid/original.pdf?X-Amz-Expires=300&key=${encodeURIComponent(key)}`,
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
      throw new Error("portal test app did not start");
    }
    return { app, admin };
  }

  async function ownerToken() {
    const token = await sign({ sub: AUTH, email: "portal.owner@example.com" });
    await running().app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    await running().app.inject({
      method: "POST",
      url: "/v1/workspace",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.setup,
        "if-match": "1",
      },
      payload: {
        business_name: "Portal Co",
        legal_name: "Portal Co LLC",
        contact_name: "Owner Q",
        contact_email: "portal.owner@example.com",
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
      },
    });
    return token;
  }

  async function publishQuote(token: string, jobId: string, keys: { job: string; open: string; save: string; publish: string }) {
    await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": keys.job },
      payload: { id: jobId, customer_name: "Riley Chen", title: "Kitchen faucet", no_site: true, mode: "quote" },
    });
    const opened = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/quote`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": keys.open },
    });
    const draftId = opened.json().data.id as string;
    const saved = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${draftId}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": keys.save,
        "if-match": String(opened.json().data.version),
      },
      payload: {
        notes: "Replace cartridge.",
        terms: "Net 14.",
        expiry_days: 14,
        lines: [
          {
            client_line_id: randomUUID(),
            description: "Labour hour",
            unit: "hour",
            quantity: "2.5",
            unit_price_cents: 10000,
            discount_cents: 1000,
            tax_bp: 825,
          },
        ],
      },
    });
    const previewed = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${draftId}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(saved.json().data.version) },
    });
    const published = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${draftId}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": keys.publish,
        "if-match": String(saved.json().data.version),
      },
      payload: { preview_hash: previewed.json().data.preview_hash, recipient_email: "customer@example.com" },
    });
    return published.json().data as { id: string; request_id: string; snapshot_sha256: string; number: string };
  }

  async function fragmentToken(requestId: string): Promise<string> {
    const row = await running().admin.query<{ nonce: Buffer; ciphertext: Buffer }>(
      `select p.nonce, p.ciphertext
       from commercial.encrypted_delivery_payloads p
       join commercial.delivery_attempts a on a.id = p.delivery_attempt_id
       where a.request_id = $1 and a.template_id = 'EMAIL01'`,
      [requestId],
    );
    const first = row.rows[0];
    if (!first) {
      throw new Error("missing EMAIL01 payload");
    }
    const token = decryptDeliveryToken(
      { algorithm: "aes-256-gcm", keyVersion: 1, nonce: first.nonce, ciphertext: first.ciphertext },
      DELIVERY,
    );
    return encodeFragmentToken(token);
  }

  async function completePdf(documentId: string) {
    const issued = await running().admin.query(`select workspace_id, revision_no from commercial.documents where id = $1`, [
      documentId,
    ]);
    const task = await running().admin.query(
      `select id from commercial.outbox_tasks where aggregate_id = $1 and task_type = 'generate_original_pdf'`,
      [documentId],
    );
    const artifactId = randomUUID();
    const objectKey = originalPdfObjectKey({
      workspaceId: issued.rows[0].workspace_id,
      documentId,
      revision: issued.rows[0].revision_no,
      artifactId,
    });
    const pdf = Buffer.from("%PDF-1.4 portal");
    await running().admin.query("set role worker_app");
    try {
      await running().admin.query("select commercial.complete_original_pdf($1::uuid, $2::uuid, $3, $4, $5::bigint)", [
        task.rows[0].id,
        artifactId,
        objectKey,
        createHash("sha256").update(pdf).digest("hex"),
        pdf.byteLength,
      ]);
    } finally {
      await running().admin.query("reset role");
    }
    return objectKey;
  }

  async function verifySession(token: string) {
    const exchanged = await running().app.inject({
      method: "POST",
      url: "/v1/portal/exchange",
      payload: { token },
    });
    expect(exchanged.statusCode).toBe(200);
    const session = exchanged.json().data.session as string;
    const csrf = exchanged.json().data.csrf_token as string;
    const cookie = `jti_portal=${session}`;
    const sent = await running().app.inject({
      method: "POST",
      url: "/v1/portal/code/send",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      payload: {},
    });
    expect(sent.statusCode).toBe(202);
    const payload = await running().admin.query<{ nonce: Buffer; ciphertext: Buffer }>(
      `select p.nonce, p.ciphertext
       from commercial.encrypted_delivery_payloads p
       join commercial.delivery_attempts a on a.id = p.delivery_attempt_id
       where a.template_id = 'EMAIL03'
       order by a.created_at desc limit 1`,
    );
    const packed = payload.rows[0];
    if (!packed) {
      throw new Error("missing EMAIL03 payload");
    }
    const code = decryptUtf8(
      { algorithm: "aes-256-gcm", keyVersion: 1, nonce: packed.nonce, ciphertext: packed.ciphertext },
      DELIVERY,
    );
    expect(code).toMatch(/^\d{6}$/);
    const verified = await running().app.inject({
      method: "POST",
      url: "/v1/portal/code/verify",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      payload: { code },
    });
    expect(verified.statusCode).toBe(200);
    return { cookie, csrf: verified.json().data.csrf_token as string };
  }

  it("rejects unknown tokens and owner bearer on portal routes", async () => {
    const owner = await sign({ sub: AUTH, email: "portal.owner@example.com" });
    const unknown = await running().app.inject({ method: "POST", url: "/v1/portal/exchange", payload: { token: "not-a-token" } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("REQUEST_UNAVAILABLE");
    const bearer = await running().app.inject({
      method: "POST",
      url: "/v1/portal/exchange",
      headers: { authorization: `Bearer ${owner}` },
      payload: { token: "abcdefghijklmnopqrstuvwxyzABCDEFG0123456789_-" },
    });
    expect(bearer.statusCode).toBe(401);
  });

  it("verifies the bound email, accepts the quote, and refreshes owner status", async () => {
    const token = await ownerToken();
    const published = await publishQuote(token, JOB, KEYS);
    expect(published.request_id).toBeTruthy();
    const fragment = await fragmentToken(published.request_id);
    expect(fragment).not.toContain("?");
    const session = await verifySession(fragment);
    const document = await running().app.inject({ method: "GET", url: "/v1/portal/document", headers: { cookie: session.cookie } });
    expect(document.statusCode).toBe(200);
    expect(JSON.stringify(document.json())).not.toContain("customer@example.com");
    expect(JSON.stringify(document.json())).not.toContain(fragment);
    expect(document.json().data.snapshot.total_cents).toBe(25980);
    await completePdf(published.id);
    const ready = await running().app.inject({ method: "GET", url: "/v1/portal/document", headers: { cookie: session.cookie } });
    expect(ready.json().data.pdf_state).toBe("ready");
    const download = await running().app.inject({ method: "GET", url: "/v1/portal/download", headers: { cookie: session.cookie } });
    expect(download.statusCode).toBe(200);
    expect(download.json().data.url).toContain("X-Amz-Expires=300");
    const decided = await running().app.inject({
      method: "POST",
      url: "/v1/portal/decision",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": KEYS.decide,
        "content-type": "application/json",
      },
      payload: {
        decision: "approve",
        signer_name: "Riley Chen",
        consent_version: "apr04.v1",
        consent_accepted: true,
        snapshot_sha256: published.snapshot_sha256,
      },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().data.decision).toBe("approve");
    expect(decided.json().data.payment_claimed).toBe(false);
    const replay = await running().app.inject({
      method: "POST",
      url: "/v1/portal/decision",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": KEYS.decide,
        "content-type": "application/json",
      },
      payload: {
        decision: "approve",
        signer_name: "Riley Chen",
        consent_version: "apr04.v1",
        consent_accepted: true,
        snapshot_sha256: published.snapshot_sha256,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.replayed).toBe(true);
    const second = await running().app.inject({
      method: "POST",
      url: "/v1/portal/decision",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": KEYS.decide2,
        "content-type": "application/json",
      },
      payload: {
        decision: "decline",
        signer_name: "Riley Chen",
        consent_version: "apr04.v1",
        consent_accepted: true,
        snapshot_sha256: published.snapshot_sha256,
      },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("ALREADY_DECIDED");
    const job = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(job.json().data.current_quote.lifecycle).toBe("accepted");
    const request = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}/request`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(request.json().data.request_state).toBe("approved");
    const immutable = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/quote`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": KEYS.open2 },
    });
    expect(immutable.statusCode).toBe(409);
    expect(immutable.json().error.code).toBe("DOCUMENT_IMMUTABLE");
    const receipt = await running().app.inject({
      method: "GET",
      url: "/v1/portal/receipt",
      headers: { cookie: session.cookie },
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json().data.payment_claimed).toBe(false);
    expect(JSON.stringify(receipt.json())).not.toContain("customer@example.com");
  });

  it("hides the snapshot until verification, then rejects consent, hash mismatch, and late approve", async () => {
    const token = await ownerToken();
    const published = await publishQuote(token, "44444444-4444-4444-8444-444444444442", {
      job: "42424242-4242-4242-8242-424242424251",
      open: "42424242-4242-4242-8242-424242424252",
      save: "42424242-4242-4242-8242-424242424253",
      publish: "42424242-4242-4242-8242-424242424254",
    });
    expect(published.request_id).toBeTruthy();
    const fragment = await fragmentToken(published.request_id);
    const exchanged = await running().app.inject({
      method: "POST",
      url: "/v1/portal/exchange",
      payload: { token: fragment },
    });
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json().data.snapshot).toBeUndefined();
    expect(JSON.stringify(exchanged.json())).not.toContain("Riley Chen");
    const cookie = `jti_portal=${exchanged.json().data.session}`;
    const csrf = exchanged.json().data.csrf_token as string;
    const before = await running().app.inject({
      method: "GET",
      url: "/v1/portal/document",
      headers: { cookie },
    });
    expect(before.statusCode).toBe(404);
    await running().app.inject({
      method: "POST",
      url: "/v1/portal/code/send",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      payload: {},
    });
    const wrong = await running().app.inject({
      method: "POST",
      url: "/v1/portal/code/verify",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      payload: { code: "000000" },
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe("VALIDATION_FAILED");
    const packed = await running().admin.query<{ nonce: Buffer; ciphertext: Buffer }>(
      `select p.nonce, p.ciphertext
       from commercial.encrypted_delivery_payloads p
       join commercial.delivery_attempts a on a.id = p.delivery_attempt_id
       where a.template_id = 'EMAIL03'
       order by a.created_at desc limit 1`,
    );
    const first = packed.rows[0];
    if (!first) {
      throw new Error("missing EMAIL03 payload");
    }
    const code = decryptUtf8(
      { algorithm: "aes-256-gcm", keyVersion: 1, nonce: first.nonce, ciphertext: first.ciphertext },
      DELIVERY,
    );
    const verified = await running().app.inject({
      method: "POST",
      url: "/v1/portal/code/verify",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      payload: { code },
    });
    expect(verified.statusCode).toBe(200);
    const session = { cookie, csrf: verified.json().data.csrf_token as string };
    await completePdf(published.id);
    const consent = await running().app.inject({
      method: "POST",
      url: "/v1/portal/decision",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": "43434343-4343-4343-8343-434343434353",
        "content-type": "application/json",
      },
      payload: {
        decision: "approve",
        signer_name: "Riley Chen",
        consent_version: "apr04.v1",
        consent_accepted: false,
        snapshot_sha256: published.snapshot_sha256,
      },
    });
    expect(consent.statusCode).toBe(422);
    const mismatch = await running().app.inject({
      method: "POST",
      url: "/v1/portal/decision",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": "43434343-4343-4343-8343-434343434354",
        "content-type": "application/json",
      },
      payload: {
        decision: "approve",
        signer_name: "Riley Chen",
        consent_version: "apr04.v1",
        consent_accepted: true,
        snapshot_sha256: "ab".repeat(32),
      },
    });
    expect(mismatch.statusCode).toBe(422);
    await running().admin.query(
      `update commercial.approval_requests set expires_at = now() - interval '1 minute' where id = $1`,
      [published.request_id],
    );
    const late = await running().app.inject({
      method: "POST",
      url: "/v1/portal/decision",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": "43434343-4343-4343-8343-434343434352",
        "content-type": "application/json",
      },
      payload: {
        decision: "approve",
        signer_name: "Riley Chen",
        consent_version: "apr04.v1",
        consent_accepted: true,
        snapshot_sha256: published.snapshot_sha256,
      },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("REQUEST_EXPIRED");
    const job = await running().app.inject({
      method: "GET",
      url: "/v1/jobs/44444444-4444-4444-8444-444444444442",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(job.json().data.current_quote.lifecycle).toBe("expired");
  });

  it("declines with a comment then opens a revision", async () => {
    const token = await ownerToken();
    const jobId = "44444444-4444-4444-8444-444444444443";
    const published = await publishQuote(token, jobId, {
      job: "42424242-4242-4242-8242-424242424261",
      open: "42424242-4242-4242-8242-424242424262",
      save: "42424242-4242-4242-8242-424242424263",
      publish: "42424242-4242-4242-8242-424242424264",
    });
    expect(published.request_id).toBeTruthy();
    const fragment = await fragmentToken(published.request_id);
    const session = await verifySession(fragment);
    await completePdf(published.id);
    const declined = await running().app.inject({
      method: "POST",
      url: "/v1/portal/decision",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": "43434343-4343-4343-8343-434343434351",
        "content-type": "application/json",
      },
      payload: {
        decision: "decline",
        signer_name: "Riley Chen",
        consent_version: "apr04.v1",
        consent_accepted: true,
        snapshot_sha256: published.snapshot_sha256,
        comment: "Please revise the labour hours.",
      },
    });
    expect(declined.statusCode).toBe(200);
    expect(declined.json().data.decision).toBe("decline");
    const request = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}/request`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(request.json().data.request_state).toBe("declined");
    const opened = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/quote`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "42424242-4242-4242-8242-424242424265" },
    });
    expect(opened.statusCode).toBe(200);
  });
});
