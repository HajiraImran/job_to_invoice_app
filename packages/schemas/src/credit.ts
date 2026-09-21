import { parseIntegerCents } from "./draft.ts";
import { parseBoundedText } from "./text.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CREDIT_REASON_MIN = 5;
export const CREDIT_REASON_MAX = 500;

export type FieldError = { field: string; message: string };
export type CreditAllocationInput = { invoice_line_id: string; net_credit_cents: number };
export type CreditPreviewInput = {
  reason: string;
  allocations: CreditAllocationInput[];
};
export type CreditIssueInput = { preview_hash: string };
export type CreditParseResult<T> = { ok: true; value: T } | { ok: false; field_errors: FieldError[] };

export function parseCreditPreview(input: unknown): CreditParseResult<CreditPreviewInput> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (key !== "reason" && key !== "allocations") {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }
  const reason = parseBoundedText(record.reason, { min: CREDIT_REASON_MIN, max: CREDIT_REASON_MAX, multiline: true });
  if (!reason.ok) {
    field_errors.push({ field: "reason", message: "Enter a reason between 5 and 500 characters." });
  }
  if (!Array.isArray(record.allocations) || record.allocations.length < 1) {
    field_errors.push({ field: "allocations", message: "Select at least one invoice line to credit." });
    return { ok: false, field_errors };
  }
  const allocations: CreditAllocationInput[] = [];
  const seen = new Set<string>();
  for (const [index, item] of record.allocations.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      field_errors.push({ field: `allocations.${index}`, message: "Each allocation must be an object." });
      continue;
    }
    const row = item as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (key !== "invoice_line_id" && key !== "net_credit_cents") {
        field_errors.push({ field: `allocations.${index}.${key}`, message: "Unknown fields are not allowed." });
      }
    }
    if (typeof row.invoice_line_id !== "string" || !UUID.test(row.invoice_line_id)) {
      field_errors.push({ field: `allocations.${index}.invoice_line_id`, message: "An invoice line UUID is required." });
    } else if (seen.has(row.invoice_line_id)) {
      field_errors.push({ field: `allocations.${index}.invoice_line_id`, message: "Each invoice line may be credited once." });
    } else {
      seen.add(row.invoice_line_id);
    }
    const amount = parseIntegerCents(row.net_credit_cents);
    if (!amount.ok || amount.value < 1) {
      field_errors.push({
        field: `allocations.${index}.net_credit_cents`,
        message: "Enter a positive amount in integer cents.",
      });
    } else if (typeof row.invoice_line_id === "string" && UUID.test(row.invoice_line_id) && !field_errors.some((error) => error.field.endsWith("invoice_line_id") && error.field.includes(String(index)))) {
      allocations.push({ invoice_line_id: row.invoice_line_id, net_credit_cents: amount.value });
    }
  }
  if (field_errors.length > 0 || !reason.ok) {
    return { ok: false, field_errors };
  }
  return { ok: true, value: { reason: reason.value, allocations } };
}

export function parseCreditIssue(input: unknown): CreditParseResult<CreditIssueInput> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (key !== "preview_hash") {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }
  if (typeof record.preview_hash !== "string" || !SHA256_HEX.test(record.preview_hash)) {
    field_errors.push({ field: "preview_hash", message: "A 64-character preview hash is required." });
  }
  if (field_errors.length > 0 || typeof record.preview_hash !== "string") {
    return { ok: false, field_errors };
  }
  return { ok: true, value: { preview_hash: record.preview_hash } };
}
