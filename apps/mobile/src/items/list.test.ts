import { analyticsPropertiesAreSafe, parseCatalogueItemCreate } from "@job-to-invoice/schemas";
import { describe, expect, it } from "vitest";
import { emptyItemForm, itemCreateFromForm, itemPatchFromForm, lineFromCatalogueItem, type CatalogueItemRecord } from "./form.ts";
import {
  ITEM_LIST_LIMIT,
  ITEM_SEARCH_DEBOUNCE_MS,
  activePickerItems,
  appendItemPage,
  itemAnalyticsProperties,
  itemArchiveBody,
  itemArchiveRequest,
  itemConflict,
  itemEmptyCopy,
  itemIdempotencyAfterFailure,
  itemListPath,
  itemListRow,
  itemNotFound,
  itemPatchRequest,
  itemPickerPath,
  itemQueryKey,
  itemResponseCurrent,
  itemSearchQuery,
  itemSubmitBlocked,
  presentItemsList,
} from "./presentation.ts";

const ID = "11111111-1111-4111-8111-111111111111";

const item = (extra: Partial<CatalogueItemRecord> = {}): CatalogueItemRecord => ({
  id: ID,
  description: "Labour hour",
  unit: "hour",
  custom_unit_label: null,
  default_quantity: "1.000",
  unit_price_cents: 0,
  discount_cents: 0,
  tax_bp: 0,
  archived_at: null,
  version: 3,
  created_at: "2026-09-22T00:00:00.000Z",
  updated_at: "2026-09-22T00:00:00.000Z",
  ...extra,
});

const base = emptyItemForm();

describe("items list presentation", () => {
  it("keeps active as the default path and binds the cursor to search and state", () => {
    expect(ITEM_SEARCH_DEBOUNCE_MS).toBe(300);
    expect(ITEM_LIST_LIMIT).toBe(25);
    expect(itemSearchQuery("  Labour  ")).toBe("Labour");
    expect(itemQueryKey("active", "Labour")).toBe("active\nLabour");
    expect(itemListPath({ state: "active", search: " Labour " })).toBe("/v1/items?state=active&limit=25&search=Labour");
    expect(itemListPath({ state: "archived", search: "", cursor: "cursor-1" })).toContain("state=archived");
    expect(itemListPath({ state: "archived", search: "", cursor: "cursor-1" })).toContain("cursor=cursor-1");
    expect(itemListPath({ state: "active", search: "tile", cursor: "old" })).not.toBe(
      itemListPath({ state: "archived", search: "tile", cursor: "old" }),
    );
  });

  it("ignores a stale page and appends only new ids", () => {
    expect(itemResponseCurrent(2, 2)).toBe(true);
    expect(itemResponseCurrent(1, 2)).toBe(false);
    const first = item();
    const second = item({ id: "22222222-2222-4222-8222-222222222222", description: "Materials" });
    expect(appendItemPage([first], [first, second])).toEqual([first, second]);
  });

  it("retains authorized rows after a refresh error and separates first-load failure from empty", () => {
    const rows = [item()];
    const refresh = presentItemsList({
      authStatus: "authenticated",
      loading: false,
      loadedOnce: true,
      items: rows,
      queryMatches: true,
      error: { message: "Could not load items. Try again.", retryable: true },
    });
    expect(refresh.kind).toBe("loaded");
    expect(refresh.items).toEqual(rows);
    expect(refresh.showRetry).toBe(true);
    const firstFailure = presentItemsList({
      authStatus: "authenticated",
      loading: false,
      loadedOnce: true,
      items: [],
      error: { message: "Could not load items. Try again.", retryable: true },
    });
    expect(firstFailure.kind).toBe("error");
    expect(firstFailure.items).toEqual([]);
    expect(presentItemsList({ authStatus: "authenticated", loading: false, loadedOnce: true, items: [] }).kind).toBe(
      "empty",
    );
    expect(itemEmptyCopy("archived").title).toBe("No archived items");
    expect(itemEmptyCopy("active").title).toBe("No saved items");
  });

  it("hides add and previously loaded rows when offline or access has expired", () => {
    const loaded = [item({ unit_price_cents: 4500, description: "Private rate" })];
    const offline = presentItemsList({
      authStatus: "offline_cached",
      loading: false,
      loadedOnce: true,
      items: loaded,
    });
    expect(offline.kind).toBe("offline");
    expect(offline.items).toEqual([]);
    expect(offline.showAdd).toBe(false);
    expect(offline.showRetry).toBe(true);
    const expired = presentItemsList({
      authStatus: "access_expired",
      loading: false,
      loadedOnce: true,
      items: loaded,
    });
    expect(expired.items).toEqual([]);
    expect(expired.showAdd).toBe(false);
    expect(expired.showRetry).toBe(false);
  });

  it("shows production row fields and an archived text badge", () => {
    const row = itemListRow(item({ archived_at: "2026-09-22T00:00:00.000Z", tax_bp: 825, unit_price_cents: 1250 }));
    expect(row).toEqual({
      description: "Labour hour",
      unit: "per hour",
      price: "$12.50",
      tax: "Tax 8.25%",
      archived: true,
    });
    expect(itemListRow(item()).price).toBe("$0.00");
  });

  it("offers only active items from the picker", () => {
    expect(itemPickerPath(" bolt ")).toBe("/v1/items?state=active&search=bolt");
    expect(itemPickerPath("")).not.toContain("archived");
    const archived = item({ archived_at: "2026-09-22T00:00:00.000Z" });
    expect(activePickerItems([item(), archived])).toEqual([item()]);
  });
});

