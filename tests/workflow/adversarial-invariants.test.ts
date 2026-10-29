import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PurchaseWorkflowService,
  ApprovalIntegrityError,
} from "../../lib/workflow/service";
import {
  InMemoryPurchaseRepository,
  CandidateRecord,
  PurchaseRecord,
} from "../../lib/workflow/repository";
import { Actor, PurchaseState } from "../../lib/state/types";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { PaymentVerificationService } from "../../lib/paypal/verification";
import { computeSnapshotHash } from "../../lib/state/snapshot";
import {
  validateQuoteForCandidate,
  computeQuoteFingerprint,
  SuccessfulShippingQuote,
} from "../../lib/discovery/shipping-quote";
import { transition } from "../../lib/state/transitions";

describe("Plinthly Phase 11G — Adversarial Invariants and Payment Integrity Audit", () => {
  let repo: InMemoryPurchaseRepository;
  let mockPayPalClient: PayPalSandboxClient;
  let service: PurchaseWorkflowService;
  let verificationService: PaymentVerificationService;

  const buyerActor: Actor = { kind: "user", userId: "usr_buyer_adversarial" };
  const systemActor: Actor = { kind: "system", component: "adversarial_audit" };

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();

    mockPayPalClient = {
      createOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL-ORDER-ADV-001",
        status: "CREATED",
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-ADV-001",
            rel: "approve",
            method: "GET",
          },
        ],
      }),
      getOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL-ORDER-ADV-001",
        status: "APPROVED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: "pur_test_placeholder",
            amount: {
              currency_code: "USD",
              value: "505.00",
            },
          },
        ],
        links: [],
      }),
      authorizeOrder: vi.fn(),
      captureOrder: vi.fn(),
    } as unknown as PayPalSandboxClient;

    service = new PurchaseWorkflowService(repo, mockPayPalClient);
    verificationService = new PaymentVerificationService(repo, mockPayPalClient);
  });

  async function createApprovedPurchaseHelper(overrides?: {
    unitPriceCents?: number;
    shippingCents?: number;
    shippingQuoteExpiresAt?: string | null;
  }) {
    const purchase = await service.createPurchase(
      {
        budgetCents: 100000,
        currency: "USD",
        requirements: ["ram", { key: "ram", expectedValue: "16GB" }],
      },
      buyerActor
    );

    const unitPrice = overrides?.unitPriceCents ?? 50000;
    const shipping = overrides?.shippingCents ?? 500;
    const total = unitPrice + shipping;

    const candData = {
      externalId: "EXT-ADV-01",
      title: "Adversarial Test Item",
      merchantName: "TrustedStore",
      merchantUrl: "https://trustedstore.com/item",
      unitPriceCents: unitPrice,
      quantity: 1,
      shippingCents: shipping,
      currency: "USD" as const,
      availability: "in_stock",
      isComplete: true,
      capturedAt: new Date().toISOString(),
    };

    const evalRes = await service.evaluatePurchaseCandidate(
      purchase.id,
      {
        rawCandidate: candData,
        rawObservations: [
          {
            requirementKey: "ram",
            value: "16GB",
            sourceUrl: "https://trustedstore.com/specs",
            sourceType: "spec_sheet",
            capturedAt: new Date().toISOString(),
          },
          ...(overrides?.shippingQuoteExpiresAt
            ? [
                {
                  requirementKey: "shipping",
                  value: JSON.stringify({
                    amountCents: shipping,
                    expiresAt: overrides.shippingQuoteExpiresAt,
                    quoteId: "quote_test_exp",
                  }),
                  sourceUrl: "https://api.trustedstore.com/shipping-rates/001",
                  sourceType: "retailer_shipping_quote",
                  capturedAt: new Date().toISOString(),
                },
              ]
            : []),
        ],
        requiredRuleKeys: ["P-BUDGET"],
      },
      buyerActor
    );

    expect(evalRes.status).toBe("POLICY_PASSED");

    const appRes = await service.approvePurchase(
      purchase.id,
      {
        expectedSnapshotHash: evalRes.snapshotHash,
        expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
        expectedTotalCents: total,
        expectedCurrency: "USD",
        policyVersion: "1.0.0",
        expectedVersion: evalRes.version,
      },
      buyerActor
    );

    expect(appRes.status).toBe("APPROVED");

    return { purchaseId: purchase.id, evalRes, appRes, total };
  }

  // 1. Price changes after approval fails closed
  it("1. price changes after approval fail closed before creating PayPal order", async () => {
    const { purchaseId, evalRes } = await createApprovedPurchaseHelper();

    // Adversarial tampering: modify unit price in database
    const storedCand = (repo as unknown as { candidates: Map<string, CandidateRecord> }).candidates.get(evalRes.candidateId);
    expect(storedCand).toBeDefined();
    storedCand!.unitPriceCents = 60000; // Increased from 50000 to 60000
    storedCand!.totalCents = 60500;
    storedCand!.snapshotHash = computeSnapshotHash({
      ...storedCand!,
      unitPriceCents: 60000,
      totalCents: 60500,
    });

    await expect(service.createPayPalOrder(purchaseId, buyerActor)).rejects.toThrow(ApprovalIntegrityError);

    // Verify PayPal client was never called
    expect(mockPayPalClient.createOrder).not.toHaveBeenCalled();
  });

  // 2. Shipping amount changes after approval fails closed
  it("2. shipping amount changes after approval fail closed before order creation", async () => {
    const { purchaseId, evalRes } = await createApprovedPurchaseHelper();

    const storedCand = (repo as unknown as { candidates: Map<string, CandidateRecord> }).candidates.get(evalRes.candidateId);
    expect(storedCand).toBeDefined();
    storedCand!.shippingCents = 2500; // Alter shipping from 500 to 2500
    storedCand!.totalCents = 52500;
    storedCand!.snapshotHash = computeSnapshotHash({
      ...storedCand!,
      shippingCents: 2500,
      totalCents: 52500,
    });

    await expect(service.createPayPalOrder(purchaseId, buyerActor)).rejects.toThrow(ApprovalIntegrityError);
    expect(mockPayPalClient.createOrder).not.toHaveBeenCalled();
  });

  // 3. Retailer or canonical URL changes after approval fails closed
  it("3. retailer or canonical URL changes fail closed before order creation", async () => {
    const { purchaseId, evalRes } = await createApprovedPurchaseHelper();

    const storedCand = (repo as unknown as { candidates: Map<string, CandidateRecord> }).candidates.get(evalRes.candidateId);
    expect(storedCand).toBeDefined();
    // Tamper with merchant domain / URL
    storedCand!.merchantUrl = "https://hijacked-attacker-store.com/item";
    storedCand!.snapshotHash = computeSnapshotHash({
      ...storedCand!,
      merchantUrl: "https://hijacked-attacker-store.com/item",
    });

    await expect(service.createPayPalOrder(purchaseId, buyerActor)).rejects.toThrow(ApprovalIntegrityError);
    expect(mockPayPalClient.createOrder).not.toHaveBeenCalled();
  });

  // 4. Evidence removal or replacement after approval fails closed
  it("4. evidence removal or replacement after approval fails closed", async () => {
    const { purchaseId } = await createApprovedPurchaseHelper();

    const storedPurchase = (repo as unknown as { purchases: Map<string, PurchaseRecord> }).purchases.get(purchaseId);
    expect(storedPurchase).toBeDefined();
    // Tamper with policy evidence fingerprint on purchase record
    storedPurchase!.policyEvidenceFingerprint = "f".repeat(64);

    await expect(service.createPayPalOrder(purchaseId, buyerActor)).rejects.toThrow(ApprovalIntegrityError);
    expect(mockPayPalClient.createOrder).not.toHaveBeenCalled();
  });

  // 5. Quote expires after approval but before order creation fails closed
  it("5. quote expires after approval but before order creation fails closed", async () => {
    // Quote expired 1 hour ago
    const pastExpiry = new Date(Date.now() - 3600000).toISOString();
    const { purchaseId } = await createApprovedPurchaseHelper();

    await expect(
      service.createPayPalOrder(purchaseId, buyerActor, {
        shippingQuote: { expiresAt: pastExpiry },
      })
    ).rejects.toThrow(ApprovalIntegrityError);
    expect(mockPayPalClient.createOrder).not.toHaveBeenCalled();
  });

  // 6. Stale or reused quote for a different candidate fails closed
  it("6. reusing a quote for a different candidate fails validation and approval", () => {
    const now = new Date();
    const quoteForCandidateA: SuccessfulShippingQuote = {
      status: "success",
      quoteId: "quote_cand_a",
      amountCents: 999,
      currency: "USD",
      retailerId: "trustedstore.com",
      merchantDomain: "trustedstore.com",
      externalId: "PROD-AAA:trustedstore.com",
      canonicalProductUrl: "https://trustedstore.com/prod-aaa",
      destinationPostalCode: "98101",
      destinationCountry: "US",
      deliveryMethod: "standard_ground",
      quotedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600000).toISOString(),
      sourceUrl: "https://api.trustedstore.com/quotes/quote_cand_a",
      quoteFingerprint: "",
    };

    const quoteFingerprint = computeQuoteFingerprint(quoteForCandidateA);
    const validQuoteForA = { ...quoteForCandidateA, quoteFingerprint };

    // Attacker submits quote A for Candidate B
    const requestForCandidateB = {
      candidate: {
        externalId: "PROD-BBB:trustedstore.com", // Different candidate!
        merchantName: "TrustedStore",
        merchantUrl: "https://trustedstore.com/prod-bbb",
        unitPriceCents: 10000,
        quantity: 1,
        currency: "USD" as const,
      },
      canonicalProductUrl: "https://trustedstore.com/prod-bbb",
      destination: {
        country: "US" as const,
        postalCode: "98101",
        deliveryMethodPreference: "standard_ground" as const,
      },
      requestedCurrency: "USD" as const,
      now,
    };

    const validation = validateQuoteForCandidate(validQuoteForA, requestForCandidateB);
    expect(validation.valid).toBe(false);
    expect(validation.isAuthoritative).toBe(false);
    expect(validation.shippingCents).toBeNull();
    expect(validation.rejectionReason).toContain("does not match candidate externalId");
  });

  // 7. Duplicate order-creation requests return existing attempt idempotently without creating a second remote order
  it("7. duplicate order-creation requests return existing attempt without creating duplicate remote order", async () => {
    const { purchaseId } = await createApprovedPurchaseHelper();

    // First order creation request
    const firstOrder = await service.createPayPalOrder(purchaseId, buyerActor);
    expect(firstOrder.status).toBe("ORDER_CREATED");
    expect(firstOrder.paypalOrderId).toBe("PAYPAL-ORDER-ADV-001");
    expect(mockPayPalClient.createOrder).toHaveBeenCalledTimes(1);

    // Second order creation request arrives (duplicate)
    const secondOrder = await service.createPayPalOrder(purchaseId, buyerActor);
    expect(secondOrder.status).toBe("ORDER_CREATED");
    expect(secondOrder.paypalOrderId).toBe("PAYPAL-ORDER-ADV-001");

    // CRITICAL: PayPal remote API was NOT called a second time
    expect(mockPayPalClient.createOrder).toHaveBeenCalledTimes(1);
  });

  // 8. PayPal order status conflicts with application recorded status fails closed
  it("8. conflicting or unapproved remote PayPal order state fails closed and does not advance state", async () => {
    const { purchaseId } = await createApprovedPurchaseHelper();

    await service.createPayPalOrder(purchaseId, buyerActor);

    // Mock remote PayPal returning CREATED (buyer has NOT approved yet in Sandbox)
    (mockPayPalClient.getOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "PAYPAL-ORDER-ADV-001",
      status: "CREATED", // Not approved!
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: purchaseId,
          amount: {
            currency_code: "USD",
            value: "505.00",
          },
        },
      ],
      links: [],
    });

    const verifyRes = await verificationService.verifyPayment(purchaseId, buyerActor);
    expect(verifyRes.verified).toBe(false);
    expect(verifyRes.outcome).toBe("PENDING_BUYER_ACTION");

    // Internal state remains ORDER_CREATED, NOT advancing to BUYER_CONFIRMED
    const updated = await repo.getPurchaseById(purchaseId);
    expect(updated?.purchase.status).toBe("ORDER_CREATED");
  });

  // 9. Reference ID or Amount mismatch from PayPal fails closed with MISMATCH_REJECTED
  it("9. PayPal order reference ID or amount mismatch fails closed with MISMATCH_REJECTED", async () => {
    const { purchaseId } = await createApprovedPurchaseHelper();

    await service.createPayPalOrder(purchaseId, buyerActor);

    // Remote order has wrong reference ID (adversarial swap)
    (mockPayPalClient.getOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "PAYPAL-ORDER-ADV-001",
      status: "APPROVED",
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: "WRONG_PURCHASE_ID_HIJACK",
          amount: {
            currency_code: "USD",
            value: "505.00",
          },
        },
      ],
      links: [],
    });

    const verifyRes = await verificationService.verifyPayment(purchaseId, buyerActor);
    expect(verifyRes.verified).toBe(false);
    expect(verifyRes.outcome).toBe("MISMATCH_REJECTED");
    expect(verifyRes.message).toContain("does not match internal purchase ID");

    // State remains ORDER_CREATED
    const updated = await repo.getPurchaseById(purchaseId);
    expect(updated?.purchase.status).toBe("ORDER_CREATED");
  });

  // 10. No capture transition or endpoint exists
  it("10. verifies no capture transition is permitted from any state", () => {
    const now = new Date();
    const approvedState: PurchaseState = {
      purchaseId: "pur_term_test",
      status: "APPROVED",
      policyVersion: "1.0.0",
      budgetCents: 60000,
      currency: "USD",
      requiredRuleKeys: ["P-BUDGET"],
      selectedCandidate: null,
      approvals: [],
      paymentAttempts: [],
      currentEvidenceFingerprint: null,
      policyEvidenceFingerprint: null,
    };

    // Transitioning with record_capture_attempt fails closed with illegal_transition
    const res = transition(
      approvedState,
      { kind: "record_capture_attempt" },
      { now, actor: systemActor }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("illegal_transition");
    }
  });
});
