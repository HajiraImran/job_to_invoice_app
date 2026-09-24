import { parseUsAddress, type UsAddress } from "./address.ts";
import { parseOwnerEmail } from "./email.ts";
import { CUSTOMER_NAME_MAX, isClientUuid } from "./job.ts";
import { parseOptionalPhone } from "./phone.ts";
import { parseBoundedText } from "./text.ts";

export const CUSTOMER_NAME_MIN = 1;
export const CUSTOMER_LIST_DEFAULT_LIMIT = 25;
export const CUSTOMER_LIST_MAX_LIMIT = 100;
export const CUSTOMER_LIST_STATES = ["active", "archived", "all"] as const;
export const CUSTOMER_PRIMARY_MIN_PT = 48;
export const CUSTOMER_TARGET_MIN_PT = 44;

export type CustomerListState = (typeof CUSTOMER_LIST_STATES)[number];

export type CustomerDuplicate = {
  id: string;
  name: string;
  archived: boolean;
};

export type CustomerWrite = {
  id: string | null;
  name: string;
  email: string | null;
  normalized_email: string | null;
  phone: string | null;
  billing_address: UsAddress | null;
  confirm_duplicate_email: boolean;
};

export type CustomerPatch = {
  name?: string;
  email?: string | null;
  normalized_email?: string | null;
  phone?: string | null;
  billing_address?: UsAddress | null;
  confirm_duplicate_email: boolean;
};

export type CustomerListQuery = {
  search: string | null;
  cursor: string | null;
  limit: number;
  state: CustomerListState;
};

type FieldError = { field: string; message: string };

const CREATE_FIELDS = new Set(["id", "name", "email", "phone", "billing_address", "confirm_duplicate_email"]);
const PATCH_FIELDS = CREATE_FIELDS;
const LIST_FIELDS = new Set(["search", "cursor", "limit", "state"]);

function messageFor(code: "required" | "too_short" | "too_long" | "invalid"): string {
  if (code === "required") return "This field is required.";
  if (code === "too_short") return "This value is too short.";
  if (code === "too_long") return "This value is too long.";
  return "Enter a valid value.";
}

function rejectUnknown(record: Record<string, unknown>, allowed: Set<string>, field_errors: FieldError[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      field_errors.push({
        field: key,
        message: key === "workspace_id" || key === "normalized_email" || key === "version" || key === "archived_at"
          ? "This field cannot be set by the client."
          : "Unknown fields are not allowed.",
      });
    }
  }
}

function parseConfirm(raw: unknown, field_errors: FieldError[]): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    field_errors.push({ field: "confirm_duplicate_email", message: "Confirm the duplicate email or leave it unset." });
    return false;
  }
  return raw;
}

function parseOptionalContactEmail(raw: unknown, field_errors: FieldError[]): { display: string | null; normalized: string | null } | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return { display: null, normalized: null };
  }
  if (typeof raw !== "string") {
    field_errors.push({ field: "email", message: "Enter a valid email." });
    return undefined;
  }
  const parsed = parseOwnerEmail(raw);
  if (!parsed.ok) {
    field_errors.push({ field: "email", message: "Enter a valid email." });
    return undefined;
  }
  return { display: parsed.display, normalized: parsed.normalized };
}

function parseBilling(raw: unknown, field_errors: FieldError[]): UsAddress | null | undefined {
  if (raw === undefined || raw === null) return null;
  const parsed = parseUsAddress(raw);
  if (!parsed.ok) {
    for (const item of parsed.field_errors) {
      field_errors.push({
        field: item.field === "address" ? "billing_address" : item.field.replace(/^address/, "billing_address"),
        message: item.message,
      });
    }
    return undefined;
  }
  return parsed.value;
}

