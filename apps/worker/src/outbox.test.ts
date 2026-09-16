import { buildQuoteSnapshot, originalPdfObjectKey } from "@job-to-invoice/domain";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  encryptDeliveryToken,
  generateApprovalToken,
  hashApprovalToken,
  parseVersionedSecret,
} from "@job-to-invoice/config";
import { processSendEmail } from "./email.ts";
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

  async function seedQuoteTask(ids: { job: string; doc: string; line: string; task: string; event: string; number: string }) {
    const snapshot = f01Snapshot();
    const canonical = Buffer.from(JSON.stringify(snapshot));
    await running().admin.query(
      `insert into commercial.jobs (workspace_id, id, customer_id, title, no_site, lifecycle, mode)
       values ($1, $2, $3, 'Slow PDF', true, 'draft', 'quote')`,
      [WS, ids.job, CUSTOMER],
    );
    await running().admin.query(
      `insert into commercial.documents (
        workspace_id, id, created_by, job_id, kind, number, revision_no, lifecycle,
        issued_at, issue_date, currency, net_cents, tax_cents, total_cents,
        snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256
      ) values ($1, $2, $3, $4, 'quote', $5, 1, 'issued', now(), date '2026-09-15', 'USD', $6, $7, $8, $9::jsonb, $10, 1, $11)`,
      [
        WS,
        ids.doc,
        USER,
        ids.job,
        ids.number,
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
      [WS, ids.line, ids.doc, line.net_cents, line.tax_cents, line.total_cents],
    );
    await insertTask(ids.task, ids.event, ids.doc, { document_id: ids.doc, kind: "quote" });
  }

  function countingPool(pool: Pool) {
    const heartbeats = { count: 0 };
    const wrapped = {
      connect: async () => {
        const client = await pool.connect();
        const query = client.query.bind(client) as (sql: string, values?: unknown[]) => ReturnType<typeof client.query>;
        client.query = ((sql: string, values?: unknown[]) => {
          if (sql.includes("heartbeat_outbox_task")) {
            heartbeats.count += 1;
          }
          return query(sql, values);
        }) as typeof client.query;
        return client;
      },
    } as Pool;
    return { pool: wrapped, heartbeats };
  }

  it("keeps one serialized render that exceeds 8 seconds with heartbeat and no claim timeout", async () => {
    const ids = {
      job: "ffff5555-ffff-4555-8555-ffffffffffff",
      doc: "ffff7777-ffff-4777-8777-ffffffffffff",
      line: "ffff8888-ffff-4888-8888-ffffffffffff",
      task: "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbb10",
      event: "cccc1111-cccc-4111-8ccc-cccccccccc10",
      number: "Q-000010",
    };
    await seedQuoteTask(ids);
    const keys: string[] = [];
    const stages: string[] = [];
    let sawRendering!: () => void;
    const rendering = new Promise<void>((resolve) => {
      sawRendering = resolve;
    });
    const counted = countingPool(running().pool);
    const store = {
      putObject: async ({ key }: { key: string }) => {
        keys.push(key);
      },
    };
    const first = processGenerateOriginalPdf({
      pool: counted.pool,
      store,
      render: async () => {
        await new Promise((resolve) => setTimeout(resolve, 8_500));
        return Buffer.from("%PDF-1.4 slow-render");
      },
      onStage: (stage) => {
        stages.push(stage);
        if (stage === "rendering") {
          sawRendering();
        }
      },
      heartbeatMs: 1_000,
    });
    await rendering;
    const second = processGenerateOriginalPdf({
      pool: counted.pool,
      store,
      render: async () => Buffer.from("%PDF-1.4 overlap"),
    });
    const [left, right] = await Promise.all([first, second]);
    expect([left, right].sort()).toEqual(["done", "idle"]);
    expect(keys).toHaveLength(1);
    expect(stages).toEqual(["claim_started", "claimed", "rendering", "uploading", "completed"]);
    expect(stages).not.toContain("claim_timed_out");
    expect(counted.heartbeats.count).toBeGreaterThanOrEqual(2);
    const done = await running().admin.query("select status from commercial.outbox_tasks where id = $1", [ids.task]);
    expect(done.rows[0]?.status).toBe("done");
  });

  it("keeps one serialized upload that exceeds 8 seconds with heartbeat and no claim timeout", async () => {
    const ids = {
      job: "aaaa5555-aaaa-4555-8555-aaaaaaaaaa10",
      doc: "aaaa7777-aaaa-4777-8777-aaaaaaaaaa10",
      line: "aaaa8888-aaaa-4888-8888-aaaaaaaaaa10",
      task: "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbb11",
      event: "cccc1111-cccc-4111-8ccc-cccccccccc11",
      number: "Q-000011",
    };
    await seedQuoteTask(ids);
    const keys: string[] = [];
    const stages: string[] = [];
    let sawUploading!: () => void;
    const uploading = new Promise<void>((resolve) => {
      sawUploading = resolve;
    });
    const counted = countingPool(running().pool);
    const store = {
      putObject: async ({ key }: { key: string }) => {
        keys.push(key);
        await new Promise((resolve) => setTimeout(resolve, 8_500));
      },
    };
    const first = processGenerateOriginalPdf({
      pool: counted.pool,
      store,
      render: async () => Buffer.from("%PDF-1.4 slow-upload"),
      onStage: (stage) => {
        stages.push(stage);
        if (stage === "uploading") {
          sawUploading();
        }
      },
      heartbeatMs: 1_000,
    });
    await uploading;
    const second = processGenerateOriginalPdf({
      pool: counted.pool,
      store,
      render: async () => Buffer.from("%PDF-1.4 overlap-upload"),
    });
    const [left, right] = await Promise.all([first, second]);
    expect([left, right].sort()).toEqual(["done", "idle"]);
    expect(keys).toHaveLength(1);
    expect(stages).toEqual(["claim_started", "claimed", "rendering", "uploading", "completed"]);
    expect(stages).not.toContain("claim_timed_out");
    expect(counted.heartbeats.count).toBeGreaterThanOrEqual(2);
    const done = await running().admin.query("select status from commercial.outbox_tasks where id = $1", [ids.task]);
    expect(done.rows[0]?.status).toBe("done");
  });

  const DELIVERY_KEY = "delivery-key-material-ok";

  async function insertEmail01(ids: {
    job: string;
    doc: string;
    request: string;
    attempt: string;
    payload: string;
    task: string;
    event: string;
  }) {
    const secret = parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", DELIVERY_KEY);
    const token = generateApprovalToken();
    const hashed = hashApprovalToken(token, secret);
    const encrypted = encryptDeliveryToken(token, secret);
    const effect = `${WS}:${ids.doc}:EMAIL01:${ids.request}`;
    await running().admin.query(
      `insert into commercial.approval_requests (
        workspace_id, id, job_id, document_id, purpose, recipient_email, token_hash,
        token_key_version, state, expected_scope_version, expires_at, access_until
      ) values ($1, $2, $3, $4, 'approval', 'customer@example.com', $5, $6, 'pending', 0, now() + interval '14 days', now() + interval '90 days')`,
      [WS, ids.request, ids.job, ids.doc, hashed.hash, hashed.keyVersion],
    );
    await running().admin.query(
      `insert into commercial.delivery_attempts (
        workspace_id, id, document_id, request_id, template_id, recipient_email_encrypted, state, effect_key
      ) values ($1, $2, $3, $4, 'EMAIL01', $5, 'queued', $6)`,
      [WS, ids.attempt, ids.doc, ids.request, Buffer.alloc(32, 7), effect],
    );
    await running().admin.query(
      `insert into commercial.encrypted_delivery_payloads (
        workspace_id, id, delivery_attempt_id, algorithm, key_version, nonce, ciphertext
      ) values ($1, $2, $3, 'aes-256-gcm', $4, $5, $6)`,
      [WS, ids.payload, ids.attempt, encrypted.keyVersion, encrypted.nonce, encrypted.ciphertext],
    );
    await running().admin.query(
      `insert into commercial.outbox_tasks (
        workspace_id, id, event_id, task_type, aggregate_id, payload_json, status, effect_key
      ) values ($1, $2, $3, 'send_email', $4, $5::jsonb, 'pending', $6)`,
      [
        WS,
        ids.task,
        ids.event,
        ids.request,
        JSON.stringify({ document_id: ids.doc, request_id: ids.request, template_id: "EMAIL01" }),
        effect,
      ],
    );
    token.fill(0);
    return effect;
  }

  it("does not claim EMAIL01 until the original PDF is ready and fails without send when PDF is dead", async () => {
    const ids = {
      job: "aaaae055-aaaa-4555-8555-aaaaaaaaaaaa",
      doc: "aaaae077-aaaa-4777-8777-aaaaaaaaaaaa",
      line: "aaaae088-aaaa-4888-8888-aaaaaaaaaaaa",
      task: "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbb20",
      event: "cccc1111-cccc-4111-8ccc-cccccccccc20",
      number: "Q-000020",
      request: "aaaae012-aaaa-4999-8999-aaaaaaaaaaaa",
      attempt: "aaaae013-aaaa-4999-8999-aaaaaaaaaaaa",
      payload: "aaaae014-aaaa-4999-8999-aaaaaaaaaaaa",
      emailTask: "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbb21",
      emailEvent: "cccc1111-cccc-4111-8ccc-cccccccccc21",
    };
    await seedQuoteTask(ids);
    await insertEmail01({
      job: ids.job,
      doc: ids.doc,
      request: ids.request,
      attempt: ids.attempt,
      payload: ids.payload,
      task: ids.emailTask,
      event: ids.emailEvent,
    });
    const send = vi.fn(async () => ({ ok: true as const, id: "msg_should_not_send" }));
    expect(
      await processSendEmail({
        pool: running().pool,
        deliverySecret: DELIVERY_KEY,
        apiKey: "email-key-material-ok",
        fromDomain: "mail.test",
        portalOrigin: "https://portal.example.test",
        appName: "Job to Invoice",
        send,
      }),
    ).toBe("idle");
    expect(send).not.toHaveBeenCalled();
    await running().admin.query("update commercial.outbox_tasks set status = 'dead' where id = $1", [ids.task]);
    expect(
      await processSendEmail({
        pool: running().pool,
        deliverySecret: DELIVERY_KEY,
        apiKey: "email-key-material-ok",
        fromDomain: "mail.test",
        portalOrigin: "https://portal.example.test",
        appName: "Job to Invoice",
        send,
      }),
    ).toBe("dead");
    expect(send).not.toHaveBeenCalled();
    const delivery = await running().admin.query("select state from commercial.delivery_attempts where id = $1", [
      ids.attempt,
    ]);
    expect(delivery.rows[0]?.state).toBe("failed");
  });

  it("sends EMAIL01 after PDF ready with fragment href, persists provider id, retries 429, and reuses the effect", async () => {
    const ids = {
      job: "aaaae155-aaaa-4555-8555-aaaaaaaaaaaa",
      doc: "aaaae177-aaaa-4777-8777-aaaaaaaaaaaa",
      line: "aaaae188-aaaa-4888-8888-aaaaaaaaaaaa",
      task: "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbb30",
      event: "cccc1111-cccc-4111-8ccc-cccccccccc30",
      number: "Q-000030",
      request: "aaaae112-aaaa-4999-8999-aaaaaaaaaaaa",
      attempt: "aaaae113-aaaa-4999-8999-aaaaaaaaaaaa",
      payload: "aaaae114-aaaa-4999-8999-aaaaaaaaaaaa",
      emailTask: "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbb31",
      emailEvent: "cccc1111-cccc-4111-8ccc-cccccccccc31",
    };
    await seedQuoteTask(ids);
    const effect = await insertEmail01({
      job: ids.job,
      doc: ids.doc,
      request: ids.request,
      attempt: ids.attempt,
      payload: ids.payload,
      task: ids.emailTask,
      event: ids.emailEvent,
    });
    expect(
      await processGenerateOriginalPdf({
        pool: running().pool,
        store: { putObject: async () => undefined },
        render: async () => Buffer.from("%PDF-1.4 email"),
      }),
    ).toBe("done");
    const calls: string[] = [];
    expect(
      await processSendEmail({
        pool: running().pool,
        deliverySecret: DELIVERY_KEY,
        apiKey: "email-key-material-ok",
        fromDomain: "mail.test",
        portalOrigin: "https://portal.example.test",
        appName: "Job to Invoice",
        send: async (input) => {
          calls.push(input.idempotencyKey);
          expect(input.html).toContain("https://portal.example.test/review#");
          expect(input.html).not.toContain("?token=");
          expect(input.html.toLowerCase()).not.toContain("attachment");
          expect(input.idempotencyKey).toBe(effect);
          return { ok: false, retryable: true, status: 429 };
        },
      }),
    ).toBe("retry");
    const before = await running().admin.query(
      "select ciphertext from commercial.encrypted_delivery_payloads where id = $1",
      [ids.payload],
    );
    await rewind(ids.emailTask);
    expect(
      await processSendEmail({
        pool: running().pool,
        deliverySecret: DELIVERY_KEY,
        apiKey: "email-key-material-ok",
        fromDomain: "mail.test",
        portalOrigin: "https://portal.example.test",
        appName: "Job to Invoice",
        send: async (input) => {
          calls.push(input.idempotencyKey);
          return { ok: true, id: "msg_email_1" };
        },
      }),
    ).toBe("done");
    const after = await running().admin.query(
      "select ciphertext from commercial.encrypted_delivery_payloads where id = $1",
      [ids.payload],
    );
    expect(after.rows[0]?.ciphertext).toEqual(before.rows[0]?.ciphertext);
    expect(calls).toEqual([effect, effect]);
    const delivery = await running().admin.query(
      "select state, provider_message_id from commercial.delivery_attempts where id = $1",
      [ids.attempt],
    );
    expect(delivery.rows[0]).toMatchObject({ state: "accepted_by_provider", provider_message_id: "msg_email_1" });
    expect(delivery.rows[0]?.state).not.toBe("delivered");
    await running().admin.query(
      "update commercial.outbox_tasks set status = 'pending', available_at = now() - interval '1 second', lease_until = null where id = $1",
      [ids.emailTask],
    );
    const replaySend = vi.fn(async () => ({ ok: true as const, id: "msg_should_not_resend" }));
    expect(
      await processSendEmail({
        pool: running().pool,
        deliverySecret: DELIVERY_KEY,
        apiKey: "email-key-material-ok",
        fromDomain: "mail.test",
        portalOrigin: "https://portal.example.test",
        appName: "Job to Invoice",
        send: replaySend,
      }),
    ).toBe("done");
    expect(replaySend).not.toHaveBeenCalled();
    expect(
      await processSendEmail({
        pool: running().pool,
        deliverySecret: DELIVERY_KEY,
        apiKey: "email-key-material-ok",
        fromDomain: "mail.test",
        portalOrigin: "https://portal.example.test",
        appName: "Job to Invoice",
        send: async () => ({ ok: false, retryable: false, status: 422 }),
      }),
    ).toBe("idle");
  });

  it("does not overlap EMAIL01 processing", async () => {
    const ids = {
      job: "aaaae255-aaaa-4555-8555-aaaaaaaaaaaa",
      doc: "aaaae277-aaaa-4777-8777-aaaaaaaaaaaa",
      line: "aaaae288-aaaa-4888-8888-aaaaaaaaaaaa",
      task: "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbb40",
      event: "cccc1111-cccc-4111-8ccc-cccccccccc40",
      number: "Q-000040",
      request: "aaaae212-aaaa-4999-8999-aaaaaaaaaaaa",
      attempt: "aaaae213-aaaa-4999-8999-aaaaaaaaaaaa",
      payload: "aaaae214-aaaa-4999-8999-aaaaaaaaaaaa",
      emailTask: "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbb41",
      emailEvent: "cccc1111-cccc-4111-8ccc-cccccccccc41",
    };
    await seedQuoteTask(ids);
    await insertEmail01({
      job: ids.job,
      doc: ids.doc,
      request: ids.request,
      attempt: ids.attempt,
      payload: ids.payload,
      task: ids.emailTask,
      event: ids.emailEvent,
    });
    expect(
      await processGenerateOriginalPdf({
        pool: running().pool,
        store: { putObject: async () => undefined },
        render: async () => Buffer.from("%PDF-1.4 overlap-email"),
      }),
    ).toBe("done");
    let releases!: () => void;
    const held = new Promise<void>((resolve) => {
      releases = resolve;
    });
    const first = processSendEmail({
      pool: running().pool,
      deliverySecret: DELIVERY_KEY,
      apiKey: "email-key-material-ok",
      fromDomain: "mail.test",
      portalOrigin: "https://portal.example.test",
      appName: "Job to Invoice",
      send: async () => {
        await held;
        return { ok: true, id: "msg_overlap" };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = processSendEmail({
      pool: running().pool,
      deliverySecret: DELIVERY_KEY,
      apiKey: "email-key-material-ok",
      fromDomain: "mail.test",
      portalOrigin: "https://portal.example.test",
      appName: "Job to Invoice",
      send: async () => ({ ok: true, id: "msg_overlap_other" }),
    });
    releases();
    const [left, right] = await Promise.all([first, second]);
    expect([left, right].sort()).toEqual(["done", "idle"]);
  });

  it("marks EMAIL01 dead on a permanent provider 4xx", async () => {
    const ids = {
      job: "aaaae355-aaaa-4555-8555-aaaaaaaaaaaa",
      doc: "aaaae377-aaaa-4777-8777-aaaaaaaaaaaa",
      line: "aaaae388-aaaa-4888-8888-aaaaaaaaaaaa",
      task: "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbb50",
      event: "cccc1111-cccc-4111-8ccc-cccccccccc50",
      number: "Q-000050",
      request: "aaaae312-aaaa-4999-8999-aaaaaaaaaaaa",
      attempt: "aaaae313-aaaa-4999-8999-aaaaaaaaaaaa",
      payload: "aaaae314-aaaa-4999-8999-aaaaaaaaaaaa",
      emailTask: "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbb51",
      emailEvent: "cccc1111-cccc-4111-8ccc-cccccccccc51",
    };
    await seedQuoteTask(ids);
    await insertEmail01({
      job: ids.job,
      doc: ids.doc,
      request: ids.request,
      attempt: ids.attempt,
      payload: ids.payload,
      task: ids.emailTask,
      event: ids.emailEvent,
    });
    expect(
      await processGenerateOriginalPdf({
        pool: running().pool,
        store: { putObject: async () => undefined },
        render: async () => Buffer.from("%PDF-1.4 reject"),
      }),
    ).toBe("done");
    expect(
      await processSendEmail({
        pool: running().pool,
        deliverySecret: DELIVERY_KEY,
        apiKey: "email-key-material-ok",
        fromDomain: "mail.test",
        portalOrigin: "https://portal.example.test",
        appName: "Job to Invoice",
        send: async () => ({ ok: false, retryable: false, status: 422 }),
      }),
    ).toBe("dead");
    const delivery = await running().admin.query("select state from commercial.delivery_attempts where id = $1", [
      ids.attempt,
    ]);
    expect(delivery.rows[0]?.state).toBe("failed");
  });
});
