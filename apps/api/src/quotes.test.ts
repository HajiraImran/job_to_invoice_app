import { loadEnv, RESEND_WEBHOOK_FIXTURE } from "@job-to-invoice/config";
import { originalPdfObjectKey } from "@job-to-invoice/domain";
import { createJwtFixture } from "@job-to-invoice/testing";
import { createHash } from "node:crypto";
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
const AUTH_P = "31313131-3131-4131-8131-313131313131";
const AUTH_S = "32323232-3232-4232-8232-323232323232";
const KEY_1 = "33333333-3333-4333-8333-333333333331";
const KEY_2 = "33333333-3333-4333-8333-333333333332";
const KEY_3 = "33333333-3333-4333-8333-333333333333";
const KEY_4 = "33333333-3333-4333-8333-333333333334";
const KEY_5 = "33333333-3333-4333-8333-333333333335";
const KEY_6 = "33333333-3333-4333-8333-333333333336";
const JOB_1 = "34343434-3434-4343-8343-343434343431";
const JOB_2 = "34343434-3434-4343-8343-343434343432";
const JOB_S = "35353535-3535-4353-8353-353535353535";
const JOB_T1 = "3b3b3b3b-3b3b-43b3-83b3-3b3b3b3b3b31";
const JOB_T2 = "3b3b3b3b-3b3b-43b3-83b3-3b3b3b3b3b32";
const JOB_T3 = "3b3b3b3b-3b3b-43b3-83b3-3b3b3b3b3b33";
const JOB_T4 = "3b3b3b3b-3b3b-43b3-83b3-3b3b3b3b3b34";
const LINE_1 = "36363636-3636-4363-8363-363636363631";

function setupBody() {
  return {
    business_name: "Quote Publish Co",
    legal_name: "Quote Publish Co LLC",
    contact_name: "Owner P",
    contact_email: "owner.p@example.com",
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
  };
}

function jobBody(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_1,
    customer_name: "Riley Chen",
    title: "Kitchen faucet",
    no_site: true,
    internal_notes: "Rear hose bib.",
    mode: "quote",
    ...overrides,
  };
}

function f01Line(overrides: Record<string, unknown> = {}) {
  return {
    client_line_id: LINE_1,
    description: "Labour hour",
    unit: "hour",
    quantity: "2.5",
    unit_price_cents: 10000,
    discount_cents: 1000,
    tax_bp: 825,
    ...overrides,
  };
}

function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    notes: "Replace cartridge.",
    terms: "Net 14.",
    expiry_days: 14,
    lines: [f01Line()],
    ...overrides,
  };
}

