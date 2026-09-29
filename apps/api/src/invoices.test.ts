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
  job2: "53535353-5353-4353-8353-535353535356",
  open2: "53535353-5353-4353-8353-535353535357",
  save2: "53535353-5353-4353-8353-535353535358",
  publish2: "53535353-5353-4353-8353-535353535359",
  decide2: "54545454-5454-4454-8454-545454545452",
  pay: "57575757-5757-4757-8757-575757575761",
  payReplay: "57575757-5757-4757-8757-575757575762",
  overpay: "57575757-5757-4757-8757-575757575763",
  refund: "57575757-5757-4757-8757-575757575764",
  refund2: "57575757-5757-4757-8757-575757575765",
  job3: "53535353-5353-4353-8353-535353535360",
  open3: "53535353-5353-4353-8353-535353535361",
  save3: "53535353-5353-4353-8353-535353535362",
  publish3: "53535353-5353-4353-8353-535353535363",
  decide3: "54545454-5454-4454-8454-545454545453",
  issue3: "55555555-5555-4555-8555-555555555553",
  payFull: "57575757-5757-4757-8757-575757575766",
  credit: "58585858-5858-4858-8858-585858585861",
  job4: "53535353-5353-4353-8353-535353535364",
  open4: "53535353-5353-4353-8353-535353535365",
  save4: "53535353-5353-4353-8353-535353535366",
  publish4: "53535353-5353-4353-8353-535353535367",
  decide4: "54545454-5454-4454-8454-545454545454",
  issue4: "55555555-5555-4555-8555-555555555554",
  payRev: "57575757-5757-4757-8757-575757575767",
  reverse: "59595959-5959-4959-8959-595959595961",
  reverse2: "59595959-5959-4959-8959-595959595962",
  job5: "53535353-5353-4353-8353-535353535368",
  open5: "53535353-5353-4353-8353-535353535369",
  save5: "53535353-5353-4353-8353-535353535370",
  publish5: "53535353-5353-4353-8353-535353535371",
  decide5: "54545454-5454-4454-8454-545454545455",
  issue5: "55555555-5555-4555-8555-555555555555",
  payDep: "57575757-5757-4757-8757-575757575768",
  overpayDep: "57575757-5757-4757-8757-575757575769",
  refundDep: "57575757-5757-4757-8757-575757575770",
  reversePayDep: "59595959-5959-4959-8959-595959595963",
  reverseRefundDep: "59595959-5959-4959-8959-595959595964",
  setupC: "56565656-5656-4656-8656-565656565652",
  setupD: "56565656-5656-4656-8656-565656565653",
  jobVoid: "53535353-5353-4353-8353-535353535372",
  openVoid: "53535353-5353-4353-8353-535353535373",
  saveVoid: "53535353-5353-4353-8353-535353535374",
  publishVoid: "53535353-5353-4353-8353-535353535375",
  decideVoid: "54545454-5454-4454-8454-545454545456",
  issueVoid: "55555555-5555-4555-8555-555555555556",
  voidKey: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a51",
  voidReplay: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a52",
  voidDup: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a53",
  replaceIssue: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a54",
  replaceReplay: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a55",
  jobVoidPay: "53535353-5353-4353-8353-535353535376",
  openVoidPay: "53535353-5353-4353-8353-535353535377",
  saveVoidPay: "53535353-5353-4353-8353-535353535378",
  publishVoidPay: "53535353-5353-4353-8353-535353535379",
  decideVoidPay: "54545454-5454-4454-8454-545454545457",
  issueVoidPay: "55555555-5555-4555-8555-555555555557",
  payVoid: "57575757-5757-4757-8757-575757575771",
  voidPay: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a56",
  jobVoidCredit: "53535353-5353-4353-8353-535353535380",
  openVoidCredit: "53535353-5353-4353-8353-535353535381",
  saveVoidCredit: "53535353-5353-4353-8353-535353535382",
  publishVoidCredit: "53535353-5353-4353-8353-535353535383",
  decideVoidCredit: "54545454-5454-4454-8454-545454545458",
  issueVoidCredit: "55555555-5555-4555-8555-555555555558",
  creditVoid: "58585858-5858-4858-8858-585858585862",
  voidCredit: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a57",
};
const AUTH_C = "53535353-5353-4353-8353-535353535253";
const AUTH_D = "54545454-5454-4454-8454-545454545450";
const JOB = "57575757-5757-4757-8757-575757575751";
const JOB_B = "57575757-5757-4757-8757-575757575752";
const JOB_LEDGER = "57575757-5757-4757-8757-575757575753";
const JOB_CREDIT = "57575757-5757-4757-8757-575757575754";
const JOB_REVERSE = "57575757-5757-4757-8757-575757575755";
const JOB_REVERSE_DEP = "57575757-5757-4757-8757-575757575756";
const JOB_VOID = "57575757-5757-4757-8757-575757575757";
const JOB_VOID_PAY = "57575757-5757-4757-8757-575757575758";
const JOB_VOID_CREDIT = "57575757-5757-4757-8757-575757575759";
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

  async function publishQuote(
    token: string,
    jobId: string,
    keys: { job: string; open: string; save: string; publish: string } = {
      job: KEYS.job,
      open: KEYS.open,
      save: KEYS.save,
      publish: KEYS.publish,
    },
  ) {
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

  async function approveQuote(
    token: string,
    published: { id: string; request_id: string; snapshot_sha256: string },
    decideKey = KEYS.decide,
  ) {
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
        "idempotency-key": decideKey,
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

  async function issueInvoice(
    token: string,
    jobId: string,
    keys: {
      job: string;
      open: string;
      save: string;
      publish: string;
      decide: string;
      issue: string;
    },
  ) {
    const published = await publishQuote(token, jobId, keys);
    await approveQuote(token, published, keys.decide);
    const preview = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    const issued = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": keys.issue,
      },
      payload: { preview_hash: preview.json().data.preview_hash },
    });
    expect(issued.statusCode).toBe(202);
    return issued.json().data as { id: string; number: string; request_id: string; snapshot_sha256: string };
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
    expect(blocked.json().error.message).toBe(
      "This job has unpublished extra work. Open Extra work to finish sending it for approval, or discard that draft before invoicing.",
    );
    expect(blocked.json().error.field_errors).toEqual([
      { field: "change_draft", message: "Finish or discard the unpublished extra work before invoicing." },
    ]);
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

  it("records a partial payment, rejects unconfirmed overpay, then refunds the overpayment", async () => {
    const token = await sign({ sub: AUTH, email: "owner.i@example.com" });
    expect((await completeSetup(token, KEYS.setup)).statusCode).toBe(200);
    const published = await publishQuote(token, JOB_LEDGER, {
      job: KEYS.job2,
      open: KEYS.open2,
      save: KEYS.save2,
      publish: KEYS.publish2,
    });
    await approveQuote(token, published, KEYS.decide2);
    const preview = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_LEDGER}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    const issued = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_LEDGER}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.issue2,
      },
      payload: { preview_hash: preview.json().data.preview_hash },
    });
    expect(issued.statusCode).toBe(202);
    const invoiceId = issued.json().data.id as string;
    expect(issued.json().data.number).toBe("INV-000002");
    const partial = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/payments`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.pay,
      },
      payload: { amount_cents: 4000, effective_date: "2026-09-21", method: "cash" },
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.json().data.payment_status).toBe("partially_paid");
    expect(partial.json().data.amount_due_cents).toBe(21980);
    expect(partial.json().data.recorded_by).toBe("Recorded by business");
    const replay = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/payments`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.pay,
      },
      payload: { amount_cents: 4000, effective_date: "2026-09-21", method: "cash" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(partial.json().data.id);
    const blockedRefund = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/refunds`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.refund,
      },
      payload: { amount_cents: 1000, effective_date: "2026-09-21", method: "cash" },
    });
    expect(blockedRefund.statusCode).toBe(409);
    expect(blockedRefund.json().error.code).toBe("REFUND_EXCEEDS_BALANCE");
    const unconfirmed = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/payments`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.overpay,
      },
      payload: { amount_cents: 30000, effective_date: "2026-09-21", method: "check" },
    });
    expect(unconfirmed.statusCode).toBe(422);
    const overpay = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/payments`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.overpay,
      },
      payload: {
        amount_cents: 30000,
        effective_date: "2026-09-21",
        method: "check",
        confirm_overpayment: true,
      },
    });
    expect(overpay.statusCode).toBe(200);
    expect(overpay.json().data.payment_status).toBe("refund_due");
    expect(overpay.json().data.amount_to_refund_cents).toBe(8020);
    const partialRefund = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/refunds`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.refund,
      },
      payload: { amount_cents: 2000, effective_date: "2026-09-21", method: "bank_transfer" },
    });
    expect(partialRefund.statusCode).toBe(200);
    expect(partialRefund.json().data.payment_status).toBe("refund_due");
    expect(partialRefund.json().data.amount_to_refund_cents).toBe(6020);
    const overRefund = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/refunds`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.refund2,
      },
      payload: { amount_cents: 6021, effective_date: "2026-09-21", method: "bank_transfer" },
    });
    expect(overRefund.statusCode).toBe(409);
    expect(overRefund.json().error.code).toBe("REFUND_EXCEEDS_BALANCE");
    const refund = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/refunds`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.refund2,
      },
      payload: { amount_cents: 6020, effective_date: "2026-09-21", method: "bank_transfer" },
    });
    expect(refund.statusCode).toBe(200);
    expect(refund.json().data.payment_status).toBe("settled");
    expect(refund.json().data.balance_cents).toBe(0);
    const ledger = await running().app.inject({
      method: "GET",
      url: `/v1/invoices/${invoiceId}/ledger`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().data.entries).toHaveLength(4);
    const event = await running().admin.query<{ n: string }>(
      `select count(*)::text as n from commercial.analytics_events
       where event_name = 'payment_recorded' and job_id = $1`,
      [JOB_LEDGER],
    );
    expect(Number(event.rows[0]?.n)).toBe(2);
    const other = await sign({ sub: AUTH_B, email: "owner.b@example.com" });
    const stolen = await running().app.inject({
      method: "GET",
      url: `/v1/invoices/${invoiceId}/ledger`,
      headers: { authorization: `Bearer ${other}` },
    });
    expect(stolen.statusCode).toBe(404);
  }, 60_000);

  it("issues a credit after full payment and leaves a refund due without moving money", async () => {
    const token = await sign({ sub: AUTH, email: "owner.i@example.com" });
    expect((await completeSetup(token, KEYS.setup)).statusCode).toBe(200);
    const published = await publishQuote(token, JOB_CREDIT, {
      job: KEYS.job3,
      open: KEYS.open3,
      save: KEYS.save3,
      publish: KEYS.publish3,
    });
    await approveQuote(token, published, KEYS.decide3);
    const preview = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_CREDIT}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    const issued = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_CREDIT}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.issue3,
      },
      payload: { preview_hash: preview.json().data.preview_hash },
    });
    expect(issued.statusCode).toBe(202);
    const invoiceId = issued.json().data.id as string;
    expect(issued.json().data.number).toBe("INV-000003");
    const paid = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/payments`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.payFull,
      },
      payload: { amount_cents: 25980, effective_date: "2026-09-21", method: "cash" },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().data.payment_status).toBe("settled");
    const ledger = await running().app.inject({
      method: "GET",
      url: `/v1/invoices/${invoiceId}/ledger`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ledger.statusCode).toBe(200);
    const lineId = ledger.json().data.credit_sources[0].invoice_line_id as string;
    expect(ledger.json().data.credit_sources[0].remaining_net_cents).toBe(24000);
    const over = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/credits/preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        reason: "Billing correction after overbilling labour",
        allocations: [{ invoice_line_id: lineId, net_credit_cents: 24001 }],
      },
    });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe("CREDIT_EXCEEDS_SOURCE");
    const creditPreview = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/credits/preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        reason: "Billing correction after overbilling labour",
        allocations: [{ invoice_line_id: lineId, net_credit_cents: 2000 }],
      },
    });
    expect(creditPreview.statusCode).toBe(200);
    expect(creditPreview.json().data.snapshot.total_cents).toBe(2165);
    const credit = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/credits`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.credit,
      },
      payload: { preview_hash: creditPreview.json().data.preview_hash },
    });
    expect(credit.statusCode).toBe(202);
    expect(credit.json().data.number).toBe("CN-000001");
    expect(credit.json().data.kind).toBe("credit");
    const replay = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/credits`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.credit,
      },
      payload: { preview_hash: creditPreview.json().data.preview_hash },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().data.id).toBe(credit.json().data.id);
    const after = await running().app.inject({
      method: "GET",
      url: `/v1/invoices/${invoiceId}/ledger`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().data.credits_cents).toBe(2165);
    expect(after.json().data.balance_cents).toBe(-2165);
    expect(after.json().data.payment_status).toBe("refund_due");
    expect(after.json().data.amount_to_refund_cents).toBe(2165);
    expect(after.json().data.entries).toHaveLength(1);
    expect(after.json().data.entries[0].type).toBe("payment");
    const emailed = await running().admin.query<{ template_id: string }>(
      `select template_id from commercial.delivery_attempts where document_id = $1`,
      [credit.json().data.id],
    );
    expect(emailed.rows[0]?.template_id).toBe("EMAIL07");
    const analytics = await running().admin.query<{ n: string }>(
      `select count(*)::text as n from commercial.analytics_events
       where event_name = 'payment_recorded' and job_id = $1`,
      [JOB_CREDIT],
    );
    expect(Number(analytics.rows[0]?.n)).toBe(1);
    const creditId = credit.json().data.id as string;
    await completePdf(creditId);
    const ownerCredit = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${creditId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ownerCredit.statusCode).toBe(200);
    expect(ownerCredit.json().data.kind).toBe("credit");
    expect(ownerCredit.json().data.number).toBe("CN-000001");
    expect(ownerCredit.json().data.pdf_state).toBe("ready");
    const ownerDownload = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${creditId}/download`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ownerDownload.statusCode).toBe(200);
    expect(ownerDownload.json().data).toMatchObject({ document_id: creditId, state: "ready" });
    expect(ownerDownload.json().data.url).toContain("X-Amz-Expires=300");
    const jobWithCredits = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB_CREDIT}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(jobWithCredits.statusCode).toBe(200);
    expect(jobWithCredits.json().data.issued_credits).toEqual([
      expect.objectContaining({
        id: creditId,
        number: "CN-000001",
        invoice_id: invoiceId,
        pdf_state: "ready",
        total_cents: 2165,
      }),
    ]);
    const invoiceWithCredits = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${invoiceId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(invoiceWithCredits.statusCode).toBe(200);
    expect(invoiceWithCredits.json().data.issued_credits).toEqual([
      expect.objectContaining({ id: creditId, number: "CN-000001", pdf_state: "ready", total_cents: 2165 }),
    ]);
    const packedCredit = await running().admin.query<{ nonce: Buffer; ciphertext: Buffer }>(
      `select p.nonce, p.ciphertext
       from commercial.encrypted_delivery_payloads p
       join commercial.delivery_attempts a on a.id = p.delivery_attempt_id
       where a.document_id = $1 and a.template_id = 'EMAIL07'`,
      [creditId],
    );
    const packedCreditRow = packedCredit.rows[0];
    if (!packedCreditRow) {
      throw new Error("EMAIL07 payload was not found");
    }
    const creditFragment = encodeFragmentToken(
      decryptDeliveryToken(
        { algorithm: "aes-256-gcm", keyVersion: 1, nonce: packedCreditRow.nonce, ciphertext: packedCreditRow.ciphertext },
        DELIVERY,
      ),
    );
    const exchangedCredit = await running().app.inject({
      method: "POST",
      url: "/v1/portal/exchange",
      payload: { token: creditFragment },
    });
    expect(exchangedCredit.statusCode).toBe(200);
    expect(exchangedCredit.json().data.purpose).toBe("view_only");
    const creditCookie = `jti_portal=${exchangedCredit.json().data.session as string}`;
    const creditCsrf = exchangedCredit.json().data.csrf_token as string;
    await running().app.inject({
      method: "POST",
      url: "/v1/portal/code/send",
      headers: { cookie: creditCookie, "x-csrf-token": creditCsrf, "content-type": "application/json" },
      payload: {},
    });
    const otpCredit = await running().admin.query<{ nonce: Buffer; ciphertext: Buffer }>(
      `select p.nonce, p.ciphertext
       from commercial.encrypted_delivery_payloads p
       join commercial.delivery_attempts a on a.id = p.delivery_attempt_id
       where a.template_id = 'EMAIL03'
       order by a.created_at desc limit 1`,
    );
    const otpCreditRow = otpCredit.rows[0];
    if (!otpCreditRow) {
      throw new Error("EMAIL03 payload was not found");
    }
    const creditCode = decryptUtf8(
      { algorithm: "aes-256-gcm", keyVersion: 1, nonce: otpCreditRow.nonce, ciphertext: otpCreditRow.ciphertext },
      DELIVERY,
    );
    const verifiedCredit = await running().app.inject({
      method: "POST",
      url: "/v1/portal/code/verify",
      headers: { cookie: creditCookie, "x-csrf-token": creditCsrf, "content-type": "application/json" },
      payload: { code: creditCode },
    });
    expect(verifiedCredit.statusCode).toBe(200);
    const portalCredit = await running().app.inject({
      method: "GET",
      url: "/v1/portal/document",
      headers: { cookie: creditCookie },
    });
    expect(portalCredit.statusCode).toBe(200);
    expect(portalCredit.json().data.number).toBe("CN-000001");
    expect(portalCredit.json().data.revision_label).toBe("R1");
    expect(portalCredit.json().data.pdf_state).toBe("ready");
    expect(portalCredit.json().data.allowed_actions).toEqual(expect.arrayContaining(["download", "report"]));
    const portalDownload = await running().app.inject({
      method: "GET",
      url: "/v1/portal/download",
      headers: { cookie: creditCookie },
    });
    expect(portalDownload.statusCode).toBe(200);
    expect(portalDownload.json().data).toMatchObject({ document_id: creditId, state: "ready" });
    expect(portalDownload.json().data.url).toContain("X-Amz-Expires=300");
    const other = await sign({ sub: AUTH_B, email: "owner.b@example.com" });
    const stolen = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/credits/preview`,
      headers: { authorization: `Bearer ${other}`, "content-type": "application/json" },
      payload: {
        reason: "Billing correction after overbilling labour",
        allocations: [{ invoice_line_id: lineId, net_credit_cents: 2000 }],
      },
    });
    expect(stolen.statusCode).toBe(404);
  }, 90_000);

  it("reverses a payment once, replays after ephemeral expiry, and rejects a second reversal", async () => {
    const token = await sign({ sub: AUTH_B, email: "owner.b@example.com" });
    expect((await completeSetup(token, KEYS.setupB)).statusCode).toBe(200);
    const published = await publishQuote(token, JOB_REVERSE, {
      job: KEYS.job4,
      open: KEYS.open4,
      save: KEYS.save4,
      publish: KEYS.publish4,
    });
    await approveQuote(token, published, KEYS.decide4);
    const preview = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_REVERSE}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    const issued = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_REVERSE}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.issue4,
      },
      payload: { preview_hash: preview.json().data.preview_hash },
    });
    expect(issued.statusCode).toBe(202);
    const invoiceId = issued.json().data.id as string;
    expect(issued.json().data.number).toBe("INV-000001");
    const paid = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/payments`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.payRev,
      },
      payload: { amount_cents: 4000, effective_date: "2026-09-21", method: "cash" },
    });
    expect(paid.statusCode).toBe(200);
    const paymentId = paid.json().data.id as string;
    const reversed = await running().app.inject({
      method: "POST",
      url: `/v1/ledger/${paymentId}/reverse`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.reverse,
      },
      payload: { reason: "Typed the wrong amount" },
    });
    expect(reversed.statusCode).toBe(200);
    expect(reversed.json().data.type).toBe("reversal");
    expect(reversed.json().data.amount_cents).toBe(4000);
    expect(reversed.json().data.reverses_entry_id).toBe(paymentId);
    expect(reversed.json().data.payment_status).toBe("issued_unpaid");
    expect(reversed.json().data.balance_cents).toBe(25980);
    expect(reversed.json().data.effective_payments_cents).toBe(0);
    const firstId = reversed.json().data.id as string;
    const stored = await running().admin.query<{ operation_id: string; permanence: string }>(
      `select operation_id, permanence from commercial.idempotency_records where key = $1`,
      [KEYS.reverse],
    );
    expect(stored.rows[0]?.permanence).toBe("financial");
    const operationId = stored.rows[0]?.operation_id;
    await running().admin.query(`delete from commercial.idempotency_records where permanence = 'ephemeral'`);
    const replay = await running().app.inject({
      method: "POST",
      url: `/v1/ledger/${paymentId}/reverse`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.reverse,
      },
      payload: { reason: "Typed the wrong amount" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(firstId);
    expect(replay.json().data.replayed).toBe(true);
    const afterExpiry = await running().admin.query<{ operation_id: string; n: string }>(
      `select operation_id, count(*)::text as n
       from commercial.idempotency_records
       where key = $1
       group by operation_id`,
      [KEYS.reverse],
    );
    expect(afterExpiry.rows).toHaveLength(1);
    expect(afterExpiry.rows[0]?.operation_id).toBe(operationId);
    const second = await running().app.inject({
      method: "POST",
      url: `/v1/ledger/${paymentId}/reverse`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.reverse2,
      },
      payload: { reason: "Trying again after the first reversal" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("ENTRY_ALREADY_REVERSED");
    const reverseReversal = await running().app.inject({
      method: "POST",
      url: `/v1/ledger/${firstId}/reverse`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.reverse2,
      },
      payload: { reason: "Trying to reverse the reversal" },
    });
    expect(reverseReversal.statusCode).toBe(422);
    const ledger = await running().app.inject({
      method: "GET",
      url: `/v1/invoices/${invoiceId}/ledger`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().data.entries).toHaveLength(2);
    expect(ledger.json().data.entries.map((entry: { type: string }) => entry.type)).toEqual(["payment", "reversal"]);
    expect(ledger.json().data.balance_cents).toBe(25980);
    expect(ledger.json().data.payment_status).toBe("issued_unpaid");
    const analytics = await running().admin.query<{ n: string }>(
      `select count(*)::text as n from commercial.analytics_events
       where event_name = 'payment_recorded' and job_id = $1`,
      [JOB_REVERSE],
    );
    expect(Number(analytics.rows[0]?.n)).toBe(1);
    const other = await sign({ sub: AUTH, email: "owner.i@example.com" });
    const stolen = await running().app.inject({
      method: "POST",
      url: `/v1/ledger/${paymentId}/reverse`,
      headers: {
        authorization: `Bearer ${other}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.reverse,
      },
      payload: { reason: "Typed the wrong amount" },
    });
    expect(stolen.statusCode).toBe(404);
  }, 60_000);

  it("blocks reversing a payment while an effective dependent refund remains", async () => {
    const token = await sign({ sub: AUTH_B, email: "owner.b@example.com" });
    const published = await publishQuote(token, JOB_REVERSE_DEP, {
      job: KEYS.job5,
      open: KEYS.open5,
      save: KEYS.save5,
      publish: KEYS.publish5,
    });
    await approveQuote(token, published, KEYS.decide5);
    const preview = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_REVERSE_DEP}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    const issued = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_REVERSE_DEP}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.issue5,
      },
      payload: { preview_hash: preview.json().data.preview_hash },
    });
    expect(issued.statusCode).toBe(202);
    const invoiceId = issued.json().data.id as string;
    expect(issued.json().data.number).toBe("INV-000002");
    const paid = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/payments`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.payDep,
      },
      payload: { amount_cents: 25980, effective_date: "2026-09-21", method: "cash" },
    });
    expect(paid.statusCode).toBe(200);
    const paymentId = paid.json().data.id as string;
    const overpay = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/payments`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.overpayDep,
      },
      payload: {
        amount_cents: 2000,
        effective_date: "2026-09-21",
        method: "check",
        confirm_overpayment: true,
      },
    });
    expect(overpay.statusCode).toBe(200);
    const refund = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoiceId}/refunds`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.refundDep,
      },
      payload: { amount_cents: 2000, effective_date: "2026-09-21", method: "cash" },
    });
    expect(refund.statusCode).toBe(200);
    const refundId = refund.json().data.id as string;
    const blocked = await running().app.inject({
      method: "POST",
      url: `/v1/ledger/${paymentId}/reverse`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.reversePayDep,
      },
      payload: { reason: "Want to void after refunding" },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe("VALIDATION_FAILED");
    const refundReversed = await running().app.inject({
      method: "POST",
      url: `/v1/ledger/${refundId}/reverse`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.reverseRefundDep,
      },
      payload: { reason: "Refund was recorded in error" },
    });
    expect(refundReversed.statusCode).toBe(200);
    expect(refundReversed.json().data.type).toBe("reversal");
    expect(refundReversed.json().data.reverses_entry_id).toBe(refundId);
    const afterCorrection = await running().app.inject({
      method: "POST",
      url: `/v1/ledger/${paymentId}/reverse`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.reversePayDep,
      },
      payload: { reason: "Want to void after refunding" },
    });
    expect(afterCorrection.statusCode).toBe(200);
    expect(afterCorrection.json().data.reverses_entry_id).toBe(paymentId);
    const ledger = await running().app.inject({
      method: "GET",
      url: `/v1/invoices/${invoiceId}/ledger`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().data.entries).toHaveLength(5);
    expect(ledger.json().data.effective_payments_cents).toBe(2000);
    expect(ledger.json().data.effective_refunds_cents).toBe(0);
    expect(ledger.json().data.balance_cents).toBe(23980);
    expect(ledger.json().data.payment_status).toBe("partially_paid");
  }, 60_000);

  it("voids an unpaid invoice, blocks replay races, and issues a replacement", async () => {
    const token = await sign({ sub: AUTH_C, email: "owner.c@example.com" });
    expect((await completeSetup(token, KEYS.setupC)).statusCode).toBe(200);
    const issued = await issueInvoice(token, JOB_VOID, {
      job: KEYS.jobVoid,
      open: KEYS.openVoid,
      save: KEYS.saveVoid,
      publish: KEYS.publishVoid,
      decide: KEYS.decideVoid,
      issue: KEYS.issueVoid,
    });
    expect(issued.number).toBe("INV-000001");
    const originalSha = issued.snapshot_sha256;
    const packed = await running().admin.query<{ nonce: Buffer; ciphertext: Buffer }>(
      `select p.nonce, p.ciphertext
       from commercial.encrypted_delivery_payloads p
       join commercial.delivery_attempts a on a.id = p.delivery_attempt_id
       where a.request_id = $1 and a.template_id = 'EMAIL06'`,
      [issued.request_id],
    );
    await completePdf(issued.id);
    const packedRow = packed.rows[0];
    if (!packedRow) {
      throw new Error("EMAIL06 payload was not found");
    }
    const fragment = encodeFragmentToken(
      decryptDeliveryToken(
        { algorithm: "aes-256-gcm", keyVersion: 1, nonce: packedRow.nonce, ciphertext: packedRow.ciphertext },
        DELIVERY,
      ),
    );
    const exchanged = await running().app.inject({ method: "POST", url: "/v1/portal/exchange", payload: { token: fragment } });
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json().data.purpose).toBe("view_only");

    const [first, second] = await Promise.all([
      running().app.inject({
        method: "POST",
        url: `/v1/invoices/${issued.id}/void`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": KEYS.voidKey,
        },
        payload: { reason: "Wrong customer email typed" },
      }),
      running().app.inject({
        method: "POST",
        url: `/v1/invoices/${issued.id}/void`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": KEYS.voidDup,
        },
        payload: { reason: "Wrong customer email typed" },
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = first.statusCode === 200 ? first : second;
    expect(winner.json().data.lifecycle).toBe("voided");
    expect(winner.json().data.voided).toBe(true);
    expect(winner.json().data.number).toBe("INV-000001");
    const replay = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${issued.id}/void`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.voidKey,
      },
      payload: { reason: "Wrong customer email typed" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(issued.id);
    const mismatch = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${issued.id}/void`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.voidKey,
      },
      payload: { reason: "Different void reason now" },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
    const already = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${issued.id}/void`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.voidReplay,
      },
      payload: { reason: "Trying to void again" },
    });
    expect(already.statusCode).toBe(409);
    expect(already.json().error.code).toBe("DOCUMENT_IMMUTABLE");
    const afterPortal = await running().app.inject({
      method: "POST",
      url: "/v1/portal/exchange",
      payload: { token: fragment },
    });
    expect(afterPortal.statusCode).toBe(404);
    expect(afterPortal.json().error.code).toBe("REQUEST_UNAVAILABLE");
    const emails = await running().admin.query<{ n: string }>(
      `select count(*)::text as n from commercial.delivery_attempts
       where document_id = $1 and template_id = 'EMAIL08'`,
      [issued.id],
    );
    expect(Number(emails.rows[0]?.n)).toBe(1);
    const original = await running().admin.query<{ sha: string; number: string; lifecycle: string }>(
      `select snapshot_sha256 as sha, number, lifecycle from commercial.documents where id = $1`,
      [issued.id],
    );
    expect(original.rows[0]?.sha).toBe(originalSha);
    expect(original.rows[0]?.number).toBe("INV-000001");
    expect(original.rows[0]?.lifecycle).toBe("voided");
    const ledger = await running().app.inject({
      method: "GET",
      url: `/v1/invoices/${issued.id}/ledger`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().data.entries).toEqual([]);
    expect(ledger.json().data.voided).toBe(true);
    const job = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB_VOID}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(job.json().data.active_invoice).toBeNull();
    expect(job.json().data.permitted_actions).toContain("create_replacement");
    const preview = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${issued.id}/replacement-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { customer: { name: "Riley Chen", email: "fixed@example.com" } },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.snapshot.net_cents).toBe(24000);
    expect(preview.json().data.prior_document_id).toBe(issued.id);
    const replacement = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${issued.id}/issue-replacement`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.replaceIssue,
      },
      payload: { preview_hash: preview.json().data.preview_hash },
    });
    expect(replacement.statusCode).toBe(202);
    expect(replacement.json().data.number).toBe("INV-000002");
    expect(replacement.json().data.id).not.toBe(issued.id);
    const retry = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${issued.id}/issue-replacement`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.replaceIssue,
      },
      payload: { preview_hash: preview.json().data.preview_hash },
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().data.id).toBe(replacement.json().data.id);
    const linked = await running().admin.query<{ prior: string; active: string | null }>(
      `select d.prior_document_id::text as prior, j.active_invoice_id::text as active
       from commercial.documents d
       join commercial.jobs j on j.id = d.job_id
       where d.id = $1`,
      [replacement.json().data.id],
    );
    expect(linked.rows[0]?.prior).toBe(issued.id);
    expect(linked.rows[0]?.active).toBe(replacement.json().data.id);
    const other = await sign({ sub: AUTH_D, email: "owner.d@example.com" });
    expect((await completeSetup(other, KEYS.setupD)).statusCode).toBe(200);
    const stolen = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${issued.id}/void`,
      headers: {
        authorization: `Bearer ${other}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.voidKey,
      },
      payload: { reason: "Wrong customer email typed" },
    });
    expect(stolen.statusCode).toBe(404);
  }, 60_000);

  it("rejects void when an unreversed payment remains", async () => {
    const token = await sign({ sub: AUTH_C, email: "owner.c@example.com" });
    const issued = await issueInvoice(token, JOB_VOID_PAY, {
      job: KEYS.jobVoidPay,
      open: KEYS.openVoidPay,
      save: KEYS.saveVoidPay,
      publish: KEYS.publishVoidPay,
      decide: KEYS.decideVoidPay,
      issue: KEYS.issueVoidPay,
    });
    const paid = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${issued.id}/payments`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.payVoid,
      },
      payload: { amount_cents: 4000, effective_date: "2026-09-21", method: "cash" },
    });
    expect(paid.statusCode).toBe(200);
    const blocked = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${issued.id}/void`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.voidPay,
      },
      payload: { reason: "Want to void after taking money" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("LEDGER_BLOCKS_VOID");
    const ledger = await running().app.inject({
      method: "GET",
      url: `/v1/invoices/${issued.id}/ledger`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ledger.json().data.entries).toHaveLength(1);
    expect(ledger.json().data.effective_payments_cents).toBe(4000);
    const after = await running().admin.query<{ lifecycle: string }>(
      `select lifecycle from commercial.documents where id = $1`,
      [issued.id],
    );
    expect(after.rows[0]?.lifecycle).toBe("issued");
  }, 60_000);

  it("rejects void when an issued credit remains", async () => {
    const token = await sign({ sub: AUTH_C, email: "owner.c@example.com" });
    const issued = await issueInvoice(token, JOB_VOID_CREDIT, {
      job: KEYS.jobVoidCredit,
      open: KEYS.openVoidCredit,
      save: KEYS.saveVoidCredit,
      publish: KEYS.publishVoidCredit,
      decide: KEYS.decideVoidCredit,
      issue: KEYS.issueVoidCredit,
    });
    const ledger = await running().app.inject({
      method: "GET",
      url: `/v1/invoices/${issued.id}/ledger`,
      headers: { authorization: `Bearer ${token}` },
    });
    const lineId = ledger.json().data.credit_sources[0].invoice_line_id as string;
    const preview = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${issued.id}/credits/preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { reason: "Scope reduced after issue", allocations: [{ invoice_line_id: lineId, net_credit_cents: 2000 }] },
    });
    expect(preview.statusCode).toBe(200);
    const credit = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${issued.id}/credits`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.creditVoid,
      },
      payload: { preview_hash: preview.json().data.preview_hash },
    });
    expect(credit.statusCode).toBe(202);
    const blocked = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${issued.id}/void`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEYS.voidCredit,
      },
      payload: { reason: "Want to void after credit" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("LEDGER_BLOCKS_VOID");
    const credits = await running().admin.query<{ n: string }>(
      `select count(*)::text as n from commercial.documents
       where prior_document_id = $1 and kind = 'credit' and lifecycle = 'issued'`,
      [issued.id],
    );
    expect(Number(credits.rows[0]?.n)).toBe(1);
    const after = await running().admin.query<{ lifecycle: string }>(
      `select lifecycle from commercial.documents where id = $1`,
      [issued.id],
    );
    expect(after.rows[0]?.lifecycle).toBe("issued");
  }, 60_000);
});
