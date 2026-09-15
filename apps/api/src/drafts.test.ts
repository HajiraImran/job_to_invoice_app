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
import { createJwtVerifier } from "./jwt.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const AUTH_Q = "12121212-1212-4121-8121-121212121212";
const AUTH_R = "13131313-1313-4131-8131-131313131313";
const KEY_1 = "14141414-1414-4141-8141-141414141414";
const KEY_2 = "15151515-1515-4151-8151-151515151515";
const KEY_3 = "16161616-1616-4161-8161-161616161616";
const KEY_4 = "17171717-1717-4171-8171-171717171717";
const KEY_5 = "18181818-1818-4181-8181-181818181818";
const JOB_Q = "19191919-1919-4191-8191-191919191919";
const JOB_D = "20202020-2020-4202-8202-202020202020";
const JOB_R = "21212121-2121-4212-8212-212121212121";
const LINE_1 = "22222222-2222-4222-8222-222222222222";
const LINE_2 = "23232323-2323-4232-8232-232323232323";

function setupBody() {
  return {
    business_name: "Quote Draft Co",
    legal_name: "Quote Draft Co LLC",
    contact_name: "Owner Q",
    contact_email: "owner.q@example.com",
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
    id: JOB_Q,
    customer_name: "Riley Chen",
    title: "Kitchen faucet",
    no_site: true,
    internal_notes: "",
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

describe("quote draft API", () => {
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
    const env = loadEnv({ APP_ENV: "development", PORTAL_ORIGIN: "http://localhost:3000" });
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

  async function openQuote(token: string, jobId: string, key: string) {
    return running().app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/quote`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": key,
      },
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

  it("opens one quote draft, saves F01 totals, and replays idempotency", async () => {
    const token = await sign({ sub: AUTH_Q, email: "owner.q@example.com" });
    const setup = await completeSetup(token);
    expect(setup.statusCode).toBe(200);
    const job = await createJob(token, jobBody(), KEY_2);
    expect(job.statusCode).toBe(200);
    expect(job.json().data.quote_draft).toBeNull();
    const opened = await openQuote(token, JOB_Q, KEY_3);
    expect(opened.statusCode).toBe(200);
    const draft = opened.json().data;
    expect(draft.kind).toBe("quote");
    expect(draft.draft_state).toBe("editing");
    expect(draft.version).toBe(1);
    expect(draft.lines).toEqual([]);
    expect(draft.net_cents).toBe(0);
    expect(draft.terms).toBe("Net 14.");
    const replay = await openQuote(token, JOB_Q, KEY_3);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(draft.id);
    const again = await openQuote(token, JOB_Q, KEY_4);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.id).toBe(draft.id);
    const saved = await saveDraft(token, draft.id, 1, draftBody(), KEY_5);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.gross_cents).toBeUndefined();
    expect(saved.json().data.net_cents).toBe(24000);
    expect(saved.json().data.tax_cents).toBe(1980);
    expect(saved.json().data.total_cents).toBe(25980);
    expect(saved.json().data.lines[0].gross_cents).toBe(25000);
    expect(saved.json().data.version).toBe(2);
    const replaySave = await saveDraft(token, draft.id, 1, draftBody(), KEY_5);
    expect(replaySave.statusCode).toBe(200);
    expect(replaySave.json().data.version).toBe(2);
    const mismatch = await saveDraft(token, draft.id, 1, draftBody({ notes: "Other" }), KEY_5);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
    const stale = await saveDraft(
      token,
      draft.id,
      1,
      draftBody({
        lines: [f01Line(), f01Line({ client_line_id: LINE_2, description: "Materials", quantity: "1", unit_price_cents: 500, discount_cents: 0, tax_bp: 0 })],
      }),
      "19191919-1919-4191-8191-191919191918",
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("VERSION_CONFLICT");
    const detail = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB_Q}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.json().data.quote_draft.id).toBe(draft.id);
    expect(detail.json().data.quote_draft.total_cents).toBe(25980);
    const loaded = await running().app.inject({
      method: "GET",
      url: `/v1/drafts/${draft.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().data.total_cents).toBe(25980);
    expect(JSON.stringify(loaded.json())).not.toMatch(/sql|stack|postgres/i);
  });

  it("rejects direct-invoice jobs, extra body fields, and missing If-Match", async () => {
    const token = await sign({ sub: AUTH_Q, email: "owner.q@example.com" });
    const direct = await createJob(token, jobBody({ id: JOB_D, mode: "direct_invoice", title: "Completed work" }), "20202020-2020-4202-8202-202020202021");
    expect(direct.statusCode).toBe(200);
    const quote = await openQuote(token, JOB_D, "20202020-2020-4202-8202-202020202022");
    expect(quote.statusCode).toBe(422);
    expect(quote.json().error.code).toBe("VALIDATION_FAILED");
    const extra = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_Q}/quote`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "20202020-2020-4202-8202-202020202023",
      },
      payload: { total_cents: 1 },
    });
    expect(extra.statusCode).toBe(422);
    const opened = await openQuote(token, JOB_Q, KEY_3);
    const missingMatch = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${opened.json().data.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "20202020-2020-4202-8202-202020202024",
      },
      payload: draftBody(),
    });
    expect(missingMatch.statusCode).toBe(422);
    const unknownJob = await openQuote(token, "99999999-9999-4999-8999-999999999999", "20202020-2020-4202-8202-202020202025");
    expect(unknownJob.statusCode).toBe(404);
  });

  it("isolates quote drafts across workspaces", async () => {
    const tokenQ = await sign({ sub: AUTH_Q, email: "owner.q@example.com" });
    const tokenR = await sign({ sub: AUTH_R, email: "owner.r@example.com" });
    const setupR = await completeSetup(tokenR, KEY_1);
    expect(setupR.statusCode).toBe(200);
    const jobR = await createJob(tokenR, jobBody({ id: JOB_R, customer_name: "Taylor West" }), KEY_2);
    expect(jobR.statusCode).toBe(200);
    const opened = await openQuote(tokenR, JOB_R, KEY_3);
    expect(opened.statusCode).toBe(200);
    const leak = await running().app.inject({
      method: "GET",
      url: `/v1/drafts/${opened.json().data.id}`,
      headers: { authorization: `Bearer ${tokenQ}` },
    });
    expect(leak.statusCode).toBe(404);
    expect(JSON.stringify(leak.json())).not.toMatch(/Taylor West|Net 14/i);
    const steal = await saveDraft(tokenQ, opened.json().data.id, 1, draftBody(), "24242424-2424-4242-8242-242424242424");
    expect(steal.statusCode).toBe(404);
  });

  it("rejects unauthenticated quote routes", async () => {
    const open = await running().app.inject({ method: "POST", url: `/v1/jobs/${JOB_Q}/quote` });
    expect(open.statusCode).toBe(401);
    const get = await running().app.inject({ method: "GET", url: "/v1/drafts/22222222-2222-4222-8222-222222222222" });
    expect(get.statusCode).toBe(401);
  });
});
