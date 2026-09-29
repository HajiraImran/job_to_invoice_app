import { copy } from "../i18n/en.ts";
import { subscriptionPath } from "../subscription/presentation.ts";

export type QuoteEditorKind =
  | "loading"
  | "error"
  | "offline"
  | "access_expired"
  | "missing"
  | "ready"
  | "conflict";

export type QuoteSaveStatus =
  | "idle"
  | "saving_locally"
  | "saved_on_device"
  | "synchronizing"
  | "synced"
  | "validation"
  | "offline"
  | "conflict"
  | "storage_failure"
  | "error";

/** @deprecated legacy alias kept for gradual migration */
export type LegacyQuoteSaveStatus = "saving" | "saved";

export function presentQuoteSaveLabel(status: QuoteSaveStatus): string {
  switch (status) {
    case "saving_locally":
      return copy.quoteSaving;
    case "saved_on_device":
      return copy.quoteSaved;
    case "synchronizing":
      return copy.quoteSynchronizing;
    case "synced":
      return copy.quoteSynced;
    case "storage_failure":
      return copy.quoteStorageFailure;
    case "conflict":
      return copy.quoteConflict;
    case "offline":
      return copy.quoteOfflineEditing;
    case "validation":
      return copy.quoteSaveError;
    case "error":
      return copy.quoteSaveError;
    default:
      return "";
  }
}

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

export function quoteReviewBlocked(input: {
  lineCount: number;
  totalsOk: boolean;
  netCents: number;
  offline: boolean;
  busy: boolean;
  accessExpired: boolean;
  formUnsaved?: boolean;
  saveStatus?: QuoteSaveStatus;
}): boolean {
  const saveBlocksReview =
    input.saveStatus != null && input.saveStatus !== "synced" && input.saveStatus !== "idle";
  return (
    input.accessExpired ||
    input.offline ||
    input.busy ||
    input.formUnsaved === true ||
    saveBlocksReview ||
    input.lineCount === 0 ||
    !input.totalsOk ||
    input.netCents <= 0
  );
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
    customer: { name: string; email?: string | null };
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
    return {
      kind: "confirming",
      showRetry: false,
      publishDisabled: input.publishing,
      message: input.error?.message,
    };
  }
  if (input.error) {
    return {
      kind: "error",
      showRetry: input.error.retryable,
      publishDisabled: true,
      message: input.error.message,
    };
  }
  return { kind: "ready", showRetry: false, publishDisabled: false };
}

export function quotePublishBackControls(kind: QuoteReviewKind): {
  cancelConfirmation: boolean;
  jobOverview: boolean;
} {
  if (kind === "confirming") {
    return { cancelConfirmation: true, jobOverview: false };
  }
  if (kind === "publishing") {
    return { cancelConfirmation: false, jobOverview: false };
  }
  return { cancelConfirmation: false, jobOverview: true };
}

const PREVIEW_HASH = /^[0-9a-f]{64}$/;

export function previewAfterPublishError<T extends { preview_hash: string }>(
  preview: T | undefined,
  code: string | undefined,
): T | undefined {
  if (!preview) {
    return preview;
  }
  if (code === "PREVIEW_CHANGED" || code === "VERSION_CONFLICT") {
    return { ...preview, preview_hash: "" };
  }
  return preview;
}

export function previewHashIsCurrent(preview?: { preview_hash: string }): boolean {
  return Boolean(preview && PREVIEW_HASH.test(preview.preview_hash));
}

export function presentPreviewGeneratedLabel(receivedAtMs: number | undefined, nowMs: number): string | undefined {
  if (receivedAtMs === undefined || nowMs < receivedAtMs || nowMs - receivedAtMs >= 60_000) {
    return undefined;
  }
  return copy.previewGeneratedJustNow;
}

export type FrozenPreviewLine = {
  position: number;
  description: string;
  quantity: string;
  unit: string;
  unitPriceCents: number;
  amountCents: number;
};

