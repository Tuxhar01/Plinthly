import { CandidateFacts } from "./types";
import {
  InvalidDecimalFormatError,
  AmountOutOfBoundsError,
} from "../contracts/stage2-errors";

export const MAX_CENTS = 2147483647;

export const PG_BIGINT_MIN = BigInt("-9223372036854775808");
export const PG_BIGINT_MAX = BigInt("9223372036854775807");
export const MAX_CART_CENTS = BigInt("999999999"); // $9,999,999.99

const ZERO_BIGINT = BigInt(0);
const HUNDRED_BIGINT = BigInt(100);

export const CANONICAL_UNSIGNED_DECIMAL_REGEX = /^(0|[1-9][0-9]*)(\.[0-9]{2})?$/;
export const CANONICAL_SIGNED_DECIMAL_REGEX = /^-?(0|[1-9][0-9]*)(\.[0-9]{2})?$/;
export const CANONICAL_NEGATIVE_ZERO_REGEX = /^-0(\.00)?$/;

export const CANONICAL_UNSIGNED_DECIMAL_PATTERN = "^(0|[1-9][0-9]*)(\\.[0-9]{2})?$";
export const CANONICAL_SIGNED_DECIMAL_PATTERN = "^-?(0|[1-9][0-9]*)(\\.[0-9]{2})?$";

export interface DecimalParserOptions {
  readonly signed?: boolean;
  readonly minCents?: bigint;
  readonly maxCents?: bigint;
}

/**
 * Deterministic string-to-cents BigInt parser implementing Section 7.3 of Contract v2.0.11.
 * Completely eliminates binary floating-point representation drift (e.g. 19.99 * 100 = 1998.9999999999998).
 *
 * Enforces:
 * 1. Strict canonical regex syntax: ^(0|[1-9][0-9]*)(\.[0-9]{2})?$ (or signed counterpart)
 * 2. Rejection of negative zero ("-0", "-0.00") with ERR_INVALID_DECIMAL_FORMAT (22023)
 * 3. Rejection of negative amounts on unsigned parser with ERR_AMOUNT_OUT_OF_BOUNDS (22003)
 * 4. Rejection of invalid formatting (leading zeros, whitespace, exponent, commas) with ERR_INVALID_DECIMAL_FORMAT (22023)
 * 5. Int64 bounds validation (-9223372036854775808 to 9223372036854775807) with ERR_AMOUNT_OUT_OF_BOUNDS (22003)
 */
export function parseDecimalStringToCents(
  input: string,
  options: DecimalParserOptions = {}
): bigint {
  if (typeof input !== "string" || input.length === 0) {
    throw new InvalidDecimalFormatError("Decimal monetary input must be a non-empty string.");
  }

  // Reject negative zero variants strictly under all parsing modes (Vectors 17, 18)
  if (CANONICAL_NEGATIVE_ZERO_REGEX.test(input)) {
    throw new InvalidDecimalFormatError("Negative zero is strictly prohibited in monetary inputs.");
  }

  const isSigned = options.signed === true;

  if (isSigned) {
    if (!CANONICAL_SIGNED_DECIMAL_REGEX.test(input)) {
      throw new InvalidDecimalFormatError(
        `Input "${input}" does not match canonical signed decimal regex: ${CANONICAL_SIGNED_DECIMAL_PATTERN}`
      );
    }
  } else {
    // If unsigned mode receives a negative number (e.g. Vector 19: "-15.00"),
    // check if it is syntactically a signed decimal to report ERR_AMOUNT_OUT_OF_BOUNDS
    if (input.startsWith("-")) {
      if (CANONICAL_SIGNED_DECIMAL_REGEX.test(input)) {
        throw new AmountOutOfBoundsError("Negative amount prohibited on unsigned inputs.");
      }
      throw new InvalidDecimalFormatError(
        `Input "${input}" does not match canonical non-negative decimal regex: ${CANONICAL_UNSIGNED_DECIMAL_PATTERN}`
      );
    }

    if (!CANONICAL_UNSIGNED_DECIMAL_REGEX.test(input)) {
      throw new InvalidDecimalFormatError(
        `Input "${input}" does not match canonical non-negative decimal regex: ${CANONICAL_UNSIGNED_DECIMAL_PATTERN}`
      );
    }
  }

  const isNegative = input.startsWith("-");
  const clean = isNegative ? input.slice(1) : input;

  let cents: bigint;
  if (clean.includes(".")) {
    const parts = clean.split(".");
    if (parts.length !== 2 || parts[1].length !== 2) {
      throw new InvalidDecimalFormatError("Monetary amounts with fractional separator must have exactly 2 decimal digits.");
    }
    const integerPart = BigInt(parts[0]);
    const fractionalPart = BigInt(parts[1]);
    cents = integerPart * HUNDRED_BIGINT + fractionalPart;
  } else {
    cents = BigInt(clean) * HUNDRED_BIGINT;
  }

  if (isNegative) {
    cents = -cents;
  }

  // PostgreSQL BIGINT bounds validation
  if (cents < PG_BIGINT_MIN || cents > PG_BIGINT_MAX) {
    throw new AmountOutOfBoundsError(
      `Parsed amount (${cents}) exceeds 64-bit signed integer (BIGINT) bounds.`
    );
  }

  if (options.minCents !== undefined && cents < options.minCents) {
    throw new AmountOutOfBoundsError(
      `Parsed amount (${cents}) is less than minimum permitted cents (${options.minCents}).`
    );
  }

  if (options.maxCents !== undefined && cents > options.maxCents) {
    throw new AmountOutOfBoundsError(
      `Parsed amount (${cents}) exceeds maximum permitted cents (${options.maxCents}).`
    );
  }

  return cents;
}

