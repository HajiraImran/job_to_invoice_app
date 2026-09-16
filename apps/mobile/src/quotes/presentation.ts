import { copy } from "../i18n/en.ts";

export type QuoteEditorKind =
  | "loading"
  | "error"
  | "offline"
  | "access_expired"
  | "missing"
  | "ready"
  | "conflict";

export type QuoteSaveStatus = "idle" | "saving" | "saved" | "validation" | "offline" | "conflict" | "error";

export function presentQuoteEditor(input: {
  authStatus: string;
  loading: boolean;
  draft?: { id: string };
  error?: { message: string; retryable: boolean; status: number; code?: string };
  saveStatus: QuoteSaveStatus;
}): { kind: QuoteEditorKind; showRetry: boolean; message?: string; saveLabel: QuoteSaveStatus } {
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", showRetry: false, saveLabel: input.saveStatus };
  }
  if (input.loading && !input.draft) {
    return { kind: "loading", showRetry: false, saveLabel: input.saveStatus };
  }
  if (input.error && !input.draft) {
    if (input.error.status === 404) {
      return { kind: "missing", showRetry: false, message: input.error.message, saveLabel: input.saveStatus };
    }
    return {
      kind: input.authStatus === "offline_cached" ? "offline" : "error",
      showRetry: input.error.retryable,
      message: input.error.message,
      saveLabel: input.saveStatus,
    };
  }
  if (input.saveStatus === "conflict" || input.error?.code === "VERSION_CONFLICT") {
    return { kind: "conflict", showRetry: true, message: input.error?.message, saveLabel: "conflict" };
  }
  if (!input.draft) {
    return { kind: "missing", showRetry: false, saveLabel: input.saveStatus };
  }
  return { kind: "ready", showRetry: false, saveLabel: input.saveStatus };
}

export function quoteActionLabel(hasDraft: boolean): "create" | "open" {
  return hasDraft ? "open" : "create";
}

export type QuotePreviewRecord = {
  draft_id: string;
  job_id: string;
  version: number;
  preview_hash: string;
  preview_expires_at: string;
  schema_version: number;
  number_label: string;
  snapshot: {
    business: { business_name: string; legal_name: string; contact_name: string; contact_email: string };
    customer: { name: string };
    job: { title: string; no_site: boolean; site_address: { line1: string; city: string; state: string; postal_code: string } | null };
    notes: string;
    terms: string;
    expiry_days: number;
    expiry_local_date: string;
    issue_date: string;
    lines: Array<{
      position: number;
      description: string;
      quantity: string;
      unit: string;
      custom_unit_label: string | null;
      unit_price_cents: number;
      discount_cents: number;
      tax_bp: number;
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

export type PublishedQuoteRecord = {
  id: string;
  job_id: string;
  number: string;
  revision_label: string;
  revision_no: number;
  lifecycle: string;
  pdf_state: string;
  snapshot: QuotePreviewRecord["snapshot"];
  net_cents: number;
  tax_cents: number;
  total_cents: number;
};

export type QuoteReviewKind =
  | "loading"
  | "error"
  | "offline"
  | "access_expired"
  | "ready"
  | "confirming"
  | "publishing"
  | "published"
  | "conflict"
  | "entitlement"
  | "already";

export function presentQuoteReview(input: {
  authStatus: string;
  loading: boolean;
  confirming: boolean;
  publishing: boolean;
  published?: PublishedQuoteRecord;
  preview?: QuotePreviewRecord;
  error?: { message: string; retryable: boolean; status: number; code?: string };
}): { kind: QuoteReviewKind; showRetry: boolean; publishDisabled: boolean; message?: string } {
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", showRetry: false, publishDisabled: true };
  }
  if (input.authStatus === "offline_cached") {
    return { kind: "offline", showRetry: true, publishDisabled: true, message: input.error?.message };
  }
  if (input.published) {
    return { kind: "published", showRetry: false, publishDisabled: true };
  }
  if (input.publishing) {
    return { kind: "publishing", showRetry: false, publishDisabled: true };
  }
  if (input.error?.code === "ENTITLEMENT_REQUIRED") {
    return { kind: "entitlement", showRetry: false, publishDisabled: true, message: input.error.message };
  }
  if (input.error?.code === "DOCUMENT_IMMUTABLE") {
    return { kind: "already", showRetry: true, publishDisabled: true, message: input.error.message };
  }
  if (input.error?.code === "VERSION_CONFLICT" || input.error?.code === "PREVIEW_CHANGED") {
    return { kind: "conflict", showRetry: true, publishDisabled: true, message: input.error.message };
  }
  if (input.loading && !input.preview) {
    return { kind: "loading", showRetry: false, publishDisabled: true };
  }
  if (input.error && !input.preview) {
    return {
      kind: "error",
      showRetry: input.error.retryable,
      publishDisabled: true,
      message: input.error.message,
    };
  }
  if (!input.preview) {
    return { kind: "error", showRetry: true, publishDisabled: true };
  }
  if (input.confirming) {
    return { kind: "confirming", showRetry: false, publishDisabled: false };
  }
  return { kind: "ready", showRetry: false, publishDisabled: false };
}

export type QuotePdfDownload = {
  state: string;
  url: string | null;
};

export function presentQuotePdf(download?: QuotePdfDownload): {
  kind: "preparing" | "ready" | "failed";
  url?: string;
  showRetry: boolean;
} {
  if (download?.state === "ready" && typeof download.url === "string" && download.url.length > 0) {
    return { kind: "ready", url: download.url, showRetry: false };
  }
  if (download?.state === "failed") {
    return { kind: "failed", showRetry: true };
  }
  return { kind: "preparing", showRetry: true };
}

export function presentQuotePdfRetry(input: {
  checking: boolean;
  stillPreparing: boolean;
}): { busy: boolean; label: string; acknowledgement?: string } {
  if (input.checking) {
    return { busy: true, label: copy.quotePdfChecking };
  }
  if (input.stillPreparing) {
    return { busy: false, label: copy.quotePdfRetry, acknowledgement: copy.quotePdfStillPreparing };
  }
  return { busy: false, label: copy.quotePdfRetry };
}
