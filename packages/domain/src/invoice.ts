import {
  MAX_DOCUMENT_ABS_CENTS,
  MAX_LINES,
  MONEY_SCHEMA_VERSION,
  assertIntegerCents,
  domainError,
  toSafeCents,
  type UsdCents,
} from "./money.ts";

export type ResidualInvoiceLine = {
  source_line_id: string;
  residual_net_cents: number;
  residual_tax_cents: number;
};

export type InvoiceLineResult = {
  source_line_id: string;
  net_cents: UsdCents;
  tax_cents: UsdCents;
  total_cents: UsdCents;
};

export type InvoiceTotals = {
  schema_version: typeof MONEY_SCHEMA_VERSION;
  agreed_job_total_cents: UsdCents;
  invoice_issued_cents: UsdCents;
  credits_cents: UsdCents;
  net_cents: UsdCents;
  tax_cents: UsdCents;
  total_cents: UsdCents;
  lines: InvoiceLineResult[];
};

export function calculateInvoiceFromResiduals(
  lines: readonly ResidualInvoiceLine[],
  options: { agreed_job_total_cents: number; credits_cents?: number } = { agreed_job_total_cents: 0 },
): InvoiceTotals {
  if (lines.length === 0) {
    throw domainError("VALIDATION_FAILED", "An invoice must retain its source lines");
  }
  if (lines.length > MAX_LINES) {
    throw domainError("VALIDATION_FAILED", "At most 100 lines per document");
  }
  const agreed = assertIntegerCents(options.agreed_job_total_cents, "agreed_job_total_cents");
  const credits = assertIntegerCents(options.credits_cents ?? 0, "credits_cents");
  if (agreed < 0n) {
    throw domainError("VALIDATION_FAILED", "Agreed job total cannot be negative", "agreed_job_total_cents");
  }
  if (credits < 0n) {
    throw domainError("VALIDATION_FAILED", "Credits cannot be negative", "credits_cents");
  }

  const seen = new Set<string>();
  const calculated: InvoiceLineResult[] = [];
  let net = 0n;
  let tax = 0n;
  for (const line of lines) {
    if (seen.has(line.source_line_id)) {
      throw domainError("VALIDATION_FAILED", "Invoice source line identifiers must be unique", "source_line_id");
    }
    seen.add(line.source_line_id);
    const residualNet = assertIntegerCents(line.residual_net_cents, "residual_net_cents");
    const residualTax = assertIntegerCents(line.residual_tax_cents, "residual_tax_cents");
    if (residualNet < 0n || residualTax < 0n) {
      throw domainError("VALIDATION_FAILED", "Invoice residual amounts cannot be negative");
    }
    const lineTotal = residualNet + residualTax;
    calculated.push({
      source_line_id: line.source_line_id,
      net_cents: toSafeCents(residualNet, "net_cents"),
      tax_cents: toSafeCents(residualTax, "tax_cents"),
      total_cents: toSafeCents(lineTotal, "total_cents"),
    });
    net += residualNet;
    tax += residualTax;
  }
  const total = net + tax;
  if (total > MAX_DOCUMENT_ABS_CENTS) {
    throw domainError("VALIDATION_FAILED", "Document total exceeds 999999999 cents");
  }
  if (credits > total && total !== 0n) {
    throw domainError("CREDIT_EXCEEDS_SOURCE", "Issued credits cannot exceed the invoice issued total", "credits_cents");
  }
  if (total === 0n && credits > 0n) {
    throw domainError("CREDIT_EXCEEDS_SOURCE", "Issued credits cannot exceed the invoice issued total", "credits_cents");
  }

  return {
    schema_version: MONEY_SCHEMA_VERSION,
    agreed_job_total_cents: toSafeCents(agreed, "agreed_job_total_cents"),
    invoice_issued_cents: toSafeCents(total, "invoice_issued_cents"),
    credits_cents: toSafeCents(credits, "credits_cents"),
    net_cents: toSafeCents(net, "net_cents"),
    tax_cents: toSafeCents(tax, "tax_cents"),
    total_cents: toSafeCents(total, "total_cents"),
    lines: calculated,
  };
}
