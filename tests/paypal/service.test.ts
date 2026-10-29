import { describe, it, expect, beforeEach, vi } from "vitest";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import {
  ApprovalIntegrityError,
  IllegalTransitionError,
  ForbiddenError,
  WorkflowError,
} from "../../lib/workflow/errors";
import { PayPalUnknownOutcomeError, PayPalTimeoutError } from "../../lib/paypal/types";
import { Actor } from "../../lib/state/types";

describe("Phase 5 - PayPal Sandbox Order Creation & Buyer Approval Workflow", () => {
  let repo: InMemoryPurchaseRepository;
  let service: PurchaseWorkflowService;
  let mockPayPalClient: PayPalSandboxClient;

  const userActor: Actor = { kind: "user", userId: "usr_buyer_paypal" };
  const sysActor: Actor = { kind: "system", component: "sys_evaluator" };

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();

    mockPayPalClient = {
      getAccessToken: vi.fn().mockResolvedValue("mock_token"),
      createOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL_ORDER_12345",
        status: "CREATED",
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_ORDER_12345",
            rel: "approve",
            method: "GET",
          },
        ],
      }),
      getOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL_ORDER_12345",
        status: "APPROVED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: "any_ref",
            amount: { currency_code: "USD", value: "75.00" },
          },
        ],
      }),
      clearCachedToken: vi.fn(),
    } as unknown as PayPalSandboxClient;

    service = new PurchaseWorkflowService(repo, mockPayPalClient);
  });

  /**
   * Helper to set up an APPROVED purchase with selected candidate and active approval.
   */
  async function setupApprovedPurchase(totalCents: number = 7500): Promise<{
    purchaseId: string;
    snapshotHash: string;
    approvalId: string;
  }> {
    const purchase = await service.createPurchase(
      {
        budgetCents: 10000,
        currency: "USD",
        requirements: ["spec_a"],
      },
      userActor
    );

    const now = new Date("2026-10-20T12:00:00Z");
    const evalRes = await service.evaluatePurchaseCandidate(
      purchase.id,
      {
        rawCandidate: {
          externalId: "ext_item_1",
          title: "Standard Widget",
          merchantName: "Acme",
          merchantUrl: "https://acme.com/w",
          unitPriceCents: totalCents,
          quantity: 1,
          shippingCents: 0,
          currency: "USD",
          availability: "IN_STOCK",
        },
        rawObservations: [
          {
            requirementKey: "spec_a",
            value: "pass",
            status: "supports",
            sourceUrl: "https://acme.com/w",
            sourceType: "feed",
            capturedAt: now.toISOString(),
          },
        ],
        requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
      },
      sysActor,
      now
    );

    const approvalRes = await service.approvePurchase(
      purchase.id,
      {
        expectedSnapshotHash: evalRes.snapshotHash,
      },
      userActor,
      now
    );

    return {
      purchaseId: purchase.id,
      snapshotHash: evalRes.snapshotHash,
      approvalId: approvalRes.approvalId,
    };
  }

  describe("Server-Side Order Creation", () => {
    it("creates a PayPal order derived strictly from approved server terms", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);

      const orderResult = await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "test_idem_order_1",
      });

      expect(orderResult.purchaseId).toBe(purchaseId);
      expect(orderResult.paypalOrderId).toBe("PAYPAL_ORDER_12345");
      expect(orderResult.status).toBe("ORDER_CREATED");
      expect(orderResult.amountCents).toBe(7500);
      expect(orderResult.currency).toBe("USD");
      expect(orderResult.approvalUrl).toContain("checkoutnow");

      // Verify PayPal client received the exact server-calculated amount
      expect(mockPayPalClient.createOrder).toHaveBeenCalledTimes(1);
      const callArg = vi.mocked(mockPayPalClient.createOrder).mock.calls[0][0];
      expect(callArg.amountCents).toBe(7500);
      expect(callArg.currency).toBe("USD");
      expect(callArg.referenceId).toBe(purchaseId);

      // Verify repository updated to ORDER_CREATED
      const updated = await repo.getPurchaseById(purchaseId);
      expect(updated?.purchase.status).toBe("ORDER_CREATED");
      expect(updated?.purchase.version).toBe(4);

      // Verify audit event order_created exists
      const audit = await repo.getAuditHistory(purchaseId);
      const orderEvent = audit.find((e) => e.type === "order_created");
      expect(orderEvent).toBeDefined();
      expect((orderEvent?.payload as Record<string, unknown>).paypalOrderId).toBe("PAYPAL_ORDER_12345");
    });

    it("refuses to create order without active approval", async () => {
      // Create unapproved purchase in REQUIREMENTS_CONFIRMED
      const purchase = await service.createPurchase(
        { budgetCents: 5000, currency: "USD", requirements: ["req"] },
        userActor
      );

      await expect(
        service.createPayPalOrder(purchase.id, userActor)
      ).rejects.toThrow(IllegalTransitionError);

      expect(mockPayPalClient.createOrder).not.toHaveBeenCalled();
    });

    it("refuses order creation if caller is unauthorized", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);
      const intruderActor: Actor = { kind: "user", userId: "intruder_user" };

      await expect(
        service.createPayPalOrder(purchaseId, intruderActor)
      ).rejects.toThrow(ForbiddenError);

      expect(mockPayPalClient.createOrder).not.toHaveBeenCalled();
    });

    it("refuses order creation if approval snapshot has drifted", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);

      // Tamper stored approval snapshotHash in repository to simulate drift
      const repoWithApprovals = repo as unknown as { approvals: Map<string, Array<{ snapshotHash: string }>> };
      const approvals = repoWithApprovals.approvals.get(purchaseId);
      if (approvals && approvals[0]) {
        approvals[0].snapshotHash = "tampered_snapshot_hash";
      }

      await expect(
        service.createPayPalOrder(purchaseId, userActor)
      ).rejects.toThrow(ApprovalIntegrityError);

      expect(mockPayPalClient.createOrder).not.toHaveBeenCalled();
    });

    it("replays existing order without calling PayPal createOrder again when status is ORDER_CREATED", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);

      // First call creates the order
      const res1 = await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "replay_idem_key",
      });
      expect(res1.status).toBe("ORDER_CREATED");
      expect(mockPayPalClient.createOrder).toHaveBeenCalledTimes(1);

      // Second call replays the existing order
      const res2 = await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "replay_idem_key",
      });
      expect(res2.paypalOrderId).toBe(res1.paypalOrderId);
      expect(res2.status).toBe("ORDER_CREATED");
      expect(mockPayPalClient.createOrder).toHaveBeenCalledTimes(1); // Not called a second time!
    });

    it("retains recoverable state and throws PayPalUnknownOutcomeError on timeout", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);

      // Simulate network timeout on PayPal createOrder
      vi.mocked(mockPayPalClient.createOrder).mockRejectedValueOnce(
        new PayPalTimeoutError("PayPal Sandbox order creation timed out")
      );

      await expect(
        service.createPayPalOrder(purchaseId, userActor, { idempotencyKey: "timeout_test_key" })
      ).rejects.toThrow(PayPalUnknownOutcomeError);

      // Verify purchase remains in APPROVED state so retry can reconcile safely
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("APPROVED");
    });
  });

  describe("Buyer Approval Verification", () => {
    it("advances state to BUYER_APPROVED only after independently verifying PayPal status", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);
      await service.createPayPalOrder(purchaseId, userActor);

      // Mock PayPal getOrder returns APPROVED status
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_12345",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "75.00" },
          },
        ],
      });

      const confirmed = await service.confirmBuyerApproval(purchaseId, userActor, {
        paypalOrderId: "PAYPAL_ORDER_12345",
      });

      expect(confirmed.status).toBe("BUYER_APPROVED");
      expect(confirmed.id).toBe(purchaseId);

      // Verify repository updated to BUYER_APPROVED
      const updated = await repo.getPurchaseById(purchaseId);
      expect(updated?.purchase.status).toBe("BUYER_APPROVED");
      expect(updated?.purchase.version).toBe(5);

      const liveAttempt = updated?.paymentAttempts.find((a) => a.paypalOrderId === "PAYPAL_ORDER_12345");
      expect(liveAttempt?.verifiedStatus).toBe("APPROVED");

      // Verify audit event buyer_approved exists
      const audit = await repo.getAuditHistory(purchaseId);
      const buyerApprovedEvent = audit.find((e) => e.type === "buyer_approved");
      expect(buyerApprovedEvent).toBeDefined();
    });

    it("rejects buyer approval if PayPal order has not yet been approved by buyer in Sandbox", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);
      await service.createPayPalOrder(purchaseId, userActor);

      // Mock PayPal getOrder returns CREATED (buyer hasn't completed approval in PayPal UI)
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_12345",
        status: "CREATED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "75.00" },
          },
        ],
      });

      await expect(
        service.confirmBuyerApproval(purchaseId, userActor, {
          paypalOrderId: "PAYPAL_ORDER_12345",
        })
      ).rejects.toThrow(WorkflowError);

      // State remains ORDER_CREATED
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });

    it("rejects buyer approval when caller provides mismatched order ID", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);
      await service.createPayPalOrder(purchaseId, userActor);

      await expect(
        service.confirmBuyerApproval(purchaseId, userActor, {
          paypalOrderId: "MISMATCHED_ORDER_ID_999",
        })
      ).rejects.toThrow("Supplied PayPal order ID");

      expect(mockPayPalClient.getOrder).not.toHaveBeenCalled();
    });

    it("rejects buyer approval if PayPal order amount does not match approved terms", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);
      await service.createPayPalOrder(purchaseId, userActor);

      // Mock PayPal getOrder returns mismatched amount (e.g. 50.00 instead of 75.00)
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_12345",
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

      await expect(
        service.confirmBuyerApproval(purchaseId, userActor, {
          paypalOrderId: "PAYPAL_ORDER_12345",
        })
      ).rejects.toThrow(/does not match approved total/i);

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
    });

    it("replays response idempotently if already BUYER_APPROVED without advancing state further", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);
      await service.createPayPalOrder(purchaseId, userActor);

      vi.mocked(mockPayPalClient.getOrder).mockResolvedValue({
        id: "PAYPAL_ORDER_12345",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "75.00" },
          },
        ],
      });

      // Confirm 1
      const res1 = await service.confirmBuyerApproval(purchaseId, userActor);
      expect(res1.status).toBe("BUYER_APPROVED");

      // Confirm 2 (retry)
      const res2 = await service.confirmBuyerApproval(purchaseId, userActor);
      expect(res2.status).toBe("BUYER_APPROVED");
      expect(res2.id).toBe(res1.id);
      expect(res2.version).toBe(res1.version); // Not incremented again!
    });

    it("rejects buyer approval when PayPal order has empty or missing purchase_units", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);
      await service.createPayPalOrder(purchaseId, userActor);

      // Mock order with empty purchase_units array
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_12345",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [],
      });

      await expect(
        service.confirmBuyerApproval(purchaseId, userActor, {
          paypalOrderId: "PAYPAL_ORDER_12345",
        })
      ).rejects.toThrow(/does not contain any purchase units/i);

      // Verify state was not advanced and no buyer_approved audit event was created
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
      const audit = await repo.getAuditHistory(purchaseId);
      expect(audit.some((e) => e.type === "buyer_approved")).toBe(false);
    });

    it("rejects buyer approval when PayPal order contains multiple purchase units", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);
      await service.createPayPalOrder(purchaseId, userActor);

      // Mock order with multiple purchase units
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_12345",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "75.00" },
          },
          {
            reference_id: "second_unit",
            amount: { currency_code: "USD", value: "10.00" },
          },
        ],
      });

      await expect(
        service.confirmBuyerApproval(purchaseId, userActor, {
          paypalOrderId: "PAYPAL_ORDER_12345",
        })
      ).rejects.toThrow(/requires exactly 1 purchase unit/i);

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
      const audit = await repo.getAuditHistory(purchaseId);
      expect(audit.some((e) => e.type === "buyer_approved")).toBe(false);
    });

    it("rejects buyer approval when purchase unit reference_id is missing", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);
      await service.createPayPalOrder(purchaseId, userActor);

      // Mock order without reference_id
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_12345",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: "",
            amount: { currency_code: "USD", value: "75.00" },
          },
        ],
      });

      await expect(
        service.confirmBuyerApproval(purchaseId, userActor, {
          paypalOrderId: "PAYPAL_ORDER_12345",
        })
      ).rejects.toThrow(/missing required reference_id/i);

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
      const audit = await repo.getAuditHistory(purchaseId);
      expect(audit.some((e) => e.type === "buyer_approved")).toBe(false);
    });

    it("rejects buyer approval when purchase unit reference_id does not match internal purchase ID", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);
      await service.createPayPalOrder(purchaseId, userActor);

      // Mock order with mismatched reference_id
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "PAYPAL_ORDER_12345",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: "different_purchase_id_999",
            amount: { currency_code: "USD", value: "75.00" },
          },
        ],
      });

      await expect(
        service.confirmBuyerApproval(purchaseId, userActor, {
          paypalOrderId: "PAYPAL_ORDER_12345",
        })
      ).rejects.toThrow(/does not match internal purchase id/i);

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
      const audit = await repo.getAuditHistory(purchaseId);
      expect(audit.some((e) => e.type === "buyer_approved")).toBe(false);
    });

    it("rejects buyer approval when remote order id does not match payment attempt order id", async () => {
      const { purchaseId } = await setupApprovedPurchase(7500);
      await service.createPayPalOrder(purchaseId, userActor);

      // Mock order with mismatched remote id
      vi.mocked(mockPayPalClient.getOrder).mockResolvedValueOnce({
        id: "DIFFERENT_REMOTE_ORDER_ID",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "75.00" },
          },
        ],
      });

      await expect(
        service.confirmBuyerApproval(purchaseId, userActor, {
          paypalOrderId: "PAYPAL_ORDER_12345",
        })
      ).rejects.toThrow(/does not match active payment attempt order id/i);

      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).toBe("ORDER_CREATED");
      const audit = await repo.getAuditHistory(purchaseId);
      expect(audit.some((e) => e.type === "buyer_approved")).toBe(false);
    });
  });
});