export function parseCustomerCreate(input: unknown): { ok: true; value: CustomerWrite } | { ok: false; field_errors: FieldError[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const field_errors: FieldError[] = [];
  rejectUnknown(record, CREATE_FIELDS, field_errors);
  let id: string | null = null;
  if (record.id !== undefined && record.id !== null) {
    if (!isClientUuid(record.id)) {
      field_errors.push({ field: "id", message: "A customer UUID is required." });
    } else {
      id = record.id;
    }
  }
  const name = parseBoundedText(record.name, { min: CUSTOMER_NAME_MIN, max: CUSTOMER_NAME_MAX });
  if (!name.ok) field_errors.push({ field: "name", message: messageFor(name.code) });
  const email = parseOptionalContactEmail(record.email, field_errors);
  const phone = parseOptionalPhone(record.phone);
  if (!phone.ok) field_errors.push({ field: "phone", message: "Enter a phone number with a country code, or leave it blank." });
  const address = parseBilling(record.billing_address, field_errors);
  const confirm = parseConfirm(record.confirm_duplicate_email, field_errors);
  if (field_errors.length > 0 || !name.ok || !email || !phone.ok || address === undefined) {
    return { ok: false, field_errors };
  }
  return {
    ok: true,
    value: {
      id,
      name: name.value,
      email: email.display,
      normalized_email: email.normalized,
      phone: phone.value,
      billing_address: address,
      confirm_duplicate_email: confirm,
    },
  };
}

export function parseCustomerPatch(input: unknown): { ok: true; value: CustomerPatch } | { ok: false; field_errors: FieldError[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const field_errors: FieldError[] = [];
  rejectUnknown(record, PATCH_FIELDS, field_errors);
  const hasName = Object.prototype.hasOwnProperty.call(record, "name");
  const hasEmail = Object.prototype.hasOwnProperty.call(record, "email");
  const hasPhone = Object.prototype.hasOwnProperty.call(record, "phone");
  const hasAddress = Object.prototype.hasOwnProperty.call(record, "billing_address");
  if (!hasName && !hasEmail && !hasPhone && !hasAddress) {
    field_errors.push({ field: "body", message: "Change at least one contact field." });
  }
  const value: CustomerPatch = { confirm_duplicate_email: parseConfirm(record.confirm_duplicate_email, field_errors) };
  if (hasName) {
    const name = parseBoundedText(record.name, { min: CUSTOMER_NAME_MIN, max: CUSTOMER_NAME_MAX });
    if (!name.ok) field_errors.push({ field: "name", message: messageFor(name.code) });
    else value.name = name.value;
  }
  if (hasEmail) {
    const email = parseOptionalContactEmail(record.email, field_errors);
    if (email) {
      value.email = email.display;
      value.normalized_email = email.normalized;
    }
  }
  if (hasPhone) {
    const phone = parseOptionalPhone(record.phone);
    if (!phone.ok) field_errors.push({ field: "phone", message: "Enter a phone number with a country code, or leave it blank." });
    else value.phone = phone.value;
  }
  if (hasAddress) {
    const address = parseBilling(record.billing_address, field_errors);
    if (address !== undefined) value.billing_address = address;
  }
  if (field_errors.length > 0) return { ok: false, field_errors };
  return { ok: true, value };
}

export function parseCustomerListQuery(input: unknown): { ok: true; value: CustomerListQuery } | { ok: false; field_errors: FieldError[] } {
  if (input === undefined || input === null) {
    return {
      ok: true,
      value: { search: null, cursor: null, limit: CUSTOMER_LIST_DEFAULT_LIMIT, state: "active" },
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "query", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const field_errors: FieldError[] = [];
  rejectUnknown(record, LIST_FIELDS, field_errors);
  let search: string | null = null;
  if (record.search !== undefined && record.search !== null && record.search !== "") {
    if (typeof record.search !== "string") {
      field_errors.push({ field: "search", message: "Search must be text." });
    } else {
      const trimmed = record.search.trim();
      if (trimmed.length > CUSTOMER_NAME_MAX) {
        field_errors.push({ field: "search", message: "Search is too long." });
      } else {
        search = trimmed.length > 0 ? trimmed : null;
      }
    }
  }
  let cursor: string | null = null;
  if (record.cursor !== undefined && record.cursor !== null && record.cursor !== "") {
    if (typeof record.cursor !== "string" || record.cursor.length > 512) {
      field_errors.push({ field: "cursor", message: "Enter a valid value." });
    } else {
      cursor = record.cursor;
    }
  }
  let limit = CUSTOMER_LIST_DEFAULT_LIMIT;
  if (record.limit !== undefined && record.limit !== null && record.limit !== "") {
    const raw = typeof record.limit === "number" ? record.limit : typeof record.limit === "string" ? Number(record.limit) : Number.NaN;
    if (!Number.isInteger(raw) || raw < 1 || raw > CUSTOMER_LIST_MAX_LIMIT) {
      field_errors.push({ field: "limit", message: "Enter a page size from 1 through 100." });
    } else {
      limit = raw;
    }
  }
  let state: CustomerListState = "active";
  if (record.state !== undefined && record.state !== null && record.state !== "") {
    if (record.state !== "active" && record.state !== "archived" && record.state !== "all") {
      field_errors.push({ field: "state", message: "Choose Active, Archived, or All." });
    } else {
      state = record.state;
    }
  }
  if (field_errors.length > 0) return { ok: false, field_errors };
  return { ok: true, value: { search, cursor, limit, state } };
}

export function parseCustomerArchive(input: unknown): { ok: true; value: { archived: boolean } } | { ok: false; field_errors: FieldError[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (key !== "archived") field_errors.push({ field: key, message: "Unknown fields are not allowed." });
  }
  if (typeof record.archived !== "boolean") {
    field_errors.push({ field: "archived", message: "Choose archive or restore." });
  }
  if (field_errors.length > 0 || typeof record.archived !== "boolean") return { ok: false, field_errors };
  return { ok: true, value: { archived: record.archived } };
}
