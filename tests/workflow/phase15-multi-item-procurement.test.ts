/**
 * Plinthly Phase 15 — Multi-Item Procurement, Cart Aggregation, and Split-Shipment Planning Tests.
 *
 * Verifies:
 * 1. Multi-item buyer requirements: multiple line items, duplicate ID rejection, quantity validation, currency homogeneity.
 * 2. Candidate allocation: spec matching, variant contradiction rejection, duplicate allocation prevention.
 * 3. Retailer cart aggregation: merchant domain grouping, $35 threshold qualification, marketplace threshold contribution vs shipping eligibility.
 * 4. Split-shipment planning: independent shipments, fulfillment method partitioning, marketplace seller splits, unevidenced delivery dates.
 * 5. Purchase strategy comparison: defensible ranking, incomplete shipping marking totals uncertain (never ranked cheaper than verified).
 * 6. Cryptographic approval snapshot: full plan hash, material change invalidation (quantities, candidates, destination).
 * 7. PayPal Sandbox safety: zero PayPal calls when unapproved/invalid, multi-merchant transaction boundary enforcement, zero funds captured.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateProcurementLineItems,
  convertLegacyRequirementsToLineItems,
} from "../../lib/discovery/cart/line-item";
import {
  checkCandidateCompatibility,
  allocateCandidatesToLineItems,
} from "../../lib/discovery/cart/allocation";
import {
  aggregateRetailerCarts,
} from "../../lib/discovery/cart/cart-aggregator";
import { planCartShipments } from "../../lib/discovery/cart/split-shipment";
import {
  buildStrategyFromAllocations,
  generateProcurementStrategies,
} from "../../lib/discovery/cart/strategy-engine";
import {
  createMultiItemApprovalSnapshot,
  deriveMultiItemInvalidationReasons,
} from "../../lib/discovery/cart/approval-snapshot";
import {
  ProcurementLineItem,
  CartItem,
} from "../../lib/discovery/cart/types";
import { NormalizedProductCandidate } from "../../lib/discovery/types";
import { DestinationContext } from "../../lib/discovery/shipping";
import { getMerchantPolicyRegistry } from "../../lib/discovery/merchant-policy-registry";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { Actor } from "../../lib/state/types";

describe("PLINTHLY — PHASE 15: Multi-Item Procurement, Cart Aggregation & Split-Shipment Planning", () => {
  const defaultDestination: DestinationContext = {
    country: "US",
    postalCode: "94103",
    deliveryMethodPreference: "standard_ground",
  };

  const humanBuyer: Actor = { kind: "user", userId: "usr_multi_buyer_1" };

  describe("1. Multi-Item Buyer Requirements and Validation", () => {
    it("1.1 validates multiple line items with distinct IDs, quantities, specifications, and budgets", () => {
      const rawLineItems = [
        {
          id: "item_laptop",
          title: "Lenovo ThinkPad Laptop",
          quantity: 2,
          budgetCents: 150000,
          currency: "USD",
          requirements: [{ key: "ram", expectedValue: "16GB", description: "16GB Memory" }],
          verificationLevel: "standard",
        },
        {
          id: "item_dock",
          title: "Thunderbolt 4 Dock",
          quantity: 1,
          budgetCents: 25000,
          currency: "USD",
          requirements: [{ key: "ports", expectedValue: "thunderbolt", description: "Thunderbolt 4" }],
          verificationLevel: "strict",
        },
      ];

      const result = validateProcurementLineItems(rawLineItems);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lineItems).toHaveLength(2);
        expect(result.lineItems[0].id).toBe("item_laptop");
        expect(result.lineItems[0].quantity).toBe(2);
        expect(result.lineItems[1].id).toBe("item_dock");
        expect(result.lineItems[1].verificationLevel).toBe("strict");
      }
    });

    it("1.2 rejects duplicate line-item IDs with duplicate_line_item_id code", () => {
      const duplicateItems = [
        { id: "item_same", title: "Product Alpha", quantity: 1, currency: "USD" },
        { id: "item_same", title: "Product Beta", quantity: 1, currency: "USD" },
      ];

      const result = validateProcurementLineItems(duplicateItems);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.code === "duplicate_line_item_id")).toBe(true);
        expect(result.errors[0].message).toContain('Duplicate line-item identifier "item_same"');
      }
    });

    it("1.3 rejects invalid quantities (zero, negative, floating-point, NaN)", () => {
      const invalidQuantities = [
        { id: "line_1", title: "Item 1", quantity: 0, currency: "USD" },
        { id: "line_2", title: "Item 2", quantity: -3, currency: "USD" },
        { id: "line_3", title: "Item 3", quantity: 1.5, currency: "USD" },
        { id: "line_4", title: "Item 4", quantity: NaN, currency: "USD" },
      ];

      const result = validateProcurementLineItems(invalidQuantities);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThanOrEqual(4);
        expect(result.errors.every((e) => e.code === "invalid_quantity")).toBe(true);
      }
    });

    it("1.4 rejects non-USD currencies and enforces homogeneous USD currency across all items", () => {
      const foreignCurrencies = [
        { id: "line_1", title: "US Product", quantity: 1, currency: "USD" },
        { id: "line_2", title: "Euro Product", quantity: 1, currency: "EUR" },
      ];

      const result = validateProcurementLineItems(foreignCurrencies);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.code === "unsupported_currency")).toBe(true);
      }
    });

    it("1.5 backward compatibility: normalizes legacy single-item requirements into 1 line item", () => {
      const legacyRequirements = ["Laptop", { key: "ram", expectedValue: "32GB" }];
      const lineItems = convertLegacyRequirementsToLineItems(legacyRequirements, 180000, "USD", 2);

      expect(lineItems).toHaveLength(1);
      expect(lineItems[0].id).toBe("line_1");
      expect(lineItems[0].quantity).toBe(2);
      expect(lineItems[0].budgetCents).toBe(180000);
      expect(lineItems[0].requirements).toHaveLength(2);
    });
  });

  describe("2. Candidate Discovery, Allocation and Spec Compatibility", () => {
    const mockLaptopLineItem: ProcurementLineItem = {
      id: "line_laptop",
      title: "Laptop with 32GB RAM",
      quantity: 1,
      budgetCents: 150000,
      currency: "USD",
      requirements: [{ key: "ram", expectedValue: "32GB" }],
      verificationLevel: "standard",
    };

    const compatibleCandidate: NormalizedProductCandidate = {
      id: "cand_laptop_32gb",
      purchaseId: "pur_test",
      externalId: "cand_laptop_32gb",
      title: "Lenovo ThinkPad T14s 32GB RAM",
      merchantName: "Walmart",
      merchantUrl: "https://walmart.com/ip/123",
      unitPriceCents: 120000,
      quantity: 1,
      shippingCents: 0,
      totalCents: 120000,
      currency: "USD",
      availability: "in_stock",
      source: "channel3",
      capturedAt: new Date(),
      snapshotHash: "x".repeat(64),
      rawSourceData: {},
      isComplete: true,
      validationErrors: [],
      sellerName: "Walmart.com",
      isMarketplace: false,
      isDirectRetailerSeller: true,
      fulfillmentMethod: "standard_ground",
      observationList: [
        {
          requirementKey: "ram",
          value: "32GB",
          status: "supports",
          sourceType: "upstream_metadata",
          sourceUrl: "https://walmart.com/ip/123",
          capturedAt: new Date().toISOString(),
        },
      ],
    };

    const contradictingCandidate: NormalizedProductCandidate = {
      ...compatibleCandidate,
      externalId: "cand_laptop_16gb",
      title: "Lenovo ThinkPad T14s 16GB RAM",
      observationList: [
        {
          requirementKey: "ram",
          value: "16GB",
          status: "contradicts",
          sourceType: "upstream_metadata",
          sourceUrl: "https://walmart.com/ip/123",
          capturedAt: new Date().toISOString(),
        },
      ],
    };

    it("2.1 successfully allocates candidate when specifications match verified evidence", () => {
      const check = checkCandidateCompatibility(mockLaptopLineItem, compatibleCandidate);
      expect(check.compatible).toBe(true);
      expect(check.matchedSpecs).toContain("ram");
      expect(check.contradictorySpecs).toHaveLength(0);
    });

    it("2.2 rejects candidate allocation when critical specifications contradict (e.g. 16GB vs 32GB requested)", () => {
      const check = checkCandidateCompatibility(mockLaptopLineItem, contradictingCandidate);
      expect(check.compatible).toBe(false);
      expect(check.contradictorySpecs.length).toBeGreaterThan(0);
      expect(check.reason).toContain("Specification contradictions detected");
    });

    it("2.3 prevents duplicate allocation of the same candidate instance across distinct line items", () => {
      const lineItemA: ProcurementLineItem = {
        id: "item_a",
        title: "Product A",
        quantity: 1,
        currency: "USD",
        requirements: [],
      };
      const lineItemB: ProcurementLineItem = {
        id: "item_b",
        title: "Product B",
        quantity: 1,
        currency: "USD",
        requirements: [],
      };

      // Only 1 candidate in pool
      const pool = [compatibleCandidate];

      const result = allocateCandidatesToLineItems([lineItemA, lineItemB], pool, {
        allowSharedCandidatesAcrossIdenticalItems: false,
      });

      // Exactly 1 allocation made; lineItemB cannot duplicate the same candidate
      expect(result.allocations).toHaveLength(1);
      expect(result.allocations[0].lineItemId).toBe("item_a");
      expect(result.unallocatedLineItemIds).toContain("item_b");
    });
  });

  describe("3. Retailer Cart Aggregation and Policy Threshold Engine", () => {
    it("3.1 groups allocated candidates by normalized merchant domain", () => {
      const allocations = [
        {
          lineItemId: "item_1",
          candidateId: "cand_1",
          externalId: "cand_1",
          title: "Walmart Item",
          merchantName: "Walmart",
          merchantUrl: "https://www.walmart.com/ip/1",
          unitPriceCents: 2000,
          quantity: 1,
          currency: "USD" as const,
          availability: "in_stock",
          sellerName: "Walmart.com",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          fulfillmentMethod: "standard_ground",
          snapshotHash: "a".repeat(64),
          capturedAt: new Date().toISOString(),
        },
        {
          lineItemId: "item_2",
          candidateId: "cand_2",
          externalId: "cand_2",
          title: "Target Item",
          merchantName: "Target",
          merchantUrl: "https://www.target.com/p/2",
          unitPriceCents: 4000,
          quantity: 1,
          currency: "USD" as const,
          availability: "in_stock",
          sellerName: "Target",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          fulfillmentMethod: "standard_ground",
          snapshotHash: "b".repeat(64),
          capturedAt: new Date().toISOString(),
        },
      ];

      const carts = aggregateRetailerCarts({
        allocations,
        destination: defaultDestination,
      });

      expect(carts).toHaveLength(2);
      const domains = carts.map((c) => c.merchantDomain);
      expect(domains).toContain("walmart.com");
      expect(domains).toContain("target.com");
    });

    it("3.2 combines multiple line items from the same retailer to satisfy $35 free-shipping threshold", () => {
      // Two items: $20.00 and $25.00 -> total $45.00 satisfies Walmart $35 threshold
      const allocations = [
        {
          lineItemId: "item_1",
          candidateId: "cand_1",
          externalId: "cand_1",
          title: "Walmart Keyboard",
          merchantName: "Walmart",
          merchantUrl: "https://www.walmart.com/ip/keyboard",
          unitPriceCents: 2000,
          quantity: 1,
          currency: "USD" as const,
          availability: "in_stock",
          sellerName: "Walmart.com",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          fulfillmentMethod: "standard_ground",
          snapshotHash: "a".repeat(64),
          capturedAt: new Date().toISOString(),
        },
        {
          lineItemId: "item_2",
          candidateId: "cand_2",
          externalId: "cand_2",
          title: "Walmart Mouse",
          merchantName: "Walmart",
          merchantUrl: "https://www.walmart.com/ip/mouse",
          unitPriceCents: 2500,
          quantity: 1,
          currency: "USD" as const,
          availability: "in_stock",
          sellerName: "Walmart.com",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          fulfillmentMethod: "standard_ground",
          snapshotHash: "b".repeat(64),
          capturedAt: new Date().toISOString(),
        },
      ];

      const carts = aggregateRetailerCarts({
        allocations,
        destination: defaultDestination,
      });

      expect(carts).toHaveLength(1);
      const cart = carts[0];
      expect(cart.merchandiseSubtotalCents).toBe(4500);
      expect(cart.thresholdEvaluation?.thresholdSatisfied).toBe(true);
      expect(cart.thresholdEvaluation?.thresholdCents).toBe(3500);
      expect(cart.totalShippingCents).toBe(0);
      expect(cart.isShippingComplete).toBe(true);
    });

    it("3.3 differentiates threshold contribution from free-shipping eligibility for Walmart Marketplace items", () => {
      // Item 1: Walmart 1P $20.00
      // Item 2: Walmart Marketplace seller item $25.00
      // Qualifying threshold subtotal = $45.00 >= $35.00 -> Threshold satisfied!
      // But Marketplace item does NOT receive retailer-funded free shipping (dispatched by 3P seller)
      const allocations = [
        {
          lineItemId: "item_1",
          candidateId: "cand_1",
          externalId: "cand_1",
          title: "Walmart First-Party Item",
          merchantName: "Walmart",
          merchantUrl: "https://www.walmart.com/ip/1p",
          unitPriceCents: 2000,
          quantity: 1,
          currency: "USD" as const,
          availability: "in_stock",
          sellerName: "Walmart.com",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          fulfillmentMethod: "standard_ground",
          snapshotHash: "a".repeat(64),
          capturedAt: new Date().toISOString(),
        },
        {
          lineItemId: "item_2",
          candidateId: "cand_2",
          externalId: "cand_2",
          title: "Walmart Marketplace Item",
          merchantName: "Walmart",
          merchantUrl: "https://www.walmart.com/ip/marketplace",
          unitPriceCents: 2500,
          quantity: 1,
          currency: "USD" as const,
          availability: "in_stock",
          sellerName: "Third-Party Electronics Hub",
          isMarketplace: true,
          isDirectRetailerSeller: false,
          fulfillmentMethod: "standard_ground",
          snapshotHash: "b".repeat(64),
          capturedAt: new Date().toISOString(),
        },
      ];

      const carts = aggregateRetailerCarts({
        allocations,
        destination: defaultDestination,
      });

      expect(carts).toHaveLength(1);
      const cart = carts[0];
      expect(cart.thresholdEvaluation?.thresholdSatisfied).toBe(true);

      // The marketplace item contributed to threshold
      const mpItem = cart.items.find((i) => i.isMarketplace);
      expect(mpItem?.contributesToCartThreshold).toBe(true);
      expect(mpItem?.isIndividuallyEligibleForFreeShipping).toBe(false);

      // Cart splits into 2 shipments: Walmart 1P (shipping $0) and Marketplace Seller (unquoted/separate)
      expect(cart.shipments).toHaveLength(2);
      const mpShipment = cart.shipments.find((s) => s.sellerName === "Third-Party Electronics Hub");
      expect(mpShipment?.isShippingVerified).toBe(false);
      expect(mpShipment?.shippingChargeCents).toBeNull();
      expect(cart.isShippingComplete).toBe(false);
    });

    it("3.4 Target cart excludes Target Plus marketplace items from $35 threshold calculation", () => {
      const allocations = [
        {
          lineItemId: "item_tp",
          candidateId: "cand_tp",
          externalId: "cand_tp",
          title: "Target Plus Marketplace Item",
          merchantName: "Target",
          merchantUrl: "https://www.target.com/p/tp",
          unitPriceCents: 5000,
          quantity: 1,
          currency: "USD" as const,
          availability: "in_stock",
          sellerName: "Partner Merchant",
          isMarketplace: true,
          isDirectRetailerSeller: false,
          fulfillmentMethod: "standard_ground",
          snapshotHash: "c".repeat(64),
          capturedAt: new Date().toISOString(),
        },
      ];

      const carts = aggregateRetailerCarts({
        allocations,
        destination: defaultDestination,
      });

      const cart = carts[0];
      expect(cart.thresholdEvaluation?.qualifyingMerchandiseSubtotalCents).toBe(0);
      expect(cart.thresholdEvaluation?.thresholdSatisfied).toBe(false);
    });
  });

  describe("4. Independent Split-Shipment Planning", () => {
    it("4.1 splits a single cart into multiple shipments when fulfillment methods differ (freight vs standard parcel)", () => {
      const items: CartItem[] = [
        {
          lineItemId: "item_parcel",
          candidateId: "cand_p",
          externalId: "cand_p",
          title: "Mouse",
          unitPriceCents: 3000,
          quantity: 1,
          lineItemTotalCents: 3000,
          currency: "USD",
          sellerName: "Best Buy",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          isWfsFulfilled: false,
          fulfillmentMethod: "standard_ground",
          requiresSpecialDelivery: false,
          contributesToCartThreshold: true,
          isIndividuallyEligibleForFreeShipping: true,
          itemShippingCents: 0,
        },
        {
          lineItemId: "item_freight",
          candidateId: "cand_f",
          externalId: "cand_f",
          title: "75-inch Television",
          unitPriceCents: 80000,
          quantity: 1,
          lineItemTotalCents: 80000,
          currency: "USD",
          sellerName: "Best Buy",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          isWfsFulfilled: false,
          fulfillmentMethod: "freight",
          requiresSpecialDelivery: true,
          contributesToCartThreshold: false,
          isIndividuallyEligibleForFreeShipping: false,
          itemShippingCents: null,
        },
      ];

      const shipments = planCartShipments({
        merchantDomain: "bestbuy.com",
        merchantName: "Best Buy",
        items,
        cartLevelFreeShippingEarned: true,
      });

      expect(shipments).toHaveLength(2);
      const freightShipment = shipments.find((s) => s.fulfillmentMethod === "freight");
      const parcelShipment = shipments.find((s) => s.fulfillmentMethod === "standard_ground");

      expect(freightShipment?.splitReason).toBe("special_delivery_required");
      expect(freightShipment?.isShippingVerified).toBe(false);
      expect(parcelShipment?.shippingChargeCents).toBe(0);
      expect(parcelShipment?.isShippingVerified).toBe(true);
    });

    it("4.2 retains null delivery dates when carrier timestamps are unverified", () => {
      const items: CartItem[] = [
        {
          lineItemId: "item_1",
          candidateId: "cand_1",
          externalId: "cand_1",
          title: "Item 1",
          unitPriceCents: 2000,
          quantity: 1,
          lineItemTotalCents: 2000,
          currency: "USD",
          sellerName: "Walmart.com",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          isWfsFulfilled: false,
          fulfillmentMethod: "standard_ground",
          requiresSpecialDelivery: false,
          contributesToCartThreshold: true,
          isIndividuallyEligibleForFreeShipping: true,
          itemShippingCents: 0,
        },
      ];

      const shipments = planCartShipments({
        merchantDomain: "walmart.com",
        merchantName: "Walmart",
        items,
        cartLevelFreeShippingEarned: true,
      });

      expect(shipments[0].deliveryDate).toBeNull();
    });
  });

  describe("5. Purchase Strategy Generation and Defensible Ranking", () => {
    const lineItems: ProcurementLineItem[] = [
      { id: "item_1", title: "Laptop", quantity: 1, currency: "USD", requirements: [] },
      { id: "item_2", title: "Monitor", quantity: 1, currency: "USD", requirements: [] },
    ];

    it("5.1 generates Lowest Cost and Single-Retailer Consolidated strategies", () => {
      const candidates: NormalizedProductCandidate[] = [
        {
          id: "cand_walmart_laptop",
          purchaseId: "pur_test",
          externalId: "cand_walmart_laptop",
          title: "Walmart Laptop",
          merchantName: "Walmart",
          merchantUrl: "https://walmart.com/laptop",
          unitPriceCents: 80000,
          quantity: 1,
          shippingCents: 0,
          totalCents: 80000,
          currency: "USD",
          availability: "in_stock",
          source: "channel3",
          capturedAt: new Date(),
          snapshotHash: "x".repeat(64),
          rawSourceData: {},
          isComplete: true,
          validationErrors: [],
          sellerName: "Walmart.com",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          fulfillmentMethod: "standard_ground",
        },
        {
          id: "cand_walmart_monitor",
          purchaseId: "pur_test",
          externalId: "cand_walmart_monitor",
          title: "Walmart Monitor",
          merchantName: "Walmart",
          merchantUrl: "https://walmart.com/monitor",
          unitPriceCents: 20000,
          quantity: 1,
          shippingCents: 0,
          totalCents: 20000,
          currency: "USD",
          availability: "in_stock",
          source: "channel3",
          capturedAt: new Date(),
          snapshotHash: "y".repeat(64),
          rawSourceData: {},
          isComplete: true,
          validationErrors: [],
          sellerName: "Walmart.com",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          fulfillmentMethod: "standard_ground",
        },
      ];

      const strategies = generateProcurementStrategies({
        lineItems,
        candidates,
        destination: defaultDestination,
      });

      expect(strategies.length).toBeGreaterThanOrEqual(1);
      const names = strategies.map((s) => s.name);
      expect(names.some((n) => n.includes("Lowest Landed Cost") || n.includes("Consolidated"))).toBe(true);
    });

    it("5.2 INVARIANT: an incomplete total with unquoted shipping is marked uncertain and NEVER ranked cheaper than a complete verified total", () => {
      // Strategy A: Total merchandise $50, but shipping is UNQUOTED (missing) -> totalLandedCostCents = null
      const stratAllocA = [
        {
          lineItemId: "item_1",
          candidateId: "cand_a",
          externalId: "cand_a",
          title: "Item A with Unknown Shipping",
          merchantName: "SomeUnknownRetailer",
          merchantUrl: "https://unknown.com/1",
          unitPriceCents: 5000,
          quantity: 1,
          currency: "USD" as const,
          availability: "in_stock",
          sellerName: "Unknown Seller",
          isMarketplace: true,
          isDirectRetailerSeller: false,
          fulfillmentMethod: "standard_ground",
          snapshotHash: "a".repeat(64),
          capturedAt: new Date().toISOString(),
        },
      ];

      // Strategy B: Total merchandise $55, verified $0 free shipping -> totalLandedCostCents = 5500
      const stratAllocB = [
        {
          lineItemId: "item_1",
          candidateId: "cand_b",
          externalId: "cand_b",
          title: "Item B with Verified Free Shipping",
          merchantName: "Walmart",
          merchantUrl: "https://walmart.com/1",
          unitPriceCents: 5500,
          quantity: 1,
          currency: "USD" as const,
          availability: "in_stock",
          sellerName: "Walmart.com",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          fulfillmentMethod: "standard_ground",
          snapshotHash: "b".repeat(64),
          capturedAt: new Date().toISOString(),
        },
      ];

      const singleLineItem = [{ id: "item_1", title: "Item", quantity: 1, currency: "USD" as const, requirements: [] }];

      const stratA = buildStrategyFromAllocations("strat_a", "Incomplete Strategy", "Unknown shipping", stratAllocA, singleLineItem, defaultDestination);
      const stratB = buildStrategyFromAllocations("strat_b", "Complete Strategy", "Verified shipping", stratAllocB, singleLineItem, defaultDestination);

      expect(stratA.isLandedCostDefensible).toBe(false);
      expect(stratA.totalLandedCostCents).toBeNull();
      expect(stratA.feasibility).toBe("uncertain");

      expect(stratB.isLandedCostDefensible).toBe(true);
      expect(stratB.totalLandedCostCents).toBe(5500);
      expect(stratB.feasibility).toBe("feasible");

      // Test ranking order
      const ranked = [stratA, stratB].sort((a, b) => {
        if (a.feasibility !== b.feasibility) {
          const map = { feasible: 3, uncertain: 2, blocked: 1 };
          return map[b.feasibility] - map[a.feasibility];
        }
        return (a.totalLandedCostCents ?? Infinity) - (b.totalLandedCostCents ?? Infinity);
      });

      // Strategy B (verified complete) must ALWAYS rank ahead of Strategy A (uncertain)
      expect(ranked[0].strategyId).toBe("strat_b");
      expect(ranked[1].strategyId).toBe("strat_a");
    });
  });

  describe("6. Buyer Approval, Cryptographic Snapshots and Invalidation", () => {
    const testLineItem: ProcurementLineItem = {
      id: "item_1",
      title: "Laptop",
      quantity: 1,
      budgetCents: 100000,
      currency: "USD",
      requirements: [],
    };

    const testAllocation = {
      lineItemId: "item_1",
      candidateId: "cand_1",
      externalId: "cand_1",
      title: "Laptop",
      merchantName: "Walmart",
      merchantUrl: "https://walmart.com/1",
      unitPriceCents: 5000,
      quantity: 1,
      currency: "USD" as const,
      availability: "in_stock",
      sellerName: "Walmart.com",
      isMarketplace: false,
      isDirectRetailerSeller: true,
      fulfillmentMethod: "standard_ground",
      snapshotHash: "a".repeat(64),
      capturedAt: new Date().toISOString(),
    };

    const strategy = buildStrategyFromAllocations(
      "strat_1",
      "Test Strat",
      "Desc",
      [testAllocation],
      [testLineItem],
      defaultDestination
    );

    it("6.1 creates cryptographic MultiItemApprovalSnapshot bound to line items, allocations, and carts", () => {
      const snapshot = createMultiItemApprovalSnapshot({
        snapshotId: "snap_1",
        purchaseId: "pur_test_1",
        strategy,
        lineItems: [testLineItem],
        destination: defaultDestination,
        approverUserId: "usr_buyer",
        evidenceFingerprint: "f".repeat(64),
      });

      expect(snapshot.snapshotId).toBe("snap_1");
      expect(snapshot.multiItemSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshot.totalLandedCostCents).toBe(strategy.totalLandedCostCents);
      expect(snapshot.lineItems).toHaveLength(1);
    });

    it("6.2 invalidates approval when line-item quantity is changed", () => {
      const snapshot = createMultiItemApprovalSnapshot({
        snapshotId: "snap_1",
        purchaseId: "pur_test_1",
        strategy,
        lineItems: [testLineItem],
        destination: defaultDestination,
        approverUserId: "usr_buyer",
        evidenceFingerprint: "f".repeat(64),
      });

      const modifiedLineItems = [{ ...testLineItem, quantity: 2 }];
      const reasons = deriveMultiItemInvalidationReasons(
        snapshot,
        strategy,
        modifiedLineItems,
        defaultDestination,
        "f".repeat(64)
      );

      expect(reasons).toContain("line_item_changed");
    });

    it("6.3 invalidates approval when delivery destination changes", () => {
      const snapshot = createMultiItemApprovalSnapshot({
        snapshotId: "snap_1",
        purchaseId: "pur_test_1",
        strategy,
        lineItems: [testLineItem],
        destination: defaultDestination,
        approverUserId: "usr_buyer",
        evidenceFingerprint: "f".repeat(64),
      });

      const changedDest: DestinationContext = {
        country: "US",
        postalCode: "99501", // Alaska
        deliveryMethodPreference: "standard_ground",
      };

      const reasons = deriveMultiItemInvalidationReasons(
        snapshot,
        strategy,
        [testLineItem],
        changedDest,
        "f".repeat(64)
      );

      expect(reasons).toContain("destination_changed");
    });
  });

  describe("7. PayPal Sandbox Safety and Transaction Boundary", () => {
    let repo: InMemoryPurchaseRepository;
    let mockPayPal: PayPalSandboxClient;
    let service: PurchaseWorkflowService;

    beforeEach(() => {
      repo = new InMemoryPurchaseRepository();
      mockPayPal = {
        createOrder: vi.fn(),
        getOrder: vi.fn(),
        capturePayment: vi.fn(),
      } as unknown as PayPalSandboxClient;

      service = new PurchaseWorkflowService(repo, mockPayPal);
    });

    it("7.1 prevents PayPal order creation when purchase is not in APPROVED status", async () => {
      const purchase = await service.createPurchase(
        {
          budgetCents: 100000,
          currency: "USD",
          requirements: ["Laptop"],
        },
        humanBuyer
      );

      await expect(
        service.createPayPalOrder(purchase.id, humanBuyer)
      ).rejects.toThrow(/Cannot create PayPal order for purchase in status/);

      // Verify zero PayPal client calls
      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    async function setupApprovedPurchase(unitPriceCents: number = 50000) {
      const registry = getMerchantPolicyRegistry();
      const bestBuyPolicy = registry.getPoliciesForMerchant("Best Buy")[0];
      const nowIso = new Date().toISOString();

      const purchase = await service.createPurchase(
        {
          budgetCents: 150000,
          currency: "USD",
          requirements: [],
          destination: defaultDestination,
        },
        humanBuyer
      );

      const candData = {
        externalId: "sku_laptop_bb:bestbuy.com",
        title: "Approved Best Buy Test Laptop",
        merchantName: "Best Buy",
        merchantUrl: "https://www.bestbuy.com/site/laptop/1.p",
        unitPriceCents,
        quantity: 1,
        shippingCents: 0,
        shippingType: "policy_derived",
        currency: "USD" as const,
        availability: "in_stock",
        isComplete: true,
        capturedAt: nowIso,
        sourceVerificationTimestamp: nowIso,
        policyId: bestBuyPolicy.policyId,
        policyDocumentFingerprint: bestBuyPolicy.policyDocumentFingerprint,
        policyVersion: bestBuyPolicy.policyVersion,
        policySourceUrl: bestBuyPolicy.policySourceUrl,
        destinationPostalCode: defaultDestination.postalCode,
      };

      const evalRes = await service.evaluatePurchaseCandidate(
        purchase.id,
        {
          rawCandidate: candData,
          rawObservations: [
            {
              requirementKey: "destination",
              value: defaultDestination.postalCode,
              sourceUrl: "https://plinthly.com/user/destination",
              sourceType: "user_context",
              capturedAt: nowIso,
            },
            {
              requirementKey: "shipping",
              value: JSON.stringify({
                policyId: bestBuyPolicy.policyId,
                policyVersion: bestBuyPolicy.policyVersion,
                policyFingerprint: bestBuyPolicy.policyDocumentFingerprint,
                expiresAt: null,
              }),
              sourceUrl: bestBuyPolicy.policySourceUrl,
              sourceType: "merchant_policy",
              capturedAt: nowIso,
            },
          ],
          requiredRuleKeys: ["P-BUDGET"],
        },
        humanBuyer
      );

      expect(evalRes.status).toBe("POLICY_PASSED");

      await service.approvePurchase(
        purchase.id,
        {
          expectedSnapshotHash: evalRes.snapshotHash,
          expectedTotalCents: unitPriceCents,
        },
        humanBuyer
      );

      return purchase;
    }

    it("7.2 enforces transaction boundary check when targetCartMerchantDomain is provided", async () => {
      const purchase = await setupApprovedPurchase(50000);

      // If user specifies a mismatching targetCartMerchantDomain (e.g. walmart.com on a bestbuy.com candidate):
      await expect(
        service.createPayPalOrder(purchase.id, humanBuyer, {
          targetCartMerchantDomain: "walmart.com",
        })
      ).rejects.toThrow(/Target cart merchant domain "walmart.com" does not match/);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("7.3 allows PayPal order creation when targetCartMerchantDomain matches the retailer", async () => {
      const purchase = await setupApprovedPurchase(50000);

      vi.mocked(mockPayPal.createOrder).mockResolvedValue({
        id: "ORDER_PAYPAL_TEST_1",
        status: "CREATED",
        links: [{ rel: "approve", href: "https://sandbox.paypal.com/checkout?token=ORDER_PAYPAL_TEST_1", method: "GET" }],
      });

      const orderRes = await service.createPayPalOrder(purchase.id, humanBuyer, {
        targetCartMerchantDomain: "bestbuy.com",
      });

      expect(orderRes.paypalOrderId).toBe("ORDER_PAYPAL_TEST_1");
      expect(mockPayPal.createOrder).toHaveBeenCalledTimes(1);
    });
  });
});
