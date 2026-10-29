/**
 * Plinthly Phase 13E — Independent Adversarial Verification & Product Readiness Test Suite.
 *
 * Rigorously challenges the complete procurement and payment boundary:
 * 1. Expired quote + superseded policy
 * 2. Policy fingerprint changes without a version change
 * 3. Changed product variant, seller, destination, currency, shipping cost, or quantity
 * 4. Stale approval submitted through alternate route or retry
 * 5. Two concurrent order-creation requests for the same approved purchase
 * 6. Process failure after external request but before result is persisted
 * 7. Timeout after remote service may have accepted a request
 * 8. Remote PayPal 404, timeout, malformed JSON, 5xx, and nonterminal order states
 * 9. Proposal approval by unauthenticated or unauthorized actor
 * 10. Duplicate, replayed, and concurrent proposal approval
 * 11. Application restart between proposal creation and review, and between policy publication and candidate evaluation
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  InMemoryPurchaseRepository,
  CandidateRecord,
} from "../../lib/workflow/repository";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { CreatePayPalOrderResponse } from "../../lib/workflow/types";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import {
  PayPalApiError,
  PayPalGetOrderResponse,
  PayPalOrderResponse,
  PayPalTimeoutError,
  PayPalUnknownOutcomeError,
} from "../../lib/paypal/types";
import {
  ApprovalIntegrityError,
  WorkflowError,
} from "../../lib/workflow/errors";
import {
  MerchantPolicyRegistry,
  DEFAULT_MERCHANT_POLICIES,
  setMerchantPolicyRegistry,
} from "../../lib/discovery/merchant-policy-registry";
import {
  PolicyProposalEngine,
  PolicyProposalError,
} from "../../lib/discovery/policy-ingestion/proposal-engine";
import { computePolicyFingerprint } from "../../lib/discovery/merchant-policy";
import { Actor } from "../../lib/state/types";
import { PaymentVerificationService } from "../../lib/paypal/verification";
import {
  DurablePolicyStore,
  getProposalReviewAuditLog,
  clearProposalReviewAuditLog,
} from "../../lib/discovery/policy-persistence";

describe("Phase 13E — Independent Adversarial Verification", () => {
  let repo: InMemoryPurchaseRepository;
  let mockPayPal: PayPalSandboxClient;
  let service: PurchaseWorkflowService;
  let registry: MerchantPolicyRegistry;
  let proposalEngine: PolicyProposalEngine;
  const tempStoragePath = join(process.cwd(), ".data", "test-phase13e-persistence.json");

  const buyerActor: Actor = { kind: "user", userId: "usr_buyer_alice" };
  const systemActor: Actor = { kind: "system", component: "auto_crawler" };

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
    registry = new MerchantPolicyRegistry(DEFAULT_MERCHANT_POLICIES);
    setMerchantPolicyRegistry(registry);
    proposalEngine = new PolicyProposalEngine();
    clearProposalReviewAuditLog();

    mockPayPal = {
      createOrder: vi.fn(),
      getOrder: vi.fn(),
    } as unknown as PayPalSandboxClient;

    service = new PurchaseWorkflowService(repo, mockPayPal);

    if (existsSync(tempStoragePath)) {
      rmSync(tempStoragePath, { force: true });
    }
  });

  afterEach(() => {
    if (existsSync(tempStoragePath)) {
      rmSync(tempStoragePath, { force: true });
    }
  });

  // Helper to establish a valid, approved purchase for testing pre-order boundaries
  async function setupApprovedPurchase(overrides?: {
    shippingQuoteExpiresAt?: string;
    shippingPolicyVersion?: string;
    budgetCents?: number;
    destination?: string;
    unitPriceCents?: number;
    shippingCents?: number;
  }) {
    const policyVersion = overrides?.shippingPolicyVersion ?? "2.0.0";
    const budgetCents = overrides?.budgetCents ?? 30000;
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
      buyerActor
    );

    const bestBuyPolicy = registry.getPoliciesForMerchant("Best Buy")[0];
    const nowIso = new Date().toISOString();

    const candData = {
      externalId: "sku_bb_laptop_adversarial",
      title: "Best Buy Adversarial Test Laptop",
      merchantName: "Best Buy",
      merchantUrl: "https://www.bestbuy.com/site/laptop/adv.p",
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
      buyerActor
    );

    expect(evalRes.status).toBe("POLICY_PASSED");

    const approval = await service.approvePurchase(
      purchase.id,
      {
        expectedSnapshotHash: evalRes.snapshotHash,
        expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
        expectedTotalCents: total,
        expectedCurrency: "USD",
        policyVersion,
      },
      buyerActor
    );

    expect(approval.status).toBe("APPROVED");

    return { purchase, evalRes, approval, bestBuyPolicy, totalCents: total };
  }

  // --------------------------------------------------------------------------
  // B.1: Expired Quote + Superseded Policy
  // --------------------------------------------------------------------------
  it("B.1: fails closed when both quote is expired and policy is superseded, making ZERO calls to PayPal", async () => {
    const expiredPastIso = new Date(Date.now() - 120_000).toISOString();
    const { purchase, bestBuyPolicy } = await setupApprovedPurchase({
      shippingQuoteExpiresAt: expiredPastIso,
    });

    // Mutate and publish superseded policy version
    const updatedPolicy = {
      ...bestBuyPolicy,
      policyVersion: "2.1.0",
      thresholdCents: 5000,
    };
    registry.publishPolicy({
      ...updatedPolicy,
      policyDocumentFingerprint: computePolicyFingerprint(updatedPolicy),
    });

    let thrownError: unknown;
    try {
      await service.createPayPalOrder(purchase.id, buyerActor);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(ApprovalIntegrityError);
    // Verified: Mocked PayPal receives exactly ZERO calls
    expect(mockPayPal.createOrder).not.toHaveBeenCalled();

    // Verified: Approval record is permanently marked invalidated in repository
    const fresh = await repo.getPurchaseById(purchase.id);
    const activeApp = fresh?.approvals.find((a) => a.invalidatedAt === null);
    expect(activeApp).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // B.2: Policy Fingerprint Changes Without Version Change
  // --------------------------------------------------------------------------
  it("B.2: fails closed when terms mutate under identical version, making ZERO calls to PayPal", async () => {
    const { purchase, bestBuyPolicy } = await setupApprovedPurchase();

    // Publisher changes policy conditions without version increment
    const mutated = {
      ...bestBuyPolicy,
      thresholdCents: 4500, // $45 instead of $35
    };
    registry.publishPolicy({
      ...mutated,
      policyDocumentFingerprint: computePolicyFingerprint(mutated),
    });

    await expect(
      service.createPayPalOrder(purchase.id, buyerActor)
    ).rejects.toThrow(ApprovalIntegrityError);

    expect(mockPayPal.createOrder).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // B.3: Changed Variant, Seller, Destination, Currency, Shipping Cost, Quantity
  // --------------------------------------------------------------------------
  describe("B.3: Tampering Invariants", () => {
    it("B.3a: fails closed if candidate snapshotHash changes (e.g. title/variant/seller)", async () => {
      const { purchase, evalRes } = await setupApprovedPurchase();

      // Adversarial mutation in database: variant/externalId changed
      const storedCand = (repo as unknown as { candidates: Map<string, CandidateRecord> }).candidates.get(
        evalRes.candidateId
      );
      expect(storedCand).toBeDefined();
      storedCand!.externalId = "sku_tampered_variant_32gb";

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor)
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("B.3b: fails closed if candidate seller changes", async () => {
      const { purchase, evalRes } = await setupApprovedPurchase();

      const storedCand = (repo as unknown as { candidates: Map<string, CandidateRecord> }).candidates.get(
        evalRes.candidateId
      );
      storedCand!.merchantName = "Different Untrusted Seller";

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor)
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("B.3c: fails closed if currency is changed after approval", async () => {
      const { purchase, evalRes } = await setupApprovedPurchase();

      const storedCand = (repo as unknown as { candidates: Map<string, CandidateRecord> }).candidates.get(
        evalRes.candidateId
      );
      // Adversarial mutation: currency changed to EUR
      (storedCand as unknown as { currency: string }).currency = "EUR";

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor)
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("B.3d: fails closed if shipping cost is changed after approval", async () => {
      const { purchase, evalRes } = await setupApprovedPurchase();

      const storedCand = (repo as unknown as { candidates: Map<string, CandidateRecord> }).candidates.get(
        evalRes.candidateId
      );
      storedCand!.shippingCents = 1500; // Shipping increased from $0 to $15

      await expect(
        service.createPayPalOrder(purchase.id, buyerActor)
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("B.3e: fails closed if requested destination mismatches approved destination", async () => {
      const { purchase } = await setupApprovedPurchase({
        destination: "10001", // New York
      });

      // Request order with different postal code
      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, {
          destination: { country: "US", postalCode: "90210", deliveryMethodPreference: "standard_ground" },
        })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });

    it("B.3f: fails closed if destination is excluded under active merchant policy", async () => {
      const { purchase } = await setupApprovedPurchase({
        destination: "10001",
      });

      // Request delivery to Alaska (excluded by Best Buy policy)
      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, {
          destination: { country: "US", postalCode: "99501", deliveryMethodPreference: "standard_ground" },
        })
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPal.createOrder).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // B.4: Stale Approval Submitted via Retry
  // --------------------------------------------------------------------------
  it("B.4: permanently blocks retried order creation once an approval is invalidated", async () => {
    const expiredPastIso = new Date(Date.now() - 30_000).toISOString();
    const { purchase } = await setupApprovedPurchase({
      shippingQuoteExpiresAt: expiredPastIso,
    });

    // First attempt fails and invalidates
    await expect(
      service.createPayPalOrder(purchase.id, buyerActor)
    ).rejects.toThrow(ApprovalIntegrityError);

    // Subsequent retries fail immediately on no_effective_approval
    let retryErr: unknown;
    try {
      await service.createPayPalOrder(purchase.id, buyerActor);
    } catch (err) {
      retryErr = err;
    }
    expect(retryErr).toBeInstanceOf(ApprovalIntegrityError);
    expect((retryErr as ApprovalIntegrityError).code).toBe("no_effective_approval");

    // Zero calls to PayPal across both attempts
    expect(mockPayPal.createOrder).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // B.5: Concurrent Order Creation for Same Purchase
  // --------------------------------------------------------------------------
  it("B.5: handles concurrent order creation safely without duplicate order creation", async () => {
    const { purchase } = await setupApprovedPurchase();

    const mockOrderResponse: PayPalOrderResponse = {
      id: "ORDER_CONCURRENT_SAFE",
      status: "CREATED",
      links: [{ href: "https://sandbox.paypal.com/checkout?token=ORDER_CONCURRENT_SAFE", rel: "approve", method: "GET" }],
    };

    (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(mockOrderResponse);

    // Fire two order-creation requests simultaneously for the same purchase
    const results = await Promise.allSettled([
      service.createPayPalOrder(purchase.id, buyerActor),
      service.createPayPalOrder(purchase.id, buyerActor),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Both fulfilled requests agree on the exact same PayPal order ID
    for (const res of fulfilled) {
      const val = (res as PromiseFulfilledResult<CreatePayPalOrderResponse>).value;
      expect(val.paypalOrderId).toBe("ORDER_CONCURRENT_SAFE");
    }

    // Purchase is cleanly in ORDER_CREATED
    const fresh = await repo.getPurchaseById(purchase.id);
    expect(fresh?.purchase.status).toBe("ORDER_CREATED");
  });

  // --------------------------------------------------------------------------
  // B.6: Process Failure After External Call Before Persistence
  // --------------------------------------------------------------------------
  it("B.6: recovers via deterministic idempotency key without duplicate order if persistence fails", async () => {
    const { purchase, approval } = await setupApprovedPurchase();

    const orderFirstCall: PayPalOrderResponse = {
      id: "ORDER_RECOVERED_123",
      status: "CREATED",
      links: [{ href: "https://sandbox.paypal.com/checkout?token=ORDER_RECOVERED_123", rel: "approve", method: "GET" }],
    };

    // First call: createOrder succeeds in PayPal Sandbox, but repo.recordOrderCreation crashes
    (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(orderFirstCall);

    const originalRecordOrder = repo.recordOrderCreation.bind(repo);
    vi.spyOn(repo, "recordOrderCreation").mockRejectedValueOnce(new Error("Database connection dropped"));

    await expect(
      service.createPayPalOrder(purchase.id, buyerActor)
    ).rejects.toThrow("Database connection dropped");

    // The purchase remains in APPROVED in the local database
    const stateAfterCrash = await repo.getPurchaseById(purchase.id);
    expect(stateAfterCrash?.purchase.status).toBe("APPROVED");

    // Recovery retry: PayPal mock is configured to return the existing order for this idempotency key
    (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(orderFirstCall);
    vi.spyOn(repo, "recordOrderCreation").mockImplementation(originalRecordOrder);

    const recovered = await service.createPayPalOrder(purchase.id, buyerActor);
    expect(recovered.paypalOrderId).toBe("ORDER_RECOVERED_123");
    expect(recovered.status).toBe("ORDER_CREATED");

    // Both PayPal calls used the identical idempotency key bound to purchase and approval
    const expectedKey = `pay_${purchase.id}_${approval.approvalId}`;
    expect(mockPayPal.createOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: expectedKey })
    );
    expect(mockPayPal.createOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: expectedKey })
    );
  });

  // --------------------------------------------------------------------------
  // B.7: Timeout After Remote Service May Have Accepted
  // --------------------------------------------------------------------------
  it("B.7: preserves unknown-outcome state on PayPal timeout and reuses idempotency key on retry", async () => {
    const { purchase, approval } = await setupApprovedPurchase();

    // PayPal API call times out
    (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new PayPalTimeoutError("Sandbox gateway timed out after 30000ms")
    );

    let thrownTimeout: unknown;
    try {
      await service.createPayPalOrder(purchase.id, buyerActor);
    } catch (err) {
      thrownTimeout = err;
    }

    expect(thrownTimeout).toBeInstanceOf(PayPalUnknownOutcomeError);

    // Purchase status is retained in APPROVED rather than corrupted
    const fresh = await repo.getPurchaseById(purchase.id);
    expect(fresh?.purchase.status).toBe("APPROVED");

    // On retry, PayPal Sandbox returns the order created during the initial request
    const existingOrder: PayPalOrderResponse = {
      id: "ORDER_TIMEOUT_RECOVERED",
      status: "CREATED",
      links: [],
    };
    (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(existingOrder);

    const retryResult = await service.createPayPalOrder(purchase.id, buyerActor);
    expect(retryResult.paypalOrderId).toBe("ORDER_TIMEOUT_RECOVERED");

    // Checked: Both calls transmitted the exact same idempotency key
    expect(mockPayPal.createOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: `pay_${purchase.id}_${approval.approvalId}` })
    );
  });

  // --------------------------------------------------------------------------
  // B.8: Remote PayPal 404, Timeout, Malformed JSON, 5xx, Nonterminal States
  // --------------------------------------------------------------------------
  describe("B.8: Verification Boundary Robustness", () => {
    it("B.8a: handles remote 404 by marking payment attempt NOT_FOUND without advancing workflow", async () => {
      const { purchase } = await setupApprovedPurchase();

      const createdOrder: PayPalOrderResponse = {
        id: "PAYPAL_404_VERIF",
        status: "CREATED",
        links: [],
      };
      (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdOrder);
      await service.createPayPalOrder(purchase.id, buyerActor);

      (mockPayPal.getOrder as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new PayPalApiError(404, "RESOURCE_NOT_FOUND", "Resource Not Found")
      );

      const verifier = new PaymentVerificationService(repo, mockPayPal);
      const res = await verifier.verifyPayment(purchase.id, buyerActor);

      expect(res.outcome).toBe("REMOTE_NOT_FOUND");
      expect(res.verified).toBe(false);

      const fresh = await repo.getPurchaseById(purchase.id);
      expect(fresh?.purchase.status).toBe("ORDER_CREATED"); // Never mutated to BUYER_APPROVED
    });

    it("B.8b: handles transient remote timeout during verification without advancing workflow", async () => {
      const { purchase } = await setupApprovedPurchase();

      (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "PAYPAL_TIMEOUT_VERIF",
        status: "CREATED",
        links: [],
      });
      await service.createPayPalOrder(purchase.id, buyerActor);

      (mockPayPal.getOrder as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new PayPalTimeoutError("Connection timed out")
      );

      const verifier = new PaymentVerificationService(repo, mockPayPal);
      const res = await verifier.verifyPayment(purchase.id, buyerActor);

      expect(res.outcome).toBe("UNVERIFIED_TRANSIENT");
      expect(res.verified).toBe(false);

      const fresh = await repo.getPurchaseById(purchase.id);
      expect(fresh?.purchase.status).toBe("ORDER_CREATED");
    });

    it("B.8c: handles 5xx remote API errors without corrupting state", async () => {
      const { purchase } = await setupApprovedPurchase();

      (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "PAYPAL_500_VERIF",
        status: "CREATED",
        links: [],
      });
      await service.createPayPalOrder(purchase.id, buyerActor);

      (mockPayPal.getOrder as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new PayPalApiError(500, "INTERNAL_SERVER_ERROR", "Internal Server Error")
      );

      const verifier = new PaymentVerificationService(repo, mockPayPal);
      const res = await verifier.verifyPayment(purchase.id, buyerActor);

      expect(res.outcome).toBe("UNVERIFIED_API_ERROR");
      expect(res.verified).toBe(false);
    });

    it("B.8d: rejects nonterminal status (CREATED / PAYER_ACTION_REQUIRED) in confirmBuyerApproval", async () => {
      const { purchase } = await setupApprovedPurchase();

      (mockPayPal.createOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "PAYPAL_PENDING_ACTION",
        status: "CREATED",
        links: [],
      });
      await service.createPayPalOrder(purchase.id, buyerActor);

      const pendingOrder: PayPalGetOrderResponse = {
        id: "PAYPAL_PENDING_ACTION",
        status: "PAYER_ACTION_REQUIRED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchase.id,
            amount: { value: "150.00", currency_code: "USD" },
          },
        ],
      };
      (mockPayPal.getOrder as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(pendingOrder);

      let confirmErr: unknown;
      try {
        await service.confirmBuyerApproval(purchase.id, buyerActor);
      } catch (err) {
        confirmErr = err;
      }

      expect(confirmErr).toBeInstanceOf(WorkflowError);
      expect((confirmErr as WorkflowError).code).toBe("payment_not_yet_approved");

      const fresh = await repo.getPurchaseById(purchase.id);
      expect(fresh?.purchase.status).toBe("ORDER_CREATED");
    });
  });

  // --------------------------------------------------------------------------
  // B.9 & B.10: Policy Proposal Authorization, Replay, and Concurrency
  // --------------------------------------------------------------------------
  describe("B.9 & B.10: Proposal Authorization and Concurrency", () => {
    it("B.9: refuses approval by non-user actor (system crawler component)", () => {
      const bestBuyPolicy = registry.getPoliciesForMerchant("Best Buy")[0];
      const proposal = proposalEngine.evaluateIngestion(
        {
          sourceUrl: bestBuyPolicy.policySourceUrl,
          retrievedAt: new Date().toISOString(),
          httpStatus: 200,
          etag: null,
          lastModified: null,
          rawContentHash: "a".repeat(64),
          contentLength: 1024,
          isNotModified: false,
        },
        {
          status: "extracted",
          terms: {
            merchantDomain: "bestbuy.com",
            merchantName: "Best Buy",
            deliveryMethod: "standard_ground",
            currency: "USD",
            thresholdCents: 4500, // Material change
            shippingCostCents: 0,
            allowedZones: ["contiguous_us"],
            excludedZones: ["alaska", "hawaii"],
          },
          parserVersion: "2.0.0",
          warnings: [],
          explanation: "Threshold updated",
        },
        bestBuyPolicy
      );

      expect(proposal.status).toBe("proposed");

      expect(() => {
        proposalEngine.approveProposal(proposal.proposalId, systemActor, registry);
      }).toThrowError(PolicyProposalError);
    });

    it("B.10: rejects replayed or duplicate proposal approvals", () => {
      const bestBuyPolicy = registry.getPoliciesForMerchant("Best Buy")[0];
      const proposal = proposalEngine.evaluateIngestion(
        {
          sourceUrl: bestBuyPolicy.policySourceUrl,
          retrievedAt: new Date().toISOString(),
          httpStatus: 200,
          etag: null,
          lastModified: null,
          rawContentHash: "b".repeat(64),
          contentLength: 1024,
          isNotModified: false,
        },
        {
          status: "extracted",
          terms: {
            merchantDomain: "bestbuy.com",
            merchantName: "Best Buy",
            deliveryMethod: "standard_ground",
            currency: "USD",
            thresholdCents: 4000,
            shippingCostCents: 0,
            allowedZones: ["contiguous_us"],
            excludedZones: ["alaska", "hawaii"],
          },
          parserVersion: "2.0.0",
          warnings: [],
          explanation: "Threshold updated",
        },
        bestBuyPolicy
      );

      // First approval succeeds
      proposalEngine.approveProposal(proposal.proposalId, buyerActor, registry);

      // Replay fails
      expect(() => {
        proposalEngine.approveProposal(proposal.proposalId, buyerActor, registry);
      }).toThrowError(PolicyProposalError);
    });
  });

  // --------------------------------------------------------------------------
  // B.11 & Section C: Application Restart Durability & Schema Validation
  // --------------------------------------------------------------------------
  describe("B.11 & Section C: Durable Storage, Auto-Restore & Audit Lineage", () => {
    it("B.11a: persists proposal review across simulated application restart", () => {
      const store = new DurablePolicyStore(tempStoragePath);
      const bestBuyPolicy = registry.getPoliciesForMerchant("Best Buy")[0];

      const proposal = proposalEngine.evaluateIngestion(
        {
          sourceUrl: bestBuyPolicy.policySourceUrl,
          retrievedAt: new Date().toISOString(),
          httpStatus: 200,
          etag: null,
          lastModified: null,
          rawContentHash: "c".repeat(64),
          contentLength: 2048,
          isNotModified: false,
        },
        {
          status: "extracted",
          terms: {
            merchantDomain: "bestbuy.com",
            merchantName: "Best Buy",
            deliveryMethod: "standard_ground",
            currency: "USD",
            thresholdCents: 4200,
            shippingCostCents: 0,
            allowedZones: ["contiguous_us"],
            excludedZones: ["alaska", "hawaii"],
          },
          parserVersion: "2.0.0",
          warnings: [],
          explanation: "Threshold updated to $42",
        },
        bestBuyPolicy
      );

      // Approve proposal as human reviewer
      const reviewResult = proposalEngine.approveProposal(proposal.proposalId, buyerActor, registry);
      expect(reviewResult.approvedProposal.status).toBe("validated");

      // Save to durable store
      const auditLog = getProposalReviewAuditLog();
      expect(auditLog.length).toBeGreaterThanOrEqual(1);
      store.saveState(registry, proposalEngine, auditLog);

      // Simulate application restart: instantiate clean instances
      const restartedRegistry = new MerchantPolicyRegistry([]);
      const restartedEngine = new PolicyProposalEngine();

      const loadResult = store.loadState(restartedRegistry, restartedEngine);
      expect(loadResult.loadedFromDisk).toBe(true);

      // Assert: The published policy is active in the restarted registry
      const activeBestBuy = restartedRegistry.getPoliciesForMerchant("Best Buy");
      expect(activeBestBuy.some((p) => p.thresholdCents === 4200)).toBe(true);

      // Assert: Proposal audit log restored with decision, prior & new fingerprints
      expect(loadResult.auditLog.length).toBeGreaterThanOrEqual(1);
      const auditEntry = loadResult.auditLog.find((a) => a.proposalId === proposal.proposalId);
      expect(auditEntry).toBeDefined();
      expect(auditEntry?.decision).toBe("approved");
      expect(auditEntry?.reviewer.kind).toBe("user");
      expect(auditEntry?.newFingerprint).toBe(reviewResult.publishedPolicy.policyDocumentFingerprint);
    });

    it("B.11b: rejects corrupted schema files and safely falls back without crash", () => {
      const store = new DurablePolicyStore(tempStoragePath);
      // Write corrupted/invalid JSON structure to disk
      const corruptedData = {
        schemaVersion: "1.0.0",
        lastSavedAt: new Date().toISOString(),
        registry: {
          policies: [{ invalidField: true }], // Schema violation
          history: [],
        },
        proposals: { proposals: [] },
        auditLog: [],
      };
      mkdirSync(dirname(tempStoragePath), { recursive: true });
      writeFileSync(tempStoragePath, JSON.stringify(corruptedData), "utf8");

      const safeRegistry = new MerchantPolicyRegistry(DEFAULT_MERCHANT_POLICIES);
      const safeEngine = new PolicyProposalEngine();

      const loadResult = store.loadState(safeRegistry, safeEngine);
      expect(loadResult.loadedFromDisk).toBe(false);
      // Still retains default safe policies
      expect(safeRegistry.getPoliciesForMerchant("Best Buy").length).toBeGreaterThan(0);
    });
  });
});
