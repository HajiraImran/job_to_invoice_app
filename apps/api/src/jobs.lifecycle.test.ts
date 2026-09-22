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
const AUTH = "12121212-1212-4121-8121-121212121212";
const AUTH_B = "13131313-1313-4131-8131-131313131313";
const JOB_Q = "14141414-1414-4141-8141-141414141414";
const JOB_I = "15151515-1515-4151-8151-151515151515";
const JOB_L = "16161616-1616-4161-8161-161616161616";
const JOB_A = "17171717-1717-4171-8171-171717171717";

function setupBody() {
  return {
    business_name: "Lifecycle Co",
    legal_name: "Lifecycle Co LLC",
    contact_name: "Lee Owner",
    contact_email: "Owner.Plus+tag@Example.COM",
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

function quoteLine() {
  return {
    client_line_id: "18181818-1818-4181-8181-181818181818",
    description: "Labour hour",
    unit: "hour",
    quantity: "2.5",
    unit_price_cents: 10000,
    discount_cents: 1000,
    tax_bp: 825,
  };
}

describe("JOB02 job cancel, delete, and linked create", () => {
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

  async function completeSetup(token: string, email = "owner.life@example.com") {
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
      payload: { ...setupBody(), contact_email: email },
    });
  }

  async function publishQuote(token: string, jobId: string) {
    const created = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {
        id: jobId,
        customer_name: "Riley Chen",
        title: "Kitchen faucet",
        no_site: true,
        mode: "quote",
      },
    });
    expect(created.statusCode).toBe(200);
    const opened = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/quote`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    });
    expect(opened.statusCode).toBe(200);
    const saved = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${opened.json().data.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-match": String(opened.json().data.version),
      },
      payload: { notes: "Replace cartridge.", terms: "Net 14.", expiry_days: 14, lines: [quoteLine()] },
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
        "idempotency-key": randomUUID(),
        "if-match": String(saved.json().data.version),
      },
      payload: { preview_hash: previewed.json().data.preview_hash, recipient_email: "customer@example.com" },
    });
    expect(published.statusCode).toBe(202);
    return published.json().data as { id: string; number: string };
  }

  it("cancels a published job, withdraws the pending request, and blocks delete and reopen", async () => {
    const token = await sign({ sub: AUTH, email: "owner.life@example.com" });
    const setup = await completeSetup(token);
    expect(setup.statusCode).toBe(200);
    await publishQuote(token, JOB_Q);
    const publishedDelete = await running().app.inject({
      method: "DELETE",
      url: `/v1/jobs/${JOB_Q}`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    });
    expect(publishedDelete.statusCode).toBe(409);
    expect(publishedDelete.json().error.code).toBe("JOB_NOT_DELETABLE");
    const cancelKey = randomUUID();
    const canceled = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_Q}/cancel`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": cancelKey,
      },
      payload: { reason: "Customer paused the kitchen work." },
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().data.lifecycle).toBe("canceled");
    expect(canceled.json().data.permitted_actions).toContain("create_linked_job");
    expect(canceled.json().data.permitted_actions).not.toContain("cancel_job");
    expect(canceled.json().data.permitted_actions).not.toContain("create_invoice");
    expect(canceled.json().data.current_quote.lifecycle).toBe("withdrawn");
    const replay = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_Q}/cancel`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": cancelKey,
      },
      payload: { reason: "Customer paused the kitchen work." },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.lifecycle).toBe("canceled");
    const again = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_Q}/cancel`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { reason: "Try to reopen." },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("JOB_NOT_CANCELABLE");
    const emails = await running().admin.query<{ template_id: string; n: number }>(
      `select template_id, count(*)::int as n
       from commercial.delivery_attempts
       where template_id = 'EMAIL08'
       group by template_id`,
    );
    expect(emails.rows[0]?.n).toBeGreaterThanOrEqual(1);
    const requestState = await running().admin.query<{ state: string }>(
      `select state from commercial.approval_requests where job_id = $1 and purpose = 'approval'`,
      [JOB_Q],
    );
    expect(requestState.rows.every((row) => row.state === "withdrawn")).toBe(true);
    const slots = await running().admin.query<{ consumed: number }>(
      `select free_jobs_consumed::int as consumed from commercial.job_allowances where workspace_id = $1`,
      [setup.json().data.workspace.id],
    );
    expect(slots.rows[0]?.consumed).toBe(1);
    const other = await sign({ sub: AUTH_B, email: "owner.other@example.com" });
    await completeSetup(other, "owner.other@example.com");
    const leak = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_Q}/cancel`,
      headers: {
        authorization: `Bearer ${other}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { reason: "Cross tenant." },
    });
    expect(leak.statusCode).toBe(404);
    expect(JSON.stringify(leak.json())).not.toMatch(/Riley|kitchen/i);
  });

  it("creates a linked draft from a canceled job and rejects an active source", async () => {
    const token = await sign({ sub: AUTH, email: "owner.life@example.com" });
    const linked = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {
        id: JOB_L,
        customer_name: "Riley Chen",
        title: "Kitchen faucet follow-up",
        no_site: true,
        mode: "quote",
        related_job_id: JOB_Q,
      },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().data.related_job_id).toBe(JOB_Q);
    expect(linked.json().data.lifecycle).toBe("draft");
    expect(linked.json().data.permitted_actions).toContain("delete_job");
    const activeSource = await publishQuote(token, JOB_A);
    expect(activeSource.id).toBeTruthy();
    const rejected = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {
        id: randomUUID(),
        customer_name: "Riley Chen",
        title: "Should fail",
        no_site: true,
        mode: "quote",
        related_job_id: JOB_A,
      },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe("RELATED_JOB_UNAVAILABLE");
  });

  it("cancels an invoiced job and keeps the receivable visible", async () => {
    const token = await sign({ sub: AUTH, email: "owner.life@example.com" });
    const created = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {
        id: JOB_I,
        customer_name: "Sam Patel",
        title: "Deck repair",
        no_site: true,
        mode: "direct_invoice",
      },
    });
    expect(created.statusCode).toBe(200);
    const draftId = created.json().data.invoice_draft.id as string;
    const version = created.json().data.invoice_draft.version as number;
    const saved = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${draftId}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-match": String(version),
      },
      payload: {
        direct_invoice: true,
        issue_acknowledgement: true,
        due_date: "2026-10-05",
        payment_instructions: "Due on receipt.",
        notes: "",
        customer_email: null,
        lines: [quoteLine()],
      },
    });
    expect(saved.statusCode).toBe(200);
    const previewed = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${draftId}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(saved.json().data.version) },
    });
    expect(previewed.statusCode).toBe(200);
    const issued = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_I}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { preview_hash: previewed.json().data.preview_hash },
    });
    expect(issued.statusCode).toBe(202);
    const canceledInvoice = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_I}/cancel`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { reason: "Work stopped after issue." },
    });
    expect(canceledInvoice.statusCode).toBe(200);
    expect(canceledInvoice.json().data.lifecycle).toBe("canceled");
    expect(canceledInvoice.json().data.permitted_actions).toContain("view_invoice");
    expect(canceledInvoice.json().data.active_invoice.number).toMatch(/^INV-/);
    const issuedStill = await running().admin.query<{ n: number }>(
      `select count(*)::int as n from commercial.documents
        where job_id = $1 and kind = 'invoice' and lifecycle = 'issued'`,
      [JOB_I],
    );
    expect(issuedStill.rows[0]?.n).toBe(1);
  });
});

describe("JOB01 archive, restore, and finish", () => {
  let stop: (() => Promise<void>) | undefined;
  let pool: Pool | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  let sign: Awaited<ReturnType<typeof createJwtFixture>>["sign"];
  let admin: Client | undefined;

  const AUTH_C = "19191919-1919-4191-8191-191919191919";
  const AUTH_D = "1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a";
  const JOB_F = "1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b";
  const JOB_P = "1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c";
  const JOB_D = "1d1d1d1d-1d1d-41d1-81d1-1d1d1d1d1d1d";

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
      payload: { ...setupBody(), contact_email: email },
    });
  }

  async function issueDirectInvoice(token: string, jobId: string) {
    const created = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {
        id: jobId,
        customer_name: "Sam Patel",
        title: "Deck repair",
        no_site: true,
        mode: "direct_invoice",
      },
    });
    expect(created.statusCode).toBe(200);
    const draftId = created.json().data.invoice_draft.id as string;
    const saved = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${draftId}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-match": String(created.json().data.invoice_draft.version),
      },
      payload: {
        direct_invoice: true,
        issue_acknowledgement: true,
        due_date: "2026-10-05",
        payment_instructions: "Due on receipt.",
        notes: "",
        customer_email: null,
        lines: [quoteLine()],
      },
    });
    expect(saved.statusCode).toBe(200);
    const previewed = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${draftId}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(saved.json().data.version) },
    });
    expect(previewed.statusCode).toBe(200);
    const issued = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { preview_hash: previewed.json().data.preview_hash },
    });
    expect(issued.statusCode).toBe(202);
    return issued.json().data as { id: string; number: string; total_cents: number };
  }

  it("finishes a settled invoice, archives the finished job, and restores it", async () => {
    const token = await sign({ sub: AUTH_C, email: "owner.finish@example.com" });
    const setup = await completeSetup(token, "owner.finish@example.com");
    expect(setup.statusCode).toBe(200);
    const invoice = await issueDirectInvoice(token, JOB_F);
    const unfinished = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_F}/finish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {},
    });
    expect(unfinished.statusCode).toBe(409);
    expect(unfinished.json().error.code).toBe("JOB_NOT_FINISHABLE");
    const paid = await running().app.inject({
      method: "POST",
      url: `/v1/invoices/${invoice.id}/payments`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { amount_cents: invoice.total_cents, effective_date: "2026-09-21", method: "cash" },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().data.payment_status).toBe("settled");
    const finishKey = randomUUID();
    const finished = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_F}/finish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": finishKey,
      },
      payload: {},
    });
    expect(finished.statusCode).toBe(200);
    expect(finished.json().data.lifecycle).toBe("finished");
    expect(finished.json().data.permitted_actions).toContain("archive_job");
    expect(finished.json().data.permitted_actions).not.toContain("finish_job");
    expect(finished.json().data.permitted_actions).not.toContain("cancel_job");
    expect(finished.json().data.active_invoice.number).toMatch(/^INV-/);
    const replay = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_F}/finish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": finishKey,
      },
      payload: {},
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.lifecycle).toBe("finished");
    const again = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_F}/finish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("JOB_NOT_FINISHABLE");
    const finishedList = await running().app.inject({
      method: "GET",
      url: "/v1/jobs?state=finished",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(finishedList.statusCode).toBe(200);
    expect(finishedList.json().data.items.some((item: { id: string }) => item.id === JOB_F)).toBe(true);
    const archiveKey = randomUUID();
    const archived = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_F}/archive`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": archiveKey,
      },
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.lifecycle).toBe("archived");
    expect(archived.json().data.archived_from_state).toBe("finished");
    expect(archived.json().data.permitted_actions).toContain("restore_job");
    expect(archived.json().data.permitted_actions).not.toContain("archive_job");
    const archiveReplay = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_F}/archive`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": archiveKey,
      },
      payload: { archived: true },
    });
    expect(archiveReplay.statusCode).toBe(200);
    expect(archiveReplay.json().data.lifecycle).toBe("archived");
    const archivedList = await running().app.inject({
      method: "GET",
      url: "/v1/jobs?state=archived",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(archivedList.json().data.items.some((item: { id: string }) => item.id === JOB_F)).toBe(true);
    const restored = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_F}/archive`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { archived: false },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.lifecycle).toBe("finished");
    expect(restored.json().data.archived_from_state).toBeNull();
    const other = await sign({ sub: AUTH_D, email: "owner.other2@example.com" });
    await completeSetup(other, "owner.other2@example.com");
    const leak = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_F}/archive`,
      headers: {
        authorization: `Bearer ${other}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { archived: true },
    });
    expect(leak.statusCode).toBe(404);
    expect(JSON.stringify(leak.json())).not.toMatch(/Sam|deck/i);
  });

  it("refuses draft archive and pending-approval archive", async () => {
    const token = await sign({ sub: AUTH_C, email: "owner.finish@example.com" });
    const draft = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {
        id: JOB_D,
        customer_name: "Draft Customer",
        title: "Unused draft",
        no_site: true,
        mode: "quote",
      },
    });
    expect(draft.statusCode).toBe(200);
    const draftArchive = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_D}/archive`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { archived: true },
    });
    expect(draftArchive.statusCode).toBe(409);
    expect(draftArchive.json().error.code).toBe("JOB_NOT_ARCHIVABLE");
    const created = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {
        id: JOB_P,
        customer_name: "Riley Chen",
        title: "Kitchen faucet",
        no_site: true,
        mode: "quote",
      },
    });
    expect(created.statusCode).toBe(200);
    const opened = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_P}/quote`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    });
    expect(opened.statusCode).toBe(200);
    const saved = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${opened.json().data.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "if-match": String(opened.json().data.version),
      },
      payload: { notes: "Replace cartridge.", terms: "Net 14.", expiry_days: 14, lines: [quoteLine()] },
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
        "idempotency-key": randomUUID(),
        "if-match": String(saved.json().data.version),
      },
      payload: { preview_hash: previewed.json().data.preview_hash, recipient_email: "customer@example.com" },
    });
    expect(published.statusCode).toBe(202);
    const pendingArchive = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_P}/archive`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { archived: true },
    });
    expect(pendingArchive.statusCode).toBe(409);
    expect(pendingArchive.json().error.code).toBe("APPROVAL_PENDING");
  });
});
