import { Pool, type PoolClient } from "pg";
import { allowlistedSqlstate } from "./me-log.ts";
import { currentRequestTiming, recordDatabaseFailure, type DatabaseFailureKind } from "./request-context.ts";

export const API_TRANSACTION_STAGES = [
  "database_connect_failed",
  "transaction_start_failed",
  "set_role_failed",
  "tenant_context_failed",
  "session_query_failed",
] as const;

export type ApiTransactionStage = (typeof API_TRANSACTION_STAGES)[number];

export const CONNECT_ATTEMPT_TIMEOUT_MS = 2_000;
export const CONNECT_MAX_ATTEMPTS = 3;
export const CONNECT_DEADLINE_MS = 5_500;
export const CONNECT_BACKOFF_MIN_MS = 50;
export const CONNECT_BACKOFF_MAX_MS = 150;
export const POOL_MAX_CLIENTS = 10;
export const POOL_MIN_CLIENTS = 1;
export const POOL_IDLE_TIMEOUT_MS = 300_000;
export const POOL_KEEPALIVE_DELAY_MS = 10_000;
export const QUERY_TIMEOUT_MS = 20_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RETRYABLE_NODE_CODES = new Set([
  "ETIMEDOUT",
  "TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);
const RETRYABLE_SQLSTATES = new Set(["08000", "08001", "08003", "08006", "57P01", "57P02", "57P03", "53300"]);
const TERMINATED_MESSAGES = new Set([
  "Connection terminated unexpectedly",
  "Connection terminated",
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
]);
const BROKEN_CLIENT_MESSAGES = new Set([
  ...TERMINATED_MESSAGES,
  "Query read timeout",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
]);
const TIMEOUT_MESSAGES = new Set([
  "Query read timeout",
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
]);

export class ApiTransactionError extends Error {
  readonly stage: ApiTransactionStage;
  readonly sqlstate?: string;
  readonly code?: string;

  constructor(stage: ApiTransactionStage, sqlstate?: string) {
    super("unavailable");
    this.name = "ApiTransactionError";
    this.stage = stage;
    if (sqlstate) {
      this.sqlstate = sqlstate;
      this.code = sqlstate;
    }
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

export function connectErrorSqlstate(error: unknown): string | undefined {
  const code = errorCode(error);
  if (code === "ETIMEDOUT" || code === "TIMEOUT" || code === "ECONNRESET" || code === "EPIPE") {
    return "08006";
  }
  if (code === "ECONNREFUSED") {
    return "08001";
  }
  const message = errorMessage(error);
  if (message && TERMINATED_MESSAGES.has(message)) {
    return "08006";
  }
  return allowlistedSqlstate(code);
}

export function sqlstateFromUnknown(error: unknown): string | undefined {
  return connectErrorSqlstate(error);
}

export function isRetryableConnectError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && (RETRYABLE_NODE_CODES.has(code) || RETRYABLE_SQLSTATES.has(code))) {
    return true;
  }
  const message = errorMessage(error);
  return Boolean(message && TERMINATED_MESSAGES.has(message));
}

export function isBrokenClientError(error: unknown): boolean {
  if (isRetryableConnectError(error)) {
    return true;
  }
  const message = errorMessage(error);
  return Boolean(message && BROKEN_CLIENT_MESSAGES.has(message));
}

export function databaseFailureKind(error: unknown): DatabaseFailureKind | undefined {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (code === "ETIMEDOUT" || code === "TIMEOUT" || code === "57014" || (message && TIMEOUT_MESSAGES.has(message))) {
    return "timeout";
  }
  if (isBrokenClientError(error)) {
    return "unavailable";
  }
  return undefined;
}

function noteDatabaseFailure(error: unknown): void {
  const kind = databaseFailureKind(error);
  if (kind) {
    recordDatabaseFailure(kind);
  }
}

function preambleStage(error: unknown, includesTenant: boolean): ApiTransactionStage {
  const message = (errorMessage(error) ?? "").toLowerCase();
  if (includesTenant && (message.includes("tenant") || message.includes("set_local_tenant_context"))) {
    return "tenant_context_failed";
  }
  if (message.includes("role")) {
    return "set_role_failed";
  }
  return "transaction_start_failed";
}

export function connectBackoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(CONNECT_BACKOFF_MAX_MS, CONNECT_BACKOFF_MIN_MS * 2 ** Math.max(0, attempt - 1));
  return Math.max(0, Math.floor(exp * (0.5 + random() * 0.5)));
}

function destroyFailedClient(error: unknown, client?: PoolClient): void {
  const attached = error && typeof error === "object" ? (error as { client?: PoolClient }).client : undefined;
  const target = client ?? attached;
  if (!target || typeof target.release !== "function") {
    return;
  }
  try {
    target.release(true);
  } catch {
    /* already released */
  }
}

export type AcquireConnectOptions = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  deadlineMs?: number;
};

