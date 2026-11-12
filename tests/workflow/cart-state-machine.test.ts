import { describe, it, expect } from "vitest";
import {
  canTransitionCart,
  assertCartTransition,
  isValidCartStatus,
  InvalidCartTransitionError,
  ALL_CART_STATUSES,
} from "../../lib/workflow/cart-state-machine";

describe("Phase 4: ApprovedMerchantCart Payment State Machine", () => {
  it("validates all 8 canonical cart statuses", () => {
    expect(ALL_CART_STATUSES.length).toBe(8);
    for (const status of ALL_CART_STATUSES) {
      expect(isValidCartStatus(status)).toBe(true);
    }
    expect(isValidCartStatus("NON_EXISTENT_STATUS")).toBe(false);
  });

  describe("Valid Transitions", () => {
    it("allows READY -> BUYER_APPROVED", () => {
      expect(canTransitionCart("READY", "BUYER_APPROVED")).toBe(true);
      expect(() => assertCartTransition("READY", "BUYER_APPROVED")).not.toThrow();
    });

    it("allows BUYER_APPROVED -> CAPTURING (R2-02)", () => {
      expect(canTransitionCart("BUYER_APPROVED", "CAPTURING")).toBe(true);
      expect(() => assertCartTransition("BUYER_APPROVED", "CAPTURING")).not.toThrow();
    });

    it("allows CAPTURING -> CAPTURED (R2-05)", () => {
      expect(canTransitionCart("CAPTURING", "CAPTURED")).toBe(true);
      expect(() => assertCartTransition("CAPTURING", "CAPTURED")).not.toThrow();
    });

    it("allows CAPTURING -> FAILED (isolated failure)", () => {
      expect(canTransitionCart("CAPTURING", "FAILED")).toBe(true);
      expect(() => assertCartTransition("CAPTURING", "FAILED")).not.toThrow();
    });

    it("allows CAPTURED -> PARTIALLY_REFUNDED (R2-06)", () => {
      expect(canTransitionCart("CAPTURED", "PARTIALLY_REFUNDED")).toBe(true);
      expect(() => assertCartTransition("CAPTURED", "PARTIALLY_REFUNDED")).not.toThrow();
    });

    it("allows CAPTURED -> REFUNDED (R2-06 full refund)", () => {
      expect(canTransitionCart("CAPTURED", "REFUNDED")).toBe(true);
      expect(() => assertCartTransition("CAPTURED", "REFUNDED")).not.toThrow();
    });

    it("allows PARTIALLY_REFUNDED -> REFUNDED", () => {
      expect(canTransitionCart("PARTIALLY_REFUNDED", "REFUNDED")).toBe(true);
      expect(() => assertCartTransition("PARTIALLY_REFUNDED", "REFUNDED")).not.toThrow();
    });
  });

  describe("Invalid & Disallowed Transitions", () => {
    it("rejects transition from CAPTURED to CAPTURING", () => {
      expect(canTransitionCart("CAPTURED", "CAPTURING")).toBe(false);
      expect(() => assertCartTransition("CAPTURED", "CAPTURING")).toThrow(
        InvalidCartTransitionError
      );
    });

    it("rejects transition from REFUNDED to CAPTURING", () => {
      expect(canTransitionCart("REFUNDED", "CAPTURING")).toBe(false);
      expect(() => assertCartTransition("REFUNDED", "CAPTURING")).toThrow(
        InvalidCartTransitionError
      );
    });

    it("rejects transition from FAILED to CAPTURED", () => {
      expect(canTransitionCart("FAILED", "CAPTURED")).toBe(false);
      expect(() => assertCartTransition("FAILED", "CAPTURED")).toThrow(
        InvalidCartTransitionError
      );
    });

    it("rejects self-transitions (e.g. CAPTURED -> CAPTURED)", () => {
      expect(canTransitionCart("CAPTURED", "CAPTURED")).toBe(false);
    });

    it("error matches SQLSTATE 55000 and code ERR_INVALID_TRANSITION", () => {
      try {
        assertCartTransition("REFUNDED", "CAPTURING");
        expect.unreachable();
      } catch (err: any) {
        expect(err.code).toBe("ERR_INVALID_TRANSITION");
        expect(err.sqlState).toBe("55000");
      }
    });
  });
});

