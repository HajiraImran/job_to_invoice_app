import { describe, expect, it } from "vitest";
import {
  CATALOGUE_SEED_DESCRIPTIONS,
  emptyCatalogueItem,
  parseCatalogueItemCreate,
  parseCatalogueItemPatch,
  parseItemArchive,
  parseItemListQuery,
} from "./item.ts";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";

function validItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    description: "Labour hour",
    unit: "hour",
    default_quantity: "1",
    unit_price_cents: 0,
    discount_cents: 0,
    tax_bp: 0,
    ...overrides,
  };
}

describe("CAT01 catalogue items", () => {
  it("parses a zero-price seed item and rejects floats or live-link fields", () => {
    expect(parseCatalogueItemCreate(validItem()).ok).toBe(true);
    expect(parseCatalogueItemCreate(validItem({ unit_price_cents: 10.5 })).ok).toBe(false);
    expect(parseCatalogueItemCreate(validItem({ discount_cents: 1.25 })).ok).toBe(false);
    expect(parseCatalogueItemCreate(validItem({ catalogue_item_id: ITEM_ID })).ok).toBe(false);
    expect(parseCatalogueItemCreate(validItem({ workspace_id: ITEM_ID })).ok).toBe(false);
    expect(CATALOGUE_SEED_DESCRIPTIONS).toEqual([
      "Labour hour",
      "Materials",
      "Small repair",
      "Installation",
      "Disposal",
    ]);
  });

  it("requires a client UUID and a positive three-decimal quantity", () => {
    expect(parseCatalogueItemCreate(validItem({ id: "not-a-uuid" })).ok).toBe(false);
    expect(parseCatalogueItemCreate(validItem({ default_quantity: "0" })).ok).toBe(false);
    expect(parseCatalogueItemCreate(validItem({ default_quantity: "1.0001" })).ok).toBe(false);
    expect(parseCatalogueItemCreate(validItem({ default_quantity: 1 })).ok).toBe(false);
  });

  it("requires a custom unit label only for custom units", () => {
    expect(parseCatalogueItemCreate(validItem({ unit: "custom" })).ok).toBe(false);
    expect(
      parseCatalogueItemCreate(validItem({ unit: "custom", custom_unit_label: "bag" })).ok,
    ).toBe(true);
    expect(parseCatalogueItemCreate(validItem({ custom_unit_label: "bag" })).ok).toBe(false);
  });

  it("parses a versioned patch and archive body without unknown fields", () => {
    const { id: _id, ...body } = validItem({ unit_price_cents: 10000 });
    expect(parseCatalogueItemPatch(body).ok).toBe(true);
    expect(parseCatalogueItemPatch({ ...body, id: ITEM_ID }).ok).toBe(false);
    expect(parseItemArchive({ archived: true }).ok).toBe(true);
    expect(parseItemArchive({ archived: false, extra: true }).ok).toBe(false);
    expect(emptyCatalogueItem(ITEM_ID).unit_price_cents).toBe(0);
  });

  it("defaults a blank list query to active most-recently-updated items", () => {
    const parsed = parseItemListQuery({});
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({ cursor: null, limit: 25, search: null, state: "active" });
    }
    expect(parseItemListQuery({ state: "archived", search: "labour" }).ok).toBe(true);
    expect(parseItemListQuery({ unknown: true }).ok).toBe(false);
  });
});
