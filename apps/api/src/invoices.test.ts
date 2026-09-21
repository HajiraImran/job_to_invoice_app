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
const AUTH = "51515151-5151-4151-8151-515151515151";
const AUTH_B = "52525252-5252-4252-8252-525252525252";
const KEYS = {
  setup: "53535353-5353-4353-8353-535353535351",
  job: "53535353-5353-4353-8353-535353535352",
  open: "53535353-5353-4353-8353-535353535353",
  save: "53535353-5353-4353-8353-535353535354",
  publish: "53535353-5353-4353-8353-535353535355",
  decide: "54545454-5454-4454-8454-545454545451",
  issue: "55555555-5555-4555-8555-555555555551",
  issue2: "55555555-5555-4555-8555-555555555552",
  setupB: "56565656-5656-4656-8656-565656565651",
};
const JOB = "57575757-5757-4757-8757-575757575751";
const JOB_B = "57575757-5757-4757-8757-575757575752";
const DELIVERY = parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", "delivery-key-material-ok");

describe("invoice issue API", () => {
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
      throw new Error("invoice API test app did not start");
    }
    return { app, admin };
  }

  async function completeSetup(token: string, key: string) {
    await running().app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    return running().app.inject({
      method: "POST",
      url: "/v1/workspace",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
        "if-match": "1",
      },
      payload: {
        business_name: "Invoice Co",
        legal_name: "Invoice Co LLC",
        contact_name: "Owner I",
        contact_email: "owner.i@example.com",
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
  }

  async function publishQuote(token: string, jobId: string) {
    await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": KEYS.job },
      payload: { id: jobId, customer_name: "Riley Chen", title: "Kitchen faucet", no_site: true, mode: "quote" },
    });
    const opened = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/quote`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": KEYS.open },
    });
    const draftId = opened.json().data.id as string;
    const saved = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${draftId}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.save,
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
        "idempotency-key": KEYS.publish,
        "if-match": String(saved.json().data.version),
      },
      payload: { preview_hash: previewed.json().data.preview_hash, recipient_email: "customer@example.com" },
    });
    expect(published.statusCode).toBe(202);
    return published.json().data as { id: string; request_id: string; snapshot_sha256: string; snapshot: { canonical?: unknown } };
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
    const pdf = Buffer.from("%PDF-1.4 invoice-test");
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
  }

  async function approveQuote(token: string, published: { id: string; request_id: string; snapshot_sha256: string }) {
    const packed = await running().admin.query<{ nonce: Buffer; ciphertext: Buffer }>(
      `select p.nonce, p.ciphertext
       from commercial.encrypted_delivery_payloads p
       join commercial.delivery_attempts a on a.id = p.delivery_attempt_id
       where a.request_id = $1 and a.template_id = 'EMAIL01'`,
      [published.request_id],
    );
    const packedRow = packed.rows[0];
    if (!packedRow) {
      throw new Error("EMAIL01 payload was not found");
    }
    const fragment = encodeFragmentToken(
      decryptDeliveryToken(
        { algorithm: "aes-256-gcm", keyVersion: 1, nonce: packedRow.nonce, ciphertext: packedRow.ciphertext },
        DELIVERY,
      ),
    );
    await completePdf(published.id);
    const exchanged = await running().app.inject({ method: "POST", url: "/v1/portal/exchange", payload: { token: fragment } });
    const session = exchanged.json().data.session as string;
    const cookie = `jti_portal=${session}`;
    let csrf = exchanged.json().data.csrf_token as string;
    await running().app.inject({
      method: "POST",
      url: "/v1/portal/code/send",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      payload: {},
    });
    const otp = await running().admin.query<{ nonce: Buffer; ciphertext: Buffer }>(
      `select p.nonce, p.ciphertext
       from commercial.encrypted_delivery_payloads p
       join commercial.delivery_attempts a on a.id = p.delivery_attempt_id
       where a.template_id = 'EMAIL03'
       order by a.created_at desc limit 1`,
    );
    const otpRow = otp.rows[0];
    if (!otpRow) {
      throw new Error("EMAIL03 payload was not found");
    }
    const code = decryptUtf8(
      { algorithm: "aes-256-gcm", keyVersion: 1, nonce: otpRow.nonce, ciphertext: otpRow.ciphertext },
      DELIVERY,
    );
    const verified = await running().app.inject({
      method: "POST",
      url: "/v1/portal/code/verify",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      payload: { code },
    });
    csrf = verified.json().data.csrf_token as string;
    const decided = await running().app.inject({
      method: "POST",
      url: "/v1/portal/decision",
      headers: {
        cookie,
        "x-csrf-token": csrf,
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
    return token;
  }

  it("previews and issues one invoice from accepted residuals, then replays", async () => {
    const token = await sign({ sub: AUTH, email: "owner.i@example.com" });
    expect((await completeSetup(token, KEYS.setup)).statusCode).toBe(200);
    const published = await publishQuote(token, JOB);
    const before = await running().admin.query<{ bytes: Buffer }>(
      `select canonical_snapshot_bytes as bytes from commercial.documents where id = $1`,
      [published.id],
    );
    const unaccepted = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(unaccepted.statusCode).toBe(422);
    await approveQuote(token, published);
    const job = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(job.json().data.permitted_actions).toContain("create_invoice");
    const preview = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { due_date: "2026-10-05", payment_instructions: "Net 14." },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.snapshot.kind).toBe("invoice");
    expect(preview.json().data.snapshot.total_cents).toBe(25980);
    expect(preview.json().data.snapshot).not.toHaveProperty("number");
    await running().admin.query("set role migrator");
    try {
      await running().admin.query(
        `insert into commercial.document_drafts (
           workspace_id, id, job_id, kind, payload_json, draft_state
         )
         select j.workspace_id, $2::uuid, j.id, 'change', '{}'::jsonb, 'editing'
         from commercial.jobs j where j.id = $1`,
        [JOB, JOB_B],
      );
    } finally {
      await running().admin.query("reset role");
    }
    const blocked = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("UNRESOLVED_CHANGES");
    await running().admin.query("set role migrator");
    try {
      await running().admin.query(`update commercial.document_drafts set draft_state = 'discarded' where id = $1`, [
        JOB_B,
      ]);
    } finally {
      await running().admin.query("reset role");
    }
    const issued = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.issue,
      },
      payload: { preview_hash: preview.json().data.preview_hash },
    });
    expect(issued.statusCode).toBe(202);
    expect(issued.json().data.number).toBe("INV-000001");
    expect(issued.json().data.payment_status).toBe("issued_unpaid");
    expect(issued.json().data.total_cents).toBe(25980);
    const replay = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.issue,
      },
      payload: { preview_hash: preview.json().data.preview_hash },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().data.id).toBe(issued.json().data.id);
    const mismatch = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.issue,
      },
      payload: { preview_hash: "b".repeat(64) },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
    const secondPreview = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(secondPreview.statusCode).toBe(422);
    const after = await running().admin.query<{ bytes: Buffer }>(
      `select canonical_snapshot_bytes as bytes from commercial.documents where id = $1`,
      [published.id],
    );
    expect(after.rows[0]?.bytes.equals(before.rows[0]?.bytes ?? Buffer.alloc(0))).toBe(true);
    const emailed = await running().admin.query<{ template_id: string }>(
      `select template_id from commercial.delivery_attempts where document_id = $1`,
      [issued.json().data.id],
    );
    expect(emailed.rows[0]?.template_id).toBe("EMAIL06");
    const invoiced = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(invoiced.json().data.lifecycle).toBe("invoiced");
    expect(invoiced.json().data.permitted_actions).toContain("view_invoice");
    expect(invoiced.json().data.active_invoice.number).toBe("INV-000001");
    const other = await sign({ sub: AUTH_B, email: "owner.b@example.com" });
    await completeSetup(other, KEYS.setupB);
    const stolen = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/invoice-preview`,
      headers: { authorization: `Bearer ${other}`, "content-type": "application/json" },
      payload: {},
    });
    expect(stolen.statusCode).toBe(404);
  }, 60_000);
});
