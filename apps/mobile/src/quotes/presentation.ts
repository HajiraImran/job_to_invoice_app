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
