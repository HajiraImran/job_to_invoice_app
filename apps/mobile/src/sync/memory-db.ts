/**
 * In-memory EncryptedSqliteHandle for SYNC01 orchestration tests.
 * Not a full SQL engine — supports the statements used by schema/outbox/drafts/jobs.
 */

import type { EncryptedSqliteHandle, SqliteStatementResult } from "../storage/encrypted-database.ts";

type Row = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createMemorySqlite(): EncryptedSqliteHandle & {
  tables: Record<string, Row[]>;
} {
  const tables: Record<string, Row[]> = {
    schema_meta: [],
    jobs_cache: [],
    local_drafts: [],
    outbox_ops: [],
    sync_meta: [],
    sync01_probe: [],
  };

  function ensure(name: string): Row[] {
    if (!tables[name]) {
      tables[name] = [];
    }
    return tables[name];
  }

  const handle: EncryptedSqliteHandle & { tables: Record<string, Row[]> } = {
    tables,
    execAsync: async () => {
      /* DDL no-op — tables precreated */
    },
    runAsync: async (source: string, params: unknown[] = []): Promise<SqliteStatementResult> => {
      const sql = source.replace(/\s+/g, " ").trim();
      if (sql.startsWith("insert into schema_meta")) {
        ensure("schema_meta").length = 0;
        ensure("schema_meta").push({
          id: 1,
          version: params[0],
          owner_id: params[1],
          workspace_id: params[2],
          bound_at: params[3],
        });
        return { changes: 1, lastInsertRowId: 1 };
      }
      if (sql.startsWith("update schema_meta set version")) {
        const row = ensure("schema_meta")[0];
        if (row) {
          row.version = params[0];
        }
        return { changes: row ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.includes("insert into local_drafts")) {
        const draftId = String(params[0]);
        const existing = ensure("local_drafts").find((row) => row.draft_id === draftId);
        const syncState = sql.includes("'dirty'") ? "dirty" : params[7];
        const localUpdatedAt = sql.includes("'dirty'") ? params[7] : params[8];
        const next: Row = {
          draft_id: params[0],
          job_id: params[1],
          kind: params[2],
          base_version: params[3],
          server_version: params[4],
          schema_version: params[5],
          payload_json: params[6],
          sync_state: syncState,
          local_updated_at: localUpdatedAt,
          conflict_server_json: null,
          conflict_local_json: null,
        };
        if (sql.includes("on conflict") && existing) {
          Object.assign(existing, next);
        } else if (!existing) {
          ensure("local_drafts").push(next);
        } else {
          Object.assign(existing, next);
        }
        return { changes: 1, lastInsertRowId: 1 };
      }
      if (sql.startsWith("update local_drafts set") && sql.includes("conflict_local_json = ?")) {
        const draft = ensure("local_drafts").find((row) => row.draft_id === params[3]);
        if (draft) {
          draft.sync_state = "conflict";
          draft.conflict_local_json = params[0];
          draft.conflict_server_json = params[1];
          draft.local_updated_at = params[2];
        }
        return { changes: draft ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.startsWith("update local_drafts set") && sql.includes("conflict_local_json = null")) {
        const draft = ensure("local_drafts").find((row) => row.draft_id === params[5]);
        if (draft) {
          draft.payload_json = params[0];
          draft.base_version = params[1];
          draft.server_version = params[2];
          draft.sync_state = params[3];
          draft.conflict_local_json = null;
          draft.conflict_server_json = null;
          draft.local_updated_at = params[4];
        }
        return { changes: draft ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.startsWith("update local_drafts set sync_state")) {
        const draft = ensure("local_drafts").find((row) => row.draft_id === params[5]);
        if (draft) {
          draft.sync_state = params[0];
          if (params[1] !== null && params[1] !== undefined) {
            draft.base_version = params[1];
          }
          if (params[2] !== null && params[2] !== undefined) {
            draft.server_version = params[2];
          }
          if (params[3] !== null && params[3] !== undefined) {
            draft.payload_json = params[3];
          }
          draft.local_updated_at = params[4];
        }
        return { changes: draft ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.includes("insert into outbox_ops")) {
        const opId = String(params[0]);
        const existing = ensure("outbox_ops").find((row) => row.operation_id === opId);
        const next: Row = {
          operation_id: params[0],
          resource_kind: params[1],
          resource_id: params[2],
          method: params[3],
          path: params[4],
          body_json: params[5],
          base_version: params[6],
          idempotency_key: params[7],
          dependency_ids_json: params[8],
          state: "pending",
          attempts: 0,
          next_attempt_at: params[9],
          last_error_code: null,
          created_at: params[10],
          updated_at: params[11],
        };
        if (existing) {
          Object.assign(existing, next);
        } else {
          ensure("outbox_ops").push(next);
        }
        return { changes: 1, lastInsertRowId: 1 };
      }
      if (sql.startsWith("update outbox_ops set base_version = ?")) {
        const version = Number(params[0]);
        let changes = 0;
        for (const row of ensure("outbox_ops")) {
          if (row.resource_id !== params[2] || !["pending", "failed"].includes(String(row.state))) {
            continue;
          }
          const current = row.base_version === null || row.base_version === undefined ? null : Number(row.base_version);
          if (current === null || current < version) {
            row.base_version = version;
            row.updated_at = params[1];
            changes += 1;
          }
        }
        return { changes, lastInsertRowId: 1 };
      }
      if (sql.startsWith("update outbox_ops set") && sql.includes("method = ?")) {
        const row = ensure("outbox_ops").find((item) => item.operation_id === params[8]);
        if (row) {
          row.method = params[0];
          row.path = params[1];
          row.body_json = params[2];
          row.base_version = params[3];
          row.idempotency_key = params[4];
          row.dependency_ids_json = params[5];
          row.state = "pending";
          row.next_attempt_at = params[6];
          row.updated_at = params[7];
          row.last_error_code = null;
        }
        return { changes: row ? 1 : 0, lastInsertRowId: 1 };
      }
      if (
        sql.includes("set state = 'in_flight'") &&
        sql.includes("and state = 'pending'") &&
        !sql.includes("next_attempt_at")
      ) {
        const row = ensure("outbox_ops").find(
          (item) => item.operation_id === params[1] && item.state === "pending",
        );
        if (row) {
          row.state = "in_flight";
          row.updated_at = params[0];
        }
        return { changes: row ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.includes("state = 'pending'") && sql.includes("state = 'in_flight'") && sql.includes("next_attempt_at")) {
        const row = ensure("outbox_ops").find(
          (item) => item.operation_id === params[2] && item.state === "in_flight",
        );
        if (row) {
          row.state = "pending";
          row.next_attempt_at = params[0];
          row.updated_at = params[1];
        }
        return { changes: row ? 1 : 0, lastInsertRowId: 1 };
      }
      if (
        sql.includes("next_attempt_at = ?") &&
        sql.includes("state = 'pending'") &&
        !sql.includes("attempts") &&
        !sql.includes("paused_conflict") &&
        !sql.includes("method = ?")
      ) {
        const row = ensure("outbox_ops").find(
          (item) => item.operation_id === params[2] && item.state === "pending",
        );
        if (row) {
          row.next_attempt_at = params[0];
          row.updated_at = params[1];
        }
        return { changes: row ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.includes("state = 'in_flight'") && !sql.includes("state = 'pending'")) {
        const row = ensure("outbox_ops").find((item) => item.operation_id === params[1] && item.state === "pending");
        if (row) {
          row.state = "in_flight";
          row.updated_at = params[0];
        }
        return { changes: row ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.includes("state = 'done'") && sql.includes("last_error_code = ?") && sql.includes("resource_id")) {
        let changes = 0;
        for (const row of ensure("outbox_ops")) {
          if (
            row.resource_id === params[2] &&
            row.operation_id !== params[3] &&
            ["pending", "failed"].includes(String(row.state))
          ) {
            row.state = "done";
            row.updated_at = params[0];
            row.last_error_code = params[1];
            changes += 1;
          }
        }
        return { changes, lastInsertRowId: 1 };
      }
      if (sql.includes("state = 'done'") && sql.includes("last_error_code = ?") && !sql.includes("null")) {
        const row = ensure("outbox_ops").find((item) => item.operation_id === params[2]);
        if (row) {
          row.state = "done";
          row.updated_at = params[0];
          row.last_error_code = params[1];
        }
        return { changes: row ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.includes("state = 'done'")) {
        const row = ensure("outbox_ops").find((item) => item.operation_id === params[1]);
        if (row) {
          row.state = "done";
          row.updated_at = params[0];
          row.last_error_code = null;
        }
        return { changes: row ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.includes("state = 'failed'") && sql.includes("last_error_code")) {
        const row = ensure("outbox_ops").find((item) => item.operation_id === params[2]);
        if (row) {
          row.state = "failed";
          row.last_error_code = params[0];
          row.updated_at = params[1];
        }
        return { changes: row ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.includes("state = 'pending'") && sql.includes("paused_conflict")) {
        for (const row of ensure("outbox_ops")) {
          if (row.resource_id === params[2] && row.state === "paused_conflict") {
            row.state = "pending";
            row.next_attempt_at = params[0];
            row.updated_at = params[1];
            row.last_error_code = null;
          }
        }
        return { changes: 1, lastInsertRowId: 1 };
      }
      if (sql.includes("state = 'paused_conflict'")) {
        const row = ensure("outbox_ops").find((item) => item.operation_id === params[2]);
        if (row) {
          row.state = "paused_conflict";
          row.updated_at = params[0];
          row.last_error_code = params[1];
        }
        return { changes: row ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.includes("attempts = ?")) {
        const row = ensure("outbox_ops").find((item) => item.operation_id === params[4]);
        if (row) {
          row.state = "pending";
          row.attempts = params[0];
          row.next_attempt_at = params[1];
          row.last_error_code = params[2];
          row.updated_at = params[3];
        }
        return { changes: row ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.startsWith("delete from outbox_ops")) {
        const before = ensure("outbox_ops").length;
        tables.outbox_ops = ensure("outbox_ops").filter((row) => {
          if (row.resource_id !== params[0]) {
            return true;
          }
          return !["paused_conflict", "pending", "failed"].includes(String(row.state));
        });
        return { changes: before - tables.outbox_ops.length, lastInsertRowId: 1 };
      }
      if (sql.includes("insert into jobs_cache")) {
        const jobId = String(params[0]);
        const existing = ensure("jobs_cache").find((row) => row.job_id === jobId);
        const next: Row = {
          job_id: params[0],
          payload_json: params[1],
          list_state: params[2],
          sync_badge: params[3],
          server_confirmed: params[4],
          pinned: params[5],
          updated_at: params[6],
          last_accessed_at: params[7],
        };
        if (existing) {
          Object.assign(existing, next);
        } else {
          ensure("jobs_cache").push(next);
        }
        return { changes: 1, lastInsertRowId: 1 };
      }
      if (sql.startsWith("update jobs_cache set sync_badge")) {
        const row = ensure("jobs_cache").find((item) => item.job_id === params[1]);
        if (row) {
          row.sync_badge = params[0];
        }
        return { changes: row ? 1 : 0, lastInsertRowId: 1 };
      }
      if (sql.startsWith("delete from jobs_cache where job_id in")) {
        /* eviction simplified: no-op in memory tests unless overflow tested separately */
        return { changes: 0, lastInsertRowId: 1 };
      }
      return { changes: 0, lastInsertRowId: 0 };
    },
    getFirstAsync: async <T,>(source: string, params: unknown[] = []): Promise<T | null> => {
      const sql = source.replace(/\s+/g, " ").trim();
      if (sql.includes("from schema_meta")) {
        const row = ensure("schema_meta")[0];
        return row ? (clone(row) as T) : null;
      }
      if (sql.includes("count(*) as n from outbox_ops")) {
        if (sql.includes("next_attempt_at >")) {
          const n = ensure("outbox_ops").filter(
            (row) => row.state === "pending" && String(row.next_attempt_at) > String(params[0]),
          ).length;
          return { n } as T;
        }
        const states = sql.includes("pending")
          ? ["pending", "in_flight", "paused_conflict", "failed"]
          : sql.includes("in_flight")
            ? ["in_flight"]
            : null;
        const n = ensure("outbox_ops").filter((row) => (states ? states.includes(String(row.state)) : true)).length;
        if (sql.includes("resource_id")) {
          const count = ensure("outbox_ops").filter(
            (row) =>
              row.resource_id === params[0] && ["in_flight", "paused_conflict"].includes(String(row.state)),
          ).length;
          return { n: count } as T;
        }
        return { n } as T;
      }
      if (sql.includes("count(*) as n from local_drafts")) {
        const n = ensure("local_drafts").filter((row) =>
          ["dirty", "queued", "conflict", "saving"].includes(String(row.sync_state)),
        ).length;
        return { n } as T;
      }
      if (sql.includes("count(*) as n from jobs_cache")) {
        if (sql.includes("sync_badge")) {
          const n = ensure("jobs_cache").filter(
            (row) => row.sync_badge === "pending" && Number(row.server_confirmed) === 0,
          ).length;
          return { n } as T;
        }
        return { n: ensure("jobs_cache").length } as T;
      }
      if (sql.includes("from outbox_ops where resource_id") && sql.includes("limit 1")) {
        const open = ["pending", "in_flight", "paused_conflict", "failed"];
        const rows = ensure("outbox_ops").filter(
          (item) => item.resource_id === params[0] && open.includes(String(item.state)),
        );
        if (sql.includes("updated_at desc")) {
          rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
        } else {
          rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        }
        const row = rows[0];
        return row ? (clone(row) as T) : null;
      }
      if (sql.includes("from outbox_ops where operation_id")) {
        const row = ensure("outbox_ops").find((item) => item.operation_id === params[0]);
        return row ? (clone(row) as T) : null;
      }
      if (sql.includes("from local_drafts where draft_id")) {
        const row = ensure("local_drafts").find((item) => item.draft_id === params[0]);
        return row ? (clone(row) as T) : null;
      }
      if (sql.includes("from local_drafts where job_id")) {
        const rank = (row: Row) => {
          if (row.sync_state === "conflict") {
            return 0;
          }
          return row.server_version === null || row.server_version === undefined ? 2 : 1;
        };
        const rows = ensure("local_drafts")
          .filter((item) => item.job_id === params[0])
          .sort((a, b) => {
            const byRank = rank(a) - rank(b);
            if (byRank !== 0) {
              return byRank;
            }
            return String(b.local_updated_at).localeCompare(String(a.local_updated_at));
          });
        return rows[0] ? (clone(rows[0]) as T) : null;
      }
      if (sql.includes("from jobs_cache where job_id")) {
        const row = ensure("jobs_cache").find((item) => item.job_id === params[0]);
        return row ? (clone(row) as T) : null;
      }
      return null;
    },
    getAllAsync: async <T,>(source: string, params: unknown[] = []): Promise<T[]> => {
      const sql = source.replace(/\s+/g, " ").trim();
      if (sql.includes("idempotency_key from outbox_ops")) {
        return ensure("outbox_ops")
          .filter(
            (row) =>
              row.resource_id === params[0] &&
              ["pending", "in_flight", "paused_conflict", "failed"].includes(String(row.state)),
          )
          .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
          .map(
            (row) =>
              clone({
                operation_id: row.operation_id,
                state: row.state,
                idempotency_key: row.idempotency_key,
              }) as T,
          );
      }
      if (sql.includes("group by resource_id") && sql.includes("having")) {
        const counts = new Map<string, number>();
        for (const row of ensure("outbox_ops")) {
          if (["pending", "failed"].includes(String(row.state))) {
            counts.set(String(row.resource_id), (counts.get(String(row.resource_id)) ?? 0) + 1);
          }
        }
        return [...counts.entries()]
          .filter(([, n]) => n > 1)
          .map(([resource_id, n]) => clone({ resource_id, n }) as T);
      }
      if (
        sql.includes("select operation_id from outbox_ops") &&
        sql.includes("state in ('pending', 'failed')") &&
        sql.includes("order by updated_at desc")
      ) {
        return ensure("outbox_ops")
          .filter((row) => row.resource_id === params[0] && ["pending", "failed"].includes(String(row.state)))
          .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
          .map((row) => clone({ operation_id: row.operation_id }) as T);
      }
      if (sql.includes("select operation_id from outbox_ops where state = 'in_flight' and updated_at <=")) {
        return ensure("outbox_ops")
          .filter((row) => row.state === "in_flight" && String(row.updated_at) <= String(params[0]))
          .map((row) => clone({ operation_id: row.operation_id }) as T);
      }
      if (sql.includes("select operation_id from outbox_ops where state = 'in_flight'")) {
        return ensure("outbox_ops")
          .filter((row) => row.state === "in_flight")
          .map((row) => clone({ operation_id: row.operation_id }) as T);
      }
      if (sql.includes("select operation_id from outbox_ops where state = 'pending' and next_attempt_at >")) {
        return ensure("outbox_ops")
          .filter((row) => row.state === "pending" && String(row.next_attempt_at) > String(params[0]))
          .map((row) => clone({ operation_id: row.operation_id }) as T);
      }
      if (sql.includes("from outbox_ops") && sql.includes("state = 'pending'")) {
        return ensure("outbox_ops")
          .filter((row) => row.state === "pending" && String(row.next_attempt_at) <= String(params[0]))
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
          .slice(0, Number(params[1] ?? 20))
          .map((row) => clone(row) as T);
      }
      if (sql.includes("from local_drafts where job_id") && sql.includes("server_version is null")) {
        return ensure("local_drafts")
          .filter(
            (row) =>
              row.job_id === params[0] &&
              row.draft_id !== params[1] &&
              (row.server_version === null || row.server_version === undefined) &&
              row.sync_state === "dirty",
          )
          .map((row) => clone({ draft_id: row.draft_id, payload_json: row.payload_json }) as T);
      }
      if (sql.includes("from jobs_cache where list_state")) {
        return ensure("jobs_cache")
          .filter((row) => row.list_state === params[0])
          .map((row) => clone(row) as T);
      }
      return [];
    },
    closeAsync: async () => {
      /* no-op */
    },
  };
  return handle;
}
