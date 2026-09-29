import {
  dollarsStringToCents,
  parseCatalogueItemCreate,
  parseCatalogueItemPatch,
  parseTaxPercentToBp,
  taxBpToPercentLabel,
  type CatalogueItemInput,
  type LineUnit,
} from "@job-to-invoice/schemas";
import { centsToDollarsInput, type QuoteLineForm } from "../quotes/form.ts";

export type CatalogueItemRecord = {
  id: string;
  description: string;
  unit: LineUnit;
  custom_unit_label: string | null;
  default_quantity: string;
  unit_price_cents: number;
  discount_cents: number;
  tax_bp: number;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export type ItemFormValues = {
  description: string;
  unit: LineUnit;
  custom_unit_label: string;
  default_quantity: string;
  unit_price: string;
  discount: string;
  tax_percent: string;
};

export function emptyItemForm(): ItemFormValues {
  return {
    description: "",
    unit: "item",
    custom_unit_label: "",
    default_quantity: "1",
    unit_price: "0.00",
    discount: "0.00",
    tax_percent: "0.00",
  };
}

export function formFromItem(item: CatalogueItemRecord): ItemFormValues {
  return {
    description: item.description,
    unit: item.unit,
    custom_unit_label: item.custom_unit_label ?? "",
    default_quantity: item.default_quantity.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""),
    unit_price: centsToDollarsInput(item.unit_price_cents),
    discount: centsToDollarsInput(item.discount_cents),
    tax_percent: taxBpToPercentLabel(item.tax_bp),
  };
}

function moneyFields(values: ItemFormValues) {
  const price = dollarsStringToCents(values.unit_price);
  const discount = dollarsStringToCents(values.discount);
  const tax = parseTaxPercentToBp(values.tax_percent);
  return {
    description: values.description,
    unit: values.unit,
    ...(values.unit === "custom" ? { custom_unit_label: values.custom_unit_label } : {}),
    default_quantity: values.default_quantity.trim(),
    unit_price_cents: price.ok ? price.value : values.unit_price,
    discount_cents: discount.ok ? discount.value : values.discount,
    tax_bp: tax.ok ? tax.value : values.tax_percent,
  };
}

export function itemCreateFromForm(values: ItemFormValues, id: string) {
  return parseCatalogueItemCreate({ id, ...moneyFields(values) });
}

export function itemPatchFromForm(values: ItemFormValues) {
  return parseCatalogueItemPatch(moneyFields(values));
}

export function lineFromCatalogueItem(item: CatalogueItemRecord, clientLineId: string): QuoteLineForm {
  return {
    client_line_id: clientLineId,
    description: item.description,
    unit: item.unit,
    custom_unit_label: item.custom_unit_label ?? "",
    quantity: item.default_quantity.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") || "1",
    unit_price: centsToDollarsInput(item.unit_price_cents),
    discount: centsToDollarsInput(item.discount_cents),
    tax_percent: taxBpToPercentLabel(item.tax_bp),
  };
}

export function firstItemFieldError(errors: Record<string, string>): string | undefined {
  return Object.keys(errors)[0];
}

export function itemHasCatalogueId(line: QuoteLineForm | CatalogueItemInput): boolean {
  return "catalogue_item_id" in line;
}
