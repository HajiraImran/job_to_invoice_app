import { formatUsdCents } from "@job-to-invoice/schemas";
import { changeStatusLabel } from "../changes/presentation.ts";
import { copy } from "../i18n/en.ts";

export type JobSummary = {
  id: string;
  customer_id: string;
  customer_name: string;
  title: string;
  lifecycle: string;
  mode: string;
  no_site: boolean;
  version: number;
  created_at: string;
  updated_at: string;
};

export type JobDetail = JobSummary & {
  site_address: {
    line1: string;
    line2?: string | null;
    city: string;
    state: string;
    postal_code: string;
  } | null;
  internal_notes: string;
  related_job_id?: string | null;
  archived_from_state?: string | null;
  permitted_actions: string[];
  quote_draft: {
    id: string;
    version: number;
    line_count: number;
    net_cents: number;
    tax_cents: number;
    total_cents: number;
  } | null;
  invoice_draft?: {
    id: string;
    version: number;
    line_count: number;
    net_cents: number;
    tax_cents: number;
    total_cents: number;
  } | null;
  current_quote: {
    id: string;
    number: string;
    revision_no: number;
    lifecycle: string;
    total_cents: number;
  } | null;
  active_invoice: {
    id: string;
    number: string;
    revision_no: number;
    lifecycle: string;
    total_cents: number;
    due_date: string | null;
  } | null;
  latest_invoice: {
    id: string;
    number: string;
    revision_no: number;
    lifecycle: string;
    total_cents: number;
    due_date: string | null;
  } | null;
  change_draft: {
    id: string;
    version: number;
    reason: string;
    additions_count?: number;
    reductions_count?: number;
  } | null;
  latest_change: {
    id: string;
    number: string;
    revision_no: number;
    lifecycle: string;
    total_cents: number;
    request_state: string | null;
    additions?: Array<{ description: string; total_cents: number }>;
  } | null;
  issued_credits?: Array<{
    id: string;
    number: string;
    revision_no: number;
    lifecycle: string;
    total_cents: number;
    pdf_state: string;
    invoice_id: string;
  }>;
};

export type JobsListKind = "loading" | "empty" | "loaded" | "error" | "offline" | "access_expired";

export type JobsListView = {
  kind: JobsListKind;
  items: JobSummary[];
  showRetry: boolean;
  showCreate: boolean;
  showOfflineBanner: boolean;
  showSearchDownloaded: boolean;
  message?: string;
  /** Real items are on screen and a newer copy is loading. */
  refreshing?: boolean;
};

export function presentJobsList(input: {
  authStatus: string;
  loading: boolean;
  loadedOnce: boolean;
  items: JobSummary[];
  searching: boolean;
  error?: { message: string; retryable: boolean };
}): JobsListView {
  if (input.authStatus === "access_expired") {
    return {
      kind: "access_expired",
      items: input.items,
      showRetry: false,
      showCreate: false,
      showOfflineBanner: false,
      showSearchDownloaded: false,
    };
  }
  if (input.authStatus === "offline_cached") {
    return {
      kind: input.items.length === 0 ? (input.loadedOnce ? "offline" : "offline") : "loaded",
      items: input.items,
      showRetry: true,
      showCreate: true,
      showOfflineBanner: true,
      showSearchDownloaded: input.searching,
      message: input.items.length === 0 && input.loadedOnce ? copy.cacheMissOffline : undefined,
    };
  }
  if (input.loading && !input.loadedOnce) {
    return {
      kind: "loading",
      items: [],
      showRetry: false,
      showCreate: true,
      showOfflineBanner: false,
      showSearchDownloaded: false,
    };
  }
  if (input.error && !input.loadedOnce) {
    return {
      kind: "error",
      items: [],
      showRetry: input.error.retryable,
      showCreate: true,
      showOfflineBanner: false,
      showSearchDownloaded: false,
      message: input.error.message,
    };
  }
  if (input.items.length === 0) {
    return {
      kind: "empty",
      items: [],
      showRetry: Boolean(input.error?.retryable),
      showCreate: true,
      showOfflineBanner: false,
      showSearchDownloaded: false,
      message: input.error?.message,
    };
  }
  return {
    kind: "loaded",
    items: input.items,
    showRetry: Boolean(input.error?.retryable),
    showCreate: true,
    showOfflineBanner: false,
    showSearchDownloaded: false,
    message: input.error?.message,
    refreshing: input.loading,
  };
}

/** Fail closed: only a string array is a server permission list. */
export function normalizePermittedActions(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((action) => typeof action !== "string")) {
    return [];
  }
  return value;
}

export function jobPermitsAction(job: unknown, action: string): boolean {
  if (!job || typeof job !== "object") {
    return false;
  }
  return normalizePermittedActions((job as { permitted_actions?: unknown }).permitted_actions).includes(action);
}

type PresentableJob = Omit<JobDetail, "permitted_actions"> & { permitted_actions?: unknown };

