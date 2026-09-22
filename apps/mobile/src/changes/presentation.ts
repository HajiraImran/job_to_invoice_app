import { copy } from "../i18n/en.ts";

export type ChangeSource = {
  source_line_id: string;
  description: string;
  remaining_net_cents: number;
  remaining_tax_cents: number;
};

export type ChangeDraftRecord = {
  id: string;
  job_id: string;
  kind: string;
  draft_state: string;
  version: number;
  reason: string;
  expected_scope_version: number;
  expiry_days: number;
  additions: Array<{
    client_line_id: string;
    description: string;
    unit: string;
    custom_unit_label: string | null;
    quantity: string;
    unit_price_cents: number;
    discount_cents: number;
    tax_bp: number;
  }>;
  reductions: Array<{ source_line_id: string; net_credit_cents: number }>;
  sources: ChangeSource[];
  previous_total_cents: number;
  change_including_tax_cents: number;
  new_agreed_total_cents: number;
  default_tax_bp: number;
};

export type ChangeEditorKind = "loading" | "loaded" | "empty" | "error" | "offline" | "blocked";

export function presentChangeEditor(input: {
  authStatus: string;
  loading: boolean;
  draft?: ChangeDraftRecord;
  error?: { message: string; retryable: boolean; status: number; code?: string };
}): { kind: ChangeEditorKind; showRetry: boolean; message?: string; draft?: ChangeDraftRecord } {
  if (input.authStatus === "offline_cached") {
    return { kind: "offline", showRetry: true, message: copy.changeOffline, draft: input.draft };
  }
  if (input.loading && !input.draft) {
    return { kind: "loading", showRetry: false };
  }
  if (input.error && !input.draft) {
    if (input.error.code === "VALIDATION_FAILED" || input.error.status === 422) {
      return { kind: "blocked", showRetry: false, message: input.error.message || copy.changeBlocked };
    }
    return {
      kind: "error",
      showRetry: input.error.retryable || input.error.status === 0,
      message: input.error.message || copy.changeLoadError,
    };
  }
  if (!input.draft) {
    return { kind: "error", showRetry: true, message: copy.changeLoadError };
  }
  if (input.draft.additions.length + input.draft.reductions.length === 0) {
    return { kind: "empty", showRetry: false, draft: input.draft, message: copy.changeEmpty };
  }
  return { kind: "loaded", showRetry: false, draft: input.draft };
}

export function changeStatusLabel(lifecycle: string, requestState?: string | null): string {
  if (requestState === "pending" || lifecycle === "issued") {
    return copy.changePending;
  }
  if (requestState === "approved" || lifecycle === "accepted") {
    return copy.changeApproved;
  }
  if (requestState === "declined" || lifecycle === "declined") {
    return copy.changeDeclined;
  }
  return lifecycle;
}
