import { describe, expect, it } from "vitest";
import { emptyItemForm, formFromItem, itemCreateFromForm, itemHasCatalogueId, lineFromCatalogueItem } from "./form.ts";
import { presentItemsList } from "./presentation.ts";

const ITEM = {
  id: "11111111-1111-4111-8111-111111111111",
  description: "Labour hour",
  unit: "hour" as const,
  custom_unit_label: null,
  default_quantity: "1.000",
  unit_price_cents: 10000,
  discount_cents: 0,
  tax_bp: 825,
  archived_at: null,
  version: 2,
  created_at: "2026-09-22T00:00:00.000Z",
  updated_at: "2026-09-22T00:00:00.000Z",
};

describe("catalogue item form", () => {
  it("copies defaults into a new line without a live catalogue id", () => {
    const line = lineFromCatalogueItem(ITEM, "22222222-2222-4222-8222-222222222222");
    expect(line.description).toBe("Labour hour");
    expect(line.unit).toBe("hour");
    expect(line.quantity).toBe("1");
    expect(line.unit_price).toBe("100");
    expect(line.tax_percent).toBe("8.25");
    expect(itemHasCatalogueId(line)).toBe(false);
    expect(JSON.stringify(line)).not.toContain("catalogue_item_id");
  });

  it("rejects float prices and unknown live-link fields", () => {
    expect(itemCreateFromForm({ ...emptyItemForm(), description: "Tile", unit_price: "12.5" }, ITEM.id).ok).toBe(true);
    expect(itemCreateFromForm({ ...emptyItemForm(), description: "Tile", unit_price: "12.555" }, ITEM.id).ok).toBe(
      false,
    );
    expect(formFromItem(ITEM).unit_price).toBe("100");
  });
});

describe("items list states", () => {
  it("shows loading, empty, error, and loaded without hiding add", () => {
    expect(presentItemsList({ authStatus: "authenticated", loading: true, loadedOnce: false, items: [] }).kind).toBe(
      "loading",
    );
    expect(presentItemsList({ authStatus: "authenticated", loading: false, loadedOnce: true, items: [] }).kind).toBe(
      "empty",
    );
    expect(
      presentItemsList({
        authStatus: "authenticated",
        loading: false,
        loadedOnce: true,
        items: [],
        error: { message: "Could not load items. Try again.", retryable: true },
      }).kind,
    ).toBe("error");
    expect(
      presentItemsList({
        authStatus: "authenticated",
        loading: false,
        loadedOnce: true,
        items: [ITEM],
      }).kind,
    ).toBe("loaded");
    expect(presentItemsList({ authStatus: "access_expired", loading: false, loadedOnce: true, items: [] }).kind).toBe(
      "access_expired",
    );
  });
});
