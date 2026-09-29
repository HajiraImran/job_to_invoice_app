import { formatUsdCents, taxBpToPercentLabel, type LineUnit } from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import type { CatalogueItemRecord, ItemFormValues } from "./form.ts";

export const ITEM_SEARCH_DEBOUNCE_MS = 300;
export const ITEM_LIST_LIMIT = 25;
export const ITEM_GUTTER = 20;
export const ITEM_CONTROL_PT = 48;
export const ITEM_TARGET_MIN_PT = 44;
export const ITEM_PRIMARY_PT = 56;

export type ItemFilter = "active" | "archived";

export type ItemsListState =
  | { kind: "loading"; items: CatalogueItemRecord[]; showAdd: boolean; showRetry: boolean; refreshing: boolean; message?: string }
  | { kind: "empty"; items: CatalogueItemRecord[]; showAdd: boolean; showRetry: boolean; refreshing: boolean; message?: string }
  | { kind: "error"; items: CatalogueItemRecord[]; showAdd: boolean; showRetry: boolean; refreshing: boolean; message?: string }
  | { kind: "offline"; items: CatalogueItemRecord[]; showAdd: boolean; showRetry: boolean; refreshing: boolean; message?: string }
  | { kind: "access_expired"; items: CatalogueItemRecord[]; showAdd: boolean; showRetry: boolean; refreshing: boolean; message?: string }
  | { kind: "loaded"; items: CatalogueItemRecord[]; showAdd: boolean; showRetry: boolean; refreshing: boolean; message?: string };

export function presentItemsList(input: {
  authStatus: string;
  loading: boolean;
  loadedOnce: boolean;
  items: CatalogueItemRecord[];
  queryMatches?: boolean;
  error?: { message: string; retryable: boolean };
}): ItemsListState {
  const showAdd = input.authStatus === "authenticated";
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", items: [], showAdd: false, showRetry: false, refreshing: false };
  }
  if (input.authStatus === "offline_cached") {
    return { kind: "offline", items: [], showAdd: false, showRetry: true, refreshing: false };
  }
  if (input.loading && (!input.loadedOnce || input.queryMatches === false)) {
    return { kind: "loading", items: [], showAdd, showRetry: false, refreshing: false };
  }
  if (input.error && input.items.length > 0 && input.queryMatches !== false) {
    return {
      kind: "loaded",
      items: input.items,
      showAdd,
      showRetry: input.error.retryable,
      refreshing: input.loading,
      message: input.error.message,
    };
  }
  if (input.error && input.items.length === 0) {
    return {
      kind: "error",
      items: [],
      showAdd,
      showRetry: input.error.retryable,
      refreshing: false,
      message: input.error.message,
    };
  }
  if (input.items.length === 0) {
    if (input.loading) {
      return { kind: "loading", items: [], showAdd, showRetry: false, refreshing: false };
    }
    return { kind: "empty", items: [], showAdd, showRetry: false, refreshing: false };
  }
  return {
    kind: "loaded",
    items: input.items,
    showAdd,
    showRetry: false,
    refreshing: input.loading,
    message: input.error?.message,
  };
}

export function itemListAnnouncement(kind: ItemsListState["kind"]): string {
  if (kind === "loading") return copy.itemsLoading;
  if (kind === "empty") return copy.itemsEmpty;
  if (kind === "offline") return copy.itemsOfflineTitle;
  if (kind === "access_expired") return copy.accessExpired;
  if (kind === "error") return copy.itemsLoadError;
  return copy.itemsTitle;
}

export function itemQueryKey(state: ItemFilter, search: string): string {
  return `${state}\n${search}`;
}

export function itemSearchQuery(input: string): string {
  return input.trim();
}

export function itemResponseCurrent(generation: number, latest: number): boolean {
  return generation === latest;
}

export function appendItemPage(current: readonly CatalogueItemRecord[], page: readonly CatalogueItemRecord[]): CatalogueItemRecord[] {
  const seen = new Set(current.map((item) => item.id));
  const next = [...current];
  for (const item of page) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    next.push(item);
  }
  return next;
}