describe("item validation and commands", () => {
  it("accepts schema bounds and rejects invalid quantity, cents, tax, and custom labels", () => {
    const created = itemCreateFromForm({ ...base, description: "Tile", unit: "item" }, ID);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.unit_price_cents).toBe(0);
      expect(created.value.discount_cents).toBe(0);
      expect(created.value.tax_bp).toBe(0);
      expect(created.value).not.toHaveProperty("workspace_id");
      expect(created.value).not.toHaveProperty("catalogue_item_id");
      expect(created.value).not.toHaveProperty("version");
      expect(created.value).not.toHaveProperty("archived_at");
    }
    expect(itemCreateFromForm({ ...base, description: "Tile", default_quantity: "999999.999" }, ID).ok).toBe(true);
    expect(itemCreateFromForm({ ...base, description: "Tile", default_quantity: "0" }, ID).ok).toBe(false);
    expect(itemCreateFromForm({ ...base, description: "Tile", default_quantity: "1.2345" }, ID).ok).toBe(false);
    expect(itemCreateFromForm({ ...base, description: "Tile", default_quantity: "1000000" }, ID).ok).toBe(false);
    expect(itemCreateFromForm({ ...base, description: "Tile", unit_price: "999999.99" }, ID).ok).toBe(true);
    expect(itemCreateFromForm({ ...base, description: "Tile", unit_price: "1000000.00" }, ID).ok).toBe(false);
    expect(itemCreateFromForm({ ...base, description: "Tile", unit_price: "12.555" }, ID).ok).toBe(false);
    expect(itemCreateFromForm({ ...base, description: "Tile", discount: "-1" }, ID).ok).toBe(false);
    expect(itemCreateFromForm({ ...base, description: "Tile", tax_percent: "25" }, ID).ok).toBe(true);
    expect(itemCreateFromForm({ ...base, description: "Tile", tax_percent: "25.01" }, ID).ok).toBe(false);
    expect(itemCreateFromForm({ ...base, description: "Tile", unit: "custom", custom_unit_label: "bag" }, ID).ok).toBe(
      true,
    );
    expect(itemCreateFromForm({ ...base, description: "Tile", unit: "custom", custom_unit_label: "" }, ID).ok).toBe(
      false,
    );
    expect(itemCreateFromForm({ ...base, description: "" }, ID).ok).toBe(false);
    const rejected = parseCatalogueItemCreate({
      id: ID,
      description: "Tile",
      unit: "item",
      custom_unit_label: "bag",
      default_quantity: "1",
      unit_price_cents: 0,
      discount_cents: 0,
      tax_bp: 0,
    });
    expect(rejected.ok).toBe(false);
  });

  it("builds patch and archive requests with If-Match and blocks duplicate submits", () => {
    const current = item();
    const patch = itemPatchFromForm({ ...base, description: "Labour hour", unit: "hour", unit_price: "10.00" });
    expect(patch.ok).toBe(true);
    if (!patch.ok) {
      return;
    }
    expect(itemPatchRequest(current, patch.value)).toEqual({
      path: `/v1/items/${ID}`,
      method: "PATCH",
      ifMatch: 3,
      body: patch.value,
    });
    expect(itemArchiveRequest(current, true)).toEqual({
      path: `/v1/items/${ID}/archive`,
      method: "POST",
      ifMatch: 3,
      body: { archived: true },
    });
    expect(itemArchiveBody(false)).toEqual({ archived: false });
    expect(itemSubmitBlocked(true)).toBe(true);
    expect(itemSubmitBlocked(false)).toBe(false);
    expect(itemIdempotencyAfterFailure("key-1", "UNAVAILABLE")).toBe("key-1");
    expect(itemIdempotencyAfterFailure("key-1", "RATE_LIMITED")).toBe("key-1");
    expect(itemIdempotencyAfterFailure("key-1", "VALIDATION_FAILED")).toBeUndefined();
    expect(itemConflict("VERSION_CONFLICT")).toBe(true);
    expect(itemNotFound(404, "NOT_FOUND")).toBe(true);
  });

  it("copies catalogue defaults without a live link and leaves that copy unchanged", () => {
    const source = item({ unit_price_cents: 6400, discount_cents: 100, tax_bp: 800, default_quantity: "2.500" });
    const line = lineFromCatalogueItem(source, "44444444-4444-4444-8444-444444444444");
    source.description = "Edited catalogue";
    source.unit_price_cents = 9000;
    expect(line.description).toBe("Labour hour");
    expect(line.unit_price).toBe("64");
    expect(line.discount).toBe("1");
    expect(line.tax_percent).toBe("8");
    expect(line.quantity).toBe("2.5");
    expect(JSON.stringify(line)).not.toContain("catalogue_item_id");
  });

  it("emits no analytics properties", () => {
    expect(itemAnalyticsProperties()).toEqual({});
    expect(analyticsPropertiesAreSafe(itemAnalyticsProperties())).toBe(true);
  });
});
