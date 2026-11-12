/**
 * Plinthly Stage 2 Phase 4 — Model A Landed Cost Zero-Variance Reconciler
 *
 * Enforces Model A Landed Cost Invariant (Contract v2.0.11 Section 1.1, 7.1.6):
 * merchandiseSubtotalCents - discountCents + shippingTotalCents + taxAmountCents = totalCartCents
 *
 * Strict Rule: Permitted variance is exactly 0 cents.
 * Any non-zero discrepancy rejects cart checkout preparation immediately.
 */

import crypto from "crypto";

export interface LandedCostBreakdown {
  merchandiseSubtotalCents: number | bigint;
  discountCents: number | bigint;
  shippingTotalCents: number | bigint;
  taxAmountCents: number | bigint;
  totalCartCents: number | bigint;
  currency?: string;
  cartId?: string;
}

export type CartFinancialComponents = LandedCostBreakdown;

export interface LandedCostReconciliationResult {
  valid: boolean;
  computedTotalCents: bigint;
  declaredTotalCents: bigint;
  varianceCents: bigint;
  merchandiseSubtotalCents: bigint;
  discountCents: bigint;
  shippingTotalCents: bigint;
  taxAmountCents: bigint;
  totalCartCents: bigint;
  reconciliationDigest?: string;
  breakdown: {
    merchandiseSubtotalCents: bigint;
    discountCents: bigint;
    shippingTotalCents: bigint;
    taxAmountCents: bigint;
    totalCartCents: bigint;
    currency?: string;
  };
}

export interface AggregateLandedCostBreakdown {
  aggregateId?: string;
  declaredAggregateTotalCents?: number | bigint;
  totalAuthorizedCents?: number | bigint;
  totalMerchandiseCents?: number | bigint;
  totalDiscountCents?: number | bigint;
  totalShippingCents?: number | bigint;
  totalTaxCents?: number | bigint;
  currency: string;
  carts: LandedCostBreakdown[];
}

export interface AggregateLandedCostReconciliationResult {
  valid: boolean;
  aggregateId?: string;
  currency: string;
  totalCarts: number;
  computedAggregateTotalCents: bigint;
  declaredAggregateTotalCents: bigint;
  totalAuthorizedCents: bigint;
  computedAggregateMerchandiseCents: bigint;
  totalMerchandiseCents: bigint;
  computedAggregateDiscountCents: bigint;
  totalDiscountCents: bigint;
  computedAggregateShippingCents: bigint;
  totalShippingCents: bigint;
  computedAggregateTaxCents: bigint;
  totalTaxCents: bigint;
  varianceCents: bigint;
  reconciliationDigest: string;
  cartBreakdowns: LandedCostReconciliationResult[];
}

export class LandedCostVarianceError extends Error {
  public readonly code = "ERR_LANDED_COST_VARIANCE";
  public readonly computedTotalCents: bigint;
  public readonly declaredTotalCents: bigint;
  public readonly varianceCents: bigint;

  constructor(
    message: string,
    computedTotalCents: bigint,
    declaredTotalCents: bigint,
    varianceCents: bigint
  ) {
    super(message);
    this.name = "LandedCostVarianceError";
    this.computedTotalCents = computedTotalCents;
    this.declaredTotalCents = declaredTotalCents;
    this.varianceCents = varianceCents;
  }
}

export class CurrencyMismatchError extends Error {
  public readonly code = "ERR_CURRENCY_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "CurrencyMismatchError";
  }
}

/**
 * Reconciles the landed cost components of a merchant cart with zero permitted variance.
 * Throws LandedCostVarianceError if computed total differs from declared total by even 1 cent.
 */
