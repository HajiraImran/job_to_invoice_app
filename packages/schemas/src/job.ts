import { parseUsAddress, type UsAddress } from "./address.ts";
import { parseBoundedText, parseOptionalBoundedText } from "./text.ts";

export const JOB_TITLE_MAX = 120;
export const CUSTOMER_NAME_MAX = 120;
export const INTERNAL_NOTES_MAX = 4000;
export const JOB_SEARCH_MAX = 120;
export const JOB_LIST_DEFAULT_LIMIT = 25;
export const JOB_LIST_MAX_LIMIT = 100;

export const JOB_LIFECYCLES = [
  "draft",
  "active",
  "invoiced",
  "finished",
  "canceled",
  "archived",
] as const;

export type JobLifecycle = (typeof JOB_LIFECYCLES)[number];

export const JOB_MODES = ["quote", "direct_invoice"] as const;

export type JobMode = (typeof JOB_MODES)[number];

export const JOB_LIST_STATES = ["open", "finished", "archived"] as const;

export type JobListState = (typeof JOB_LIST_STATES)[number];

export const JOB_CREATE_FIELDS = [
  "id",
  "customer_id",
  "customer_name",
  "title",
  "no_site",
  "site_address",
  "internal_notes",
  "mode",
  "related_job_id",
] as const;

export const FORBIDDEN_JOB_FIELDS = [
  "workspace_id",
  "lifecycle",
  "version",
  "created_at",
  "updated_at",
  "completion_right",
  "current_quote_id",
  "active_invoice_id",
  "scope_version",
  "entitlement_origin",
  "first_published_at",
  "archived_from_state",
  "owner_user_id",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FieldError = { field: string; message: string };

export type JobCreateInput = {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  title: string;
  no_site: boolean;
  site_address: UsAddress | null;
  internal_notes: string;
  mode: JobMode;
  related_job_id: string | null;
};

export type JobCreateParseResult =
  | { ok: true; value: JobCreateInput }
  | { ok: false; field_errors: FieldError[] };

export type JobListScope = JobListState | "all";

export type JobListQuery = {
  cursor: string | null;
  limit: number;
  search: string | null;
  state: JobListScope;
  customer_id: string | null;
};

export type JobListQueryParseResult =
  | { ok: true; value: JobListQuery }
  | { ok: false; field_errors: FieldError[] };

export type JobArchiveInput = { archived: boolean };

export type JobArchiveParseResult =
  | { ok: true; value: JobArchiveInput }
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

export function isJobLifecycle(value: string): value is JobLifecycle {
  return (JOB_LIFECYCLES as readonly string[]).includes(value);
}

export function isJobMode(value: string): value is JobMode {
  return (JOB_MODES as readonly string[]).includes(value);
}

export function isJobListState(value: string): value is JobListState {
  return (JOB_LIST_STATES as readonly string[]).includes(value);
}

export function isClientUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function parseJobCreate(input: unknown): JobCreateParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set<string>(JOB_CREATE_FIELDS);
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }

  if (!isClientUuid(record.id)) {
    field_errors.push({ field: "id", message: "A client UUID is required." });
  }

  const hasCustomerId = record.customer_id !== undefined && record.customer_id !== null;
  const hasCustomerName = record.customer_name !== undefined && record.customer_name !== null;
  let customerId: string | null = null;
  let customerName: string | null = null;
  if (hasCustomerId && hasCustomerName) {
    field_errors.push({ field: "customer_id", message: "Choose a saved customer or a customer name." });
  } else if (hasCustomerId) {
    if (!isClientUuid(record.customer_id)) {
      field_errors.push({ field: "customer_id", message: "A customer UUID is required." });
    } else {
      customerId = record.customer_id;
    }
  } else if (hasCustomerName) {
    const customer = parseBoundedText(record.customer_name, { min: 1, max: CUSTOMER_NAME_MAX });
    if (!customer.ok) {
      field_errors.push({ field: "customer_name", message: messageFor(customer.code) });
    } else {
      customerName = customer.value;
    }
  } else {
    field_errors.push({ field: "customer_id", message: "Choose a customer." });
  }

  const title = parseBoundedText(record.title, { min: 1, max: JOB_TITLE_MAX });
  if (!title.ok) {
    field_errors.push({ field: "title", message: messageFor(title.code) });
  }

  if (typeof record.no_site !== "boolean") {
    field_errors.push({ field: "no_site", message: "Choose a site address or No site address." });
  }

  const notes = parseOptionalBoundedText(record.internal_notes, {
    min: 0,
    max: INTERNAL_NOTES_MAX,
    multiline: true,
  });
  if (!notes.ok) {
    field_errors.push({ field: "internal_notes", message: messageFor(notes.code) });
  }

  const modeRaw = typeof record.mode === "string" ? record.mode.trim() : "";
  if (!isJobMode(modeRaw)) {
    field_errors.push({ field: "mode", message: "Choose Quote or Direct invoice." });
  }

  let relatedJobId: string | null = null;
  if (record.related_job_id !== undefined && record.related_job_id !== null && record.related_job_id !== "") {
    if (!isClientUuid(record.related_job_id)) {
      field_errors.push({ field: "related_job_id", message: "A job UUID is required." });
    } else {
      relatedJobId = record.related_job_id;
    }
  }

  let site: UsAddress | null = null;
  if (record.no_site === true) {
    if (record.site_address !== undefined && record.site_address !== null) {
      field_errors.push({
        field: "site_address",
        message: "Clear the site address or uncheck No site address.",
      });
    }
  } else if (record.no_site === false) {
    const parsedSite = parseUsAddress(record.site_address);
    if (!parsedSite.ok) {
      field_errors.push(
        ...parsedSite.field_errors.map((item) => ({
          field: item.field === "address" ? "site_address" : item.field.replace(/^address/, "site_address"),
          message: item.message,
        })),
      );
    } else {
      site = parsedSite.value;
    }
  }

  if (
    field_errors.length > 0 ||
    !isClientUuid(record.id) ||
    (customerId === null && customerName === null) ||
    !title.ok ||
    typeof record.no_site !== "boolean" ||
    !notes.ok ||
    !isJobMode(modeRaw)
  ) {
    return { ok: false, field_errors };
  }

  return {
    ok: true,
    value: {
      id: record.id,
      customer_id: customerId,
      customer_name: customerName,
      title: title.value,
      no_site: record.no_site,
      site_address: record.no_site ? null : site,
      internal_notes: notes.value ?? "",
      mode: modeRaw,
      related_job_id: relatedJobId,
    },
  };
}

