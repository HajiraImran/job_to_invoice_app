import { loadEnv } from "@job-to-invoice/config";
import { CATALOGUE_SEED_DESCRIPTIONS } from "@job-to-invoice/schemas";
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
import { decodeItemCursor, encodeItemCursor } from "./items.ts";
import { createJwtVerifier } from "./jwt.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const AUTH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AUTH_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AUTH_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const KEY_1 = "11111111-1111-4111-8111-111111111111";
const KEY_2 = "22222222-2222-4222-8222-222222222222";
const KEY_3 = "33333333-3333-4333-8333-333333333333";
const KEY_4 = "44444444-4444-4444-8444-444444444444";
const KEY_5 = "55555555-5555-4555-8555-555555555555";
const KEY_6 = "66666666-6666-4666-8666-666666666666";
const KEY_7 = "77777777-7777-4777-8777-777777777777";
const ITEM_1 = "88888888-8888-4888-8888-888888888888";
const JOB_1 = "99999999-9999-4999-8999-999999999999";

function setupBody(overrides: Record<string, unknown> = {}) {
  return {
    business_name: "Catalogue Co",
    legal_name: "Catalogue Co LLC",
    contact_name: "Casey Owner",
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

function itemBody(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_1,
    description: "Custom tile",
    unit: "square_foot",
    default_quantity: "1",
    unit_price_cents: 1250,
    discount_cents: 0,
    tax_bp: 0,
    ...overrides,
  };
}

function itemPatchBody(overrides: Record<string, unknown> = {}) {
  const { id: _id, ...body } = itemBody(overrides);
  return body;
}

function f01Line(overrides: Record<string, unknown> = {}) {
  return {
    client_line_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    description: "Labour hour",
    unit: "hour",
    quantity: "2.5",
    unit_price_cents: 10000,
    discount_cents: 1000,
    tax_bp: 825,
    ...overrides,
  };
}

describe("catalogue items API", () => {
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

  it("encodes list cursors as opaque filter-bound tokens", () => {
    const encoded = encodeItemCursor({ u: "2026-09-22T12:00:00.000Z", i: ITEM_1, s: "labour", t: "active" });
    expect(encoded).not.toMatch(/labour|Labour|2026-09-22T12:00:00/);
    expect(decodeItemCursor(encoded)).toEqual({
      u: "2026-09-22T12:00:00.000Z",
      i: ITEM_1,
      s: "labour",
      t: "active",
    });
    expect(decodeItemCursor("not-a-cursor")).toBeUndefined();
  });

  it("rejects missing authentication and incomplete setup", async () => {
    const list = await running().app.inject({ method: "GET", url: "/v1/items" });
    expect(list.statusCode).toBe(401);
    const token = await sign({ sub: AUTH_C, email: "owner.c@example.com" });
    await me(token);
    const beforeSetup = await running().app.inject({
      method: "GET",
      url: "/v1/items",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(beforeSetup.statusCode).toBe(403);
    expect(beforeSetup.json().error.code).toBe("SETUP_INCOMPLETE");
  });

  it("seeds five zero-price examples on setup and searches case-insensitively", async () => {
    const token = await sign({ sub: AUTH_A, email: "owner.a@example.com" });
    const setup = await completeSetup(token);
    expect(setup.statusCode).toBe(200);
    const listed = await running().app.inject({
      method: "GET",
      url: "/v1/items",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.statusCode).toBe(200);
    const items = listed.json().data.items as Array<{
      description: string;
      unit_price_cents: number;
      discount_cents: number;
      tax_bp: number;
    }>;
    expect(items.map((item) => item.description).sort()).toEqual([...CATALOGUE_SEED_DESCRIPTIONS].sort());
    expect(items.every((item) => item.unit_price_cents === 0 && item.discount_cents === 0 && item.tax_bp === 0)).toBe(
      true,
    );
    const search = await running().app.inject({
      method: "GET",
      url: "/v1/items?search=LABOUR",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().data.items).toHaveLength(1);
    expect(search.json().data.items[0].description).toBe("Labour hour");
  });

  it("creates, replays, patches, archives, and conceals cross-tenant items", async () => {
    const token = await sign({ sub: AUTH_D, email: "owner.d@example.com" });
    await completeSetup(token);
    const created = await running().app.inject({
      method: "POST",
      url: "/v1/items",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY_2,
      },
      payload: itemBody(),
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data.unit_price_cents).toBe(1250);
    expect(created.json().data.default_quantity).toBe("1");
    const replay = await running().app.inject({
      method: "POST",
      url: "/v1/items",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY_2,
      },
      payload: itemBody(),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(ITEM_1);
    const mismatch = await running().app.inject({
      method: "POST",
      url: "/v1/items",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY_2,
      },
      payload: itemBody({ description: "Other tile" }),
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
    const floats = await running().app.inject({
      method: "POST",
      url: "/v1/items",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY_3,
      },
      payload: itemBody({ id: "12121212-1212-4121-8121-121212121212", unit_price_cents: 12.5 }),
    });
    expect(floats.statusCode).toBe(422);

    const patched = await running().app.inject({
      method: "PATCH",
      url: `/v1/items/${ITEM_1}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "if-match": String(created.json().data.version),
      },
      payload: itemPatchBody({ unit_price_cents: 2500 }),
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.unit_price_cents).toBe(2500);
    const stale = await running().app.inject({
      method: "PATCH",
      url: `/v1/items/${ITEM_1}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "if-match": String(created.json().data.version),
      },
      payload: itemPatchBody({ unit_price_cents: 3000 }),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("VERSION_CONFLICT");

    const archived = await running().app.inject({
      method: "POST",
      url: `/v1/items/${ITEM_1}/archive`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "if-match": String(patched.json().data.version),
      },
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.archived_at).toMatch(/T/);
    const active = await running().app.inject({
      method: "GET",
      url: "/v1/items",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(active.json().data.items.some((item: { id: string }) => item.id === ITEM_1)).toBe(false);
    const hidden = await running().app.inject({
      method: "GET",
      url: "/v1/items?state=archived",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(hidden.json().data.items.some((item: { id: string }) => item.id === ITEM_1)).toBe(true);

    const other = await sign({ sub: AUTH_B, email: "owner.b@example.com" });
    await completeSetup(other, KEY_4);
    const foreign = await running().app.inject({
      method: "GET",
      url: `/v1/items/${ITEM_1}`,
      headers: { authorization: `Bearer ${other}` },
    });
    expect(foreign.statusCode).toBe(404);
    const foreignPatch = await running().app.inject({
      method: "PATCH",
      url: `/v1/items/${ITEM_1}`,
      headers: {
        authorization: `Bearer ${other}`,
        "content-type": "application/json",
        "if-match": "1",
      },
      payload: itemPatchBody({ unit_price_cents: 1 }),
    });
    expect(foreignPatch.statusCode).toBe(404);
  });

  it("QA15: editing a catalogue price leaves issued document bytes unchanged", async () => {
    const token = await sign({ sub: AUTH_C, email: "owner.c@example.com" });
    await completeSetup(token, KEY_4);
    const listed = await running().app.inject({
      method: "GET",
      url: "/v1/items?search=Labour",
      headers: { authorization: `Bearer ${token}` },
    });
    const labour = listed.json().data.items[0] as { id: string; version: number; unit_price_cents: number };
    const priced = await running().app.inject({
      method: "PATCH",
      url: `/v1/items/${labour.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "if-match": String(labour.version),
      },
      payload: {
        description: "Labour hour",
        unit: "hour",
        default_quantity: "1",
        unit_price_cents: 10000,
        discount_cents: 0,
        tax_bp: 825,
      },
    });
    expect(priced.statusCode).toBe(200);

    const job = await running().app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY_5,
      },
      payload: {
        id: JOB_1,
        customer_name: "Riley Chen",
        title: "Kitchen faucet",
        no_site: true,
        mode: "quote",
      },
    });
    expect(job.statusCode).toBe(200);
    const opened = await running().app.inject({
      method: "POST",
      url: `/v1/jobs/${JOB_1}/quote`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": KEY_6,
      },
    });
    expect(opened.statusCode).toBe(200);
    const saved = await running().app.inject({
      method: "PATCH",
      url: `/v1/drafts/${opened.json().data.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": KEY_7,
        "if-match": String(opened.json().data.version),
      },
      payload: {
        notes: "Replace cartridge.",
        terms: "Net 14.",
        expiry_days: 14,
        lines: [f01Line()],
      },
    });
    expect(saved.statusCode).toBe(200);
    const previewed = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${saved.json().data.id}/preview`,
      headers: {
        authorization: `Bearer ${token}`,
        "if-match": String(saved.json().data.version),
      },
    });
    expect(previewed.statusCode).toBe(200);
    const published = await running().app.inject({
      method: "POST",
      url: `/v1/drafts/${saved.json().data.id}/publish`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "abababab-abab-4aba-8aba-abababababab",
        "if-match": String(saved.json().data.version),
      },
      payload: { preview_hash: previewed.json().data.preview_hash, recipient_email: "customer@example.com" },
    });
    expect(published.statusCode).toBe(202);
    const before = await running().admin.query<{ bytes: Buffer; price: string }>(
      `select d.canonical_snapshot_bytes as bytes, l.unit_price_cents::text as price
       from commercial.documents d
       join commercial.document_lines l on l.workspace_id = d.workspace_id and l.document_id = d.id
       where d.id = $1`,
      [published.json().data.id],
    );
    expect(before.rows[0]?.price).toBe("10000");

    const raised = await running().app.inject({
      method: "PATCH",
      url: `/v1/items/${labour.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "if-match": String(priced.json().data.version),
      },
      payload: {
        description: "Labour hour",
        unit: "hour",
        default_quantity: "1",
        unit_price_cents: 20000,
        discount_cents: 0,
        tax_bp: 825,
      },
    });
    expect(raised.statusCode).toBe(200);
    expect(raised.json().data.unit_price_cents).toBe(20000);

    const after = await running().admin.query<{ bytes: Buffer; price: string }>(
      `select d.canonical_snapshot_bytes as bytes, l.unit_price_cents::text as price
       from commercial.documents d
       join commercial.document_lines l on l.workspace_id = d.workspace_id and l.document_id = d.id
       where d.id = $1`,
      [published.json().data.id],
    );
    expect(after.rows[0]?.price).toBe("10000");
    expect(after.rows[0]?.bytes.equals(before.rows[0]?.bytes ?? Buffer.alloc(0))).toBe(true);
    const latest = await running().app.inject({
      method: "GET",
      url: `/v1/items/${labour.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(latest.json().data.unit_price_cents).toBe(20000);
  });
});
