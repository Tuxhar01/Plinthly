import { describe, it, expect } from "vitest";
import { reconcileLandedCostZeroVariance } from "../../lib/workflow/landed-cost-reconciler";

describe("Section 10 Acceptance Test: TEST-ARITH-03 (Model A Landed Cost Reconciliation)", () => {
  it("enforces exact zero-variance landed cost equation: merchandise - discount + shipping + tax = total", () => {
    // 2500 - 500 + 1000 + 240 = 3240
    const result = reconcileLandedCostZeroVariance({
      merchandiseSubtotalCents: 2500,
      discountCents: 500,
      shippingTotalCents: 1000,
      taxAmountCents: 240,
      totalCartCents: 3240,
    });

    expect(result.valid).toBe(true);
    expect(result.varianceCents).toBe(BigInt(0));
    expect(result.computedTotalCents).toBe(BigInt(3240));
    expect(result.declaredTotalCents).toBe(BigInt(3240));
  });

  it("strictly rejects 1-cent variance fail-closed (variance = 1 cent)", () => {
    expect(() =>
      reconcileLandedCostZeroVariance({
        merchandiseSubtotalCents: 2500,
        discountCents: 500,
        shippingTotalCents: 1000,
        taxAmountCents: 240,
        totalCartCents: 3241, // 1 cent extra!
      })
    ).toThrow("ERR_LANDED_COST_VARIANCE");
  });

  it("strictly rejects negative financial components", () => {
    expect(() =>
      reconcileLandedCostZeroVariance({
        merchandiseSubtotalCents: -2500,
        discountCents: 0,
        shippingTotalCents: 0,
        taxAmountCents: 0,
        totalCartCents: 0,
      })
    ).toThrow("ERR_INVALID_AMOUNT");
  });

  it("strictly rejects promotional discounts exceeding merchandise subtotal", () => {
    expect(() =>
      reconcileLandedCostZeroVariance({
        merchandiseSubtotalCents: 1000,
        discountCents: 1500, // discount > subtotal
        shippingTotalCents: 500,
        taxAmountCents: 0,
        totalCartCents: 0,
      })
    ).toThrow("ERR_INVALID_DISCOUNT");
  });
});

