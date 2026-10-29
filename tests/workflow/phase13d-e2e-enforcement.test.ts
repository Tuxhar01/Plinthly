import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  InMemoryPurchaseRepository,
} from "../../lib/workflow/repository";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import {
  PayPalSandboxClient,
} from "../../lib/paypal/client";
import {
  PayPalApiError,
  PayPalGetOrderResponse,
  PayPalOrderResponse,
} from "../../lib/paypal/types";
import {
  ApprovalIntegrityError,
  WorkflowError,
} from "../../lib/workflow/errors";
import { IdempotencyConflictError } from "../../lib/workflow/idempotency";
import {
  MerchantPolicyRegistry,
  DEFAULT_MERCHANT_POLICIES,
  setMerchantPolicyRegistry,
} from "../../lib/discovery/merchant-policy-registry";
import {
  PolicyProposalEngine,
  PolicyProposalError,
} from "../../lib/discovery/policy-ingestion/proposal-engine";
import {
  PolicyExtractionResult,
  PolicySourceRecord,
  ExtractedPolicyTerms,
} from "../../lib/discovery/policy-ingestion/types";
import { computePolicyFingerprint } from "../../lib/discovery/merchant-policy";
import { Actor } from "../../lib/state/types";

describe("Phase 13D — End-to-End Evidence Enforcement & Purchase Safety", () => {
  let repo: InMemoryPurchaseRepository;
  let mockPayPal: PayPalSandboxClient;
  let service: PurchaseWorkflowService;
  let registry: MerchantPolicyRegistry;
  let proposalEngine: PolicyProposalEngine;

  const testUser: Actor = { kind: "user", userId: "usr_buyer_primary" };
  const adminUser: Actor = { kind: "user", userId: "usr_compliance_lead" };
  const systemActor: Actor = { kind: "system", component: "background_scheduler" };

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
    registry = new MerchantPolicyRegistry(DEFAULT_MERCHANT_POLICIES);
    setMerchantPolicyRegistry(registry);
    proposalEngine = new PolicyProposalEngine();

    mockPayPal = {
      createOrder: vi.fn(),
      getOrder: vi.fn(),
    } as unknown as PayPalSandboxClient;

    service = new PurchaseWorkflowService(repo, mockPayPal);
  });

  // Helper to setup an approved purchase ready for order creation
  async function setupApprovedPurchase(overrides?: {
    shippingQuoteExpiresAt?: string;
    shippingPolicyVersion?: string;
    budgetCents?: number;
    destination?: string;
    unitPriceCents?: number;
    shippingCents?: number;
  }) {
    const policyVersion = overrides?.shippingPolicyVersion ?? "2.0.0";
    const budgetCents = overrides?.budgetCents ?? 25000;
    const dest = overrides?.destination ?? "10001";
    const unitPrice = overrides?.unitPriceCents ?? 15000;
    const shipping = overrides?.shippingCents ?? 0;
    const total = unitPrice + shipping;

    const purchase = await service.createPurchase(
      {
        budgetCents,
        currency: "USD",
        requirements: [],
      },
      testUser
    );

    const bestBuyPolicy = registry.getPoliciesForMerchant("Best Buy")[0];
    const nowIso = new Date().toISOString();

    const candData = {
      externalId: "sku_bb_laptop_001",
      title: "Best Buy Approved Laptop",
      merchantName: "Best Buy",
      merchantUrl: "https://www.bestbuy.com/site/laptop/123.p",
      unitPriceCents: unitPrice,
      quantity: 1,
      shippingCents: shipping,
      shippingType: "policy_derived",
      currency: "USD" as const,
      availability: "in_stock",
      isComplete: true,
      capturedAt: nowIso,
      sourceVerificationTimestamp: nowIso,
      policyId: bestBuyPolicy.policyId,
      policyDocumentFingerprint: bestBuyPolicy.policyDocumentFingerprint,
      policyVersion,
      policySourceUrl: bestBuyPolicy.policySourceUrl,
      destinationPostalCode: dest,
    };

    const evalRes = await service.evaluatePurchaseCandidate(
      purchase.id,
      {
        rawCandidate: candData,
        rawObservations: [
          {
            requirementKey: "destination",
            value: dest,
            sourceUrl: "https://plinthly.com/user/destination",
            sourceType: "user_context",
            capturedAt: nowIso,
          },
          {
            requirementKey: "shipping",
            value: JSON.stringify({
              policyId: bestBuyPolicy.policyId,
              policyVersion,
              policyFingerprint: bestBuyPolicy.policyDocumentFingerprint,
              expiresAt: overrides?.shippingQuoteExpiresAt ?? null,
            }),
            sourceUrl: bestBuyPolicy.policySourceUrl,
            sourceType: "merchant_policy",
            capturedAt: nowIso,
          },
        ],
        requiredRuleKeys: ["P-BUDGET"],
      },
      testUser
    );

    // Approve purchase
    const approval = await service.approvePurchase(
      purchase.id,
      {
        expectedSnapshotHash: evalRes.snapshotHash,
        expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
        expectedTotalCents: total,
        expectedCurrency: "USD",
        policyVersion,
      },
      testUser
    );

    return { purchase, evalRes, approval, bestBuyPolicy, totalCents: total };
  }

  // --------------------------------------------------------------------------
  // 1. Stale Approval Enforcement at PayPal Boundary
  // --------------------------------------------------------------------------
  describe("Stale Approval Rejection & Pre-Order Safety", () => {
    it("fails closed when policy version is superseded after buyer approval, giving ZERO calls to PayPal", async () => {
      const { purchase, approval, bestBuyPolicy } = await setupApprovedPurchase({
        shippingPolicyVersion: "2.0.0",
      });

      // Simulate official policy update: proposal approved bumping Best Buy policy to 2.1.0
      const updatedPolicy = {
        ...bestBuyPolicy,
        policyVersion: "2.1.0",
        thresholdCents: 4500, // Policy terms changed
      };
      const newFingerprint = computePolicyFingerprint(updatedPolicy);
      registry.publishPolicy({
        ...updatedPolicy,
        policyDocumentFingerprint: newFingerprint,
      });

      // Attempt to create PayPal order with stale approval (which was bound to 2.0.0)
      let errorThrown: unknown;
      try {
        await service.createPayPalOrder(purchase.id, testUser);
      } catch (err) {
        errorThrown = err;
      }

      expect(errorThrown).toBeInstanceOf(ApprovalIntegrityError);
      expect((errorThrown as ApprovalIntegrityError).code).toBe("policy_superseded");
      expect((errorThrown as ApprovalIntegrityError).message).toContain("policy_superseded");

      // Assert: PayPal client receives ZERO calls!
      expect(mockPayPal.createOrder).not.toHaveBeenCalled();

      // Assert: Database approval record was permanently invalidated
      const freshAggregate = await repo.getPurchaseById(purchase.id);
      const appRecord = freshAggregate?.approvals.find((a) => a.id === approval.approvalId);
      expect(appRecord?.invalidatedAt).not.toBeNull();
      expect(appRecord?.invalidationReason).toContain("policy_superseded");
    });

    it("fails closed when policy terms change under the exact same URL and version, giving ZERO calls to PayPal", async () => {
      const { purchase, bestBuyPolicy } = await setupApprovedPurchase({
        shippingPolicyVersion: "2.0.0",
      });

      // Simulate source terms change under identical URL: fingerprint changed
      const mutatedPolicy = {
        ...bestBuyPolicy,
        thresholdCents: 5000, // Threshold increased to $50
      };
      const mutatedFingerprint = computePolicyFingerprint(mutatedPolicy);
      registry.publishPolicy({
        ...mutatedPolicy,
        policyDocumentFingerprint: mutatedFingerprint,
      });

      await expect(
        service.createPayPalOrder(purchase.id, testUser)
      ).rejects.toThrow(ApprovalIntegrityError);

      // Assert PayPal was never called
      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("fails closed when shipping quote expires after approval, giving ZERO calls to PayPal", async () => {
      const expiredPastIso = new Date(Date.now() - 60_000).toISOString(); // 1 minute in the past
      const { purchase } = await setupApprovedPurchase({
        shippingQuoteExpiresAt: expiredPastIso,
      });

      let quoteErr: unknown;
      try {
        await service.createPayPalOrder(purchase.id, testUser);
      } catch (err) {
        quoteErr = err;
      }

      expect(quoteErr).toBeInstanceOf(ApprovalIntegrityError);
      expect((quoteErr as ApprovalIntegrityError).code).toBe("quote_expired");

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("fails closed when requested destination is changed to an excluded zone (e.g. Alaska), giving ZERO calls to PayPal", async () => {
      const { purchase } = await setupApprovedPurchase({
        destination: "10001", // Approved for New York (contiguous US)
      });

      // Call order creation requesting delivery to Anchorage, AK (excluded by Best Buy policy)
      await expect(
        service.createPayPalOrder(purchase.id, testUser, {
          destination: { country: "US", postalCode: "99501", deliveryMethodPreference: "standard_ground" }, // Alaska
        })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("fails closed when candidate landed cost exceeds purchase budget, giving ZERO calls to PayPal", async () => {
      // Set up purchase with budget $100 (10000 cents), candidate price $150 (15000 cents)
      const purchase = await service.createPurchase(
        {
          budgetCents: 10000,
          currency: "USD",
          requirements: [],
        },
        testUser
      );

      const bestBuyPolicy = registry.getPoliciesForMerchant("Best Buy")[0];
      const nowIso = new Date().toISOString();

      const candData = {
        externalId: "sku_bb_over_budget",
        title: "Best Buy Over Budget Laptop",
        merchantName: "Best Buy",
        merchantUrl: "https://www.bestbuy.com/site/laptop/over.p",
        unitPriceCents: 15000, // Exceeds budget 10000
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
        policySourceUrl: bestBuyPolicy.policySourceUrl,
        policyVersion: "2.0.0",
        destinationPostalCode: "10001",
      };

      // Evaluation blocks on P-BUDGET
      const evalRes = await service.evaluatePurchaseCandidate(
        purchase.id,
        {
          rawCandidate: candData,
          rawObservations: [],
          requiredRuleKeys: ["P-BUDGET"],
        },
        testUser
      );

      expect(evalRes.status).toBe("POLICY_BLOCKED");

      // Attempting to approve a blocked purchase fails
      await expect(
        service.approvePurchase(
          purchase.id,
          {
            expectedSnapshotHash: evalRes.snapshotHash,
            expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
            expectedTotalCents: 15000,
            expectedCurrency: "USD",
          },
          testUser
        )
      ).rejects.toThrow();

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 2. Policy Publication Security & Review Controls
  // --------------------------------------------------------------------------
  describe("Policy Publication Security & Review Controls", () => {
    it("refuses approval of policy proposal by non-human actor (system component)", () => {
      const bestBuy = registry.getPoliciesForMerchant("Best Buy")[0];
      const sourceRecord: PolicySourceRecord = {
        sourceUrl: bestBuy.policySourceUrl,
        retrievedAt: new Date().toISOString(),
        httpStatus: 200,
        etag: null,
        lastModified: null,
        rawContentHash: "rawhash_test_123",
        contentLength: 1000,
        isNotModified: false,
      };

      const terms: ExtractedPolicyTerms = {
        merchantDomain: "bestbuy.com",
        merchantName: "Best Buy",
        deliveryMethod: "standard_ground",
        currency: "USD",
        thresholdCents: 4500,
        shippingCostCents: 0,
        allowedZones: ["contiguous_us"],
        excludedZones: ["alaska", "hawaii", "us_territory"],
        requiresDirectRetailerSeller: true,
      };

      const mockExtract: PolicyExtractionResult = {
        status: "extracted",
        parserVersion: "2.0.0",
        warnings: [],
        explanation: "Threshold updated to $45.",
        terms,
      };

      const proposal = proposalEngine.evaluateIngestion(sourceRecord, mockExtract, bestBuy);
      expect(proposal.status).toBe("proposed");

      // Attempt to approve via system component (should be rejected)
      expect(() => {
        proposalEngine.approveProposal(proposal.proposalId, systemActor, registry);
      }).toThrow(PolicyProposalError);

      try {
        proposalEngine.approveProposal(proposal.proposalId, systemActor, registry);
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyProposalError);
        expect((err as PolicyProposalError).code).toBe("unauthorized_actor");
      }

      // Proposal remains in "proposed" status
      expect(proposalEngine.getProposal(proposal.proposalId)?.status).toBe("proposed");
    });

    it("refuses rejection of policy proposal by non-human actor", () => {
      const bestBuy = registry.getPoliciesForMerchant("Best Buy")[0];
      const sourceRecord: PolicySourceRecord = {
        sourceUrl: bestBuy.policySourceUrl,
        retrievedAt: new Date().toISOString(),
        httpStatus: 200,
        etag: null,
        lastModified: null,
        rawContentHash: "rawhash_test_456",
        contentLength: 1000,
        isNotModified: false,
      };

      const terms: ExtractedPolicyTerms = {
        merchantDomain: "bestbuy.com",
        merchantName: "Best Buy",
        deliveryMethod: "standard_ground",
        currency: "USD",
        thresholdCents: 4500,
        shippingCostCents: 0,
        allowedZones: ["contiguous_us"],
        excludedZones: ["alaska", "hawaii", "us_territory"],
        requiresDirectRetailerSeller: true,
      };

      const mockExtract: PolicyExtractionResult = {
        status: "extracted",
        parserVersion: "2.0.0",
        warnings: [],
        explanation: "Threshold updated.",
        terms,
      };

      const proposal = proposalEngine.evaluateIngestion(sourceRecord, mockExtract, bestBuy);

      expect(() => {
        proposalEngine.rejectProposal(proposal.proposalId, "Not permanent terms", systemActor);
      }).toThrow(PolicyProposalError);

      try {
        proposalEngine.rejectProposal(proposal.proposalId, "Not permanent terms", systemActor);
      } catch (err) {
        expect((err as PolicyProposalError).code).toBe("unauthorized_actor");
      }
    });

    it("prevents replaying already-approved or rejected policy proposals", () => {
      const bestBuy = registry.getPoliciesForMerchant("Best Buy")[0];
      const sourceRecord: PolicySourceRecord = {
        sourceUrl: bestBuy.policySourceUrl,
        retrievedAt: new Date().toISOString(),
        httpStatus: 200,
        etag: null,
        lastModified: null,
        rawContentHash: "rawhash_replay_test",
        contentLength: 1000,
        isNotModified: false,
      };

      const terms: ExtractedPolicyTerms = {
        merchantDomain: "bestbuy.com",
        merchantName: "Best Buy",
        deliveryMethod: "standard_ground",
        currency: "USD",
        thresholdCents: 4500,
        shippingCostCents: 0,
        allowedZones: ["contiguous_us"],
        excludedZones: ["alaska", "hawaii", "us_territory"],
        requiresDirectRetailerSeller: true,
      };

      const mockExtract: PolicyExtractionResult = {
        status: "extracted",
        parserVersion: "2.0.0",
        warnings: [],
        explanation: "Threshold change.",
        terms,
      };

      const proposal = proposalEngine.evaluateIngestion(sourceRecord, mockExtract, bestBuy);

      // First approval succeeds
      proposalEngine.approveProposal(proposal.proposalId, adminUser, registry);
      expect(proposalEngine.getProposal(proposal.proposalId)?.status).toBe("validated");

      // Second approval attempt fails with invalid_status_transition
      expect(() => {
        proposalEngine.approveProposal(proposal.proposalId, adminUser, registry);
      }).toThrow(PolicyProposalError);

      try {
        proposalEngine.approveProposal(proposal.proposalId, adminUser, registry);
      } catch (err) {
        expect((err as PolicyProposalError).code).toBe("invalid_status_transition");
      }
    });

    it("rejects version conflicts when proposed version is already active or in history", () => {
      const bestBuy = registry.getPoliciesForMerchant("Best Buy")[0];
      const sourceRecord: PolicySourceRecord = {
        sourceUrl: bestBuy.policySourceUrl,
        retrievedAt: new Date().toISOString(),
        httpStatus: 200,
        etag: null,
        lastModified: null,
        rawContentHash: "rawhash_conflict_test",
        contentLength: 1000,
        isNotModified: false,
      };

      // Construct a proposal whose proposed version 2.0.0 is already active in registry
      const conflictingProposal = {
        proposalId: "prop_conflict_123",
        policyId: bestBuy.policyId,
        changeType: "material_terms_changed" as const,
        currentPolicy: bestBuy,
        proposedPolicy: {
          ...bestBuy,
          policyVersion: "2.0.0", // Conflict: 2.0.0 is already active!
        },
        sourceRecord,
        parserVersion: "2.0.0",
        status: "proposed" as const,
        explanation: "Conflicting version.",
        createdAt: new Date().toISOString(),
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      };

      (proposalEngine as unknown as { proposals: Map<string, unknown> }).proposals.set(
        conflictingProposal.proposalId,
        conflictingProposal
      );

      expect(() => {
        proposalEngine.approveProposal(conflictingProposal.proposalId, adminUser, registry);
      }).toThrow(PolicyProposalError);

      try {
        proposalEngine.approveProposal(conflictingProposal.proposalId, adminUser, registry);
      } catch (err) {
        expect((err as PolicyProposalError).code).toBe("version_conflict");
      }
    });

    it("persists proposal state and policy history across restarts via export/import", () => {
      const bestBuy = registry.getPoliciesForMerchant("Best Buy")[0];
      const sourceRecord: PolicySourceRecord = {
        sourceUrl: bestBuy.policySourceUrl,
        retrievedAt: new Date().toISOString(),
        httpStatus: 200,
        etag: null,
        lastModified: null,
        rawContentHash: "hash_restart_durability",
        contentLength: 1200,
        isNotModified: false,
      };

      const terms: ExtractedPolicyTerms = {
        merchantDomain: "bestbuy.com",
        merchantName: "Best Buy",
        deliveryMethod: "standard_ground",
        currency: "USD",
        thresholdCents: 4500,
        shippingCostCents: 0,
        allowedZones: ["contiguous_us"],
        excludedZones: ["alaska", "hawaii", "us_territory"],
        requiresDirectRetailerSeller: true,
      };

      const mockExtract: PolicyExtractionResult = {
        status: "extracted",
        parserVersion: "2.0.0",
        warnings: [],
        explanation: "Threshold change.",
        terms,
      };

      const proposal = proposalEngine.evaluateIngestion(sourceRecord, mockExtract, bestBuy);
      proposalEngine.approveProposal(proposal.proposalId, adminUser, registry);

      // Export state
      const exportedProposalState = proposalEngine.exportState();
      const exportedRegistryState = registry.exportState();

      // Instantiate fresh engine and registry (simulating server reboot)
      const freshEngine = new PolicyProposalEngine();
      const freshRegistry = new MerchantPolicyRegistry([]);

      freshEngine.importState(exportedProposalState);
      freshRegistry.importState(exportedRegistryState);

      // Assert proposal state restored
      expect(freshEngine.getProposal(proposal.proposalId)?.status).toBe("validated");
      expect(freshEngine.getProposal(proposal.proposalId)?.reviewedBy).toEqual(adminUser);

      // Assert registry version history restored
      expect(freshRegistry.isPolicyActive(bestBuy.policyId, "2.1.0")).toBe(true);
      expect(freshRegistry.getPolicyVersion(bestBuy.policyId, "2.0.0")).not.toBeNull();
      expect(freshRegistry.getPolicyVersion(bestBuy.policyId, "2.1.0")).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Idempotency & Concurrency Enforcement
  // --------------------------------------------------------------------------
  describe("Idempotency & Concurrency Enforcement", () => {
    it("returns cached order on retried PayPal order creation without calling external PayPal API twice", async () => {
      const { purchase } = await setupApprovedPurchase();

      const fakePayPalOrder: PayPalOrderResponse = {
        id: "PAYPAL_ORDER_IDEMPOTENT_999",
        status: "CREATED",
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_ORDER_IDEMPOTENT_999",
            rel: "approve",
            method: "GET",
          },
        ],
      };

      (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePayPalOrder);

      const idemKey = "test_key_phase13d_001";

      // First call: executes against PayPal
      const firstResult = await service.createPayPalOrder(purchase.id, testUser, {
        idempotencyKey: idemKey,
      });

      expect(firstResult.paypalOrderId).toBe(fakePayPalOrder.id);
      expect(mockPayPal.createOrder).toHaveBeenCalledTimes(1);

      // Second call: exact same idempotency key and request
      const secondResult = await service.createPayPalOrder(purchase.id, testUser, {
        idempotencyKey: idemKey,
      });

      expect(secondResult.paypalOrderId).toBe(fakePayPalOrder.id);
      // Assert: PayPal client was NOT called a second time!
      expect(mockPayPal.createOrder).toHaveBeenCalledTimes(1);
    });

    it("rejects idempotency conflict when same key is used with conflicting parameters", async () => {
      const { purchase } = await setupApprovedPurchase();

      const fakePayPalOrder: PayPalOrderResponse = {
        id: "PAYPAL_ORDER_IDEMPOTENT_888",
        status: "CREATED",
        links: [],
      };

      (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePayPalOrder);

      const idemKey = "test_conflict_key_002";

      // Seed idempotency record with conflicting request hash
      await repo.saveIdempotencyRecord({
        id: "idem_seed_conflict",
        key: idemKey,
        actorId: testUser.userId,
        operation: "create_paypal_order",
        requestHash: "conflicting_request_hash_xyz",
        responseStatus: 201,
        responseBody: { fake: "body" },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      });

      await expect(
        service.createPayPalOrder(purchase.id, testUser, {
          idempotencyKey: idemKey,
        })
      ).rejects.toThrow(IdempotencyConflictError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 4. Remote Status Verification & Audit Preservation
  // --------------------------------------------------------------------------
  describe("Remote Verification Robustness & Non-Terminal Rejections", () => {
    it("handles remote PayPal 404 cleanly by failing payment attempt without mutating purchase or capturing funds", async () => {
      const { purchase } = await setupApprovedPurchase();

      const fakePayPalOrder: PayPalOrderResponse = {
        id: "PAYPAL_404_TEST",
        status: "CREATED",
        links: [],
      };

      (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePayPalOrder);

      await service.createPayPalOrder(purchase.id, testUser);

      // Mock getOrder to return 404
      (mockPayPal.getOrder as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new PayPalApiError(404, "RESOURCE_NOT_FOUND", "Resource Not Found", "debug_404_test")
      );

      let orderErr: unknown;
      try {
        await service.confirmBuyerApproval(purchase.id, testUser);
      } catch (err) {
        orderErr = err;
      }
      expect(orderErr).toBeInstanceOf(WorkflowError);
      expect((orderErr as WorkflowError).code).toBe("order_not_found");

      // Assert: Purchase status remains ORDER_CREATED (never mutated to BUYER_APPROVED)
      const freshAggregate = await repo.getPurchaseById(purchase.id);
      expect(freshAggregate?.purchase.status).toBe("ORDER_CREATED");

      // Assert: Payment attempt marked NOT_FOUND
      const attempt = freshAggregate?.paymentAttempts.find((a) => a.paypalOrderId === "PAYPAL_404_TEST");
      expect(attempt?.verifiedStatus).toBe("NOT_FOUND");
      expect(attempt?.failureReason).toBe("remote_order_not_found");
    });

    it("rejects non-terminal PayPal statuses (PAYER_ACTION_REQUIRED) without approving or capturing", async () => {
      const { purchase } = await setupApprovedPurchase();

      const fakePayPalOrder: PayPalOrderResponse = {
        id: "PAYPAL_PENDING_TEST",
        status: "CREATED",
        links: [],
      };

      (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePayPalOrder);
      await service.createPayPalOrder(purchase.id, testUser);

      const remoteGetPending: PayPalGetOrderResponse = {
        id: "PAYPAL_PENDING_TEST",
        status: "PAYER_ACTION_REQUIRED", // Buyer has not approved yet
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchase.id,
            amount: {
              value: "150.00",
              currency_code: "USD",
            },
          },
        ],
      };

      (mockPayPal.getOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(remoteGetPending);

      let pendingErr: unknown;
      try {
        await service.confirmBuyerApproval(purchase.id, testUser);
      } catch (err) {
        pendingErr = err;
      }
      expect(pendingErr).toBeInstanceOf(WorkflowError);
      expect((pendingErr as WorkflowError).code).toBe("payment_not_yet_approved");

      // Assert: Status remains ORDER_CREATED
      const freshAggregate = await repo.getPurchaseById(purchase.id);
      expect(freshAggregate?.purchase.status).toBe("ORDER_CREATED");
    });
  });
});