function presentableJob(job: PresentableJob): JobDetail {
  const permitted_actions = normalizePermittedActions(job.permitted_actions);
  if (job.permitted_actions === permitted_actions) {
    return job as JobDetail;
  }
  return { ...job, permitted_actions };
}

export function presentJobDetail(input: {
  authStatus: string;
  loading: boolean;
  job?: PresentableJob;
  error?: { message: string; retryable: boolean; status: number };
}): {
  kind: "loading" | "error" | "missing" | "loaded" | "access_expired" | "offline";
  showRetry: boolean;
  job?: JobDetail;
  message?: string;
  refreshFailed?: boolean;
} {
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", showRetry: false };
  }
  if (input.loading && !input.job) {
    return { kind: "loading", showRetry: false };
  }
  if (input.error && !input.job) {
    if (input.error.status === 404) {
      return { kind: "missing", showRetry: false, message: input.error.message };
    }
    return {
      kind: input.authStatus === "offline_cached" ? "offline" : "error",
      showRetry: input.error.retryable,
      message: input.error.message,
    };
  }
  if (!input.job) {
    return { kind: "missing", showRetry: false };
  }
  return {
    kind: "loaded",
    showRetry: Boolean(input.error?.retryable),
    job: presentableJob(input.job),
    message: input.error?.message,
    refreshFailed: Boolean(input.error),
  };
}

export function nextActionCopy(
  mode: string,
  lifecycle: string,
  quoteLifecycle?: string | null,
  hasInvoice?: boolean,
): "quote" | "direct" | "published" | "invoice" | "view_invoice" | "replace_invoice" | "none" {
  if (hasInvoice) {
    return "view_invoice";
  }
  if (lifecycle === "canceled" || lifecycle === "finished" || lifecycle === "archived") {
    return hasInvoice ? "view_invoice" : "none";
  }
  if (lifecycle === "invoiced") {
    return "replace_invoice";
  }
  if (lifecycle === "draft") {
    return mode === "direct_invoice" ? "direct" : "quote";
  }
  if (lifecycle === "active") {
    if (quoteLifecycle === "accepted") {
      return "invoice";
    }
    if (quoteLifecycle && quoteLifecycle !== "issued") {
      return "quote";
    }
    return "published";
  }
  if (lifecycle !== "draft") {
    return "none";
  }
  return mode === "direct_invoice" ? "direct" : "quote";
}

export function jobLifecycleActions(job: Pick<JobDetail, "lifecycle" | "latest_invoice" | "active_invoice"> & { permitted_actions?: unknown }): {
  canDelete: boolean;
  canCancel: boolean;
  canCreateLinked: boolean;
  canArchive: boolean;
  canRestore: boolean;
  canFinish: boolean;
  showReceivable: boolean;
} {
  const permitted = normalizePermittedActions(job.permitted_actions);
  return {
    canDelete: permitted.includes("delete_job"),
    canCancel: permitted.includes("cancel_job"),
    canCreateLinked: permitted.includes("create_linked_job"),
    canArchive: permitted.includes("archive_job"),
    canRestore: permitted.includes("restore_job"),
    canFinish: permitted.includes("finish_job"),
    showReceivable: job.lifecycle === "canceled" && Boolean(job.active_invoice || job.latest_invoice),
  };
}

export function presentScopeTotalCents(job: JobDetail): number | null {
  if (
    job.latest_change &&
    (job.latest_change.lifecycle === "accepted" || job.latest_change.request_state === "approved")
  ) {
    return job.latest_change.total_cents;
  }
  if (job.current_quote) {
    return job.current_quote.total_cents;
  }
  if (job.quote_draft) {
    return job.quote_draft.total_cents;
  }
  if (job.invoice_draft) {
    return job.invoice_draft.total_cents;
  }
  if (job.lifecycle !== "canceled" && job.active_invoice) {
    return job.active_invoice.total_cents;
  }
  return null;
}

export function presentReceivableCents(job: JobDetail): number | null {
  if (job.lifecycle !== "canceled") {
    return null;
  }
  return (job.active_invoice ?? job.latest_invoice)?.total_cents ?? null;
}

export function presentUpdatedLabel(updatedAt: string, nowMs = Date.now()): string {
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) {
    return "";
  }
  const minutes = Math.floor(Math.max(0, nowMs - then) / 60_000);
  if (minutes < 1) {
    return copy.jobUpdatedJustNow;
  }
  if (minutes < 60) {
    return copy.jobUpdatedMinutes.replace("{count}", String(minutes));
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return copy.jobUpdatedHours.replace("{count}", String(hours));
  }
  return copy.jobUpdatedDate.replace("{date}", new Date(then).toLocaleDateString());
}