/**
 * Specialized parser for cart and payment capture amounts enforcing [0, 999999999] bounds.
 */
export function parseCartDecimalStringToCents(input: string): bigint {
  return parseDecimalStringToCents(input, {
    signed: false,
    minCents: ZERO_BIGINT,
    maxCents: MAX_CART_CENTS,
  });
}

/**
 * Formats minor units (cents) into canonical two-decimal string format.
 */
export function formatCentsToDecimal(cents: bigint | number): string {
  const bigCents = typeof cents === "bigint" ? cents : BigInt(cents);
  const isNegative = bigCents < ZERO_BIGINT;
  const absCents = isNegative ? -bigCents : bigCents;
  const integerPart = absCents / HUNDRED_BIGINT;
  const fractionalPart = absCents % HUNDRED_BIGINT;
  const fracStr = fractionalPart.toString().padStart(2, "0");
  const sign = isNegative ? "-" : "";
  return `${sign}${integerPart.toString()}.${fracStr}`;
}

export function assertCents(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`${name} cannot be negative, got ${value}`);
  }
  if (value > MAX_CENTS) {
    throw new Error(`${name} exceeds maximum allowed cents (${MAX_CENTS}), got ${value}`);
  }
}

export function deriveTotalCents(
  unitPriceCents: number,
  quantity: number,
  shippingCents: number
): number {
  assertCents("unitPriceCents", unitPriceCents);
  assertCents("shippingCents", shippingCents);

  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_CENTS) {
    throw new Error(`quantity must be an integer between 1 and ${MAX_CENTS}, got ${quantity}`);
  }

  const unitBig = BigInt(unitPriceCents);
  const qtyBig = BigInt(quantity);
  const shipBig = BigInt(shippingCents);
  const totalBig = unitBig * qtyBig + shipBig;

  if (totalBig > BigInt(MAX_CENTS)) {
    throw new Error(`Derived total cents (${totalBig}) exceeds maximum allowed cents (${MAX_CENTS})`);
  }

  return Number(totalBig);
}

export function validateCandidateMoney(
  candidate: Pick<CandidateFacts, "unitPriceCents" | "quantity" | "shippingCents" | "totalCents" | "currency">
): boolean {
  if (candidate.currency !== "USD") {
    return false;
  }
  if (
    typeof candidate.unitPriceCents !== "number" ||
    !Number.isInteger(candidate.unitPriceCents) ||
    candidate.unitPriceCents <= 0 ||
    candidate.unitPriceCents > MAX_CENTS
  ) {
    return false;
  }
  if (
    typeof candidate.quantity !== "number" ||
    !Number.isInteger(candidate.quantity) ||
    candidate.quantity < 1 ||
    candidate.quantity > MAX_CENTS
  ) {
    return false;
  }
  if (
    typeof candidate.shippingCents !== "number" ||
    !Number.isInteger(candidate.shippingCents) ||
    candidate.shippingCents < 0 ||
    candidate.shippingCents > MAX_CENTS
  ) {
    return false;
  }

  try {
    const derived = deriveTotalCents(candidate.unitPriceCents, candidate.quantity, candidate.shippingCents);
    return candidate.totalCents === derived;
  } catch {
    return false;
  }
}
