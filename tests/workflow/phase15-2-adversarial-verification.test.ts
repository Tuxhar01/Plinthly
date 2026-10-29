/**
 * Plinthly Phase 15.2 — Adversarial Runtime Verification and Checkout Integrity.
 *
 * Comprehensive adversarial test suite covering all 12 specified scenarios:
 * 1. Process/service restart retention of approval identity.
 * 2. Candidate/Price/Quote/Shipping/Destination/Allocation/Policy change invalidation.
 * 3. Quote expiration, merchant mismatch, and destination geographic exclusion.
 * 4. Stored snapshot/approval record tampering and candidate inconsistency.
 * 5. Concurrent checkout race conditions against same approval (optimistic concurrency / lock checks).
 * 6. Replay attack: reusing payment attempt or approval for different cart or amount.
 * 7. Multi-merchant checkout attempted without explicit target cart domain.
 * 8. Targeted cart amount manipulation vs approved cart amount.
 * 9. Unfulfilled line items and discovery partial failures (fail-closed, 0 candidate fabrication).
 * 10. Policy update or approval invalidation between approval and checkout.
 * 11. Server restart after invalidation retains invalidated status.
 * 12. Remote PayPal error handling (timeout, 404, nonterminal status, network error).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import {
  InMemoryPurchaseRepository,
  CandidateRecord,
  ApprovalRecord,
  PurchaseRecord,
} from "../../lib/workflow/repository";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { Actor } from "../../lib/state/types";
import { DestinationContext } from "../../lib/discovery/shipping";
import { NormalizedProductCandidate } from "../../lib/discovery/types";
import { ProcurementLineItem } from "../../lib/discovery/cart/types";
import {
  ApprovalIntegrityError,
  ValidationError,
  IdempotencyConflictError,
  IllegalTransitionError,
  WorkflowError,
} from "../../lib/workflow/errors";
import {
  PayPalTimeoutError,
  PayPalUnknownOutcomeError,
  PayPalApiError,
  PayPalNetworkError,
} from "../../lib/paypal/types";
import { PaymentVerificationService } from "../../lib/paypal/verification";

describe("PLINTHLY — PHASE 15.2: Adversarial Runtime Verification & Checkout Integrity", () => {
  const defaultDestination: DestinationContext = {
    country: "US",
    postalCode: "94103",
    deliveryMethodPreference: "standard_ground",
  };

  const buyerActor: Actor = { kind: "user", userId: "usr_adversary_buyer_1" };

  let repo: InMemoryPurchaseRepository;
  let mockPayPal: PayPalSandboxClient;
  let service: PurchaseWorkflowService;

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
    mockPayPal = {
      createOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL-ORDER-ADV-001",
        status: "CREATED",
        links: [
          {
            rel: "approve",
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-ADV-001",
            method: "GET",
          },
        ],
      }),
      getOrder: vi.fn(),
    } as unknown as PayPalSandboxClient;

    service = new PurchaseWorkflowService(repo, mockPayPal);
  });

  const lineItemsTwoMerchants: ProcurementLineItem[] = [
    {
      id: "line_laptop",
      title: "ThinkPad Workstation Laptop",
      quantity: 1,
      budgetCents: 120000,
      currency: "USD",
      requirements: [{ key: "ram", expectedValue: "16GB", description: "16GB RAM" }],
      verificationLevel: "standard",
    },
    {
      id: "line_monitor",
      title: "4K UHD 27-inch Monitor",
      quantity: 1,
      budgetCents: 50000,
      currency: "USD",
      requirements: [{ key: "resolution", expectedValue: "4k", description: "4K Resolution" }],
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
    availability?: string;
    isMarketplace?: boolean;
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
      availability: params.availability ?? "in_stock",
      source: "channel3",
      capturedAt: new Date(),
      snapshotHash: snapHash,
      rawSourceData: {},
      isComplete: true,
      validationErrors: [],
      sellerName: params.isMarketplace ? "Third-Party Marketplace Seller" : params.merchantName,
      isMarketplace: params.isMarketplace ?? false,
      isDirectRetailerSeller: !params.isMarketplace,
      fulfillmentMethod: "standard_ground",
    };
  }

  async function setupApprovedMultiItemPurchase(options?: {
    singleMerchant?: boolean;
    destination?: DestinationContext;
  }) {
    const purchase = await service.createPurchase(
      {
        budgetCents: 200000,
        currency: "USD",
        destination: options?.destination ?? defaultDestination,
        lineItems: lineItemsTwoMerchants,
      },
      buyerActor
    );

    const candLaptop = createCandidate({
      id: "cand_laptop_bb",
      purchaseId: purchase.id,
      title: "ThinkPad Workstation Laptop 16GB",
      merchantName: "Best Buy",
      merchantDomain: "bestbuy.com",
      unitPriceCents: 95000,
      shippingCents: 0,
    });

    const candMonitor = createCandidate({
      id: options?.singleMerchant ? "cand_mon_bb" : "cand_mon_walmart",
      purchaseId: purchase.id,
      title: "4K UHD 27-inch Monitor",
      merchantName: options?.singleMerchant ? "Best Buy" : "Walmart",
      merchantDomain: options?.singleMerchant ? "bestbuy.com" : "walmart.com",
      unitPriceCents: 35000,
      shippingCents: 0,
    });

    const planRes = await service.createMultiItemPlan(
      purchase.id,
      {
        lineItems: lineItemsTwoMerchants,
        candidates: [candLaptop, candMonitor],
        destination: options?.destination ?? defaultDestination,
      },
      buyerActor
    );

    const chosenStrategy = planRes.strategies.find((s) => s.feasibility === "feasible")!;
    expect(chosenStrategy).toBeDefined();

    const approvedPlan = await service.approveMultiItemPlan(
      purchase.id,
      {
        strategyId: chosenStrategy.strategyId,
        expectedTotalLandedCostCents: chosenStrategy.totalLandedCostCents!,
        expectedCurrency: "USD",
        destination: options?.destination ?? defaultDestination,
      },
      buyerActor
    );

    return {
      purchase,
      plan: planRes,
      strategy: chosenStrategy,
      approval: approvedPlan,
      candidates: [candLaptop, candMonitor],
    };
  }

  // Helper to directly mutate repository private store for tampering tests
  function mutateRepoCandidate(candId: string, mutateFn: (cand: CandidateRecord) => void) {
    const internalCandidates = (repo as unknown as { candidates: Map<string, CandidateRecord> }).candidates;
    const existing = internalCandidates.get(candId);
    if (existing) {
      const copy = { ...existing };
      mutateFn(copy);
      internalCandidates.set(candId, copy);
    }
  }

  function mutateRepoApproval(purchaseId: string, mutateFn: (appr: ApprovalRecord) => void) {
    const internalApprovals = (repo as unknown as { approvals: Map<string, ApprovalRecord[]> }).approvals;
    const existingList = internalApprovals.get(purchaseId) ?? [];
    if (existingList.length > 0) {
      const copyList = existingList.map((a) => {
        const copy = { ...a };
        mutateFn(copy);
        return copy;
      });
      internalApprovals.set(purchaseId, copyList);
    }
  }

  function mutateRepoPurchase(purchaseId: string, mutateFn: (p: PurchaseRecord) => void) {
    const internalPurchases = (repo as unknown as { purchases: Map<string, PurchaseRecord> }).purchases;
    const existing = internalPurchases.get(purchaseId);
    if (existing) {
      const copy = { ...existing };
      mutateFn(copy);
      internalPurchases.set(purchaseId, copy);
    }
  }

  // ==========================================================================
  // SCENARIO 1: Process/Service Restart Retention of Approval Identity
  // ==========================================================================
  describe("Scenario 1: Process/Service Restart Retention of Approval Identity", () => {
    it("1.1 approval snapshot identity, strategy allocations, and retailer carts remain valid after cold restart", async () => {
      const { purchase, approval } = await setupApprovedMultiItemPurchase();
      const approvedHash = approval.activeApproval!.multiItemSnapshotHash;
      expect(approvedHash).toHaveLength(64);

      // Simulate cold service restart: New service instance over existing repository
      const coldService = new PurchaseWorkflowService(repo, mockPayPal);

      // Cold service creates PayPal order directly from durable persisted state
      const orderRes = await coldService.createPayPalOrder(purchase.id, buyerActor, {
        targetCartMerchantDomain: "bestbuy.com",
      });

      expect(orderRes.status).toBe("ORDER_CREATED");
      expect(orderRes.paypalOrderId).toBe("PAYPAL-ORDER-ADV-001");
      expect(orderRes.amountCents).toBe(95000); // Exact Best Buy cart amount
      expect(mockPayPal.createOrder).toHaveBeenCalledTimes(1);

      // Check persistence after order creation
      const persisted = await repo.getPurchaseById(purchase.id);
      expect(persisted?.purchase.status).toBe("ORDER_CREATED");
      expect(persisted?.paymentAttempts).toHaveLength(1);
      expect(persisted?.paymentAttempts[0].status).toBe("OPEN");
    });
  });

  // ==========================================================================
  // SCENARIO 2: Candidate / Price / Quote / Shipping / Destination Change Invalidation
  // ==========================================================================
  describe("Scenario 2: Candidate/Price/Quote/Shipping/Destination/Policy Change Invalidation", () => {
    it("2.1 fails closed and invalidates approval if candidate unit price changes post-approval", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase();

      // Mutate stored candidate record directly in repository
      mutateRepoCandidate("cand_laptop_bb", (c) => {
        c.unitPriceCents = 105000; // Price increased by $100
      });

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, { targetCartMerchantDomain: "bestbuy.com" })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();

      // Verify approval record was invalidated in repository
      const fresh = await repo.getPurchaseById(purchase.id);
      const eff = fresh?.approvals.find((a) => a.invalidatedAt === null);
      expect(eff).toBeUndefined();
    });

    it("2.2 fails closed and invalidates approval if candidate shipping cost changes post-approval", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase();

      // Mutate stored candidate shipping fee in repository
      mutateRepoCandidate("cand_laptop_bb", (c) => {
        c.shippingCents = 1500; // $15 shipping fee added
      });

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, { targetCartMerchantDomain: "bestbuy.com" })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("2.3 fails closed and invalidates approval if candidate availability becomes out_of_stock", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase();

      // Mutate stored candidate availability to out_of_stock
      mutateRepoCandidate("cand_laptop_bb", (c) => {
        c.availability = "out_of_stock";
      });

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, { targetCartMerchantDomain: "bestbuy.com" })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("2.4 fails closed and invalidates approval if destination postal code changes at checkout", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase();

      // Attempt checkout with a different postal code
      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, {
          targetCartMerchantDomain: "bestbuy.com",
          destination: { country: "US", postalCode: "90210", deliveryMethodPreference: "standard_ground" },
        })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("2.5 fails closed if allocated candidate record is deleted or missing from repository", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase();

      // Clear candidates list in repository
      (repo as unknown as { candidates: Map<string, CandidateRecord> }).candidates.clear();

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, { targetCartMerchantDomain: "bestbuy.com" })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SCENARIO 3: Quote Expiration, Merchant Mismatch, Destination Exclusion
  // ==========================================================================
  describe("Scenario 3: Quote Expiration, Merchant Mismatch, and Destination Exclusion", () => {
    it("3.1 rejects checkout immediately when shipping quote has expired", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase();

      const expiredTime = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, {
          targetCartMerchantDomain: "bestbuy.com",
          shippingQuote: {
            quoteId: "quote_expired_1",
            amountCents: 0,
            currency: "USD",
            expiresAt: expiredTime,
          },
        })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("3.2 fails closed with ValidationError when targetCartMerchantDomain does not match approved carts", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase();

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, {
          targetCartMerchantDomain: "unknown-store.com",
        })
      ).rejects.toThrow(ValidationError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("3.3 fails closed when destination postal code is excluded under merchant policy", async () => {
      // Setup purchase for excluded zip code in Alaska/Hawaii
      const excludedDest: DestinationContext = {
        country: "US",
        postalCode: "99501", // Alaska
        deliveryMethodPreference: "standard_ground",
      };

      const { purchase } = await setupApprovedMultiItemPurchase({ destination: excludedDest });

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, {
          targetCartMerchantDomain: "bestbuy.com",
        })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SCENARIO 4: Stored Snapshot / Approval Record Tampering
  // ==========================================================================
  describe("Scenario 4: Stored Snapshot/Approval Record Tampering & Candidate Inconsistency", () => {
    it("4.1 detects tampered snapshotHash in approval record and blocks order creation", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase();

      // Tamper with approval record's snapshotHash in repo
      mutateRepoApproval(purchase.id, (a) => {
        a.snapshotHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      });

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, { targetCartMerchantDomain: "bestbuy.com" })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("4.2 detects tampered totalCents in approval record and blocks order creation", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase();

      // Tamper with approval record's totalCents in repo
      mutateRepoApproval(purchase.id, (a) => {
        a.totalCents = 1000; // Reduced from 130000
      });

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, { targetCartMerchantDomain: "bestbuy.com" })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("4.3 detects tampered line items count in requirements JSON and blocks order creation", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase();

      // Tamper with requirements JSON by adding an extra line item
      mutateRepoPurchase(purchase.id, (p) => {
        const req = p.requirements as Record<string, unknown>;
        (req.lineItems as unknown[]).push({
          id: "line_fraudulent_item",
          title: "Fraudulent Gift Card",
          quantity: 1,
          budgetCents: 50000,
          currency: "USD",
        });
      });

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, { targetCartMerchantDomain: "bestbuy.com" })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("4.4 detects candidate total inconsistency with unitPrice * quantity + shipping", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase();

      // Tamper candidate totalCents in repo without changing unitPrice
      mutateRepoCandidate("cand_laptop_bb", (c) => {
        c.totalCents = 50000; // Inconsistent with unitPrice (95000)
      });

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, { targetCartMerchantDomain: "bestbuy.com" })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SCENARIO 5: Concurrent Checkout Race Conditions Against Same Approval
  // ==========================================================================
  describe("Scenario 5: Concurrent Checkout Race Conditions Against Same Approval", () => {
    it("5.1 handles parallel order creation requests safely with zero duplicate PayPal orders", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase({ singleMerchant: true });

      // Launch 3 simultaneous requests to create PayPal order for the same purchase
      const [res1, res2, res3] = await Promise.allSettled([
        service.createPayPalOrder(purchase.id, buyerActor),
        service.createPayPalOrder(purchase.id, buyerActor),
        service.createPayPalOrder(purchase.id, buyerActor),
      ]);

      const fulfilled = [res1, res2, res3].filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Verify that all fulfilled calls received the identical PayPal order ID
      const orderIds = fulfilled.map(
        (f) => (f as PromiseFulfilledResult<{ paypalOrderId: string }>).value.paypalOrderId
      );
      expect(new Set(orderIds).size).toBe(1);

      // Verify PayPal client was called exactly ONCE
      expect(mockPayPal.createOrder).toHaveBeenCalledTimes(1);

      // Verify exactly 1 payment attempt was recorded in repository
      const fresh = await repo.getPurchaseById(purchase.id);
      expect(fresh?.purchase.status).toBe("ORDER_CREATED");
      expect(fresh?.paymentAttempts).toHaveLength(1);
      expect(fresh?.paymentAttempts[0].status).toBe("OPEN");
    });
  });

  // ==========================================================================
  // SCENARIO 6: Replay Attacks & Status Invariants
  // ==========================================================================
  describe("Scenario 6: Replay Attack and Status Invariants", () => {
    it("6.1 replaying idempotency key with different payload throws IdempotencyConflictError with 0 PayPal calls", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase({ singleMerchant: true });

      // First call succeeds with custom idempotency key
      const order1 = await service.createPayPalOrder(purchase.id, buyerActor, {
        idempotencyKey: "idem_custom_key_001",
      });
      expect(order1.status).toBe("ORDER_CREATED");
      expect(mockPayPal.createOrder).toHaveBeenCalledTimes(1);

      // Mutate the saved idempotency record requestHash to simulate replay with different parameters
      const compoundKey = `${buyerActor.userId}:create_paypal_order:idem_custom_key_001`;
      const savedIdem = (repo as unknown as { idempotencyRecords: Map<string, unknown> }).idempotencyRecords.get(compoundKey);
      if (savedIdem) {
        (savedIdem as { requestHash: string }).requestHash = "different_hash_tampered_request";
      }

      // Replay same idempotency key with fresh service to bypass in-memory in-flight map
      const freshService = new PurchaseWorkflowService(repo, mockPayPal);

      await expect(
        freshService.createPayPalOrder(purchase.id, buyerActor, {
          idempotencyKey: "idem_custom_key_001",
        })
      ).rejects.toThrow(IdempotencyConflictError);

      // Zero new PayPal calls
      expect(mockPayPal.createOrder).toHaveBeenCalledTimes(1);
    });

    it("6.2 calling createPayPalOrder after order is already created safely returns existing attempt without calling PayPal", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase({ singleMerchant: true });

      const firstOrder = await service.createPayPalOrder(purchase.id, buyerActor);
      expect(mockPayPal.createOrder).toHaveBeenCalledTimes(1);

      // Second call returns existing attempt without calling PayPal createOrder
      const secondOrder = await service.createPayPalOrder(purchase.id, buyerActor);
      expect(secondOrder.paypalOrderId).toBe(firstOrder.paypalOrderId);
      expect(mockPayPal.createOrder).toHaveBeenCalledTimes(1);
    });

    it("6.3 calling createPayPalOrder after status has advanced to BUYER_APPROVED throws IllegalTransitionError", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase({ singleMerchant: true });

      await service.createPayPalOrder(purchase.id, buyerActor);

      // Mutate stored purchase status in repository to BUYER_APPROVED
      mutateRepoPurchase(purchase.id, (p) => {
        p.status = "BUYER_APPROVED";
      });

      // Clear in-flight map with fresh service
      const freshService = new PurchaseWorkflowService(repo, mockPayPal);

      await expect(freshService.createPayPalOrder(purchase.id, buyerActor)).rejects.toThrow(
        IllegalTransitionError
      );

      // Zero new PayPal calls
      expect(mockPayPal.createOrder).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // SCENARIO 7: Multi-Merchant Checkout Without Explicit Target Cart Domain
  // ==========================================================================
  describe("Scenario 7: Multi-Merchant Checkout Without Target Domain", () => {
    it("7.1 fails closed with ValidationError when multi-cart strategy has no targetCartMerchantDomain", async () => {
      // Setup purchase spanning Best Buy + Walmart
      const { purchase } = await setupApprovedMultiItemPurchase({ singleMerchant: false });

      await expect(service.createPayPalOrder(purchase.id, buyerActor)).rejects.toThrow(
        ValidationError
      );

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SCENARIO 8: Targeted Cart Amount Manipulation vs Approved Cart Amount
  // ==========================================================================
  describe("Scenario 8: Targeted Cart Amount Manipulation vs Approved Cart Amount", () => {
    it("8.1 server calculates PayPal order amount strictly from targeted cart; rejects tampered remote order amounts", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase({ singleMerchant: false });

      // Target Best Buy cart ($950.00)
      const order = await service.createPayPalOrder(purchase.id, buyerActor, {
        targetCartMerchantDomain: "bestbuy.com",
      });

      expect(order.amountCents).toBe(95000); // Only Best Buy, NOT cross-merchant total ($1,300)
      expect(mockPayPal.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 95000,
          currency: "USD",
        })
      );

      // Verify remote order amount tampering rejection in confirmBuyerApproval
      (mockPayPal.getOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: order.paypalOrderId,
        status: "APPROVED",
        purchase_units: [
          {
            reference_id: purchase.id,
            amount: { currency_code: "USD", value: "999.99" }, // Attacker tampered amount!
          },
        ],
      });

      await expect(
        service.confirmBuyerApproval(purchase.id, buyerActor, {
          paypalOrderId: order.paypalOrderId,
        })
      ).rejects.toThrow(WorkflowError);
    });
  });

  // ==========================================================================
  // SCENARIO 9: Unfulfilled Line Items or Discovery Partial Failures
  // ==========================================================================
  describe("Scenario 9: Unfulfilled Line Items and Discovery Partial Failures", () => {
    it("9.1 marks strategy infeasible/blocked and blocks approval when a line item has zero candidates (0 candidate fabrication)", async () => {
      const purchase = await service.createPurchase(
        {
          budgetCents: 200000,
          currency: "USD",
          destination: defaultDestination,
          lineItems: lineItemsTwoMerchants,
        },
        buyerActor
      );

      // Only 1 candidate provided (laptop), monitor candidate is missing completely
      const candLaptopOnly = createCandidate({
        id: "cand_laptop_lonely",
        purchaseId: purchase.id,
        title: "ThinkPad Workstation Laptop",
        merchantName: "Best Buy",
        merchantDomain: "bestbuy.com",
        unitPriceCents: 95000,
      });

      const planRes = await service.createMultiItemPlan(
        purchase.id,
        {
          lineItems: lineItemsTwoMerchants,
          candidates: [candLaptopOnly],
          destination: defaultDestination,
        },
        buyerActor
      );

      // Every generated strategy must be blocked/infeasible with non-defensible landed cost
      for (const strat of planRes.strategies) {
        expect(strat.feasibility).toBe("blocked");
        expect(strat.isLandedCostDefensible).toBe(false);
      }

      // Attempting to approve any infeasible strategy must fail closed
      await expect(
        service.approveMultiItemPlan(
          purchase.id,
          {
            strategyId: planRes.strategies[0].strategyId,
            destination: defaultDestination,
          },
          buyerActor
        )
      ).rejects.toThrow(ValidationError);
    });
  });

  // ==========================================================================
  // SCENARIO 10: Policy Update Between Approval and Checkout
  // ==========================================================================
  describe("Scenario 10: Policy Update Between Approval and Checkout", () => {
    it("10.1 blocks order creation and invalidates approval if retailer policy is superseded", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase({ singleMerchant: true });

      // Mutate the approval record's policyVersion so it's superseded
      mutateRepoApproval(purchase.id, (a) => {
        a.policyVersion = "0.9.0-deprecated";
      });

      mutateRepoPurchase(purchase.id, (p) => {
        const req = p.requirements as Record<string, unknown> as {
          approvedStrategy: { carts: { policyVersion: string }[] };
        };
        req.approvedStrategy.carts[0].policyVersion = "0.9.0-deprecated";
      });

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, { targetCartMerchantDomain: "bestbuy.com" })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SCENARIO 11: Server Restart After Invalidation Retains Invalidated Status
  // ==========================================================================
  describe("Scenario 11: Server Restart After Invalidation Retains Invalidated Status", () => {
    it("11.1 restart does not resurrect an invalidated approval", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase({ singleMerchant: true });

      // Invalidate approval directly in repo
      mutateRepoApproval(purchase.id, (a) => {
        a.invalidatedAt = new Date();
        a.invalidationReason = "candidate_changed";
      });

      // Cold restart
      const reloadedService = new PurchaseWorkflowService(repo, mockPayPal);

      // Attempt checkout on reloaded service
      await expect(
        reloadedService.createPayPalOrder(purchase.id, buyerActor, {
          targetCartMerchantDomain: "bestbuy.com",
        })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SCENARIO 12: Remote PayPal Error Handling
  // ==========================================================================
  describe("Scenario 12: Remote PayPal Error Handling", () => {
    it("12.1 handles PayPalTimeoutError with PayPalUnknownOutcomeError; state retained", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase({ singleMerchant: true });

      (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new PayPalTimeoutError("Connection timed out after 10000ms")
      );

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, { targetCartMerchantDomain: "bestbuy.com" })
      ).rejects.toThrow(PayPalUnknownOutcomeError);

      // Status remains APPROVED (no half-baked payment attempt recorded)
      const fresh = await repo.getPurchaseById(purchase.id);
      expect(fresh?.purchase.status).toBe("APPROVED");
      expect(fresh?.paymentAttempts).toHaveLength(0);
    });

    it("12.2 handles 404 Resource Not Found by recording NOT_FOUND and preserving audit records", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase({ singleMerchant: true });

      const order = await service.createPayPalOrder(purchase.id, buyerActor, {
        targetCartMerchantDomain: "bestbuy.com",
      });

      // Remote returns 404
      (mockPayPal.getOrder as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new PayPalApiError(404, "RESOURCE_NOT_FOUND", "Order not found", "DEBUG-404")
      );

      await expect(
        service.confirmBuyerApproval(purchase.id, buyerActor, {
          paypalOrderId: order.paypalOrderId,
        })
      ).rejects.toThrow(WorkflowError);

      // Payment verification service handles 404 gracefully preserving audit history
      const verificationService = new PaymentVerificationService(repo, mockPayPal);
      const verifyRes = await verificationService.verifyPayment(purchase.id, buyerActor);

      expect(verifyRes.outcome).toBe("REMOTE_NOT_FOUND");
      expect(verifyRes.verified).toBe(false);

      // Historical audit history preserved
      const auditHistory = await repo.getAuditHistory(purchase.id);
      expect(auditHistory.length).toBeGreaterThanOrEqual(1);
    });

    it("12.3 handles nonterminal PayPal order status (CREATED, PAYER_ACTION_REQUIRED) cleanly", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase({ singleMerchant: true });

      const order = await service.createPayPalOrder(purchase.id, buyerActor, {
        targetCartMerchantDomain: "bestbuy.com",
      });

      // Single merchant total is 130000 cents ($1300.00)
      (mockPayPal.getOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: order.paypalOrderId,
        status: "PAYER_ACTION_REQUIRED",
        links: [
          {
            rel: "approve",
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-ADV-001",
            method: "GET",
          },
        ],
        purchase_units: [
          {
            reference_id: purchase.id,
            amount: { currency_code: "USD", value: "1300.00" },
          },
        ],
      });

      await expect(
        service.confirmBuyerApproval(purchase.id, buyerActor, {
          paypalOrderId: order.paypalOrderId,
        })
      ).rejects.toThrow(WorkflowError);

      const verificationService = new PaymentVerificationService(repo, mockPayPal);
      const verifyRes = await verificationService.verifyPayment(purchase.id, buyerActor);

      expect(verifyRes.outcome).toBe("PENDING_BUYER_ACTION");
      expect(verifyRes.verified).toBe(false);
      expect(verifyRes.remoteStatus).toBe("PAYER_ACTION_REQUIRED");
    });

    it("12.4 handles PayPalNetworkError during verification with UNVERIFIED_TRANSIENT; state retained", async () => {
      const { purchase } = await setupApprovedMultiItemPurchase({ singleMerchant: true });

      await service.createPayPalOrder(purchase.id, buyerActor, {
        targetCartMerchantDomain: "bestbuy.com",
      });

      (mockPayPal.getOrder as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new PayPalNetworkError("DNS lookup failed for sandbox.paypal.com")
      );

      const verificationService = new PaymentVerificationService(repo, mockPayPal);
      const verifyRes = await verificationService.verifyPayment(purchase.id, buyerActor);

      expect(verifyRes.outcome).toBe("UNVERIFIED_TRANSIENT");
      expect(verifyRes.verified).toBe(false);
      expect(verifyRes.internalStatus).toBe("ORDER_CREATED");
    });
  });
});
