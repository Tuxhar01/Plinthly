import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { PaymentVerificationService } from "../../lib/paypal/verification";
import {
  PayPalTimeoutError,
  PayPalNetworkError,
  PayPalApiError,
} from "../../lib/paypal/types";
import { Actor } from "../../lib/state/types";
import { ForbiddenError, WorkflowError } from "../../lib/workflow/errors";

describe("Phase 6 — Independent Payment Verification Service (Mocked Sandbox)", () => {
  let repo: InMemoryPurchaseRepository;
  let workflowService: PurchaseWorkflowService;
  let verificationService: PaymentVerificationService;
  let mockPayPalClient: PayPalSandboxClient;

  const userActor: Actor = { kind: "user", userId: "usr_buyer_verify" };
  const sysActor: Actor = { kind: "system", component: "sys_evaluator" };

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();

    mockPayPalClient = {
      getAccessToken: vi.fn().mockResolvedValue("mock_token"),
      createOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "CREATED",
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_ORDER_VERIFY_1",
            rel: "approve",
            method: "GET",
          },
        ],
      }),
      getOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: "placeholder",
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      }),
      clearCachedToken: vi.fn(),
    } as unknown as PayPalSandboxClient;

    workflowService = new PurchaseWorkflowService(repo, mockPayPalClient);
    verificationService = new PaymentVerificationService(repo, mockPayPalClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setupApprovedPurchase(totalCents: number = 8500) {
    const purchase = await workflowService.createPurchase(
      {
        budgetCents: 10000,
        currency: "USD",
        requirements: ["spec_v"],
      },
      userActor
    );

    const now = new Date("2026-10-20T12:00:00Z");
    const evalRes = await workflowService.evaluatePurchaseCandidate(
      purchase.id,
      {
        rawCandidate: {
          externalId: "ext_item_v",
          title: "Verify Widget",
          merchantName: "Acme",
          merchantUrl: "https://acme.com/v",
          unitPriceCents: totalCents,
          quantity: 1,
          shippingCents: 0,
          currency: "USD",
          availability: "IN_STOCK",
        },
        rawObservations: [
          {
            requirementKey: "spec_v",
            value: "pass",
            status: "supports",
            sourceUrl: "https://acme.com/v",
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
      userActor,
      now
    );

    return { purchaseId: purchase.id };
  }

  describe("Successful Independent Verification", () => {
    it("advances ORDER_CREATED purchase to BUYER_APPROVED when PayPal reports status APPROVED", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      });

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(true);
      expect(result.outcome).toBe("BUYER_APPROVED");
      expect(result.remoteStatus).toBe("APPROVED");
      expect(result.referenceIdMatched).toBe(true);
      expect(result.amountMatched).toBe(true);
      expect(result.currencyMatched).toBe(true);
      expect(result.observedAmountCents).toBe(8500);
      expect(result.observedCurrency).toBe("USD");
      expect(result.internalStatus).toBe("BUYER_APPROVED");

      // Verify repository updated to BUYER_APPROVED
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("BUYER_APPROVED");

      // Verify payment attempt verifiedStatus updated
      const attempt = current?.paymentAttempts.find((a) => a.paypalOrderId === "PAYPAL_ORDER_VERIFY_1");
      expect(attempt?.verifiedStatus).toBe("APPROVED");
      expect(attempt?.verifiedAt).toBeDefined();

      // Verify buyer_approved audit event was emitted
      const audit = await repo.getAuditHistory(purchaseId);
      expect(audit.some((e) => e.type === "buyer_approved")).toBe(true);
    });

    it("re-verifies idempotently when purchase is already BUYER_APPROVED without advancing state further", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockResolvedValue({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      });

      // Verification 1: advances ORDER_CREATED -> BUYER_APPROVED
      const res1 = await verificationService.verifyPayment(purchaseId, userActor);
      expect(res1.outcome).toBe("BUYER_APPROVED");

      const v1Purchase = await repo.getPurchaseById(purchaseId);
      const v1Version = v1Purchase!.purchase.version;

      // Verification 2: idempotent re-verification
      const res2 = await verificationService.verifyPayment(purchaseId, userActor);
      expect(res2.outcome).toBe("BUYER_APPROVED");
      expect(res2.verified).toBe(true);
      expect(res2.internalStatus).toBe("BUYER_APPROVED");

      // Status remains BUYER_APPROVED, not COMPLETED
      const v2Purchase = await repo.getPurchaseById(purchaseId);
      expect(v2Purchase?.purchase.status).toBe("BUYER_APPROVED");
      expect(v2Purchase?.purchase.version).toBe(v1Version);
    });
  });

  describe("Pending Remote Status Handling", () => {
    it("reports PENDING_BUYER_ACTION and retains ORDER_CREATED when status is CREATED", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "CREATED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      });

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("PENDING_BUYER_ACTION");
      expect(result.remoteStatus).toBe("CREATED");

      // Verify internal purchase status was not advanced
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");

      // Verify payment attempt recorded observed status
      const attempt = current?.paymentAttempts.find((a) => a.paypalOrderId === "PAYPAL_ORDER_VERIFY_1");
      expect(attempt?.verifiedStatus).toBe("CREATED");
    });

    it("reports PENDING_BUYER_ACTION when status is PAYER_ACTION_REQUIRED", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "PAYER_ACTION_REQUIRED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      });

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("PENDING_BUYER_ACTION");
      expect(result.remoteStatus).toBe("PAYER_ACTION_REQUIRED");

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });
  });

  describe("Non-Approved and Contradictory Remote Statuses", () => {
    it("reports REMOTELY_COMPLETED without falsely advancing internal workflow to COMPLETED", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      // Simulate PayPal reporting order status COMPLETED (e.g. captured externally)
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "COMPLETED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      });

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.outcome).toBe("REMOTELY_COMPLETED");
      expect(result.remoteStatus).toBe("COMPLETED");

      // CRITICAL GUARANTEE: Internal workflow must NOT be marked COMPLETED!
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
      expect(current?.purchase.status).not.toBe("COMPLETED");

      // Payment attempt records verifiedStatus
      const attempt = current?.paymentAttempts.find((a) => a.paypalOrderId === "PAYPAL_ORDER_VERIFY_1");
      expect(attempt?.verifiedStatus).toBe("COMPLETED");
    });

    it("reports VOIDED and records failureReason when order is VOIDED in PayPal", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "VOIDED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      });

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("VOIDED");
      expect(result.remoteStatus).toBe("VOIDED");

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
      const attempt = current?.paymentAttempts.find((a) => a.paypalOrderId === "PAYPAL_ORDER_VERIFY_1");
      expect(attempt?.failureReason).toBe("remote_order_voided");
    });
  });

  describe("Mismatched and Malformed Remote State Rejection", () => {
    it("rejects verification when remote order ID does not match stored attempt order ID", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "WRONG_REMOTE_ORDER_ID_888",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      });

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("MISMATCH_REJECTED");
      expect(result.message).toContain("does not match expected order ID");

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });

    it("rejects verification when purchase unit reference_id does not match purchase ID", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: "other_foreign_purchase_id",
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      });

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("MISMATCH_REJECTED");
      expect(result.referenceIdMatched).toBe(false);

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });

    it("rejects verification when currency or amount does not match approved terms", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      // Amount mismatch: 50.00 instead of 85.00
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "50.00" },
          },
        ],
      });

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("MISMATCH_REJECTED");
      expect(result.amountMatched).toBe(false);

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });

    it("rejects verification when purchase_units array is empty or malformed", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      // Empty purchase units
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [],
      });

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("MALFORMED_RESPONSE");

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });

    it("rejects verification when multiple purchase units are returned", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      // Multiple purchase units
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "85.00" },
          },
          {
            reference_id: "unit_2",
            amount: { currency_code: "USD", value: "15.00" },
          },
        ],
      });

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("MALFORMED_RESPONSE");
      expect(result.message).toContain("requires exactly 1 unit");
    });
  });

  describe("Transient Errors & Fail-Closed Safety", () => {
    it("handles PayPalTimeoutError safely without altering purchase status", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockRejectedValueOnce(
        new PayPalTimeoutError("PayPal Sandbox getOrder timed out")
      );

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("UNVERIFIED_TRANSIENT");

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });

    it("handles PayPalNetworkError safely without altering purchase status", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockRejectedValueOnce(
        new PayPalNetworkError("Socket connection reset by peer")
      );

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("UNVERIFIED_TRANSIENT");

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });

    it("handles PayPalApiError safely with structured outcome and no state change", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockRejectedValueOnce(
        new PayPalApiError(500, "INTERNAL_SERVER_ERROR", "PayPal server error")
      );

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("UNVERIFIED_API_ERROR");

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });
  });

  describe("Access Control & Authorization", () => {
    it("refuses verification if caller does not own the purchase", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      const intruder: Actor = { kind: "user", userId: "intruder_user" };

      await expect(
        verificationService.verifyPayment(purchaseId, intruder)
      ).rejects.toThrow(ForbiddenError);

      expect(mockPayPalClient.getOrder).not.toHaveBeenCalled();
    });

    it("throws WorkflowError if purchase has no payment attempt", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      // Order not created yet (purchase in APPROVED)

      await expect(
        verificationService.verifyPayment(purchaseId, userActor)
      ).rejects.toThrow(WorkflowError);

      expect(mockPayPalClient.getOrder).not.toHaveBeenCalled();
    });
  });

  describe("Route Integration", () => {
    it("workflowService.verifyPayPalPayment delegates cleanly to PaymentVerificationService", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      });

      const result = await workflowService.verifyPayPalPayment(purchaseId, userActor);

      expect(result.outcome).toBe("BUYER_APPROVED");
      expect(result.verified).toBe(true);
      expect(result.internalStatus).toBe("BUYER_APPROVED");
    });
  });

  describe("Phase 16.3: Legacy CAPTURE Intent Isolation and Non-Capture Safety", () => {
    it("isolates and rejects an order reporting intent CAPTURE even if status is APPROVED", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      // Simulate legacy order created with intent: "CAPTURE"
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "APPROVED",
        intent: "CAPTURE" as unknown as "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      });

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("MISMATCH_REJECTED");
      expect(result.approvalUrl).toBeNull();
      expect(result.message).toContain("incompatible with Plinthly's authorization-only lifecycle");
      expect(result.details?.legacyOrderIncompatible).toBe(true);

      // Verify internal purchase status was NOT advanced to BUYER_APPROVED
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");

      // Verify payment attempt records INTENT_INCOMPATIBLE
      const attempt = current?.paymentAttempts.find((a) => a.paypalOrderId === "PAYPAL_ORDER_VERIFY_1");
      expect(attempt?.verifiedStatus).toBe("INTENT_INCOMPATIBLE");
      expect(attempt?.failureReason).toBe("legacy_capture_intent_incompatible");
    });

    it("isolates and rejects an order reporting intent CAPTURE when status is PAYER_ACTION_REQUIRED", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      // Simulate legacy order 2BR08855VR6881230 in PAYER_ACTION_REQUIRED
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "PAYER_ACTION_REQUIRED",
        intent: "CAPTURE" as unknown as "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      });

      const result = await verificationService.verifyPayment(purchaseId, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("MISMATCH_REJECTED");
      expect(result.approvalUrl).toBeNull();
      expect(result.details?.legacyOrderIncompatible).toBe(true);

      // Verify purchase remains in ORDER_CREATED
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });

    it("confirmBuyerApproval throws incompatible_payment_intent for legacy CAPTURE orders", async () => {
      const { purchaseId } = await setupApprovedPurchase(8500);
      await workflowService.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_VERIFY_1",
        status: "APPROVED",
        intent: "CAPTURE" as unknown as "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "85.00" },
          },
        ],
      });

      await expect(
        workflowService.confirmBuyerApproval(purchaseId, userActor, {
          paypalOrderId: "PAYPAL_ORDER_VERIFY_1",
        })
      ).rejects.toThrowError(/incompatible with Plinthly's authorization-only workflow/);

      // Verify internal purchase status was NOT advanced
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });
  });
});
