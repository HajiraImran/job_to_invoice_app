import { buildQuoteSnapshot, originalPdfObjectKey } from "@job-to-invoice/domain";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processGenerateOriginalPdf } from "./outbox.ts";
// @ts-expect-error test harness is outside the worker package
import { applyCleanMigrations } from "../../scripts/db-admin.mjs";
// @ts-expect-error test harness is outside the worker package
import { resolveMigrationsUrl } from "../../scripts/postgres-url.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTH = "aaaa1111-aaaa-4111-8aaa-aaaaaaaaaaaa";
const WS = "11111111-1111-4111-8111-111111111111";
const MEM = "aaaa2222-aaaa-4222-8222-aaaaaaaaaaaa";
const CUSTOMER = "aaaa4444-aaaa-4444-8444-aaaaaaaaaaaa";
const JOB = "aaaa5555-aaaa-4555-8555-aaaaaaaaaaaa";
const DOC = "aaaa7777-aaaa-4777-8777-aaaaaaaaaaaa";
const LINE = "aaaa8888-aaaa-4888-8888-aaaaaaaaaaaa";
const EMPTY_DOC = "aaaa9999-aaaa-4999-8999-aaaaaaaaaaaa";
const EMPTY_JOB = "aaaa5555-aaaa-4555-8555-aaaaaaaaaaa1";
const TASK = "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbbb1";
const EMPTY_TASK = "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbbb2";
const EVENT = "cccc1111-cccc-4111-8ccc-ccccccccccc1";
const EMPTY_EVENT = "cccc1111-cccc-4111-8ccc-ccccccccccc2";

function f01Snapshot() {
  return buildQuoteSnapshot({
    business: {
      business_name: "Quote Co",
      legal_name: "Quote Co LLC",
      contact_name: "Owner",
      contact_email: "owner@example.com",
      contact_phone: "+12025550123",
      address: {
        line1: "123 Main Street",
        line2: null,
        city: "Austin",
        state: "TX",
        postal_code: "78701",
      },
      timezone: "America/Chicago",
      default_tax_bp: 0,
    },
    customer: { name: "Riley Chen", email: null, phone: null, billing_address: null },
    job: { id: JOB, title: "Kitchen faucet", site_address: null, no_site: true },
    notes: "Replace cartridge.",
    terms: "Net 14.",
    expiry_days: 14,
    expiry_local_date: "2026-09-29",
    expiry_timezone: "America/Chicago",
    expires_at: "2026-09-30T04:59:59.000Z",
    issue_date: "2026-09-15",
    lines: [
      {
        client_line_id: LINE,
        description: "Labour hour",
        unit: "hour",
        custom_unit_label: null,
        quantity: "2.5",
        unit_price_cents: 10000,
        discount_cents: 1000,
        tax_bp: 825,
      },
    ],
  }).snapshot;
}

