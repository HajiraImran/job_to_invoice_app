import { TERMS_MAX } from "./workspace-setup.ts";
import { parseOptionalBoundedText } from "./text.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

export type FieldError = { field: string; message: string };

export type InvoicePreviewInput = {
  due_date?: string;
  payment_instructions?: string;
};

export type InvoicePreviewParseResult =
  | { ok: true; value: InvoicePreviewInput }
  | { ok: false; field_errors: FieldError[] };

export type InvoiceIssueInput = {
  preview_hash: string;
};

export type InvoiceIssueParseResult =
  | { ok: true; value: InvoiceIssueInput }
  | { ok: false; field_errors: FieldError[] };

function isCalendarDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const utc = Date.UTC(year, month - 1, day);
  const reconstructed = new Date(utc);
  return (
    reconstructed.getUTCFullYear() === year &&
    reconstructed.getUTCMonth() + 1 === month &&
    reconstructed.getUTCDate() === day
  );
}

export function parseInvoicePreview(input: unknown): InvoicePreviewParseResult {
  if (input === undefined || input === null || input === "") {
    return { ok: true, value: {} };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (key !== "due_date" && key !== "payment_instructions") {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }
  let due_date: string | undefined;
  if (record.due_date !== undefined && record.due_date !== null && record.due_date !== "") {
    if (typeof record.due_date !== "string" || !isCalendarDate(record.due_date)) {
      field_errors.push({ field: "due_date", message: "Enter a due date as YYYY-MM-DD." });
    } else {
      due_date = record.due_date;
    }
  }
  let payment_instructions: string | undefined;
  if (record.payment_instructions !== undefined && record.payment_instructions !== null) {
    const parsed = parseOptionalBoundedText(record.payment_instructions, {
      min: 0,
      max: TERMS_MAX,
      multiline: true,
    });
    if (!parsed.ok) {
      field_errors.push({ field: "payment_instructions", message: "Payment instructions are too long." });
    } else if (parsed.value) {
      payment_instructions = parsed.value;
    }
  }
  if (field_errors.length > 0) {
    return { ok: false, field_errors };
  }
  return {
    ok: true,
    value: {
      ...(due_date ? { due_date } : {}),
      ...(payment_instructions ? { payment_instructions } : {}),
    },
  };
}

export function parseInvoiceIssue(input: unknown): InvoiceIssueParseResult {
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
