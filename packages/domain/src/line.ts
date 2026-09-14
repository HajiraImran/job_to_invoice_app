import {
  MAX_DOCUMENT_ABS_CENTS,
  MAX_TAX_BP,
  MAX_UNIT_PRICE_CENTS,
  MONEY_SCHEMA_VERSION,
  QUANTITY_SCALE,
  TAX_DIVISOR,
  assertIntegerCents,
  domainError,
  formatQuantity,
  parseQuantity,
  roundHalfUpDiv,
  toSafeCents,
  type UsdCents,
} from "./money.ts";

export type LineInput = {
  client_line_id?: string | null;
  quantity: string;
  unit_price_cents: number;
  discount_cents: number;
  tax_bp: number;
};

export type LineResult = {
  schema_version: typeof MONEY_SCHEMA_VERSION;
  client_line_id: string | null;
  quantity: string;
  unit_price_cents: UsdCents;
  discount_cents: UsdCents;
  tax_bp: number;
  gross_cents: UsdCents;
  net_cents: UsdCents;
  tax_cents: UsdCents;
  total_cents: UsdCents;
};

export function taxOnNet(netCents: bigint, taxBp: bigint): bigint {
  return roundHalfUpDiv(netCents * taxBp, TAX_DIVISOR);
}

export function calculateLine(input: LineInput): LineResult {
  const milles = parseQuantity(input.quantity);
  const price = assertIntegerCents(input.unit_price_cents, "unit_price_cents");
  const discount = assertIntegerCents(input.discount_cents, "discount_cents");
  const taxBp = assertIntegerCents(input.tax_bp, "tax_bp");

  if (price < 0n || price > MAX_UNIT_PRICE_CENTS) {
    throw domainError("VALIDATION_FAILED", "Unit price must be 0 to 99999999 cents", "unit_price_cents");
  }
  if (discount < 0n) {
    throw domainError("VALIDATION_FAILED", "Discount cannot be negative", "discount_cents");
  }
  if (taxBp < 0n || taxBp > MAX_TAX_BP) {
    throw domainError("VALIDATION_FAILED", "Tax rate must be 0 to 2500 basis points", "tax_bp");
  }

  const gross = roundHalfUpDiv(milles * price, QUANTITY_SCALE);
  if (discount > gross) {
    throw domainError("VALIDATION_FAILED", "Fixed line discount cannot exceed rounded gross", "discount_cents");
  }
  const net = gross - discount;
  const tax = taxOnNet(net, taxBp);
  const total = net + tax;
  if (total > MAX_DOCUMENT_ABS_CENTS) {
    throw domainError("VALIDATION_FAILED", "Line total exceeds 999999999 cents", "total_cents");
  }

  return {
    schema_version: MONEY_SCHEMA_VERSION,
    client_line_id: input.client_line_id ?? null,
    quantity: formatQuantity(milles),
    unit_price_cents: toSafeCents(price, "unit_price_cents"),
    discount_cents: toSafeCents(discount, "discount_cents"),
    tax_bp: Number(taxBp),
    gross_cents: toSafeCents(gross, "gross_cents"),
    net_cents: toSafeCents(net, "net_cents"),
    tax_cents: toSafeCents(tax, "tax_cents"),
    total_cents: toSafeCents(total, "total_cents"),
  };
}