export function presentCurrentStep(job: JobDetail): { label: string; tone: "draft" | "ready" | "attention" | "neutral" } {
  const next = nextActionCopy(
    job.mode,
    job.lifecycle,
    job.current_quote?.lifecycle,
    Boolean(job.active_invoice),
  );
  const quoteLifecycle = job.current_quote?.lifecycle;
  if (next === "quote" && quoteLifecycle && quoteLifecycle !== "issued") {
    return { label: copy.createRevision, tone: "attention" };
  }
  if (next === "quote") {
    return { label: job.quote_draft ? copy.openQuote : copy.createQuote, tone: "draft" };
  }
  if (next === "direct") {
    return { label: copy.createInvoice, tone: "draft" };
  }
  if (next === "invoice") {
    return { label: copy.jobStepReadyInvoice, tone: "ready" };
  }
  if (next === "published") {
    return { label: quoteLifecycle ? quoteLifecycleLabel(quoteLifecycle) : copy.jobLifecycleActive, tone: "neutral" };
  }
  if (next === "view_invoice") {
    return { label: copy.viewInvoice, tone: "ready" };
  }
  if (next === "replace_invoice") {
    return { label: copy.invoiceReplace, tone: "attention" };
  }
  if (job.lifecycle === "canceled") {
    return { label: copy.jobLifecycleCanceled, tone: "attention" };
  }
  if (job.lifecycle === "finished") {
    return { label: copy.jobLifecycleFinished, tone: "neutral" };
  }
  if (job.lifecycle === "archived") {
    return { label: copy.jobLifecycleArchived, tone: "neutral" };
  }
  return { label: copy.jobLifecycleDraft, tone: "neutral" };
}

export type JobDocumentAction = "quote" | "request" | "invoice" | "change" | "credit";

export type JobDocumentRow = {
  key: string;
  title: string;
  subtitle: string;
  action: JobDocumentAction;
  targetId?: string;
};

export function presentJobDocuments(job: JobDetail): JobDocumentRow[] {
  const rows: JobDocumentRow[] = [];
  if (job.current_quote) {
    rows.push({
      key: `quote-${job.current_quote.id}`,
      title: copy.jobQuotePill.replace("{number}", job.current_quote.number),
      subtitle: `${quoteLifecycleLabel(job.current_quote.lifecycle)} · PDF`,
      action: "quote",
    });
    if (job.current_quote.lifecycle === "accepted") {
      rows.push({
        key: `receipt-${job.current_quote.id}`,
        title: copy.jobApprovalReceipt,
        subtitle: copy.jobApprovalReceiptHint,
        action: "request",
      });
    }
  }
  const invoice = job.active_invoice ?? job.latest_invoice;
  if (invoice) {
    rows.push({
      key: `invoice-${invoice.id}`,
      title: invoice.number,
      subtitle: invoice.lifecycle,
      action: "invoice",
      targetId: invoice.id,
    });
  }
  for (const credit of job.issued_credits ?? []) {
    rows.push({
      key: `credit-${credit.id}`,
      title: credit.number,
      subtitle: copy.jobCreditDocumentHint,
      action: "credit",
      targetId: credit.id,
    });
  }
  if (job.latest_change) {
    rows.push({
      key: `change-${job.latest_change.id}`,
      title: job.latest_change.number,
      subtitle: changeStatusLabel(job.latest_change.lifecycle, job.latest_change.request_state),
      action: "change",
    });
    const approved =
      job.latest_change.lifecycle === "accepted" || job.latest_change.request_state === "approved";
    if (approved) {
      for (const [index, line] of (job.latest_change.additions ?? []).entries()) {
        rows.push({
          key: `change-line-${job.latest_change.id}-${index}`,
          title: line.description,
          subtitle: formatUsdCents(line.total_cents),
          action: "change",
        });
      }
    }
  }
  return rows;
}

export type JobActivityRow = { key: string; title: string; at: string };

export function presentJobActivity(job: JobDetail): JobActivityRow[] {
  const rows: JobActivityRow[] = [{ key: "created", title: copy.jobCreatedActivity, at: job.created_at }];
  if (job.updated_at && job.updated_at !== job.created_at) {
    rows.push({ key: "updated", title: copy.jobUpdatedActivity, at: job.updated_at });
  }
  return rows.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

export function presentModePill(job: Pick<JobDetail, "mode" | "current_quote">): string {
  if (job.current_quote?.number) {
    return copy.jobQuotePill.replace("{number}", job.current_quote.number);
  }
  return job.mode === "direct_invoice" ? copy.modeDirect : copy.modeQuote;
}

export function quoteLifecycleLabel(lifecycle: string): string {
  switch (lifecycle) {
    case "accepted":
      return copy.quoteLifecycleAccepted;
    case "declined":
      return copy.quoteLifecycleDeclined;
    case "expired":
      return copy.quoteLifecycleExpired;
    case "superseded":
      return copy.quoteLifecycleSuperseded;
    case "withdrawn":
      return copy.quoteLifecycleWithdrawn;
    case "issued":
      return copy.quoteLifecycleIssued;
    default:
      return lifecycle;
  }
}
