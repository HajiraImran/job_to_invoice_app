import { addCalendarDays } from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";

export type InvoicePreviewRecord = {
  draft_id: string;
  job_id: string;
  version: number;
  preview_hash: string;
  preview_expires_at: string;
  schema_version: number;
  number_label: string;
  snapshot: {
    business: { business_name: string };
    customer: { name: string; email?: string | null };
    job: { title: string };
    payment_instructions: string;
    issue_date: string;
    due_date: string;
    lines: Array<{
      position: number;
      description: string;
      quantity: string;
      unit: string;
      net_cents: number;
      tax_cents: number;
      total_cents: number;
    }>;
    net_cents: number;
    tax_cents: number;
    total_cents: number;
    currency: string;
  };
};

export type IssuedInvoiceRecord = {
  id: string;
  job_id: string;
  number: string;
  revision_label: string;
  lifecycle: string;
  pdf_state: string;
  delivery_state: string | null;
  payment_status: string;
  due_date: string;
  snapshot: InvoicePreviewRecord["snapshot"];
  net_cents: number;
  tax_cents: number;
  total_cents: number;
};

export type InvoicePreviewKind =
  | "loading"
  | "error"
  | "offline"
  | "access_expired"
  | "empty"
  | "ready"
  | "confirming"
  | "issuing"
  | "conflict"
  | "unresolved";

export function presentInvoicePreview(input: {
  authStatus: string;
  loading: boolean;
  confirming: boolean;
  issuing: boolean;
  preview?: InvoicePreviewRecord;
  error?: { message: string; retryable: boolean; status: number; code?: string };
}): { kind: InvoicePreviewKind; showRetry: boolean; message?: string; issueDisabled: boolean } {
  const offline = input.authStatus === "offline_cached";
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", showRetry: false, issueDisabled: true };
  }
  if (input.loading && !input.preview) {
    return { kind: "loading", showRetry: false, issueDisabled: true };
  }
  if (input.error && !input.preview) {
    if (input.error.status === 404) {
      return { kind: "empty", showRetry: false, message: input.error.message, issueDisabled: true };
    }
    if (input.error.code === "UNRESOLVED_CHANGES") {
      return { kind: "unresolved", showRetry: false, message: input.error.message, issueDisabled: true };
    }
    return {
      kind: offline ? "offline" : "error",
      showRetry: input.error.retryable,
      message: input.error.message,
      issueDisabled: true,
    };
  }
  if (!input.preview) {
    return { kind: "empty", showRetry: false, issueDisabled: true };
  }
  if (input.error?.code === "PREVIEW_CHANGED" || input.error?.code === "UNRESOLVED_CHANGES") {
    return {
      kind: input.error.code === "UNRESOLVED_CHANGES" ? "unresolved" : "conflict",
      showRetry: true,
      message: input.error.message,
      issueDisabled: true,
    };
  }
  if (input.issuing) {
    return { kind: "issuing", showRetry: false, issueDisabled: true };
  }
  if (input.confirming) {
    return { kind: "confirming", showRetry: false, issueDisabled: offline };
  }
  return { kind: offline ? "offline" : "ready", showRetry: false, issueDisabled: offline };
}

export function presentInvoiceStatus(status: string): string {
  switch (status) {
    case "issued_unpaid":
      return copy.invoiceStatusUnpaid;
    case "overdue":
      return copy.invoiceStatusOverdue;
    default:
      return status;
  }
}

export function presentInvoicePdf(state: string): { label: string; canShare: boolean } {
  if (state === "ready") {
    return { label: copy.invoicePdfReady, canShare: true };
  }
  if (state === "failed") {
    return { label: copy.invoicePdfFailed, canShare: false };
  }
  return { label: copy.invoicePdfPreparing, canShare: false };
}

export function dueDateFromOption(
  issueDate: string,
  option: "receipt" | "7" | "14" | "30" | "custom",
  customDate?: string,
): string {
  if (option === "receipt") {
    return issueDate;
  }
  if (option === "custom") {
    return customDate || issueDate;
  }
  return addCalendarDays(issueDate, Number(option));
}
