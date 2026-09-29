import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  CONNECT_DEADLINE_MS,
  CONNECT_MAX_ATTEMPTS,
  WorkerTransactionError,
  acquirePooledClient,
  enterWorkerRoleOperation,
  bindConnectTimeouts,
  connectErrorSqlstate,
  connectTimeoutsFor,
  createWorkerPool,
  heartbeatWorkerPool,
  observeWorkerPoolErrors,
  sqlstateFromUnknown,
  warmWorkerPool,
  withClaimBudget,
  withWorkerRole,
  workerPoolOptions,
} from "./db.ts";

type Script = {
  connect?: unknown;
  connectErrors?: unknown[];
  hangConnect?: boolean;
  hangQuery?: boolean;
  delayQuery?: (resolve: (value: { rows: unknown[] }) => void) => void;
  begin?: unknown;
  setRole?: unknown;
  query?: unknown;
  rows?: unknown[];
  roleContext?: Record<string, unknown>;
};

function pgError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

function scriptedPool(script: Script): {
  pool: Pool;
  release: ReturnType<typeof vi.fn>;
  commits: { count: number };
  connects: { count: number };
  begins: { count: number };
  queries: string[];
} {
  const commits = { count: 0 };
  const connects = { count: 0 };
  const begins = { count: 0 };
  const queries: string[] = [];
  let rejectHang: ((error: Error) => void) | undefined;
  const release = vi.fn((destroy?: boolean | Error) => {
    if (destroy && rejectHang) {
      rejectHang(new Error("terminated"));
      rejectHang = undefined;
    }
  });
  const pool = {
    connect: async () => {
      connects.count += 1;
      if (script.hangConnect) {
        return new Promise(() => undefined);
      }
      const queued = script.connectErrors?.[connects.count - 1];
      if (queued) {
        throw queued;
      }
      if (script.connect) {
        throw script.connect;
      }
      const one = async (normalized: string): Promise<{ rows: unknown[] }> => {
          if (normalized.includes("pg_has_role")) {
            return {
              rows: [
                script.roleContext ?? {
                  current_user: "postgres",
                  session_user: "postgres",
                  session_member: true,
                  current_member: true,
                  database_name: "app",
                  server_port: 5432,
                  transaction_read_only: "off",
                },
              ],
            };
          }
          if ((script.hangQuery || script.delayQuery) && normalized.startsWith("select")) {
            return new Promise<{ rows: unknown[] }>((resolve, reject) => {
              rejectHang = reject;
              if (script.delayQuery) {
                script.delayQuery(resolve);
              }
            });
          }
          if (normalized === "begin") {
            begins.count += 1;
            if (script.begin) {
              throw script.begin;
            }
            return { rows: [] };
          }
          if (normalized.startsWith("set local statement_timeout")) {
            return { rows: [] };
          }
          if (normalized === "set local role worker_app" || normalized === "set local role purge_app") {
            if (script.setRole) {
              throw script.setRole;
            }
            return { rows: [] };
          }
          if (normalized === "commit") {
            commits.count += 1;
            return { rows: [] };
          }
          if (normalized === "rollback") {
            return { rows: [] };
          }
          if (script.query) {
            throw script.query;
          }
          return { rows: script.rows ?? [] };
      };
      const client = {
        query: async (sql: string) => {
          queries.push(sql);
          const parts = sql
            .split(";")
            .map((part) => part.trim().toLowerCase())
            .filter((part) => part.length > 0);
          let last: { rows: unknown[] } = { rows: [] };
          for (const part of parts) {
            last = await one(part);
          }
          return last;
        },
        release,
      };
      return client as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool, release, commits, connects, begins, queries };
}

describe("withWorkerRole stages", () => {
  const noSleep = { sleep: async () => undefined, random: () => 0.5 };

  it("maps connect failure without copying the error message", async () => {
    const error = pgError("08006", "could not connect to host.example.invalid");
    const thrown = await withWorkerRole(scriptedPool({ connect: error }).pool, async () => undefined, noSleep).catch(
      (value) => value,
    );
    expect(thrown).toBeInstanceOf(WorkerTransactionError);
    expect(thrown).toMatchObject({
      stage: "database_connect_failed",
      sqlstate: "08006",
      message: "unavailable",
    });
    expect(JSON.stringify(thrown)).not.toMatch(/host\.example|could not connect/i);
  });

  it("maps begin failure", async () => {
    await expect(
      withWorkerRole(
        scriptedPool({ begin: pgError("25P02", "current transaction is aborted") }).pool,
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      stage: "transaction_start_failed",
      sqlstate: "25P02",
      message: "unavailable",
    });
  });

  it("maps SET LOCAL ROLE failure without logging the role command", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      if (typeof line === "string") {
        lines.push(line);
      }
    });
    try {
      const scripted = scriptedPool({
        setRole: pgError(
          "42501",
          'permission denied to set role "worker_app" postgres://worker:secret@db.example/app token=abc set local role',
        ),
        roleContext: {
          current_user: "Bearer secret-token",
          session_user: "postgres://worker:secret@db.example/app",
          session_member: true,
          current_member: false,
          database_name: "postgres://worker:secret@db.example/app",
          server_port: 5432,
          transaction_read_only: "off",
        },
      });
      const thrown = await enterWorkerRoleOperation("worker_pdf", () =>
        withWorkerRole(scripted.pool, async () => undefined),
      ).catch((value) => value);
      expect(thrown).toMatchObject({
        stage: "set_role_failed",
        sqlstate: "42501",
        message: "unavailable",
      });
      expect(JSON.stringify(thrown)).not.toMatch(/permission denied|worker_app|SET ROLE|postgres:\/\/|secret|db\.example/i);
      expect(lines).toHaveLength(1);
      const diagnostic = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      expect(diagnostic).toEqual({
        event: "worker_role_diagnostic",
        operation: "worker_pdf",
        target_role: "worker_app",
        current_user: null,
        session_user: null,
        session_member: true,
        current_member: false,
        database: null,
        server_port: 5432,
        transaction: "read-write",
        sqlstate: "42501",
      });
      expect(lines[0]).not.toMatch(/permission denied|set local role|postgres:\/\/|secret|db\.example|Bearer|token=abc/i);
      expect(scripted.release).toHaveBeenCalledTimes(1);
      expect(scripted.release).toHaveBeenCalledWith(true);
      expect(scripted.release).not.toHaveBeenCalledWith(false);
      expect(scripted.commits.count).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("destroys a 42501 role client and lets the next transaction use a fresh one", async () => {
    const idle: Array<{ id: number }> = [];
    const destroyed: number[] = [];
    let nextId = 0;
    let roleAttempts = 0;
    const pool = {
      connect: async () => {
        const reused = idle.shift();
        if (reused) {
          return reused;
        }
        const id = (nextId += 1);
        const one = async (normalized: string): Promise<{ rows: unknown[] }> => {
            if (normalized.includes("pg_has_role")) {
              return {
                rows: [
                  {
                    current_user: "postgres",
                    session_user: "postgres",
                    session_member: true,
                    current_member: true,
                    database_name: "app",
                    server_port: 5432,
                    transaction_read_only: "off",
                  },
                ],
              };
            }
            if (normalized === "set local role worker_app" || normalized === "set local role purge_app") {
              roleAttempts += 1;
              if (id === 1) {
                throw pgError("42501", 'permission denied to set role "worker_app"');
              }
              return { rows: [] };
            }
            if (normalized.startsWith("select")) {
              return { rows: [{ id: "fresh" }] };
            }
            return { rows: [] };
        };
        const client = {
          id,
          query: async (sql: string) => {
            let last: { rows: unknown[] } = { rows: [] };
            for (const part of sql.split(";").map((value) => value.trim().toLowerCase()).filter(Boolean)) {
              last = await one(part);
            }
            return last;
          },
          release(destroy?: boolean) {
            if (destroy) {
              destroyed.push(id);
              return;
            }
            idle.push(client);
          },
        };
        return client;
      },
    } as unknown as Pool;

    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      if (typeof line === "string" && line.includes("worker_role_diagnostic")) {
        lines.push(line);
      }
    });
    let thrown: unknown;
    try {
      thrown = await withWorkerRole(pool, async () => "claimed", { operation: "export" }).catch((value) => value);
    expect(thrown).toBeInstanceOf(WorkerTransactionError);
    expect(thrown).toMatchObject({
      stage: "set_role_failed",
      sqlstate: "42501",
      message: "unavailable",
    });
    expect(JSON.stringify(thrown)).not.toMatch(/permission denied|worker_app|set local role/i);
    expect(roleAttempts).toBe(1);
    expect(destroyed).toEqual([1]);
    expect(idle).toEqual([]);

    const row = await withWorkerRole(pool, async (client) => {
      expect((client as unknown as { id: number }).id).toBe(2);
      const result = await client.query("select 1");
      return result.rows[0];
    });
    expect(row).toEqual({ id: "fresh" });
    expect(roleAttempts).toBe(2);
    expect(destroyed).toEqual([1]);
    expect(idle.map((client) => client.id)).toEqual([2]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "worker_role_diagnostic",
      operation: "export",
      target_role: "worker_app",
      current_user: "postgres",
      session_user: "postgres",
      session_member: true,
      current_member: true,
      database: "app",
      server_port: 5432,
      transaction: "read-write",
      sqlstate: "42501",
    });
    expect(lines[0]).not.toMatch(/permission denied|set local role|postgres:\/\//i);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not emit a role diagnostic after a successful role switch", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      if (typeof line === "string" && line.includes("worker_role_diagnostic")) {
        lines.push(line);
      }
    });
    try {
      await expect(withWorkerRole(scriptedPool({}).pool, async () => "ready")).resolves.toBe("ready");
      expect(lines).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("maps claim query failure", async () => {
    await expect(
      withWorkerRole(
        scriptedPool({
          query: pgError("42883", "function commercial.claim_generate_original_pdf() does not exist"),
        }).pool,
        async (client) => {
          await client.query("select * from commercial.claim_generate_original_pdf()");
          return undefined;
        },
      ),
    ).rejects.toMatchObject({
      stage: "claim_query_failed",
      sqlstate: "42883",
      message: "unavailable",
    });
  });

  it("reports a hanging connect as connection acquisition, not a claim query timeout", async () => {
    const thrown = await withWorkerRole(scriptedPool({ hangConnect: true }).pool, async () => undefined, {
      timeoutMs: 20,
    }).catch((value) => value);
    expect(thrown).toMatchObject({
      stage: "connect_timed_out",
      message: "unavailable",
    });
    expect(thrown.sqlstate).toBeUndefined();
  });

  it("keeps a slow connection that arrives after the claim budget and recovers on the next tick", async () => {
    const idle: PoolClient[] = [];
    const destroyed: PoolClient[] = [];
    let slow = true;
    let connects = 0;
    const queries: string[] = [];
    const makeClient = (): PoolClient => {
      const client = {
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: sql.startsWith("select") ? [{ id: "task-1" }] : [] };
        },
        release: (destroy?: boolean) => {
          (destroy ? destroyed : idle).push(client as unknown as PoolClient);
        },
      };
      return client as unknown as PoolClient;
    };
    const pool = {
      connect: async () => {
        connects += 1;
        const reused = idle.pop();
        if (reused) {
          return reused;
        }
        if (slow) {
          slow = false;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        return makeClient();
      },
    } as unknown as Pool;
    const claim = async (client: PoolClient) => (await client.query("select * from commercial.claim_generate_original_pdf()")).rows[0];

    await expect(withWorkerRole(pool, claim, { timeoutMs: 10 })).rejects.toMatchObject({ stage: "connect_timed_out" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(destroyed).toHaveLength(0);
    expect(idle).toHaveLength(1);
    expect(queries).toEqual([]);

    await expect(withWorkerRole(pool, claim, { timeoutMs: 50 })).resolves.toEqual({ id: "task-1" });
    expect(connects).toBe(2);
    expect(destroyed).toHaveLength(0);
    expect(queries).toEqual([
      "begin; set local statement_timeout = 8000; set local role worker_app",
      "select * from commercial.claim_generate_original_pdf()",
      "commit",
    ]);
  });

  it("sends BEGIN, statement timeout, and role in one round trip", async () => {
    const scripted = scriptedPool({ rows: [{ id: "one" }] });
    await withWorkerRole(scripted.pool, async (client) => (await client.query("select 1")).rows[0], {
      role: "purge_app",
      statementTimeoutMs: 1234,
    });
    expect(scripted.queries).toEqual([
      "begin; set local statement_timeout = 1234; set local role purge_app",
      "select 1",
      "commit",
    ]);
  });

  it("destroys a client whose connection dropped mid-transaction without waiting on rollback", async () => {
    const scripted = scriptedPool({ query: Object.assign(new Error("Connection terminated unexpectedly"), {}) });
    await expect(
      withWorkerRole(scripted.pool, async (client) => {
        await client.query("select * from commercial.load_original_pdf_source($1::uuid)");
      }),
    ).rejects.toMatchObject({ stage: "claim_query_failed", sqlstate: "08006" });
    expect(scripted.queries).not.toContain("rollback");
    expect(scripted.release).toHaveBeenCalledWith(true);
  });

  it("times out a hanging claim query, destroys the client, and recovers on a later call", async () => {
    const hung = scriptedPool({ hangQuery: true });
    await expect(
      withWorkerRole(
        hung.pool,
        async (client) => {
          await client.query("select * from commercial.claim_generate_original_pdf()");
          return "claimed";
        },
        { timeoutMs: 20 },
      ),
    ).rejects.toMatchObject({ stage: "claim_timed_out" });
    expect(hung.release).toHaveBeenCalledWith(true);
    expect(hung.commits.count).toBe(0);

    const recovered = scriptedPool({ rows: [{ id: "task-1" }] });
    const row = await withWorkerRole(
      recovered.pool,
      async (client) => {
        const result = await client.query("select * from commercial.claim_generate_original_pdf()");
        return result.rows[0];
      },
      { timeoutMs: 50 },
    );
    expect(row).toEqual({ id: "task-1" });
    expect(recovered.commits.count).toBe(1);
    expect(recovered.release).toHaveBeenCalledWith(false);
  });

  it("does not commit a late claim result after timeout", async () => {
    let finishQuery: ((value: { rows: unknown[] }) => void) | undefined;
    const delayed = scriptedPool({
      delayQuery: (resolve) => {
        finishQuery = resolve;
      },
    });
    const pending = withWorkerRole(
      delayed.pool,
      async (client) => {
        const result = await client.query("select * from commercial.claim_generate_original_pdf()");
        return result.rows[0];
      },
      { timeoutMs: 20 },
    );
    await expect(pending).rejects.toMatchObject({ stage: "claim_timed_out" });
    expect(delayed.release).toHaveBeenCalledWith(true);
    finishQuery?.({ rows: [{ id: "late-claim" }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(delayed.commits.count).toBe(0);
  });

  it("does not apply the claim budget after a successful claim query", async () => {
    const delayed = scriptedPool({
      delayQuery: (resolve) => {
        setTimeout(() => resolve({ rows: [{ id: "post-claim" }] }), 40);
      },
    });
    const row = await withWorkerRole(delayed.pool, async (client) => {
      const result = await client.query("select * from commercial.load_original_pdf_source($1::uuid)", ["task"]);
      return result.rows[0];
    });
    expect(row).toEqual({ id: "post-claim" });
    expect(delayed.commits.count).toBe(1);
    expect(delayed.release).not.toHaveBeenCalledWith(true);
  });

  it("does not treat a budget timeout as idle work", async () => {
    await expect(withClaimBudget(new Promise(() => undefined), 20)).rejects.toMatchObject({
      stage: "claim_timed_out",
    });
  });

  it("clears the claim timer after a fast claim", async () => {
    vi.useFakeTimers();
    try {
      const fast = scriptedPool({ rows: [{ id: "fast" }] });
      const result = await withWorkerRole(
        fast.pool,
        async (client) => {
          const rows = await client.query("select 1");
          return rows.rows[0];
        },
        { timeoutMs: 8_000 },
      );
      expect(result).toEqual({ id: "fast" });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(fast.release).not.toHaveBeenCalledWith(true);
      expect(fast.commits.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("categorizes node connect failures as allowlisted SQLSTATE classes", () => {
    expect(connectErrorSqlstate({ code: "ETIMEDOUT" })).toBe("08006");
    expect(connectErrorSqlstate({ code: "ECONNRESET" })).toBe("08006");
    expect(connectErrorSqlstate({ code: "ECONNREFUSED" })).toBe("08001");
    expect(sqlstateFromUnknown({ code: "ECONNREFUSED" })).toBe("08001");
    expect(sqlstateFromUnknown({ code: "42501" })).toBe("42501");
    expect(sqlstateFromUnknown(new Error("secret"))).toBeUndefined();
  });

  it("retries a timed-out connect then begins once", async () => {
    const scripted = scriptedPool({ connectErrors: [pgError("ETIMEDOUT", "connect ETIMEDOUT db.example.invalid")] });
    const result = await withWorkerRole(scripted.pool, async () => "claimed", noSleep);
    expect(result).toBe("claimed");
    expect(scripted.connects.count).toBe(2);
    expect(scripted.begins.count).toBe(1);
    expect(scripted.commits.count).toBe(1);
    expect(scripted.release).toHaveBeenCalledWith(false);
  });

  it("exhausts connect failures without beginning a transaction", async () => {
    const scripted = scriptedPool({ connect: pgError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1") });
    const thrown = await withWorkerRole(scripted.pool, async () => "claimed", noSleep).catch((value) => value);
    expect(thrown).toMatchObject({
      stage: "database_connect_failed",
      sqlstate: "08001",
      message: "unavailable",
    });
    expect(scripted.connects.count).toBe(CONNECT_MAX_ATTEMPTS);
    expect(scripted.begins.count).toBe(0);
    expect(JSON.stringify(thrown)).not.toMatch(/10\.0\.0\.1|ECONNREFUSED|postgres:\/\//i);
  });

  it("does not retry after BEGIN may have executed", async () => {
    const scripted = scriptedPool({ begin: pgError("08006", "server closed the connection unexpectedly") });
    await expect(withWorkerRole(scripted.pool, async () => "claimed", noSleep)).rejects.toMatchObject({
      stage: "transaction_start_failed",
    });
    expect(scripted.connects.count).toBe(1);
    expect(scripted.begins.count).toBe(1);
  });

  it("applies configured attempt timeout to the pool and deadline to acquisition", async () => {
    expect(workerPoolOptions({ attemptTimeoutMs: 10_000, deadlineMs: 25_000 })).toEqual({
      max: 4,
      min: 1,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 300_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      query_timeout: 30_000,
    });
    const pool = createWorkerPool("postgres://worker:x@127.0.0.1:1/app", {
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
    const thrown = await withWorkerRole(scripted.pool, async () => "ok", {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      random: () => 0.5,
    }).catch((value) => value);
    expect(scripted.connects.count).toBeGreaterThanOrEqual(1);
    expect(scripted.connects.count).toBeLessThan(CONNECT_MAX_ATTEMPTS);
    expect(thrown).toMatchObject({
      name: "WorkerTransactionError",
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

  it("destroys a client attached to a failed connect attempt", async () => {
    const release = vi.fn();
    const failed = Object.assign(pgError("ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1"), { client: { release } });
    await expect(
      acquirePooledClient({ connect: async () => Promise.reject(failed) }, { ...noSleep, maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(release).toHaveBeenCalledWith(true);
  });
});

describe("worker pool resilience", () => {
  it("logs pool and client errors with only an allowlisted SQLSTATE instead of crashing", () => {
    const handlers = new Map<string, (value: unknown) => void>();
    const clientHandlers = new Map<string, (value: unknown) => void>();
    const events: unknown[] = [];
    observeWorkerPoolErrors(
      { on: (name: string, handler: (value: unknown) => void) => handlers.set(name, handler) } as unknown as Pool,
      (event) => events.push(event),
    );
    handlers.get("connect")?.({ on: (name: string, handler: (value: unknown) => void) => clientHandlers.set(name, handler) });
    handlers.get("error")?.(Object.assign(new Error("read ECONNRESET 10.0.0.1 postgres://u:p@h/db"), { code: "ECONNRESET" }));
    clientHandlers.get("error")?.(new Error("Connection terminated unexpectedly"));
    expect(events).toEqual([
      { event: "db_client_error", scope: "pool", sqlstate: "08006" },
      { event: "db_client_error", scope: "client", sqlstate: "08006" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/10\.0\.0\.1|postgres:|ECONNRESET/);
  });

  it("registers error listeners on pools it creates", async () => {
    const pool = createWorkerPool("postgres://worker:x@127.0.0.1:1/app");
    try {
      expect(pool.listenerCount("error")).toBeGreaterThan(0);
      expect(pool.listenerCount("connect")).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  it("pings idle clients, destroys a dropped one, and reopens the minimum when empty", async () => {
    const released: Array<boolean | undefined> = [];
    let fail = true;
    const pool = {
      idleCount: 2,
      totalCount: 2,
      connect: async () => ({
        query: async () => {
          if (fail) {
            fail = false;
            throw new Error("Connection terminated unexpectedly");
          }
          return { rows: [] };
        },
        release: (destroy?: boolean) => released.push(destroy),
      }),
    } as unknown as Pool;
    expect(await heartbeatWorkerPool(pool)).toEqual({ pinged: 1, failed: 1 });
    expect(released.sort()).toEqual([true, undefined]);

    const empty = { ...pool, idleCount: 0, totalCount: 0 } as unknown as Pool;
    expect(await heartbeatWorkerPool(empty)).toEqual({ pinged: 1, failed: 0 });
  });

  it("warms a pool before polling and reports failure without throwing", async () => {
    const ok = scriptedPool({});
    await expect(warmWorkerPool(ok.pool, { sleep: async () => undefined })).resolves.toBe(true);
    const down = scriptedPool({ connect: pgError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1") });
    await expect(warmWorkerPool(down.pool, { sleep: async () => undefined })).resolves.toBe(false);
  });
});