export type ApiConnectTimeouts = {
  attemptTimeoutMs: number;
  deadlineMs: number;
};

const poolConnectTimeouts = new WeakMap<Pool, ApiConnectTimeouts>();

export function bindConnectTimeouts(pool: Pick<Pool, "connect">, timeouts: ApiConnectTimeouts): void {
  poolConnectTimeouts.set(pool as Pool, timeouts);
}

export function connectTimeoutsFor(
  pool: Pick<Pool, "connect">,
  options?: AcquireConnectOptions,
): ApiConnectTimeouts {
  const stored = poolConnectTimeouts.get(pool as Pool);
  return {
    attemptTimeoutMs: stored?.attemptTimeoutMs ?? CONNECT_ATTEMPT_TIMEOUT_MS,
    deadlineMs: options?.deadlineMs ?? stored?.deadlineMs ?? CONNECT_DEADLINE_MS,
  };
}

export function createApiPool(connectionString: string, timeouts?: Partial<ApiConnectTimeouts>): Pool {
  const resolved: ApiConnectTimeouts = {
    attemptTimeoutMs: timeouts?.attemptTimeoutMs ?? CONNECT_ATTEMPT_TIMEOUT_MS,
    deadlineMs: timeouts?.deadlineMs ?? CONNECT_DEADLINE_MS,
  };
  const pool = new Pool({
    connectionString,
    ...apiPoolOptions(resolved),
  });
  observePoolErrors(pool);
  bindConnectTimeouts(pool, resolved);
  return pool;
}

export type ApiPoolOptions = {
  max: number;
  min: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  keepAlive: boolean;
  keepAliveInitialDelayMillis: number;
  query_timeout: number;
};

export function apiPoolOptions(timeouts?: Partial<ApiConnectTimeouts>): ApiPoolOptions {
  return {
    max: POOL_MAX_CLIENTS,
    min: POOL_MIN_CLIENTS,
    connectionTimeoutMillis: timeouts?.attemptTimeoutMs ?? CONNECT_ATTEMPT_TIMEOUT_MS,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: POOL_KEEPALIVE_DELAY_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  };
}

export type DatabaseClientEvent = { event: "db_client_error"; scope: "pool" | "client"; sqlstate?: string };

function writeDatabaseClientEvent(event: DatabaseClientEvent): void {
  try {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } catch {
    /* diagnostics must not throw */
  }
}

/**
 * A pooled connection can be closed by the pooler or network while idle or between
 * queries. node-postgres emits `error` on the client; without a listener Node treats
 * it as an uncaught exception and terminates the API process.
 */
export function observePoolErrors(
  pool: Pick<Pool, "on">,
  log: (event: DatabaseClientEvent) => void = writeDatabaseClientEvent,
): void {
  pool.on("error", (error) => {
    log({ event: "db_client_error", scope: "pool", sqlstate: connectErrorSqlstate(error) });
  });
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      log({ event: "db_client_error", scope: "client", sqlstate: connectErrorSqlstate(error) });
    });
  });
}

export async function warmApiPool(pool: Pool, options?: AcquireConnectOptions): Promise<boolean> {
  try {
    const client = await acquirePooledClient(pool, options);
    try {
      await client.query("select 1");
      client.release();
    } catch (error) {
      client.release(true);
      throw error;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The Supabase session pooler closes a connection after about 20 s idle (measured with
 * `pnpm --filter @job-to-invoice/api db:latency`, DB_LATENCY_IDLE_S), and TCP keepalive does not
 * prevent it. Each reconnect then costs several seconds and can exceed the connect deadline, so
 * idle connections are pinged below that window and one connection is kept open.
 */
export const POOL_HEARTBEAT_MS = 10_000;

type HeartbeatPool = Pick<Pool, "connect" | "idleCount" | "totalCount">;

export async function heartbeatIdleClients(pool: HeartbeatPool): Promise<{ pinged: number; failed: number }> {
  const idle = pool.idleCount;
  const targets = idle > 0 ? idle : pool.totalCount === 0 ? POOL_MIN_CLIENTS : 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: targets }, async () => {
      let client: PoolClient | undefined;
      try {
        client = await pool.connect();
        await client.query("select 1");
        client.release();
      } catch {
        failed += 1;
        client?.release(true);
      }
    }),
  );
  return { pinged: targets - failed, failed };
}

export function startPoolHeartbeat(
  pool: HeartbeatPool,
  options: {
    intervalMs?: number;
    schedule?: (tick: () => void, ms: number) => { unref?: () => void };
    cancel?: (handle: { unref?: () => void }) => void;
  } = {},
): () => void {
  const schedule = options.schedule ?? ((tick, ms) => setInterval(tick, ms));
  const cancel = options.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let running = false;
  const handle = schedule(() => {
    if (running) {
      return;
    }
    running = true;
    void heartbeatIdleClients(pool).finally(() => {
      running = false;
    });
  }, options.intervalMs ?? POOL_HEARTBEAT_MS);
  handle.unref?.();
  return () => cancel(handle);
}

