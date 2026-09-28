// Isolated end-to-end PDF verification against a throwaway embedded Postgres
// and the local development object store. Never touches the hosted database:
// DATABASE_URL_MIGRATIONS is ignored so the embedded cluster is always used.
// The only storage object written lives under a random fixture workspace
// prefix and is deleted at the end. Output contains no secrets or keys.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type Pool } from "pg";
import {
  alignDevelopmentStorageEnv,
  loadApiEnv,
  loadWorkerEnv,
  type ApiDocumentsStorageConfig,
} from "@job-to-invoice/config";
import { buildQuoteSnapshot, type ChangeSnapshotV1 } from "@job-to-invoice/domain";
import { createDocumentsObjectStore } from "./documents-store.ts";
import { createWorkerPool, WorkerTransactionError } from "./db.ts";
import { processGenerateOriginalPdf } from "./outbox.ts";
import { renderQuoteOriginalPdf } from "./pdf.ts";

delete process.env.DATABASE_URL_MIGRATIONS;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const importFrom = (relative: string) => import(new URL(relative, import.meta.url).href);

const { resolveMigrationsUrl } = (await importFrom("../../../scripts/postgres-url.mjs")) as {
  resolveMigrationsUrl: () => Promise<{ url: string; stop: () => Promise<void> }>;
};
const { applyCleanMigrations } = (await importFrom("../../../scripts/db-admin.mjs")) as {
  applyCleanMigrations: (client: Client, root: string) => Promise<void>;
};
const { createDocumentsDownloadStore } = (await importFrom("../../api/src/documents-store.ts")) as {
  createDocumentsDownloadStore: (config: ApiDocumentsStorageConfig) => { presignGet: (key: string) => Promise<string> };
};
const { currentLanIPv4, windowsDefaultRouteAliases } = (await importFrom("../../portal/src/dev-origin.ts")) as {
  currentLanIPv4: (aliases: readonly string[]) => string | undefined;
  windowsDefaultRouteAliases: () => string[];
};

const report: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail?: unknown) => {
  report[name] = detail === undefined ? ok : { ok, detail };
  if (!ok) {
    process.exitCode = 1;
  }
};

const localAddresses = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .filter((entry) => entry.family === "IPv4")
  .map((entry) => entry.address);
report.storageAlignment = alignDevelopmentStorageEnv(process.env, {
  localAddresses,
  lanHost: currentLanIPv4(windowsDefaultRouteAliases()),
});
const workerStorage = loadWorkerEnv().documentsStorage;
const apiStorage = loadApiEnv().documentsStorage;
if (!workerStorage || !apiStorage) {
  throw new Error("development storage configuration is required");
}

const ids = {
  user: randomUUID(),
  auth: randomUUID(),
  ws: randomUUID(),
  membership: randomUUID(),
  customer: randomUUID(),
  job: randomUUID(),
  doc: randomUUID(),
  line: randomUUID(),
  task: randomUUID(),
  event: randomUUID(),
  changeDoc: randomUUID(),
  changeTask: randomUUID(),
  changeEvent: randomUUID(),
};

