import { parseBoundedText, parseOptionalBoundedText } from "./text.ts";
import { parseTaxBp, TAX_BP_MAX, TAX_BP_MIN, TERMS_MAX } from "./workspace-setup.ts";

export const LINE_DESCRIPTION_MAX = 500;
export const CUSTOM_UNIT_LABEL_MAX = 20;
export const NOTES_MAX = 2000;
export const EXPIRY_DAYS_MIN = 1;
export const EXPIRY_DAYS_MAX = 90;
export const DRAFT_EXPIRY_DAYS_DEFAULT = 14;
export const MAX_DRAFT_LINES = 100;
export const MAX_UNIT_PRICE_CENTS = 99_999_999;
export const MAX_DOCUMENT_ABS_CENTS = 999_999_999;
export const QUANTITY_PATTERN = /^(0|[1-9]\d{0,5})(\.\d{1,3})?$/;

export const LINE_UNITS = ["item", "hour", "day", "square_foot", "linear_foot", "custom"] as const;

export type LineUnit = (typeof LINE_UNITS)[number];

export const DRAFT_PAYLOAD_FIELDS = ["notes", "terms", "expiry_days", "lines"] as const;

export const DRAFT_LINE_FIELDS = [
  "client_line_id",
  "description",
  "unit",
  "custom_unit_label",
  "quantity",
  "unit_price_cents",
  "discount_cents",
  "tax_bp",
] as const;

export const FORBIDDEN_DRAFT_FIELDS = [
  "workspace_id",
  "job_id",
  "kind",
  "draft_state",
  "version",
  "schema_version",
  "parent_document_id",
  "base_scope_version",
  "net_cents",
  "tax_cents",
  "total_cents",
  "gross_cents",
  "tax_by_rate",
  "currency",
  "id",
  "created_at",
  "updated_at",
  "payload_json",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FieldError = { field: string; message: string };

export type DraftLineInput = {
  client_line_id: string;
  description: string;
  unit: LineUnit;
  custom_unit_label: string | null;
  quantity: string;
  unit_price_cents: number;
  discount_cents: number;
  tax_bp: number;
};

export type DraftPayloadInput = {
  notes: string;
  terms: string;
  expiry_days: number;
  lines: DraftLineInput[];
};

export type DraftPayloadParseResult =
  | { ok: true; value: DraftPayloadInput }
  | { ok: false; field_errors: FieldError[] };

function messageFor(code: "required" | "too_short" | "too_long" | "invalid"): string {
  if (code === "required") {
    return "This field is required.";
  }
  if (code === "too_short") {
    return "Enter at least the minimum number of characters.";
  }
  if (code === "too_long") {
    return "This value is too long.";
  }
  return "Enter a valid value.";
}

export function isLineUnit(value: string): value is LineUnit {
  return (LINE_UNITS as readonly string[]).includes(value);
}

export function isClientUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function parseIntegerCents(input: unknown): { ok: true; value: number } | { ok: false } {
  if (typeof input !== "number" || !Number.isInteger(input) || Object.is(input, -0)) {
    return { ok: false };
  }
  return { ok: true, value: input };
}

export function dollarsStringToCents(input: string): { ok: true; value: number } | { ok: false } {
  const trimmed = input.trim();
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(trimmed)) {
    return { ok: false };
  }
  const [wholeRaw, fracRaw = ""] = trimmed.split(".");
  const whole = Number(wholeRaw);
  const frac = Number((fracRaw + "00").slice(0, 2));
  const cents = whole * 100 + frac;
  if (!Number.isInteger(cents) || cents < 0 || cents > MAX_UNIT_PRICE_CENTS) {
    return { ok: false };
  }
  return { ok: true, value: cents };
}

