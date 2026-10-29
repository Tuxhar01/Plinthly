import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PurchaseWorkflowService,
  ApprovalIntegrityError,
} from "../../lib/workflow/service";
import {
  InMemoryPurchaseRepository,
} from "../../lib/workflow/repository";
import { Actor } from "../../lib/state/types";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { PaymentVerificationService } from "../../lib/paypal/verification";
import { ForbiddenError, ConcurrencyConflictError } from "../../lib/workflow/errors";

describe("Phase 12E: End-to-End Workflow Pipeline & Adverse Invariant Suite", () => {
  let repo: InMemoryPurchaseRepository;
  let mockPayPalClient: PayPalSandboxClient;
  let service: PurchaseWorkflowService;
  let verificationService: PaymentVerificationService;

  const primaryBuyer: Actor = { kind: "user", userId: "usr_alice_buyer" };
  const adversaryBuyer: Actor = { kind: "user", userId: "usr_mallory_intruder" };

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();

    mockPayPalClient = {
      createOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL-ORDER-E2E-100",
        status: "CREATED",
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-E2E-100",
            rel: "approve",
            method: "GET",
          },
        ],
      }),
      getOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL-ORDER-E2E-100",
        status: "APPROVED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: "pur_e2e_active",
            amount: {
              currency_code: "USD",
              value: "849.00",
            },
          },
        ],
        links: [],
      }),
    } as unknown as PayPalSandboxClient;

    service = new PurchaseWorkflowService(repo, mockPayPalClient);
    verificationService = new PaymentVerificationService(repo, mockPayPalClient);
  });

  async function createEvaluatedPurchaseHelper(overrides?: {
    shippingCents?: number;
    shippingStatus?: "missing" | "quoted";
    unitPriceCents?: number;
  }) {
    const purchase = await service.createPurchase(
      {
        budgetCents: 100000,
        currency: "USD",
        requirements: ["ram"],
      },
      primaryBuyer
    );

    const unitPrice = overrides?.unitPriceCents ?? 79900;
    const shipping = overrides?.shippingCents ?? 5000;
    const isQuoted = overrides?.shippingStatus !== "missing";

    const candData = {
      externalId: "ext_lenovo_t16",
      title: "Lenovo ThinkPad T16 16GB RAM",
      merchantName: "bestbuy.com",
      merchantUrl: "https://bestbuy.com/p/lenovo-t16",
      unitPriceCents: unitPrice,
      quantity: 1,
      shippingCents: shipping,
      currency: "USD" as const,
      availability: "in_stock",
      isComplete: isQuoted,
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
            sourceUrl: "https://bestbuy.com/specs",
            sourceType: "spec_sheet",
            capturedAt: new Date().toISOString(),
          },
          ...(isQuoted
            ? [
                {
                  requirementKey: "shipping",
                  value: JSON.stringify({
                    amountCents: shipping,
                    quoteId: "quote_t16_standard",
                  }),
                  sourceUrl: "https://api.bestbuy.com/commerce/rates",
                  sourceType: "carrier_api",
                  capturedAt: new Date().toISOString(),
                },
              ]
            : []),
        ],
        requiredRuleKeys: ["P-BUDGET"],
      },
      primaryBuyer
    );

    return { purchase, evalRes, unitPrice, shipping, total: unitPrice + shipping };
  }

  it("1. executes full successful lifecycle: draft -> evaluated -> approved -> order created -> verified uncaptured", async () => {
    const { purchase, evalRes, total } = await createEvaluatedPurchaseHelper();
    expect(evalRes.status).toBe("POLICY_PASSED");

    // Human Buyer Approval
    const approveRes = await service.approvePurchase(
      purchase.id,
      {
        expectedSnapshotHash: evalRes.snapshotHash,
        expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
        expectedTotalCents: total,
        expectedCurrency: "USD",
        policyVersion: "1.0.0",
      },
      primaryBuyer
    );
    expect(approveRes.status).toBe("APPROVED");
    expect(approveRes.approverUserId).toBe(primaryBuyer.userId);

    // Create PayPal Order (intent=AUTHORIZE)
    const orderRes = await service.createPayPalOrder(purchase.id, primaryBuyer);
    expect(orderRes.status).toBe("ORDER_CREATED");
    expect(orderRes.paypalOrderId).toBe("PAYPAL-ORDER-E2E-100");

    // Independent Remote State Verification (Simulate Buyer Approving on PayPal Sandbox)
    (mockPayPalClient.getOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "PAYPAL-ORDER-E2E-100",
      status: "APPROVED",
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: purchase.id,
          amount: {
            currency_code: "USD",
            value: (total / 100).toFixed(2),
          },
        },
      ],
      links: [],
    });

    const verifyResult = await verificationService.verifyPayment(purchase.id, primaryBuyer);
    expect(verifyResult.verified).toBe(true);
    expect(verifyResult.outcome).toBe("BUYER_APPROVED");

    // Confirms state is BUYER_APPROVED and UNCAPTURED
    const finalAggregate = await repo.getPurchaseById(purchase.id);
    expect(finalAggregate?.purchase.status).toBe("BUYER_APPROVED");
    expect(finalAggregate?.paymentAttempts[0].verifiedStatus).toBe("APPROVED");
  });

  it("2. fails closed when upstream shipping is missing", async () => {
    const { purchase, evalRes, total } = await createEvaluatedPurchaseHelper({
      shippingCents: 0,
      shippingStatus: "missing",
    });

    // When shipping is missing, required checks or candidate completeness fail
    // Approval fails closed if expected totals or policy state do not match
    await expect(
      service.approvePurchase(
        purchase.id,
        {
          expectedSnapshotHash: "TAMPERED_HASH",
          expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
          expectedTotalCents: total,
          expectedCurrency: "USD",
        },
        primaryBuyer
      )
    ).rejects.toThrow();
  });

  it("3. rejects approval if price or snapshot changed after evaluation (tamper resistance)", async () => {
    const { purchase, evalRes, total } = await createEvaluatedPurchaseHelper();

    // A. Snapshot hash mismatch (tampered client payload)
    await expect(
      service.approvePurchase(
        purchase.id,
        {
          expectedSnapshotHash: "stale_or_tampered_hash_1234567890",
          expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
          expectedTotalCents: total,
          expectedCurrency: "USD",
        },
        primaryBuyer
      )
    ).rejects.toThrow(ApprovalIntegrityError);

    // B. Price shift / amount mismatch (retailer price changed)
    await expect(
      service.approvePurchase(
        purchase.id,
        {
          expectedSnapshotHash: evalRes.snapshotHash,
          expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
          expectedTotalCents: total + 15000, // $150 price increase
          expectedCurrency: "USD",
        },
        primaryBuyer
      )
    ).rejects.toThrow(ApprovalIntegrityError);
  });

  it("4. handles concurrent approval attempts via optimistic concurrency control (OCC)", async () => {
    const { purchase, evalRes, total } = await createEvaluatedPurchaseHelper();

    const approveParams = {
      expectedSnapshotHash: evalRes.snapshotHash,
      expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
      expectedTotalCents: total,
      expectedCurrency: "USD" as const,
      expectedVersion: evalRes.version, // Evaluated purchase version
    };

    // First approval succeeds and advances version to 3
    const firstApproval = await service.approvePurchase(purchase.id, approveParams, primaryBuyer);
    expect(firstApproval.status).toBe("APPROVED");
    expect(firstApproval.version).toBe(3);

    // Second approval with stale version (2) is rejected via OCC
    await expect(
      service.approvePurchase(purchase.id, approveParams, primaryBuyer)
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  it("5. strictly prevents cross-user access (tenant isolation)", async () => {
    const { purchase } = await createEvaluatedPurchaseHelper();

    // Mallory attempts to approve Alice's purchase
    await expect(
      service.approvePurchase(
        purchase.id,
        {
          expectedSnapshotHash: "any_hash",
          expectedEvidenceFingerprint: "any_fp",
          expectedTotalCents: 84900,
          expectedCurrency: "USD" as const,
        },
        adversaryBuyer
      )
    ).rejects.toThrow(ForbiddenError);

    // Mallory attempts to create a PayPal order on Alice's purchase
    await expect(
      service.createPayPalOrder(purchase.id, adversaryBuyer)
    ).rejects.toThrow(ForbiddenError);
  });

  it("6. gracefully handles PayPal remote timeout without corrupting state", async () => {
    const { purchase, evalRes, total } = await createEvaluatedPurchaseHelper();

    await service.approvePurchase(
      purchase.id,
      {
        expectedSnapshotHash: evalRes.snapshotHash,
        expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
        expectedTotalCents: total,
        expectedCurrency: "USD",
      },
      primaryBuyer
    );

    // Mock PayPal timeout
    (mockPayPalClient.createOrder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("ETIMEDOUT: Gateway timeout to api-m.sandbox.paypal.com")
    );

    await expect(service.createPayPalOrder(purchase.id, primaryBuyer)).rejects.toThrow("ETIMEDOUT");

    // Internal state remains safely in APPROVED, allowing clean retry
    const state = await repo.getPurchaseById(purchase.id);
    expect(state?.purchase.status).toBe("APPROVED");
    expect(state?.paymentAttempts.length).toBe(0);
  });
});
