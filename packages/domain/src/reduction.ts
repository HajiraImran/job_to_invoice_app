import {
  MONEY_SCHEMA_VERSION,
  assertIntegerCents,
  domainError,
  roundHalfUpDiv,
  toSafeCents,
  type UsdCents,
} from "./money.ts";

export type SourceLine = {
  source_line_id: string;
  original_net_cents: number;
  original_tax_cents: number;
  accepted_net_reductions_cents: number;
};

export type ReductionResult = {
  schema_version: typeof MONEY_SCHEMA_VERSION;
  source_line_id: string;
  net_reduction_cents: UsdCents;
  tax_reduction_cents: UsdCents;
  total_reduction_cents: UsdCents;
  remaining_net_cents: UsdCents;
  remaining_tax_cents: UsdCents;
  cumulative_net_reductions_cents: UsdCents;
};

export function taxReductionFor(originalNet: bigint, originalTax: bigint, prior: bigint, next: bigint): bigint {
  if (originalNet <= 0n) {
    throw domainError("VALIDATION_FAILED", "A reducible source line cannot have zero net", "source_line_id");
  }
  if (next <= 0n) {
    throw domainError("VALIDATION_FAILED", "Reduction net must be positive cents", "net_credit_cents");
  }
  if (prior < 0n) {
    throw domainError("VALIDATION_FAILED", "Prior reductions cannot be negative", "accepted_net_reductions_cents");
  }
  if (prior + next > originalNet) {
    throw domainError(
      "CREDIT_EXCEEDS_SOURCE",
      "Cumulative net reductions cannot exceed the source net",
      "net_credit_cents",
    );
  }
  const after = roundHalfUpDiv(originalTax * (prior + next), originalNet);
  const before = roundHalfUpDiv(originalTax * prior, originalNet);
  return after - before;
}

export function remainingAfterReductions(
  originalNet: bigint,
  originalTax: bigint,
  reductions: readonly bigint[],
): { remainingNet: bigint; remainingTax: bigint; taxReductions: bigint[] } {
  let prior = 0n;
  const taxReductions: bigint[] = [];
  for (const reduction of reductions) {
    const tax = taxReductionFor(originalNet, originalTax, prior, reduction);
    taxReductions.push(tax);
    prior += reduction;
  }
  return {
    remainingNet: originalNet - prior,
    remainingTax:
      prior === 0n ? originalTax : originalTax - roundHalfUpDiv(originalTax * prior, originalNet),
    taxReductions,
  };
}

export function applyReduction(source: SourceLine, netCreditCents: number): ReductionResult {
  const originalNet = assertIntegerCents(source.original_net_cents, "original_net_cents");
  const originalTax = assertIntegerCents(source.original_tax_cents, "original_tax_cents");
  const prior = assertIntegerCents(source.accepted_net_reductions_cents, "accepted_net_reductions_cents");
  const next = assertIntegerCents(netCreditCents, "net_credit_cents");
  if (originalTax < 0n) {
    throw domainError("VALIDATION_FAILED", "Source tax cannot be negative", "original_tax_cents");
  }
  const tax = taxReductionFor(originalNet, originalTax, prior, next);
  const cumulative = prior + next;
  const remainingNet = originalNet - cumulative;
  const remainingTax = originalTax - roundHalfUpDiv(originalTax * cumulative, originalNet);
  return {
    schema_version: MONEY_SCHEMA_VERSION,
    source_line_id: source.source_line_id,
    net_reduction_cents: toSafeCents(next, "net_reduction_cents"),
    tax_reduction_cents: toSafeCents(tax, "tax_reduction_cents"),
    total_reduction_cents: toSafeCents(next + tax, "total_reduction_cents"),
    remaining_net_cents: toSafeCents(remainingNet, "remaining_net_cents"),
    remaining_tax_cents: toSafeCents(remainingTax, "remaining_tax_cents"),
    cumulative_net_reductions_cents: toSafeCents(cumulative, "cumulative_net_reductions_cents"),
  };
}

export function applySequentialReductions(source: SourceLine, netCredits: readonly number[]): ReductionResult[] {
  const results: ReductionResult[] = [];
  let prior = source.accepted_net_reductions_cents;
  for (const netCredit of netCredits) {
    const result = applyReduction({ ...source, accepted_net_reductions_cents: prior }, netCredit);
    results.push(result);
    prior = result.cumulative_net_reductions_cents;
  }
  return results;
}
