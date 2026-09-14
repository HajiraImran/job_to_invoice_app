import { parseBoundedText, parseOptionalBoundedText } from "./text.ts";

export const US_STATES = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
] as const;

export type UsStateCode = (typeof US_STATES)[number];

const STATE_SET = new Set<string>(US_STATES);

export const ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

export type UsAddress = {
  line1: string;
  line2: string | null;
  city: string;
  state: UsStateCode;
  postal_code: string;
};

export type AddressParseResult =
  | { ok: true; value: UsAddress }
  | { ok: false; field_errors: { field: string; message: string }[] };

function fieldMessage(code: "required" | "too_short" | "too_long" | "invalid"): string {
  switch (code) {
    case "required":
      return "This field is required.";
    case "too_short":
      return "This value is too short.";
    case "too_long":
      return "This value is too long.";
    default:
      return "Enter a valid value.";
  }
}

export function isUsStateCode(value: string): value is UsStateCode {
  return STATE_SET.has(value);
}

export function parseUsAddress(input: unknown): AddressParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "address", message: "Enter a US business address." }] };
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(["line1", "line2", "city", "state", "postal_code"]);
  const field_errors: { field: string; message: string }[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }
  const line1 = parseBoundedText(record.line1, { min: 1, max: 150 });
  if (!line1.ok) {
    field_errors.push({ field: "address.line1", message: fieldMessage(line1.code) });
  }
  const line2 = parseOptionalBoundedText(record.line2, { min: 1, max: 150 });
  if (!line2.ok) {
    field_errors.push({ field: "address.line2", message: fieldMessage(line2.code) });
  }
  const city = parseBoundedText(record.city, { min: 1, max: 80 });
  if (!city.ok) {
    field_errors.push({ field: "address.city", message: fieldMessage(city.code) });
  }
  const stateRaw = typeof record.state === "string" ? record.state.trim().toUpperCase() : "";
  if (!isUsStateCode(stateRaw)) {
    field_errors.push({ field: "address.state", message: "Select a two-letter US state." });
  }
  const zipRaw = typeof record.postal_code === "string" ? record.postal_code.trim() : "";
  if (!ZIP_PATTERN.test(zipRaw)) {
    field_errors.push({ field: "address.postal_code", message: "Enter a 5-digit ZIP or ZIP+4." });
  }
  if (field_errors.length > 0 || !line1.ok || !line2.ok || !city.ok || !isUsStateCode(stateRaw)) {
    return { ok: false, field_errors };
  }
  return {
    ok: true,
    value: {
      line1: line1.value,
      line2: line2.value,
      city: city.value,
      state: stateRaw,
      postal_code: zipRaw,
    },
  };
}
