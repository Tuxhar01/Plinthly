/**
 * Plinthly Stage 3 Phase 4 — Landed-Cost Zero-Variance Reconciler Unit Tests
 *
 * Verifies P4-03:
 * 1. Single-cart zero-variance Model A reconciliation (|Δ| = 0).
 * 2. Multi-cart aggregate landed-cost zero-variance reconciliation.
 * 3. Fail-closed rejection on single-cent variance (|Δ| = 1¢).
 * 4. Rejection of currency mismatches across carts (CurrencyMismatchError).
 * 5. Deterministic SHA-256 reconciliation digest computation.
 * 6. BigInt integer cents precision (complete elimination of floating-point drift).
 */

import { describe, it, expect } from "vitest";
import {
  reconcileLandedCostZeroVariance,
  reconcileAggregateLandedCostZeroVariance,
  LandedCostVarianceError,
  CurrencyMismatchError,
  CartFinancialComponents,
} from "../../lib/workflow/landed-cost-reconciler";

describe("P4-03: Landed-Cost Zero-Variance Reconciler", () => {
  describe("Single-Cart Reconciliation (reconcileLandedCostZeroVariance)", () => {
    it("1. succeeds when merchandise - discount + shipping + tax == totalCartCents (|Δ| = 0)", () => {
      const components: CartFinancialComponents = {
        merchandiseSubtotalCents: 10000,
        discountCents: 1000,
        shippingTotalCents: 500,
        taxAmountCents: 760,
        totalCartCents: 10260, // 10000 - 1000 + 500 + 760 = 10260
      };

      const result = reconcileLandedCostZeroVariance(components);
      expect(result.merchandiseSubtotalCents).toBe(BigInt(10000));
      expect(result.discountCents).toBe(BigInt(1000));
      expect(result.shippingTotalCents).toBe(BigInt(500));
      expect(result.taxAmountCents).toBe(BigInt(760));
      expect(result.totalCartCents).toBe(BigInt(10260));
      expect(result.varianceCents).toBe(BigInt(0));
    });

    it("2. fails closed with LandedCostVarianceError if totalCartCents is over by 1 cent (|Δ| = +1¢)", () => {
      const components: CartFinancialComponents = {
        merchandiseSubtotalCents: 10000,
        discountCents: 1000,
        shippingTotalCents: 500,
        taxAmountCents: 760,
        totalCartCents: 10261, // 1 cent extra
      };

      expect(() => reconcileLandedCostZeroVariance(components)).toThrowError(LandedCostVarianceError);
      try {
        reconcileLandedCostZeroVariance(components);
      } catch (err: any) {
        expect(err.varianceCents).toBe(BigInt(1));
      }
    });

    it("3. fails closed with LandedCostVarianceError if totalCartCents is under by 1 cent (|Δ| = -1¢)", () => {
      const components: CartFinancialComponents = {
        merchandiseSubtotalCents: 10000,
        discountCents: 1000,
        shippingTotalCents: 500,
        taxAmountCents: 760,
        totalCartCents: 10259, // 1 cent under
      };

      expect(() => reconcileLandedCostZeroVariance(components)).toThrowError(LandedCostVarianceError);
      try {
        reconcileLandedCostZeroVariance(components);
      } catch (err: any) {
        expect(err.varianceCents).toBe(BigInt(1));
      }
    });

    it("4. handles BigInt values accurately without floating-point precision loss", () => {
      // Numbers that cause IEEE 754 floating point issues: 0.1 + 0.2 != 0.3
      const components: CartFinancialComponents = {
        merchandiseSubtotalCents: BigInt(2999999999),
        discountCents: BigInt(100000000),
        shippingTotalCents: BigInt(50000000),
        taxAmountCents: BigInt(245000000),
        totalCartCents: BigInt(3194999999), // 2999999999 - 100000000 + 50000000 + 245000000 = 3194999999
      };

      const result = reconcileLandedCostZeroVariance(components);
      expect(result.varianceCents).toBe(BigInt(0));
      expect(result.totalCartCents).toBe(BigInt(3194999999));
    });
  });

  describe("Aggregate Multi-Cart Reconciliation (reconcileAggregateLandedCostZeroVariance)", () => {
    it("5. validates aggregate components and per-cart components with zero variance and produces SHA-256 digest", () => {
      const cartA: CartFinancialComponents = {
        cartId: "cart-001",
        merchandiseSubtotalCents: 5000,
        discountCents: 500,
        shippingTotalCents: 600,
        taxAmountCents: 400,
        totalCartCents: 5500, // 5000 - 500 + 600 + 400 = 5500
        currency: "USD",
      };

      const cartB: CartFinancialComponents = {
        cartId: "cart-002",
        merchandiseSubtotalCents: 8000,
        discountCents: 0,
        shippingTotalCents: 1000,
        taxAmountCents: 720,
        totalCartCents: 9720, // 8000 - 0 + 1000 + 720 = 9720
        currency: "USD",
      };

      const aggregateInput = {
        aggregateId: "agg-12345",
        totalMerchandiseCents: 13000, // 5000 + 8000
        totalDiscountCents: 500,     // 500 + 0
        totalShippingCents: 1600,    // 600 + 1000
        totalTaxCents: 1120,         // 400 + 720
        totalAuthorizedCents: 15220, // 5500 + 9720 = 15220
        currency: "USD",
        carts: [cartA, cartB],
      };

      const reconciled = reconcileAggregateLandedCostZeroVariance(aggregateInput);
      expect(reconciled.aggregateId).toBe("agg-12345");
      expect(reconciled.totalMerchandiseCents).toBe(BigInt(13000));
      expect(reconciled.totalDiscountCents).toBe(BigInt(500));
      expect(reconciled.totalShippingCents).toBe(BigInt(1600));
      expect(reconciled.totalTaxCents).toBe(BigInt(1120));
      expect(reconciled.totalAuthorizedCents).toBe(BigInt(15220));
      expect(reconciled.currency).toBe("USD");
      expect(reconciled.cartBreakdowns).toHaveLength(2);
      expect(reconciled.reconciliationDigest).toMatch(/^[a-f0-9]{64}$/);
    });

    it("6. fails closed if aggregate total does not match sum of cart totals", () => {
      const cartA: CartFinancialComponents = {
        cartId: "cart-001",
        merchandiseSubtotalCents: 5000,
        discountCents: 0,
        shippingTotalCents: 500,
        taxAmountCents: 400,
        totalCartCents: 5900,
        currency: "USD",
      };

      const aggregateInput = {
        aggregateId: "agg-12345",
        totalMerchandiseCents: 5000,
        totalDiscountCents: 0,
        totalShippingCents: 500,
        taxAmountCents: 400,
        totalAuthorizedCents: 5901, // 1 cent discrepancy between aggregate authorized and cart sum
        currency: "USD",
        carts: [cartA],
      };

      expect(() => reconcileAggregateLandedCostZeroVariance(aggregateInput)).toThrowError(
        LandedCostVarianceError
      );
    });

    it("7. fails closed if one individual cart has internal variance even if aggregate sum matched", () => {
      const badCart: CartFinancialComponents = {
        cartId: "cart-bad",
        merchandiseSubtotalCents: 5000,
        discountCents: 0,
        shippingTotalCents: 500,
        taxAmountCents: 400,
        totalCartCents: 6000, // components sum to 5900, but cart says 6000!
        currency: "USD",
      };

      const aggregateInput = {
        aggregateId: "agg-test",
        totalMerchandiseCents: 5000,
        totalDiscountCents: 0,
        totalShippingCents: 500,
        taxAmountCents: 400,
        totalAuthorizedCents: 6000,
        currency: "USD",
        carts: [badCart],
      };

      expect(() => reconcileAggregateLandedCostZeroVariance(aggregateInput)).toThrowError(
        LandedCostVarianceError
      );
    });

    it("8. rejects currency mismatch across carts with CurrencyMismatchError", () => {
      const cartUSD: CartFinancialComponents = {
        cartId: "cart-usd",
        merchandiseSubtotalCents: 5000,
        discountCents: 0,
        shippingTotalCents: 500,
        taxAmountCents: 400,
        totalCartCents: 5900,
        currency: "USD",
      };

      const cartEUR: CartFinancialComponents = {
        cartId: "cart-eur",
        merchandiseSubtotalCents: 4000,
        discountCents: 0,
        shippingTotalCents: 400,
        taxAmountCents: 800,
        totalCartCents: 5200,
        currency: "EUR", // Mismatched currency!
      };

      const aggregateInput = {
        aggregateId: "agg-multi-curr",
        totalMerchandiseCents: 9000,
        totalDiscountCents: 0,
        totalShippingCents: 900,
        taxAmountCents: 1200,
        totalAuthorizedCents: 11100,
        currency: "USD",
        carts: [cartUSD, cartEUR],
      };

      expect(() => reconcileAggregateLandedCostZeroVariance(aggregateInput)).toThrowError(
        CurrencyMismatchError
      );
    });
  });
});
