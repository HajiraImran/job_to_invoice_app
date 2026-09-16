import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  WorkerTransactionError,
  sqlstateFromUnknown,
  withClaimBudget,
  withWorkerRole,
} from "./db.ts";

type Script = {
  connect?: unknown;
  hangConnect?: boolean;
  hangQuery?: boolean;
  delayQuery?: (resolve: (value: { rows: unknown[] }) => void) => void;
  begin?: unknown;
  setRole?: unknown;
  query?: unknown;
  rows?: unknown[];
};

function pgError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

function scriptedPool(script: Script): { pool: Pool; release: ReturnType<typeof vi.fn>; commits: { count: number } } {
  const commits = { count: 0 };
  let rejectHang: ((error: Error) => void) | undefined;
  const release = vi.fn((destroy?: boolean | Error) => {
    if (destroy && rejectHang) {
      rejectHang(new Error("terminated"));
      rejectHang = undefined;
    }
  });
  const pool = {
    connect: async () => {
      if (script.hangConnect) {
        return new Promise(() => undefined);
      }
      if (script.connect) {
        throw script.connect;
      }
      const client = {
        query: async (sql: string) => {
          const normalized = sql.trim().toLowerCase();
          if ((script.hangQuery || script.delayQuery) && normalized.startsWith("select")) {
            return new Promise<{ rows: unknown[] }>((resolve, reject) => {
              rejectHang = reject;
              if (script.delayQuery) {
                script.delayQuery(resolve);
              }
            });
          }
          if (normalized === "begin") {
            if (script.begin) {
              throw script.begin;
            }
            return { rows: [] };
          }
          if (normalized.startsWith("set local statement_timeout")) {
            return { rows: [] };
          }
          if (normalized === "set local role worker_app") {
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
        },
        release,
      };
      return client as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool, release, commits };
}

describe("withWorkerRole stages", () => {
  it("maps connect failure without copying the error message", async () => {
    const error = pgError("08006", "could not connect to host.example.invalid");
    const thrown = await withWorkerRole(scriptedPool({ connect: error }).pool, async () => undefined).catch(
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
    const thrown = await withWorkerRole(
      scriptedPool({ setRole: pgError("42501", 'permission denied to set role "worker_app"') }).pool,
      async () => undefined,
    ).catch((value) => value);
    expect(thrown).toMatchObject({
      stage: "set_role_failed",
      sqlstate: "42501",
      message: "unavailable",
    });
    expect(JSON.stringify(thrown)).not.toMatch(/permission denied|worker_app|SET ROLE/i);
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

  it("times out a hanging connect", async () => {
    const thrown = await withWorkerRole(scriptedPool({ hangConnect: true }).pool, async () => undefined, {
      timeoutMs: 20,
    }).catch((value) => value);
    expect(thrown).toMatchObject({
      stage: "claim_timed_out",
      message: "unavailable",
    });
    expect(thrown.sqlstate).toBeUndefined();
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

  it("ignores non-SQLSTATE node codes", () => {
    expect(sqlstateFromUnknown({ code: "ECONNREFUSED" })).toBeUndefined();
    expect(sqlstateFromUnknown({ code: "42501" })).toBe("42501");
    expect(sqlstateFromUnknown(new Error("secret"))).toBeUndefined();
  });
});
