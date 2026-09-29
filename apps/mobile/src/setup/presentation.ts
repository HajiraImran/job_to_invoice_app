import {
  TERMS_MAX,
  analyticsPropertiesAreSafe,
  confirmTimeZoneSelection,
  filterTimeZones,
  formatTimeZoneOption,
  listTimeZones,
  parseDueDays,
  parseOptionalPhone,
  parseTaxPercentToBp,
  parseUsAddress,
  type AuthSnapshot,
} from "@job-to-invoice/schemas";
import { colors } from "../theme.ts";
import { copy } from "../i18n/en.ts";
import { APP_JOBS_HREF, resolveOwnerGuard } from "../session/logic.ts";
import { dueDaysFromForm, firstFieldError, setupRequestFromForm, type SetupFormValues } from "./form.ts";

export const SETUP_HREF = "/(onboarding)/setup";
export const SETUP_PRIMARY_BUTTON_MIN_HEIGHT = 56;
export const SETUP_GUTTER = 24;
export const SETUP_HIT_TARGET = 44;
export const SETUP_PROGRESS_ACCENT = colors.success;
export const SETUP_QUEUES_OFFLINE = false;

export const BASIC_INFO_INPUT_ORDER = [
  "business_name",
  "legal_name",
  "contact_name",
  "contact_phone",
  "line1",
  "line2",
  "city",
  "state",
  "postal_code",
] as const;

export const BASIC_INFO_FIELDS = new Set([
  "business_name",
  "legal_name",
  "trade",
  "contact_name",
  "contact_email",
  "contact_phone",
  "address",
  "address.line1",
  "address.line2",
  "address.city",
  "address.state",
  "address.postal_code",
]);

export const BRANDING_FIELDS = new Set(["skip_logo"]);

export function presentBasicInfoScreen() {
  return {
    route: SETUP_HREF,
    stepLabel: copy.setupStepOf.replace("{current}", "1").replace("{total}", "3"),
    section: copy.setupBasicInfo,
    percentLabel: "33%",
    progress: 0.33,
    heading: copy.setupBasicHeading,
    supportingText: copy.setupBasicSupport,
    addressSection: copy.businessAddressSection,
    emailVerifiedLabel: copy.contactEmailVerified,
    continueLabel: copy.continueToBranding,
    backLabel: copy.back,
    emailEditable: false,
    nextStep: 2 as const,
    settingsVisible: false,
    persistOnContinue: false,
  };
}

export function errorsForSetupStep(
  values: SetupFormValues,
  flags: { timezoneConfirmed: boolean; taxZeroConfirmed: boolean; skipLogo: boolean },
  step: 1 | 2 | 3,
): { field: string; message: string }[] {
  const parsed = setupRequestFromForm(values, flags);
  if (parsed.ok) {
    return [];
  }
  return parsed.field_errors.filter((item) => {
    if (step === 1) {
      return BASIC_INFO_FIELDS.has(item.field);
    }
    if (step === 2) {
      return BRANDING_FIELDS.has(item.field);
    }
    return !BASIC_INFO_FIELDS.has(item.field) && !BRANDING_FIELDS.has(item.field);
  });
}

export function presentSetupFieldErrors(
  values: SetupFormValues,
  flags: { timezoneConfirmed: boolean; taxZeroConfirmed: boolean; skipLogo: boolean },
  step: 1 | 2 | 3,
): Record<string, string> {
  return Object.fromEntries(errorsForSetupStep(values, flags, step).map((item) => [item.field, item.message]));
}

export function presentFirstInvalidField(
  values: SetupFormValues,
  flags: { timezoneConfirmed: boolean; taxZeroConfirmed: boolean; skipLogo: boolean },
  step: 1 | 2 | 3,
): string | undefined {
  return firstFieldError(errorsForSetupStep(values, flags, step));
}

export function presentBasicInfoContinueEnabled(submitting: boolean): boolean {
  return !submitting;
}

export function presentContinueLabel(step: 1 | 2 | 3, submitting: boolean): string {
  if (step === 1) {
    return copy.continueToBranding;
  }
  if (step === 2) {
    return copy.continue;
  }
  return submitting ? copy.savingSetup : copy.saveSetup;
}

export function presentSetupProgress(step: 1 | 2 | 3): { fraction: number; percentLabel: string; section: string } {
  if (step === 1) {
    return { fraction: 0.33, percentLabel: "33%", section: copy.setupBasicInfo };
  }
  if (step === 2) {
    return { fraction: 0.66, percentLabel: "66%", section: copy.skipLogo };
  }
  return { fraction: 1, percentLabel: "100%", section: copy.setupDefaultsSection };
}

export function presentNextInputName(name: string): string | undefined {
  const index = BASIC_INFO_INPUT_ORDER.indexOf(name as (typeof BASIC_INFO_INPUT_ORDER)[number]);
  if (index < 0 || index === BASIC_INFO_INPUT_ORDER.length - 1) {
    return undefined;
  }
  return BASIC_INFO_INPUT_ORDER[index + 1];
}

