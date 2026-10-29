import { describe, it, expect, vi, beforeEach } from "vitest";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { PaymentVerificationService } from "../../lib/paypal/verification";
import { Actor } from "../../lib/state/types";
import {
  PayPalApiError,
  PayPalGetOrderResponse,
  PayPalNetworkError,
  PayPalTimeoutError,
  PayPalUnknownOutcomeError,
} from "../../lib/paypal/types";
import { WorkflowError } from "../../lib/workflow/errors";
import { createPayPalOrderSchema } from "../../lib/workflow/validation";

describe("Phase 16.3: Payment Lifecycle State Distinctions & Acceptance", () => {
  let repo: InMemoryPurchaseRepository;
  let mockPayPalClient: PayPalSandboxClient;
  let workflowService: PurchaseWorkflowService;
  let verificationService: PaymentVerificationService;

  const testBuyer: Actor = { kind: "user", userId: "usr_buyer_16_3" };
  const sysActor: Actor = { kind: "system", component: "sys_evaluator" };

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
    mockPayPalClient = {
      createOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL_ORDER_16_3",
        status: "CREATED",
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_ORDER_16_3",
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
          externalId: "ext_item_16_3",
          title: "Verify Laptop",
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
            value: "16GB",
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

  // 1. Distinction: Order created, buyer action required
  describe("1. Order Created — Buyer Action Required (PAYER_ACTION_REQUIRED / CREATED)", () => {
    it("reports PENDING_BUYER_ACTION and preserves ORDER_CREATED state without advancing", async () => {
      const { purchaseId } = await createReadyPurchase(201000);
      const created = await workflowService.createPayPalOrder(purchaseId, testBuyer);

      expect(created.status).toBe("ORDER_CREATED");
      expect(created.paypalOrderId).toBe("PAYPAL_ORDER_16_3");

      const pendingOrder: PayPalGetOrderResponse = {
        id: "PAYPAL_ORDER_16_3",
        status: "PAYER_ACTION_REQUIRED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "2010.00" },
          },
        ],
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_ORDER_16_3",
            rel: "payer-action",
            method: "GET",
          },
        ],
      };
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce(pendingOrder);

      const verification = await verificationService.verifyPayment(purchaseId, testBuyer);

      expect(verification.verified).toBe(false);
      expect(verification.outcome).toBe("PENDING_BUYER_ACTION");
      expect(verification.remoteStatus).toBe("PAYER_ACTION_REQUIRED");
      expect(verification.approvalUrl).toBe("https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_ORDER_16_3");
      expect(verification.internalStatus).toBe("ORDER_CREATED");

      // Verify DB state was NOT advanced
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
      const attempt = current?.paymentAttempts.find((a) => a.paypalOrderId === "PAYPAL_ORDER_16_3");
      expect(attempt?.verifiedStatus).toBe("PAYER_ACTION_REQUIRED");
    });
  });

  // 2. Distinction: Buyer approved order
  describe("2. Buyer Approved Order (APPROVED)", () => {
    it("advances purchase from ORDER_CREATED to BUYER_APPROVED upon verified buyer approval", async () => {
      const { purchaseId } = await createReadyPurchase(201000);
      await workflowService.createPayPalOrder(purchaseId, testBuyer);

      const approvedOrder: PayPalGetOrderResponse = {
        id: "PAYPAL_ORDER_16_3",
        status: "APPROVED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "2010.00" },
          },
        ],
      };
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce(approvedOrder);

      const verification = await verificationService.verifyPayment(purchaseId, testBuyer);

      expect(verification.verified).toBe(true);
      expect(verification.outcome).toBe("BUYER_APPROVED");
      expect(verification.remoteStatus).toBe("APPROVED");
      expect(verification.internalStatus).toBe("BUYER_APPROVED");

      // Verify DB state advanced to BUYER_APPROVED
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("BUYER_APPROVED");
      const attempt = current?.paymentAttempts.find((a) => a.paypalOrderId === "PAYPAL_ORDER_16_3");
      expect(attempt?.verifiedStatus).toBe("APPROVED");
    });

    it("idempotently verifies when purchase is already in BUYER_APPROVED", async () => {
      const { purchaseId } = await createReadyPurchase(201000);
      await workflowService.createPayPalOrder(purchaseId, testBuyer);

      const approvedOrder: PayPalGetOrderResponse = {
        id: "PAYPAL_ORDER_16_3",
        status: "APPROVED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "2010.00" },
          },
        ],
      };
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValue(approvedOrder);

      // First verification advances to BUYER_APPROVED
      await verificationService.verifyPayment(purchaseId, testBuyer);

      // Second verification is idempotent
      const secondVerification = await verificationService.verifyPayment(purchaseId, testBuyer);
      expect(secondVerification.verified).toBe(true);
      expect(secondVerification.outcome).toBe("BUYER_APPROVED");
      expect(secondVerification.message).toContain("re-verified idempotently");
    });
  });

  // 3. Distinction: Remote COMPLETED / External Authorization without fund capture
  describe("3. Non-Capture Invariant & External Completion", () => {
    it("reports REMOTELY_COMPLETED without falsely advancing internal workflow to COMPLETED", async () => {
      const { purchaseId } = await createReadyPurchase(201000);
      await workflowService.createPayPalOrder(purchaseId, testBuyer);

      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_16_3",
        status: "COMPLETED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "2010.00" },
          },
        ],
      });

      const verification = await verificationService.verifyPayment(purchaseId, testBuyer);

      expect(verification.outcome).toBe("REMOTELY_COMPLETED");
      expect(verification.remoteStatus).toBe("COMPLETED");

      // Critical non-capture guarantee: internal status does NOT become COMPLETED
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
      expect(current?.purchase.status).not.toBe("COMPLETED");
    });
  });

  // 4. Distinction: Remote status unverified (transient error / 404)
  describe("4. Remote Unverified & Fault Isolation (Transient Errors / 404)", () => {
    it("returns UNVERIFIED_TRANSIENT on PayPalNetworkError without mutating purchase state", async () => {
      const { purchaseId } = await createReadyPurchase(201000);
      await workflowService.createPayPalOrder(purchaseId, testBuyer);

      vi.mocked(mockPayPalClient.getOrder).mockRejectedValueOnce(
        new PayPalNetworkError("Connection refused by PayPal Sandbox gateway")
      );

      const verification = await verificationService.verifyPayment(purchaseId, testBuyer);

      expect(verification.verified).toBe(false);
      expect(verification.outcome).toBe("UNVERIFIED_TRANSIENT");
      expect(verification.remoteStatus).toBeNull();
      expect(verification.internalStatus).toBe("ORDER_CREATED");

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });

    it("returns UNVERIFIED_TRANSIENT on PayPalTimeoutError without mutating purchase state", async () => {
      const { purchaseId } = await createReadyPurchase(201000);
      await workflowService.createPayPalOrder(purchaseId, testBuyer);

      vi.mocked(mockPayPalClient.getOrder).mockRejectedValueOnce(
        new PayPalTimeoutError("PayPal request timed out after 10000ms")
      );

      const verification = await verificationService.verifyPayment(purchaseId, testBuyer);

      expect(verification.verified).toBe(false);
      expect(verification.outcome).toBe("UNVERIFIED_TRANSIENT");

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });

    it("returns REMOTE_NOT_FOUND on HTTP 404 and preserves historical audit records", async () => {
      const { purchaseId } = await createReadyPurchase(201000);
      await workflowService.createPayPalOrder(purchaseId, testBuyer);

      vi.mocked(mockPayPalClient.getOrder).mockRejectedValueOnce(
        new PayPalApiError(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.", "debug_404_abc")
      );

      const verification = await verificationService.verifyPayment(purchaseId, testBuyer);

      expect(verification.verified).toBe(false);
      expect(verification.outcome).toBe("REMOTE_NOT_FOUND");
      expect(verification.remoteStatus).toBe("NOT_FOUND");
      expect(verification.details?.historicalAuditPreserved).toBe(true);

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
      const attempt = current?.paymentAttempts.find((a) => a.paypalOrderId === "PAYPAL_ORDER_16_3");
      expect(attempt?.verifiedStatus).toBe("NOT_FOUND");
      expect(attempt?.failureReason).toBe("remote_order_not_found");
    });
  });

  // 5. Distinction: Legacy order wrong intent (CAPTURE)
  describe("5. Legacy Order Wrong Intent (CAPTURE) Isolation", () => {
    it("verifyPayment rejects legacy CAPTURE order and suppresses approval URL", async () => {
      const { purchaseId } = await createReadyPurchase(201000);
      await workflowService.createPayPalOrder(purchaseId, testBuyer);

      // Remote order has status APPROVED but legacy intent CAPTURE
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_16_3",
        status: "APPROVED",
        intent: "CAPTURE" as unknown as "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "2010.00" },
          },
        ],
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_ORDER_16_3",
            rel: "payer-action",
            method: "GET",
          },
        ],
      });

      const verification = await verificationService.verifyPayment(purchaseId, testBuyer);

      expect(verification.verified).toBe(false);
      expect(verification.outcome).toBe("MISMATCH_REJECTED");
      expect(verification.approvalUrl).toBeNull();
      expect(verification.details?.observedIntent).toBe("CAPTURE");
      expect(verification.details?.requiredIntent).toBe("AUTHORIZE");
      expect(verification.details?.legacyOrderIncompatible).toBe(true);

      // Verify status was NOT advanced
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");

      const attempt = current?.paymentAttempts.find((a) => a.paypalOrderId === "PAYPAL_ORDER_16_3");
      expect(attempt?.verifiedStatus).toBe("INTENT_INCOMPATIBLE");
      expect(attempt?.failureReason).toBe("legacy_capture_intent_incompatible");
    });

    it("confirmBuyerApproval throws incompatible_payment_intent on legacy CAPTURE order", async () => {
      const { purchaseId } = await createReadyPurchase(201000);
      await workflowService.createPayPalOrder(purchaseId, testBuyer);

      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_16_3",
        status: "APPROVED",
        intent: "CAPTURE" as unknown as "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "2010.00" },
          },
        ],
      });

      let capturedError: unknown;
      try {
        await workflowService.confirmBuyerApproval(purchaseId, testBuyer, {
          paypalOrderId: "PAYPAL_ORDER_16_3",
        });
      } catch (err) {
        capturedError = err;
      }

      expect(capturedError).toBeInstanceOf(WorkflowError);
      expect((capturedError as WorkflowError).code).toBe("incompatible_payment_intent");

      // Verify status was NOT advanced
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });
  });

  // 6. Distinction: Order creation timeout / ambiguity
  describe("6. Order Creation Timeout & Ambiguity Handling", () => {
    it("surfaces PayPalTimeoutError without recording an unverified order ID", async () => {
      const { purchaseId } = await createReadyPurchase(201000);

      vi.mocked(mockPayPalClient.createOrder).mockRejectedValueOnce(
        new PayPalTimeoutError("Order creation timed out waiting for PayPal Sandbox response")
      );

      await expect(
        workflowService.createPayPalOrder(purchaseId, testBuyer)
      ).rejects.toThrow(PayPalUnknownOutcomeError);

      // Verify purchase remains in APPROVED state so retry can reconcile safely
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("APPROVED");
      expect(current?.paymentAttempts).toHaveLength(0);
    });
  });

  // 7. Distinction: Idempotent retry reconciles without second order
  describe("7. Idempotent Retry Reconciles Without Second Order", () => {
    it("returns existing payment attempt on subsequent calls without creating a duplicate order", async () => {
      const { purchaseId } = await createReadyPurchase(201000);

      // First call creates the order
      const firstResult = await workflowService.createPayPalOrder(purchaseId, testBuyer);
      expect(firstResult.status).toBe("ORDER_CREATED");
      expect(firstResult.paypalOrderId).toBe("PAYPAL_ORDER_16_3");
      expect(mockPayPalClient.createOrder).toHaveBeenCalledTimes(1);

      // Second call is idempotent: returns existing order without calling createOrder again
      const secondResult = await workflowService.createPayPalOrder(purchaseId, testBuyer);
      expect(secondResult.status).toBe("ORDER_CREATED");
      expect(secondResult.paypalOrderId).toBe(firstResult.paypalOrderId);
      expect(mockPayPalClient.createOrder).toHaveBeenCalledTimes(1);

      // Verify exactly 1 payment attempt in DB
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.paymentAttempts).toHaveLength(1);
    });
  });

  // 8. Request path and schema verification
  describe("8. Request Path & Schema Enforcement (AUTHORIZE Only)", () => {
    it("createPayPalOrderSchema rejects any payload with intent: 'CAPTURE'", () => {
      const result = createPayPalOrderSchema.safeParse({
        intent: "CAPTURE",
      });
      expect(result.success).toBe(false);
    });

    it("createPayPalOrderSchema accepts payload with intent: 'AUTHORIZE' or undefined", () => {
      const resWithAuth = createPayPalOrderSchema.safeParse({
        intent: "AUTHORIZE",
      });
      expect(resWithAuth.success).toBe(true);

      const resEmpty = createPayPalOrderSchema.safeParse({});
      expect(resEmpty.success).toBe(true);
    });

    it("workflowService.createPayPalOrder always sends intent: 'AUTHORIZE' to PayPalSandboxClient", async () => {
      const { purchaseId } = await createReadyPurchase(201000);
      await workflowService.createPayPalOrder(purchaseId, testBuyer);

      expect(mockPayPalClient.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: "AUTHORIZE",
          amountCents: 201000,
          currency: "USD",
          referenceId: purchaseId,
        })
      );
    });
  });
});
