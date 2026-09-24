import { loadEnv } from "@job-to-invoice/config";
import { createJwtFixture } from "@job-to-invoice/testing";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error test harness is outside the API package
import { applyCleanMigrations } from "../../scripts/db-admin.mjs";
// @ts-expect-error test harness is outside the API package
import { resolveMigrationsUrl } from "../../scripts/postgres-url.mjs";
import { buildApp } from "./app.ts";
import { decodeJobCursor, encodeJobCursor } from "./jobs.ts";
import { createJwtVerifier } from "./jwt.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const AUTH_E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const AUTH_F = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const AUTH_G = "abababab-abab-4aba-8aba-abababababab";
const KEY_1 = "11111111-1111-4111-8111-111111111111";
const KEY_2 = "22222222-2222-4222-8222-222222222222";
const KEY_3 = "33333333-3333-4333-8333-333333333333";
const JOB_1 = "44444444-4444-4444-8444-444444444444";
const JOB_2 = "55555555-5555-4555-8555-555555555555";
const JOB_3 = "66666666-6666-4666-8666-666666666666";
const JOB_4 = "77777777-7777-4777-8777-777777777777";

function setupBody(overrides: Record<string, unknown> = {}) {
  return {
    business_name: "José's Handyman",
    legal_name: "José's Handyman LLC",
    contact_name: "José García",
    contact_email: "Owner.Plus+tag@Example.COM",
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
    ...overrides,
  };
}

function jobBody(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_1,
    customer_name: "Riley Chen",
    title: "Kitchen faucet",
    no_site: false,
    site_address: {
      line1: "500 Oak Avenue",
      city: "Austin",
      state: "TX",
      postal_code: "78702",
    },
    internal_notes: "Rear hose bib.",
    mode: "quote",
    ...overrides,
  };
}

