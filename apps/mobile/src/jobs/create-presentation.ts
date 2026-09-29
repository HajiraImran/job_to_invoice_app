import {
  JOB_TITLE_MAX,
  analyticsPropertiesAreSafe,
  parseBoundedText,
  type JobMode,
} from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import type { CustomerRecord } from "../customers/presentation.ts";
import { presentCustomerList, type CustomerListKind } from "../customers/presentation.ts";
import { emptyJobForm, jobRequestFromForm, type JobFormValues } from "./form.ts";
import { createJobPath, jobDetailPath, jobInvoicePath, jobQuotePath, jobsIndexPath } from "./routes.ts";

export const CREATE_JOB_HREF = createJobPath();
export const CREATE_JOB_GUTTER = 20;
export const CREATE_JOB_HIT = 44;
export const CREATE_JOB_PRIMARY_MIN_HEIGHT = 56;
export const CREATE_JOB_PRIMARY_ACTION = "#464B71";
export const CREATE_JOB_PRIMARY_PRESSED = "#3A3E5E";
export const CREATE_JOB_BACK_VISUAL = 36;
export const CREATE_JOB_CARD_RADIUS = 16;
export const CREATE_JOB_SHEET_RADIUS = 24;
export const CREATE_JOB_SUPPORT_MAX_WIDTH = 292;
export const CREATE_JOB_HEADING_SIZE = 28;
export const CREATE_JOB_HEADING_LINE = 34;
export const CREATE_JOB_SECTION_SIZE = 17;
export const CREATE_JOB_LABEL_SIZE = 15;
export const CREATE_JOB_HINT_SIZE = 14;
export const CREATE_JOB_BADGE_FILL = "#DCEFE4";
export const CREATE_JOB_CONTACTS_PERMISSION = false;

export function presentCreateJobScreen() {
  return {
    route: CREATE_JOB_HREF,
    heading: copy.createJob,
    supportingText: copy.createJobSupport,
    billingHeading: copy.createJobBilling,
    quoteTitle: copy.modeQuote,
    quoteBadge: copy.modeQuoteBadge,
    quoteHint: copy.modeQuoteHint,
    directTitle: copy.modeDirectTitle,
    directHint: copy.modeDirectHint,
    customerLabel: copy.customerField,
    customerPlaceholder: copy.customerSelect,
    pickerTitle: copy.customerPickerTitle,
    pickerHint: copy.customerPickerHint,
    searchLabel: copy.customersSearch,
    addCustomer: copy.addNewCustomer,
    siteLabel: copy.jobSite,
    noSiteLabel: copy.noSiteAddress,
    addSiteLabel: copy.siteAddAddress,
    titleLabel: copy.jobTitle,
    titlePlaceholder: copy.jobTitlePlaceholder,
    continueLabel: copy.continueToLines,
    creatingLabel: copy.creatingJob,
    backHref: jobsIndexPath(),
    defaultMode: "quote" as const,
    defaultNoSite: true,
    settingsVisible: false,
    contactsPermission: CREATE_JOB_CONTACTS_PERMISSION,
    contactImport: false,
  };
}

export function presentCreateJobCustomerLabel(): string {
  return "Customer";
}

export function presentModeCards(selected: JobFormValues["mode"]): {
  mode: JobMode;
  title: string;
  hint: string;
  badge?: string;
  selected: boolean;
}[] {
  return [
    {
      mode: "quote",
      title: copy.modeQuote,
      hint: copy.modeQuoteHint,
      badge: copy.modeQuoteBadge,
      selected: selected === "quote",
    },
    {
      mode: "direct_invoice",
      title: copy.modeDirectTitle,
      hint: copy.modeDirectHint,
      selected: selected === "direct_invoice",
    },
  ];
}

export function presentCreateJobReady(
  values: JobFormValues,
  online: boolean,
  submitting: boolean,
): boolean {
  if (submitting) {
    return false;
  }
  const parsed = jobRequestFromForm(values, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", undefined, {
    savedCustomer: online,
  });
  return parsed.ok;
}

export function presentCreateJobNextHref(jobId: string, mode: JobMode, online: boolean): string {
  if (!online) {
    return jobDetailPath(jobId);
  }
  return mode === "direct_invoice" ? jobInvoicePath(jobId) : jobQuotePath(jobId);
}

export function presentTitleInvalid(title: string): boolean {
  return !parseBoundedText(title, { min: 1, max: JOB_TITLE_MAX }).ok;
}

export function presentCustomerSecondary(customer: Pick<CustomerRecord, "email" | "phone">): string {
  return customer.email?.trim() || customer.phone?.trim() || "";
}

export function presentActiveCustomersOnly(customers: CustomerRecord[]): CustomerRecord[] {
  return customers.filter((customer) => !customer.archived_at);
}

export function presentPickerState(input: {
  authStatus: string;
  loading: boolean;
  loadedOnce: boolean;
  customers: CustomerRecord[];
  error?: { message: string; retryable: boolean };
}): { kind: CustomerListKind; customers: CustomerRecord[]; showAdd: boolean; showRetry: boolean; message?: string } {
  return presentCustomerList({
    ...input,
    customers: presentActiveCustomersOnly(input.customers),
  });
}

export function presentCustomerRowLabel(customer: Pick<CustomerRecord, "name" | "email" | "phone">): string {
  const secondary = presentCustomerSecondary(customer);
  return secondary ? `${customer.name}, ${secondary}` : customer.name;
}

export function presentDuplicateSubmitBlocked(submitting: boolean): boolean {
  return submitting;
}

export function createJobAnalyticsPropertiesAreSafe(properties: Record<string, unknown>): boolean {
  return analyticsPropertiesAreSafe(properties);
}

export function presentDefaultCreateValues(): JobFormValues {
  const values = emptyJobForm();
  return { ...values, mode: "quote", no_site: true };
}

export function presentCreateJobPrimaryColor(): string {
  return CREATE_JOB_PRIMARY_ACTION;
}

export function presentSiteFieldValue(values: Pick<JobFormValues, "no_site" | "line1">): string {
  if (values.no_site) {
    return copy.noSiteAddress;
  }
  const line1 = values.line1.trim();
  return line1 || copy.siteAddAddress;
}
