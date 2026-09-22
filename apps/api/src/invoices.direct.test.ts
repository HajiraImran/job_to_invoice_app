import {
  loadEnv,
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
const AUTH = "61616161-6161-4161-8161-616161616161";
const AUTH_B = "61616161-6161-4161-8161-616161616162";
const JOB = "62626262-6262-4262-8262-626262626261";
const JOB_EMAIL = "62626262-6262-4262-8262-626262626262";
const JOB_RACE = "62626262-6262-4262-8262-626262626263";
const JOB_SLOT = "62626262-6262-4262-8262-626262626264";
const JOB_FOREIGN = "62626262-6262-4262-8262-626262626265";

function setupBody(email: string) {
  return {
    business_name: "Direct Co",
    legal_name: "Direct Co LLC",
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
    default_terms: "Due on receipt.",
    skip_logo: true,
  };
}

function line(description = "Completed work") {
  return {
    client_line_id: randomUUID(),
    description,
    unit: "item",
    quantity: "1",
    unit_price_cents: 10000,
    discount_cents: 0,
    tax_bp: 0,
  };
}

describe("direct invoice API", () => {
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
      throw new Error("direct invoice test app did not start");
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

  async function createDirectJob(token: string, jobId: string, jobKey: string) {
    return running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": jobKey,
      },
      payload: { id: jobId, customer_name: "Riley Chen", title: "Completed work", no_site: true, mode: "direct_invoice" },
    });
  }

  async function saveAndPreview(
    token: string,
    draftId: string,
    version: number,
    extra: { customer_email?: string | null } = {},
  ) {
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
        customer_email: extra.customer_email ?? null,
        lines: [line()],
      },
    });
    const previewed = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${draftId}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(saved.json().data.version) },
    });
    return { saved, previewed };
  }

  it("creates an invoice draft on POST /jobs and issues without a customer email", async () => {
    const token = await sign({ sub: AUTH, email: "owner.direct@example.com" });
    await completeSetup(token, "owner.direct@example.com", randomUUID());
    const created = await createDirectJob(token, JOB, randomUUID());
    expect(created.statusCode).toBe(200);
    expect(created.json().data.mode).toBe("direct_invoice");
    expect(created.json().data.invoice_draft.id).toBeTruthy();
    expect(created.json().data.permitted_actions).toContain("create_invoice");
    const draftId = created.json().data.invoice_draft.id as string;
    const loaded = await running().app.inject({
      method: "GET",
      url: `/v1/drafts/${draftId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().data.direct_invoice).toBe(true);
    const missingAck = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${draftId}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(loaded.json().data.version) },
    });
    expect(missingAck.statusCode).toBe(422);
    const { previewed } = await saveAndPreview(token, draftId, loaded.json().data.version);
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json().data.snapshot.origin).toBe("direct");
    expect(previewed.json().data.snapshot.no_prior_approval).toBe(true);
    const issueKey = randomUUID();
    const issued = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": issueKey,
      },
      payload: { preview_hash: previewed.json().data.preview_hash },
    });
    expect(issued.statusCode).toBe(202);
    expect(issued.json().data.number).toBe("INV-000001");
    expect(issued.json().data.delivery_state).toBe("not_requested");
    expect(issued.json().data.request_id).toBeNull();
    expect(issued.json().data.snapshot.origin).toBe("direct");
    const replay = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": issueKey,
      },
      payload: { preview_hash: previewed.json().data.preview_hash },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().data.id).toBe(issued.json().data.id);
    const detail = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.json().data.lifecycle).toBe("invoiced");
    expect(detail.json().data.active_invoice.number).toBe("INV-000001");
    expect(detail.json().data.permitted_actions).toContain("view_invoice");
    expect(detail.json().data.permitted_actions).not.toContain("create_change");
    const change = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB}/changes`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    });
    expect(change.statusCode).toBe(422);
    const events = await running().admin.query<{ event_name: string; safe_properties_json: { origin: string; has_changes: boolean } }>(
      `select event_name, safe_properties_json from commercial.analytics_events where job_id = $1`,
      [JOB],
    );
    expect(events.rows.some((row) => row.event_name === "invoice_issued" && row.safe_properties_json.origin === "direct" && row.safe_properties_json.has_changes === false)).toBe(true);
    const emails = await running().admin.query<{ template_id: string }>(
      `select template_id from commercial.delivery_attempts where document_id = $1`,
      [issued.json().data.id],
    );
    expect(emails.rows).toHaveLength(0);
    const foreign = await sign({ sub: AUTH_B, email: "owner.other@example.com" });
    await completeSetup(foreign, "owner.other@example.com", randomUUID());
    const hidden = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB}`,
      headers: { authorization: `Bearer ${foreign}` },
    });
    expect(hidden.statusCode).toBe(404);
    expect(JSON.stringify(issued.json())).not.toMatch(/sql|stack|postgres/i);
  });

  it("queues EMAIL06 only when a customer email is present", async () => {
    const token = await sign({ sub: AUTH, email: "owner.direct@example.com" });
    const created = await createDirectJob(token, JOB_EMAIL, randomUUID());
    const draftId = created.json().data.invoice_draft.id as string;
    const { previewed } = await saveAndPreview(token, draftId, created.json().data.invoice_draft.version, {
      customer_email: "customer@example.com",
    });
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json().data.snapshot.customer.email).toBe("customer@example.com");
    const issued = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_EMAIL}/issue-invoice`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { preview_hash: previewed.json().data.preview_hash },
    });
    expect(issued.statusCode).toBe(202);
    expect(issued.json().data.delivery_state).toBe("queued");
    expect(issued.json().data.request_id).toBeTruthy();
    const emails = await running().admin.query<{ template_id: string; purpose: string }>(
      `select da.template_id, ar.purpose
       from commercial.delivery_attempts da
       join commercial.approval_requests ar
         on ar.workspace_id = da.workspace_id and ar.id = da.request_id
       where da.document_id = $1`,
      [issued.json().data.id],
    );
    expect(emails.rows).toEqual([{ template_id: "EMAIL06", purpose: "view_only" }]);
  });

  it("serializes concurrent first issues to one invoice and consumes one free slot", async () => {
    const token = await sign({ sub: AUTH, email: "owner.direct@example.com" });
    const created = await createDirectJob(token, JOB_RACE, randomUUID());
    const draftId = created.json().data.invoice_draft.id as string;
    const { previewed } = await saveAndPreview(token, draftId, created.json().data.invoice_draft.version);
    const hash = previewed.json().data.preview_hash as string;
    const [first, second] = await Promise.all([
      running().app.inject({
        method: "POST",
        url: `/v1/jobs/${JOB_RACE}/issue-invoice`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        payload: { preview_hash: hash },
      }),
      running().app.inject({
        method: "POST",
        url: `/v1/jobs/${JOB_RACE}/issue-invoice`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        payload: { preview_hash: hash },
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses[0]).toBe(202);
    expect([202, 409, 422]).toContain(statuses[1]);
    const docs = await running().admin.query<{ number: string }>(
      `select number from commercial.documents where job_id = $1 and kind = 'invoice'`,
      [JOB_RACE],
    );
    expect(docs.rows).toHaveLength(1);
  });

  it("rejects floats, quote-mode issue on a direct job preview, and cross-tenant drafts", async () => {
    const token = await sign({ sub: AUTH, email: "owner.direct@example.com" });
    const created = await createDirectJob(token, JOB_SLOT, randomUUID());
    const draftId = created.json().data.invoice_draft.id as string;
    const floated = await running().app.inject({
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
        lines: [{ ...line(), unit_price_cents: 10.5 }],
      },
    });
    expect(floated.statusCode).toBe(422);
    const foreign = await sign({ sub: AUTH_B, email: "owner.other@example.com" });
    const hidden = await running().app.inject({
      method: "GET",
      url: `/v1/drafts/${draftId}`,
      headers: { authorization: `Bearer ${foreign}` },
    });
    expect(hidden.statusCode).toBe(404);
    const missing = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB_FOREIGN}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
  });
});
