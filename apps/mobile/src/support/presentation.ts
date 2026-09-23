import { SUPPORT_CATEGORIES, type SupportCategory } from "@job-to-invoice/schemas";

export type SupportCaseRecord = {
  id: string;
  category: string;
  state: string;
  content_access_granted: boolean;
  content_access_expires_at: string | null;
  created_at: string | null;
  support_url: string | null;
  replayed?: boolean;
};

export type SupportViewKind = "offline" | "access_expired" | "form" | "submitting" | "submitted" | "error";

export function supportPath(): string {
  return "/(tabs)/settings/support";
}

export function supportCategories(): readonly SupportCategory[] {
  return SUPPORT_CATEGORIES;
}

export function presentSupport(input: {
  authStatus: string;
  submitting: boolean;
  submitted?: SupportCaseRecord | null;
  error?: string;
}): { kind: SupportViewKind; submitDisabled: boolean; message?: string } {
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", submitDisabled: true };
  }
  if (input.authStatus === "offline_cached") {
    return { kind: "offline", submitDisabled: true, message: input.error };
  }
  if (input.submitting) {
    return { kind: "submitting", submitDisabled: true };
  }
  if (input.submitted) {
    return { kind: "submitted", submitDisabled: true };
  }
  if (input.error) {
    return { kind: "error", submitDisabled: false, message: input.error };
  }
  return { kind: "form", submitDisabled: false };
}

export function categoryLabel(category: SupportCategory): string {
  switch (category) {
    case "account":
      return "Account";
    case "billing":
      return "Plan and billing";
    case "documents":
      return "Quotes and invoices";
    case "access":
      return "Customer review access";
    case "other":
      return "Something else";
  }
}
