import type { FieldError, WorkspaceSetupInput } from "@job-to-invoice/schemas";
import {
  parseTaxPercentToBp,
  parseWorkspaceSetup,
  taxBpToPercentLabel,
} from "@job-to-invoice/schemas";

export type SetupFormValues = {
  business_name: string;
  legal_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  timezone: string;
  trade: "handyman" | "other" | "";
  tax_percent: string;
  due_preset: "0" | "7" | "14" | "30" | "custom";
  custom_due_days: string;
  default_terms: string;
};

export function emptySetupForm(email: string, timezone: string): SetupFormValues {
  return {
    business_name: "",
    legal_name: "",
    contact_name: "",
    contact_email: email,
    contact_phone: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    postal_code: "",
    timezone,
    trade: "",
    tax_percent: "0",
    due_preset: "14",
    custom_due_days: "",
    default_terms: "",
  };
}

export function dueDaysFromForm(values: SetupFormValues): number | undefined {
  if (values.due_preset !== "custom") {
    return Number(values.due_preset);
  }
  if (!/^\d+$/.test(values.custom_due_days.trim())) {
    return undefined;
  }
  return Number(values.custom_due_days.trim());
}

export function setupRequestFromForm(
  values: SetupFormValues,
  flags: { timezoneConfirmed: boolean; taxZeroConfirmed: boolean; skipLogo: boolean },
): ReturnType<typeof parseWorkspaceSetup> {
  const tax = parseTaxPercentToBp(values.tax_percent);
  const due = dueDaysFromForm(values);
  const body: Record<string, unknown> = {
    business_name: values.business_name,
    legal_name: values.legal_name,
    contact_name: values.contact_name,
    contact_email: values.contact_email,
    contact_phone: values.contact_phone,
    address: {
      line1: values.line1,
      city: values.city,
      state: values.state,
      postal_code: values.postal_code,
    },
    timezone: values.timezone,
    timezone_confirmed: flags.timezoneConfirmed,
    trade: values.trade,
    default_tax_bp: tax.ok ? tax.value : values.tax_percent,
    tax_zero_confirmed: flags.taxZeroConfirmed,
    default_due_days: due,
    default_terms: values.default_terms,
    skip_logo: flags.skipLogo,
  };
  if (values.line2.trim().length > 0) {
    (body.address as Record<string, unknown>).line2 = values.line2;
  }
  return parseWorkspaceSetup(body);
}

export function firstFieldError(errors: FieldError[]): string | undefined {
  return errors[0]?.field;
}

export { taxBpToPercentLabel };
export type { WorkspaceSetupInput };