export function reconcileLandedCostZeroVariance(
  input: LandedCostBreakdown
): LandedCostReconciliationResult {
  const merchandise = BigInt(input.merchandiseSubtotalCents);
  const discount = BigInt(input.discountCents);
  const shipping = BigInt(input.shippingTotalCents);
  const tax = BigInt(input.taxAmountCents);
  const declaredTotal = BigInt(input.totalCartCents);

  const zero = BigInt(0);
  if (merchandise < zero) {
    throw new Error("ERR_INVALID_AMOUNT: merchandiseSubtotalCents cannot be negative");
  }
  if (discount < zero) {
    throw new Error("ERR_INVALID_AMOUNT: discountCents cannot be negative");
  }
  if (shipping < zero) {
    throw new Error("ERR_INVALID_AMOUNT: shippingTotalCents cannot be negative");
  }
  if (tax < zero) {
    throw new Error("ERR_INVALID_AMOUNT: taxAmountCents cannot be negative");
  }
  if (declaredTotal < zero) {
    throw new Error("ERR_INVALID_AMOUNT: totalCartCents cannot be negative");
  }
  if (discount > merchandise) {
    throw new Error("ERR_INVALID_DISCOUNT: discountCents cannot exceed merchandiseSubtotalCents");
  }

  // Model A Invariant: merchandise - discount + shipping + tax = total
  const computedTotal = merchandise - discount + shipping + tax;
  const variance = computedTotal > declaredTotal ? computedTotal - declaredTotal : declaredTotal - computedTotal;

  if (variance !== zero) {
    throw new LandedCostVarianceError(
      `ERR_LANDED_COST_VARIANCE: Landed cost equation violated. Computed ${computedTotal} cents, declared ${declaredTotal} cents. Variance: ${variance} cents (permitted: 0 cents).`,
      computedTotal,
      declaredTotal,
      variance
    );
  }

  const digestBuffer = `${input.cartId || "cart"}|${input.currency || "USD"}|${merchandise}|${discount}|${shipping}|${tax}|${declaredTotal}`;
  const reconciliationDigest = crypto.createHash("sha256").update(digestBuffer, "utf8").digest("hex");

  return {
    valid: true,
    computedTotalCents: computedTotal,
    declaredTotalCents: declaredTotal,
    varianceCents: zero,
    merchandiseSubtotalCents: merchandise,
    discountCents: discount,
    shippingTotalCents: shipping,
    taxAmountCents: tax,
    totalCartCents: declaredTotal,
    reconciliationDigest,
    breakdown: {
      merchandiseSubtotalCents: merchandise,
      discountCents: discount,
      shippingTotalCents: shipping,
      taxAmountCents: tax,
      totalCartCents: declaredTotal,
      currency: input.currency,
    },
  };
}

/**
 * Reconciles an aggregate multi-retailer order across all constituent merchant carts.
 * Enforces zero variance across aggregate totals, checks currency consistency, and
 * returns an immutable cryptographic reconciliation digest.
 */
