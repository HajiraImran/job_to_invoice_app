import {
  MONEY_SCHEMA_VERSION,
  domainError,
  toSafeCents,
  type UsdCents,
} from "./money.ts";
import { applyReduction, type ReductionResult } from "./reduction.ts";

export type InvoiceCreditLine = {
  invoice_line_id: string;
  residual_net_cents: number;
  residual_tax_cents: number;
  credited_net_cents: number;
};

export type CreditAllocation = {
  invoice_line_id: string;
  net_credit_cents: number;
};

export type CreditResult = {
  schema_version: typeof MONEY_SCHEMA_VERSION;
  net_cents: UsdCents;
  tax_cents: UsdCents;
  total_cents: UsdCents;
  allocations: ReductionResult[];
};

export function calculateCredit(
  invoiceLines: readonly InvoiceCreditLine[],
  allocations: readonly CreditAllocation[],
): CreditResult {
  if (allocations.length === 0) {
    throw domainError("VALIDATION_FAILED", "A credit must allocate a positive net amount");
  }
  const lines = new Map(invoiceLines.map((line) => [line.invoice_line_id, line]));
  if (lines.size !== invoiceLines.length) {
    throw domainError("VALIDATION_FAILED", "Invoice line identifiers must be unique", "invoice_line_id");
  }
  const seen = new Set<string>();
  const results: ReductionResult[] = [];
  let net = 0n;
  let tax = 0n;
  for (const allocation of allocations) {
    if (seen.has(allocation.invoice_line_id)) {
      throw domainError("VALIDATION_FAILED", "A credit may allocate each invoice line only once", "invoice_line_id");
    }
    seen.add(allocation.invoice_line_id);
    const line = lines.get(allocation.invoice_line_id);
    if (!line) {
      throw domainError(
        "VALIDATION_FAILED",
        "Credit allocation must reference a line on this invoice",
        "invoice_line_id",
      );
    }
    const result = applyReduction(
      {
        source_line_id: line.invoice_line_id,
        original_net_cents: line.residual_net_cents,
        original_tax_cents: line.residual_tax_cents,
        accepted_net_reductions_cents: line.credited_net_cents,
      },
      allocation.net_credit_cents,
    );
    results.push(result);
    net += BigInt(result.net_reduction_cents);
    tax += BigInt(result.tax_reduction_cents);
  }
  if (net <= 0n) {
    throw domainError("VALIDATION_FAILED", "A credit cannot increase an invoice or record zero");
  }
  return {
    schema_version: MONEY_SCHEMA_VERSION,
    net_cents: toSafeCents(net, "net_cents"),
    tax_cents: toSafeCents(tax, "tax_cents"),
    total_cents: toSafeCents(net + tax, "total_cents"),
    allocations: results,
  };
}
