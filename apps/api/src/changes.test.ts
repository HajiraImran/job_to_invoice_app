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
const AUTH_B = "51515151-5151-4151-8151-515151515152";
const JOB = "52525252-5252-4252-8252-525252525251";
const JOB_B = "52525252-5252-4252-8252-525252525252";
const JOB_DECLINE = "52525252-5252-4252-8252-525252525253";
const JOB_RACE = "52525252-5252-4252-8252-525252525254";
const DELIVERY = parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", "delivery-key-material-ok");

function setupBody(email: string) {
  return {
    business_name: "Change Co",
    legal_name: "Change Co LLC",
    contact_name: "Owner C",
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

describe("change order API", () => {
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
      logQuotePublish: () => undefined,
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
      throw new Error("change test app did not start");
    }
    return { app, admin };
  }

  async function completeSetup(token: string, email: string, key: string) {
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
      payload: setupBody(email),
    });
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

  async function fragmentToken(requestId: string, templateId: string) {
    const row = await running().admin.query<{ nonce: Buffer; ciphertext: Buffer }>(
      `select p.nonce, p.ciphertext
       from commercial.encrypted_delivery_payloads p
       join commercial.delivery_attempts a on a.id = p.delivery_attempt_id
       where a.request_id = $1 and a.template_id = $2`,
      [requestId, templateId],
    );
    const first = row.rows[0];
    if (!first) {
      throw new Error(`missing ${templateId} payload`);
    }
    return encodeFragmentToken(
      decryptDeliveryToken(
        { algorithm: "aes-256-gcm", keyVersion: 1, nonce: first.nonce, ciphertext: first.ciphertext },
        DELIVERY,
      ),
    );
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
    const pdf = Buffer.from("%PDF-1.4 change");
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

  async function generatePdfThroughWorkerPath(documentId: string): Promise<string> {
    const task = await running().admin.query<{ id: string }>(
      `select id from commercial.outbox_tasks where aggregate_id = $1 and task_type = 'generate_original_pdf'`,
      [documentId],
    );
    const taskId = task.rows[0]?.id;
    if (!taskId) {
      throw new Error("missing generate_original_pdf task");
    }
    const pdf = Buffer.from("%PDF-1.4 change");
    await running().admin.query("begin");
    try {
      await running().admin.query("set local role worker_app");
      const claimed = await running().admin.query<{ id: string; workspace_id: string; created_by: string }>(
        "select id, workspace_id, created_by from commercial.claim_generate_original_pdf()",
      );
      expect(claimed.rows[0]?.id).toBe(taskId);
      const row = claimed.rows[0];
      if (!row) {
        throw new Error("change PDF task was not claimed");
      }
      await running().admin.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
        row.workspace_id,
        row.created_by,
      ]);
      const source = await running().admin.query<{ revision_no: number; snapshot_json: { kind: string } }>(
        "select revision_no, snapshot_json from commercial.load_original_pdf_source($1::uuid)",
        [taskId],
      );
      expect(source.rows[0]?.snapshot_json.kind).toBe("change");
      const reserved = await running().admin.query<{ artifact_id: string }>(
        "select commercial.reserve_original_pdf_artifact($1::uuid) as artifact_id",
        [taskId],
      );
      const artifactId = reserved.rows[0]?.artifact_id;
      if (!artifactId) {
        throw new Error("change PDF artifact was not reserved");
      }
      const objectKey = originalPdfObjectKey({
        workspaceId: row.workspace_id,
        documentId,
        revision: source.rows[0]?.revision_no ?? 0,
        artifactId,
      });
      await running().admin.query("select commercial.complete_original_pdf($1::uuid, $2::uuid, $3, $4, $5::bigint)", [
        taskId,
        artifactId,
        objectKey,
        createHash("sha256").update(pdf).digest("hex"),
        pdf.byteLength,
      ]);
      await running().admin.query("commit");
      return objectKey;
    } catch (error) {
      await running().admin.query("rollback");
      throw error;
    }
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
    const verified = await running().app.inject({
      method: "POST",
      url: "/v1/portal/code/verify",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      payload: { code },
    });
    expect(verified.statusCode).toBe(200);
    return { cookie, csrf: verified.json().data.csrf_token as string };
  }

  async function approveDocument(published: { id: string; request_id: string; snapshot_sha256: string }, templateId: string) {
    await completePdf(published.id);
    const fragment = await fragmentToken(published.request_id, templateId);
    const session = await verifySession(fragment);
    const decided = await running().app.inject({
      method: "POST",
      url: "/v1/portal/decision",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
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
    return decided;
  }

  async function publishChange(
    token: string,
    jobId: string,
    body: Record<string, unknown>,
    keys: { open: string; save: string; publish: string },
  ) {
    const opened = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/changes`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": keys.open },
    });
    expect(opened.statusCode).toBe(200);
    const saved = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${opened.json().data.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": keys.save,
        "if-match": String(opened.json().data.version),
      },
      payload: {
        ...body,
        expected_scope_version: opened.json().data.expected_scope_version,
      },
    });
    expect(saved.statusCode).toBe(200);
    const previewed = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${saved.json().data.id}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(saved.json().data.version) },
    });
    expect(previewed.statusCode).toBe(200);
    const published = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${saved.json().data.id}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": keys.publish,
        "if-match": String(saved.json().data.version),
      },
      payload: { preview_hash: previewed.json().data.preview_hash, recipient_email: "customer@example.com" },
    });
    return { opened, saved, previewed, published };
  }

  it("creates, previews, publishes, and approves extra work once into invoice residual", async () => {
    const token = await sign({ sub: AUTH, email: "change.owner@example.com" });
    await completeSetup(token, "change.owner@example.com", "53535353-5353-4353-8353-535353535351");
    const quote = await publishQuote(token, JOB, {
      job: "53535353-5353-4353-8353-535353535352",
      open: "53535353-5353-4353-8353-535353535353",
      save: "53535353-5353-4353-8353-535353535354",
      publish: "53535353-5353-4353-8353-535353535355",
    });
    expect(quote.number).toMatch(/^Q-/);
    await approveDocument(quote, "EMAIL01");

    const tooSoon = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/changes`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(tooSoon.statusCode).toBe(422);

    const opened = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/changes`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "53535353-5353-4353-8353-535353535356" },
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().data.kind).toBe("change");
    expect(opened.json().data.previous_total_cents).toBe(25980);
    const expectedScope = opened.json().data.expected_scope_version as number;
    const replay = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/changes`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "53535353-5353-4353-8353-535353535356" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(opened.json().data.id);
    const mismatch = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_B}/changes`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "53535353-5353-4353-8353-535353535356" },
    });
    expect(mismatch.statusCode).toBe(409);

    const invalid = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${opened.json().data.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "53535353-5353-4353-8353-535353535357",
        "if-match": String(opened.json().data.version),
      },
      payload: {
        reason: "bad",
        expected_scope_version: expectedScope,
        additions: [
          {
            client_line_id: randomUUID(),
            description: "Handle",
            unit: "item",
            quantity: "1",
            unit_price_cents: 10.5,
            discount_cents: 0,
            tax_bp: 825,
          },
        ],
        reductions: [],
      },
    });
    expect(invalid.statusCode).toBe(422);

    const addition = {
      reason: "Customer requested a second handle",
      expected_scope_version: expectedScope,
      expiry_days: 14,
      additions: [
        {
          client_line_id: randomUUID(),
          description: "Supply and fit second door handle",
          unit: "item",
          quantity: "1",
          unit_price_cents: 10000,
          discount_cents: 0,
          tax_bp: 825,
        },
      ],
      reductions: [],
    };
    const saved = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${opened.json().data.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "53535353-5353-4353-8353-535353535358",
        "if-match": String(opened.json().data.version),
      },
      payload: addition,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.change_including_tax_cents).toBe(10825);
    expect(saved.json().data.new_agreed_total_cents).toBe(36805);

    const previewed = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${saved.json().data.id}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(saved.json().data.version) },
    });
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json().data.snapshot.kind).toBe("change");
    expect(previewed.json().data.snapshot.previous_total_cents).toBe(25980);
    expect(previewed.json().data.snapshot.change_including_tax_cents).toBe(10825);
    expect(previewed.json().data.snapshot.new_agreed_total_cents).toBe(36805);

    const published = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${saved.json().data.id}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "53535353-5353-4353-8353-535353535359",
        "if-match": String(saved.json().data.version),
      },
      payload: { preview_hash: previewed.json().data.preview_hash, recipient_email: "customer@example.com" },
    });
    expect(published.statusCode).toBe(202);
    expect(published.json().data.kind).toBe("change");
    expect(published.json().data.number).toBe("CO-000001");
    const replayPublish = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${saved.json().data.id}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "53535353-5353-4353-8353-535353535359",
        "if-match": String(saved.json().data.version),
      },
      payload: { preview_hash: previewed.json().data.preview_hash, recipient_email: "customer@example.com" },
    });
    expect(replayPublish.statusCode).toBe(202);
    expect(replayPublish.json().data.id).toBe(published.json().data.id);
    const emails = await running().admin.query<{ n: number }>(
      "select count(*)::int as n from commercial.delivery_attempts where document_id = $1 and template_id = 'EMAIL02'",
      [published.json().data.id],
    );
    expect(emails.rows[0]?.n).toBe(1);

    await running().admin.query("update commercial.workspaces set default_tax_bp = 2000 where owner_user_id = $1", [
      AUTH,
    ]);
    const loaded = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${published.json().data.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(loaded.json().data.snapshot.change_including_tax_cents).toBe(10825);
    expect(loaded.json().data.snapshot.additions[0]?.tax_bp).toBe(825);

    const job = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(job.json().data.latest_change.number).toBe("CO-000001");
    expect(job.json().data.latest_change.lifecycle).toBe("issued");
    expect(job.json().data.latest_change.additions).toEqual([
      expect.objectContaining({ description: "Supply and fit second door handle", total_cents: 10825 }),
    ]);
    expect(job.json().data.change_draft).toBeNull();
    expect(job.json().data.permitted_actions).toContain("create_change");

    const pendingPreview = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(pendingPreview.statusCode).toBe(409);
    expect(pendingPreview.json().error.code).toBe("UNRESOLVED_CHANGES");
    expect(pendingPreview.json().error.message).toBe(
      "The extra-work request is still waiting for the customer to approve it. Wait for that decision before invoicing.",
    );
    expect(pendingPreview.json().error.field_errors).toEqual([
      { field: "approval_request", message: "Wait for the customer to approve the pending request before invoicing." },
    ]);

    const fragment = await fragmentToken(published.json().data.request_id, "EMAIL02");
    expect(JSON.stringify(published.json())).not.toContain(fragment);
    const session = await verifySession(fragment);
    const preparing = await running().app.inject({
      method: "GET",
      url: "/v1/portal/document",
      headers: { cookie: session.cookie },
    });
    expect(preparing.statusCode).toBe(200);
    expect(preparing.json().data.pdf_state).toBe("preparing");
    expect(preparing.json().data.allowed_actions).not.toContain("approve");

    const objectKey = await generatePdfThroughWorkerPath(published.json().data.id);
    const artifacts = await running().admin.query(
      "select object_key, template_version, state from commercial.artifacts where document_id = $1 and type = 'original_pdf'",
      [published.json().data.id],
    );
    expect(artifacts.rows).toEqual([{ object_key: objectKey, template_version: "change-original-v1", state: "ready" }]);
    const document = await running().app.inject({
      method: "GET",
      url: "/v1/portal/document",
      headers: { cookie: session.cookie },
    });
    expect(document.statusCode).toBe(200);
    expect(document.json().data.snapshot.kind).toBe("change");
    expect(document.json().data.pdf_state).toBe("ready");
    expect(document.json().data.allowed_actions).toEqual(expect.arrayContaining(["approve", "decline"]));
    expect(document.json().data.consent_text).toContain("approve it");
    expect(JSON.stringify(document.json())).not.toContain(fragment);
    const download = await running().app.inject({
      method: "GET",
      url: "/v1/portal/download",
      headers: { cookie: session.cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.json().data).toMatchObject({ document_id: published.json().data.id, state: "ready" });
    expect(download.json().data.url).toContain(encodeURIComponent(objectKey));

    const decided = await running().app.inject({
      method: "POST",
      url: "/v1/portal/decision",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
        "idempotency-key": "54545454-5454-4454-8454-545454545451",
      },
      payload: {
        decision: "approve",
        signer_name: "Riley Chen",
        consent_version: "apr04.v1",
        consent_accepted: true,
        snapshot_sha256: published.json().data.snapshot_sha256,
      },
    });
    expect(decided.statusCode).toBe(200);
    const replayDecision = await running().app.inject({
      method: "POST",
      url: "/v1/portal/decision",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
        "idempotency-key": "54545454-5454-4454-8454-545454545451",
      },
      payload: {
        decision: "approve",
        signer_name: "Riley Chen",
        consent_version: "apr04.v1",
        consent_accepted: true,
        snapshot_sha256: published.json().data.snapshot_sha256,
      },
    });
    expect(replayDecision.statusCode).toBe(200);

    const approvedDoc = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${published.json().data.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(approvedDoc.statusCode).toBe(200);
    expect(approvedDoc.json().data.lifecycle).toBe("accepted");
    const ownerPdf = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${published.json().data.id}/download`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ownerPdf.statusCode).toBe(200);
    expect(ownerPdf.json().data.state).toBe("ready");
    expect(ownerPdf.json().data.url).toEqual(expect.any(String));

    const scope = await running().admin.query<{ n: number }>(
      "select count(*)::int as n from commercial.scope_entries where accepted_document_id = $1 and event_kind = 'add'",
      [published.json().data.id],
    );
    expect(scope.rows[0]?.n).toBe(1);

    const invoicePreview = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(invoicePreview.statusCode).toBe(200);
    expect(invoicePreview.json().data.snapshot.total_cents).toBe(36805);
    expect(invoicePreview.json().data.snapshot.lines).toHaveLength(2);
    expect(
      invoicePreview.json().data.snapshot.lines.filter(
        (line: { description: string }) => line.description === "Supply and fit second door handle",
      ),
    ).toHaveLength(1);

    const leftover = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/changes`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "53535353-5353-4353-8353-535353535364" },
    });
    expect(leftover.statusCode).toBe(200);
    expect(leftover.json().data.additions).toEqual([]);
    const leftoverJob = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(leftoverJob.json().data.change_draft.additions_count).toBe(0);
    expect(leftoverJob.json().data.change_draft.reductions_count).toBe(0);
    expect(leftoverJob.json().data.latest_change.lifecycle).toBe("accepted");
    const leftoverPreview = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(leftoverPreview.statusCode).toBe(200);
    expect(leftoverPreview.json().data.snapshot.total_cents).toBe(36805);
    expect(
      leftoverPreview.json().data.snapshot.lines.filter(
        (line: { description: string }) => line.description === "Supply and fit second door handle",
      ),
    ).toHaveLength(1);

    const other = await sign({ sub: AUTH_B, email: "change.other@example.com" });
    await completeSetup(other, "change.other@example.com", "53535353-5353-4353-8353-535353535360");
    const hidden = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${published.json().data.id}`,
      headers: { authorization: `Bearer ${other}` },
    });
    expect(hidden.statusCode).toBe(404);
    const steal = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/changes`,
      headers: { authorization: `Bearer ${other}`, "idempotency-key": "53535353-5353-4353-8353-535353535361" },
    });
    expect(steal.statusCode).toBe(404);

    const issued = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "53535353-5353-4353-8353-535353535362",
      },
      payload: { preview_hash: invoicePreview.json().data.preview_hash },
    });
    expect(issued.statusCode).toBe(202);
    const blocked = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/changes`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "53535353-5353-4353-8353-535353535363" },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe("VALIDATION_FAILED");
  }, 120_000);

  it("declines a change without adding invoice residual and rejects concurrent second decisions", async () => {
    const token = await sign({ sub: AUTH, email: "change.owner@example.com" });
    const quote = await publishQuote(token, JOB_DECLINE, {
      job: "55555555-5555-4555-8555-555555555551",
      open: "55555555-5555-4555-8555-555555555552",
      save: "55555555-5555-4555-8555-555555555553",
      publish: "55555555-5555-4555-8555-555555555554",
    });
    await approveDocument(quote, "EMAIL01");
    const source = await running().admin.query<{ id: string }>(
      `select dl.id
       from commercial.document_lines dl
       join commercial.documents d on d.id = dl.document_id
       where d.job_id = $1 and d.kind = 'quote'`,
      [JOB_DECLINE],
    );
    const published = await publishChange(
      token,
      JOB_DECLINE,
      {
        reason: "Customer asked to reduce labour",
        expected_scope_version: 1,
        expiry_days: 14,
        additions: [],
        reductions: [{ source_line_id: source.rows[0]?.id ?? "", net_credit_cents: 1000 }],
      },
      {
        open: "55555555-5555-4555-8555-555555555555",
        save: "55555555-5555-4555-8555-555555555556",
        publish: "55555555-5555-4555-8555-555555555557",
      },
    );
    expect(published.published.statusCode).toBe(202);
    await completePdf(published.published.json().data.id);
    const fragment = await fragmentToken(published.published.json().data.request_id, "EMAIL02");
    const session = await verifySession(fragment);
    const declined = await running().app.inject({
      method: "POST",
      url: "/v1/portal/decision",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
        "idempotency-key": "55555555-5555-4555-8555-555555555558",
      },
      payload: {
        decision: "decline",
        signer_name: "Riley Chen",
        consent_version: "apr04.v1",
        snapshot_sha256: published.published.json().data.snapshot_sha256,
        comment: "Not needed",
      },
    });
    expect(declined.statusCode).toBe(200);
    const scope = await running().admin.query<{ n: number }>(
      "select count(*)::int as n from commercial.scope_entries where accepted_document_id = $1",
      [published.published.json().data.id],
    );
    expect(scope.rows[0]?.n).toBe(0);
    const invoicePreview = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_DECLINE}/invoice-preview`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(invoicePreview.statusCode).toBe(200);
    expect(invoicePreview.json().data.snapshot.total_cents).toBe(25980);
    expect(invoicePreview.json().data.snapshot.lines).toHaveLength(1);
  }, 120_000);

  it("keeps one authoritative result for concurrent change decisions", async () => {
    const token = await sign({ sub: AUTH, email: "change.owner@example.com" });
    const quote = await publishQuote(token, JOB_RACE, {
      job: "56565656-5656-4656-8656-565656565651",
      open: "56565656-5656-4656-8656-565656565652",
      save: "56565656-5656-4656-8656-565656565653",
      publish: "56565656-5656-4656-8656-565656565654",
    });
    await approveDocument(quote, "EMAIL01");
    const published = await publishChange(
      token,
      JOB_RACE,
      {
        reason: "Add a matching hinge",
        expected_scope_version: 1,
        expiry_days: 14,
        additions: [
          {
            client_line_id: randomUUID(),
            description: "Matching hinge",
            unit: "item",
            quantity: "1",
            unit_price_cents: 2000,
            discount_cents: 0,
            tax_bp: 0,
          },
        ],
        reductions: [],
      },
      {
        open: "56565656-5656-4656-8656-565656565655",
        save: "56565656-5656-4656-8656-565656565656",
        publish: "56565656-5656-4656-8656-565656565657",
      },
    );
    await completePdf(published.published.json().data.id);
    const fragment = await fragmentToken(published.published.json().data.request_id, "EMAIL02");
    const first = await verifySession(fragment);
    const second = await verifySession(fragment);
    const payload = {
      decision: "approve",
      signer_name: "Riley Chen",
      consent_version: "apr04.v1",
      consent_accepted: true,
      snapshot_sha256: published.published.json().data.snapshot_sha256,
    };
    const [a, b] = await Promise.all([
      running().app.inject({
        method: "POST",
        url: "/v1/portal/decision",
        headers: {
          cookie: first.cookie,
          "x-csrf-token": first.csrf,
          "content-type": "application/json",
          "idempotency-key": "56565656-5656-4656-8656-565656565658",
        },
        payload,
      }),
      running().app.inject({
        method: "POST",
        url: "/v1/portal/decision",
        headers: {
          cookie: second.cookie,
          "x-csrf-token": second.csrf,
          "content-type": "application/json",
          "idempotency-key": "56565656-5656-4656-8656-565656565659",
        },
        payload,
      }),
    ]);
    const codes = [a.statusCode, b.statusCode];
    expect(codes).toContain(200);
    expect(codes.every((code) => [200, 404, 409].includes(code))).toBe(true);
    const decisions = await running().admin.query<{ n: number }>(
      "select count(*)::int as n from commercial.approval_decisions where document_id = $1",
      [published.published.json().data.id],
    );
    expect(decisions.rows[0]?.n).toBe(1);
  }, 120_000);

  it("refreshes a missing recipient into the preview and refuses a second send", async () => {
    const token = await sign({ sub: AUTH, email: "change.owner@example.com" });
    const other = await sign({ sub: AUTH_B, email: "change.other@example.com" });
    const opened = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_DECLINE}/changes`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "57575757-5757-4757-8757-575757575755" },
    });
    expect(opened.statusCode).toBe(200);
    const stale = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${opened.json().data.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "57575757-5757-4757-8757-575757575756",
        "if-match": String(opened.json().data.version),
      },
      payload: {
        reason: "Add a shelf",
        expected_scope_version: opened.json().data.expected_scope_version,
        expiry_days: 14,
        additions: [
          {
            client_line_id: randomUUID(),
            description: "Shelf",
            unit: "item",
            quantity: "1",
            unit_price_cents: 5000,
            discount_cents: 0,
            tax_bp: 0,
          },
        ],
        reductions: [],
      },
    });
    expect(stale.statusCode).toBe(200);
    const conflict = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${opened.json().data.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "57575757-5757-4757-8757-575757575757",
        "if-match": String(opened.json().data.version),
      },
      payload: {
        reason: "Add a shelf",
        expected_scope_version: opened.json().data.expected_scope_version,
        expiry_days: 14,
        additions: [
          {
            client_line_id: randomUUID(),
            description: "Shelf",
            unit: "item",
            quantity: "1",
            unit_price_cents: 5000,
            discount_cents: 0,
            tax_bp: 0,
          },
        ],
        reductions: [],
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("VERSION_CONFLICT");
    const previewed = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${opened.json().data.id}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(stale.json().data.version) },
    });
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json().data.snapshot.customer.email).toBeNull();
    const hidden = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${opened.json().data.id}/preview`,
      headers: { authorization: `Bearer ${other}`, "if-match": String(stale.json().data.version) },
    });
    expect(hidden.statusCode).toBe(404);
    const beforeSend = await running().admin.query<{ changes: number; pending: number; emails: number }>(
      `select
         (select count(*)::int from commercial.documents where job_id = $1 and kind = 'change') as changes,
         (select count(*)::int from commercial.approval_requests where job_id = $1 and state = 'pending') as pending,
         (select count(*)::int from commercial.delivery_attempts where template_id = 'EMAIL02' and request_id in (
            select id from commercial.approval_requests where job_id = $1
         )) as emails`,
      [JOB_DECLINE],
    );
    const baseline = beforeSend.rows[0];
    if (!baseline) {
      throw new Error("missing change baseline");
    }
    expect(baseline.pending).toBe(0);
    const job = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB_DECLINE}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const customer = await running().app.inject({
      method: "GET",
      url: `/v1/customers/${job.json().data.customer_id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(customer.statusCode).toBe(200);
    expect(customer.json().data.email).toBeNull();
    const patched = await running().app.inject({
      method: "PATCH",
      url: `/v1/customers/${job.json().data.customer_id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "57575757-5757-4757-8757-575757575758",
        "if-match": String(customer.json().data.version),
      },
      payload: { email: "shelf.customer@example.com" },
    });
    expect(patched.statusCode).toBe(200);
    const refreshed = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${opened.json().data.id}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(stale.json().data.version) },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().data.snapshot.customer.email).toBe("shelf.customer@example.com");
    await running().admin.query("set role migrator");
    try {
      await running().admin.query(
        "update commercial.document_drafts set preview_expires_at = now() - interval '1 minute' where id = $1",
        [opened.json().data.id],
      );
    } finally {
      await running().admin.query("reset role");
    }
    const expired = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${opened.json().data.id}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "57575757-5757-4757-8757-575757575759",
        "if-match": String(stale.json().data.version),
      },
      payload: {
        preview_hash: refreshed.json().data.preview_hash,
        recipient_email: "shelf.customer@example.com",
      },
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error.code).toBe("PREVIEW_CHANGED");
    const current = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${opened.json().data.id}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(stale.json().data.version) },
    });
    expect(current.statusCode).toBe(200);
    const published = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${opened.json().data.id}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "57575757-5757-4757-8757-575757575760",
        "if-match": String(stale.json().data.version),
      },
      payload: {
        preview_hash: current.json().data.preview_hash,
        recipient_email: current.json().data.snapshot.customer.email,
      },
    });
    expect(published.statusCode).toBe(202);
    const replayedDraft = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${opened.json().data.id}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "57575757-5757-4757-8757-575757575761",
        "if-match": String(stale.json().data.version),
      },
      payload: {
        preview_hash: current.json().data.preview_hash,
        recipient_email: "shelf.customer@example.com",
      },
    });
    expect(replayedDraft.statusCode).not.toBe(202);
    const again = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_DECLINE}/changes`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "57575757-5757-4757-8757-575757575762" },
    });
    expect(again.statusCode).toBe(200);
    const againSaved = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${again.json().data.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "57575757-5757-4757-8757-575757575763",
        "if-match": String(again.json().data.version),
      },
      payload: {
        reason: "Add another shelf",
        expected_scope_version: again.json().data.expected_scope_version,
        expiry_days: 14,
        additions: [
          {
            client_line_id: randomUUID(),
            description: "Second shelf",
            unit: "item",
            quantity: "1",
            unit_price_cents: 1000,
            discount_cents: 0,
            tax_bp: 0,
          },
        ],
        reductions: [],
      },
    });
    expect(againSaved.statusCode).toBe(200);
    const againPreview = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${again.json().data.id}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(againSaved.json().data.version) },
    });
    expect(againPreview.statusCode).toBe(200);
    const blocked = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${again.json().data.id}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "57575757-5757-4757-8757-575757575764",
        "if-match": String(againSaved.json().data.version),
      },
      payload: {
        preview_hash: againPreview.json().data.preview_hash,
        recipient_email: "shelf.customer@example.com",
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("APPROVAL_PENDING");
    const afterSend = await running().admin.query<{ changes: number; pending: number; emails: number }>(
      `select
         (select count(*)::int from commercial.documents where job_id = $1 and kind = 'change') as changes,
         (select count(*)::int from commercial.approval_requests where job_id = $1 and state = 'pending') as pending,
         (select count(*)::int from commercial.delivery_attempts where template_id = 'EMAIL02' and document_id = $2) as emails`,
      [JOB_DECLINE, published.json().data.id],
    );
    expect(afterSend.rows[0]).toEqual({
      changes: baseline.changes + 1,
      pending: 1,
      emails: 1,
    });
  }, 120_000);
});
