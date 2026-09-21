import { parseIntegerCents } from "./draft.ts";
import { parseOptionalBoundedText } from "./text.ts";

const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
export const LEDGER_METHODS = ["cash", "check", "bank_transfer", "external_card", "other"] as const;
export const LEDGER_REFERENCE_MAX = 100;
export const LEDGER_NOTE_MAX = 500;

export type LedgerMethod = (typeof LEDGER_METHODS)[number];
export type FieldError = { field: string; message: string };

export type LedgerPaymentInput = {
  amount_cents: number;
  effective_date: string;
  method: LedgerMethod;
  reference?: string;
  note?: string;
  confirm_overpayment: boolean;
};

export type LedgerRefundInput = {
  amount_cents: number;
  effective_date: string;
  method: LedgerMethod;
  reference?: string;
  note?: string;
};

export type LedgerParseResult<T> = { ok: true; value: T } | { ok: false; field_errors: FieldError[] };

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

function isLedgerMethod(value: unknown): value is LedgerMethod {
  return typeof value === "string" && (LEDGER_METHODS as readonly string[]).includes(value);
}

function parseSharedFields(
  record: Record<string, unknown>,
  allowed: Set<string>,
): { field_errors: FieldError[]; amount_cents?: number; effective_date?: string; method?: LedgerMethod; reference?: string; note?: string } {
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }
  const amount = parseIntegerCents(record.amount_cents);
  if (!amount.ok || amount.value < 1) {
    field_errors.push({ field: "amount_cents", message: "Enter a positive amount in integer cents." });
  }
  let effective_date: string | undefined;
  if (typeof record.effective_date !== "string" || !isCalendarDate(record.effective_date)) {
    field_errors.push({ field: "effective_date", message: "Enter a received date as YYYY-MM-DD." });
  } else {
    effective_date = record.effective_date;
  }
  let method: LedgerMethod | undefined;
  if (!isLedgerMethod(record.method)) {
    field_errors.push({ field: "method", message: "Choose a payment method." });
  } else {
    method = record.method;
  }
  let reference: string | undefined;
  if (record.reference !== undefined && record.reference !== null && record.reference !== "") {
    const parsed = parseOptionalBoundedText(record.reference, { min: 1, max: LEDGER_REFERENCE_MAX });
    if (!parsed.ok || !parsed.value) {
      field_errors.push({ field: "reference", message: "Reference must be 1 to 100 characters." });
    } else {
      reference = parsed.value;
    }
  }
  let note: string | undefined;
  if (record.note !== undefined && record.note !== null && record.note !== "") {
    const parsed = parseOptionalBoundedText(record.note, { min: 1, max: LEDGER_NOTE_MAX, multiline: true });
    if (!parsed.ok || !parsed.value) {
      field_errors.push({ field: "note", message: "Note must be 1 to 500 characters." });
    } else {
      note = parsed.value;
    }
  }
  return {
    field_errors,
    amount_cents: amount.ok && amount.value >= 1 ? amount.value : undefined,
    effective_date,
    method,
    reference,
    note,
  };
}

export function parseLedgerPayment(input: unknown): LedgerParseResult<LedgerPaymentInput> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const shared = parseSharedFields(
    record,
    new Set(["amount_cents", "effective_date", "method", "reference", "note", "confirm_overpayment"]),
  );
  let confirm_overpayment = false;
  if (record.confirm_overpayment !== undefined && record.confirm_overpayment !== null) {
    if (typeof record.confirm_overpayment !== "boolean") {
      shared.field_errors.push({ field: "confirm_overpayment", message: "Overpayment confirmation must be true or false." });
    } else {
      confirm_overpayment = record.confirm_overpayment;
    }
  }
  if (shared.field_errors.length > 0 || shared.amount_cents === undefined || !shared.effective_date || !shared.method) {
    return { ok: false, field_errors: shared.field_errors };
  }
  return {
    ok: true,
    value: {
      amount_cents: shared.amount_cents,
      effective_date: shared.effective_date,
      method: shared.method,
      ...(shared.reference ? { reference: shared.reference } : {}),
      ...(shared.note ? { note: shared.note } : {}),
      confirm_overpayment,
    },
  };
}

export function parseLedgerRefund(input: unknown): LedgerParseResult<LedgerRefundInput> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const shared = parseSharedFields(
    record,
    new Set(["amount_cents", "effective_date", "method", "reference", "note"]),
  );
  if (shared.field_errors.length > 0 || shared.amount_cents === undefined || !shared.effective_date || !shared.method) {
    return { ok: false, field_errors: shared.field_errors };
  }
  return {
    ok: true,
    value: {
      amount_cents: shared.amount_cents,
      effective_date: shared.effective_date,
      method: shared.method,
      ...(shared.reference ? { reference: shared.reference } : {}),
      ...(shared.note ? { note: shared.note } : {}),
    },
  };
}
