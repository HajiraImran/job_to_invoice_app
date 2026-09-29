import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  enterWorkerRoleOperation,
  withWorkerRole,
  workerRoleOperationIs,
  WORKER_CLAIM_TIMEOUT_MS,
  WORKER_STATEMENT_TIMEOUT_MS,
} from "./db.ts";
import { buildExportBundle, type ExportPayload } from "./export-bundle.ts";

export type ExportObjectStore = {
  putObject: (input: { key: string; body: Buffer; contentType: string }) => Promise<void>;
  getObject?: (key: string) => Promise<Buffer | undefined>;
};

type ClaimRow = {
  id: string;
  workspace_id: string;
  created_by: string;
  cutoff_at: Date | string;
  timezone: string;
  payload: ExportPayload;
};

function pdfPath(documentId: string, number: string, revision: unknown): string {
  const safeNumber = String(number).replace(/[^A-Za-z0-9._-]/g, "_");
  return `pdfs/${safeNumber}_R${String(revision ?? 1)}_${documentId.slice(0, 8)}.pdf`;
}

export async function processBuildExport(input: {
  pool: Pool;
  store: ExportObjectStore;
}): Promise<"idle" | "done" | "failed"> {
  if (!workerRoleOperationIs("export")) {
    return enterWorkerRoleOperation("export", () => processBuildExport(input));
  }
  const claimed = await withWorkerRole(
    input.pool,
    async (client) => {
      const result = await client.query<ClaimRow>("select * from commercial.claim_build_export()");
      return result.rows[0];
    },
    { timeoutMs: WORKER_CLAIM_TIMEOUT_MS, statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS },
  );
  if (!claimed) {
    return "idle";
  }

  try {
    const payload = claimed.payload;
    const documents = payload.documents ?? [];
    const artifacts = payload.artifacts ?? [];
    const pdfs: Array<{ path: string; data: Buffer; sha256: string }> = [];
    if (input.store.getObject) {
      for (const document of documents) {
        const artifact = artifacts.find(
          (row) =>
            String(row.document_id) === String(document.id) &&
            row.type === "original_pdf" &&
            row.state === "ready" &&
            typeof row.object_key === "string",
        );
        if (!artifact || typeof artifact.object_key !== "string") {
          continue;
        }
        const data = await input.store.getObject(artifact.object_key);
        if (!data) {
          continue;
        }
        pdfs.push({
          path: pdfPath(String(document.id), String(document.number ?? "DOC"), document.revision_no),
          data,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      }
    }

    const bundle = buildExportBundle({ payload, pdfs });
    const key = `${claimed.workspace_id}/exports/${claimed.id}/export-part-001.zip`;
    await input.store.putObject({
      key,
      body: bundle.zip,
      contentType: "application/zip",
    });
    await withWorkerRole(input.pool, async (client) => {
      await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
        claimed.workspace_id,
        claimed.created_by,
      ]);
      await client.query(
        "select commercial.complete_export($1::uuid, $2, $3, $4::bigint, $5::jsonb, $6::integer, $7::integer)",
        [
          claimed.id,
          key,
          bundle.sha256,
          bundle.zip.length,
          JSON.stringify(bundle.manifest),
          bundle.jobCount,
          1,
        ],
      );
    });
    return "done";
  } catch {
    await withWorkerRole(input.pool, async (client) => {
      await client.query("select commercial.fail_export($1::uuid, $2)", [claimed.id, "EXPORT_FAILED"]);
    });
    return "failed";
  }
}

export async function processPurgeExports(input: {
  pool: Pool;
  deleteObject?: (key: string) => Promise<void>;
}): Promise<"idle" | "done"> {
  if (!workerRoleOperationIs("export")) {
    return enterWorkerRoleOperation("export", () => processPurgeExports(input));
  }
  const claimed = await withWorkerRole(
    input.pool,
    async (client) => {
      const result = await client.query<{ id: string; workspace_id: string; object_key: string | null }>(
        "select * from commercial.claim_purge_exports()",
      );
      return result.rows[0];
    },
    { timeoutMs: WORKER_CLAIM_TIMEOUT_MS, statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS },
  );
  if (!claimed) {
    return "idle";
  }
  if (claimed.object_key && input.deleteObject) {
    await input.deleteObject(claimed.object_key);
  }
  await withWorkerRole(input.pool, async (client) => {
    await client.query("select commercial.complete_purge_export($1::uuid)", [claimed.id]);
  });
  return "done";
}