export function reconcileAggregateLandedCostZeroVariance(
  input: AggregateLandedCostBreakdown
): AggregateLandedCostReconciliationResult {
  const zero = BigInt(0);
  const rawDeclared = input.declaredAggregateTotalCents ?? input.totalAuthorizedCents;

  if (rawDeclared === undefined || rawDeclared === null) {
    throw new Error("ERR_INVALID_AMOUNT: declaredAggregateTotalCents or totalAuthorizedCents must be provided");
  }

  const declaredAggregateTotal = BigInt(rawDeclared);

  if (declaredAggregateTotal < zero) {
    throw new Error("ERR_INVALID_AMOUNT: declaredAggregateTotalCents cannot be negative");
  }
  if (!input.currency || input.currency.trim().length !== 3) {
    throw new Error("ERR_INVALID_CURRENCY: currency must be a valid 3-letter ISO code");
  }
  if (!input.carts || input.carts.length === 0) {
    throw new Error("ERR_EMPTY_CARTS: Aggregate landed cost reconciliation requires at least one cart");
  }

  const normalizedCurrency = input.currency.toUpperCase().trim();
  const cartBreakdowns: LandedCostReconciliationResult[] = [];

  let sumMerch = zero;
  let sumDiscount = zero;
  let sumShipping = zero;
  let sumTax = zero;
  let sumDeclaredCartTotals = zero;

  for (let i = 0; i < input.carts.length; i++) {
    const cart = input.carts[i];
    if (cart.currency && cart.currency.toUpperCase().trim() !== normalizedCurrency) {
      throw new CurrencyMismatchError(
        `ERR_CURRENCY_MISMATCH: Cart at index ${i} has currency "${cart.currency}" which does not match aggregate currency "${normalizedCurrency}".`
      );
    }

    const singleResult = reconcileLandedCostZeroVariance({
      ...cart,
      currency: normalizedCurrency,
    });
    cartBreakdowns.push(singleResult);

    sumMerch += singleResult.breakdown.merchandiseSubtotalCents;
    sumDiscount += singleResult.breakdown.discountCents;
    sumShipping += singleResult.breakdown.shippingTotalCents;
    sumTax += singleResult.breakdown.taxAmountCents;
    sumDeclaredCartTotals += singleResult.breakdown.totalCartCents;
  }

  if (input.totalMerchandiseCents !== undefined) {
    const declaredMerch = BigInt(input.totalMerchandiseCents);
    if (declaredMerch !== sumMerch) {
      const v = declaredMerch > sumMerch ? declaredMerch - sumMerch : sumMerch - declaredMerch;
      throw new LandedCostVarianceError(
        `ERR_LANDED_COST_VARIANCE: Declared totalMerchandiseCents (${declaredMerch}) does not match sum of cart subtotals (${sumMerch}).`,
        sumMerch,
        declaredMerch,
        v
      );
    }
  }

  if (input.totalDiscountCents !== undefined) {
    const declaredDisc = BigInt(input.totalDiscountCents);
    if (declaredDisc !== sumDiscount) {
      const v = declaredDisc > sumDiscount ? declaredDisc - sumDiscount : sumDiscount - declaredDisc;
      throw new LandedCostVarianceError(
        `ERR_LANDED_COST_VARIANCE: Declared totalDiscountCents (${declaredDisc}) does not match sum of cart discounts (${sumDiscount}).`,
        sumDiscount,
        declaredDisc,
        v
      );
    }
  }

  if (input.totalShippingCents !== undefined) {
    const declaredShip = BigInt(input.totalShippingCents);
    if (declaredShip !== sumShipping) {
      const v = declaredShip > sumShipping ? declaredShip - sumShipping : sumShipping - declaredShip;
      throw new LandedCostVarianceError(
        `ERR_LANDED_COST_VARIANCE: Declared totalShippingCents (${declaredShip}) does not match sum of cart shipping totals (${sumShipping}).`,
        sumShipping,
        declaredShip,
        v
      );
    }
  }

  if (input.totalTaxCents !== undefined) {
    const declaredTax = BigInt(input.totalTaxCents);
    if (declaredTax !== sumTax) {
      const v = declaredTax > sumTax ? declaredTax - sumTax : sumTax - declaredTax;
      throw new LandedCostVarianceError(
        `ERR_LANDED_COST_VARIANCE: Declared totalTaxCents (${declaredTax}) does not match sum of cart statutory taxes (${sumTax}).`,
        sumTax,
        declaredTax,
        v
      );
    }
  }

  const computedAggregateTotal = sumMerch - sumDiscount + sumShipping + sumTax;
  const variance =
    computedAggregateTotal > declaredAggregateTotal
      ? computedAggregateTotal - declaredAggregateTotal
      : declaredAggregateTotal - computedAggregateTotal;

  if (variance !== zero) {
    throw new LandedCostVarianceError(
      `ERR_LANDED_COST_VARIANCE: Aggregate landed cost equation violated. Sum of cart totals is ${computedAggregateTotal} cents, declared aggregate total is ${declaredAggregateTotal} cents. Variance: ${variance} cents (permitted: 0 cents).`,
      computedAggregateTotal,
      declaredAggregateTotal,
      variance
    );
  }

  if (sumDeclaredCartTotals !== declaredAggregateTotal) {
    const cartSumVariance =
      sumDeclaredCartTotals > declaredAggregateTotal
        ? sumDeclaredCartTotals - declaredAggregateTotal
        : declaredAggregateTotal - sumDeclaredCartTotals;
    throw new LandedCostVarianceError(
      `ERR_LANDED_COST_VARIANCE: Sum of individual cart totalCartCents (${sumDeclaredCartTotals}) does not match declared aggregate total (${declaredAggregateTotal}). Variance: ${cartSumVariance} cents.`,
      sumDeclaredCartTotals,
      declaredAggregateTotal,
      cartSumVariance
    );
  }

  const aggregateDigestInput = [
    input.aggregateId || "agg",
    normalizedCurrency,
    declaredAggregateTotal.toString(),
    sumMerch.toString(),
    sumDiscount.toString(),
    sumShipping.toString(),
    sumTax.toString(),
    ...cartBreakdowns.map((c) => c.reconciliationDigest || ""),
  ].join("|");

  const reconciliationDigest = crypto.createHash("sha256").update(aggregateDigestInput, "utf8").digest("hex");

  return {
    valid: true,
    aggregateId: input.aggregateId,
    currency: normalizedCurrency,
    totalCarts: input.carts.length,
    computedAggregateTotalCents: computedAggregateTotal,
    declaredAggregateTotalCents: declaredAggregateTotal,
    totalAuthorizedCents: declaredAggregateTotal,
    computedAggregateMerchandiseCents: sumMerch,
    totalMerchandiseCents: sumMerch,
    computedAggregateDiscountCents: sumDiscount,
    totalDiscountCents: sumDiscount,
    computedAggregateShippingCents: sumShipping,
    totalShippingCents: sumShipping,
    computedAggregateTaxCents: sumTax,
    totalTaxCents: sumTax,
    varianceCents: zero,
    reconciliationDigest,
    cartBreakdowns,
  };
}