export type FrozenPreviewView = {
  businessName: string;
  customerName: string;
  expiryDays: number;
  unpublishedLabel: string;
  lines: FrozenPreviewLine[];
  subtotalCents: number;
  discountCents: number;
  showDiscount: boolean;
  netCents: number;
  taxCents: number;
  totalCents: number;
  notes?: string;
  terms?: string;
};

export function presentCommercialSnapshot(snapshot: QuotePreviewRecord["snapshot"]): FrozenPreviewView {
  const discountCents = snapshot.lines.reduce((sum, line) => sum + line.discount_cents, 0);
  return {
    businessName: snapshot.business.business_name,
    customerName: snapshot.customer.name,
    expiryDays: snapshot.expiry_days,
    unpublishedLabel: copy.previewNotPublished,
    lines: snapshot.lines.map((line) => ({
      position: line.position,
      description: line.description,
      quantity: line.quantity,
      unit: line.custom_unit_label ?? line.unit,
      unitPriceCents: line.unit_price_cents,
      amountCents: line.total_cents,
    })),
    subtotalCents: snapshot.net_cents + discountCents,
    discountCents,
    showDiscount: discountCents > 0,
    netCents: snapshot.net_cents,
    taxCents: snapshot.tax_cents,
    totalCents: snapshot.total_cents,
    notes: snapshot.notes.trim() ? snapshot.notes : undefined,
    terms: snapshot.terms.trim() ? snapshot.terms : undefined,
  };
}

export function presentFrozenPreview(preview: QuotePreviewRecord): FrozenPreviewView {
  return presentCommercialSnapshot(preview.snapshot);
}

