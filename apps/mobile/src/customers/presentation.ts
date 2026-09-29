import { maskEmail } from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";

export type CustomerRecord = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billing_address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postal_code: string;
  } | null;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export type CustomerDuplicate = { id: string; name: string; archived: boolean };

export const CUSTOMER_PRIMARY_MIN_PT = 48;
export const CUSTOMER_TARGET_MIN_PT = 44;
export const CUSTOMER_SEARCH_DEBOUNCE_MS = 300;
export const CUSTOMER_LIST_LIMIT = 25;

export type CustomerListKind = "loading" | "empty" | "error" | "offline" | "access_expired" | "loaded";

export function presentCustomerList(input: {
  authStatus: string;
  loading: boolean;
  loadedOnce: boolean;
  customers: CustomerRecord[];
  queryMatches?: boolean;
  error?: { message: string; retryable: boolean };
}): {
  kind: CustomerListKind;
  customers: CustomerRecord[];
  showAdd: boolean;
  showRetry: boolean;
  refreshing: boolean;
  message?: string;
} {
  const showAdd = input.authStatus === "authenticated";
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", customers: [], showAdd: false, showRetry: false, refreshing: false };
  }
  if (input.authStatus === "offline_cached") {
    return { kind: "offline", customers: [], showAdd: false, showRetry: true, refreshing: false };
  }
  if (input.loading && (!input.loadedOnce || input.queryMatches === false)) {
    return { kind: "loading", customers: [], showAdd, showRetry: false, refreshing: false };
  }
  if (input.error && input.customers.length > 0 && input.queryMatches !== false) {
    return {
      kind: "loaded",
      customers: input.customers,
      showAdd,
      showRetry: input.error.retryable,
      refreshing: input.loading,
      message: input.error.message,
    };
  }
  if (input.error && input.customers.length === 0) {
    return { kind: "error", customers: [], showAdd, showRetry: input.error.retryable, refreshing: false, message: input.error.message };
  }
  if (input.customers.length === 0) {
    if (input.loading) {
      return { kind: "loading", customers: [], showAdd, showRetry: false, refreshing: false };
    }
    return { kind: "empty", customers: [], showAdd, showRetry: false, refreshing: false };
  }
  return { kind: "loaded", customers: input.customers, showAdd, showRetry: false, refreshing: input.loading };
}

export function customerListAnnouncement(kind: CustomerListKind): string {
  if (kind === "loading") return "Loading customers";
  if (kind === "empty") return "No customers in this list";
  if (kind === "error") return "Could not load customers";
  if (kind === "offline") return "Reconnect to view customers";
  if (kind === "access_expired") return "Sign in to view customers";
  return "Customers loaded";
}

export function customerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const second = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return `${first}${second}`.toUpperCase();
}

export function presentDuplicateConfirmation(duplicates: CustomerDuplicate[], enteredEmail: string) {
  const match = duplicates[0];
  if (!match) {
    return null;
  }
  return {
    id: match.id,
    name: match.name,
    email: enteredEmail.trim(),
    initials: customerInitials(match.name),
    archived: match.archived,
    createsNewCustomer: false as const,
  };
}

export function presentCreateAnyway(): { confirm_duplicate_email: true } {
  return { confirm_duplicate_email: true };
}

export function customerSubmitBlocked(submitting: boolean): boolean {
  return submitting;
}

export function presentCreateCustomerDestination(input: {
  returnTo?: string;
  relatedJobId?: string;
  customerId: string;
  customerName: string;
}):
  | { pathname: "/jobs/new"; params: { customerId: string; customerName: string; relatedJobId?: string } }
  | { pathname: `/customers/${string}` } {
  if (input.returnTo === "job") {
    return {
      pathname: "/jobs/new",
      params: {
        customerId: input.customerId,
        customerName: input.customerName,
        ...(input.relatedJobId ? { relatedJobId: input.relatedJobId } : {}),
      },
    };
  }
  return { pathname: `/customers/${input.customerId}` };
}

export type CustomerFilter = "active" | "archived" | "all";

export function customerListPath(input: { state: CustomerFilter; search: string; cursor?: string; limit?: number }): string {
  const params = new URLSearchParams({ state: input.state, limit: String(input.limit ?? CUSTOMER_LIST_LIMIT) });
  if (input.search) {
    params.set("search", input.search);
  }
  if (input.cursor) {
    params.set("cursor", input.cursor);
  }
  return `/v1/customers?${params.toString()}`;
}

export function customerResponseCurrent(started: number, latest: number): boolean {
  return started === latest;
}

export function customerQueryKey(state: CustomerFilter, search: string): string {
  return `${state}\n${search}`;
}

export function appendCustomerPage(current: readonly CustomerRecord[], page: readonly CustomerRecord[]): CustomerRecord[] {
  const seen = new Set(current.map((customer) => customer.id));
  const next = [...current];
  for (const customer of page) {
    if (seen.has(customer.id)) {
      continue;
    }
    seen.add(customer.id);
    next.push(customer);
  }
  return next;
}

export function customerRowsAfterLoad(input: {
  previous: readonly CustomerRecord[];
  next?: readonly CustomerRecord[];
  failed: boolean;
  sameQuery: boolean;
  append: boolean;
}): CustomerRecord[] {
  if (input.failed) {
    return input.sameQuery ? [...input.previous] : [];
  }
  if (!input.next) {
    return input.sameQuery ? [...input.previous] : [];
  }
  if (input.append) {
    return appendCustomerPage(input.previous, input.next);
  }
  return [...input.next];
}

