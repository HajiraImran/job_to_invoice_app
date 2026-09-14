import { calculateDocument } from "./document.ts";
import { type LineInput, type LineResult } from "./line.ts";
import {
  MAX_DOCUMENT_ABS_CENTS,
  MAX_LINES,
  MONEY_SCHEMA_VERSION,
  assertIntegerCents,
  domainError,
  toSafeCents,
  toSafeSignedCents,
  type UsdCents,
} from "./money.ts";
import { applyReduction, type ReductionResult, type SourceLine } from "./reduction.ts";

export type ChangeOrderInput = {
  previous_total_cents: number;
  additions: readonly LineInput[];
  reductions: readonly { source_line_id: string; net_credit_cents: number }[];
  sources: readonly SourceLine[];
  reason?: string | null;
};

export type ChangeOrderResult = {
  schema_version: typeof MONEY_SCHEMA_VERSION;
  previous_total_cents: UsdCents;
  addition_net_cents: UsdCents;
  addition_tax_cents: UsdCents;
  addition_total_cents: UsdCents;
  reduction_net_cents: UsdCents;
  reduction_tax_cents: UsdCents;
  reduction_total_cents: UsdCents;
  change_including_tax_cents: number;
  new_agreed_total_cents: UsdCents;
  additions: LineResult[];
  reductions: ReductionResult[];
  reason: string | null;
};

export function calculateChangeOrder(input: ChangeOrderInput): ChangeOrderResult {
  const previous = assertIntegerCents(input.previous_total_cents, "previous_total_cents");
  if (previous < 0n) {
    throw domainError("VALIDATION_FAILED", "Previous agreed total cannot be negative", "previous_total_cents");
  }
  if (input.additions.length + input.reductions.length === 0) {
    throw domainError("VALIDATION_FAILED", "A change order must contain an addition or a reduction");
  }
  if (input.additions.length + input.reductions.length > MAX_LINES) {
    throw domainError("VALIDATION_FAILED", "At most 100 lines per document");
  }

  const additionDoc =
    input.additions.length === 0
      ? {
          lines: [] as LineResult[],
          net_cents: toSafeCents(0n, "addition_net_cents"),
          tax_cents: toSafeCents(0n, "addition_tax_cents"),
          total_cents: toSafeCents(0n, "addition_total_cents"),
        }
      : calculateDocument(input.additions, { require_positive_net: false });

  const sources = new Map(input.sources.map((source) => [source.source_line_id, source]));
  if (sources.size !== input.sources.length) {
    throw domainError("VALIDATION_FAILED", "Source line identifiers must be unique", "source_line_id");
  }

  const working = new Map(
    [...sources.entries()].map(([id, source]) => [id, { ...source }]),
  );
  const reductionResults: ReductionResult[] = [];
  let reductionNet = 0n;
  let reductionTax = 0n;
  for (const reduction of input.reductions) {
    const current = working.get(reduction.source_line_id);
    if (!current) {
      throw domainError(
        "VALIDATION_FAILED",
        "Reduction must reference an approved source line on this job",
        "source_line_id",
      );
    }
    const result = applyReduction(current, reduction.net_credit_cents);
    reductionResults.push(result);
    current.accepted_net_reductions_cents = result.cumulative_net_reductions_cents;
    reductionNet += BigInt(result.net_reduction_cents);
    reductionTax += BigInt(result.tax_reduction_cents);
  }

  const additionTotal = BigInt(additionDoc.total_cents);
  const reductionTotal = reductionNet + reductionTax;
  const changeIncludingTax = additionTotal - reductionTotal;
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  if (changeIncludingTax === 0n && reason === null) {
    throw domainError(
      "VALIDATION_FAILED",
      "A zero-value change requires a written reason for the scope replacement",
      "reason",
    );
  }
  const newAgreed = previous + changeIncludingTax;
  if (newAgreed < 0n) {
    throw domainError("VALIDATION_FAILED", "Agreed job total cannot go below zero", "new_agreed_total_cents");
  }
  if (newAgreed > MAX_DOCUMENT_ABS_CENTS) {
    throw domainError("VALIDATION_FAILED", "Document total exceeds 999999999 cents", "new_agreed_total_cents");
  }

  return {
    schema_version: MONEY_SCHEMA_VERSION,
    previous_total_cents: toSafeCents(previous, "previous_total_cents"),
    addition_net_cents: toSafeCents(BigInt(additionDoc.net_cents), "addition_net_cents"),
    addition_tax_cents: toSafeCents(BigInt(additionDoc.tax_cents), "addition_tax_cents"),
    addition_total_cents: toSafeCents(additionTotal, "addition_total_cents"),
    reduction_net_cents: toSafeCents(reductionNet, "reduction_net_cents"),
    reduction_tax_cents: toSafeCents(reductionTax, "reduction_tax_cents"),
    reduction_total_cents: toSafeCents(reductionTotal, "reduction_total_cents"),
    change_including_tax_cents: toSafeSignedCents(changeIncludingTax, "change_including_tax_cents"),
    new_agreed_total_cents: toSafeCents(newAgreed, "new_agreed_total_cents"),
    additions: additionDoc.lines,
    reductions: reductionResults,
    reason,
  };
}