export function quotePublishPlansPath(): string {
  return `${subscriptionPath()}?from=publish`;
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

export type OwnerRequestRecord = {
  request_id: string;
  document_id: string;
  job_id: string;
  number: string;
  revision_label: string;
  revision_no: number;
  template_id: string;
  delivery_state: string;
  recipient_email_masked: string;
  last_event_at: string;
  retry_count: number;
  retryable: boolean;
  terminal: boolean;
  request_state?: string | null;
  decided_at?: string | null;
  resends_used_today?: number;
  resend_available_at?: string | null;
  can_resend?: boolean;
  can_withdraw?: boolean;
  can_replace_link?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type RequestActionKind = "hidden" | "disabled" | "ready" | "busy" | "offline";

export function presentRequestActions(input: {
  authStatus: string;
  request?: OwnerRequestRecord;
  submitting?: boolean;
  nowMs?: number;
}): {
  resend: RequestActionKind;
  withdraw: RequestActionKind;
  replaceLink: RequestActionKind;
  resendHint?: string;
} {
  if (input.authStatus === "offline_cached") {
    return { resend: "offline", withdraw: "offline", replaceLink: "offline", resendHint: copy.requestOffline };
  }
  if (!input.request || input.request.request_state !== "pending") {
    return { resend: "hidden", withdraw: "hidden", replaceLink: "hidden" };
  }
  if (input.submitting) {
    return { resend: "busy", withdraw: "busy", replaceLink: "busy" };
  }
  const availableAt = input.request.resend_available_at
    ? Date.parse(input.request.resend_available_at)
    : NaN;
  const now = input.nowMs ?? Date.now();
  const cooling = Number.isFinite(availableAt) && availableAt > now;
  const canResend = Boolean(input.request.can_resend) && !cooling;
  return {
    resend: canResend ? "ready" : "disabled",
    withdraw: input.request.can_withdraw === false ? "disabled" : "ready",
    replaceLink: input.request.can_replace_link === false ? "disabled" : "ready",
    resendHint: canResend
      ? undefined
      : cooling
        ? copy.requestResendWait
        : copy.requestResendCap,
  };
}

export type DeliveryStatusKind =
  | "loading"
  | "queued"
  | "sending"
  | "accepted"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "offline"
  | "error"
  | "access_expired";

export function presentDeliveryStatus(input: {
  authStatus: string;
  loading: boolean;
  checking: boolean;
  request?: OwnerRequestRecord;
  error?: { message: string; retryable: boolean; status: number };
}): { kind: DeliveryStatusKind; label: string; showRetry: boolean; retryBusy: boolean; acceptedNotDelivered: boolean } {
  if (input.authStatus === "access_expired") {
    return {
      kind: "access_expired",
      label: copy.accessExpired,
      showRetry: false,
      retryBusy: false,
      acceptedNotDelivered: false,
    };
  }
  if (input.authStatus === "offline_cached") {
    return {
      kind: "offline",
      label: copy.requestOffline,
      showRetry: true,
      retryBusy: false,
      acceptedNotDelivered: false,
    };
  }
  if (input.loading && !input.request) {
    return { kind: "loading", label: copy.requestLoading, showRetry: false, retryBusy: false, acceptedNotDelivered: false };
  }
  if (input.error && !input.request) {
    return {
      kind: "error",
      label: input.error.message,
      showRetry: input.error.retryable || input.error.status === 0,
      retryBusy: false,
      acceptedNotDelivered: false,
    };
  }
  const state = input.request?.delivery_state;
  if (state === "queued") {
    return { kind: "queued", label: copy.requestQueued, showRetry: true, retryBusy: input.checking, acceptedNotDelivered: false };
  }
  if (state === "submitting") {
    return { kind: "sending", label: copy.requestSending, showRetry: true, retryBusy: input.checking, acceptedNotDelivered: false };
  }
  if (state === "accepted_by_provider") {
    return {
      kind: "accepted",
      label: copy.requestAccepted,
      showRetry: true,
      retryBusy: input.checking,
      acceptedNotDelivered: true,
    };
  }
  if (state === "delivered") {
    return { kind: "delivered", label: copy.requestDelivered, showRetry: true, retryBusy: input.checking, acceptedNotDelivered: false };
  }
  if (state === "bounced") {
    return { kind: "bounced", label: copy.requestBounced, showRetry: true, retryBusy: input.checking, acceptedNotDelivered: false };
  }
  if (state === "complained") {
    return { kind: "complained", label: copy.requestComplained, showRetry: true, retryBusy: input.checking, acceptedNotDelivered: false };
  }
  if (state === "failed") {
    return { kind: "failed", label: copy.requestFailed, showRetry: true, retryBusy: input.checking, acceptedNotDelivered: false };
  }
  return { kind: "loading", label: copy.requestLoading, showRetry: true, retryBusy: input.checking, acceptedNotDelivered: false };
}

export function requestStateLabel(state: string | null | undefined): string | undefined {
  switch (state) {
    case "pending":
      return copy.requestStatePending;
    case "approved":
      return copy.requestStateApproved;
    case "declined":
      return copy.requestStateDeclined;
    case "expired":
      return copy.requestStateExpired;
    case "superseded":
      return copy.requestStateSuperseded;
    case "withdrawn":
      return copy.requestStateWithdrawn;
    case "revoked":
      return copy.requestStateRevoked;
    default:
      return undefined;
  }
}

export type RequestDetailTone = "pending" | "failed" | "accepted" | "neutral";

export function presentRequestDetail(request?: OwnerRequestRecord): {
  badge?: string;
  tone: RequestDetailTone;
  support: string;
  deliveryFailed: boolean;
  accepted: boolean;
} {
  const deliveryFailed =
    request?.delivery_state === "failed" || request?.delivery_state === "bounced" || request?.delivery_state === "complained";
  if (request?.request_state === "approved") {
    return {
      badge: copy.requestAcceptedBadge,
      tone: "accepted",
      support: copy.requestDetailAcceptedSupport,
      deliveryFailed: false,
      accepted: true,
    };
  }
  if (deliveryFailed && request?.request_state === "pending") {
    return {
      badge: copy.requestFailedBadge,
      tone: "failed",
      support: copy.requestDetailFailedSupport,
      deliveryFailed: true,
      accepted: false,
    };
  }
  if (request?.request_state === "pending") {
    return {
      badge: copy.requestPendingBadge,
      tone: "pending",
      support: copy.requestDetailSupport,
      deliveryFailed: false,
      accepted: false,
    };
  }
  return {
    badge: requestStateLabel(request?.request_state),
    tone: "neutral",
    support: requestStateLabel(request?.request_state) ?? copy.requestDetailSupport,
    deliveryFailed: false,
    accepted: false,
  };
}

export function presentRequestTimestamp(iso: string | null | undefined, now = new Date()): string | undefined {
  if (!iso) {
    return undefined;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
  if (date.toDateString() === now.toDateString()) {
    return `Today, ${time}`;
  }
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
  return `${day}, ${time}`;
}

export function presentCalendarDate(isoDate: string | null | undefined): string | undefined {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return undefined;
  }
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) {
    return undefined;
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

export type RequestActivityItem = { key: string; title: string; at?: string; on?: string };

export function presentRequestActivity(
  request: OwnerRequestRecord | undefined,
  extras?: { quoteIssuedOn?: string },
): RequestActivityItem[] {
  if (!request) {
    return [];
  }
  const items: RequestActivityItem[] = [];
  if (request.request_state === "approved" && request.decided_at) {
    items.push({ key: "accepted", title: copy.requestActivityAccepted, at: request.decided_at });
  } else if (request.request_state === "declined" && request.decided_at) {
    items.push({ key: "declined", title: copy.requestStateDeclined, at: request.decided_at });
  }
  if (request.last_event_at) {
    const deliveryTitle =
      request.delivery_state === "delivered"
        ? copy.requestActivityDelivered
        : request.delivery_state === "failed" || request.delivery_state === "bounced" || request.delivery_state === "complained"
          ? copy.requestActivityFailed
          : request.delivery_state === "accepted_by_provider"
            ? copy.requestAccepted
            : request.delivery_state === "submitting"
              ? copy.requestSending
              : request.delivery_state === "queued"
                ? copy.requestQueued
                : undefined;
    if (deliveryTitle) {
      items.push({ key: "delivery", title: deliveryTitle, at: request.last_event_at });
    }
  }
  if (request.created_at) {
    items.push({ key: "created", title: copy.requestActivityCreated, at: request.created_at });
  }
  if (extras?.quoteIssuedOn && presentCalendarDate(extras.quoteIssuedOn)) {
    items.push({ key: "published", title: copy.requestActivityPublished, on: extras.quoteIssuedOn });
  }
  return items;
}

export function presentApprovalReceipt(input: {
  requestState?: string | null;
  decidedAt?: string | null;
  pdfState?: string;
}): { visible: boolean; decidedAt?: string; pdf: "hidden" | "preparing" | "ready" | "failed" } {
  if (input.requestState !== "approved" || !input.decidedAt) {
    return { visible: false, pdf: "hidden" };
  }
  if (input.pdfState === "ready") {
    return { visible: true, decidedAt: input.decidedAt, pdf: "ready" };
  }
  if (input.pdfState === "failed") {
    return { visible: true, decidedAt: input.decidedAt, pdf: "failed" };
  }
  if (input.pdfState) {
    return { visible: true, decidedAt: input.decidedAt, pdf: "preparing" };
  }
  return { visible: true, decidedAt: input.decidedAt, pdf: "hidden" };
}

export function requestMutationAllowed(input: {
  inFlight: boolean;
  offline: boolean;
  action: RequestActionKind;
}): boolean {
  return !input.inFlight && !input.offline && input.action === "ready";
}

export function requestIdempotencyAfterFailure(code: string | undefined): "retain" | "rotate" {
  return code === "IDEMPOTENCY_MISMATCH" ? "rotate" : "retain";
}