const snapshot = buildQuoteSnapshot({
  business: {
    business_name: "Fixture Co",
    legal_name: "Fixture Co LLC",
    contact_name: "Fixture Owner",
    contact_email: "owner@example.test",
    contact_phone: "+12025550123",
    address: { line1: "1 Test Way", line2: null, city: "Austin", state: "TX", postal_code: "78701" },
    timezone: "America/Chicago",
    default_tax_bp: 0,
  },
  customer: { name: "Fixture Customer", email: null, phone: null, billing_address: null },
  job: { id: ids.job, title: "Fixture job", site_address: null, no_site: true },
  notes: "Isolated storage verification.",
  terms: "Net 14.",
  expiry_days: 14,
  expiry_local_date: "2026-10-12",
  expiry_timezone: "America/Chicago",
  expires_at: "2026-10-13T04:59:59.000Z",
  issue_date: "2026-09-28",
  lines: [
    {
      client_line_id: ids.line,
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

const changeSnapshot: ChangeSnapshotV1 = {
  schema_version: 1,
  kind: "change",
  currency: "USD",
  business: snapshot.business,
  customer: snapshot.customer,
  job: snapshot.job,
  reason: "Isolated change-order storage verification.",
  notes: "",
  terms: "Net 14.",
  expiry_days: 14,
  expiry_local_date: "2026-10-12",
  expiry_timezone: "America/Chicago",
  expires_at: "2026-10-13T04:59:59.000Z",
  issue_date: "2026-09-28",
  expected_scope_version: 1,
  previous_net_cents: snapshot.net_cents,
  previous_tax_cents: snapshot.tax_cents,
  previous_total_cents: snapshot.total_cents,
  addition_net_cents: 10000,
  addition_tax_cents: 825,
  addition_total_cents: 10825,
  reduction_net_cents: 0,
  reduction_tax_cents: 0,
  reduction_total_cents: 0,
  change_including_tax_cents: 10825,
  new_agreed_total_cents: snapshot.total_cents + 10825,
  additions: [
    {
      position: 1,
      client_line_id: randomUUID(),
      description: "Second handle",
      unit: "item",
      custom_unit_label: null,
      quantity: "1.000",
      unit_price_cents: 10000,
      discount_cents: 0,
      tax_bp: 825,
      gross_cents: 10000,
      net_cents: 10000,
      tax_cents: 825,
      total_cents: 10825,
    },
  ],
  reductions: [],
  net_cents: snapshot.net_cents + 10000,
  tax_cents: snapshot.tax_cents + 825,
  total_cents: snapshot.total_cents + 10825,
};

async function closedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function stageOf(work: Promise<unknown>): Promise<string> {
  try {
    return String(await work);
  } catch (error) {
    return error instanceof WorkerTransactionError ? error.stage : "unexpected_error";
  }
}

const database = await resolveMigrationsUrl();
const admin = new Client({ connectionString: database.url });
let pool: Pool | undefined;
let storedKey: string | undefined;
let changeKey: string | undefined;
const store = createDocumentsObjectStore(workerStorage);
try {
  await admin.connect();
  await applyCleanMigrations(admin, repoRoot);
  await admin.query("grant api_app, worker_app to current_user");
  const canonical = Buffer.from(JSON.stringify(snapshot));
  await admin.query(
    `insert into identity.app_users (id, auth_user_id, normalized_email, display_email, status,
       last_authenticated_at, terms_version, privacy_version)
     values ($1, $2, 'owner@example.test', 'owner@example.test', 'active', now(), '1', '1')`,
    [ids.user, ids.auth],
  );
  await admin.query(
    `insert into commercial.workspaces (workspace_id, id, owner_user_id, business_name, legal_name, contact_name,
       contact_email, timezone, trade, default_terms)
     values ($1, $1, $2, 'Fixture Co', 'Fixture Co LLC', 'Fixture Owner', 'owner@example.test', 'America/Chicago', 'handyman', 'Net 14')`,
    [ids.ws, ids.user],
  );
  await admin.query(
    `insert into commercial.memberships (workspace_id, id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')`,
    [ids.ws, ids.membership, ids.user],
  );
  await admin.query(`insert into commercial.customers (workspace_id, id, name) values ($1, $2, 'Fixture Customer')`, [
    ids.ws,
    ids.customer,
  ]);
  await admin.query(
    `insert into commercial.jobs (workspace_id, id, customer_id, title, no_site, lifecycle, mode)
     values ($1, $2, $3, 'Fixture job', true, 'draft', 'quote')`,
    [ids.ws, ids.job, ids.customer],
  );
  await admin.query(
    `insert into commercial.documents (workspace_id, id, created_by, job_id, kind, number, revision_no, lifecycle,
       issued_at, issue_date, currency, net_cents, tax_cents, total_cents,
       snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256)
     values ($1, $2, $3, $4, 'quote', 'Q-900001', 1, 'issued', now(), date '2026-09-28', 'USD', $5, $6, $7, $8::jsonb, $9, 1, $10)`,
    [
      ids.ws,
      ids.doc,
      ids.user,
      ids.job,
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
    throw new Error("fixture line missing");
  }
  await admin.query(
    `insert into commercial.document_lines (workspace_id, id, document_id, position, line_kind, description, quantity, unit,
       unit_price_cents, discount_cents, net_cents, tax_bp, tax_cents, total_cents)
     values ($1, $2, $3, 1, 'source', 'Labour hour', 2.5, 'hour', 10000, 1000, $4, 825, $5, $6)`,
    [ids.ws, ids.line, ids.doc, line.net_cents, line.tax_cents, line.total_cents],
  );
  await admin.query(
    `insert into commercial.outbox_tasks (workspace_id, id, event_id, task_type, aggregate_id, payload_json, status, effect_key)
     values ($1, $2, $3, 'generate_original_pdf', $4, $5::jsonb, 'pending', $6)`,
    [ids.ws, ids.task, ids.event, ids.doc, JSON.stringify({ document_id: ids.doc, kind: "quote" }), `${ids.ws}:${ids.doc}:original_pdf`],
  );
  const taskState = async () =>
    (
      await admin.query<{ status: string; attempts: number; last_error_code: string | null }>(
        "select status, attempts, last_error_code from commercial.outbox_tasks where id = $1",
        [ids.task],
      )
    ).rows[0];
  const rewind = () =>
    admin.query("update commercial.outbox_tasks set available_at = now() - interval '1 second' where id = $1", [ids.task]);

  pool = createWorkerPool(database.url);
  const workerPool = pool;
  const run = (overrides?: { pool?: Pool; store?: typeof store }) =>
    processGenerateOriginalPdf({
      pool: overrides?.pool ?? workerPool,
      store: overrides?.store ?? store,
      render: renderQuoteOriginalPdf,
    });

  // Database lock: the claim blocks on an exclusive table lock until the budget fires.
  await admin.query("begin");
  await admin.query("lock table commercial.outbox_tasks in access exclusive mode");
  const locked = await stageOf(run());
  await admin.query("rollback");
  check("lockTimeout_reportsClaimTimedOut", locked === "claim_timed_out", locked);
  check("lockTimeout_doesNotConsumeAttempt", (await taskState())?.attempts === 0);

  // Slow connection acquisition: the connection arrives after the budget and is kept.
  const before = workerPool.totalCount;
  let delayed = false;
  const slowPool = Object.create(workerPool) as Pool;
  slowPool.connect = (async () => {
    if (!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 9_000));
    }
    return workerPool.connect();
  }) as unknown as Pool["connect"];
  const slow = await stageOf(run({ pool: slowPool }));
  await new Promise((resolve) => setTimeout(resolve, 9_500));
  check("slowConnect_reportsConnectTimedOut", slow === "connect_timed_out", slow);
  check("slowConnect_connectionKept", workerPool.totalCount >= Math.max(before, 1) && workerPool.idleCount >= 1);
  check("slowConnect_doesNotConsumeAttempt", (await taskState())?.attempts === 0);

  // Storage outage: a refused connection on loopback, then recovery with the real store.
  const refused = createDocumentsObjectStore({
    ...workerStorage,
    endpoint: `http://127.0.0.1:${await closedLoopbackPort()}`,
  });
  const outageStarted = Date.now();
  const outage = await stageOf(run({ store: refused }));
  const afterOutage = await taskState();
  check("storageOutage_scheduledRetry", outage === "retry", outage);
  check("storageOutage_failsFast", Date.now() - outageStarted < 30_000, Date.now() - outageStarted);
  check("storageOutage_errorCode", afterOutage?.last_error_code === "STORAGE_UNAVAILABLE", afterOutage?.last_error_code);
  const noArtifact = await admin.query("select 1 from commercial.artifacts where document_id = $1", [ids.doc]);
  check("storageOutage_noArtifact", noArtifact.rowCount === 0);

  await rewind();
  const recovered = await stageOf(run());
  check("recovery_done", recovered === "done", recovered);
  const artifacts = await admin.query<{ object_key: string; sha256: string; bytes: string; state: string }>(
    "select object_key, sha256, bytes::text, state from commercial.artifacts where document_id = $1 and type = 'original_pdf'",
    [ids.doc],
  );
  const artifact = artifacts.rows[0];
  storedKey = artifact?.object_key;
  check("recovery_oneReadyArtifact", artifacts.rowCount === 1 && artifact?.state === "ready");
  check("recovery_taskDone", (await taskState())?.status === "done");
  check("duplicateRun_idle", (await stageOf(run())) === "idle");
  const stillOne = await admin.query("select 1 from commercial.artifacts where document_id = $1", [ids.doc]);
  check("duplicateRun_stillOneArtifact", stillOne.rowCount === 1);

  if (artifact) {
    const url = await createDocumentsDownloadStore(apiStorage).presignGet(artifact.object_key);
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = Buffer.from(await response.arrayBuffer());
    const sha = createHash("sha256").update(body).digest("hex");
    check("download_presignedOk", response.status === 200, response.status);
    check("download_isPdf", body.subarray(0, 5).toString("latin1") === "%PDF-" && response.headers.get("content-type") === "application/pdf");
    check("download_matchesRecordedChecksum", sha === artifact.sha256 && String(body.byteLength) === artifact.bytes);
    check("download_hostIsCurrentLan", new URL(url).hostname !== "127.0.0.1" || !report.storageAlignment, new URL(url).host);
    const anonymous = await fetch(`${workerStorage.endpoint.replace(/\/$/, "")}/${workerStorage.bucket}/${artifact.object_key}`, {
      signal: AbortSignal.timeout(10_000),
    });
    check("private_anonymousDenied", anonymous.status === 403, anonymous.status);
  }

  const changeCanonical = Buffer.from(JSON.stringify(changeSnapshot));
  await admin.query(
    `insert into commercial.documents (workspace_id, id, created_by, job_id, kind, number, revision_no, lifecycle,
       issued_at, issue_date, currency, net_cents, tax_cents, total_cents,
       snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256)
     values ($1, $2, $3, $4, 'change', 'CO-900001', 1, 'issued', now(), date '2026-09-28', 'USD', $5, $6, $7, $8::jsonb, $9, 1, $10)`,
    [
      ids.ws,
      ids.changeDoc,
      ids.user,
      ids.job,
      changeSnapshot.net_cents,
      changeSnapshot.tax_cents,
      changeSnapshot.total_cents,
      JSON.stringify(changeSnapshot),
      changeCanonical,
      createHash("sha256").update(changeCanonical).digest("hex"),
    ],
  );
  await admin.query(
    `insert into commercial.outbox_tasks (workspace_id, id, event_id, task_type, aggregate_id, payload_json, status, effect_key)
     values ($1, $2, $3, 'generate_original_pdf', $4, $5::jsonb, 'pending', $6)`,
    [
      ids.ws,
      ids.changeTask,
      ids.changeEvent,
      ids.changeDoc,
      JSON.stringify({ document_id: ids.changeDoc, kind: "change" }),
      `${ids.ws}:${ids.changeDoc}:original_pdf`,
    ],
  );
  const changeRun = await stageOf(run());
  check("change_done", changeRun === "done", changeRun);
  const changeArtifacts = await admin.query<{ object_key: string; sha256: string; bytes: string; state: string; template_version: string }>(
    `select object_key, sha256, bytes::text, state, template_version
     from commercial.artifacts where document_id = $1 and type = 'original_pdf'`,
    [ids.changeDoc],
  );
  const changeArtifact = changeArtifacts.rows[0];
  changeKey = changeArtifact?.object_key;
  check(
    "change_oneReadyArtifact",
    changeArtifacts.rowCount === 1 && changeArtifact?.state === "ready" && changeArtifact.template_version === "change-original-v1",
  );
  check("change_duplicateRun_idle", (await stageOf(run())) === "idle");
  if (changeArtifact) {
    const download = await admin.query<{ download_state: string; object_key: string }>(
      "select download_state, object_key from commercial.original_pdf_download($1::uuid, $2::uuid)",
      [ids.ws, ids.changeDoc],
    );
    check("change_downloadStateReady", download.rows[0]?.download_state === "ready" && download.rows[0]?.object_key === changeArtifact.object_key);
    const url = await createDocumentsDownloadStore(apiStorage).presignGet(changeArtifact.object_key);
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = Buffer.from(await response.arrayBuffer());
    check("change_download_presignedOk", response.status === 200, response.status);
    check("change_download_isPdf", body.subarray(0, 5).toString("latin1") === "%PDF-");
    check(
      "change_download_matchesRecordedChecksum",
      createHash("sha256").update(body).digest("hex") === changeArtifact.sha256 && String(body.byteLength) === changeArtifact.bytes,
    );
    const anonymous = await fetch(`${workerStorage.endpoint.replace(/\/$/, "")}/${workerStorage.bucket}/${changeArtifact.object_key}`, {
      signal: AbortSignal.timeout(10_000),
    });
    check("change_private_anonymousDenied", anonymous.status === 403, anonymous.status);
  }
} finally {
  for (const [name, key] of [
    ["cleanup", storedKey],
    ["changeCleanup", changeKey],
  ] as const) {
    if (key && store.deleteObject) {
      try {
        await store.deleteObject(key);
        report[name] = (await store.getObject?.(key)) === undefined ? "deleted" : "still_present";
      } catch (error) {
        report[name] = `delete_failed:${(error as { name?: string }).name ?? "unknown"}`;
        process.exitCode = 1;
      }
    }
  }
  await pool?.end().catch(() => undefined);
  await admin.end().catch(() => undefined);
  await database.stop();
}

console.log(JSON.stringify(report, null, 2));