export function formatUsdCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error("USD amounts must be integer cents; JavaScript floats are forbidden");
  }
  const negative = cents < 0;
  const abs = negative ? -cents : cents;
  const dollars = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${negative ? "-" : ""}$${dollars}.${frac.toString().padStart(2, "0")}`;
}

function parseExpiryDays(input: unknown): { ok: true; value: number } | { ok: false } {
  if (input === undefined || input === null || input === "") {
    return { ok: true, value: DRAFT_EXPIRY_DAYS_DEFAULT };
  }
  if (typeof input !== "number" || !Number.isInteger(input)) {
    return { ok: false };
  }
  if (input < EXPIRY_DAYS_MIN || input > EXPIRY_DAYS_MAX) {
    return { ok: false };
  }
  return { ok: true, value: input };
}

function parseDraftLine(input: unknown, index: number): DraftPayloadParseResult {
  const prefix = `lines.${index}`;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: prefix, message: "Enter a valid line." }] };
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set<string>(DRAFT_LINE_FIELDS);
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      field_errors.push({ field: `${prefix}.${key}`, message: "Unknown fields are not allowed." });
    }
  }

  if (!isClientUuid(record.client_line_id)) {
    field_errors.push({ field: `${prefix}.client_line_id`, message: "A client UUID is required." });
  }

  const description = parseBoundedText(record.description, { min: 1, max: LINE_DESCRIPTION_MAX });
  if (!description.ok) {
    field_errors.push({ field: `${prefix}.description`, message: messageFor(description.code) });
  }

  const unitRaw = typeof record.unit === "string" ? record.unit.trim() : "";
  if (!isLineUnit(unitRaw)) {
    field_errors.push({ field: `${prefix}.unit`, message: "Choose a unit." });
  }

  let custom_unit_label: string | null = null;
  if (unitRaw === "custom") {
    const label = parseBoundedText(record.custom_unit_label, { min: 1, max: CUSTOM_UNIT_LABEL_MAX });
    if (!label.ok) {
      field_errors.push({ field: `${prefix}.custom_unit_label`, message: messageFor(label.code) });
    } else {
      custom_unit_label = label.value;
    }
  } else if (record.custom_unit_label !== undefined && record.custom_unit_label !== null && record.custom_unit_label !== "") {
    field_errors.push({
      field: `${prefix}.custom_unit_label`,
      message: "Custom unit label is only used with a custom unit.",
    });
  }

  if (typeof record.quantity !== "string" || !QUANTITY_PATTERN.test(record.quantity)) {
    field_errors.push({
      field: `${prefix}.quantity`,
      message: "Quantity must be greater than 0 with at most three decimal places.",
    });
  } else if (record.quantity === "0" || /^0\.0+$/.test(record.quantity)) {
    field_errors.push({
      field: `${prefix}.quantity`,
      message: "Quantity must be greater than 0 with at most three decimal places.",
    });
  }

  const price = parseIntegerCents(record.unit_price_cents);
  if (!price.ok || price.value < 0 || price.value > MAX_UNIT_PRICE_CENTS) {
    field_errors.push({
      field: `${prefix}.unit_price_cents`,
      message: "Unit price must be integer cents from 0 through 99999999.",
    });
  }

  const discount = parseIntegerCents(record.discount_cents);
  if (!discount.ok || discount.value < 0) {
    field_errors.push({
      field: `${prefix}.discount_cents`,
      message: "Discount must be integer cents and cannot be negative.",
    });
  }

  const tax = parseTaxBp(record.tax_bp);
  if (!tax.ok) {
    field_errors.push({
      field: `${prefix}.tax_bp`,
      message: "Tax rate must be 0 to 25.00 percent.",
    });
  }

  if (
    field_errors.length > 0 ||
    !isClientUuid(record.client_line_id) ||
    !description.ok ||
    !isLineUnit(unitRaw) ||
    typeof record.quantity !== "string" ||
    !price.ok ||
    !discount.ok ||
    !tax.ok
  ) {
    return { ok: false, field_errors };
  }

  return {
    ok: true,
    value: {
      notes: "",
      terms: "",
      expiry_days: DRAFT_EXPIRY_DAYS_DEFAULT,
      lines: [
        {
          client_line_id: record.client_line_id,
          description: description.value,
          unit: unitRaw,
          custom_unit_label,
          quantity: record.quantity,
          unit_price_cents: price.value,
          discount_cents: discount.value,
          tax_bp: tax.value,
        },
      ],
    },
  };
}

export function parseDraftPayload(input: unknown): DraftPayloadParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set<string>(DRAFT_PAYLOAD_FIELDS);
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_DRAFT_FIELDS.includes(key as (typeof FORBIDDEN_DRAFT_FIELDS)[number]) || !allowed.has(key)) {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }

  const notes = parseOptionalBoundedText(record.notes, { min: 0, max: NOTES_MAX, multiline: true });
  if (!notes.ok) {
    field_errors.push({ field: "notes", message: messageFor(notes.code) });
  }

  const terms = parseOptionalBoundedText(record.terms, { min: 0, max: TERMS_MAX, multiline: true });
  if (!terms.ok) {
    field_errors.push({ field: "terms", message: messageFor(terms.code) });
  }

  const expiry = parseExpiryDays(record.expiry_days);
  if (!expiry.ok) {
    field_errors.push({ field: "expiry_days", message: "Expiry must be 1 to 90 days." });
  }

  if (!Array.isArray(record.lines)) {
    field_errors.push({ field: "lines", message: "Add line items as an ordered list." });
    return { ok: false, field_errors };
  }
  if (record.lines.length > MAX_DRAFT_LINES) {
    field_errors.push({ field: "lines", message: "At most 100 lines per document." });
  }

  const lines: DraftLineInput[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of record.lines.entries()) {
    const parsed = parseDraftLine(raw, index);
    if (!parsed.ok) {
      field_errors.push(...parsed.field_errors);
      continue;
    }
    const line = parsed.value.lines[0];
    if (!line) {
      continue;
    }
    if (seen.has(line.client_line_id)) {
      field_errors.push({
        field: `lines.${index}.client_line_id`,
        message: "Each line needs a unique id.",
      });
      continue;
    }
    seen.add(line.client_line_id);
    lines.push(line);
  }

  if (field_errors.length > 0 || !notes.ok || !terms.ok || !expiry.ok) {
    return { ok: false, field_errors };
  }

  return {
    ok: true,
    value: {
      notes: notes.value ?? "",
      terms: terms.value ?? "",
      expiry_days: expiry.value,
      lines,
    },
  };
}

export { TAX_BP_MAX, TAX_BP_MIN };
