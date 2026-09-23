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
const AUTH = "71717171-7171-4171-8171-717171717171";
const AUTH_B = "72727272-7272-4272-8272-727272727272";
const JOB_FREE = "73737373-7373-4373-8373-737373737371";
const JOB_TRIAL = "73737373-7373-4373-8373-737373737372";
const JOB_BLOCKED = "73737373-7373-4373-8373-737373737373";

function setupBody(email: string) {
  return {
    business_name: "Trial Co",
    legal_name: "Trial Co LLC",
    contact_name: "Owner T",
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

describe("SUB03 app-managed trial", () => {
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
      payload: setupBody(email),
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
    expect(saved.statusCode).toBe(200);
    const previewed = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${saved.json().data.id}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(saved.json().data.version) },
    });
    expect(previewed.statusCode).toBe(200);
    return running().app.inject({
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
  }

  it("starts a once-only 14-day trial, queues EMAIL09, and consumes trial slots after free jobs", async () => {
    const token = await sign({ sub: AUTH, email: "owner.trial@example.com" });
    const other = await sign({ sub: AUTH_B, email: "owner.other@example.com" });
    const setup = await completeSetup(token, "owner.trial@example.com");
    expect(setup.statusCode).toBe(200);
    await completeSetup(other, "owner.other@example.com");

    const before = await running().app.inject({
      method: "GET",
      url: "/v1/subscription",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().data).toMatchObject({
      source: "free",
      can_publish: true,
      can_start_trial: true,
      free_jobs_consumed: 0,
      free_jobs_remaining: 3,
      trial: null,
    });

    const missingAck = await running().app.inject({
      method: "POST",
      url: "/v1/subscription/trial",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: {},
    });
    expect(missingAck.statusCode).toBe(422);

    const firstPublish = await publishQuote(token, JOB_FREE);
    expect(firstPublish.statusCode).toBe(202);
    const afterFree = await running().admin.query<{ origin: string; free: number }>(
      `select j.entitlement_origin as origin, a.free_jobs_consumed::int as free
       from commercial.jobs j
       join commercial.job_allowances a on a.workspace_id = j.workspace_id
       where j.id = $1`,
      [JOB_FREE],
    );
    expect(afterFree.rows[0]).toEqual({ origin: "free", free: 1 });

    await running().admin.query(
      `update commercial.job_allowances a
       set free_jobs_consumed = 3
       from commercial.workspaces w
       where a.workspace_id = w.workspace_id and w.owner_user_id = (
         select id from identity.app_users where auth_user_id = $1
       )`,
      [AUTH],
    );

    const key = randomUUID();
    const started = await running().app.inject({
      method: "POST",
      url: "/v1/subscription/trial",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      payload: { acknowledged: true },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().data.source).toBe("trial");
    expect(started.json().data.can_start_trial).toBe(false);
    expect(started.json().data.trial.active).toBe(true);
    expect(started.json().data.trial.jobs_remaining).toBe(20);
    const ends = Date.parse(started.json().data.trial.ends_at);
    const begins = Date.parse(started.json().data.trial.started_at);
    expect(ends - begins).toBe(14 * 24 * 60 * 60 * 1000);

    const replay = await running().app.inject({
      method: "POST",
      url: "/v1/subscription/trial",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      payload: { acknowledged: true },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.trial.started_at).toBe(started.json().data.trial.started_at);

    const second = await running().app.inject({
      method: "POST",
      url: "/v1/subscription/trial",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: { acknowledged: true },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("TRIAL_ALREADY_STARTED");

    const me = await running().app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.json().data.entitlement).toEqual({ source: "trial", can_publish: true });

    const leak = await running().app.inject({
      method: "GET",
      url: "/v1/subscription",
      headers: { authorization: `Bearer ${other}` },
    });
    expect(leak.json().data.trial).toBeNull();
    expect(leak.json().data.can_start_trial).toBe(true);

    const trialPublish = await publishQuote(token, JOB_TRIAL);
    expect(trialPublish.statusCode).toBe(202);
    const trialJob = await running().admin.query<{ origin: string; free: number; trial: number }>(
      `select j.entitlement_origin as origin, a.free_jobs_consumed::int as free, a.trial_jobs_consumed::int as trial
       from commercial.jobs j
       join commercial.job_allowances a on a.workspace_id = j.workspace_id
       where j.id = $1`,
      [JOB_TRIAL],
    );
    expect(trialJob.rows[0]).toEqual({ origin: "trial", free: 3, trial: 1 });

    const email = await running().admin.query<{ template_id: string; available_at: Date; remaining: number }>(
      `select o.payload_json->>'template_id' as template_id, o.available_at,
              (o.payload_json->>'remaining_free_slots')::int as remaining
       from commercial.outbox_tasks o
       join commercial.workspaces w on w.workspace_id = o.workspace_id
       join identity.app_users u on u.id = w.owner_user_id
       where u.auth_user_id = $1 and o.payload_json->>'template_id' = 'EMAIL09'`,
      [AUTH],
    );
    expect(email.rows).toHaveLength(1);
    expect(email.rows[0]?.remaining).toBe(0);
    expect(email.rows[0]?.available_at.getTime()).toBe(ends - 2 * 24 * 60 * 60 * 1000);

    const analytics = await running().admin.query<{ n: number }>(
      `select count(*)::int as n
       from commercial.analytics_events e
       join commercial.workspaces w on w.workspace_id = e.workspace_id
       join identity.app_users u on u.id = w.owner_user_id
       where u.auth_user_id = $1 and e.event_name = 'trial_started'`,
      [AUTH],
    );
    expect(analytics.rows[0]?.n).toBe(1);

    await running().admin.query(
      `update commercial.job_allowances a
       set trial_ends_at = now() - interval '1 hour'
       from commercial.workspaces w
       where a.workspace_id = w.workspace_id and w.owner_user_id = (
         select id from identity.app_users where auth_user_id = $1
       )`,
      [AUTH],
    );
    const expired = await running().app.inject({
      method: "GET",
      url: "/v1/subscription",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(expired.json().data.can_publish).toBe(false);
    expect(expired.json().data.trial.active).toBe(false);

    const blocked = await publishQuote(token, JOB_BLOCKED);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("ENTITLEMENT_REQUIRED");
    const kept = await running().app.inject({
      method: "GET",
      url: `/v1/jobs/${JOB_TRIAL}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().data.lifecycle).toBe("active");
  }, 60_000);
});
