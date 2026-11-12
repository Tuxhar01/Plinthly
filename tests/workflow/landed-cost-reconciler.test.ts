import { describe, it, expect } from "vitest";
import {
  reconcileLandedCostZeroVariance,
  LandedCostVarianceError,
} from "../../lib/workflow/landed-cost-reconciler";

describe("Phase 4: Model A Landed Cost Zero-Variance Reconciler (TEST-ARITH-03)", () => {
  it("successfully validates landed cost when equation holds with 0 cents variance", () => {
    // 2500 - 500 + 350 + 200 = 2550
    const result = reconcileLandedCostZeroVariance({
      merchandiseSubtotalCents: 2500,
      discountCents: 500,
      shippingTotalCents: 350,
      taxAmountCents: 200,
      totalCartCents: 2550,
    });

    expect(result.valid).toBe(true);
    expect(result.varianceCents).toBe(BigInt(0));
    expect(result.computedTotalCents).toBe(BigInt(2550));
    expect(result.declaredTotalCents).toBe(BigInt(2550));
  });

  it("throws LandedCostVarianceError if declared total is even 1 cent higher than computed", () => {
    // Computed: 2500 - 500 + 350 + 200 = 2550; Declared: 2551 (1 cent higher)
    expect(() =>
      reconcileLandedCostZeroVariance({
        merchandiseSubtotalCents: 2500,
        discountCents: 500,
        shippingTotalCents: 350,
        taxAmountCents: 200,
        totalCartCents: 2551,
      })
    ).toThrow(LandedCostVarianceError);
  });

  it("throws LandedCostVarianceError if declared total is even 1 cent lower than computed", () => {
    // Computed: 2550; Declared: 2549 (1 cent lower)
    expect(() =>
      reconcileLandedCostZeroVariance({
        merchandiseSubtotalCents: 2500,
        discountCents: 500,
        shippingTotalCents: 350,
        taxAmountCents: 200,
        totalCartCents: 2549,
      })
    ).toThrow(LandedCostVarianceError);
  });

  it("enforces zero discount, zero shipping, zero tax base case", () => {
    const result = reconcileLandedCostZeroVariance({
      merchandiseSubtotalCents: 1000,
      discountCents: 0,
      shippingTotalCents: 0,
      taxAmountCents: 0,
      totalCartCents: 1000,
    });

    expect(result.valid).toBe(true);
    expect(result.computedTotalCents).toBe(BigInt(1000));
  });

  it("rejects negative merchandise subtotal", () => {
    expect(() =>
      reconcileLandedCostZeroVariance({
        merchandiseSubtotalCents: -100,
        discountCents: 0,
        shippingTotalCents: 0,
        taxAmountCents: 0,
        totalCartCents: -100,
      })
    ).toThrow("ERR_INVALID_AMOUNT");
  });

  it("rejects discount exceeding merchandise subtotal", () => {
    expect(() =>
      reconcileLandedCostZeroVariance({
        merchandiseSubtotalCents: 1000,
        discountCents: 1500,
        shippingTotalCents: 0,
        taxAmountCents: 0,
        totalCartCents: 0,
      })
    ).toThrow("ERR_INVALID_DISCOUNT");
  });
});
