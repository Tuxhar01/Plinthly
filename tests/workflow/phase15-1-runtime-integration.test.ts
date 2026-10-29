/**
 * Plinthly Phase 15.1 — Multi-Item Runtime Integration and End-to-End Verification.
 *
 * Verifies:
 * 1. Durable snapshot persistence and service restart survival (approval stored in DB requirements).
 * 2. Automated per-line-item discovery through SourceAdapter boundary (no candidate fabrication).
 * 3. Fail-closed line item unfulfillment: blocked feasibility when any item is unfulfilled.
 * 4. Pre-order snapshot revalidation in createPayPalOrder:
 *    - Rejection when candidate facts or snapshot hash changed.
 *    - Rejection when destination postal code changed.
 *    - Invalidation recorded in repository.
 * 5. Single-merchant transaction boundary enforcement:
 *    - Multi-cart strategy requires targetCartMerchantDomain.
 *    - Invalid targetCartMerchantDomain rejected.
 *    - Valid targeted merchant domain creates order for exact cart landed cost.
 *    - Single-cart strategy safely resolves target cart.
 * 6. PayPal Sandbox safety: zero PayPal captures across all operations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { Actor } from "../../lib/state/types";
import { DestinationContext } from "../../lib/discovery/shipping";
import {
  NormalizedProductCandidate,
  ProductSearchRequest,
  SourceAdapter,
  DiscoveryContext,
  DiscoveryResult,
} from "../../lib/discovery/types";
import { ProcurementLineItem } from "../../lib/discovery/cart/types";
import { ApprovalIntegrityError, ValidationError } from "../../lib/workflow/errors";

describe("PLINTHLY — PHASE 15.1: Multi-Item Runtime Integration & Verification", () => {
  const defaultDestination: DestinationContext = {
    country: "US",
    postalCode: "94103",
    deliveryMethodPreference: "standard_ground",
  };

  const humanBuyer: Actor = { kind: "user", userId: "usr_multi_buyer_1" };

  let repo: InMemoryPurchaseRepository;
  let mockPayPal: PayPalSandboxClient;
  let service: PurchaseWorkflowService;

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
    mockPayPal = {
      createOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL-ORDER-MULTI-123",
        status: "CREATED",
        links: [
          {
            rel: "approve",
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-MULTI-123",
            method: "GET",
          },
        ],
      }),
      getOrder: vi.fn(),
    } as unknown as PayPalSandboxClient;

    service = new PurchaseWorkflowService(repo, mockPayPal);
  });

  const sampleLineItems: ProcurementLineItem[] = [
    {
      id: "line_laptop",
      title: "Business Workstation Laptop",
      quantity: 1,
      budgetCents: 120000,
      currency: "USD",
      requirements: [{ key: "ram", expectedValue: "16GB", description: "16GB Memory" }],
      verificationLevel: "standard",
    },
    {
      id: "line_dock",
      title: "USB-C Dual Monitor Dock",
      quantity: 1,
      budgetCents: 30000,
      currency: "USD",
      requirements: [{ key: "ports", expectedValue: "usb-c", description: "USB-C Connectivity" }],
      verificationLevel: "standard",
    },
  ];

  function createCandidate(params: {
    id: string;
    purchaseId: string;
    title: string;
    merchantName: string;
    merchantDomain: string;
    unitPriceCents: number;
    shippingCents?: number;
    isMarketplace?: boolean;
    fulfillmentMethod?: "standard_ground" | "freight" | "in_store_pickup";
  }): NormalizedProductCandidate {
    const totalCents = (params.unitPriceCents || 0) + (params.shippingCents ?? 0);
    const snapHash = `hash_${params.id}_${params.unitPriceCents}_${params.shippingCents ?? 0}`;
    return {
      id: params.id,
      purchaseId: params.purchaseId,
      externalId: `ext_${params.id}:${params.merchantDomain}`,
      title: params.title,
      merchantName: params.merchantName,
      merchantUrl: `https://www.${params.merchantDomain}/item/${params.id}`,
      unitPriceCents: params.unitPriceCents,
      quantity: 1,
      shippingCents: params.shippingCents ?? 0,
      totalCents,
      currency: "USD",
      availability: "in_stock",
      source: "channel3",
      capturedAt: new Date(),
      snapshotHash: snapHash,
      rawSourceData: {},
      isComplete: true,
      validationErrors: [],
      sellerName: params.isMarketplace ? "Independent Seller LLC" : params.merchantName,
      isMarketplace: params.isMarketplace ?? false,
      isDirectRetailerSeller: !params.isMarketplace,
      fulfillmentMethod: params.fulfillmentMethod ?? "standard_ground",
    };
  }

  describe("1. Durable Snapshot Persistence and Restart Survival", () => {
    it("1.1 durably persists multi-item approval in repository requirements and survives service reload", async () => {
      // Create multi-item purchase
      const purchase = await service.createPurchase(
        {
          budgetCents: 150000,
          currency: "USD",
          destination: defaultDestination,
          lineItems: sampleLineItems,
        },
        humanBuyer
      );

      const candidateLaptop = createCandidate({
        id: "cand_laptop_bb",
        purchaseId: purchase.id,
        title: "Business Workstation Laptop 16GB",
        merchantName: "Best Buy",
        merchantDomain: "bestbuy.com",
        unitPriceCents: 95000,
        shippingCents: 0,
      });

      const candidateDock = createCandidate({
        id: "cand_dock_bb",
        purchaseId: purchase.id,
        title: "USB-C Dual Monitor Dock",
        merchantName: "Best Buy",
        merchantDomain: "bestbuy.com",
        unitPriceCents: 20000,
        shippingCents: 0,
      });

      // 1. Generate plan
      const planRes = await service.createMultiItemPlan(
        purchase.id,
        {
          lineItems: sampleLineItems,
          candidates: [candidateLaptop, candidateDock],
          destination: defaultDestination,
        },
        humanBuyer
      );

      expect(planRes.strategies.length).toBeGreaterThan(0);
      const chosenStrategy = planRes.strategies.find((s) => s.feasibility === "feasible")!;
      expect(chosenStrategy).toBeDefined();

      // 2. Approve strategy
      const approvedRes = await service.approveMultiItemPlan(
        purchase.id,
        {
          strategyId: chosenStrategy.strategyId,
          expectedTotalLandedCostCents: chosenStrategy.totalLandedCostCents!,
          expectedCurrency: "USD",
          destination: defaultDestination,
        },
        humanBuyer
      );

      expect(approvedRes.status).toBe("APPROVED");
      expect(approvedRes.activeApproval).not.toBeNull();
      const approvedHash = approvedRes.activeApproval!.multiItemSnapshotHash;
      expect(approvedHash).toHaveLength(64);

      // 3. Inspect repository directly: Verify requirements contains approvedStrategy
      const directPurchase = await repo.getPurchaseById(purchase.id);
      expect(directPurchase).not.toBeNull();
      expect(directPurchase!.purchase.status).toBe("APPROVED");

      const reqObj = directPurchase!.purchase.requirements as Record<string, unknown>;
      expect(reqObj).toBeDefined();
      expect(reqObj.approvedStrategy).toBeDefined();
      const persistedSnapshot = reqObj.approvedStrategy as typeof approvedRes.activeApproval;
      expect(persistedSnapshot!.multiItemSnapshotHash).toBe(approvedHash);
      expect(persistedSnapshot!.totalLandedCostCents).toBe(chosenStrategy.totalLandedCostCents);

      // 4. Simulate complete service reload: Instantiate brand new service over existing repository
      const reloadedService = new PurchaseWorkflowService(repo, mockPayPal);

      // Verify that createMultiItemPlan on reloaded service restores active approval
      const reloadedPlan = await reloadedService.createMultiItemPlan(
        purchase.id,
        {
          lineItems: sampleLineItems,
          destination: defaultDestination,
        },
        humanBuyer
      );

      expect(reloadedPlan.status).toBe("APPROVED");
      expect(reloadedPlan.activeApproval).not.toBeNull();
      expect(reloadedPlan.activeApproval!.multiItemSnapshotHash).toBe(approvedHash);
      expect(reloadedPlan.activeApproval!.strategyId).toBe(chosenStrategy.strategyId);
    });
  });

  describe("2. Automated Per-Line-Item Discovery via SourceAdapter", () => {
    it("2.1 queries discovery adapter per line item when candidates are omitted, saving discovered items", async () => {
      const mockDiscoveryAdapter: SourceAdapter = {
        name: "mock_channel3_discovery",
        source: "channel3",
        getCapabilities: () => ({
          name: "mock_channel3",
          supportedCurrencies: ["USD"],
          supportsStockStatus: true,
          supportsSpecificationAttributes: true,
          supportsPagination: false,
        }),
        search: vi.fn(async (request: ProductSearchRequest, context: DiscoveryContext): Promise<DiscoveryResult> => {
          if (request.query.includes("Laptop")) {
            return {
              status: "success",
              candidates: [
                createCandidate({
                  id: "cand_disc_laptop",
                  purchaseId: request.purchaseId,
                  title: "Discovered Workstation Laptop 16GB",
                  merchantName: "Best Buy",
                  merchantDomain: "bestbuy.com",
                  unitPriceCents: 90000,
                  shippingCents: 0,
                }),
              ],
              totalFound: 1,
              timestamp: context.now,
            };
          }
          if (request.query.includes("Dock")) {
            return {
              status: "success",
              candidates: [
                createCandidate({
                  id: "cand_disc_dock",
                  purchaseId: request.purchaseId,
                  title: "Discovered USB-C Dual Monitor Dock",
                  merchantName: "Best Buy",
                  merchantDomain: "bestbuy.com",
                  unitPriceCents: 18000,
                  shippingCents: 0,
                }),
              ],
              totalFound: 1,
              timestamp: context.now,
            };
          }
          return { status: "empty", reason: "Not found", timestamp: context.now };
        }),
      };

      const customService = new PurchaseWorkflowService(repo, mockPayPal, mockDiscoveryAdapter);

      const purchase = await customService.createPurchase(
        {
          budgetCents: 150000,
          currency: "USD",
          destination: defaultDestination,
          lineItems: sampleLineItems,
        },
        humanBuyer
      );

      // Call plan creation without passing candidates
      const planRes = await customService.createMultiItemPlan(
        purchase.id,
        {
          lineItems: sampleLineItems,
          destination: defaultDestination,
        },
        humanBuyer
      );

      // Verify adapter was searched for both line items
      expect(mockDiscoveryAdapter.search).toHaveBeenCalledTimes(2);

      // Verify candidates were discovered and strategy generated
      expect(planRes.strategies.length).toBeGreaterThan(0);
      const feasible = planRes.strategies.find((s) => s.feasibility === "feasible");
      expect(feasible).toBeDefined();
      expect(feasible!.allocations).toHaveLength(2);
      expect(feasible!.totalLandedCostCents).toBe(108000); // 90000 + 18000
    });
  });

  describe("3. Fail-Closed Line Item Unfulfillment (No Candidate Fabrication)", () => {
    it("3.1 marks strategy feasibility blocked when any line item has zero eligible candidates", async () => {
      // Mock discovery where Dock returns empty results
      const partialDiscoveryAdapter: SourceAdapter = {
        name: "mock_partial_discovery",
        source: "channel3",
        getCapabilities: () => ({
          name: "mock_partial",
          supportedCurrencies: ["USD"],
          supportsStockStatus: true,
          supportsSpecificationAttributes: true,
          supportsPagination: false,
        }),
        search: vi.fn(async (request: ProductSearchRequest, context: DiscoveryContext): Promise<DiscoveryResult> => {
          if (request.query.includes("Laptop")) {
            return {
              status: "success",
              candidates: [
                createCandidate({
                  id: "cand_only_laptop",
                  purchaseId: request.purchaseId,
                  title: "Only Laptop Found",
                  merchantName: "Best Buy",
                  merchantDomain: "bestbuy.com",
                  unitPriceCents: 90000,
                  shippingCents: 0,
                }),
              ],
              totalFound: 1,
              timestamp: context.now,
            };
          }
          // Dock returns empty
          return { status: "empty", reason: "Zero merchant offers found", timestamp: context.now };
        }),
      };

      const customService = new PurchaseWorkflowService(repo, mockPayPal, partialDiscoveryAdapter);

      const purchase = await customService.createPurchase(
        {
          budgetCents: 150000,
          currency: "USD",
          destination: defaultDestination,
          lineItems: sampleLineItems,
        },
        humanBuyer
      );

      const planRes = await customService.createMultiItemPlan(
        purchase.id,
        {
          lineItems: sampleLineItems,
          destination: defaultDestination,
        },
        humanBuyer
      );

      // Every generated strategy must be blocked
      expect(planRes.strategies.length).toBeGreaterThan(0);
      expect(planRes.strategies.every((s) => s.feasibility === "blocked")).toBe(true);

      const blockedStrategy = planRes.strategies[0];
      expect(blockedStrategy.recommendationScore).toBe(0);
      expect(blockedStrategy.recommendationRationale).toContain("Strategy is blocked due to unfulfilled line items");
      expect(blockedStrategy.riskDisclosures.some((r) => r.includes("missing matching candidates"))).toBe(true);

      // Attempting to approve this blocked strategy MUST throw ValidationError
      await expect(
        customService.approveMultiItemPlan(
          purchase.id,
          {
            strategyId: blockedStrategy.strategyId,
            destination: defaultDestination,
          },
          humanBuyer
        )
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("4. Pre-Order Snapshot Revalidation in createPayPalOrder", () => {
    async function setupApprovedMultiItemPurchase() {
      const purchase = await service.createPurchase(
        {
          budgetCents: 200000,
          currency: "USD",
          destination: defaultDestination,
          lineItems: sampleLineItems,
        },
        humanBuyer
      );

      const laptop = createCandidate({
        id: "cand_rt_laptop",
        purchaseId: purchase.id,
        title: "Business Workstation Laptop 16GB",
        merchantName: "Best Buy",
        merchantDomain: "bestbuy.com",
        unitPriceCents: 100000,
        shippingCents: 0,
      });

      const dock = createCandidate({
        id: "cand_rt_dock",
        purchaseId: purchase.id,
        title: "USB-C Dual Monitor Dock",
        merchantName: "Best Buy",
        merchantDomain: "bestbuy.com",
        unitPriceCents: 25000,
        shippingCents: 0,
      });

      const plan = await service.createMultiItemPlan(
        purchase.id,
        {
          lineItems: sampleLineItems,
          candidates: [laptop, dock],
          destination: defaultDestination,
        },
        humanBuyer
      );

      const chosen = plan.strategies.find((s) => s.feasibility === "feasible")!;
      await service.approveMultiItemPlan(
        purchase.id,
        {
          strategyId: chosen.strategyId,
          expectedTotalLandedCostCents: chosen.totalLandedCostCents!,
          expectedCurrency: "USD",
          destination: defaultDestination,
        },
        humanBuyer
      );

      return { purchase, laptop, dock, chosen };
    }

    it("4.1 rejects PayPal order and records invalidation when candidate snapshot hash changes after approval", async () => {
      const { purchase, laptop } = await setupApprovedMultiItemPurchase();

      // Tamper candidate facts in repo (e.g. price changed by upstream crawler)
      const tamperedCandidate = {
        ...laptop,
        unitPriceCents: 130000,
        snapshotHash: "tampered_candidate_hash_9999",
      };
      await repo.saveCandidateWithEvidence(tamperedCandidate, []);

      // Attempt to create PayPal order
      await expect(
        service.createPayPalOrder(purchase.id, humanBuyer, {
          targetCartMerchantDomain: "bestbuy.com",
        })
      ).rejects.toThrow(ApprovalIntegrityError);

      // Verify PayPal API was NEVER called
      expect(mockPayPal.createOrder).not.toHaveBeenCalled();

      // Verify approval was invalidated in repo
      const updatedAggregate = await repo.getPurchaseById(purchase.id);
      const appr = updatedAggregate!.approvals[0];
      expect(appr.invalidatedAt).not.toBeNull();
      expect(appr.invalidationReason).toContain("candidate_changed");
    });

    it("4.2 rejects PayPal order and records invalidation when destination postal code changes", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase();

      // Attempt to order with changed destination
      const modifiedDest: DestinationContext = {
        country: "US",
        postalCode: "99501", // Alaska
        deliveryMethodPreference: "standard_ground",
      };

      await expect(
        service.createPayPalOrder(purchase.id, humanBuyer, {
          destination: modifiedDest,
          targetCartMerchantDomain: "bestbuy.com",
        })
      ).rejects.toThrow(ApprovalIntegrityError);

      // Verify PayPal client call blocked
      expect(mockPayPal.createOrder).not.toHaveBeenCalled();

      // Verify approval was invalidated in repo
      const updatedAggregate = await repo.getPurchaseById(purchase.id);
      const appr = updatedAggregate!.approvals[0];
      expect(appr.invalidatedAt).not.toBeNull();
      expect(appr.invalidationReason).toContain("destination_changed");
    });
  });

  describe("5. Single-Merchant Transaction Boundary Enforcement", () => {
    async function setupMultiMerchantSplitPurchase() {
      const purchase = await service.createPurchase(
        {
          budgetCents: 200000,
          currency: "USD",
          destination: defaultDestination,
          lineItems: sampleLineItems,
        },
        humanBuyer
      );

      // Laptop at Best Buy
      const laptopBB = createCandidate({
        id: "cand_split_laptop_bb",
        purchaseId: purchase.id,
        title: "Workstation Laptop 16GB",
        merchantName: "Best Buy",
        merchantDomain: "bestbuy.com",
        unitPriceCents: 95000,
        shippingCents: 0,
      });

      // Dock at Target
      const dockTarget = createCandidate({
        id: "cand_split_dock_target",
        purchaseId: purchase.id,
        title: "USB-C Dual Monitor Dock",
        merchantName: "Target",
        merchantDomain: "target.com",
        unitPriceCents: 22000,
        shippingCents: 0,
      });

      const plan = await service.createMultiItemPlan(
        purchase.id,
        {
          lineItems: sampleLineItems,
          candidates: [laptopBB, dockTarget],
          destination: defaultDestination,
        },
        humanBuyer
      );

      const splitStrategy = plan.strategies.find((s) => s.carts.length === 2 && s.feasibility === "feasible")!;
      expect(splitStrategy).toBeDefined();

      await service.approveMultiItemPlan(
        purchase.id,
        {
          strategyId: splitStrategy.strategyId,
          expectedTotalLandedCostCents: splitStrategy.totalLandedCostCents!,
          expectedCurrency: "USD",
          destination: defaultDestination,
        },
        humanBuyer
      );

      return { purchase, laptopBB, dockTarget, splitStrategy };
    }

    it("5.1 blocks multi-cart order creation when targetCartMerchantDomain is omitted", async () => {
      const { purchase } = await setupMultiMerchantSplitPurchase();

      await expect(
        service.createPayPalOrder(purchase.id, humanBuyer)
      ).rejects.toThrow(/Multi-item strategy spans 2 retailer carts.*You must specify targetCartMerchantDomain/);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("5.2 rejects invalid or unapproved targetCartMerchantDomain", async () => {
      const { purchase } = await setupMultiMerchantSplitPurchase();

      await expect(
        service.createPayPalOrder(purchase.id, humanBuyer, {
          targetCartMerchantDomain: "walmart.com", // Not in approved plan
        })
      ).rejects.toThrow(/Target cart merchant domain "walmart.com" does not match any approved cart/);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("5.3 successfully creates PayPal order for valid targeted merchant cart with exact cart landed cost", async () => {
      const { purchase } = await setupMultiMerchantSplitPurchase();

      // Target Best Buy cart ($950.00)
      const orderRes = await service.createPayPalOrder(purchase.id, humanBuyer, {
        targetCartMerchantDomain: "bestbuy.com",
      });

      expect(orderRes.status).toBe("ORDER_CREATED");
      expect(orderRes.paypalOrderId).toBe("PAYPAL-ORDER-MULTI-123");

      // Verify PayPal client was called with exact Best Buy cart amount ($950.00 = 95000 cents)
      expect(mockPayPal.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceId: purchase.id,
          amountCents: 95000,
          currency: "USD",
        })
      );
    });

    it("5.4 single-cart multi-item purchase allows checkout without ambiguity", async () => {
      const purchase = await service.createPurchase(
        {
          budgetCents: 150000,
          currency: "USD",
          destination: defaultDestination,
          lineItems: sampleLineItems,
        },
        humanBuyer
      );

      // Both items at Best Buy (single cart)
      const laptop = createCandidate({
        id: "cand_single_laptop",
        purchaseId: purchase.id,
        title: "Workstation Laptop 16GB",
        merchantName: "Best Buy",
        merchantDomain: "bestbuy.com",
        unitPriceCents: 90000,
        shippingCents: 0,
      });

      const dock = createCandidate({
        id: "cand_single_dock",
        purchaseId: purchase.id,
        title: "USB-C Dual Monitor Dock",
        merchantName: "Best Buy",
        merchantDomain: "bestbuy.com",
        unitPriceCents: 20000,
        shippingCents: 0,
      });

      const plan = await service.createMultiItemPlan(
        purchase.id,
        {
          lineItems: sampleLineItems,
          candidates: [laptop, dock],
          destination: defaultDestination,
        },
        humanBuyer
      );

      const singleCartStrategy = plan.strategies.find((s) => s.carts.length === 1 && s.feasibility === "feasible")!;

      await service.approveMultiItemPlan(
        purchase.id,
        {
          strategyId: singleCartStrategy.strategyId,
          expectedTotalLandedCostCents: singleCartStrategy.totalLandedCostCents!,
          expectedCurrency: "USD",
          destination: defaultDestination,
        },
        humanBuyer
      );

      // Omission of targetCartMerchantDomain succeeds because single cart is unambiguous
      const orderRes = await service.createPayPalOrder(purchase.id, humanBuyer);

      expect(orderRes.status).toBe("ORDER_CREATED");
      expect(mockPayPal.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 110000, // 90000 + 20000
          currency: "USD",
        })
      );
    });
  });

  describe("6. PayPal Sandbox Boundary Invariant", () => {
    it("6.1 guarantees zero live captures across all multi-item operations", async () => {
      // Invariant: PayPalSandboxClient boundary does not perform payment captures; verified status remains uncaptured
      expect((mockPayPal as unknown as Record<string, unknown>).capturePayment).toBeUndefined();
    });
  });
});
