import {
  CUSTOM_UNIT_LABEL_MAX,
  LINE_DESCRIPTION_MAX,
  LINE_UNITS,
  MAX_UNIT_PRICE_CENTS,
  QUANTITY_PATTERN,
  isClientUuid,
  isLineUnit,
  parseIntegerCents,
  type FieldError,
  type LineUnit,
} from "./draft.ts";
import { parseBoundedText, parseOptionalBoundedText } from "./text.ts";
import { parseTaxBp } from "./workspace-setup.ts";

export const ITEM_SEARCH_MAX = 120;
export const ITEM_LIST_DEFAULT_LIMIT = 25;
export const ITEM_LIST_MAX_LIMIT = 100;

export const ITEM_LIST_STATES = ["active", "archived", "all"] as const;
export type ItemListState = (typeof ITEM_LIST_STATES)[number];

export const CATALOGUE_SEED_DESCRIPTIONS = [
  "Labour hour",
  "Materials",
  "Small repair",
  "Installation",
  "Disposal",
] as const;

export const ITEM_CREATE_FIELDS = [
  "id",
  "description",
  "unit",
  "custom_unit_label",
  "default_quantity",
  "unit_price_cents",
  "discount_cents",
  "tax_bp",
] as const;

export const ITEM_PATCH_FIELDS = [
  "description",
  "unit",
  "custom_unit_label",
  "default_quantity",
  "unit_price_cents",
  "discount_cents",
  "tax_bp",
] as const;

export const FORBIDDEN_ITEM_FIELDS = [
  "workspace_id",
  "archived_at",
  "version",
  "created_at",
  "updated_at",
  "owner_user_id",
  "catalogue_item_id",
] as const;

export type CatalogueItemInput = {
  id: string;
  description: string;
  unit: LineUnit;
  custom_unit_label: string | null;
  default_quantity: string;
  unit_price_cents: number;
  discount_cents: number;
  tax_bp: number;
};

export type CatalogueItemPatchInput = Omit<CatalogueItemInput, "id">;

export type ItemListQuery = {
  cursor: string | null;
  limit: number;
  search: string | null;
  state: ItemListState;
};

export type CatalogueItemParseResult =
  | { ok: true; value: CatalogueItemInput }
  | { ok: false; field_errors: FieldError[] };

export type CatalogueItemPatchParseResult =
  | { ok: true; value: CatalogueItemPatchInput }
  | { ok: false; field_errors: FieldError[] };

export type ItemListQueryParseResult =
  | { ok: true; value: ItemListQuery }
  | { ok: false; field_errors: FieldError[] };

export type ItemArchiveParseResult =
  | { ok: true; value: { archived: boolean } }
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

export function isItemListState(value: string): value is ItemListState {
  return (ITEM_LIST_STATES as readonly string[]).includes(value);
}

function parseQuantity(input: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof input !== "string" || !QUANTITY_PATTERN.test(input) || input === "0" || /^0\.0+$/.test(input)) {
    return { ok: false };
  }
  return { ok: true, value: input };
}

function parseSharedFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): {
  field_errors: FieldError[];
  value?: CatalogueItemPatchInput;
} {
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }
  for (const key of FORBIDDEN_ITEM_FIELDS) {
    if (key in record) {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }

  const description = parseBoundedText(record.description, { min: 1, max: LINE_DESCRIPTION_MAX });
  if (!description.ok) {
    field_errors.push({ field: "description", message: messageFor(description.code) });
  }

  const unitRaw = typeof record.unit === "string" ? record.unit.trim() : "";
  if (!isLineUnit(unitRaw)) {
    field_errors.push({ field: "unit", message: "Choose a unit." });
  }

  let custom_unit_label: string | null = null;
  if (unitRaw === "custom") {
    const label = parseBoundedText(record.custom_unit_label, { min: 1, max: CUSTOM_UNIT_LABEL_MAX });
    if (!label.ok) {
      field_errors.push({ field: "custom_unit_label", message: messageFor(label.code) });
    } else {
      custom_unit_label = label.value;
    }
  } else if (record.custom_unit_label !== undefined && record.custom_unit_label !== null && record.custom_unit_label !== "") {
    field_errors.push({
      field: "custom_unit_label",
      message: "Custom unit label is only used with a custom unit.",
    });
  }

  const quantity = parseQuantity(record.default_quantity);
  if (!quantity.ok) {
    field_errors.push({
      field: "default_quantity",
      message: "Quantity must be greater than 0 with at most three decimal places.",
    });
  }

  const price = parseIntegerCents(record.unit_price_cents);
  if (!price.ok || price.value < 0 || price.value > MAX_UNIT_PRICE_CENTS) {
    field_errors.push({
      field: "unit_price_cents",
      message: "Unit price must be integer cents from 0 through 99999999.",
    });
  }

  const discount = parseIntegerCents(record.discount_cents);
  if (!discount.ok || discount.value < 0) {
    field_errors.push({
      field: "discount_cents",
      message: "Discount must be integer cents and cannot be negative.",
    });
  }

  const tax = parseTaxBp(record.tax_bp);
  if (!tax.ok) {
    field_errors.push({
      field: "tax_bp",
      message: "Tax rate must be 0 to 25.00 percent.",
    });
  }

  if (
    field_errors.length > 0 ||
    !description.ok ||
    !isLineUnit(unitRaw) ||
    !quantity.ok ||
    !price.ok ||
    !discount.ok ||
    !tax.ok
  ) {
    return { field_errors };
  }

  return {
    field_errors,
    value: {
      description: description.value,
      unit: unitRaw,
      custom_unit_label,
      default_quantity: quantity.value,
      unit_price_cents: price.value,
      discount_cents: discount.value,
      tax_bp: tax.value,
    },
  };
}

