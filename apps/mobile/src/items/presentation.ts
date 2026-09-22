import type { CatalogueItemRecord } from "./form.ts";

export type ItemsListState =
  | { kind: "loading"; items: CatalogueItemRecord[]; showAdd: boolean; showRetry: boolean; message?: string }
  | { kind: "empty"; items: CatalogueItemRecord[]; showAdd: boolean; showRetry: boolean; message?: string }
  | { kind: "error"; items: CatalogueItemRecord[]; showAdd: boolean; showRetry: boolean; message?: string }
  | { kind: "offline"; items: CatalogueItemRecord[]; showAdd: boolean; showRetry: boolean; message?: string }
  | { kind: "access_expired"; items: CatalogueItemRecord[]; showAdd: boolean; showRetry: boolean; message?: string }
  | { kind: "loaded"; items: CatalogueItemRecord[]; showAdd: boolean; showRetry: boolean; message?: string };

export function presentItemsList(input: {
  authStatus: string;
  loading: boolean;
  loadedOnce: boolean;
  items: CatalogueItemRecord[];
  error?: { message: string; retryable: boolean };
}): ItemsListState {
  const showAdd = input.authStatus === "authenticated";
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", items: input.items, showAdd: false, showRetry: false };
  }
  if (input.authStatus === "offline_cached") {
    return {
      kind: "offline",
      items: input.items,
      showAdd: false,
      showRetry: true,
      message: input.error?.message,
    };
  }
  if (input.loading && !input.loadedOnce) {
    return { kind: "loading", items: input.items, showAdd, showRetry: false };
  }
  if (input.error && input.items.length === 0) {
    return {
      kind: "error",
      items: input.items,
      showAdd,
      showRetry: input.error.retryable,
      message: input.error.message,
    };
  }
  if (input.items.length === 0) {
    return { kind: "empty", items: [], showAdd, showRetry: false };
  }
  return {
    kind: "loaded",
    items: input.items,
    showAdd,
    showRetry: Boolean(input.error),
    message: input.error?.message,
  };
}
