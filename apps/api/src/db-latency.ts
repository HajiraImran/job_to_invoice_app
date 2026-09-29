import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { loadApiEnv } from "@job-to-invoice/config";
import { createApiPool, startPoolHeartbeat, withApiRole, withTenant } from "./db.ts";

const env = loadApiEnv();
const databaseUrl = "DATABASE_URL_API" in env ? env.DATABASE_URL_API : undefined;
if (!databaseUrl) {
  console.log(JSON.stringify({ error: "DATABASE_URL_API is not set" }));
  process.exit(1);
}

const host = new URL(databaseUrl).hostname;
const hostKind = host.endsWith(".pooler.supabase.com")
  ? "supabase_pooler"
  : host === "localhost" || host === "127.0.0.1"
    ? "local"
    : "other";
const elapsed = (start: number) => Math.round(performance.now() - start);
const rounds = Number(process.env.DB_LATENCY_ROUNDS ?? "5");

const pool = createApiPool(databaseUrl, {
  attemptTimeoutMs: env.databaseConnectAttemptTimeoutMs,
  deadlineMs: env.databaseConnectDeadlineMs,
});

const report: {
  host_kind: string;
  connect_attempt_timeout_ms: number;
  first_transaction_ms?: number;
  warm_transaction_ms: number[];
  authenticated_get_model_ms: number[];
  tenant_transaction_legacy_ms: number[];
  tenant_transaction_combined_ms: number[];
  round_trip_ms: number[];
  heartbeat?: boolean;
  idle_drop_after_ms?: number | null;
  transaction_after_idle_ms?: number;
  failures: string[];
} = {
  host_kind: hostKind,
  connect_attempt_timeout_ms: env.databaseConnectAttemptTimeoutMs,
  warm_transaction_ms: [],
  authenticated_get_model_ms: [],
  tenant_transaction_legacy_ms: [],
  tenant_transaction_combined_ms: [],
  round_trip_ms: [],
  failures: [],
};

const workspaceId = randomUUID();
const actorId = randomUUID();

/** The statement sequence used before the preamble was sent as one message. */
async function legacyTenantTransaction() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role api_app");
    await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [workspaceId, actorId]);
    await client.query("select 1");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function oneTransaction() {
  await withApiRole(pool, async (client) => {
    await client.query("select 1");
  });
}

try {
  const first = performance.now();
  await oneTransaction();
  report.first_transaction_ms = elapsed(first);
  for (let i = 0; i < rounds; i += 1) {
    const warm = performance.now();
    await oneTransaction();
    report.warm_transaction_ms.push(elapsed(warm));
    const request = performance.now();
    await withApiRole(pool, async (client) => {
      await client.query("select 1");
    });
    await withApiRole(pool, async (client) => {
      await client.query("select 1");
      await client.query("select 1");
    });
    report.authenticated_get_model_ms.push(elapsed(request));

    const legacy = performance.now();
    await legacyTenantTransaction();
    report.tenant_transaction_legacy_ms.push(elapsed(legacy));
    const combined = performance.now();
    await withTenant(pool, workspaceId, actorId, async (client) => {
      await client.query("select 1");
    });
    report.tenant_transaction_combined_ms.push(elapsed(combined));

    const client = await pool.connect();
    try {
      const trip = performance.now();
      await client.query("select 1");
      report.round_trip_ms.push(elapsed(trip));
    } finally {
      client.release();
    }
  }

  const idleSeconds = Number(process.env.DB_LATENCY_IDLE_S ?? "0");
  if (idleSeconds > 0) {
    const stopHeartbeat = process.env.DB_LATENCY_HEARTBEAT === "1" ? startPoolHeartbeat(pool) : () => undefined;
    report.heartbeat = process.env.DB_LATENCY_HEARTBEAT === "1";
    const idleStart = performance.now();
    const dropped = new Promise<number>((resolve) => {
      pool.on("error", () => resolve(elapsed(idleStart)));
    });
    const outcome = await Promise.race([
      dropped,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), idleSeconds * 1000)),
    ]);
    report.idle_drop_after_ms = outcome ?? null;
    stopHeartbeat();
    const after = performance.now();
    await oneTransaction();
    report.transaction_after_idle_ms = elapsed(after);
  }
} catch (error) {
  const stage = error && typeof error === "object" && "stage" in error ? String(error.stage) : "unknown";
  report.failures.push(stage);
} finally {
  await pool.end().catch(() => undefined);
}

console.log(JSON.stringify(report));
