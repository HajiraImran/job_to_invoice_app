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

function scriptedPool(script: Script): Pool {
  return {
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
          if (script.hangQuery && normalized.startsWith("select")) {
            return new Promise(() => undefined);
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
          if (normalized === "commit" || normalized === "rollback") {
            return { rows: [] };
          }
          if (script.query) {
            throw script.query;
          }
          return { rows: script.rows ?? [] };
        },
        release: vi.fn(),
      };
      return client as unknown as PoolClient;
    },
  } as unknown as Pool;
}

describe("withWorkerRole stages", () => {
  it("maps connect failure without copying the error message", async () => {
    const error = pgError("08006", "could not connect to host.example.invalid");
    const thrown = await withWorkerRole(scriptedPool({ connect: error }), async () => undefined).catch((value) => value);
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
      withWorkerRole(scriptedPool({ begin: pgError("25P02", "current transaction is aborted") }), async () => undefined),
    ).rejects.toMatchObject({
      stage: "transaction_start_failed",
      sqlstate: "25P02",
      message: "unavailable",
    });
  });

  it("maps SET LOCAL ROLE failure without logging the role command", async () => {
    const thrown = await withWorkerRole(
      scriptedPool({ setRole: pgError("42501", 'permission denied to set role "worker_app"') }),
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
      withWorkerRole(scriptedPool({ query: pgError("42883", "function commercial.claim_generate_original_pdf() does not exist") }), async (client) => {
        await client.query("select * from commercial.claim_generate_original_pdf()");
        return undefined;
      }),
    ).rejects.toMatchObject({
      stage: "claim_query_failed",
      sqlstate: "42883",
      message: "unavailable",
    });
  });

  it("times out a hanging connect", async () => {
    const thrown = await withWorkerRole(scriptedPool({ hangConnect: true }), async () => undefined, {
      timeoutMs: 20,
    }).catch((value) => value);
    expect(thrown).toMatchObject({
      stage: "claim_timed_out",
      message: "unavailable",
    });
    expect(thrown.sqlstate).toBeUndefined();
  });

  it("times out a hanging claim query", async () => {
    await expect(
      withWorkerRole(
        scriptedPool({ hangQuery: true }),
        async (client) => {
          await client.query("select * from commercial.claim_generate_original_pdf()");
          return undefined;
        },
        { timeoutMs: 20 },
      ),
    ).rejects.toMatchObject({ stage: "claim_timed_out" });
  });

  it("does not treat a budget timeout as idle work", async () => {
    await expect(withClaimBudget(new Promise(() => undefined), 20)).rejects.toMatchObject({
      stage: "claim_timed_out",
    });
  });

  it("ignores non-SQLSTATE node codes", () => {
    expect(sqlstateFromUnknown({ code: "ECONNREFUSED" })).toBeUndefined();
    expect(sqlstateFromUnknown({ code: "42501" })).toBe("42501");
    expect(sqlstateFromUnknown(new Error("secret"))).toBeUndefined();
  });
});
