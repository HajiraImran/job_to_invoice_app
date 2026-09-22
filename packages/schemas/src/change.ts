import { parseBoundedText } from "./text.ts";
import {
  DRAFT_EXPIRY_DAYS_DEFAULT,
  parseDraftPayload,
  parseIntegerCents,
  type DraftLineInput,
} from "./draft.ts";
import { isClientUuid } from "./job.ts";

export const CHANGE_REASON_MIN = 5;
export const CHANGE_REASON_MAX = 500;

export type ChangeReductionInput = {
  source_line_id: string;
  net_credit_cents: number;
};

export type ChangeDraftInput = {
  reason: string;
  expected_scope_version: number;
  expiry_days: number;
  additions: DraftLineInput[];
  reductions: ChangeReductionInput[];
};

export type ChangeDraftParseResult =
  | { ok: true; value: ChangeDraftInput }
  | { ok: false; field_errors: { field: string; message: string }[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function emptyChangeDraft(expectedScopeVersion = 1): ChangeDraftInput {
  return {
    reason: "",
    expected_scope_version: expectedScopeVersion,
    expiry_days: DRAFT_EXPIRY_DAYS_DEFAULT,
    additions: [],
    reductions: [],
  };
}

export function parseChangeDraft(input: unknown): ChangeDraftParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(["reason", "expected_scope_version", "expiry_days", "additions", "reductions"]);
  const field_errors: { field: string; message: string }[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }

  let reason = "";
  if (record.reason !== undefined && record.reason !== null && record.reason !== "") {
    const parsed = parseBoundedText(record.reason, { min: CHANGE_REASON_MIN, max: CHANGE_REASON_MAX });
    if (!parsed.ok) {
      field_errors.push({ field: "reason", message: "Reason must be 5 to 500 characters." });
    } else {
      reason = parsed.value;
    }
  }

  const scope = parseIntegerCents(record.expected_scope_version ?? 1);
  if (!scope.ok || scope.value < 1) {
    field_errors.push({ field: "expected_scope_version", message: "Expected scope version is required." });
  }

  let expiry_days = DRAFT_EXPIRY_DAYS_DEFAULT;
  if (record.expiry_days !== undefined) {
    const days = parseIntegerCents(record.expiry_days);
    if (!days.ok || days.value < 1 || days.value > 90) {
      field_errors.push({ field: "expiry_days", message: "Expiry must be 1 to 90 days." });
    } else {
      expiry_days = days.value;
    }
  }

  const additionsRaw = record.additions === undefined ? [] : record.additions;
  if (!Array.isArray(additionsRaw)) {
    field_errors.push({ field: "additions", message: "Additions must be an array." });
  }
  const reductionsRaw = record.reductions === undefined ? [] : record.reductions;
  if (!Array.isArray(reductionsRaw)) {
    field_errors.push({ field: "reductions", message: "Reductions must be an array." });
  }

  let additions: DraftLineInput[] = [];
  if (Array.isArray(additionsRaw) && additionsRaw.length > 0) {
    const parsed = parseDraftPayload({
      notes: "",
      terms: "",
      expiry_days,
      lines: additionsRaw,
    });
    if (!parsed.ok) {
      field_errors.push(
        ...parsed.field_errors.map((error) => ({
          field: error.field.replace(/^lines/, "additions"),
          message: error.message,
        })),
      );
    } else {
      additions = parsed.value.lines;
    }
  }

  const reductions: ChangeReductionInput[] = [];
  if (Array.isArray(reductionsRaw)) {
    for (const [index, item] of reductionsRaw.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        field_errors.push({ field: `reductions.${index}`, message: "Enter a valid reduction." });
        continue;
      }
      const row = item as Record<string, unknown>;
      for (const key of Object.keys(row)) {
        if (key !== "source_line_id" && key !== "net_credit_cents") {
          field_errors.push({ field: `reductions.${index}.${key}`, message: "Unknown fields are not allowed." });
        }
      }
      if (typeof row.source_line_id !== "string" || !UUID.test(row.source_line_id) || !isClientUuid(row.source_line_id)) {
        field_errors.push({ field: `reductions.${index}.source_line_id`, message: "A source line UUID is required." });
      }
      const cents = parseIntegerCents(row.net_credit_cents);
      if (!cents.ok || cents.value < 1) {
        field_errors.push({
          field: `reductions.${index}.net_credit_cents`,
          message: "Reduction must be a positive integer-cent amount.",
        });
      } else if (typeof row.source_line_id === "string" && isClientUuid(row.source_line_id)) {
        reductions.push({ source_line_id: row.source_line_id, net_credit_cents: cents.value });
      }
    }
  }

  if ((additions.length > 0 || reductions.length > 0) && reason.length < CHANGE_REASON_MIN) {
    field_errors.push({ field: "reason", message: "Reason must be 5 to 500 characters." });
  }

  if (field_errors.length > 0 || !scope.ok) {
    return { ok: false, field_errors };
  }
  return {
    ok: true,
    value: {
      reason,
      expected_scope_version: scope.value,
      expiry_days,
      additions,
      reductions,
    },
  };
}