describe("jobs API", () => {
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

  it("encodes list cursors as opaque filter-bound tokens", () => {
    const encoded = encodeJobCursor({ u: "2026-09-15T12:00:00.000Z", i: JOB_1, s: "faucet", t: "open" });
    expect(encoded).not.toMatch(/faucet|Riley|2026-09-15T12:00:00/);
    expect(decodeJobCursor(encoded)).toEqual({
      u: "2026-09-15T12:00:00.000Z",
      i: JOB_1,
      s: "faucet",
      t: "open",
      c: null,
    });
    expect(decodeJobCursor("not-a-cursor")).toBeUndefined();
  });

  it("rejects missing authentication on list, create, and detail", async () => {
    const list = await running().app.inject({ method: "GET", url: "/v1/jobs" });
    expect(list.statusCode).toBe(401);
    const create = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { "content-type": "application/json", "idempotency-key": KEY_1 },
      payload: jobBody(),
    });
    expect(create.statusCode).toBe(401);
    const detail = await running().app.inject({ method: "GET", url: `/v1/jobs/${JOB_1}` });
    expect(detail.statusCode).toBe(401);
  });

  it("rejects staff tokens and incomplete setup", async () => {
    const staff = await sign({ sub: AUTH_G, email: "owner.g@example.com", role: "staff" });
    const forbidden = await running().app.inject({
      method: "GET",
      url: "/v1/jobs",
      headers: { authorization: `Bearer ${staff}` },
    });
    expect(forbidden.statusCode).toBe(401);
    const token = await sign({ sub: AUTH_G, email: "owner.g@example.com" });
    await me(token);
    const early = await createJob(token, jobBody({ id: JOB_4 }), KEY_3);
    expect(early.statusCode).toBe(403);
    expect(early.json().error.code).toBe("SETUP_INCOMPLETE");
  });

  it("creates a draft job with a minimum customer, replays idempotency, and lists detail", async () => {
    const token = await sign({ sub: AUTH_E, email: "owner.e@example.com" });
    const setup = await completeSetup(token, KEY_1);
    expect(setup.statusCode).toBe(200);
    const created = await createJob(token, jobBody(), KEY_2);
    expect(created.statusCode).toBe(200);
    const data = created.json().data;
    expect(data.id).toBe(JOB_1);
    expect(data.lifecycle).toBe("draft");
    expect(data.mode).toBe("quote");
    expect(data.customer_name).toBe("Riley Chen");
    expect(data.permitted_actions).toEqual(["delete_job"]);
    expect(data.quote_draft).toBeNull();
    expect(data.scope_total).toBeUndefined();
    expect(data.ledger).toBeUndefined();
    const replay = await createJob(token, jobBody(), KEY_2);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(JOB_1);
    const mismatch = await createJob(token, jobBody({ title: "Other" }), KEY_2);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
    const list = await running().app.inject({
      method: "GET",
      url: "/v1/jobs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.items).toHaveLength(1);
    expect(list.json().data.next_cursor).toBeNull();
    expect(list.json().meta.request_id).toBeTruthy();
    const detail = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB_1}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.title).toBe("Kitchen faucet");
    const customers = await running().admin.query(
      "select count(*)::int as n from commercial.customers where workspace_id = $1",
      [setup.json().data.workspace.id],
    );
    expect(customers.rows[0]?.n).toBe(1);
    const analytics = await running().admin.query(
      `select event_name, safe_properties_json, job_id from commercial.analytics_events
       where workspace_id = $1 and event_name = 'job_created'`,
      [setup.json().data.workspace.id],
    );
    expect(analytics.rows).toHaveLength(1);
    expect(analytics.rows[0]?.job_id).toBe(JOB_1);
    expect(analytics.rows[0]?.safe_properties_json).toEqual({ mode: "quote" });
    expect(JSON.stringify(analytics.rows[0]?.safe_properties_json)).not.toMatch(/Riley|Oak|hose/i);
  });

  it("rejects invalid bodies, unknown fields, and forged workspace ids", async () => {
    const token = await sign({ sub: AUTH_E, email: "owner.e@example.com" });
    const invalid = await createJob(token, jobBody({ id: JOB_2, title: "" }), KEY_3);
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.field_errors.some((item: { field: string }) => item.field === "title")).toBe(true);
    const forged = await createJob(
      token,
      jobBody({ id: JOB_2, workspace_id: "99999999-9999-4999-8999-999999999999" }),
      "88888888-8888-4888-8888-888888888888",
    );
    expect(forged.statusCode).toBe(422);
    expect(JSON.stringify(forged.json())).not.toMatch(/sql|stack|postgres/i);
    const missingKey = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: jobBody({ id: JOB_2 }),
    });
    expect(missingKey.statusCode).toBe(422);
  });

  it("pages open jobs and hides drafts from finished and archived filters", async () => {
    const token = await sign({ sub: AUTH_E, email: "owner.e@example.com" });
    const second = await createJob(
      token,
      jobBody({ id: JOB_2, customer_name: "Sam Patel", title: "Deck repair", mode: "direct_invoice", no_site: true, site_address: null }),
      "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    );
    expect(second.statusCode).toBe(200);
    expect(second.json().data.mode).toBe("direct_invoice");
    const page = await running().app.inject({
      method: "GET",
      url: "/v1/jobs?limit=1",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().data.items).toHaveLength(1);
    expect(page.json().data.next_cursor).toBeTruthy();
    const next = await running().app.inject({
      method: "GET",
      url: `/v1/jobs?limit=1&cursor=${encodeURIComponent(page.json().data.next_cursor)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().data.items).toHaveLength(1);
    expect(next.json().data.items[0].id).not.toBe(page.json().data.items[0].id);
    const search = await running().app.inject({
      method: "GET",
      url: "/v1/jobs?search=Riley",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(search.json().data.items).toHaveLength(1);
    expect(search.json().data.items[0].customer_name).toBe("Riley Chen");
    const finished = await running().app.inject({
      method: "GET",
      url: "/v1/jobs?state=finished",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(finished.json().data.items).toHaveLength(0);
    const archived = await running().app.inject({
      method: "GET",
      url: "/v1/jobs?state=archived",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(archived.json().data.items).toHaveLength(0);
  });

  it("isolates jobs across workspaces and returns 404 for the other tenant", async () => {
    const tokenE = await sign({ sub: AUTH_E, email: "owner.e@example.com" });
    const tokenF = await sign({ sub: AUTH_F, email: "owner.f@example.com" });
    const setupF = await completeSetup(tokenF, KEY_1);
    expect(setupF.statusCode).toBe(200);
    const created = await createJob(tokenF, jobBody({ id: JOB_3, customer_name: "Taylor West" }), KEY_2);
    expect(created.statusCode).toBe(200);
    const listE = await running().app.inject({
      method: "GET",
      url: "/v1/jobs",
      headers: { authorization: `Bearer ${tokenE}` },
    });
    expect(listE.json().data.items.some((item: { id: string }) => item.id === JOB_3)).toBe(false);
    const leak = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB_3}`,
      headers: { authorization: `Bearer ${tokenE}` },
    });
    expect(leak.statusCode).toBe(404);
    expect(leak.json().error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(leak.json())).not.toMatch(/Taylor West/i);
    const listF = await running().app.inject({
      method: "GET",
      url: "/v1/jobs",
      headers: { authorization: `Bearer ${tokenF}` },
    });
    expect(listF.json().data.items).toHaveLength(1);
    expect(listF.json().data.items[0].id).toBe(JOB_3);
    const foreignDelete = await running().app.inject({
      method: "DELETE",
      url: `/v1/jobs/${JOB_3}`,
      headers: { authorization: `Bearer ${tokenE}`, "idempotency-key": KEY_3 },
    });
    expect(foreignDelete.statusCode).toBe(404);
    expect(foreignDelete.json().error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(foreignDelete.json())).not.toMatch(/Taylor West/i);
  });

  it("deletes an unpublished draft and refuses cancel on a draft", async () => {
    const token = await sign({ sub: AUTH_E, email: "owner.e@example.com" });
    const opened = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_1}/quote`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2" },
    });
    expect(opened.statusCode).toBe(200);
    const deleted = await running().app.inject({
      method: "DELETE",
      url: `/v1/jobs/${JOB_1}`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data).toEqual({ id: JOB_1, deleted: true, replayed: false });
    const replay = await running().app.inject({
      method: "DELETE",
      url: `/v1/jobs/${JOB_1}`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.replayed).toBe(true);
    const missing = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB_1}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
    const leftover = await running().admin.query(
      "select count(*)::int as n from commercial.document_drafts where job_id = $1",
      [JOB_1],
    );
    expect(leftover.rows[0]?.n).toBe(0);
    const cancelDraft = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_2}/cancel`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      },
      payload: { reason: "Customer paused the work." },
    });
    expect(cancelDraft.statusCode).toBe(409);
    expect(cancelDraft.json().error.code).toBe("JOB_NOT_CANCELABLE");
  });

  it("rejects client job_created analytics", async () => {
    const token = await sign({ sub: AUTH_E, email: "owner.e@example.com" });
    const response = await running().app.inject({
      method: "POST",
      url: "/v1/analytics/batch",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "55555555-5555-4555-8555-555555555555",
        "content-type": "application/json",
      },
      payload: {
        events: [
          {
            event_id: "66666666-6666-4666-8666-666666666666",
            event_name: "job_created",
            schema_version: 1,
            occurred_at: new Date().toISOString(),
            properties: { mode: "quote" },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
  });
});
