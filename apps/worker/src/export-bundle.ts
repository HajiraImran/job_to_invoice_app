import { createHash } from "node:crypto";
import { EXPORT_SCHEMA_VERSION, toCsvRow } from "@job-to-invoice/schemas";
import { buildStoredZip, type ZipEntry } from "./zip-store.ts";

export type ExportPayload = {
  schema_version?: number;
  timezone?: string;
  cutoff_at?: string;
  customers?: Array<Record<string, unknown>>;
  jobs?: Array<Record<string, unknown>>;
  documents?: Array<Record<string, unknown>>;
  ledger?: Array<Record<string, unknown>>;
  approvals?: Array<Record<string, unknown>>;
  artifacts?: Array<Record<string, unknown>>;
  images?: Array<Record<string, unknown>>;
};

function text(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function iso(value: unknown): string {
  if (!value) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function cents(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  return String(value);
}

export function buildExportReadme(input: { timezone: string; cutoffAt: string }): string {
  return [
    "Job to Invoice workspace export",
    `schema_version: ${EXPORT_SCHEMA_VERSION}`,
    `timezone: ${input.timezone}`,
    `cutoff_at: ${input.cutoffAt}`,
    "Dates are ISO-8601 instants or ISO calendar dates. Amounts use explicit *_cents columns and currency=USD.",
    "CSV cells that begin with =, +, -, @, or a control character are prefixed with a single quote.",
    "Internal staff notes, secrets, approval evidence ciphertext, and grant hashes are excluded.",
    "Accepted images were not stored in this deployment; images.csv is the path-mapping register.",
    "PDFs are included when a ready original artifact existed at cutoff. Snapshots are always included.",
    "This archive is part 001 of a numbered set. See MANIFEST.json for checksums.",
  ].join("\n");
}

export function buildExportBundle(input: {
  payload: ExportPayload;
  pdfs?: Array<{ path: string; data: Buffer; sha256: string }>;
}): { zip: Buffer; manifest: Record<string, unknown>; jobCount: number; sha256: string } {
  const timezone = text(input.payload.timezone) || "UTC";
  const cutoffAt = iso(input.payload.cutoff_at) || new Date().toISOString();
  const customers = input.payload.customers ?? [];
  const jobs = input.payload.jobs ?? [];
  const documents = input.payload.documents ?? [];
  const ledger = input.payload.ledger ?? [];
  const approvals = input.payload.approvals ?? [];
  const images = input.payload.images ?? [];
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  const entries: ZipEntry[] = [];

  function add(path: string, data: Buffer) {
    entries.push({ name: path, data });
    files.push({
      path,
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.length,
    });
  }

  add("README.txt", Buffer.from(buildExportReadme({ timezone, cutoffAt }), "utf8"));
  add("SCHEMA_VERSION", Buffer.from(String(EXPORT_SCHEMA_VERSION), "utf8"));

  const customerCsv = [
    toCsvRow(["id", "name", "email", "phone", "billing_address_json", "archived_at", "created_at"]),
    ...customers.map((row) =>
      toCsvRow([
        text(row.id),
        text(row.name),
        text(row.email),
        text(row.phone),
        text(row.billing_address_json),
        iso(row.archived_at),
        iso(row.created_at),
      ]),
    ),
  ].join("\n");
  add("customers.csv", Buffer.from(customerCsv, "utf8"));

  const jobsCsv = [
    toCsvRow([
      "id",
      "customer_id",
      "title",
      "site_address_json",
      "no_site",
      "lifecycle",
      "mode",
      "first_published_at",
      "archived_from_state",
      "related_job_id",
      "created_at",
      "updated_at",
    ]),
    ...jobs.map((row) =>
      toCsvRow([
        text(row.id),
        text(row.customer_id),
        text(row.title),
        text(row.site_address_json),
        text(row.no_site),
        text(row.lifecycle),
        text(row.mode),
        iso(row.first_published_at),
        text(row.archived_from_state),
        text(row.related_job_id),
        iso(row.created_at),
        iso(row.updated_at),
      ]),
    ),
  ].join("\n");
  add("jobs.csv", Buffer.from(jobsCsv, "utf8"));

  const documentsCsv = [
    toCsvRow([
      "id",
      "job_id",
      "kind",
      "number",
      "revision_no",
      "lifecycle",
      "issued_at",
      "issue_date",
      "due_date",
      "currency",
      "net_cents",
      "tax_cents",
      "total_cents",
      "total_usd",
      "snapshot_sha256",
      "schema_version",
      "snapshot_path",
      "pdf_path",
    ]),
    ...documents.map((row) => {
      const snapshotPath = `snapshots/${text(row.id)}.json`;
      const pdfPath = input.pdfs?.find((pdf) => pdf.path.includes(text(row.id)))?.path ?? "";
      add(snapshotPath, Buffer.from(JSON.stringify(row.snapshot_json ?? {}, null, 2), "utf8"));
      return toCsvRow([
        text(row.id),
        text(row.job_id),
        text(row.kind),
        text(row.number),
        text(row.revision_no),
        text(row.lifecycle),
        iso(row.issued_at),
        text(row.issue_date),
        text(row.due_date),
        text(row.currency) || "USD",
        cents(row.net_cents),
        cents(row.tax_cents),
        cents(row.total_cents),
        "USD",
        text(row.snapshot_sha256),
        text(row.schema_version),
        snapshotPath,
        pdfPath,
      ]);
    }),
  ].join("\n");
  add("documents.csv", Buffer.from(documentsCsv, "utf8"));

  const ledgerCsv = [
    toCsvRow([
      "id",
      "invoice_id",
      "type",
      "amount_cents",
      "currency",
      "effective_date",
      "method",
      "reference",
      "note",
      "reverses_entry_id",
      "created_at",
    ]),
    ...ledger.map((row) =>
      toCsvRow([
        text(row.id),
        text(row.invoice_id),
        text(row.type),
        cents(row.amount_cents),
        "USD",
        text(row.effective_date),
        text(row.method),
        text(row.reference),
        text(row.note),
        text(row.reverses_entry_id),
        iso(row.created_at),
      ]),
    ),
  ].join("\n");
  add("ledger.csv", Buffer.from(ledgerCsv, "utf8"));

  const approvalsCsv = [
    toCsvRow([
      "id",
      "document_id",
      "decision",
      "signer_name",
      "verified_email",
      "decided_at",
      "snapshot_sha256",
      "consent_version",
      "comment",
    ]),
    ...approvals.map((row) =>
      toCsvRow([
        text(row.id),
        text(row.document_id),
        text(row.decision),
        text(row.signer_name),
        text(row.verified_email),
        iso(row.decided_at),
        text(row.snapshot_sha256),
        text(row.consent_version),
        text(row.comment),
      ]),
    ),
  ].join("\n");
  add("approvals.csv", Buffer.from(approvalsCsv, "utf8"));

  const imagesCsv = [
    toCsvRow(["id", "document_id", "visibility", "export_path", "sha256", "bytes"]),
    ...images.map((row) =>
      toCsvRow([
        text(row.id),
        text(row.document_id),
        text(row.visibility),
        text(row.export_path),
        text(row.sha256),
        cents(row.bytes),
      ]),
    ),
  ].join("\n");
  add("images.csv", Buffer.from(imagesCsv, "utf8"));

  for (const pdf of input.pdfs ?? []) {
    add(pdf.path, pdf.data);
  }

  const manifest = {
    schema_version: EXPORT_SCHEMA_VERSION,
    timezone,
    cutoff_at: cutoffAt,
    part_count: 1,
    parts: [{ name: "export-part-001.zip", index: 1 }],
    files,
    job_count: jobs.length,
  };
  add("MANIFEST.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  const zip = buildStoredZip(entries);
  return {
    zip,
    manifest: {
      ...manifest,
      parts: [{ name: "export-part-001.zip", index: 1, sha256: createHash("sha256").update(zip).digest("hex"), bytes: zip.length }],
    },
    jobCount: jobs.length,
    sha256: createHash("sha256").update(zip).digest("hex"),
  };
}
