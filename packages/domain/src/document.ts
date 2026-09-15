import { calculateLine, type LineInput, type LineResult } from "./line.ts";
import {
  MAX_DOCUMENT_ABS_CENTS,
  MAX_LINES,
  MONEY_SCHEMA_VERSION,
  domainError,
  toSafeCents,
  type UsdCents,
} from "./money.ts";

export type TaxRateSummary = {
  tax_bp: number;
  net_cents: UsdCents;
  tax_cents: UsdCents;
};

export type DocumentTotals = {
  schema_version: typeof MONEY_SCHEMA_VERSION;
  lines: LineResult[];
  net_cents: UsdCents;
  tax_cents: UsdCents;
  total_cents: UsdCents;
  tax_by_rate: TaxRateSummary[];
};

export function calculateDocument(
  lines: readonly LineInput[],
  options: { require_positive_net: boolean } = { require_positive_net: true },
): DocumentTotals {
  if (lines.length === 0) {
    throw domainError("VALIDATION_FAILED", "A document must have at least one line");
  }
  if (lines.length > MAX_LINES) {
    throw domainError("VALIDATION_FAILED", "At most 100 lines per document");
  }

  const calculated = lines.map((line) => calculateLine(line));
  let net = 0n;
  let tax = 0n;
  const byRate = new Map<number, { net: bigint; tax: bigint }>();
  for (const line of calculated) {
    net += BigInt(line.net_cents);
    tax += BigInt(line.tax_cents);
    const bucket = byRate.get(line.tax_bp) ?? { net: 0n, tax: 0n };
    bucket.net += BigInt(line.net_cents);
    bucket.tax += BigInt(line.tax_cents);
    byRate.set(line.tax_bp, bucket);
  }
  const total = net + tax;
  if (total > MAX_DOCUMENT_ABS_CENTS) {
    throw domainError("VALIDATION_FAILED", "Document total exceeds 999999999 cents");
  }
  if (options.require_positive_net && net <= 0n) {
    throw domainError("VALIDATION_FAILED", "A quote must have at least one positive net line");
  }

  const tax_by_rate = [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tax_bp, bucket]) => ({
      tax_bp,
      net_cents: toSafeCents(bucket.net, "net_cents"),
      tax_cents: toSafeCents(bucket.tax, "tax_cents"),
    }));

  return {
    schema_version: MONEY_SCHEMA_VERSION,
    lines: calculated,
    net_cents: toSafeCents(net, "net_cents"),
    tax_cents: toSafeCents(tax, "tax_cents"),
    total_cents: toSafeCents(total, "total_cents"),
    tax_by_rate,
  };
}

export function calculateDraftDocument(lines: readonly LineInput[]): DocumentTotals {
  if (lines.length === 0) {
    return {
      schema_version: MONEY_SCHEMA_VERSION,
      lines: [],
      net_cents: toSafeCents(0n, "net_cents"),
      tax_cents: toSafeCents(0n, "tax_cents"),
      total_cents: toSafeCents(0n, "total_cents"),
      tax_by_rate: [],
    };
  }
  return calculateDocument(lines, { require_positive_net: false });
}
