import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  ApiTransactionError,
  CONNECT_DEADLINE_MS,
  CONNECT_MAX_ATTEMPTS,
  acquirePooledClient,
  apiPoolOptions,
  bindConnectTimeouts,
  connectBackoffMs,
  connectErrorSqlstate,
  connectTimeoutsFor,
  createApiPool,
  databaseFailureKind,
  heartbeatIdleClients,
  isRetryableConnectError,
  observePoolErrors,
  startPoolHeartbeat,
  sqlstateFromUnknown,
  tenantPreamble,
  withApiRole,
  withTenant,
} from "./db.ts";
import { createRequestTiming, runWithRequestTiming } from "./request-context.ts";

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

function scriptedPool(script: Script): {
  pool: Pool;
  release: ReturnType<typeof vi.fn>;
  connects: { count: number };
  begins: { count: number };
  statements: string[];
} {
  const connects = { count: 0 };
  const begins = { count: 0 };
  const statements: string[] = [];
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
      const run = async (sql: string) => {
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
      };
      const client = {
        query: async (sql: string) => {
          statements.push(sql.trim());
          let last: { rows: unknown[] } = { rows: [] };
          for (const statement of sql.split(";")) {
            last = await run(statement);
          }
          return last;
        },
        release,
      };
      return client as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool, release, connects, begins, statements };
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