describe("quote publish API", () => {
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
      EMAIL_WEBHOOK_SECRET: RESEND_WEBHOOK_FIXTURE.secret,
    });
    const SIGNED = "https://r2.invalid/original.pdf?X-Amz-Expires=300";
    app = buildApp({
      env,
      pool,
      nowSec: () => 1_731_705_121,
      logOwnerMe: () => undefined,
      documentsStore: {
        presignGet: async (key) => `${SIGNED}&key=${encodeURIComponent(key)}`,
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

  async function completeSetup(token: string, key = KEY_1) {
    await me(token);
    return running().app.inject({
      method: "POST",
      url: "/v1/workspace",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
        "if-match": "1",
      },
      payload: setupBody(),
    });
  }

  async function createJob(token: string, body: unknown, key: string) {
    return running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      payload: body as object,
    });
  }

  async function openQuote(token: string, jobId: string, key: string) {
    return running().app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/quote`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
    });
  }

  async function saveDraft(token: string, draftId: string, version: number, body: unknown, key: string) {
    return running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${draftId}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
        "if-match": String(version),
      },
      payload: body as object,
    });
  }

  async function preview(token: string, draftId: string, version: number) {
    return running().app.inject({
      method: "POST",
      url: `/v1/drafts/${draftId}/preview`,
      headers: {
        authorization: `Bearer ${token}`,
        "if-match": String(version),
      },
    });
  }

  async function publish(
    token: string,
    draftId: string,
    version: number,
    previewHash: string,
    key: string,
    recipientEmail = "customer@example.com",
  ) {
    return running().app.inject({
      method: "POST",
      url: `/v1/drafts/${draftId}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
        "if-match": String(version),
      },
      payload: { preview_hash: previewHash, recipient_email: recipientEmail },
    });
  }

  async function readyDraft(token: string, jobId: string, keys: { job: string; open: string; save: string }) {
    const job = await createJob(token, jobBody({ id: jobId }), keys.job);
    expect(job.statusCode).toBe(200);
    const opened = await openQuote(token, jobId, keys.open);
    expect(opened.statusCode).toBe(200);
    const saved = await saveDraft(token, opened.json().data.id, opened.json().data.version, draftBody(), keys.save);
    expect(saved.statusCode).toBe(200);
    return saved.json().data as { id: string; version: number; job_id: string; total_cents: number };
  }

  it("previews and publishes an immutable quote with server FIN01 totals and a queued PDF", async () => {
    const token = await sign({ sub: AUTH_P, email: "owner.p@example.com" });
    const setup = await completeSetup(token);
    expect(setup.statusCode).toBe(200);
    expect(setup.json().data.entitlement.can_publish).toBe(true);
    const draft = await readyDraft(token, JOB_1, { job: KEY_2, open: KEY_3, save: KEY_4 });
    const empty = await preview(token, draft.id, draft.version);
    expect(empty.statusCode).toBe(200);
    const previewed = empty.json().data;
    expect(previewed.number_label).toBe("Draft");
    expect(previewed.snapshot.net_cents).toBe(24000);
    expect(previewed.snapshot.tax_cents).toBe(1980);
    expect(previewed.snapshot.total_cents).toBe(25980);
    expect(previewed.snapshot.lines[0].quantity).toBe("2.500");
    expect(previewed.snapshot.business.business_name).toBe("Quote Publish Co");
    expect(previewed.snapshot.customer.name).toBe("Riley Chen");
    expect(previewed.preview_hash).toMatch(/^[0-9a-f]{64}$/);
    const published = await publish(token, draft.id, draft.version, previewed.preview_hash, KEY_5);
    expect(published.statusCode).toBe(202);
    const doc = published.json().data;
    expect(doc.number).toBe("Q-000001");
    expect(doc.revision_no).toBe(1);
    expect(doc.revision_label).toBe("R1");
    expect(doc.lifecycle).toBe("issued");
    expect(doc.pdf_state).toBe("preparing");
    expect(doc.delivery_state).toBe("queued");
    expect(doc.request_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(doc.token).toBeUndefined();
    expect(doc.href).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain("ciphertext");
    expect(JSON.stringify(doc)).not.toContain("whsec_");
    expect(JSON.stringify(doc)).not.toContain("customer@example.com");
    const missingRecipient = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${draft.id}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY_6,
        "if-match": String(draft.version),
      },
      payload: { preview_hash: previewed.preview_hash },
    });
    expect(missingRecipient.statusCode).toBe(422);
    const status = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB_1}/request`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.delivery_state).toBe("queued");
    expect(status.json().data.recipient_email_masked).toMatch(/^c\*\*\*@/);
    expect(JSON.stringify(status.json())).not.toContain("customer@example.com");
    expect(status.json().data.token).toBeUndefined();
    const emailTask = await running().admin.query(
      `select payload_json, effect_key from commercial.outbox_tasks where task_type = 'send_email' and payload_json->>'document_id' = $1`,
      [doc.id],
    );
    expect(emailTask.rows[0]?.payload_json).toEqual({
      document_id: doc.id,
      request_id: doc.request_id,
      template_id: "EMAIL01",
    });
    expect(JSON.stringify(emailTask.rows[0]?.payload_json)).not.toContain("customer@example.com");
    expect(JSON.stringify(emailTask.rows[0]?.payload_json)).not.toMatch(/token_hash|"token"|href|ciphertext/i);
    expect(doc.net_cents).toBe(24000);
    expect(doc.snapshot.notes).toBe("Replace cartridge.");
    expect(doc.snapshot.terms).toBe("Net 14.");
    expect(JSON.stringify(doc)).not.toMatch(/Rear hose bib/);
    const replay = await publish(token, draft.id, draft.version, previewed.preview_hash, KEY_5);
    expect(replay.statusCode).toBe(202);
    expect(replay.json().data.id).toBe(doc.id);
    expect(replay.json().data.number).toBe("Q-000001");
    const mismatchedRecipient = await publish(
      token,
      draft.id,
      draft.version,
      previewed.preview_hash,
      KEY_5,
      "other.customer@example.com",
    );
    expect(mismatchedRecipient.statusCode).toBe(409);
    expect(mismatchedRecipient.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
    const loaded = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${doc.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().data.number).toBe("Q-000001");
    expect(loaded.json().data.pdf_state).toBe("preparing");
    const download = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${doc.id}/download`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.json().data.state).toBe("preparing");
    expect(download.json().data.url).toBeNull();
    const issued = await running().admin.query(
      `select workspace_id, revision_no from commercial.documents where id = $1`,
      [doc.id],
    );
    const task = await running().admin.query(
      `select id from commercial.outbox_tasks where aggregate_id = $1`,
      [doc.id],
    );
    const artifactId = "37373737-3737-4373-8373-373737373738";
    const objectKey = originalPdfObjectKey({
      workspaceId: issued.rows[0].workspace_id,
      documentId: doc.id,
      revision: issued.rows[0].revision_no,
      artifactId,
    });
    const pdf = Buffer.from("%PDF-1.4 test original");
    await running().admin.query("set role worker_app");
    try {
      await running().admin.query(
        "select commercial.complete_original_pdf($1::uuid, $2::uuid, $3, $4, $5::bigint)",
        [task.rows[0].id, artifactId, objectKey, createHash("sha256").update(pdf).digest("hex"), pdf.byteLength],
      );
    } finally {
      await running().admin.query("reset role");
    }
    const readyDownload = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${doc.id}/download`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(readyDownload.statusCode).toBe(200);
    expect(readyDownload.json().data.state).toBe("ready");
    expect(readyDownload.json().data.url).toContain("X-Amz-Expires=300");
    expect(readyDownload.json().data.url).toContain(encodeURIComponent(objectKey));
    const readyDoc = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${doc.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(readyDoc.json().data.pdf_state).toBe("ready");
    const job = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB_1}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(job.json().data.lifecycle).toBe("active");
    expect(job.json().data.quote_draft).toBeNull();
    expect(job.json().data.current_quote.number).toBe("Q-000001");
    const stillDraft = await running().app.inject({
      method: "GET",
      url: `/v1/drafts/${draft.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stillDraft.statusCode).toBe(200);
    expect(stillDraft.json().data.draft_state).toBe("published");
    const edit = await saveDraft(token, draft.id, draft.version, draftBody({ notes: "changed" }), KEY_6);
    expect(edit.statusCode).toBe(422);
    const rows = await running().admin.query(
      `select number, lifecycle from commercial.documents where id = $1`,
      [doc.id],
    );
    expect(rows.rows[0]?.number).toBe("Q-000001");
    const lines = await running().admin.query(
      "select count(*)::int as n from commercial.document_lines where document_id = $1",
      [doc.id],
    );
    expect(lines.rows[0]?.n).toBe(1);
    const outbox = await running().admin.query(
      "select task_type, status from commercial.outbox_tasks where aggregate_id = $1",
      [doc.id],
    );
    expect(outbox.rows[0]?.task_type).toBe("generate_original_pdf");
    expect(outbox.rows[0]?.status).toBe("done");
    const analytics = await running().admin.query(
      `select safe_properties_json from commercial.analytics_events
       where event_name = 'document_published' and job_id = $1`,
      [JOB_1],
    );
    expect(analytics.rows[0]?.safe_properties_json).toMatchObject({
      kind: "quote",
      entitlement_origin: "free",
      line_count_bucket: "1",
    });
    await expect(
      running().admin.query("update commercial.documents set total_cents = 1 where id = $1", [doc.id]),
    ).rejects.toThrow(/immutable/i);
  });

  it("rejects empty drafts, stale previews, version conflicts, and duplicate concurrent publishes", async () => {
    const token = await sign({ sub: AUTH_P, email: "owner.p@example.com" });
    await completeSetup(token);
    const job = await createJob(token, jobBody({ id: JOB_2, title: "Second" }), "37373737-3737-4373-8373-373737373731");
    expect(job.statusCode).toBe(200);
    const opened = await openQuote(token, JOB_2, "37373737-3737-4373-8373-373737373732");
    const empty = await preview(token, opened.json().data.id, opened.json().data.version);
    expect(empty.statusCode).toBe(422);
    const saved = await saveDraft(
      token,
      opened.json().data.id,
      opened.json().data.version,
      draftBody(),
      "37373737-3737-4373-8373-373737373733",
    );
    expect(saved.statusCode).toBe(200);
    const previewed = await preview(token, saved.json().data.id, saved.json().data.version);
    expect(previewed.statusCode).toBe(200);
    const staleHash = await publish(
      token,
      saved.json().data.id,
      saved.json().data.version,
      "aa".repeat(32),
      "37373737-3737-4373-8373-373737373734",
    );
    expect(staleHash.statusCode).toBe(409);
    expect(staleHash.json().error.code).toBe("PREVIEW_CHANGED");
    const staleVersion = await publish(
      token,
      saved.json().data.id,
      1,
      previewed.json().data.preview_hash,
      "37373737-3737-4373-8373-373737373735",
    );
    expect(staleVersion.statusCode).toBe(409);
    expect(staleVersion.json().error.code).toBe("VERSION_CONFLICT");
    const [first, second] = await Promise.all([
      publish(
        token,
        saved.json().data.id,
        saved.json().data.version,
        previewed.json().data.preview_hash,
        "37373737-3737-4373-8373-373737373736",
      ),
      publish(
        token,
        saved.json().data.id,
        saved.json().data.version,
        previewed.json().data.preview_hash,
        "37373737-3737-4373-8373-373737373737",
      ),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([202, 409]);
    const winner = first.statusCode === 202 ? first : second;
    expect(winner.json().data.number).toMatch(/^Q-\d{6}$/);
    const already = first.statusCode === 202 ? second : first;
    expect(["DOCUMENT_IMMUTABLE", "VERSION_CONFLICT", "PREVIEW_CHANGED"]).toContain(already.json().error.code);
    const numbers = await running().admin.query(
      "select number from commercial.documents where job_id = $1",
      [JOB_2],
    );
    expect(numbers.rows).toHaveLength(1);
  });

  it("allocates unique quote numbers and consumes one free slot per job", async () => {
    const token = await sign({ sub: "3c3c3c3c-3c3c-43c3-83c3-3c3c3c3c3c3c", email: "owner.t@example.com" });
    const setup = await completeSetup(token, "3d3d3d3d-3d3d-43d3-83d3-3d3d3d3d3d3d");
    expect(setup.statusCode).toBe(200);
    const numbers: string[] = [];
    for (const [index, jobId] of [JOB_T1, JOB_T2, JOB_T3].entries()) {
      const draft = await readyDraft(token, jobId, {
        job: `3e3e3e3e-3e3e-43e3-83e3-3e3e3e3e3e3${index + 1}`,
        open: `3f3f3f3f-3f3f-43f3-83f3-3f3f3f3f3f3${index + 1}`,
        save: `40404040-4040-4404-8404-40404040404${index + 1}`,
      });
      const previewed = await preview(token, draft.id, draft.version);
      const published = await publish(
        token,
        draft.id,
        draft.version,
        previewed.json().data.preview_hash,
        `41414141-4141-4414-8414-41414141414${index + 1}`,
      );
      expect(published.statusCode).toBe(202);
      numbers.push(published.json().data.number);
    }
    expect(numbers).toEqual(["Q-000001", "Q-000002", "Q-000003"]);
    const fourth = await readyDraft(token, JOB_T4, {
      job: "39393939-3939-4393-8393-393939393931",
      open: "39393939-3939-4393-8393-393939393932",
      save: "39393939-3939-4393-8393-393939393933",
    });
    const preview4 = await preview(token, fourth.id, fourth.version);
    const pub4 = await publish(
      token,
      fourth.id,
      fourth.version,
      preview4.json().data.preview_hash,
      "39393939-3939-4393-8393-393939393934",
    );
    expect(pub4.statusCode).toBe(403);
    expect(pub4.json().error.code).toBe("ENTITLEMENT_REQUIRED");
    const still = await running().app.inject({
      method: "GET",
      url: `/v1/drafts/${fourth.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(still.json().data.draft_state).toBe("editing");
    const consumed = await running().admin.query(
      `select a.free_jobs_consumed from commercial.job_allowances a
       join commercial.workspaces w on w.workspace_id = a.workspace_id
       join identity.app_users u on u.id = w.owner_user_id
       where u.auth_user_id = $1`,
      ["3c3c3c3c-3c3c-43c3-83c3-3c3c3c3c3c3c"],
    );
    expect(consumed.rows[0]?.free_jobs_consumed).toBe(3);
  });

  it("isolates published quotes across workspaces", async () => {
    const tokenP = await sign({ sub: AUTH_P, email: "owner.p@example.com" });
    const tokenS = await sign({ sub: AUTH_S, email: "owner.s@example.com" });
    const setupS = await completeSetup(tokenS, KEY_1);
    expect(setupS.statusCode).toBe(200);
    const draft = await readyDraft(tokenS, JOB_S, { job: KEY_2, open: KEY_3, save: KEY_4 });
    const previewed = await preview(tokenS, draft.id, draft.version);
    const published = await publish(tokenS, draft.id, draft.version, previewed.json().data.preview_hash, KEY_5);
    expect(published.statusCode).toBe(202);
    const leak = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${published.json().data.id}`,
      headers: { authorization: `Bearer ${tokenP}` },
    });
    expect(leak.statusCode).toBe(404);
    expect(JSON.stringify(leak.json())).not.toMatch(/Riley Chen|Q-000001/i);
    const leakDownload = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${published.json().data.id}/download`,
      headers: { authorization: `Bearer ${tokenP}` },
    });
    expect(leakDownload.statusCode).toBe(404);
    const leakRequest = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB_S}/request`,
      headers: { authorization: `Bearer ${tokenP}` },
    });
    expect(leakRequest.statusCode).toBe(404);
    expect(JSON.stringify(leakRequest.json())).not.toContain("@example.com");
    expect(JSON.stringify(leakRequest.json())).not.toMatch(/token|href|ciphertext/i);
    expect(JSON.stringify(leakDownload.json())).not.toMatch(/r2\.invalid|original\.pdf/i);
    const steal = await publish(
      tokenP,
      draft.id,
      draft.version,
      previewed.json().data.preview_hash,
      "3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a",
    );
    expect(steal.statusCode).toBe(404);
  });

  it("returns failed download when original PDF generation is dead", async () => {
    const token = await sign({ sub: AUTH_P, email: "owner.p@example.com" });
    const jobId = "34343434-3434-4343-8343-343434343439";
    const draft = await readyDraft(token, jobId, {
      job: "42424242-4242-4242-8242-424242424241",
      open: "42424242-4242-4242-8242-424242424242",
      save: "42424242-4242-4242-8242-424242424243",
    });
    const previewed = await preview(token, draft.id, draft.version);
    const published = await publish(
      token,
      draft.id,
      draft.version,
      previewed.json().data.preview_hash,
      "42424242-4242-4242-8242-424242424244",
    );
    expect(published.statusCode).toBe(202);
    await running().admin.query(
      `update commercial.outbox_tasks set status = 'dead', last_error_code = 'VALIDATION_FAILED'
       where aggregate_id = $1`,
      [published.json().data.id],
    );
    const download = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${published.json().data.id}/download`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.json().data.state).toBe("failed");
    expect(download.json().data.url).toBeNull();
    const loaded = await running().app.inject({
      method: "GET",
      url: `/v1/documents/${published.json().data.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(loaded.json().data.pdf_state).toBe("failed");
  });

  it("rejects unauthenticated publish routes", async () => {
    const previewed = await running().app.inject({ method: "POST", url: "/v1/drafts/36363636-3636-4363-8363-363636363631/preview" });
    expect(previewed.statusCode).toBe(401);
    const published = await running().app.inject({ method: "POST", url: "/v1/drafts/36363636-3636-4363-8363-363636363631/publish" });
    expect(published.statusCode).toBe(401);
  });

  it("verifies Resend webhooks and ignores unsigned or replayed events", async () => {
    const headers = {
      "content-type": "application/json",
      "svix-id": RESEND_WEBHOOK_FIXTURE.svixId,
      "svix-timestamp": RESEND_WEBHOOK_FIXTURE.svixTimestamp,
      "svix-signature": RESEND_WEBHOOK_FIXTURE.svixSignature,
    };
    const accepted = await running().app.inject({
      method: "POST",
      url: "/webhooks/email",
      headers,
      payload: RESEND_WEBHOOK_FIXTURE.rawPayload,
    });
    expect(accepted.statusCode).toBe(200);
    const replay = await running().app.inject({
      method: "POST",
      url: "/webhooks/email",
      headers,
      payload: RESEND_WEBHOOK_FIXTURE.rawPayload,
    });
    expect(replay.statusCode).toBe(200);
    const altered = await running().app.inject({
      method: "POST",
      url: "/webhooks/email",
      headers,
      payload: '{"event_type":"ping","data":{"success":false}}',
    });
    expect(altered.statusCode).toBe(401);
    const unsigned = await running().app.inject({
      method: "POST",
      url: "/webhooks/email",
      headers: { "content-type": "application/json" },
      payload: RESEND_WEBHOOK_FIXTURE.rawPayload,
    });
    expect(unsigned.statusCode).toBe(401);
    expect(JSON.stringify(accepted.json())).not.toContain(RESEND_WEBHOOK_FIXTURE.secret);
    expect(JSON.stringify(accepted.json())).not.toContain("success");
  });
});