export function itemListPath(input: { state: ItemFilter; search: string; cursor?: string | null; limit?: number }): string {
  const params = new URLSearchParams();
  params.set("state", input.state);
  params.set("limit", String(input.limit ?? ITEM_LIST_LIMIT));
  const search = itemSearchQuery(input.search);
  if (search) {
    params.set("search", search);
  }
  if (input.cursor) {
    params.set("cursor", input.cursor);
  }
  return `/v1/items?${params.toString()}`;
}

export function itemPickerPath(search: string): string {
  const params = new URLSearchParams();
  params.set("state", "active");
  const trimmed = itemSearchQuery(search);
  if (trimmed) {
    params.set("search", trimmed);
  }
  return `/v1/items?${params.toString()}`;
}

export function itemUnitPhrase(unit: LineUnit, customLabel: string | null): string {
  if (unit === "hour") return copy.itemsPerHour;
  if (unit === "day") return copy.itemsPerDay;
  if (unit === "square_foot") return copy.itemsPerSquareFoot;
  if (unit === "linear_foot") return copy.itemsPerLinearFoot;
  if (unit === "custom") {
    const label = customLabel?.trim();
    return label ? `${copy.itemsPerPrefix} ${label}` : copy.itemsPerCustom;
  }
  return copy.itemsPerItem;
}

export function itemTaxChip(taxBp: number): string {
  return `${copy.itemsTaxPrefix} ${taxBpToPercentLabel(taxBp)}%`;
}

export function itemPriceChip(cents: number): string {
  return formatUsdCents(cents);
}

export function itemListRow(item: CatalogueItemRecord): {
  description: string;
  unit: string;
  price: string;
  tax: string;
  archived: boolean;
} {
  return {
    description: item.description,
    unit: itemUnitPhrase(item.unit, item.custom_unit_label),
    price: itemPriceChip(item.unit_price_cents),
    tax: itemTaxChip(item.tax_bp),
    archived: Boolean(item.archived_at),
  };
}

export function itemEmptyCopy(state: ItemFilter): { title: string; body: string } {
  if (state === "archived") {
    return { title: copy.itemsEmptyArchived, body: copy.itemsEmptyArchivedBody };
  }
  return { title: copy.itemsEmptyActive, body: copy.itemsEmptyActiveBody };
}

export function itemIdempotencyAfterFailure(previous: string | undefined, code: string | undefined): string | undefined {
  if (code === "UNAVAILABLE" || code === "RATE_LIMITED" || code === "DATABASE_TIMEOUT" || code === "DATABASE_UNAVAILABLE") {
    return previous;
  }
  return undefined;
}

export function itemSubmitBlocked(saving: boolean): boolean {
  return saving;
}

export function itemMutationAllowed(status: string): boolean {
  return status === "authenticated";
}

export function itemArchiveBody(archived: boolean): { archived: boolean } {
  return { archived };
}

export function itemPatchRequest(item: Pick<CatalogueItemRecord, "id" | "version">, body: Record<string, unknown>) {
  return {
    path: `/v1/items/${item.id}`,
    method: "PATCH" as const,
    ifMatch: item.version,
    body,
  };
}

export function itemArchiveRequest(item: Pick<CatalogueItemRecord, "id" | "version">, archived: boolean) {
  return {
    path: `/v1/items/${item.id}/archive`,
    method: "POST" as const,
    ifMatch: item.version,
    body: itemArchiveBody(archived),
  };
}

export function itemDetailClears(status: string): boolean {
  return status === "access_expired";
}

export function itemNotFound(status: number | undefined, code: string | undefined): boolean {
  return status === 404 || code === "NOT_FOUND";
}

export function itemConflict(code: string | undefined): boolean {
  return code === "VERSION_CONFLICT";
}

export function activePickerItems(items: readonly CatalogueItemRecord[]): CatalogueItemRecord[] {
  return items.filter((item) => !item.archived_at);
}

export function itemAnalyticsProperties(): Record<string, never> {
  return {};
}

export function itemFormShowsCustomLabel(values: Pick<ItemFormValues, "unit">): boolean {
  return values.unit === "custom";
}