describe("generate original PDF outbox", () => {
  let stop: (() => Promise<void>) | undefined;
  let pool: Pool | undefined;
  let admin: Client | undefined;

  beforeAll(async () => {
    const resolved = await resolveMigrationsUrl();
    stop = resolved.stop;
    admin = new Client({ connectionString: resolved.url });
    await admin.connect();
    await applyCleanMigrations(admin, repoRoot);
    await admin.query("grant api_app, worker_app to current_user");
    pool = new Pool({ connectionString: resolved.url, max: 8 });
    const snapshot = f01Snapshot();
    const canonical = Buffer.from(JSON.stringify(snapshot));
    const sha = createHash("sha256").update(canonical).digest("hex");
    await admin.query(
      `insert into identity.app_users (
        id, auth_user_id, normalized_email, display_email, status,
        last_authenticated_at, terms_version, privacy_version
      ) values ($1, $2, $3, $3, 'active', now(), '1', '1')`,
      [USER, AUTH, "owner@example.com"],
    );
    await admin.query(
      `insert into commercial.workspaces (
        workspace_id, id, owner_user_id, business_name, legal_name, contact_name,
        contact_email, timezone, trade, default_terms
      ) values ($1, $1, $2, 'Quote Co', 'Quote Co LLC', 'Owner', 'owner@example.com', 'America/Chicago', 'handyman', 'Net 14')`,
      [WS, USER],
    );
    await admin.query(
      `insert into commercial.memberships (workspace_id, id, user_id, role, status)
       values ($1, $2, $3, 'owner', 'active')`,
      [WS, MEM, USER],
    );
    await admin.query(`insert into commercial.customers (workspace_id, id, name) values ($1, $2, 'Riley Chen')`, [
      WS,
      CUSTOMER,
    ]);
    await admin.query(
      `insert into commercial.jobs (workspace_id, id, customer_id, title, no_site, lifecycle, mode)
       values ($1, $2, $3, 'Kitchen faucet', true, 'draft', 'quote')`,
      [WS, JOB, CUSTOMER],
    );
    await admin.query(
      `insert into commercial.jobs (workspace_id, id, customer_id, title, no_site, lifecycle, mode)
       values ($1, $2, $3, 'Empty', true, 'draft', 'quote')`,
      [WS, EMPTY_JOB, CUSTOMER],
    );
    await admin.query(
      `insert into commercial.documents (
        workspace_id, id, created_by, job_id, kind, number, revision_no, lifecycle,
        issued_at, issue_date, currency, net_cents, tax_cents, total_cents,
        snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256
      ) values ($1, $2, $3, $4, 'quote', 'Q-000001', 1, 'issued', now(), date '2026-09-15', 'USD', $5, $6, $7, $8::jsonb, $9, 1, $10)`,
      [WS, DOC, USER, JOB, snapshot.net_cents, snapshot.tax_cents, snapshot.total_cents, JSON.stringify(snapshot), canonical, sha],
    );
    const line = snapshot.lines[0];
    if (!line) {
      throw new Error("expected F01 line");
    }
    await admin.query(
      `insert into commercial.document_lines (
        workspace_id, id, document_id, position, line_kind, description, quantity, unit,
        unit_price_cents, discount_cents, net_cents, tax_bp, tax_cents, total_cents
      ) values ($1, $2, $3, 1, 'source', 'Labour hour', 2.5, 'hour', 10000, 1000, $4, 825, $5, $6)`,
      [WS, LINE, DOC, line.net_cents, line.tax_cents, line.total_cents],
    );
    const emptySnapshot = JSON.stringify({ schema_version: 1, kind: "quote", currency: "USD", notes: "", terms: "", lines: [] });
    await admin.query(
      `insert into commercial.documents (
        workspace_id, id, created_by, job_id, kind, number, revision_no, lifecycle,
        issued_at, issue_date, currency, net_cents, tax_cents, total_cents,
        snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256
      ) values ($1, $2, $3, $4, 'quote', 'Q-000002', 1, 'issued', now(), date '2026-09-15', 'USD', 0, 0, 0, $5::jsonb, $6, 1, $7)`,
      [WS, EMPTY_DOC, USER, EMPTY_JOB, emptySnapshot, Buffer.from("{}"), "cd".repeat(32)],
    );
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
    await stop?.();
  });

  function running() {
    if (!pool || !admin) {
      throw new Error("worker test database did not start");
    }
    return { pool, admin };
  }

  async function insertTask(id: string, eventId: string, documentId: string, payload: Record<string, unknown>) {
    await running().admin.query(
      `insert into commercial.outbox_tasks (
        workspace_id, id, event_id, task_type, aggregate_id, payload_json, status, effect_key
      ) values ($1, $2, $3, 'generate_original_pdf', $4, $5::jsonb, 'pending', $6)`,
      [WS, id, eventId, documentId, JSON.stringify(payload), `${WS}:${documentId}:original_pdf`],
    );
  }

  async function rewind(taskId: string) {
    await running().admin.query(
      `update commercial.outbox_tasks set available_at = now() - interval '1 second' where id = $1`,
      [taskId],
    );
  }

  it("uploads once, reuses the reserved object key, and ignores a duplicate claim", async () => {
    const keys: string[] = [];
    const stages: string[] = [];
    const store = {
      putObject: async ({ key }: { key: string }) => {
        keys.push(key);
      },
    };
    const render = async () => Buffer.from("%PDF-1.4 original");
    await insertTask(TASK, EVENT, DOC, { document_id: DOC, kind: "quote", workspace_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    const first = await processGenerateOriginalPdf({
      pool: running().pool,
      store,
      render,
      onStage: (stage) => stages.push(stage),
    });
    expect(first).toBe("done");
    expect(stages).toEqual(["claim_started", "claimed", "rendering", "uploading", "completed"]);
    const reserved = await running().admin.query<{ payload_json: { artifact_id: string } }>(
      "select payload_json from commercial.outbox_tasks where id = $1",
      [TASK],
    );
    const artifactId = reserved.rows[0]?.payload_json.artifact_id;
    if (!artifactId) {
      throw new Error("expected reserved artifact id");
    }
    expect(keys).toEqual([
      originalPdfObjectKey({ workspaceId: WS, documentId: DOC, revision: 1, artifactId }),
    ]);
    const second = await processGenerateOriginalPdf({ pool: running().pool, store, render });
    expect(second).toBe("idle");
    expect(keys).toHaveLength(1);
    const artifact = await running().admin.query(
      "select object_key, template_version, state from commercial.artifacts where document_id = $1",
      [DOC],
    );
    expect(artifact.rows[0]).toMatchObject({
      object_key: keys[0],
      template_version: "quote-original-v1",
      state: "ready",
    });
    const [left, right] = await Promise.all([
      processGenerateOriginalPdf({ pool: running().pool, store, render }),
      processGenerateOriginalPdf({ pool: running().pool, store, render }),
    ]);
    expect([left, right].sort()).toEqual(["idle", "idle"]);
  });

  it("retries upload with the same key and marks the fifth failure dead", async () => {
    const retryDoc = "dddd7777-dddd-4777-8777-dddddddddddd";
    const retryTask = "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbbb3";
    const retryEvent = "cccc1111-cccc-4111-8ccc-ccccccccccc3";
    const retryLine = "dddd8888-dddd-4888-8888-dddddddddddd";
    const retryJob = "dddd5555-dddd-4555-8555-dddddddddddd";
    const snapshot = f01Snapshot();
    const canonical = Buffer.from(JSON.stringify(snapshot));
    await running().admin.query(
      `insert into commercial.jobs (workspace_id, id, customer_id, title, no_site, lifecycle, mode)
       values ($1, $2, $3, 'Retry', true, 'draft', 'quote')`,
      [WS, retryJob, CUSTOMER],
    );
    await running().admin.query(
      `insert into commercial.documents (
        workspace_id, id, created_by, job_id, kind, number, revision_no, lifecycle,
        issued_at, issue_date, currency, net_cents, tax_cents, total_cents,
        snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256
      ) values ($1, $2, $3, $4, 'quote', 'Q-000003', 1, 'issued', now(), date '2026-09-15', 'USD', $5, $6, $7, $8::jsonb, $9, 1, $10)`,
      [
        WS,
        retryDoc,
        USER,
        retryJob,
        snapshot.net_cents,
        snapshot.tax_cents,
        snapshot.total_cents,
        JSON.stringify(snapshot),
        canonical,
        createHash("sha256").update(canonical).digest("hex"),
      ],
    );
    const line = snapshot.lines[0];
    if (!line) {
      throw new Error("expected F01 line");
    }
    await running().admin.query(
      `insert into commercial.document_lines (
        workspace_id, id, document_id, position, line_kind, description, quantity, unit,
        unit_price_cents, discount_cents, net_cents, tax_bp, tax_cents, total_cents
      ) values ($1, $2, $3, 1, 'source', 'Labour hour', 2.5, 'hour', 10000, 1000, $4, 825, $5, $6)`,
      [WS, retryLine, retryDoc, line.net_cents, line.tax_cents, line.total_cents],
    );
    await insertTask(retryTask, retryEvent, retryDoc, { document_id: retryDoc, kind: "quote" });
    const keys: string[] = [];
    const stages: string[] = [];
    let shouldFail = true;
    const store = {
      putObject: async ({ key }: { key: string }) => {
        keys.push(key);
        if (shouldFail) {
          throw new Error("R2 unavailable");
        }
      },
    };
    const render = async () => Buffer.from("%PDF-1.4 retry");
    expect(
      await processGenerateOriginalPdf({
        pool: running().pool,
        store,
        render,
        onStage: (stage) => stages.push(stage),
      }),
    ).toBe("retry");
    expect(stages).toEqual(["claim_started", "claimed", "rendering", "uploading", "retry_scheduled"]);
    const reserved = await running().admin.query<{ payload_json: { artifact_id: string }; status: string }>(
      "select payload_json, attempts, status from commercial.outbox_tasks where id = $1",
      [retryTask],
    );
    expect(reserved.rows[0]?.status).toBe("pending");
    expect(reserved.rows[0]?.payload_json.artifact_id).toBeTruthy();
    await rewind(retryTask);
    shouldFail = false;
    expect(await processGenerateOriginalPdf({ pool: running().pool, store, render })).toBe("done");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("fails permanent validation immediately and dead-letters the fifth transient failure", async () => {
    await insertTask(EMPTY_TASK, EMPTY_EVENT, EMPTY_DOC, { document_id: EMPTY_DOC, kind: "quote" });
    const store = { putObject: async () => undefined };
    const stages: string[] = [];
    expect(
      await processGenerateOriginalPdf({
        pool: running().pool,
        store,
        render: async () => Buffer.from("%PDF-1.4 unused"),
        onStage: (stage) => stages.push(stage),
      }),
    ).toBe("dead");
    expect(stages).toEqual(["claim_started", "claimed", "dead"]);
    const empty = await running().admin.query("select status, attempts from commercial.outbox_tasks where id = $1", [
      EMPTY_TASK,
    ]);
    expect(empty.rows[0]).toMatchObject({ status: "dead", attempts: 1 });

    const failDoc = "eeee7777-eeee-4777-8777-eeeeeeeeeeee";
    const failTask = "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbbb4";
    const failEvent = "cccc1111-cccc-4111-8ccc-ccccccccccc4";
    const failLine = "eeee8888-eeee-4888-8888-eeeeeeeeeeee";
    const failJob = "eeee5555-eeee-4555-8555-eeeeeeeeeeee";
    const snapshot = f01Snapshot();
    const canonical = Buffer.from(JSON.stringify(snapshot));
    await running().admin.query(
      `insert into commercial.jobs (workspace_id, id, customer_id, title, no_site, lifecycle, mode)
       values ($1, $2, $3, 'Fail', true, 'draft', 'quote')`,
      [WS, failJob, CUSTOMER],
    );
    await running().admin.query(
      `insert into commercial.documents (
        workspace_id, id, created_by, job_id, kind, number, revision_no, lifecycle,
        issued_at, issue_date, currency, net_cents, tax_cents, total_cents,
        snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256
      ) values ($1, $2, $3, $4, 'quote', 'Q-000004', 1, 'issued', now(), date '2026-09-15', 'USD', $5, $6, $7, $8::jsonb, $9, 1, $10)`,
      [
        WS,
        failDoc,
        USER,
        failJob,
        snapshot.net_cents,
        snapshot.tax_cents,
        snapshot.total_cents,
        JSON.stringify(snapshot),
        canonical,
        createHash("sha256").update(canonical).digest("hex"),
      ],
    );
    const line = snapshot.lines[0];
    if (!line) {
      throw new Error("expected F01 line");
    }
    await running().admin.query(
      `insert into commercial.document_lines (
        workspace_id, id, document_id, position, line_kind, description, quantity, unit,
        unit_price_cents, discount_cents, net_cents, tax_bp, tax_cents, total_cents
      ) values ($1, $2, $3, 1, 'source', 'Labour hour', 2.5, 'hour', 10000, 1000, $4, 825, $5, $6)`,
      [WS, failLine, failDoc, line.net_cents, line.tax_cents, line.total_cents],
    );
    await insertTask(failTask, failEvent, failDoc, { document_id: failDoc, kind: "quote" });
    const exploding = {
      putObject: async () => {
        throw new Error("R2 unavailable");
      },
    };
    const render = async () => Buffer.from("%PDF-1.4 boom");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await processGenerateOriginalPdf({ pool: running().pool, store: exploding, render })).toBe("retry");
      await rewind(failTask);
    }
    expect(await processGenerateOriginalPdf({ pool: running().pool, store: exploding, render })).toBe("dead");
    const dead = await running().admin.query("select status, attempts from commercial.outbox_tasks where id = $1", [
      failTask,
    ]);
    expect(dead.rows[0]).toMatchObject({ status: "dead", attempts: 5 });
    const artifacts = await running().admin.query("select id from commercial.artifacts where document_id = $1", [
      failDoc,
    ]);
    expect(artifacts.rows).toHaveLength(0);
  });
});
