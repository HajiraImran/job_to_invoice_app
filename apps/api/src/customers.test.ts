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
import { decodeCustomerCursor, encodeCustomerCursor } from "./customers.ts";
import { createJwtVerifier } from "./jwt.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const AUTH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = (n: string) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;
const CUS_1 = "11111111-1111-4111-8111-111111111111";
const CUS_2 = "22222222-2222-4222-8222-222222222222";
const CUS_3 = "33333333-3333-4333-8333-333333333333";
const JOB_1 = "44444444-4444-4444-8444-444444444444";
const JOB_2 = "55555555-5555-4555-8555-555555555555";
const LINE_1 = "66666666-6666-4666-8666-666666666666";

function setupBody() {
  return {
    business_name: "Customer Co",
    legal_name: "Customer Co LLC",
    contact_name: "Casey Owner",
    contact_email: "owner@example.com",
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

describe("customers API", () => {
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
      verifyJwt: createJwtVerifier({ issuer: fixture.issuer, audience: fixture.audience, jwks: fixture.jwks }),
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.end();
    await stop?.();
  });

  function running() {
    if (!app || !admin) throw new Error("API test app did not start");
    return { app, admin };
  }

  async function tokenFor(sub: string, email: string) {
    return sign({ sub, email });
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
      payload: setupBody(),
    });
  }

  async function createCustomer(token: string, body: unknown, key: string) {
    return running().app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      payload: body as object,
    });
  }

  it("binds customer cursors to state and search", () => {
    const encoded = encodeCustomerCursor({ u: "2026-09-24T12:00:00.000Z", i: CUS_1, s: "José", t: "active" });
    expect(encoded).not.toMatch(/José/);
    expect(decodeCustomerCursor(encoded)?.t).toBe("active");
    expect(decodeCustomerCursor("not-a-cursor")).toBeUndefined();
  });

  it("creates, pages, updates, archives, and deletes without leaking private fields", async () => {
    const token = await tokenFor(AUTH_A, "owner.a@example.com");
    expect((await completeSetup(token, KEY("a"))).statusCode).toBe(200);
    const missing = await running().app.inject({ method: "GET", url: "/v1/customers" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error).toMatchObject({ code: "AUTHENTICATION_REQUIRED", field_errors: [], retryable: false });

    const created = await createCustomer(
      token,
      { id: CUS_1, name: "  José García  ", email: "a.b+tag@gmail.com", phone: "+12025550123", billing_address: { line1: "123 Main Street", city: "Austin", state: "TX", postal_code: "78701" } },
      KEY("b"),
    );
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body.data.name).toBe("José García");
    expect(body.data.email).toBe("a.b+tag@gmail.com");
    expect(body.data).not.toHaveProperty("normalized_email");
    expect(body.data).not.toHaveProperty("workspace_id");
    expect(body.meta.request_id).toBeTruthy();

    const replay = await createCustomer(
      token,
      { id: CUS_1, name: "  José García  ", email: "a.b+tag@gmail.com", phone: "+12025550123", billing_address: { line1: "123 Main Street", city: "Austin", state: "TX", postal_code: "78701" } },
      KEY("b"),
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(CUS_1);

    const mismatch = await createCustomer(token, { id: CUS_1, name: "Other" }, KEY("b"));
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("IDEMPOTENCY_MISMATCH");

    const national = await createCustomer(token, { name: "Ada", phone: "2025550123" }, KEY("c"));
    expect(national.statusCode).toBe(422);
    const zip = await createCustomer(
      token,
      { name: "Ada", billing_address: { line1: "1 Main", city: "Austin", state: "TX", zip: "78701" } },
      KEY("d"),
    );
    expect(zip.statusCode).toBe(422);

    const second = await createCustomer(token, { id: CUS_2, name: "Blair" }, KEY("e"));
    expect(second.statusCode).toBe(200);
    const third = await createCustomer(token, { id: CUS_3, name: "Casey Search" }, KEY("f"));
    expect(third.statusCode).toBe(200);
    const page = await running().app.inject({
      method: "GET",
      url: "/v1/customers?limit=2&state=active",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().data.customers).toHaveLength(2);
    const cursor = page.json().data.next_cursor as string;
    const rebound = await running().app.inject({
      method: "GET",
      url: `/v1/customers?limit=2&state=archived&cursor=${encodeURIComponent(cursor)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rebound.statusCode).toBe(422);

    const duplicate = await createCustomer(token, { name: "Copy", email: "A.B+tag@Gmail.com" }, KEY("1"));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("DUPLICATE_CUSTOMER_EMAIL");
    expect(duplicate.json().error.duplicates[0]).toMatchObject({ id: CUS_1, name: "José García", archived: false });
    expect(JSON.stringify(duplicate.json())).not.toMatch(/normalized_email|workspace_id|a\.b\+tag/i);
    const stored = await running().admin.query(
      "select count(*)::int as n from commercial.idempotency_records where key = $1",
      [KEY("1")],
    );
    expect(stored.rows[0].n).toBe(0);
    const confirmed = await createCustomer(
      token,
      { name: "Copy", email: "A.B+tag@Gmail.com", confirm_duplicate_email: true },
      KEY("1"),
    );
    expect(confirmed.statusCode).toBe(200);

    const distinct = await createCustomer(token, { name: "Dots", email: "abtag@gmail.com" }, KEY("2"));
    expect(distinct.statusCode).toBe(200);

    const patched = await running().app.inject({
      method: "PATCH",
      url: `/v1/customers/${CUS_2}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY("3"),
        "if-match": "1",
      },
      payload: { name: "Blair Updated" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.version).toBe(2);
    const conflict = await running().app.inject({
      method: "PATCH",
      url: `/v1/customers/${CUS_2}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY("4"),
        "if-match": "1",
      },
      payload: { name: "Stale" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("VERSION_CONFLICT");

    const archived = await running().app.inject({
      method: "POST",
      url: `/v1/customers/${CUS_3}/archive`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY("5"),
      },
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.archived_at).toBeTruthy();
    const archivedAgain = await running().app.inject({
      method: "POST",
      url: `/v1/customers/${CUS_3}/archive`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY("6"),
      },
      payload: { archived: true },
    });
    expect(archivedAgain.json().data.version).toBe(archived.json().data.version);

    const other = await tokenFor(AUTH_B, "owner.b@example.com");
    expect((await completeSetup(other, KEY("7"))).statusCode).toBe(200);
    const hidden = await running().app.inject({
      method: "GET",
      url: `/v1/customers/${CUS_1}`,
      headers: { authorization: `Bearer ${other}` },
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("NOT_FOUND");
    const hiddenPatch = await running().app.inject({
      method: "PATCH",
      url: `/v1/customers/${CUS_1}`,
      headers: {
        authorization: `Bearer ${other}`,
        "content-type": "application/json",
        "idempotency-key": KEY("8"),
        "if-match": "1",
      },
      payload: { name: "Stolen" },
    });
    expect(hiddenPatch.statusCode).toBe(404);

    const job = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY("9"),
      },
      payload: { id: JOB_1, customer_id: CUS_1, title: "Faucet", no_site: true, mode: "quote" },
    });
    expect(job.statusCode).toBe(200);
    expect(job.json().data.customer_id).toBe(CUS_1);
    expect(job.json().data).not.toHaveProperty("workspace_id");

    const archivedJob = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY("0"),
      },
      payload: { id: JOB_2, customer_id: CUS_3, title: "Archived", no_site: true, mode: "direct_invoice" },
    });
    expect(archivedJob.statusCode).toBe(409);
    expect(archivedJob.json().error.code).toBe("CUSTOMER_ARCHIVED");

    const legacy = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "98989898-9898-4989-8989-989898989898",
      },
      payload: { id: "88888888-8888-4888-8888-888888888888", customer_name: "Legacy Name", title: "Legacy", no_site: true, mode: "quote" },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().data.customer_name).toBe("Legacy Name");

    const associated = await running().app.inject({
      method: "GET",
      url: `/v1/jobs?customer_id=${CUS_1}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(associated.statusCode).toBe(200);
    expect(associated.json().data.items.map((item: { id: string }) => item.id)).toContain(JOB_1);
    const missingCustomer = await running().app.inject({
      method: "GET",
      url: `/v1/jobs?customer_id=${CUS_1}`,
      headers: { authorization: `Bearer ${other}` },
    });
    expect(missingCustomer.statusCode).toBe(404);

    const blocked = await running().app.inject({
      method: "DELETE",
      url: `/v1/customers/${CUS_1}`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "abababab-abab-4aba-8aba-abababababab" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("CUSTOMER_REFERENCED");
    const removed = await running().app.inject({
      method: "DELETE",
      url: `/v1/customers/${distinct.json().data.id}`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd" },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.deleted).toBe(true);

    const audit = await running().admin.query(
      "select safe_metadata_json from commercial.audit_events where action = 'customer_created' limit 1",
    );
    expect(audit.rows[0].safe_metadata_json).toEqual({});
    const analytics = await running().admin.query(
      "select count(*)::int as n from commercial.analytics_events where safe_properties_json::text ilike '%gmail%'",
    );
    expect(analytics.rows[0].n).toBe(0);
  });

  it("does not rewrite an issued quote snapshot when the customer changes", async () => {
    const token = await tokenFor(AUTH_A, "owner.a@example.com");
    const opened = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_1}/quote`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "12121212-1212-4121-8121-121212121212" },
    });
    expect(opened.statusCode).toBe(200);
    const saved = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${opened.json().data.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "13131313-1313-4131-8131-131313131313",
        "if-match": String(opened.json().data.version),
      },
      payload: {
        notes: "Replace cartridge.",
        terms: "Net 14.",
        expiry_days: 14,
        lines: [{
          client_line_id: LINE_1,
          description: "Labour hour",
          unit: "hour",
          quantity: "1",
          unit_price_cents: 1000,
          discount_cents: 0,
          tax_bp: 0,
        }],
      },
    });
    expect(saved.statusCode).toBe(200);
    const preview = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${opened.json().data.id}/preview`,
      headers: { authorization: `Bearer ${token}`, "if-match": String(saved.json().data.version) },
    });
    expect(preview.statusCode).toBe(200);
    const published = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${opened.json().data.id}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "14141414-1414-4141-8141-141414141414",
        "if-match": String(saved.json().data.version),
      },
      payload: {
        preview_hash: preview.json().data.preview_hash,
        recipient_email: "customer@example.com",
      },
    });
    expect(published.statusCode).toBe(202);
    const before = await running().admin.query(
      "select canonical_snapshot_bytes from commercial.documents where job_id = $1",
      [JOB_1],
    );
    const draftBefore = await running().admin.query(
      "select payload_json from commercial.document_drafts where job_id = $1",
      [JOB_1],
    );
    const current = await running().app.inject({
      method: "GET",
      url: `/v1/customers/${CUS_1}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const renamed = await running().app.inject({
      method: "PATCH",
      url: `/v1/customers/${CUS_1}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "15151515-1515-4151-8151-151515151515",
        "if-match": String(current.json().data.version),
      },
      payload: { name: "José Updated" },
    });
    expect(renamed.statusCode).toBe(200);
    const after = await running().admin.query(
      "select canonical_snapshot_bytes from commercial.documents where job_id = $1",
      [JOB_1],
    );
    const draftAfter = await running().admin.query(
      "select payload_json from commercial.document_drafts where job_id = $1",
      [JOB_1],
    );
    expect(after.rows[0].canonical_snapshot_bytes).toEqual(before.rows[0].canonical_snapshot_bytes);
    expect(draftAfter.rows).toEqual(draftBefore.rows);
  });
});
