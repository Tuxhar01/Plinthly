import { describe, it, expect } from "vitest";
import {
  allocatePromotionalDiscounts,
  DiscountableLineItem,
} from "../../lib/discovery/cart/allocation";
import {
  AmountOutOfBoundsError,
  MalformedNestedStructureError,
  STAGE2_ERROR_CODES,
  SQLSTATE_CODES,
} from "../../lib/contracts/stage2-errors";

describe("Stage 2 Deterministic Discount Allocation Algorithm (Contract v2.0.11 Sec 7.2)", () => {
  describe("Proportional Floor & Remainder Distribution", () => {
    it("should distribute discount evenly when subtotals are equal and remainder is zero", () => {
      const items: DiscountableLineItem[] = [
        { itemIndex: 0, unitPriceCents: 1000, quantity: 1 },
        { itemIndex: 1, unitPriceCents: 1000, quantity: 1 },
      ];
      // Total merchandise: 2000 cents, discount: 400 cents
      const result = allocatePromotionalDiscounts(items, 400);

      expect(result.merchandiseSubtotalCents).toBe(BigInt(2000));
      expect(result.requestedDiscountCents).toBe(BigInt(400));
      expect(result.effectiveDiscountCents).toBe(BigInt(400));
      expect(result.remainderCents).toBe(BigInt(0));

      expect(result.items[0].allocatedDiscountCents).toBe(BigInt(200));
      expect(result.items[0].taxableAmountCents).toBe(BigInt(800));
      expect(result.items[1].allocatedDiscountCents).toBe(BigInt(200));
      expect(result.items[1].taxableAmountCents).toBe(BigInt(800));
    });

    it("should break ties deterministically by (itemSubtotal DESC, itemIndex ASC) for 1-cent remainders", () => {
      // 3 items with equal subtotal ($15.00 each = 4500 cents total)
      // Discount: $10.00 (1000 cents)
      // Floor: floor(1000 * 1500 / 4500) = 333 cents each (sum = 999)
      // Remainder: 1 cent
      // Subtotals are equal -> tie-breaker is itemIndex ASC (itemIndex 0 gets the 1 cent)
      const items: DiscountableLineItem[] = [
        { itemIndex: 0, unitPriceCents: 1500, quantity: 1 },
        { itemIndex: 1, unitPriceCents: 1500, quantity: 1 },
        { itemIndex: 2, unitPriceCents: 1500, quantity: 1 },
      ];

      const result = allocatePromotionalDiscounts(items, 1000);

      expect(result.merchandiseSubtotalCents).toBe(BigInt(4500));
      expect(result.effectiveDiscountCents).toBe(BigInt(1000));
      expect(result.remainderCents).toBe(BigInt(1));

      expect(result.items[0].allocatedDiscountCents).toBe(BigInt(334));
      expect(result.items[0].taxableAmountCents).toBe(BigInt(1166));

      expect(result.items[1].allocatedDiscountCents).toBe(BigInt(333));
      expect(result.items[1].taxableAmountCents).toBe(BigInt(1167));

      expect(result.items[2].allocatedDiscountCents).toBe(BigInt(333));
      expect(result.items[2].taxableAmountCents).toBe(BigInt(1167));

      const totalAllocated = result.items.reduce((acc, curr) => acc + curr.allocatedDiscountCents, BigInt(0));
      expect(totalAllocated).toBe(BigInt(1000));
    });

    it("should prioritize items with larger subtotals before itemIndex in remainder distribution", () => {
      // Item 0: $10.00, Item 1: $20.00
      // Total merchandise: $30.00 (3000 cents)
      // Discount: $5.00 (500 cents)
      // Floor:
      //   Item 0: floor(500 * 1000 / 3000) = 166 cents
      //   Item 1: floor(500 * 2000 / 3000) = 333 cents
      // Sum = 499 cents. Remainder = 1 cent.
      // Tie-breaker: Item 1 has larger subtotal (2000 > 1000), so Item 1 gets the 1 cent!
      const items: DiscountableLineItem[] = [
        { itemIndex: 0, unitPriceCents: 1000, quantity: 1 },
        { itemIndex: 1, unitPriceCents: 2000, quantity: 1 },
      ];

      const result = allocatePromotionalDiscounts(items, 500);

      expect(result.merchandiseSubtotalCents).toBe(BigInt(3000));
      expect(result.effectiveDiscountCents).toBe(BigInt(500));
      expect(result.remainderCents).toBe(BigInt(1));

      expect(result.items[0].allocatedDiscountCents).toBe(BigInt(166));
      expect(result.items[0].taxableAmountCents).toBe(BigInt(834));

      expect(result.items[1].allocatedDiscountCents).toBe(BigInt(334));
      expect(result.items[1].taxableAmountCents).toBe(BigInt(1666));

      const totalAllocated = result.items.reduce((acc, curr) => acc + curr.allocatedDiscountCents, BigInt(0));
      expect(totalAllocated).toBe(BigInt(500));
    });

    it("should distribute multi-cent remainder correctly across mixed subtotals and indices", () => {
      // 4 items:
      // Item 0: subtotal 2000 (Index 0)
      // Item 1: subtotal 2000 (Index 1)
      // Item 2: subtotal 1000 (Index 2)
      // Item 3: subtotal 3000 (Index 3)
      // Total: 8000 cents
      // Discount: 700 cents (D_effective = 700)
      // Floor:
      //   Item 0: floor(700 * 2000 / 8000) = 175
      //   Item 1: floor(700 * 2000 / 8000) = 175
      //   Item 2: floor(700 * 1000 / 8000) = 87
      //   Item 3: floor(700 * 3000 / 8000) = 262
      // Sum of floor: 175 + 175 + 87 + 262 = 699 cents
      // Remainder: 1 cent
      // Subtotal rank: Item 3 (3000) is highest -> gets the 1 cent
      const items: DiscountableLineItem[] = [
        { itemIndex: 0, unitPriceCents: 2000, quantity: 1 },
        { itemIndex: 1, unitPriceCents: 2000, quantity: 1 },
        { itemIndex: 2, unitPriceCents: 1000, quantity: 1 },
        { itemIndex: 3, unitPriceCents: 3000, quantity: 1 },
      ];

      const result = allocatePromotionalDiscounts(items, 700);

      expect(result.items[0].allocatedDiscountCents).toBe(BigInt(175));
      expect(result.items[1].allocatedDiscountCents).toBe(BigInt(175));
      expect(result.items[2].allocatedDiscountCents).toBe(BigInt(87));
      expect(result.items[3].allocatedDiscountCents).toBe(BigInt(263)); // +1 remainder

      const totalAllocated = result.items.reduce((acc, curr) => acc + curr.allocatedDiscountCents, BigInt(0));
      expect(totalAllocated).toBe(BigInt(700));
    });
  });

  describe("Excess Discount Capping & Invariant Preservation", () => {
    it("should cap discount when discount exceeds merchandise subtotal (net merchandise cannot be negative)", () => {
      const items: DiscountableLineItem[] = [
        { itemIndex: 0, unitPriceCents: 1000, quantity: 1 },
        { itemIndex: 1, unitPriceCents: 1500, quantity: 1 },
      ];
      // Total merchandise: 2500 cents. Requested discount: 5000 cents.
      const result = allocatePromotionalDiscounts(items, 5000);

      expect(result.merchandiseSubtotalCents).toBe(BigInt(2500));
      expect(result.requestedDiscountCents).toBe(BigInt(5000));
      expect(result.effectiveDiscountCents).toBe(BigInt(2500)); // Capped

      expect(result.items[0].allocatedDiscountCents).toBe(BigInt(1000));
      expect(result.items[0].taxableAmountCents).toBe(BigInt(0));

      expect(result.items[1].allocatedDiscountCents).toBe(BigInt(1500));
      expect(result.items[1].taxableAmountCents).toBe(BigInt(0));

      const totalAllocated = result.items.reduce((acc, curr) => acc + curr.allocatedDiscountCents, BigInt(0));
      expect(totalAllocated).toBe(BigInt(2500));
    });

    it("should handle zero discount correctly", () => {
      const items: DiscountableLineItem[] = [
        { itemIndex: 0, unitPriceCents: 1999, quantity: 2 },
      ];
      const result = allocatePromotionalDiscounts(items, 0);

      expect(result.merchandiseSubtotalCents).toBe(BigInt(3998));
      expect(result.effectiveDiscountCents).toBe(BigInt(0));
      expect(result.items[0].allocatedDiscountCents).toBe(BigInt(0));
      expect(result.items[0].taxableAmountCents).toBe(BigInt(3998));
    });

    it("should preserve exact conservation across odd numbers and 100+ items", () => {
      const items: DiscountableLineItem[] = [];
      for (let i = 0; i < 50; i++) {
        items.push({
          itemIndex: i,
          unitPriceCents: 199 + (i % 7) * 50,
          quantity: 1 + (i % 3),
        });
      }

      const totalSubtotal = items.reduce(
        (sum, item) => sum + BigInt(item.unitPriceCents) * BigInt(item.quantity),
        BigInt(0)
      );

      const discountToTest = BigInt(12345); // $123.45 discount
      const result = allocatePromotionalDiscounts(items, discountToTest);

      expect(result.merchandiseSubtotalCents).toBe(totalSubtotal);
      expect(result.effectiveDiscountCents).toBe(discountToTest);

      const totalAllocated = result.items.reduce((acc, curr) => acc + curr.allocatedDiscountCents, BigInt(0));
      expect(totalAllocated).toBe(discountToTest);

      for (const item of result.items) {
        expect(item.taxableAmountCents).toBeGreaterThanOrEqual(BigInt(0));
        expect(item.taxableAmountCents + item.allocatedDiscountCents).toBe(item.itemSubtotalCents);
      }
    });
  });

  describe("Validation & Rejection Guards", () => {
    it("should reject negative discount with ERR_AMOUNT_OUT_OF_BOUNDS (22003)", () => {
      const items: DiscountableLineItem[] = [
        { itemIndex: 0, unitPriceCents: 1000, quantity: 1 },
      ];
      expect(() => allocatePromotionalDiscounts(items, -100)).toThrow(AmountOutOfBoundsError);
      try {
        allocatePromotionalDiscounts(items, -100);
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_AMOUNT_OUT_OF_BOUNDS);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_NUMERIC_RANGE);
      }
    });

    it("should reject empty line items with ERR_AMOUNT_OUT_OF_BOUNDS (22003)", () => {
      expect(() => allocatePromotionalDiscounts([], 100)).toThrow(AmountOutOfBoundsError);
    });

    it("should reject duplicate itemIndex with ERR_MALFORMED_NESTED_STRUCTURE (22023)", () => {
      const items: DiscountableLineItem[] = [
        { itemIndex: 0, unitPriceCents: 1000, quantity: 1 },
        { itemIndex: 0, unitPriceCents: 2000, quantity: 1 },
      ];
      expect(() => allocatePromotionalDiscounts(items, 100)).toThrow(MalformedNestedStructureError);
      try {
        allocatePromotionalDiscounts(items, 100);
      } catch (err: any) {
        expect(err.code).toBe(STAGE2_ERROR_CODES.ERR_MALFORMED_NESTED_STRUCTURE);
        expect(err.sqlState).toBe(SQLSTATE_CODES.DATA_EXCEPTION_INVALID_VALUE);
      }
    });

    it("should reject invalid negative itemIndex with ERR_MALFORMED_NESTED_STRUCTURE (22023)", () => {
      const items: DiscountableLineItem[] = [
        { itemIndex: -1, unitPriceCents: 1000, quantity: 1 },
      ];
      expect(() => allocatePromotionalDiscounts(items, 100)).toThrow(MalformedNestedStructureError);
    });

    it("should reject non-positive unitPriceCents with ERR_AMOUNT_OUT_OF_BOUNDS (22003)", () => {
      const items: DiscountableLineItem[] = [
        { itemIndex: 0, unitPriceCents: 0, quantity: 1 },
      ];
      expect(() => allocatePromotionalDiscounts(items, 100)).toThrow(AmountOutOfBoundsError);
    });

    it("should reject non-positive quantity with ERR_AMOUNT_OUT_OF_BOUNDS (22003)", () => {
      const items: DiscountableLineItem[] = [
        { itemIndex: 0, unitPriceCents: 1000, quantity: 0 },
      ];
      expect(() => allocatePromotionalDiscounts(items, 100)).toThrow(AmountOutOfBoundsError);
    });

    it("should reject mismatched itemSubtotalCents with ERR_AMOUNT_OUT_OF_BOUNDS (22003)", () => {
      const items: DiscountableLineItem[] = [
        { itemIndex: 0, unitPriceCents: 1000, quantity: 2, itemSubtotalCents: BigInt(3000) },
      ];
      expect(() => allocatePromotionalDiscounts(items, 100)).toThrow(AmountOutOfBoundsError);
    });
  });
});