export function parseCatalogueItemCreate(input: unknown): CatalogueItemParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  if (!isClientUuid(record.id)) {
    const shared = parseSharedFields(record, new Set(ITEM_CREATE_FIELDS));
    return {
      ok: false,
      field_errors: [{ field: "id", message: "A client UUID is required." }, ...shared.field_errors],
    };
  }
  const shared = parseSharedFields(record, new Set(ITEM_CREATE_FIELDS));
  if (!shared.value) {
    return { ok: false, field_errors: shared.field_errors };
  }
  return { ok: true, value: { id: record.id, ...shared.value } };
}

export function parseCatalogueItemPatch(input: unknown): CatalogueItemPatchParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const shared = parseSharedFields(record, new Set(ITEM_PATCH_FIELDS));
  if (!shared.value) {
    return { ok: false, field_errors: shared.field_errors };
  }
  return { ok: true, value: shared.value };
}

export function parseItemArchive(input: unknown): ItemArchiveParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (key !== "archived") {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }
  if (typeof record.archived !== "boolean") {
    field_errors.push({ field: "archived", message: "Choose archive or restore." });
  }
  if (field_errors.length > 0 || typeof record.archived !== "boolean") {
    return { ok: false, field_errors };
  }
  return { ok: true, value: { archived: record.archived } };
}

function parseLimit(input: unknown): number | undefined {
  if (input === undefined || input === null || input === "") {
    return ITEM_LIST_DEFAULT_LIMIT;
  }
  const raw = typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  if (!Number.isInteger(raw) || raw < 1 || raw > ITEM_LIST_MAX_LIMIT) {
    return undefined;
  }
  return raw;
}

export function parseItemListQuery(input: unknown): ItemListQueryParseResult {
  if (input === undefined || input === null) {
    return {
      ok: true,
      value: { cursor: null, limit: ITEM_LIST_DEFAULT_LIMIT, search: null, state: "active" },
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "query", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(["cursor", "limit", "search", "state"]);
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }

  const cursorRaw = record.cursor;
  let cursor: string | null = null;
  if (cursorRaw !== undefined && cursorRaw !== null && cursorRaw !== "") {
    if (typeof cursorRaw !== "string" || cursorRaw.length > 512) {
      field_errors.push({ field: "cursor", message: "Enter a valid value." });
    } else {
      cursor = cursorRaw;
    }
  }

  const limit = parseLimit(record.limit);
  if (limit === undefined) {
    field_errors.push({ field: "limit", message: "Enter a page size from 1 through 100." });
  }

  const searchParsed = parseOptionalBoundedText(record.search, { min: 1, max: ITEM_SEARCH_MAX });
  if (!searchParsed.ok) {
    field_errors.push({ field: "search", message: messageFor(searchParsed.code) });
  }

  let state: ItemListState = "active";
  if (record.state !== undefined && record.state !== null && record.state !== "") {
    if (typeof record.state !== "string" || !isItemListState(record.state)) {
      field_errors.push({ field: "state", message: "Choose Active, Archived, or All." });
    } else {
      state = record.state;
    }
  }

  if (field_errors.length > 0 || limit === undefined || !searchParsed.ok) {
    return { ok: false, field_errors };
  }

  return {
    ok: true,
    value: {
      cursor,
      limit,
      search: searchParsed.value,
      state,
    },
  };
}

export function emptyCatalogueItem(id: string): CatalogueItemInput {
  return {
    id,
    description: "",
    unit: LINE_UNITS[0],
    custom_unit_label: null,
    default_quantity: "1",
    unit_price_cents: 0,
    discount_cents: 0,
    tax_bp: 0,
  };
}
