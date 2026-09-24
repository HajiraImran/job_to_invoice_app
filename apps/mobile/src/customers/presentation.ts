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

export type CustomerListKind = "loading" | "empty" | "error" | "offline" | "access_expired" | "loaded";

export function presentCustomerList(input: {
  authStatus: string;
  loading: boolean;
  loadedOnce: boolean;
  customers: CustomerRecord[];
  error?: { message: string; retryable: boolean };
}): {
  kind: CustomerListKind;
  customers: CustomerRecord[];
  showAdd: boolean;
  showRetry: boolean;
  message?: string;
} {
  const showAdd = input.authStatus === "authenticated";
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", customers: [], showAdd: false, showRetry: false };
  }
  if (input.authStatus === "offline_cached") {
    return { kind: "offline", customers: [], showAdd: false, showRetry: false, message: input.error?.message };
  }
  if (input.loading && !input.loadedOnce) {
    return { kind: "loading", customers: [], showAdd, showRetry: false };
  }
  if (input.error && input.customers.length === 0) {
    return { kind: "error", customers: [], showAdd, showRetry: input.error.retryable, message: input.error.message };
  }
  if (input.customers.length === 0) {
    return { kind: "empty", customers: [], showAdd, showRetry: false };
  }
  return { kind: "loaded", customers: input.customers, showAdd, showRetry: false };
}

export function customerListAnnouncement(kind: CustomerListKind): string {
  if (kind === "loading") return "Loading customers";
  if (kind === "empty") return "No customers in this list";
  if (kind === "error") return "Could not load customers";
  if (kind === "offline") return "Reconnect to view customers";
  if (kind === "access_expired") return "Sign in to view customers";
  return "Customers loaded";
}

export function formatBillingAddress(address: CustomerRecord["billing_address"]): string {
  if (!address) return "";
  const line2 = address.line2 ? `${address.line2}, ` : "";
  return `${address.line1}, ${line2}${address.city}, ${address.state} ${address.postal_code}`;
}
