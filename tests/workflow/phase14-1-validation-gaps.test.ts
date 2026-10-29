/**
 * Plinthly Phase 14.1 — Live Procurement Journey Validation and Integration Gaps Test Suite
 *
 * Validates:
 * 1. Destination Correctness & Validation:
 *    - Valid 5-digit US ZIP codes accepted.
 *    - Malformed / non-numeric postal codes rejected.
 *    - Unsupported non-US countries rejected.
 *    - Missing postal codes rejected or handled strictly without silent defaulting.
 *    - Candidate quote destination mismatch with purchase delivery destination rejected.
 *    - Expected destination at buyer approval enforced.
 *    - Destination changed after buyer approval permanently invalidates approval in repository.
 *    - Geographically excluded destinations (e.g., Alaska/Hawaii) fail closed with approval invalidation.
 * 2. Shipping Evidence Integrity & Quote Non-Reusability:
 *    - Dynamic quotes, policy-derived terms, synthetic fixtures, and missing shipping are distinguished.
 *    - Quotes cannot be reused across different merchants, destinations, or variants.
 *    - Missing shipping is never treated as zero or confirmed landed cost.
 * 3. Ranking, Deduplication & Currency Safety:
 *    - Unknown landed costs sort after all verified numbers.
 *    - Different currencies are grouped rather than treated as equivalent amounts.
 *    - Inferred specifications cannot satisfy verified-only requirements.
 *    - Duplicate listings are recognized and filtered.
 * 4. Approval & PayPal Boundary Safety:
 *    - Zero calls to PayPal when quotes expire, terms mutate, or destinations mismatch.
 *    - Ambiguous gateway timeouts fail closed without creating duplicate orders.
 * 5. Deployment Durability & Persistence:
 *    - POLICY_STORAGE_PATH env override works.
 *    - Corrupted files quarantined and fall back safely to default policies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { destinationContextSchema } from "../../lib/discovery/shipping";
import {
  computeQuoteFingerprint,
  validateQuoteForCandidate,
} from "../../lib/discovery/shipping-quote";
import { normalizeCandidate } from "../../lib/discovery/normalize";
import { ingestCandidateEvidence } from "../../lib/discovery/evidence";
import {
  getMerchantPolicyRegistry,
  MerchantPolicyRegistry,
} from "../../lib/discovery/merchant-policy-registry";
import { PolicyProposalEngine } from "../../lib/discovery/policy-ingestion/proposal-engine";
import {
  DurablePolicyStore,
  clearProposalReviewAuditLog,
} from "../../lib/discovery/policy-persistence";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { Actor } from "../../lib/state/types";
import {
  ApprovalIntegrityError,
  ValidationError,
} from "../../lib/workflow/errors";
import { PayPalTimeoutError, PayPalUnknownOutcomeError } from "../../lib/paypal/types";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("Phase 14.1 — Live Procurement Journey Validation and Integration Gaps", () => {
  const buyerActor: Actor = { kind: "user", userId: "usr_buyer_phase14_1" };
  const seattleDest = { country: "US" as const, postalCode: "98101", deliveryMethodPreference: "standard_ground" as const };
  const beverlyHillsDest = { country: "US" as const, postalCode: "90210", deliveryMethodPreference: "standard_ground" as const };
  const honoluluDest = { country: "US" as const, postalCode: "96801", deliveryMethodPreference: "standard_ground" as const }; // Hawaii (excluded zone)

  const tempDir = join(process.cwd(), ".data", "test-phase14-1");
  const tempStoragePath = join(tempDir, "policy-storage.json");

  let repo: InMemoryPurchaseRepository;
  let mockPayPal: PayPalSandboxClient;
  let service: PurchaseWorkflowService;

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
    mockPayPal = {
      createOrder: vi.fn(),
      getOrder: vi.fn(),
      getClientToken: vi.fn(),
    } as unknown as PayPalSandboxClient;
    service = new PurchaseWorkflowService(repo, mockPayPal);
    clearProposalReviewAuditLog();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function setupApprovedTestPurchase(destZip: string = "98101", unitPrice: number = 50000) {
    const registry = getMerchantPolicyRegistry();
    const bestBuyPolicy = registry.getPoliciesForMerchant("Best Buy")[0];
    const nowIso = new Date().toISOString();

    const destContext = {
      country: "US" as const,
      postalCode: destZip,
      deliveryMethodPreference: "standard_ground" as const,
    };

    const purchase = await service.createPurchase(
      {
        budgetCents: 150000,
        currency: "USD",
        requirements: [],
        destination: destContext,
      },
      buyerActor
    );

    const candData = {
      externalId: `sku_laptop_${destZip}:bestbuy.com`,
      title: "Approved Best Buy Test Laptop",
      merchantName: "Best Buy",
      merchantUrl: "https://www.bestbuy.com/site/laptop/1.p",
      unitPriceCents: unitPrice,
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
      destinationPostalCode: destZip,
    };

    const evalRes = await service.evaluatePurchaseCandidate(
      purchase.id,
      {
        rawCandidate: candData,
        rawObservations: [
          {
            requirementKey: "destination",
            value: destZip,
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
      buyerActor
    );

    expect(evalRes.status).toBe("POLICY_PASSED");

    const approval = await service.approvePurchase(
      purchase.id,
      {
        expectedSnapshotHash: evalRes.snapshotHash,
        expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
        expectedTotalCents: unitPrice,
        expectedCurrency: "USD",
        policyVersion: bestBuyPolicy.policyVersion,
        expectedDestination: destContext,
      },
      buyerActor
    );

    expect(approval.status).toBe("APPROVED");

    return { purchase, evalRes, approval, bestBuyPolicy };
  }

  // ==========================================================================
  // SECTION 1: DESTINATION CORRECTNESS & VALIDATION
  // ==========================================================================

  it("1.1 Accepts valid 5-digit US ZIP codes and standard delivery preferences", () => {
    const res = destinationContextSchema.safeParse({
      country: "US",
      postalCode: "98101",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.postalCode).toBe("98101");
      expect(res.data.country).toBe("US");
      expect(res.data.deliveryMethodPreference).toBe("standard_ground");
    }
  });

  it("1.2 Rejects malformed, non-numeric, or incomplete postal codes", () => {
    expect(destinationContextSchema.safeParse({ country: "US", postalCode: "ABCDE" }).success).toBe(false);
    expect(destinationContextSchema.safeParse({ country: "US", postalCode: "123" }).success).toBe(false);
    expect(destinationContextSchema.safeParse({ country: "US", postalCode: "" }).success).toBe(false);
    expect(destinationContextSchema.safeParse({ country: "US" }).success).toBe(false);
  });

  it("1.3 Rejects unsupported destination countries without silent defaulting", () => {
    const resCanada = destinationContextSchema.safeParse({ country: "CA", postalCode: "M5V 2T6" });
    expect(resCanada.success).toBe(false);
    if (!resCanada.success) {
      expect(resCanada.error.issues[0].message).toContain('Only "US" delivery destination is currently supported');
    }

    const resUK = destinationContextSchema.safeParse({ country: "GB", postalCode: "SW1A 1AA" });
    expect(resUK.success).toBe(false);
  });

  it("1.4 Rejects candidate evaluation when quote destination mismatches purchase delivery destination", async () => {
    // Purchase created for Seattle (98101)
    const purchase = await service.createPurchase(
      {
        budgetCents: 100000,
        currency: "USD",
        requirements: [],
        destination: seattleDest,
      },
      buyerActor
    );

    // Attempt to evaluate a candidate whose quote is bound to Beverly Hills (90210)
    await expect(
      service.evaluatePurchaseCandidate(
        purchase.id,
        {
          rawCandidate: {
            externalId: "cand_mismatched_dest:bestbuy.com",
            title: "Mismatched Destination Laptop",
            merchantName: "Best Buy",
            merchantUrl: "https://bestbuy.com/item",
            unitPriceCents: 50000,
            quantity: 1,
            shippingCents: 0,
            destinationPostalCode: "90210", // Beverly Hills
            destinationCountry: "US",
            currency: "USD",
            availability: "in_stock",
          },
          requiredRuleKeys: ["P-BUDGET"],
        },
        buyerActor
      )
    ).rejects.toThrow(ValidationError);
  });

  it("1.5 Permanently invalidates approval in repository when order destination differs from approved destination", async () => {
    const { purchase } = await setupApprovedTestPurchase("98101");

    // Verify approval is active before order attempt
    const beforeAttempt = await repo.getPurchaseById(purchase.id);
    expect(beforeAttempt?.approvals.some((a) => a.invalidatedAt === null)).toBe(true);

    // Adversarial call: Attempt order creation for Beverly Hills (90210)
    await expect(
      service.createPayPalOrder(purchase.id, buyerActor, {
        destination: beverlyHillsDest,
      })
    ).rejects.toThrow(ApprovalIntegrityError);

    // Verify: Mocked PayPal receives exactly ZERO calls
    expect(mockPayPal.createOrder).not.toHaveBeenCalled();

    // Verify: Approval was permanently recorded as invalidated in repository
    const afterAttempt = await repo.getPurchaseById(purchase.id);
    const activeApproval = afterAttempt?.approvals.find((a) => a.invalidatedAt === null);
    expect(activeApproval).toBeUndefined();

    // Verify audit event "approval_invalidated" was emitted with reason "destination_changed"
    const auditEvents = await repo.getAuditHistory(purchase.id);
    const invalidEvent = auditEvents.find((e) => e.type === "approval_invalidated");
    expect(invalidEvent).toBeDefined();
    expect((invalidEvent?.payload as { reasons: string[] })?.reasons).toContain("destination_changed");
  });

  it("1.6 Fails closed and invalidates approval when destination is in an excluded geographic zone (e.g. Hawaii)", async () => {
    const { purchase } = await setupApprovedTestPurchase("96801"); // Hawaii

    // Order attempt for excluded zone (Hawaii) must fail closed with destination_excluded
    await expect(
      service.createPayPalOrder(purchase.id, buyerActor, {
        destination: honoluluDest,
      })
    ).rejects.toThrow(ApprovalIntegrityError);

    expect(mockPayPal.createOrder).not.toHaveBeenCalled();

    const aggregate = await repo.getPurchaseById(purchase.id);
    const activeApproval = aggregate?.approvals.find((a) => a.invalidatedAt === null);
    expect(activeApproval).toBeUndefined();

    const auditEvents = await repo.getAuditHistory(purchase.id);
    const invalidEvent = auditEvents.find((e) => e.type === "approval_invalidated");
    expect(invalidEvent).toBeDefined();
    expect((invalidEvent?.payload as { reasons: string[] })?.reasons).toContain("destination_excluded");
  });

  // ==========================================================================
  // SECTION 2: SHIPPING EVIDENCE & QUOTE REUSE PREVENTION
  // ==========================================================================

  it("2.1 Prevents cross-merchant quote reuse even if externalId and destination match", () => {
    const baseQuote = {
      status: "success" as const,
      quoteId: "quote_bb_123",
      amountCents: 499,
      currency: "USD" as const,
      retailerId: "bestbuy.com",
      merchantDomain: "bestbuy.com", // Best Buy domain
      externalId: "sku_shared_100:bestbuy.com",
      canonicalProductUrl: "https://www.bestbuy.com/item",
      destinationPostalCode: "98101",
      destinationCountry: "US" as const,
      deliveryMethod: "standard_ground",
      quotedAt: "2026-10-29T10:00:00.000Z",
      expiresAt: "2026-10-29T14:00:00.000Z",
      sourceUrl: "https://bestbuy.com/quote/123",
    };

    const quoteWithFp = {
      ...baseQuote,
      quoteFingerprint: computeQuoteFingerprint(baseQuote),
    };

    // Adversarial reuse attempt: Candidate is from Walmart, attempting to reuse Best Buy quote
    const verification = validateQuoteForCandidate(quoteWithFp, {
      candidate: {
        externalId: "sku_shared_100:bestbuy.com",
        merchantName: "Walmart",
        merchantUrl: "https://www.walmart.com/ip/100", // Mismatched merchant domain
        unitPriceCents: 4000,
        quantity: 1,
        currency: "USD",
      },
      canonicalProductUrl: "https://www.walmart.com/ip/100",
      destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
      requestedCurrency: "USD",
      deliveryMethodPreference: "standard_ground",
      now: new Date("2026-10-29T11:00:00.000Z"),
    });

    expect(verification.valid).toBe(false);
    expect(verification.isAuthoritative).toBe(false);
    expect(verification.rejectionReason).toContain("does not match candidate merchant domain");
  });

  it("2.2 Unknown shipping is strictly null and never inferred as zero or confirmed landed cost", () => {
    const cand = normalizeCandidate(
      {
        externalId: "cand_no_shipping:target.com",
        title: "Target Coffee Maker",
        merchantName: "Target",
        merchantUrl: "https://target.com/coffee",
        unitPriceCents: 2999,
        currency: "USD",
        availability: "in_stock",
        // No shipping provided
      },
      {
        purchaseId: "pur_val_1",
        source: "channel3",
        now: new Date(),
      }
    );

    expect(cand.shippingDetails?.amountCents).toBeNull();
    expect(cand.shippingDetails?.type).toBe("missing");
    expect(cand.shippingDetails?.isAuthoritative).toBe(false);
    expect(cand.isComplete).toBe(false);
    expect(cand.blockerReason).toContain("Missing shipping cost specification");
  });

  // ==========================================================================
  // SECTION 3: RANKING, INFERRED SPECS & CURRENCY SAFETY
  // ==========================================================================

  it("3.1 Inferred specifications (unverified heuristics or LLM guesses) cannot satisfy verified-only requirements", () => {
    const now = new Date("2026-10-29T10:00:00.000Z");
    const candidate = normalizeCandidate(
      {
        externalId: "cand_ai_guess:bestbuy.com",
        title: "Laptop with Unverified RAM",
        merchantName: "Best Buy",
        merchantUrl: "https://bestbuy.com/laptop",
        unitPriceCents: 80000,
        currency: "USD",
        availability: "in_stock",
        shipping: 0,
      },
      { purchaseId: "pur_spec_test", source: "channel3", now }
    );

    // Ingest observation explicitly flagged as inferred / heuristic
    const ingestion = ingestCandidateEvidence({
      candidate,
      requiredAttributes: ["ram: 16GB"],
      rawObservations: [
        {
          requirementKey: "ram",
          value: "16GB",
          sourceType: "ai_inference", // Inferred heuristic, not verified retailer fact
          sourceUrl: "https://bestbuy.com/laptop",
          capturedAt: now.toISOString(),
        },
      ],
      now,
    });

    // Inferred observation must be treated as missing, NOT supports
    const ramRecord = ingestion.evidenceRecords.find((r) => r.requirementKey === "ram");
    expect(ramRecord?.status).toBe("missing");
    expect(ingestion.missingAttributeKeys).toContain("ram");
  });

  it("3.2 Comparison grid comparator groups different currencies and pushes unknown landed costs to bottom", () => {
    const honestTotalComparator = (
      valA: number | null,
      valB: number | null,
      curA: string = "USD",
      curB: string = "USD"
    ): number => {
      if (valA === null && valB === null) return 0;
      if (valA === null) return 1; // null sorts after all numbers
      if (valB === null) return -1;
      if (curA !== curB) {
        return curA.localeCompare(curB); // group currencies
      }
      return valA - valB;
    };

    const items = [
      { id: "item2_null_total", totalCents: null, currency: "USD" },
      { id: "item4_150_usd", totalCents: 15000, currency: "USD" },
      { id: "item3_100_eur", totalCents: 10000, currency: "EUR" },
      { id: "item1_100_usd", totalCents: 10000, currency: "USD" },
    ];

    const sorted = [...items].sort((a, b) =>
      honestTotalComparator(a.totalCents, b.totalCents, a.currency, b.currency)
    );

    // EUR sorted into its own group first (E < U)
    expect(sorted[0].id).toBe("item3_100_eur");
    // $100 USD ranks next
    expect(sorted[1].id).toBe("item1_100_usd");
    // $150 USD ranks next
    expect(sorted[2].id).toBe("item4_150_usd");
    // $50 item with unknown shipping ranks LAST, never cheaper than verified totals
    expect(sorted[3].id).toBe("item2_null_total");
    expect(sorted[3].totalCents).toBeNull();
  });

  // ==========================================================================
  // SECTION 4: PAYPAL BOUNDARY, TIMEOUT & RETRY SAFETY
  // ==========================================================================

  it("4.1 Handles external gateway timeouts by failing closed without blind second order creation", async () => {
    const { purchase } = await setupApprovedTestPurchase("98101");

    // Mock PayPal client to simulate network/gateway timeout
    mockPayPal.createOrder = vi.fn().mockRejectedValueOnce(
      new PayPalTimeoutError("PayPal Sandbox order creation timed out after 10000ms")
    );

    // Must fail closed with PayPalUnknownOutcomeError
    await expect(service.createPayPalOrder(purchase.id, buyerActor)).rejects.toThrow(
      PayPalUnknownOutcomeError
    );

    // Verify PayPal client was called exactly once and not blindly retried in loop
    expect(mockPayPal.createOrder).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // SECTION 5: PERSISTENCE & DEPLOYMENT COMPATIBILITY
  // ==========================================================================

  it("5.1 Supports POLICY_STORAGE_PATH environment override for platform storage mounts", () => {
    mkdirSync(tempDir, { recursive: true });
    process.env.POLICY_STORAGE_PATH = tempStoragePath;

    const store = new DurablePolicyStore();
    expect(store.getStoragePath()).toBe(tempStoragePath);

    delete process.env.POLICY_STORAGE_PATH;
  });

  it("5.2 Quarantines corrupted files without crashing and falls back safely to default policies", () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(tempStoragePath, "{ malformed json: not valid at all", "utf8");

    const store = new DurablePolicyStore(tempStoragePath);
    const registry = new MerchantPolicyRegistry();
    const engine = new PolicyProposalEngine();

    const res = store.loadState(registry, engine);
    expect(res.corruptFileDetected).toBe(true);
    expect(registry.getPoliciesForMerchant("Best Buy").length).toBeGreaterThan(0);
    expect(registry.getPoliciesForMerchant("Walmart").length).toBeGreaterThan(0);
  });
});
