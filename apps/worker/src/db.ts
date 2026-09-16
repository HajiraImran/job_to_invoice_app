import { Pool, type PoolClient } from "pg";
import { allowlistedSqlstate, type WorkerPdfStage } from "./worker-log.ts";

export const WORKER_CONNECT_TIMEOUT_MS = 8_000;
export const WORKER_STATEMENT_TIMEOUT_MS = 8_000;
export const WORKER_CLAIM_TIMEOUT_MS = 8_000;

export const WORKER_TRANSACTION_STAGES = [
  "database_connect_failed",
  "transaction_start_failed",
  "set_role_failed",
  "claim_query_failed",
  "claim_timed_out",
] as const;

export type WorkerTransactionStage = (typeof WORKER_TRANSACTION_STAGES)[number];

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

export function sqlstateFromUnknown(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return allowlistedSqlstate((error as { code?: unknown }).code);
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
  if (isTimeoutError(error)) {
    return new WorkerTransactionError("claim_timed_out", sqlstateFromUnknown(error));
  }
  return new WorkerTransactionError(stage, sqlstateFromUnknown(error));
}

export async function withClaimBudget<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
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
    connectionTimeoutMillis: WORKER_CONNECT_TIMEOUT_MS,
  });
}

export async function withWorkerRole<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options?: { timeoutMs?: number; statementTimeoutMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? WORKER_CLAIM_TIMEOUT_MS;
  const statementTimeoutMs = options?.statementTimeoutMs ?? WORKER_STATEMENT_TIMEOUT_MS;
  return withClaimBudget(
    (async () => {
      let client: PoolClient | undefined;
      try {
        try {
          client = await pool.connect();
        } catch (error) {
          throw stageError("database_connect_failed", error);
        }
        try {
          await client.query("begin");
          const timeout = Math.max(1, Math.floor(statementTimeoutMs));
          await client.query(`set local statement_timeout = ${timeout}`);
        } catch (error) {
          throw stageError("transaction_start_failed", error);
        }
        try {
          await client.query("set local role worker_app");
        } catch (error) {
          throw stageError("set_role_failed", error);
        }
        try {
          const result = await fn(client);
          await client.query("commit");
          return result;
        } catch (error) {
          throw stageError("claim_query_failed", error);
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
        client?.release();
      }
    })(),
    timeoutMs,
  );
}

export function workerStageFromError(error: unknown): { stage: WorkerPdfStage; sqlstate?: string } | undefined {
  if (error instanceof WorkerTransactionError) {
    return { stage: error.stage, sqlstate: error.sqlstate };
  }
  return undefined;
}