describe("round trips, broken connections, and timeouts", () => {
  it("sends BEGIN, SET LOCAL ROLE, and tenant context as one ordered message", async () => {
    const scripted = scriptedPool({});
    await withTenant(
      scripted.pool,
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      async (client) => {
        await client.query("select 1 as listed");
      },
    );
    expect(scripted.statements).toEqual([
      "begin; set local role api_app; select identity.set_local_tenant_context('11111111-1111-4111-8111-111111111111'::uuid, '22222222-2222-4222-8222-222222222222'::uuid)",
      "select 1 as listed",
      "commit",
    ]);
    expect(scripted.begins.count).toBe(1);
  });

  it("refuses a tenant identifier that is not a UUID without contacting the database", async () => {
    const scripted = scriptedPool({});
    const thrown = await withTenant(scripted.pool, "x' or true --", "22222222-2222-4222-8222-222222222222", async () => "ok").catch(
      (value) => value,
    );
    expect(thrown).toMatchObject({ stage: "tenant_context_failed", message: "unavailable" });
    expect(scripted.connects.count).toBe(0);
    expect(tenantPreamble("11111111-1111-4111-8111-111111111111", "not-a-uuid")).toBeUndefined();
  });

  it("destroys a client whose query timed out instead of rolling back on it", async () => {
    const scripted = scriptedPool({ query: new Error("Query read timeout") });
    const timing = createRequestTiming();
    const thrown = await runWithRequestTiming(timing, () =>
      withApiRole(scripted.pool, async (client) => {
        await client.query("select pg_sleep(60)");
      }),
    ).catch((value) => value);
    expect(thrown).toMatchObject({ stage: "session_query_failed", message: "unavailable" });
    expect(scripted.release).toHaveBeenCalledWith(true);
    expect(scripted.statements).not.toContain("rollback");
    expect(timing.dbFailure).toBe("timeout");
    expect(timing.dbTransactions).toBe(1);
  });

  it("classifies connection timeouts separately from refused or terminated connections", async () => {
    expect(databaseFailureKind(new Error("timeout exceeded when trying to connect"))).toBe("timeout");
    expect(databaseFailureKind(pgError("57014", "canceling statement due to statement timeout"))).toBe("timeout");
    expect(databaseFailureKind(pgError("ECONNREFUSED", "connect ECONNREFUSED"))).toBe("unavailable");
    expect(databaseFailureKind(new Error("Connection terminated unexpectedly"))).toBe("unavailable");
    expect(databaseFailureKind(pgError("P0001", "VERSION_CONFLICT"))).toBeUndefined();

    const timing = createRequestTiming();
    const scripted = scriptedPool({ connect: new Error("timeout exceeded when trying to connect") });
    await runWithRequestTiming(timing, () => withApiRole(scripted.pool, async () => "ok", noSleep)).catch(() => undefined);
    expect(timing.dbFailure).toBe("timeout");
    expect(scripted.connects.count).toBe(CONNECT_MAX_ATTEMPTS);
  });

  it("keeps the process alive when a pooled connection is terminated between queries", () => {
    const pool = new EventEmitter();
    const events: unknown[] = [];
    observePoolErrors(pool as unknown as Pool, (event) => events.push(event));
    const client = new EventEmitter();
    pool.emit("connect", client);
    expect(() => client.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(() => pool.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).not.toThrow();
    expect(events).toEqual([
      { event: "db_client_error", scope: "client", sqlstate: "08006" },
      { event: "db_client_error", scope: "pool", sqlstate: "08006" },
    ]);
  });

  it("attaches the error listener to every client the real pool creates", async () => {
    const pool = createApiPool("postgres://api:x@127.0.0.1:1/app");
    try {
      expect(pool.listenerCount("error")).toBe(1);
      expect(pool.listenerCount("connect")).toBe(1);
      expect(pool.options.idleTimeoutMillis).toBe(300_000);
      expect(pool.options.min).toBe(1);
    } finally {
      await pool.end();
    }
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
    expect(apiPoolOptions()).toEqual({
      max: 10,
      min: 1,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 300_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      query_timeout: 20_000,
    });
    expect(connectBackoffMs(1, () => 0)).toBe(25);
    expect(connectBackoffMs(1, () => 1)).toBe(50);
    expect(JSON.stringify(apiPoolOptions())).not.toMatch(/postgres:\/\/|password|amazonaws/i);
  });

  it("applies configured attempt timeout to the pool and deadline to acquisition", async () => {
    expect(apiPoolOptions({ attemptTimeoutMs: 10_000, deadlineMs: 25_000 })).toMatchObject({
      max: 10,
      connectionTimeoutMillis: 10_000,
    });
    const pool = createApiPool("postgres://api:x@127.0.0.1:1/app", {
      attemptTimeoutMs: 10_000,
      deadlineMs: 25_000,
    });
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(10_000);
      expect(connectTimeoutsFor(pool)).toEqual({ attemptTimeoutMs: 10_000, deadlineMs: 25_000 });
    } finally {
      await pool.end();
    }

    let now = 0;
    const scripted = scriptedPool({ connect: pgError("ETIMEDOUT", "connect ETIMEDOUT db.example.invalid") });
    bindConnectTimeouts(scripted.pool, { attemptTimeoutMs: 10_000, deadlineMs: 80 });
    const thrown = await withApiRole(scripted.pool, async () => "ok", {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      random: () => 0.5,
    }).catch((value) => value);
    expect(scripted.connects.count).toBeGreaterThanOrEqual(1);
    expect(scripted.connects.count).toBeLessThan(CONNECT_MAX_ATTEMPTS);
    expect(thrown).toMatchObject({
      name: "ApiTransactionError",
      stage: "database_connect_failed",
      message: "unavailable",
    });
    expect(JSON.stringify(thrown)).not.toMatch(/postgres:\/\/|password|db\.example|connect ETIMEDOUT/i);
  });

  it("honors an explicit acquisition deadline over bound pool timeouts", async () => {
    let now = 0;
    const fake = {
      connect: async () => {
        throw pgError("ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1");
      },
    };
    bindConnectTimeouts(fake, { attemptTimeoutMs: 10_000, deadlineMs: CONNECT_DEADLINE_MS });
    expect(connectTimeoutsFor(fake, { deadlineMs: 40 }).deadlineMs).toBe(40);
    await expect(
      acquirePooledClient(fake, {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        random: () => 0.5,
        deadlineMs: 40,
      }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });
});

describe("idle connection heartbeat", () => {
  function heartbeatPool(idleCount: number, totalCount: number, failQuery = false) {
    const released: boolean[] = [];
    const queries: string[] = [];
    const pool = {
      idleCount,
      totalCount,
      connect: async () =>
        ({
          query: async (sql: string) => {
            queries.push(sql);
            if (failQuery) {
              throw new Error("Connection terminated unexpectedly");
            }
            return { rows: [] };
          },
          release: (destroy?: boolean) => {
            released.push(destroy === true);
          },
        }) as unknown as PoolClient,
    };
    return { pool: pool as unknown as Pool, released, queries };
  }

  it("pings every idle client with a harmless query and releases it", async () => {
    const { pool, released, queries } = heartbeatPool(3, 3);
    await expect(heartbeatIdleClients(pool)).resolves.toEqual({ pinged: 3, failed: 0 });
    expect(queries).toEqual(["select 1", "select 1", "select 1"]);
    expect(released).toEqual([false, false, false]);
  });

  it("reopens one connection after the pooler dropped them all, and never pings busy clients", async () => {
    const empty = heartbeatPool(0, 0);
    await expect(heartbeatIdleClients(empty.pool)).resolves.toEqual({ pinged: 1, failed: 0 });
    const busy = heartbeatPool(0, 2);
    await expect(heartbeatIdleClients(busy.pool)).resolves.toEqual({ pinged: 0, failed: 0 });
    expect(busy.queries).toEqual([]);
  });

  it("destroys a client whose ping fails", async () => {
    const { pool, released } = heartbeatPool(1, 1, true);
    await expect(heartbeatIdleClients(pool)).resolves.toEqual({ pinged: 0, failed: 1 });
    expect(released).toEqual([true]);
  });

  it("runs below the pooler's measured 20 s idle cut-off, skips overlapping ticks, and stops", async () => {
    let tick: (() => void) | undefined;
    let scheduledMs = 0;
    let cancelled = false;
    let connects = 0;
    let finish: (() => void) | undefined;
    const pool = {
      idleCount: 1,
      totalCount: 1,
      connect: async () => {
        connects += 1;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { query: async () => ({ rows: [] }), release: () => undefined } as unknown as PoolClient;
      },
    } as unknown as Pool;
    const stop = startPoolHeartbeat(pool, {
      schedule: (fn, ms) => {
        tick = fn;
        scheduledMs = ms;
        return {};
      },
      cancel: () => {
        cancelled = true;
      },
    });
    expect(scheduledMs).toBeLessThan(20_000);
    tick?.();
    tick?.();
    expect(connects).toBe(1);
    finish?.();
    stop();
    expect(cancelled).toBe(true);
  });
});
