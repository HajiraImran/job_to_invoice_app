import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import { allowlistedSqlstate, type WorkerPdfStage } from "./worker-log.ts";

export const WORKER_CONNECT_TIMEOUT_MS = 2_000;
export const WORKER_STATEMENT_TIMEOUT_MS = 8_000;
export const WORKER_CLAIM_TIMEOUT_MS = 8_000;
export const CONNECT_ATTEMPT_TIMEOUT_MS = WORKER_CONNECT_TIMEOUT_MS;
export const CONNECT_MAX_ATTEMPTS = 3;
export const CONNECT_DEADLINE_MS = 5_500;
export const CONNECT_BACKOFF_MIN_MS = 50;
export const CONNECT_BACKOFF_MAX_MS = 150;
export const WORKER_POOL_MAX_CLIENTS = 4;
export const WORKER_POOL_MIN_CLIENTS = 1;
export const WORKER_POOL_IDLE_TIMEOUT_MS = 300_000;
export const WORKER_KEEPALIVE_DELAY_MS = 10_000;
// Above every worker statement_timeout so the server cancels first; this only
// catches a socket that stopped answering.
export const WORKER_QUERY_TIMEOUT_MS = 30_000;
// The Supabase session pooler drops a connection after about 20 s idle, and a
// cold connect on a lossy link costs several seconds, so idle connections are
// pinged below that window.
export const WORKER_POOL_HEARTBEAT_MS = 10_000;

export const WORKER_TRANSACTION_STAGES = [
  "database_connect_failed",
  "connect_timed_out",
  "transaction_start_failed",
  "set_role_failed",
  "claim_query_failed",
  "claim_timed_out",
] as const;

export type WorkerTransactionStage = (typeof WORKER_TRANSACTION_STAGES)[number];

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
const TERMINATED_MESSAGES = new Set(["Connection terminated unexpectedly", "Connection terminated"]);

export class WorkerTransactionError extends Error {
  readonly stage: WorkerTransactionStage;
  readonly sqlstate?: string;

