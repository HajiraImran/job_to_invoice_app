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
  permitted_actions: string[];
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
      kind: input.items.length === 0 ? "offline" : "loaded",
      items: input.items,
      showRetry: true,
      showCreate: false,
      showOfflineBanner: true,
      showSearchDownloaded: input.searching,
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
  };
}

export function presentJobDetail(input: {
  authStatus: string;
  loading: boolean;
  job?: JobDetail;
  error?: { message: string; retryable: boolean; status: number };
}): {
  kind: "loading" | "error" | "missing" | "loaded" | "access_expired" | "offline";
  showRetry: boolean;
  job?: JobDetail;
  message?: string;
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
  return { kind: "loaded", showRetry: false, job: input.job };
}

export function nextActionCopy(mode: string, lifecycle: string): "quote" | "direct" | "none" {
  if (lifecycle !== "draft") {
    return "none";
  }
  return mode === "direct_invoice" ? "direct" : "quote";
}
