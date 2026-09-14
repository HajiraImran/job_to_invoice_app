import { MONEY_ERROR_CODES, MONEY_SCHEMA_VERSION } from "@job-to-invoice/schemas";

export { MONEY_ERROR_CODES, MONEY_SCHEMA_VERSION };

export const QUANTITY_SCALE = 1000n;
export const TAX_DIVISOR = 10000n;
export const MAX_QUANTITY_MILLES = 999_999_999n;
export const MAX_UNIT_PRICE_CENTS = 99_999_999n;
export const MAX_DOCUMENT_ABS_CENTS = 999_999_999n;
export const MAX_TAX_BP = 2500n;
export const MAX_LINES = 100;
export const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

export type UsdCents = number & { readonly __brand: "UsdCents" };

export function usdCents(value: number): UsdCents {
  if (!Number.isInteger(value)) {
    throw new Error("USD amounts must be integer cents; JavaScript floats are forbidden");
  }
  return value as UsdCents;
}

export function assertIntegerCents(value: number, field: string): bigint {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw domainError("VALIDATION_FAILED", `${field} must be integer USD cents`, field);
  }
  return BigInt(value);
}

export function toSafeCents(value: bigint, field: string): UsdCents {
  if (value < 0n) {
    throw domainError("VALIDATION_FAILED", `${field} cannot be negative`, field);
  }
  return toSafeSignedCents(value, field) as UsdCents;
}

export function toSafeSignedCents(value: bigint, field: string): number {
  if (value > MAX_SAFE_CENTS || value < -MAX_SAFE_CENTS) {
    throw domainError(
      "VALIDATION_FAILED",
      `${field} exceeds serializable integer cents; schema revision required`,
      field,
    );
  }
  return Number(value);
}

export function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw domainError("VALIDATION_FAILED", "Division denominator must be positive");
  }
  if (numerator < 0n) {
    throw domainError("VALIDATION_FAILED", "Money numerators must be nonnegative");
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n >= denominator) {
    return quotient + 1n;
  }
  return quotient;
}

const QUANTITY_PATTERN = /^(0|[1-9]\d{0,5})(\.\d{1,3})?$/;

export function parseQuantity(raw: string): bigint {
  if (typeof raw !== "string" || !QUANTITY_PATTERN.test(raw)) {
    throw domainError(
      "VALIDATION_FAILED",
      "Quantity must be a decimal string with at most three places and no locale formatting",
      "quantity",
    );
  }
  const [whole, fraction = ""] = raw.split(".");
  const milles = BigInt(whole ?? "0") * QUANTITY_SCALE + BigInt((fraction + "000").slice(0, 3));
  if (milles <= 0n || milles > MAX_QUANTITY_MILLES) {
    throw domainError("VALIDATION_FAILED", "Quantity must be greater than 0 and at most 999999.999", "quantity");
  }
  return milles;
}

export function formatQuantity(milles: bigint): string {
  const whole = milles / QUANTITY_SCALE;
  const frac = milles % QUANTITY_SCALE;
  return `${whole.toString()}.${frac.toString().padStart(3, "0")}`;
}

export function domainError(code: string, message: string, field?: string): DomainError {
  return new DomainError(code, message, field);
}

export class DomainError extends Error {
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.field = field;
    Object.setPrototypeOf(this, DomainError.prototype);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
