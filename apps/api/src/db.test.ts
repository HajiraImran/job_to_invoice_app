import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { ApiTransactionError, sqlstateFromUnknown, withApiRole } from "./db.ts";

type Script = {
  connect?: unknown;
  begin?: unknown;
  setRole?: unknown;
  query?: unknown;
  commit?: unknown;
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
      if (script.connect) {
        throw script.connect;
      }
      const client = {
        query: async (sql: string) => {
          const normalized = sql.trim().toLowerCase();
          if (normalized === "begin") {
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
        release: vi.fn(),
      };
      return client as unknown as PoolClient;
    },
  } as unknown as Pool;
}

describe("withApiRole stages", () => {
  it("maps connect failure without copying the error message", async () => {
    const error = pgError("08006", "could not connect to host.example.invalid");
    await expect(withApiRole(scriptedPool({ connect: error }), async () => undefined)).rejects.toMatchObject({
      name: "ApiTransactionError",
      stage: "database_connect_failed",
      sqlstate: "08006",
      message: "unavailable",
    });
    const thrown = await withApiRole(scriptedPool({ connect: error }), async () => undefined).catch((value) => value);
    expect(thrown).toBeInstanceOf(ApiTransactionError);
    expect(JSON.stringify(thrown)).not.toMatch(/host\.example|could not connect/i);
  });

  it("maps begin failure", async () => {
    await expect(
      withApiRole(scriptedPool({ begin: pgError("25P02", "current transaction is aborted") }), async () => undefined),
    ).rejects.toMatchObject({
      stage: "transaction_start_failed",
      sqlstate: "25P02",
      message: "unavailable",
    });
  });

  it("maps SET LOCAL ROLE failure without logging the role command", async () => {
    const thrown = await withApiRole(
      scriptedPool({ setRole: pgError("42501", 'permission denied to set role "api_app"') }),
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
      withApiRole(scriptedPool({ query: pgError("42883", "function identity.provision_owner does not exist") }), async (client) => {
        await client.query("select 1 from identity.provision_owner($1::uuid, $2, $3)", ["x", "y", "z"]);
        return undefined;
      }),
    ).rejects.toMatchObject({
      stage: "session_query_failed",
      sqlstate: "42883",
      message: "unavailable",
    });
  });

  it("ignores non-SQLSTATE node codes", () => {
    expect(sqlstateFromUnknown({ code: "ECONNREFUSED" })).toBeUndefined();
    expect(sqlstateFromUnknown({ code: "42501" })).toBe("42501");
    expect(sqlstateFromUnknown(new Error("secret"))).toBeUndefined();
  });
});
