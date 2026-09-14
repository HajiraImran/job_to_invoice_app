export type UsdCents = number & { readonly __brand: "UsdCents" };

/** Foundation only. Product money rules (FIN01–FIN05) are not implemented here yet. */
export function usdCents(value: number): UsdCents {
  if (!Number.isInteger(value)) {
    throw new Error("USD amounts must be integer cents; JavaScript floats are forbidden");
  }
  return value as UsdCents;
}