export function presentFieldAccessibility(label: string, required: boolean, error?: string): {
  accessibilityLabel: string;
  accessibilityHint?: string;
} {
  const status = required ? copy.setupRequired : copy.setupOptional;
  return {
    accessibilityLabel: `${label}, ${status}`,
    accessibilityHint: error,
  };
}

export function presentEmailAccessibility(label: string): {
  accessibilityLabel: string;
  accessibilityHint: string;
  editable: false;
  accessibilityState: { disabled: true };
} {
  return {
    accessibilityLabel: `${label}, ${copy.setupRequired}, ${copy.contactEmailVerified}`,
    accessibilityHint: copy.contactEmailVerified,
    editable: false,
    accessibilityState: { disabled: true },
  };
}

export function presentSavingAnnouncement(submitting: boolean): string | undefined {
  return submitting ? copy.savingSetup : undefined;
}

export function presentOfflineMutationRejected(): boolean {
  return SETUP_QUEUES_OFFLINE === false;
}

export function presentDuplicateSubmitBlocked(submitting: boolean): boolean {
  return submitting;
}

export function presentSetupRouteDecision(snapshot: AuthSnapshot) {
  return resolveOwnerGuard({
    snapshot,
    segments: ["(onboarding)", "setup"],
  });
}

export function presentAuthenticatedEmail(display: string): string {
  return display;
}

export function presentNationalPhoneRejected(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return !parseOptionalPhone(trimmed).ok;
}

export function presentAddressUsesPostalCode(values: SetupFormValues): boolean {
  const parsed = setupRequestFromForm(values, {
    timezoneConfirmed: true,
    taxZeroConfirmed: true,
    skipLogo: true,
  });
  return parsed.ok && "postal_code" in parsed.value.address && !("zip" in parsed.value.address);
}

export function presentPartialAddressInvalid(values: SetupFormValues): boolean {
  const address = parseUsAddress({
    line1: values.line1,
    city: values.city,
    state: values.state,
    postal_code: values.postal_code,
    ...(values.line2.trim() ? { line2: values.line2 } : {}),
  });
  return !address.ok;
}

export function setupAnalyticsPropertiesAreSafe(properties: Record<string, unknown>): boolean {
  return analyticsPropertiesAreSafe(properties);
}

export function presentDefaultsScreen() {
  return {
    route: SETUP_HREF,
    stepLabel: copy.setupStepOf.replace("{current}", "3").replace("{total}", "3"),
    section: copy.setupDefaultsSection,
    percentLabel: "100%",
    progress: 1,
    heading: copy.setupDefaultsHeading,
    supportingText: copy.setupDefaultsSupport,
    continueLabel: copy.saveSetup,
    backLabel: copy.back,
    backStep: 2 as const,
    currencyLabel: copy.currencyLabel,
    currencyValue: copy.currencyValue,
    currencyHint: copy.currencyLockedHint,
    currencyEditable: false,
    termsMax: TERMS_MAX,
    settingsVisible: false,
    persistOnSave: true,
    successHref: APP_JOBS_HREF,
    queuesOffline: false,
  };
}

export function presentDuePresetLabel(preset: SetupFormValues["due_preset"]): string {
  if (preset === "0") {
    return copy.dueOnReceiptChip;
  }
  if (preset === "custom") {
    return copy.dueCustom;
  }
  return preset;
}

export function presentTimezoneFieldValue(timeZone: string, at: Date = new Date()): string {
  return formatTimeZoneOption(timeZone, at);
}

export function presentTimezonePickerRows(
  committed: string,
  query: string,
  device: string | undefined,
  at: Date = new Date(),
): { id: string; label: string; selected: boolean }[] {
  const zones = listTimeZones([committed, device ?? ""]);
  return filterTimeZones(zones, query, at).map((id) => ({
    id,
    label: formatTimeZoneOption(id, at),
    selected: id === committed,
  }));
}

export function presentConfirmedTimezone(provisional: string | undefined, committed: string): string {
  return confirmTimeZoneSelection(provisional, committed);
}

export function presentTaxRateInvalid(value: string): boolean {
  return !parseTaxPercentToBp(value).ok;
}

export function presentTaxConfirmationRequired(taxPercent: string, confirmed: boolean): boolean {
  const parsed = parseTaxPercentToBp(taxPercent);
  return parsed.ok && parsed.value === 0 && confirmed !== true;
}

export function presentCustomDueInvalid(values: SetupFormValues): boolean {
  if (values.due_preset !== "custom") {
    return false;
  }
  const due = dueDaysFromForm(values);
  if (due === undefined) {
    return true;
  }
  return !parseDueDays(due).ok;
}

export function presentTermsOverLimit(value: string): boolean {
  return value.length > TERMS_MAX;
}
