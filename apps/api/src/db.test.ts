import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  ApiTransactionError,
  CONNECT_MAX_ATTEMPTS,
  acquirePooledClient,
  apiPoolOptions,
  connectBackoffMs,
  connectErrorSqlstate,
  isRetryableConnectError,
  sqlstateFromUnknown,
  withApiRole,
  withTenant,
} from "./db.ts";

type Script = {
  connect?: unknown;
  connectErrors?: unknown[];
  begin?: unknown;
  setRole?: unknown;
  tenant?: unknown;
  query?: unknown;
  commit?: unknown;
  rows?: unknown[];
};

function pgError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

function scriptedPool(script: Script): { pool: Pool; release: ReturnType<typeof vi.fn>; connects: { count: number }; begins: { count: number } } {
  const connects = { count: 0 };
  const begins = { count: 0 };
  const release = vi.fn();
  const pool = {
    connect: async () => {
      connects.count += 1;
      const queued = script.connectErrors?.[connects.count - 1];
      if (queued) {
        throw queued;
      }
      if (script.connect) {
        throw script.connect;
      }
      const client = {
        query: async (sql: string) => {
          const normalized = sql.trim().toLowerCase();
          if (normalized === "begin") {
            begins.count += 1;
            if (script.begin) {
              throw script.begin;
            }
            return { rows: [] };
          }
          if (normalized === "set local role api_app") {
            if (script.setRole) {
              throw script.setRole;
            }
            return { rows: [] };
          }
          if (normalized.includes("set_local_tenant_context")) {
            if (script.tenant) {
              throw script.tenant;
            }
            return { rows: [] };
          }
          if (normalized === "commit") {
            if (script.commit) {
              throw script.commit;
            }
            return { rows: [] };
          }
          if (normalized === "rollback") {
            return { rows: [] };
          }
          if (script.query) {
            throw script.query;
          }
          return { rows: script.rows ?? [{ ok: true }] };
        },
        release,
      };
      return client as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool, release, connects, begins };
}

const noSleep = { sleep: async () => undefined, random: () => 0.5 };

describe("withApiRole stages", () => {
  it("maps connect failure without copying the error message", async () => {
    const error = pgError("08006", "could not connect to host.example.invalid");
    const first = scriptedPool({ connect: error });
    await expect(withApiRole(first.pool, async () => undefined, noSleep)).rejects.toMatchObject({
      name: "ApiTransactionError",
      stage: "database_connect_failed",
      sqlstate: "08006",
      message: "unavailable",
    });
    const second = scriptedPool({ connect: error });
    const thrown = await withApiRole(second.pool, async () => undefined, noSleep).catch((value) => value);
    expect(thrown).toBeInstanceOf(ApiTransactionError);
    expect(JSON.stringify(thrown)).not.toMatch(/host\.example|could not connect/i);
  });

  it("maps begin failure", async () => {
    await expect(
      withApiRole(scriptedPool({ begin: pgError("25P02", "current transaction is aborted") }).pool, async () => undefined),
    ).rejects.toMatchObject({
      stage: "transaction_start_failed",
      sqlstate: "25P02",
      message: "unavailable",
    });
  });

  it("maps SET LOCAL ROLE failure without logging the role command", async () => {
    const thrown = await withApiRole(
      scriptedPool({ setRole: pgError("42501", 'permission denied to set role "api_app"') }).pool,
      async () => undefined,
    ).catch((value) => value);
    expect(thrown).toMatchObject({
      stage: "set_role_failed",
      sqlstate: "42501",
      message: "unavailable",
    });
    expect(JSON.stringify(thrown)).not.toMatch(/permission denied|api_app|SET ROLE/i);
  });

  it("maps callback query failure", async () => {
    await expect(
      withApiRole(scriptedPool({ query: pgError("42883", "function identity.provision_owner does not exist") }).pool, async (client) => {
        await client.query("select 1 from identity.provision_owner($1::uuid, $2, $3)", ["x", "y", "z"]);
        return undefined;
      }),
    ).rejects.toMatchObject({
      stage: "session_query_failed",
      sqlstate: "42883",
      message: "unavailable",
    });
  });

  it("maps tenant context failure without copying identifiers", async () => {
    const thrown = await withTenant(
      scriptedPool({ tenant: pgError("42501", "permission denied for function set_local_tenant_context") }).pool,
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      async () => undefined,
    ).catch((value) => value);
    expect(thrown).toMatchObject({
      stage: "tenant_context_failed",
      sqlstate: "42501",
      message: "unavailable",
    });
    expect(JSON.stringify(thrown)).not.toMatch(/11111111|set_local_tenant_context|permission denied/i);
  });

  it("categorizes node connect failures as allowlisted SQLSTATE classes", () => {
    expect(connectErrorSqlstate({ code: "ETIMEDOUT" })).toBe("08006");
    expect(connectErrorSqlstate({ code: "ECONNRESET" })).toBe("08006");
    expect(connectErrorSqlstate({ code: "ECONNREFUSED" })).toBe("08001");
    expect(connectErrorSqlstate({ message: "Connection terminated unexpectedly" })).toBe("08006");
    expect(sqlstateFromUnknown({ code: "ECONNREFUSED" })).toBe("08001");
    expect(sqlstateFromUnknown({ code: "42501" })).toBe("42501");
    expect(sqlstateFromUnknown(new Error("secret"))).toBeUndefined();
    expect(isRetryableConnectError(pgError("ETIMEDOUT", "connect ETIMEDOUT 8.8.8.8"))).toBe(true);
  });
});

describe("bounded pre-BEGIN connection acquisition", () => {
  it("retries a timed-out connect then begins once", async () => {
    const scripted = scriptedPool({ connectErrors: [pgError("ETIMEDOUT", "connect ETIMEDOUT db.example.invalid")] });
    const result = await withApiRole(scripted.pool, async () => "ok", noSleep);
    expect(result).toBe("ok");
    expect(scripted.connects.count).toBe(2);
    expect(scripted.begins.count).toBe(1);
    expect(scripted.release).toHaveBeenCalledWith(false);
  });

  it("exhausts retryable connect failures and returns database_connect_failed", async () => {
    const scripted = scriptedPool({ connect: pgError("ECONNRESET", "read ECONNRESET") });
    const thrown = await withApiRole(scripted.pool, async () => "ok", noSleep).catch((value) => value);
    expect(thrown).toMatchObject({
      stage: "database_connect_failed",
      sqlstate: "08006",
      message: "unavailable",
    });
    expect(scripted.connects.count).toBe(CONNECT_MAX_ATTEMPTS);
    expect(scripted.begins.count).toBe(0);
    expect(JSON.stringify(thrown)).not.toMatch(/ECONNRESET|example|postgres:\/\//i);
  });

  it("does not retry after BEGIN may have executed", async () => {
    const scripted = scriptedPool({ begin: pgError("08006", "server closed the connection unexpectedly") });
    await expect(withApiRole(scripted.pool, async () => "ok", noSleep)).rejects.toMatchObject({
      stage: "transaction_start_failed",
    });
    expect(scripted.connects.count).toBe(1);
    expect(scripted.begins.count).toBe(1);
  });

  it("destroys a client attached to a failed connect attempt", async () => {
    const release = vi.fn();
    const failed = Object.assign(pgError("ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1"), {
      client: { release },
    });
    await expect(
      acquirePooledClient(
        { connect: async () => Promise.reject(failed) },
        { ...noSleep, maxAttempts: 1 },
      ),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(release).toHaveBeenCalledWith(true);
  });

  it("uses a process-level pool timeout and jittered backoff without secrets", () => {
    expect(apiPoolOptions()).toEqual({ max: 10, connectionTimeoutMillis: 2_000 });
    expect(connectBackoffMs(1, () => 0)).toBe(25);
    expect(connectBackoffMs(1, () => 1)).toBe(50);
    expect(JSON.stringify(apiPoolOptions())).not.toMatch(/postgres:\/\/|password|amazonaws/i);
  });
});