  constructor(stage: WorkerTransactionStage, sqlstate?: string) {
    super("unavailable");
    this.name = "WorkerTransactionError";
    this.stage = stage;
    if (sqlstate) {
      this.sqlstate = sqlstate;
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

export type WorkerConnectTimeouts = {
  attemptTimeoutMs: number;
  deadlineMs: number;
};

const poolConnectTimeouts = new WeakMap<Pool, WorkerConnectTimeouts>();

export function bindConnectTimeouts(pool: Pick<Pool, "connect">, timeouts: WorkerConnectTimeouts): void {
  poolConnectTimeouts.set(pool as Pool, timeouts);
}

export function connectTimeoutsFor(
  pool: Pick<Pool, "connect">,
  options?: AcquireConnectOptions,
): WorkerConnectTimeouts {
  const stored = poolConnectTimeouts.get(pool as Pool);
  return {
    attemptTimeoutMs: stored?.attemptTimeoutMs ?? CONNECT_ATTEMPT_TIMEOUT_MS,
    deadlineMs: options?.deadlineMs ?? stored?.deadlineMs ?? CONNECT_DEADLINE_MS,
  };
}

export type WorkerPoolOptions = {
  max: number;
  min: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  keepAlive: boolean;
  keepAliveInitialDelayMillis: number;
  query_timeout: number;
};

export function workerPoolOptions(timeouts?: Partial<WorkerConnectTimeouts>): WorkerPoolOptions {
  return {
    max: WORKER_POOL_MAX_CLIENTS,
    min: WORKER_POOL_MIN_CLIENTS,
    connectionTimeoutMillis: timeouts?.attemptTimeoutMs ?? CONNECT_ATTEMPT_TIMEOUT_MS,
    idleTimeoutMillis: WORKER_POOL_IDLE_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: WORKER_KEEPALIVE_DELAY_MS,
    query_timeout: WORKER_QUERY_TIMEOUT_MS,
  };
}

export type WorkerDatabaseClientEvent = {
  event: "db_client_error";
  scope: "pool" | "client";
  sqlstate?: string;
};

function writeDatabaseClientEvent(event: WorkerDatabaseClientEvent): void {
  try {
    console.log(JSON.stringify(event));
  } catch {
    /* diagnostics must not throw */
  }
}

/**
 * node-postgres emits `error` on an idle or checked-out client when the pooler
 * or network closes it. Without a listener Node treats that as an uncaught
 * exception and the worker process exits.
 */
export function observeWorkerPoolErrors(
  pool: Pick<Pool, "on">,
  log: (event: WorkerDatabaseClientEvent) => void = writeDatabaseClientEvent,
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

type HeartbeatPool = Pick<Pool, "connect" | "idleCount" | "totalCount">;

export async function heartbeatWorkerPool(pool: HeartbeatPool): Promise<{ pinged: number; failed: number }> {
  const idle = pool.idleCount;
  const targets = idle > 0 ? idle : pool.totalCount === 0 ? WORKER_POOL_MIN_CLIENTS : 0;
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

export function startWorkerPoolHeartbeat(
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
    void heartbeatWorkerPool(pool).finally(() => {
      running = false;
    });
  }, options.intervalMs ?? WORKER_POOL_HEARTBEAT_MS);
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

export function isTimeoutError(error: unknown): boolean {
  if (error instanceof WorkerTransactionError) {
    return error.stage === "claim_timed_out";
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "57014" || code === "ETIMEDOUT" || code === "TIMEOUT";
}

function stageError(stage: WorkerTransactionStage, error: unknown): WorkerTransactionError {
  if (error instanceof WorkerTransactionError) {
    return error;
  }
  return new WorkerTransactionError(stage, sqlstateFromUnknown(error));
}

export async function withClaimBudget<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => WorkerTransactionStage | undefined,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const stage = onTimeout?.();
          reject(new WorkerTransactionError(stage ?? "claim_timed_out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export const WORKER_ROLE_OPERATIONS = ["worker_pdf", "export", "email", "purge"] as const;
export type WorkerRoleOperation = (typeof WORKER_ROLE_OPERATIONS)[number];

const workerRoleOperation = new AsyncLocalStorage<WorkerRoleOperation>();

export function workerRoleOperationIs(operation: WorkerRoleOperation): boolean {
  return workerRoleOperation.getStore() === operation;
}

export function enterWorkerRoleOperation<T>(operation: WorkerRoleOperation, work: () => Promise<T>): Promise<T> {
  if (workerRoleOperationIs(operation)) {
    return work();
  }
  return workerRoleOperation.run(operation, work);
}

const SAFE_DB_TOKEN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const ROLE_SWITCH_CONTEXT_SQL =
  "select current_user as current_user, session_user as session_user, pg_has_role(session_user, $1, 'member') as session_member, pg_has_role(current_user, $1, 'member') as current_member, current_database() as database_name, inet_server_port() as server_port, current_setting('transaction_read_only') as transaction_read_only";

export type WorkerRoleDiagnostic = {
  event: "worker_role_diagnostic";
  operation: WorkerRoleOperation | "unspecified";
  target_role: "worker_app" | "purge_app";
  current_user: string | null;
  session_user: string | null;
  session_member: boolean | null;
  current_member: boolean | null;
  database: string | null;
  server_port: number | null;
  transaction: "read-write" | "read-only" | null;
  sqlstate: string | null;
};

function safeDbToken(value: unknown): string | null {
  return typeof value === "string" && SAFE_DB_TOKEN.test(value) ? value : null;
}

function safeMember(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function safePort(value: unknown): number | null {
  const port = typeof value === "number" ? value : typeof value === "string" && /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

function transactionMode(value: unknown): "read-write" | "read-only" | null {
  if (value === true || value === "on" || value === "true") {
    return "read-only";
  }
  if (value === false || value === "off" || value === "false") {
    return "read-write";
  }
  return null;
}

export function workerRoleDiagnostic(input: {
  operation: WorkerRoleOperation | "unspecified";
  targetRole: "worker_app" | "purge_app";
  row?: Record<string, unknown>;
  sqlstate?: string;
}): WorkerRoleDiagnostic {
  return {
    event: "worker_role_diagnostic",
    operation: input.operation,
    target_role: input.targetRole,
    current_user: safeDbToken(input.row?.current_user),
    session_user: safeDbToken(input.row?.session_user),
    session_member: safeMember(input.row?.session_member),
    current_member: safeMember(input.row?.current_member),
    database: safeDbToken(input.row?.database_name),
    server_port: safePort(input.row?.server_port),
    transaction: transactionMode(input.row?.transaction_read_only),
    sqlstate: allowlistedSqlstate(input.sqlstate) ?? null,
  };
}

function writeRoleSwitchDiagnostic(
  operation: WorkerRoleOperation | "unspecified",
  targetRole: "worker_app" | "purge_app",
  row: Record<string, unknown> | undefined,
  error: unknown,
): void {
  const diagnostic = workerRoleDiagnostic({
    operation,
    targetRole,
    row,
    sqlstate: sqlstateFromUnknown(error),
  });
  console.log(JSON.stringify(diagnostic));
}

export function createWorkerPool(connectionString: string, timeouts?: Partial<WorkerConnectTimeouts>): Pool {
  const resolved: WorkerConnectTimeouts = {
    attemptTimeoutMs: timeouts?.attemptTimeoutMs ?? CONNECT_ATTEMPT_TIMEOUT_MS,
    deadlineMs: timeouts?.deadlineMs ?? CONNECT_DEADLINE_MS,
  };
  const pool = new Pool({
    connectionString,
    ...workerPoolOptions(resolved),
  });
  observeWorkerPoolErrors(pool);
  bindConnectTimeouts(pool, resolved);
  return pool;
}

export async function warmWorkerPool(pool: Pool, options?: AcquireConnectOptions): Promise<boolean> {
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

const ROLE_SWITCH_SQLSTATES = new Set(["42501", "42704"]);

async function roleSwitchContext(
  client: PoolClient,
  targetRole: "worker_app" | "purge_app",
): Promise<Record<string, unknown> | undefined> {
  try {
    await client.query("rollback");
    const context = await client.query<Record<string, unknown>>(ROLE_SWITCH_CONTEXT_SQL, [targetRole]);
    return context.rows[0];
  } catch {
    return undefined;
  }
}

export async function withWorkerRole<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options?: {
    timeoutMs?: number;
    statementTimeoutMs?: number;
    role?: "worker_app" | "purge_app";
    operation?: WorkerRoleOperation;
  } & AcquireConnectOptions,
): Promise<T> {
  const claimTimeoutMs = options?.timeoutMs;
  const statementTimeoutMs = options?.statementTimeoutMs ?? WORKER_STATEMENT_TIMEOUT_MS;
  let client: PoolClient | undefined;
  let acquiring = true;
  let timedOut = false;
  let timedOutWhileConnecting = false;
  let released = false;
  let destroy = false;

  const releaseClient = (shouldDestroy = false) => {
    if (!client || released) {
      return;
    }
    released = true;
    try {
      client.release(shouldDestroy);
    } catch {
      /* already released */
    }
    client = undefined;
  };

  const abortClaim = (): WorkerTransactionStage => {
    timedOut = true;
    if (acquiring) {
      // A slow connect is not a broken one. Keep it for the next tick instead
      // of forcing another cold connect.
      timedOutWhileConnecting = true;
      return "connect_timed_out";
    }
    destroy = true;
    releaseClient(true);
    return "claim_timed_out";
  };

  const throwIfClaimTimedOut = () => {
    if (timedOut) {
      throw new WorkerTransactionError(timedOutWhileConnecting ? "connect_timed_out" : "claim_timed_out");
    }
  };

  const run = async (): Promise<T> => {
    try {
      try {
        client = await acquirePooledClient(pool, options);
      } catch (error) {
        destroyFailedClient(error);
        throw stageError("database_connect_failed", error);
      } finally {
        acquiring = false;
      }
      if (timedOutWhileConnecting) {
        releaseClient(false);
      }
      throwIfClaimTimedOut();
      const targetRole = options?.role === "purge_app" ? "purge_app" : "worker_app";
      const operation =
        options?.operation ?? workerRoleOperation.getStore() ?? (targetRole === "purge_app" ? "purge" : "unspecified");
      const timeout = Math.max(1, Math.floor(statementTimeoutMs));
      try {
        // One round trip. BEGIN still precedes SET LOCAL in the same transaction.
        await client.query(`begin; set local statement_timeout = ${timeout}; set local role ${targetRole}`);
      } catch (error) {
        const code = errorCode(error);
        if (code && ROLE_SWITCH_SQLSTATES.has(code)) {
          destroy = true;
          writeRoleSwitchDiagnostic(operation, targetRole, await roleSwitchContext(client, targetRole), error);
          throw stageError("set_role_failed", error);
        }
        destroy = true;
        throw stageError("transaction_start_failed", error);
      }
      throwIfClaimTimedOut();
      try {
        const result = await fn(client);
        throwIfClaimTimedOut();
        await client.query("commit");
        throwIfClaimTimedOut();
        return result;
      } catch (error) {
        if (claimTimeoutMs !== undefined && (timedOut || isTimeoutError(error))) {
          destroy = true;
          throw new WorkerTransactionError("claim_timed_out", sqlstateFromUnknown(error));
        }
        destroy = isRetryableConnectError(error);
        throw stageError("claim_query_failed", error);
      }
    } catch (error) {
      // Destroying the connection discards the open transaction server-side;
      // a rollback on a broken socket would only wait for query_timeout.
      if (client && !released && !destroy) {
        try {
          await client.query("rollback");
        } catch {
          destroy = true;
        }
      }
      throw error;
    } finally {
      releaseClient((timedOut && !timedOutWhileConnecting) || destroy);
    }
  };

  const work = run();
  void work.catch(() => undefined);
  if (claimTimeoutMs === undefined) {
    return work;
  }
  return withClaimBudget(work, claimTimeoutMs, abortClaim);
}

export function workerStageFromError(error: unknown): { stage: WorkerPdfStage; sqlstate?: string } | undefined {
  if (error instanceof WorkerTransactionError) {
    return { stage: error.stage, sqlstate: error.sqlstate };
  }
  return undefined;
}