function parseLimit(input: unknown): number | undefined {
  if (input === undefined || input === null || input === "") {
    return JOB_LIST_DEFAULT_LIMIT;
  }
  const raw = typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  if (!Number.isInteger(raw) || raw < 1 || raw > JOB_LIST_MAX_LIMIT) {
    return undefined;
  }
  return raw;
}

export function parseJobListQuery(input: unknown): JobListQueryParseResult {
  if (input === undefined || input === null) {
    return {
      ok: true,
      value: { cursor: null, limit: JOB_LIST_DEFAULT_LIMIT, search: null, state: "open", customer_id: null },
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "query", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(["cursor", "limit", "search", "state", "customer_id"]);
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

  const searchParsed = parseOptionalBoundedText(record.search, { min: 1, max: JOB_SEARCH_MAX });
  if (!searchParsed.ok) {
    field_errors.push({ field: "search", message: messageFor(searchParsed.code) });
  }

  let customerId: string | null = null;
  if (record.customer_id !== undefined && record.customer_id !== null && record.customer_id !== "") {
    if (!isClientUuid(record.customer_id)) {
      field_errors.push({ field: "customer_id", message: "A customer UUID is required." });
    } else {
      customerId = record.customer_id;
    }
  }

  const stateProvided = record.state !== undefined && record.state !== null && record.state !== "";
  let state: JobListScope = customerId && !stateProvided ? "all" : "open";
  if (stateProvided) {
    if (typeof record.state !== "string" || !isJobListState(record.state)) {
      field_errors.push({ field: "state", message: "Choose Active, Finished, or Archived." });
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
      customer_id: customerId,
    },
  };
}

export function analyticsModeForJob(mode: JobMode): "quote" | "direct" {
  return mode === "direct_invoice" ? "direct" : "quote";
}

export function parseJobArchive(input: unknown): JobArchiveParseResult {
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
