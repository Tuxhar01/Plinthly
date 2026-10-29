import { describe, it, expect, vi, beforeEach } from "vitest";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { PaymentVerificationService } from "../../lib/paypal/verification";
import { Actor, AuditEventDraft } from "../../lib/state/types";
import {
  PayPalGetOrderResponse,
  PayPalNetworkError,
} from "../../lib/paypal/types";
import { validateRecord } from "../../lib/audit/writer";

describe("Phase 17: Payment Intent Audit Trail & Immutable Lineage", () => {
  let repo: InMemoryPurchaseRepository;
  let mockPayPalClient: PayPalSandboxClient;
  let workflowService: PurchaseWorkflowService;
  let verificationService: PaymentVerificationService;

  const testBuyer: Actor = { kind: "user", userId: "usr_buyer_phase17" };
  const sysActor: Actor = { kind: "system", component: "sys_evaluator" };

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
    mockPayPalClient = {
      createOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL_ORDER_PHASE17",
        status: "CREATED",
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_ORDER_PHASE17",
            rel: "approve",
            method: "GET",
          },
        ],
      }),
      getOrder: vi.fn(),
      clearCachedToken: vi.fn(),
    } as unknown as PayPalSandboxClient;

    workflowService = new PurchaseWorkflowService(repo, mockPayPalClient);
    verificationService = new PaymentVerificationService(repo, mockPayPalClient);
  });

  async function createReadyPurchase(totalCents: number = 201000) {
    const purchase = await workflowService.createPurchase(
      {
        budgetCents: totalCents + 10000,
        currency: "USD",
        requirements: ["spec_ram"],
      },
      testBuyer
    );

    const now = new Date("2026-10-29T12:00:00Z");
    const evalRes = await workflowService.evaluatePurchaseCandidate(
      purchase.id,
      {
        rawCandidate: {
          externalId: "ext_item_p17",
          title: "Phase 17 Laptop",
          merchantName: "Acme",
          merchantUrl: "https://acme.com/laptop",
          unitPriceCents: totalCents,
          quantity: 1,
          shippingCents: 0,
          currency: "USD",
          availability: "IN_STOCK",
        },
        rawObservations: [
          {
            requirementKey: "spec_ram",
            value: "32GB",
            status: "supports",
            sourceUrl: "https://acme.com/laptop",
            sourceType: "feed",
            capturedAt: now.toISOString(),
          },
        ],
        requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
      },
      sysActor,
      now
    );

    await workflowService.approvePurchase(
      purchase.id,
      {
        expectedSnapshotHash: evalRes.snapshotHash,
      },
      testBuyer,
      now
    );

    return { purchaseId: purchase.id };
  }

  it("1. Persists requested intent 'AUTHORIZE' in payment attempt and orderResponse for new orders", async () => {
    const { purchaseId } = await createReadyPurchase(201000);
    const orderRes = await workflowService.createPayPalOrder(purchaseId, testBuyer);

    // DTO response carries requestedIntent: "AUTHORIZE"
    expect(orderRes.status).toBe("ORDER_CREATED");
    expect(orderRes.requestedIntent).toBe("AUTHORIZE");
    expect(orderRes.paypalOrderId).toBe("PAYPAL_ORDER_PHASE17");

    // Repository aggregate carries requestedIntent: "AUTHORIZE"
    const aggregate = await repo.getPurchaseById(purchaseId);
    expect(aggregate?.paymentAttempts).toHaveLength(1);
    const attempt = aggregate?.paymentAttempts[0];
    expect(attempt?.requestedIntent).toBe("AUTHORIZE");
    expect(attempt?.status).toBe("OPEN");

    // Public PurchaseResponse DTO carries requestedIntent
    const pubRes = await workflowService.getPurchase(purchaseId, testBuyer);
    expect(pubRes.livePaymentAttempt?.requestedIntent).toBe("AUTHORIZE");
  });

  it("2. Records requested intent 'AUTHORIZE' immutably in the order_created audit event", async () => {
    const { purchaseId } = await createReadyPurchase(201000);
    await workflowService.createPayPalOrder(purchaseId, testBuyer);

    const auditHistory = await workflowService.getAuditHistory(purchaseId, testBuyer);
    const orderCreatedEvent = auditHistory.events.find((e) => e.type === "order_created");

    expect(orderCreatedEvent).toBeDefined();
    const payload = orderCreatedEvent!.payload as Record<string, unknown>;
    expect(payload.requestedIntent).toBe("AUTHORIZE");
    expect(payload.paypalOrderId).toBe("PAYPAL_ORDER_PHASE17");
    expect(payload.totalCents).toBe(201000);
  });

  it("3. Keeps requested intent ('AUTHORIZE') strictly distinct from observed remote intent and verification status", async () => {
    const { purchaseId } = await createReadyPurchase(201000);
    await workflowService.createPayPalOrder(purchaseId, testBuyer);

    // Mock remote PayPal order returning remoteStatus: APPROVED and remote intent: AUTHORIZE
    const approvedRemote: PayPalGetOrderResponse = {
      id: "PAYPAL_ORDER_PHASE17",
      status: "APPROVED",
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: purchaseId,
          amount: { currency_code: "USD", value: "2010.00" },
        },
      ],
    };
    vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce(approvedRemote);

    const verification = await verificationService.verifyPayment(purchaseId, testBuyer);
    expect(verification.verified).toBe(true);
    expect(verification.outcome).toBe("BUYER_APPROVED");

    // Internal state verifies: requestedIntent is unchanged "AUTHORIZE", verifiedStatus is "APPROVED"
    const aggregate = await repo.getPurchaseById(purchaseId);
    const attempt = aggregate?.paymentAttempts[0];
    expect(attempt?.requestedIntent).toBe("AUTHORIZE");
    expect(attempt?.verifiedStatus).toBe("APPROVED");
  });

  it("4. Historical records without requestedIntent evaluate to null without rewriting or inventing intent", async () => {
    const { purchaseId } = await createReadyPurchase(50000);
    const aggBefore = await repo.getPurchaseById(purchaseId);
    const approval = aggBefore!.approvals[0];

    // Record order creation without requestedIntent in payload (legacy behavior)
    await repo.recordOrderCreation({
      purchaseId,
      expectedStatus: "APPROVED",
      expectedVersion: aggBefore!.purchase.version,
      nextStatus: "ORDER_CREATED",
      paymentAttempt: {
        id: "att_legacy_123",
        purchaseId,
        approvalId: approval.id,
        idempotencyKey: "idem_legacy_123",
        paypalOrderId: "LEGACY_ORDER_NO_INTENT",
        status: "OPEN",
        createdAt: new Date(),
        verifiedStatus: null,
        verifiedAt: null,
        failureReason: null,
      },
      auditEvents: [
        {
          type: "order_created",
          purchaseId,
          actor: testBuyer,
          occurredAt: new Date(),
          payload: {
            paymentAttemptId: "att_legacy_123",
            approvalId: approval.id,
            paypalOrderId: "LEGACY_ORDER_NO_INTENT",
            totalCents: 50000,
            // requestedIntent is intentionally omitted (legacy)
          },
        },
      ],
    });

    const aggregate = await repo.getPurchaseById(purchaseId);
    const attempt = aggregate?.paymentAttempts[0];

    // INVARIANT: requestedIntent is null, NOT invented or assumed as AUTHORIZE
    expect(attempt?.requestedIntent).toBeNull();
  });

  it("5. Remote PayPal lookup failures preserve local requestedIntent and attempt immutability", async () => {
    const { purchaseId } = await createReadyPurchase(201000);
    await workflowService.createPayPalOrder(purchaseId, testBuyer);

    // PayPal API network error
    vi.mocked(mockPayPalClient.getOrder).mockRejectedValueOnce(
      new PayPalNetworkError("Remote connection dropped")
    );

    const verification = await verificationService.verifyPayment(purchaseId, testBuyer);
    expect(verification.verified).toBe(false);
    expect(verification.outcome).toBe("UNVERIFIED_TRANSIENT");

    // Local requestedIntent remains completely intact and immutable
    const aggregate = await repo.getPurchaseById(purchaseId);
    const attempt = aggregate?.paymentAttempts[0];
    expect(attempt?.requestedIntent).toBe("AUTHORIZE");
    expect(attempt?.status).toBe("OPEN");
    expect(attempt?.verifiedStatus).toBeNull();
  });

  it("6. Audit writer rejects non-AUTHORIZE requestedIntent in order_created event", () => {
    const invalidDraft: AuditEventDraft<"order_created"> = {
      type: "order_created",
      purchaseId: "pur_test_intent_invalid",
      actor: testBuyer,
      occurredAt: new Date(),
      payload: {
        paymentAttemptId: "att_1",
        approvalId: "appr_1",
        paypalOrderId: "PAYPAL_1",
        totalCents: 1000,
        requestedIntent: "CAPTURE" as unknown as "AUTHORIZE", // Illegal requested intent
      },
    };
    expect(() => {
      validateRecord(invalidDraft);
    }).toThrowError(/order_created payload requestedIntent must be AUTHORIZE if specified/);

    const validDraft: AuditEventDraft<"order_created"> = {
      type: "order_created",
      purchaseId: "pur_test_intent_valid",
      actor: testBuyer,
      occurredAt: new Date(),
      payload: {
        paymentAttemptId: "att_1",
        approvalId: "appr_1",
        paypalOrderId: "PAYPAL_1",
        totalCents: 1000,
        requestedIntent: "AUTHORIZE",
      },
    };
    expect(() => {
      validateRecord(validDraft);
    }).not.toThrow();
  });
});
