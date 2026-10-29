/**
 * Plinthly Phase 16.1 — Shipping Evidence Audit and Reconciliation Regression Tests.
 *
 * Enforces:
 * 1. Policy-threshold eligibility alone is NEVER mistaken for a retailer-issued shipping quote.
 * 2. Distinguishes:
 *    - "quoted": Retailer/carrier issued real-time rate bound to cart and destination.
 *    - "policy_derived": Documented policy eligibility determination (threshold met, non-marketplace, standard zone).
 *    - "missing": Unquoted / unknown shipping charge.
 * 3. Prevents policy-threshold eligibility from setting isQuoteBound=true.
 * 4. Ensures lowest cost strategies without real-time carrier quotes are clearly labeled as (Policy-Derived).
 * 5. Rechecks approval integrity, target cart isolation, and material change invalidation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { planCartShipments } from "../../lib/discovery/cart/split-shipment";
import { generateProcurementStrategies } from "../../lib/discovery/cart/strategy-engine";
import { CartItem, ProcurementLineItem } from "../../lib/discovery/cart/types";
import { DestinationContext } from "../../lib/discovery/shipping";
import { NormalizedProductCandidate } from "../../lib/discovery/types";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { Actor } from "../../lib/state/types";

describe("Phase 16.1 — Shipping Evidence Audit and Reconciliation", () => {
  const destination: DestinationContext = {
    country: "US",
    postalCode: "94103",
    deliveryMethodPreference: "standard_ground",
  };

  const buyerActor: Actor = {
    kind: "user",
    userId: "usr_buyer_p16_1",
  };

  describe("1. Policy-Threshold vs Retailer Quote Separation", () => {
    it("assigns shippingEvidenceType: 'policy_derived' and isQuoteBound: false when free shipping threshold is met", () => {
      const items: CartItem[] = [
        {
          lineItemId: "li_laptop",
          candidateId: "cand_bb_laptop",
          externalId: "ext_bb_laptop",
          title: "Dell XPS 15 Laptop",
          unitPriceCents: 150000,
          quantity: 1,
          lineItemTotalCents: 150000,
          currency: "USD",
          sellerName: "Best Buy",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          isWfsFulfilled: false,
          fulfillmentMethod: "standard_ground",
          requiresSpecialDelivery: false,
          contributesToCartThreshold: true,
          isIndividuallyEligibleForFreeShipping: true,
          itemShippingCents: null, // No explicit quote
        },
      ];

      const shipments = planCartShipments({
        merchantDomain: "bestbuy.com",
        merchantName: "Best Buy",
        items,
        cartLevelFreeShippingEarned: true, // $1,500 >= $35 threshold
        destinationPostalCode: "94103",
      });

      expect(shipments).toHaveLength(1);
      const ship = shipments[0];

      // Shipping amount is $0.00
      expect(ship.shippingChargeCents).toBe(0);
      expect(ship.isShippingVerified).toBe(true);

      // CRITICAL RECONCILIATION INVARIANTS:
      // Policy threshold is policy_derived, NOT quoted!
      expect(ship.shippingEvidenceType).toBe("policy_derived");
      expect(ship.isQuoteBound).toBe(false);
      expect(ship.explanation).toContain("Policy-derived free shipping applied");
      expect(ship.explanation).toContain("Carrier shipping quote is not bound");
    });

    it("assigns shippingEvidenceType: 'quoted' and isQuoteBound: true when explicit retailer shipping quote is provided", () => {
      const items: CartItem[] = [
        {
          lineItemId: "li_item",
          candidateId: "cand_item_quoted",
          externalId: "ext_quoted",
          title: "Specialty Audio Interface",
          unitPriceCents: 12000,
          quantity: 1,
          lineItemTotalCents: 12000,
          currency: "USD",
          sellerName: "B&H Photo",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          isWfsFulfilled: false,
          fulfillmentMethod: "standard_ground",
          requiresSpecialDelivery: false,
          contributesToCartThreshold: true,
          isIndividuallyEligibleForFreeShipping: true,
          itemShippingCents: 999, // Explicit retailer-quoted fee: $9.99
        },
      ];

      const shipments = planCartShipments({
        merchantDomain: "bhphotovideo.com",
        merchantName: "B&H Photo",
        items,
        cartLevelFreeShippingEarned: false,
        destinationPostalCode: "94103",
      });

      expect(shipments).toHaveLength(1);
      const ship = shipments[0];

      expect(ship.shippingChargeCents).toBe(999);
      expect(ship.isShippingVerified).toBe(true);
      expect(ship.shippingEvidenceType).toBe("quoted");
      expect(ship.isQuoteBound).toBe(true);
      expect(ship.explanation).toContain("Standard retailer shipping fee applied ($9.99)");
    });

    it("assigns shippingEvidenceType: 'missing' and isQuoteBound: false when unquoted and below threshold", () => {
      const items: CartItem[] = [
        {
          lineItemId: "li_cable",
          candidateId: "cand_cable",
          externalId: "ext_cable",
          title: "USB Cable",
          unitPriceCents: 1000,
          quantity: 1,
          lineItemTotalCents: 1000,
          currency: "USD",
          sellerName: "Best Buy",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          isWfsFulfilled: false,
          fulfillmentMethod: "standard_ground",
          requiresSpecialDelivery: false,
          contributesToCartThreshold: true,
          isIndividuallyEligibleForFreeShipping: true,
          itemShippingCents: null, // No quote, and below $35 threshold
        },
      ];

      const shipments = planCartShipments({
        merchantDomain: "bestbuy.com",
        merchantName: "Best Buy",
        items,
        cartLevelFreeShippingEarned: false,
        destinationPostalCode: "94103",
      });

      expect(shipments).toHaveLength(1);
      const ship = shipments[0];

      expect(ship.shippingChargeCents).toBeNull();
      expect(ship.isShippingVerified).toBe(false);
      expect(ship.shippingEvidenceType).toBe("missing");
      expect(ship.isQuoteBound).toBe(false);
      expect(ship.explanation).toContain("Shipping charge unquoted from retailer upstream");
    });

    it("prevents policy-threshold free shipping from leaking to third-party marketplace sellers", () => {
      const items: CartItem[] = [
        {
          lineItemId: "li_direct",
          candidateId: "cand_direct",
          externalId: "ext_direct",
          title: "Direct Retailer TV",
          unitPriceCents: 50000,
          quantity: 1,
          lineItemTotalCents: 50000,
          currency: "USD",
          sellerName: "Best Buy",
          isMarketplace: false,
          isDirectRetailerSeller: true,
          isWfsFulfilled: false,
          fulfillmentMethod: "standard_ground",
          requiresSpecialDelivery: false,
          contributesToCartThreshold: true,
          isIndividuallyEligibleForFreeShipping: true,
          itemShippingCents: null,
        },
        {
          lineItemId: "li_market",
          candidateId: "cand_market",
          externalId: "ext_market",
          title: "Marketplace HDMI Cable",
          unitPriceCents: 2000,
          quantity: 1,
          lineItemTotalCents: 2000,
          currency: "USD",
          sellerName: "CableWorld Inc",
          isMarketplace: true,
          isDirectRetailerSeller: false,
          isWfsFulfilled: false,
          fulfillmentMethod: "standard_ground",
          requiresSpecialDelivery: false,
          contributesToCartThreshold: false,
          isIndividuallyEligibleForFreeShipping: false,
          itemShippingCents: null, // Marketplace seller has not provided shipping quote
        },
      ];

      const shipments = planCartShipments({
        merchantDomain: "bestbuy.com",
        merchantName: "Best Buy",
        items,
        cartLevelFreeShippingEarned: true, // Direct item exceeded threshold
        destinationPostalCode: "94103",
      });

      // Must be split into 2 shipments: direct vs marketplace
      expect(shipments).toHaveLength(2);

      const directShip = shipments.find((s) => s.sellerName === "Best Buy")!;
      const marketShip = shipments.find((s) => s.sellerName === "CableWorld Inc")!;

      // Direct shipment gets policy-derived free shipping
      expect(directShip.shippingChargeCents).toBe(0);
      expect(directShip.shippingEvidenceType).toBe("policy_derived");
      expect(directShip.isQuoteBound).toBe(false);

      // Marketplace shipment DOES NOT get free shipping: remains unquoted
      expect(marketShip.shippingChargeCents).toBeNull();
      expect(marketShip.isShippingVerified).toBe(false);
      expect(marketShip.shippingEvidenceType).toBe("missing");
      expect(marketShip.isQuoteBound).toBe(false);
      expect(marketShip.explanation).toContain("ships independently");
    });
  });

  describe("2. Strategy Labeling and Landed Cost Disclosure", () => {
    const lineItems: ProcurementLineItem[] = [
      {
        id: "li_1",
        title: "Workstation Laptop",
        quantity: 1,
        budgetCents: 160000,
        currency: "USD",
        requirements: ["32GB RAM"],
      },
      {
        id: "li_2",
        title: "4K Monitor",
        quantity: 1,
        budgetCents: 50000,
        currency: "USD",
        requirements: ["4K"],
      },
      {
        id: "li_3",
        title: "USB-C Dock",
        quantity: 1,
        budgetCents: 20000,
        currency: "USD",
        requirements: ["Thunderbolt"],
      },
    ];

    const policyBackedCandidates: NormalizedProductCandidate[] = [
      {
        id: "cand_bb_laptop",
        purchaseId: "pur_dummy",
        externalId: "ext_bb_1",
        title: "Dell XPS 15 Laptop 32GB RAM",
        merchantName: "Best Buy",
        merchantUrl: "https://www.bestbuy.com/site/laptop/1.p",
        unitPriceCents: 145000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 145000,
        currency: "USD",
        availability: "in_stock",
        capturedAt: new Date(),
        snapshotHash: "hash_laptop",
        source: "channel3",
        sellerName: "Best Buy",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
      },
      {
        id: "cand_bb_monitor",
        purchaseId: "pur_dummy",
        externalId: "ext_bb_2",
        title: "Dell 27 Inch 4K Monitor",
        merchantName: "Best Buy",
        merchantUrl: "https://www.bestbuy.com/site/monitor/2.p",
        unitPriceCents: 42000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 42000,
        currency: "USD",
        availability: "in_stock",
        capturedAt: new Date(),
        snapshotHash: "hash_monitor",
        source: "channel3",
        sellerName: "Best Buy",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
      },
      {
        id: "cand_bb_dock",
        purchaseId: "pur_dummy",
        externalId: "ext_bb_3",
        title: "Dell Thunderbolt Dock",
        merchantName: "Best Buy",
        merchantUrl: "https://www.bestbuy.com/site/dock/3.p",
        unitPriceCents: 14000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 14000,
        currency: "USD",
        availability: "in_stock",
        capturedAt: new Date(),
        snapshotHash: "hash_dock",
        source: "channel3",
        sellerName: "Best Buy",
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
      },
    ];

    it("labels policy-threshold lowest cost strategy as 'Lowest Landed Cost (Policy-Derived)'", () => {
      const strategies = generateProcurementStrategies({
        lineItems,
        candidates: policyBackedCandidates,
        destination,
      });

      expect(strategies.length).toBeGreaterThan(0);
      const lowestCost = strategies.find((s) => s.strategyId === "strat_lowest_landed_cost")!;
      expect(lowestCost).toBeDefined();

      // Explicit evidence reconciliation assertions:
      expect(lowestCost.shippingEvidenceType).toBe("policy_derived");
      expect(lowestCost.isQuoteBacked).toBe(false);
      expect(lowestCost.name).toBe("Lowest Landed Cost (Policy-Derived)");

      // Total merchandise is separate from shipping
      expect(lowestCost.totalMerchandiseCents).toBe(201000);
      expect(lowestCost.totalShippingCents).toBe(0);
      expect(lowestCost.totalLandedCostCents).toBe(201000);

      // Recommendation rationale discloses policy derivation and lack of bound carrier quote
      expect(lowestCost.recommendationRationale).toContain("Policy-derived landed cost");
      expect(lowestCost.recommendationRationale).toContain("published merchant threshold policy");
      expect(lowestCost.recommendationRationale).toContain("real-time carrier shipping quote is not bound");
    });
  });

  describe("3. Approval Integrity and Target Cart Isolation", () => {
    let service: PurchaseWorkflowService;
    let repo: InMemoryPurchaseRepository;

    beforeEach(() => {
      repo = new InMemoryPurchaseRepository();
      service = new PurchaseWorkflowService(repo);
    });

    it("binds approval snapshot to policy-derived shipping evidence and prevents manipulation", async () => {
      const testItems: ProcurementLineItem[] = [
        {
          id: "item_1",
          title: "Dell XPS 15 Workstation",
          quantity: 1,
          budgetCents: 150000,
          currency: "USD",
          requirements: [{ key: "ram", expectedValue: "32GB" }],
        },
        {
          id: "item_2",
          title: "Dell 4K Monitor",
          quantity: 1,
          budgetCents: 50000,
          currency: "USD",
          requirements: [{ key: "res", expectedValue: "4K" }],
        },
      ];

      // 1. Create Purchase
      const purchase = await service.createPurchase(
        {
          budgetCents: 210000,
          currency: "USD",
          destination,
          lineItems: testItems,
          confirmImmediately: true,
        },
        buyerActor
      );

      // 2. Evaluate plan
      const planRes = await service.createMultiItemPlan(
        purchase.id,
        {
          lineItems: testItems,
          destination,
          candidates: [
            {
              id: "cand_laptop",
              purchaseId: purchase.id,
              snapshotHash: "snap_hash_laptop",
              rawSourceData: {},
              isComplete: true,
              validationErrors: [],
              source: "channel3",
              externalId: "ext_laptop",
              title: "Dell XPS 15 Laptop",
              merchantName: "Best Buy",
              merchantUrl: "https://www.bestbuy.com/site/laptop/1.p",
              unitPriceCents: 145000,
              quantity: 1,
              shippingCents: 0,
              totalCents: 145000,
              currency: "USD",
              availability: "in_stock",
              capturedAt: new Date(),
            },
            {
              id: "cand_monitor",
              purchaseId: purchase.id,
              snapshotHash: "snap_hash_monitor",
              rawSourceData: {},
              isComplete: true,
              validationErrors: [],
              source: "channel3",
              externalId: "ext_monitor",
              title: "Dell 4K Monitor",
              merchantName: "Best Buy",
              merchantUrl: "https://www.bestbuy.com/site/monitor/2.p",
              unitPriceCents: 42000,
              quantity: 1,
              shippingCents: 0,
              totalCents: 42000,
              currency: "USD",
              availability: "in_stock",
              capturedAt: new Date(),
            },
          ],
        },
        buyerActor
      );

      const chosenStrategy = planRes.strategies[0];
      expect(chosenStrategy.isLandedCostDefensible).toBe(true);
      expect(chosenStrategy.shippingEvidenceType).toBe("policy_derived");

      // 3. Approve plan
      const approved = await service.approveMultiItemPlan(
        purchase.id,
        {
          strategyId: chosenStrategy.strategyId,
          expectedTotalLandedCostCents: chosenStrategy.totalLandedCostCents!,
          expectedCurrency: "USD",
        },
        buyerActor
      );

      expect(approved.status).toBe("APPROVED");
      expect(approved.activeApproval?.multiItemSnapshotHash).toBeDefined();

      // 4. Invalidate upon destination change
      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, {
          targetCartMerchantDomain: "bestbuy.com",
          destination: {
            country: "US",
            postalCode: "99501",
            deliveryMethodPreference: "standard_ground",
          }, // Mismatched destination
          idempotencyKey: "test_idem_dest_change",
        })
      ).rejects.toThrow();

      // 5. Confirm approval is revoked
      const reloaded = await service.getPurchase(purchase.id, buyerActor);
      expect(reloaded.activeApproval).toBeNull();

      // 6. Checkout attempt on invalidated approval strictly rejected
      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, {
          targetCartMerchantDomain: "bestbuy.com",
          idempotencyKey: "test_idem_after_revocation",
        })
      ).rejects.toThrow();
    });
  });
});
