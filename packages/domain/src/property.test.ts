import { describe, expect, it } from "vitest";
import {
  applySequentialReductions,
  calculateDocument,
  calculateLine,
  canonicalize,
  taxOnNet,
} from "./index.ts";

function splitMix64(seed: bigint): () => bigint {
  let state = seed;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = state;
    z = (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n;
    z &= 0xffffffffffffffffn;
    z = (z ^ (z >> 27n)) * 0x94d049bb133111ebn;
    z &= 0xffffffffffffffffn;
    return z ^ (z >> 31n);
  };
}

function randInt(next: () => bigint, min: bigint, max: bigint): bigint {
  const span = max - min + 1n;
  return min + (next() % span);
}

function partition(next: () => bigint, total: bigint): bigint[] {
  if (total === 0n) {
    return [];
  }
  const parts: bigint[] = [];
  let remaining = total;
  while (remaining > 0n) {
    const take = randInt(next, 1n, remaining);
    parts.push(take);
    remaining -= take;
  }
  return parts;
}

function shuffle<T>(next: () => bigint, values: readonly T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const j = Number(next() % BigInt(index + 1));
    const current = copy[index];
    const swap = copy[j];
    if (current === undefined || swap === undefined) {
      continue;
    }
    copy[index] = swap;
    copy[j] = current;
  }
  return copy;
}

describe("financial property tests", () => {
  it("remaining source net and tax stay nonnegative and a full credit reverses all tax", () => {
    const next = splitMix64(0x51ed_f105n);
    for (let i = 0; i < 200; i += 1) {
      const net = randInt(next, 1n, 20000n);
      const taxBp = randInt(next, 0n, 2500n);
      const tax = taxOnNet(net, taxBp);
      const parts = partition(next, net);
      const results = applySequentialReductions(
        {
          source_line_id: `src-${i}`,
          original_net_cents: Number(net),
          original_tax_cents: Number(tax),
          accepted_net_reductions_cents: 0,
        },
        parts.map((part) => Number(part)),
      );
      for (const result of results) {
        expect(result.remaining_net_cents).toBeGreaterThanOrEqual(0);
        expect(result.remaining_tax_cents).toBeGreaterThanOrEqual(0);
      }
      const last = results[results.length - 1];
      expect(last?.remaining_net_cents).toBe(0);
      expect(last?.remaining_tax_cents).toBe(0);
      const taxSum = results.reduce((sum, result) => sum + result.tax_reduction_cents, 0);
      expect(taxSum).toBe(Number(tax));
    }
  });

  it("document totals are associative under line permutation", () => {
    const next = splitMix64(0x0dd1n);
    for (let i = 0; i < 50; i += 1) {
      const lines = Array.from({ length: Number(randInt(next, 2n, 8n)) }, () => ({
        quantity: `${Number(randInt(next, 1n, 50n))}.${Number(randInt(next, 0n, 999n)).toString().padStart(3, "0")}`,
        unit_price_cents: Number(randInt(next, 0n, 250000n)),
        discount_cents: 0,
        tax_bp: Number(randInt(next, 0n, 2500n)),
      }));
      if (lines.every((line) => line.unit_price_cents === 0)) {
        const first = lines[0];
        if (first) {
          first.unit_price_cents = 1;
        }
      }
      const base = calculateDocument(lines);
      const shuffled = calculateDocument(shuffle(next, lines));
      expect(shuffled.net_cents).toBe(base.net_cents);
      expect(shuffled.tax_cents).toBe(base.tax_cents);
      expect(shuffled.total_cents).toBe(base.total_cents);
    }
  });

  it("retries of the same inputs are invariant", () => {
    const input = { quantity: "2.5", unit_price_cents: 10000, discount_cents: 1000, tax_bp: 825 };
    const first = canonicalize(calculateLine(input));
    for (let i = 0; i < 20; i += 1) {
      expect(canonicalize(calculateLine(input))).toBe(first);
    }
    const document = canonicalize(
      calculateDocument([
        input,
        { quantity: "1", unit_price_cents: 10000, discount_cents: 0, tax_bp: 825 },
      ]),
    );
    for (let i = 0; i < 20; i += 1) {
      expect(
        canonicalize(
          calculateDocument([
            input,
            { quantity: "1", unit_price_cents: 10000, discount_cents: 0, tax_bp: 825 },
          ]),
        ),
      ).toBe(document);
    }
  });
});
