import { createHash } from "node:crypto";
import {
  originalPdfObjectKey,
  renderQuoteOriginalHtml,
  type QuotePdfDocument,
  type QuoteSnapshotV1,
} from "@job-to-invoice/domain";
import type { Pool } from "pg";
import { withWorkerRole } from "./db.ts";
import type { DocumentsObjectStore } from "./r2.ts";

export type PdfRenderer = (document: QuotePdfDocument) => Promise<Buffer>;

export class PermanentPdfError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PermanentPdfError";
    this.code = code;
  }
}

type ClaimRow = {
  id: string;
  workspace_id: string;
  aggregate_id: string;
  payload_json: unknown;
  attempts: number;
  created_by: string;
  number: string;
  revision_no: number;
};

type SourceRow = {
  workspace_id: string;
  document_id: string;
  created_by: string;
  number: string;
  revision_no: number;
  snapshot_json: QuoteSnapshotV1;
  net_cents: string | number;
  tax_cents: string | number;
  total_cents: string | number;
  lines_json: unknown;
};

function asCents(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new PermanentPdfError("VALIDATION_FAILED", "Issued cents must be integers");
  }
  return parsed;
}

function asDocument(row: SourceRow): QuotePdfDocument {
  const snapshot = row.snapshot_json;
  if (!snapshot || snapshot.kind !== "quote") {
    throw new PermanentPdfError("VALIDATION_FAILED", "PDF source must be a published quote");
  }
  const lines = Array.isArray(row.lines_json) ? row.lines_json : [];
  if (lines.length < 1) {
    throw new PermanentPdfError("VALIDATION_FAILED", "PDF source must include line items");
  }
  return {
    number: row.number,
    revision_no: row.revision_no,
    snapshot,
    lines: lines.map((line) => {
      const record = line as Record<string, unknown>;
      return {
        position: Number(record.position),
        description: String(record.description ?? ""),
        quantity: record.quantity == null ? null : String(record.quantity),
        unit: record.unit == null ? null : String(record.unit),
        custom_unit_label:
          snapshot.lines?.find((item) => item.position === Number(record.position))?.custom_unit_label ?? null,
        unit_price_cents: record.unit_price_cents == null ? null : Number(record.unit_price_cents),
        discount_cents: Number(record.discount_cents),
        net_cents: Number(record.net_cents),
        tax_bp: Number(record.tax_bp),
        tax_cents: Number(record.tax_cents),
        total_cents: Number(record.total_cents),
      };
    }),
    net_cents: asCents(row.net_cents),
    tax_cents: asCents(row.tax_cents),
    total_cents: asCents(row.total_cents),
  };
}

export async function processGenerateOriginalPdf(input: {
  pool: Pool;
  store: DocumentsObjectStore;
  render: PdfRenderer;
}): Promise<"idle" | "done" | "retry" | "dead"> {
  const claimed = await withWorkerRole(input.pool, async (client) => {
    const result = await client.query<ClaimRow>("select * from commercial.claim_generate_original_pdf()");
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
      row.workspace_id,
      row.created_by,
    ]);
    return row;
  });
  if (!claimed) {
    return "idle";
  }

  try {
    const source = await withWorkerRole(input.pool, async (client) => {
      await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
        claimed.workspace_id,
        claimed.created_by,
      ]);
      const loaded = await client.query<SourceRow>("select * from commercial.load_original_pdf_source($1::uuid)", [
        claimed.id,
      ]);
      const reserved = await client.query<{ reserve_original_pdf_artifact: string }>(
        "select commercial.reserve_original_pdf_artifact($1::uuid)",
        [claimed.id],
      );
      return { row: loaded.rows[0], artifactId: reserved.rows[0]?.reserve_original_pdf_artifact };
    });
    if (!source.row || !source.artifactId) {
      throw new PermanentPdfError("VALIDATION_FAILED", "Published quote was not found");
    }
    const document = asDocument(source.row);
    renderQuoteOriginalHtml(document);
    const key = originalPdfObjectKey({
      workspaceId: source.row.workspace_id,
      documentId: source.row.document_id,
      revision: source.row.revision_no,
      artifactId: source.artifactId,
    });
    await withWorkerRole(input.pool, async (client) => {
      await client.query("select commercial.heartbeat_outbox_task($1::uuid)", [claimed.id]);
    });
    const bytes = await input.render(document);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await input.store.putObject({ key, body: bytes, contentType: "application/pdf" });
    await withWorkerRole(input.pool, async (client) => {
      await client.query(
        "select commercial.complete_original_pdf($1::uuid, $2::uuid, $3, $4, $5::bigint)",
        [claimed.id, source.artifactId, key, sha256, bytes.byteLength],
      );
    });
    return "done";
  } catch (error) {
    const permanent =
      error instanceof PermanentPdfError ||
      (error instanceof Error &&
        /at least one line|must match the issued snapshot|must be a published quote/.test(error.message));
    const code =
      error instanceof PermanentPdfError ? error.code : permanent ? "VALIDATION_FAILED" : "PDF_RENDER_FAILED";
    const status = await withWorkerRole(input.pool, async (client) => {
      const failed = await client.query<{ fail_original_pdf: string }>(
        "select commercial.fail_original_pdf($1::uuid, $2, $3::boolean)",
        [claimed.id, code, permanent],
      );
      return failed.rows[0]?.fail_original_pdf ?? "pending";
    });
    return status === "dead" ? "dead" : "retry";
  }
}
