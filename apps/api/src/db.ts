import type { Pool, PoolClient } from "pg";
import { allowlistedSqlstate } from "./me-log.ts";

export const API_TRANSACTION_STAGES = [
  "database_connect_failed",
  "transaction_start_failed",
  "set_role_failed",
  "tenant_context_failed",
  "session_query_failed",
] as const;

export type ApiTransactionStage = (typeof API_TRANSACTION_STAGES)[number];

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

export function sqlstateFromUnknown(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return allowlistedSqlstate((error as { code?: unknown }).code);
}

function stageError(stage: ApiTransactionStage, error: unknown): ApiTransactionError {
  if (error instanceof ApiTransactionError) {
    return error;
  }
  return new ApiTransactionError(stage, sqlstateFromUnknown(error));
}

export async function withApiRole<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient | undefined;
  try {
    try {
      client = await pool.connect();
    } catch (error) {
      throw stageError("database_connect_failed", error);
    }
    try {
      await client.query("begin");
    } catch (error) {
      throw stageError("transaction_start_failed", error);
    }
    try {
      await client.query("set local role api_app");
    } catch (error) {
      throw stageError("set_role_failed", error);
    }
    try {
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
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
    client?.release();
  }
}

export async function withTenant<T>(
  pool: Pool,
  workspaceId: string,
  actorId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withApiRole(pool, async (client) => {
    try {
      await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [workspaceId, actorId]);
    } catch (error) {
      throw new ApiTransactionError("tenant_context_failed", sqlstateFromUnknown(error));
    }
    return fn(client);
  });
}