export function customerEmptyBody(state: CustomerFilter): string {
  if (state === "archived") {
    return copy.customersEmptyArchived;
  }
  if (state === "all") {
    return copy.customersEmptyAll;
  }
  return copy.customersEmptyActive;
}

export function customerResultLabel(state: CustomerFilter, count: number, complete: boolean): string | undefined {
  if (!complete || !Number.isInteger(count) || count < 1) {
    return undefined;
  }
  if (state === "archived") {
    return count === 1 ? copy.customersCountArchivedOne : copy.customersCountArchived.replace("{count}", String(count));
  }
  if (state === "all") {
    return count === 1 ? copy.customersCountAllOne : copy.customersCountAll.replace("{count}", String(count));
  }
  return count === 1 ? copy.customersCountActiveOne : copy.customersCountActive.replace("{count}", String(count));
}

export function maskCustomerPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) {
    return "•••";
  }
  const last = digits.slice(-4);
  const country = digits.length > 10 ? digits.slice(0, digits.length - 10) : "";
  return `${country ? `+${country} ` : ""}••• ••• ${last}`;
}

export function customerListContact(customer: Pick<CustomerRecord, "email" | "phone">): string | undefined {
  if (customer.email) {
    return maskEmail(customer.email);
  }
  if (customer.phone) {
    return maskCustomerPhone(customer.phone);
  }
  return undefined;
}

export function customerJobCountLabel(jobCount: number | undefined): string | undefined {
  if (!Number.isInteger(jobCount) || (jobCount as number) < 0) {
    return undefined;
  }
  if (jobCount === 0) {
    return copy.customerNoJobs;
  }
  if (jobCount === 1) {
    return copy.customerOneJob;
  }
  return copy.customerManyJobs.replace("{count}", String(jobCount));
}

export function customerListRow(customer: CustomerRecord): {
  id: string;
  name: string;
  initials: string;
  contact?: string;
  status: "active" | "archived";
  jobCountLabel?: string;
} {
  const jobCount = (customer as CustomerRecord & { job_count?: number }).job_count;
  return {
    id: customer.id,
    name: customer.name,
    initials: customerInitials(customer.name),
    contact: customerListContact(customer),
    status: customer.archived_at ? "archived" : "active",
    jobCountLabel: customerJobCountLabel(jobCount),
  };
}

export function customerJobSummary(job: { id: string; title: string; lifecycle: string }): {
  id: string;
  title: string;
  status: string;
} {
  return { id: job.id, title: job.title, status: customerJobStatus(job.lifecycle) };
}

export function customerJobStatus(lifecycle: string): string {
  if (lifecycle === "active") return copy.jobLifecycleActive;
  if (lifecycle === "invoiced") return copy.jobLifecycleInvoiced;
  if (lifecycle === "finished") return copy.jobLifecycleFinished;
  if (lifecycle === "canceled") return copy.jobLifecycleCanceled;
  if (lifecycle === "archived") return copy.jobLifecycleArchived;
  return copy.jobLifecycleDraft;
}

export function customerJobsPath(customerId: string, cursor?: string): string {
  const params = new URLSearchParams({ customer_id: customerId, limit: String(CUSTOMER_LIST_LIMIT) });
  if (cursor) {
    params.set("cursor", cursor);
  }
  return `/v1/jobs?${params.toString()}`;
}

export function customerActionSheet(input: { archived: boolean; jobsLoaded: boolean; referenced: boolean }): {
  actions: Array<"edit" | "archive" | "restore" | "delete">;
  deleteUnavailable: boolean;
} {
  const actions: Array<"edit" | "archive" | "restore" | "delete"> = ["edit"];
  if (input.archived) {
    actions.push("restore");
  } else {
    actions.push("archive");
  }
  const referenced = input.jobsLoaded && input.referenced;
  if (input.jobsLoaded && !input.referenced) {
    actions.push("delete");
  }
  return { actions, deleteUnavailable: referenced };
}

export function customerArchiveBody(archived: boolean): { archived: boolean } {
  return { archived };
}

export function customerMutationAllowed(inFlight: boolean, authStatus: string): boolean {
  return !inFlight && authStatus === "authenticated";
}

export function customerIdempotencyAfterFailure(previous: string | undefined, code: string | undefined): string | undefined {
  if (code === "UNAVAILABLE" || code === "RATE_LIMITED" || code === "DATABASE_TIMEOUT" || code === "DATABASE_UNAVAILABLE") {
    return previous;
  }
  return undefined;
}

export function customerHardwareBack(sheetOpen: boolean): "close_sheet" | "leave" {
  return sheetOpen ? "close_sheet" : "leave";
}

export function customerAnalyticsProperties(): Record<string, never> {
  return {};
}

export function customerDetailVisible<T>(authStatus: string, customer?: T): T | undefined {
  if (authStatus === "access_expired" || authStatus === "offline_cached") {
    return undefined;
  }
  return customer;
}

export function formatBillingAddress(address: CustomerRecord["billing_address"]): string {
  if (!address) return "";
  const line2 = address.line2 ? `${address.line2}, ` : "";
  return `${address.line1}, ${line2}${address.city}, ${address.state} ${address.postal_code}`;
}
