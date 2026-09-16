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

export const WORKER_TRANSACTION_STAGES = [
  "database_connect_failed",
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
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new WorkerTransactionError("claim_timed_out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function createWorkerPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: CONNECT_ATTEMPT_TIMEOUT_MS,
  });
}

export async function withWorkerRole<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options?: { timeoutMs?: number; statementTimeoutMs?: number } & AcquireConnectOptions,
): Promise<T> {
  const claimTimeoutMs = options?.timeoutMs;
  const statementTimeoutMs = options?.statementTimeoutMs ?? WORKER_STATEMENT_TIMEOUT_MS;
  let client: PoolClient | undefined;
  let timedOut = false;
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

  const abortClaim = () => {
    timedOut = true;
    destroy = true;
    releaseClient(true);
  };

  const throwIfClaimTimedOut = () => {
    if (timedOut) {
      throw new WorkerTransactionError("claim_timed_out");
    }
  };

  const run = async (): Promise<T> => {
    try {
      try {
        client = await acquirePooledClient(pool, options);
      } catch (error) {
        destroyFailedClient(error);
        throw stageError("database_connect_failed", error);
      }
      throwIfClaimTimedOut();
      try {
        await client.query("begin");
        const timeout = Math.max(1, Math.floor(statementTimeoutMs));
        await client.query(`set local statement_timeout = ${timeout}`);
      } catch (error) {
        destroy = isRetryableConnectError(error);
        throw stageError("transaction_start_failed", error);
      }
      throwIfClaimTimedOut();
      try {
        await client.query("set local role worker_app");
      } catch (error) {
        destroy = isRetryableConnectError(error);
        throw stageError("set_role_failed", error);
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
      if (client && !released) {
        try {
          await client.query("rollback");
        } catch {
          /* already aborted */
        }
      }
      throw error;
    } finally {
      releaseClient(timedOut || destroy);
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
