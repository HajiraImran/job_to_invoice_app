import { parseUsAddress, type UsAddress } from "./address.ts";
import { parseOwnerEmail } from "./email.ts";
import { parseOptionalPhone } from "./phone.ts";
import { parseBoundedText, parseOptionalBoundedText } from "./text.ts";
import { isValidIanaTimeZone } from "./timezone.ts";

export const WORKSPACE_SETUP_FIELDS = [
  "business_name",
  "legal_name",
  "contact_name",
  "contact_email",
  "contact_phone",
  "address",
  "timezone",
  "timezone_confirmed",
  "trade",
  "default_tax_bp",
  "tax_zero_confirmed",
  "default_due_days",
  "default_terms",
  "skip_logo",
] as const;

export const FORBIDDEN_SETUP_FIELDS = [
  "owner_user_id",
  "workspace_id",
  "setup_completed_at",
  "currency",
  "version",
  "id",
  "created_at",
  "updated_at",
] as const;

export const TAX_BP_MIN = 0;
export const TAX_BP_MAX = 2500;
export const DUE_DAYS_MIN = 0;
export const DUE_DAYS_MAX = 365;
export const TERMS_MAX = 4000;

export type WorkspaceTrade = "handyman" | "other";

export type WorkspaceSetupInput = {
  business_name: string;
  legal_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string | null;
  address: UsAddress;
  timezone: string;
  timezone_confirmed: true;
  trade: WorkspaceTrade;
  default_tax_bp: number;
  tax_zero_confirmed: boolean;
  default_due_days: number;
  default_terms: string;
  skip_logo: true;
};

export type FieldError = { field: string; message: string };

export type WorkspaceSetupParseResult =
  | { ok: true; value: WorkspaceSetupInput }
  | { ok: false; field_errors: FieldError[] };

function messageFor(
  field: string,
  code: "required" | "too_short" | "too_long" | "invalid",
): string {
  if (code === "required") {
    return "This field is required.";
  }
  if (code === "too_short") {
    return "Enter at least the minimum number of characters.";
  }
  if (code === "too_long") {
    return "This value is too long.";
  }
  if (field === "contact_email") {
    return "Enter a valid email address.";
  }
  return "Enter a valid value.";
}

export function parseTaxBp(input: unknown): { ok: true; value: number } | { ok: false } {
  if (typeof input !== "number" || !Number.isInteger(input) || Object.is(input, -0)) {
    return { ok: false };
  }
  if (input < TAX_BP_MIN || input > TAX_BP_MAX) {
    return { ok: false };
  }
  return { ok: true, value: input };
}

export function parseTaxPercentToBp(input: string): { ok: true; value: number } | { ok: false } {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { ok: false };
  }
  const [wholeRaw, fracRaw = ""] = trimmed.split(".");
  const whole = Number(wholeRaw);
  const frac = Number((fracRaw + "00").slice(0, 2));
  const bp = whole * 100 + frac;
  return parseTaxBp(bp);
}

export function parseDueDays(input: unknown): { ok: true; value: number } | { ok: false } {
  if (typeof input !== "number" || !Number.isInteger(input)) {
    return { ok: false };
  }
  if (input < DUE_DAYS_MIN || input > DUE_DAYS_MAX) {
    return { ok: false };
  }
  return { ok: true, value: input };
}

export function parseWorkspaceSetup(input: unknown): WorkspaceSetupParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set<string>(WORKSPACE_SETUP_FIELDS);
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }

  const business = parseBoundedText(record.business_name, { min: 2, max: 100 });
  if (!business.ok) {
    field_errors.push({ field: "business_name", message: messageFor("business_name", business.code) });
  }
  const legal = parseBoundedText(record.legal_name, { min: 2, max: 150 });
  if (!legal.ok) {
    field_errors.push({ field: "legal_name", message: messageFor("legal_name", legal.code) });
  }
  const contact = parseBoundedText(record.contact_name, { min: 2, max: 100 });
  if (!contact.ok) {
    field_errors.push({ field: "contact_name", message: messageFor("contact_name", contact.code) });
  }

  const email = typeof record.contact_email === "string" ? parseOwnerEmail(record.contact_email) : { ok: false as const, code: "invalid" as const };
  if (!email.ok) {
    field_errors.push({
      field: "contact_email",
      message: email.code === "too_long" ? "This value is too long." : "Enter a valid email address.",
    });
  }

  const phone = parseOptionalPhone(record.contact_phone);
  if (!phone.ok) {
    field_errors.push({
      field: "contact_phone",
      message: "Enter a phone number with a country code, or leave it blank.",
    });
  }

  const address = parseUsAddress(record.address);
  if (!address.ok) {
    field_errors.push(...address.field_errors);
  }

  const timezone = typeof record.timezone === "string" ? record.timezone.trim() : "";
  if (!isValidIanaTimeZone(timezone)) {
    field_errors.push({ field: "timezone", message: "Select a valid timezone." });
  }
  if (record.timezone_confirmed !== true) {
    field_errors.push({ field: "timezone_confirmed", message: "Confirm the business timezone." });
  }

  const trade = record.trade;
  if (trade !== "handyman" && trade !== "other") {
    field_errors.push({ field: "trade", message: "Select a trade." });
  }

  const tax = parseTaxBp(record.default_tax_bp);
  if (!tax.ok) {
    field_errors.push({ field: "default_tax_bp", message: "Enter a tax rate between 0% and 25%." });
  } else if (tax.value === 0 && record.tax_zero_confirmed !== true) {
    field_errors.push({
      field: "tax_zero_confirmed",
      message: "Confirm tax treatment for your business",
    });
  }

  const due = parseDueDays(record.default_due_days);
  if (!due.ok) {
    field_errors.push({ field: "default_due_days", message: "Enter due days from 0 through 365." });
  }

  const terms =
    record.default_terms === undefined || record.default_terms === null || record.default_terms === ""
      ? parseOptionalBoundedText("", { min: 0, max: TERMS_MAX, multiline: true })
      : parseOptionalBoundedText(record.default_terms, { min: 0, max: TERMS_MAX, multiline: true });
  if (!terms.ok) {
    field_errors.push({ field: "default_terms", message: messageFor("default_terms", terms.code) });
  }

  if (record.skip_logo !== true) {
    field_errors.push({ field: "skip_logo", message: "Logo upload can be skipped for now." });
  }

  if (
    field_errors.length > 0 ||
    !business.ok ||
    !legal.ok ||
    !contact.ok ||
    !email.ok ||
    !phone.ok ||
    !address.ok ||
    !tax.ok ||
    !due.ok ||
    !terms.ok ||
    (trade !== "handyman" && trade !== "other")
  ) {
    return { ok: false, field_errors };
  }

  return {
    ok: true,
    value: {
      business_name: business.value,
      legal_name: legal.value,
      contact_name: contact.value,
      contact_email: email.display,
      contact_phone: phone.value,
      address: address.value,
      timezone,
      timezone_confirmed: true,
      trade,
      default_tax_bp: tax.value,
      tax_zero_confirmed: tax.value === 0 ? true : record.tax_zero_confirmed === true,
      default_due_days: due.value,
      default_terms: terms.value ?? "",
      skip_logo: true,
    },
  };
}

export function taxBpToPercentLabel(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = bp % 100;
  if (frac === 0) {
    return String(whole);
  }
  if (frac % 10 === 0) {
    return `${whole}.${frac / 10}`;
  }
  return `${whole}.${String(frac).padStart(2, "0")}`;
}
