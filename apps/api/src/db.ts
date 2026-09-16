import { Pool, type PoolClient } from "pg";
import { allowlistedSqlstate } from "./me-log.ts";

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

export function createApiPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: CONNECT_ATTEMPT_TIMEOUT_MS,
  });
}

export function apiPoolOptions(): { max: number; connectionTimeoutMillis: number } {
  return {
    max: 10,
    connectionTimeoutMillis: CONNECT_ATTEMPT_TIMEOUT_MS,
  };
}

export async function acquirePooledClient(
  pool: Pick<Pool, "connect">,
  options?: AcquireConnectOptions,
): Promise<PoolClient> {
  const now = options?.now ?? Date.now;
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options?.random ?? Math.random;
  const maxAttempts = options?.maxAttempts ?? CONNECT_MAX_ATTEMPTS;
  const deadline = now() + (options?.deadlineMs ?? CONNECT_DEADLINE_MS);
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

export async function withApiRole<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options?: AcquireConnectOptions,
): Promise<T> {
  let client: PoolClient | undefined;
  let destroy = false;
  try {
    try {
      client = await acquirePooledClient(pool, options);
    } catch (error) {
      destroyFailedClient(error);
      throw stageError("database_connect_failed", error);
    }
    try {
      await client.query("begin");
    } catch (error) {
      destroy = isRetryableConnectError(error);
      throw stageError("transaction_start_failed", error);
    }
    try {
      await client.query("set local role api_app");
    } catch (error) {
      destroy = isRetryableConnectError(error);
      throw stageError("set_role_failed", error);
    }
    try {
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      destroy = isRetryableConnectError(error);
      throw stageError("session_query_failed", error);
    }
  } catch (error) {
    if (client) {
      try {
        await client.query("rollback");
      } catch {
        /* already aborted */
      }
    }
    throw error;
  } finally {
    if (client) {
      try {
        client.release(destroy);
      } catch {
        /* already released */
      }
    }
  }
}

export async function withTenant<T>(
  pool: Pool,
  workspaceId: string,
  actorId: string,
  fn: (client: PoolClient) => Promise<T>,
  options?: AcquireConnectOptions,
): Promise<T> {
  return withApiRole(
    pool,
    async (client) => {
      try {
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [workspaceId, actorId]);
      } catch (error) {
        throw new ApiTransactionError("tenant_context_failed", sqlstateFromUnknown(error));
      }
      return fn(client);
    },
    options,
  );
}