export async function acquirePooledClient(
  pool: Pick<Pool, "connect">,
  options?: AcquireConnectOptions,
): Promise<PoolClient> {
  const now = options?.now ?? Date.now;
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options?.random ?? Math.random;
  const maxAttempts = options?.maxAttempts ?? CONNECT_MAX_ATTEMPTS;
  const deadline = now() + connectTimeoutsFor(pool, options).deadlineMs;
  let lastError: unknown = new Error("unavailable");

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (now() >= deadline) {
      break;
    }
    try {
      return await pool.connect();
    } catch (error) {
      lastError = error;
      destroyFailedClient(error);
      const hasRetry = attempt < maxAttempts && now() < deadline && isRetryableConnectError(error);
      if (!hasRetry) {
        throw error;
      }
      const wait = connectBackoffMs(attempt, random);
      const remaining = deadline - now();
      if (remaining <= 0) {
        break;
      }
      await sleep(Math.min(wait, remaining));
    }
  }
  throw lastError;
}

function stageError(stage: ApiTransactionStage, error: unknown): ApiTransactionError {
  if (error instanceof ApiTransactionError) {
    return error;
  }
  return new ApiTransactionError(stage, sqlstateFromUnknown(error));
}

const API_TRANSACTION_PREAMBLE = "begin; set local role api_app";

/**
 * BEGIN, SET LOCAL ROLE, and (for tenant work) the tenant GUCs are sent as one simple-query
 * message so they run in order inside the same transaction for one network round trip.
 * Tenant identifiers come only from the verified owner row and are checked as UUIDs
 * before they are placed in the statement.
 */
export function tenantPreamble(workspaceId: string, actorId: string): string | undefined {
  if (!UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(actorId)) {
    return undefined;
  }
  return `${API_TRANSACTION_PREAMBLE}; select identity.set_local_tenant_context('${workspaceId.toLowerCase()}'::uuid, '${actorId.toLowerCase()}'::uuid)`;
}

async function runApiTransaction<T>(
  pool: Pool,
  preamble: { sql: string; includesTenant: boolean },
  fn: (client: PoolClient) => Promise<T>,
  options?: AcquireConnectOptions,
): Promise<T> {
  const timing = currentRequestTiming();
  let client: PoolClient | undefined;
  let destroy = false;
  let startedAt = Date.now();
  try {
    try {
      client = await acquirePooledClient(pool, options);
    } catch (error) {
      destroyFailedClient(error);
      noteDatabaseFailure(error);
      throw stageError("database_connect_failed", error);
    } finally {
      if (timing) {
        timing.dbWaitMs += Date.now() - startedAt;
      }
      startedAt = Date.now();
    }
    try {
      await client.query(preamble.sql);
    } catch (error) {
      destroy = isBrokenClientError(error);
      noteDatabaseFailure(error);
      throw stageError(preambleStage(error, preamble.includesTenant), error);
    }
    try {
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      destroy = isBrokenClientError(error);
      noteDatabaseFailure(error);
      throw stageError("session_query_failed", error);
    }
  } catch (error) {
    if (client && !destroy) {
      try {
        await client.query("rollback");
      } catch {
        /* already aborted */
      }
    }
    throw error;
  } finally {
    if (client) {
      if (timing) {
        timing.dbMs += Date.now() - startedAt;
        timing.dbTransactions += 1;
      }
      try {
        client.release(destroy);
      } catch {
        /* already released */
      }
    }
  }
}

export async function withApiRole<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options?: AcquireConnectOptions,
): Promise<T> {
  return runApiTransaction(pool, { sql: API_TRANSACTION_PREAMBLE, includesTenant: false }, fn, options);
}

export async function withTenant<T>(
  pool: Pool,
  workspaceId: string,
  actorId: string,
  fn: (client: PoolClient) => Promise<T>,
  options?: AcquireConnectOptions,
): Promise<T> {
  const sql = tenantPreamble(workspaceId, actorId);
  if (!sql) {
    throw new ApiTransactionError("tenant_context_failed", "22023");
  }
  return runApiTransaction(pool, { sql, includesTenant: true }, fn, options);
}

export async function withPortal<T>(
  pool: Pool,
  workspaceId: string,
  requestId: string,
  fn: (client: PoolClient) => Promise<T>,
  options?: AcquireConnectOptions,
): Promise<T> {
  return withApiRole(
    pool,
    async (client) => {
      try {
        await client.query("select identity.set_local_portal_context($1::uuid, $2::uuid)", [workspaceId, requestId]);
      } catch (error) {
        throw new ApiTransactionError("tenant_context_failed", sqlstateFromUnknown(error));
      }
      return fn(client);
    },
    options,
  );
}
