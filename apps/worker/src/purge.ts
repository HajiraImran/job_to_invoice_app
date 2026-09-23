import type { Pool } from "pg";
import { withWorkerRole, WORKER_CLAIM_TIMEOUT_MS, WORKER_STATEMENT_TIMEOUT_MS } from "./db.ts";

export type PurgeObjectStore = {
  deleteObject: (key: string) => Promise<void>;
};

type ClaimRow = {
  id: string;
  workspace_id: string;
  owner_id: string;
  object_keys: string[] | null;
};

export async function processPurgeAccount(input: {
  pool: Pool;
  store: PurgeObjectStore;
}): Promise<"idle" | "done" | "retry" | "failed"> {
  const claimed = await withWorkerRole(
    input.pool,
    async (client) => {
      const result = await client.query<ClaimRow>("select * from commercial.claim_purge_account()");
      return result.rows[0];
    },
    { timeoutMs: WORKER_CLAIM_TIMEOUT_MS, statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS, role: "purge_app" },
  );
  if (!claimed) {
    return "idle";
  }

  try {
    for (const key of claimed.object_keys ?? []) {
      if (typeof key === "string" && key.length > 0) {
        await input.store.deleteObject(key);
      }
    }
    await withWorkerRole(
      input.pool,
      async (client) => {
        await client.query("select commercial.complete_purge_account($1::uuid)", [claimed.id]);
      },
      { role: "purge_app" },
    );
    return "done";
  } catch {
    return "retry";
  }
}
