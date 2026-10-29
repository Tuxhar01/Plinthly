import { CandidateFacts } from "./types";

export const MAX_CENTS = 2147483647;

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
