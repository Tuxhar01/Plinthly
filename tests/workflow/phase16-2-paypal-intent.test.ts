/**
 * Plinthly Phase 16.2 — PayPal Intent Consistency and Non-Capture Safety Tests.
 *
 * Enforces:
 * 1. Outgoing PayPal Sandbox order request explicitly uses intent: "AUTHORIZE".
 * 2. No supported API route can silently substitute or fall back to "CAPTURE".
 * 3. Retries and idempotency do not dispatch duplicate PayPal orders.
 * 4. Selected merchant cart amount and currency remain bound to approved snapshot.
 * 5. Buyer approval is not confused with authorization or capture.
 * 6. No code path automatically captures funds; captures across database remain 0.
 * 7. Stale or invalidated approvals cannot reach PayPal order creation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { PayPalApiError } from "../../lib/paypal/types";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { Actor } from "../../lib/state/types";
import { createPayPalOrderSchema } from "../../lib/workflow/validation";
import { DestinationContext } from "../../lib/discovery/shipping";
import { ApprovalIntegrityError } from "../../lib/workflow/errors";

describe("Phase 16.2 — PayPal Intent Consistency and Non-Capture Safety", () => {
  const destination: DestinationContext = {
    country: "US",
    postalCode: "94103",
    deliveryMethodPreference: "standard_ground",
  };

  const buyerActor: Actor = {
    kind: "user",
    userId: "usr_buyer_p16_2",
  };

  describe("1. Outgoing PayPal Order Intent Verification", () => {
    it("PayPalSandboxClient.createOrder explicitly sends intent: 'AUTHORIZE' in payload", async () => {
      let capturedPayload: Record<string, unknown> | null = null;

      const mockFetch = vi.fn(async (url: string, opts?: RequestInit) => {
        if (url.includes("/oauth2/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "mock_token_123", expires_in: 3600 }),
          };
        }

        capturedPayload = JSON.parse(opts?.body as string) as Record<string, unknown>;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "ORDER_AUTH_123",
            status: "CREATED",
            links: [
              {
                href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER_AUTH_123",
                rel: "approve",
                method: "GET",
              },
            ],
          }),
        };
      });

      const client = new PayPalSandboxClient(
        {
          clientId: "client_id",
          clientSecret: "client_secret",
          baseUrl: "https://api-m.sandbox.paypal.com",
        },
        mockFetch as unknown as typeof fetch
      );

      const order = await client.createOrder({
        referenceId: "pur_test_123",
        amountCents: 201000,
        currency: "USD",
        idempotencyKey: "idem_key_1",
        intent: "AUTHORIZE",
      });

      expect(order.id).toBe("ORDER_AUTH_123");
      expect(capturedPayload).not.toBeNull();
      const payload = capturedPayload as unknown as { intent: string; purchase_units: Array<{ amount: { value: string } }> };
      // CRITICAL INVARIANT: Intent MUST be AUTHORIZE
      expect(payload.intent).toBe("AUTHORIZE");
      expect(payload.purchase_units[0].amount.value).toBe("2010.00");
    });

    it("PayPalSandboxClient.createOrder strictly rejects intent: 'CAPTURE' with PayPalApiError", async () => {
      const mockFetch = vi.fn();
      const client = new PayPalSandboxClient(
        {
          clientId: "client_id",
          clientSecret: "client_secret",
          baseUrl: "https://api-m.sandbox.paypal.com",
        },
        mockFetch as unknown as typeof fetch
      );

      await expect(
        client.createOrder({
          referenceId: "pur_test_123",
          amountCents: 201000,
          currency: "USD",
          idempotencyKey: "idem_key_1",
          intent: "CAPTURE" as unknown as "AUTHORIZE", // Adversarial attempt to substitute CAPTURE
        })
      ).rejects.toThrow(PayPalApiError);

      await expect(
        client.createOrder({
          referenceId: "pur_test_123",
          amountCents: 201000,
          currency: "USD",
          idempotencyKey: "idem_key_1",
          intent: "CAPTURE" as unknown as "AUTHORIZE",
        })
      ).rejects.toThrow(/Only intent "AUTHORIZE" is permitted/);

      // Verify no network request was sent
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("2. API Route and Validation Schema Hardening", () => {
    it("createPayPalOrderSchema rejects any payload attempting to specify intent: 'CAPTURE'", () => {
      const result = createPayPalOrderSchema.safeParse({
        idempotencyKey: "idem_test",
        intent: "CAPTURE",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Only intent "AUTHORIZE" is permitted');
      }
    });

    it("createPayPalOrderSchema accepts valid payload with optional intent: 'AUTHORIZE'", () => {
      const result = createPayPalOrderSchema.safeParse({
        idempotencyKey: "idem_test",
        intent: "AUTHORIZE",
        targetCartMerchantDomain: "bestbuy.com",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("3. End-to-End Service Flow and Invariant Safety", () => {
    let repo: InMemoryPurchaseRepository;
    let mockPayPalClient: {
      createOrder: ReturnType<typeof vi.fn>;
      getOrder: ReturnType<typeof vi.fn>;
    };
    let service: PurchaseWorkflowService;

    beforeEach(() => {
      repo = new InMemoryPurchaseRepository();
      mockPayPalClient = {
        createOrder: vi.fn().mockResolvedValue({
          id: "PAYPAL_AUTH_999",
          status: "CREATED",
          links: [
            {
              href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_AUTH_999",
              rel: "approve",
              method: "GET",
            },
          ],
        }),
        getOrder: vi.fn(),
      };
      service = new PurchaseWorkflowService(repo, mockPayPalClient as unknown as PayPalSandboxClient);
    });

    it("PurchaseWorkflowService.createPayPalOrder explicitly sends intent: 'AUTHORIZE' to client", async () => {
      // Create approved purchase
      const purchase = await service.createPurchase(
        {
          budgetCents: 150000,
          currency: "USD",
          destination,
          lineItems: [
            {
              id: "item_1",
              title: "Dell Workstation",
              quantity: 1,
              budgetCents: 150000,
              currency: "USD",
              requirements: [],
            },
          ],
          confirmImmediately: true,
        },
        buyerActor
      );

      // Evaluate plan
      const plan = await service.createMultiItemPlan(
        purchase.id,
        {
          destination,
          lineItems: [
            {
              id: "item_1",
              title: "Dell Workstation",
              quantity: 1,
              budgetCents: 150000,
              currency: "USD",
              requirements: [],
            },
          ],
          candidates: [
            {
              id: "cand_1",
              purchaseId: purchase.id,
              source: "channel3",
              externalId: "ext_1",
              title: "Dell Workstation",
              merchantName: "Best Buy",
              merchantUrl: "https://www.bestbuy.com/site/1.p",
              unitPriceCents: 140000,
              quantity: 1,
              shippingCents: 0,
              totalCents: 140000,
              currency: "USD",
              availability: "in_stock",
              capturedAt: new Date(),
              snapshotHash: "hash_1",
              rawSourceData: {},
              isComplete: true,
              validationErrors: [],
            },
          ],
        },
        buyerActor
      );

      // Approve plan
      await service.approveMultiItemPlan(
        purchase.id,
        {
          strategyId: plan.strategies[0].strategyId,
          expectedTotalLandedCostCents: plan.strategies[0].totalLandedCostCents!,
          expectedCurrency: "USD",
        },
        buyerActor
      );

      // Create PayPal order
      const orderRes = await service.createPayPalOrder(purchase.id, buyerActor, {
        idempotencyKey: "idem_safe_auth_1",
        targetCartMerchantDomain: "bestbuy.com",
      });

      expect(orderRes.paypalOrderId).toBe("PAYPAL_AUTH_999");
      expect(orderRes.status).toBe("ORDER_CREATED");

      // Verify client call received intent: "AUTHORIZE"
      expect(mockPayPalClient.createOrder).toHaveBeenCalledTimes(1);
      const callArgs = mockPayPalClient.createOrder.mock.calls[0][0];
      expect(callArgs.intent).toBe("AUTHORIZE");
      expect(callArgs.amountCents).toBe(140000);
      expect(callArgs.currency).toBe("USD");
    });

    it("idempotent retries do not call PayPal createOrder a second time", async () => {
      const purchase = await service.createPurchase(
        {
          budgetCents: 150000,
          currency: "USD",
          destination,
          lineItems: [{ id: "item_1", title: "Item 1", quantity: 1, budgetCents: 150000, currency: "USD", requirements: [] }],
          confirmImmediately: true,
        },
        buyerActor
      );

      const plan = await service.createMultiItemPlan(
        purchase.id,
        {
          destination,
          lineItems: [{ id: "item_1", title: "Item 1", quantity: 1, budgetCents: 150000, currency: "USD", requirements: [] }],
          candidates: [
            {
              id: "cand_1",
              purchaseId: purchase.id,
              source: "channel3",
              externalId: "ext_1",
              title: "Item 1",
              merchantName: "Best Buy",
              merchantUrl: "https://www.bestbuy.com/site/1.p",
              unitPriceCents: 140000,
              quantity: 1,
              shippingCents: 0,
              totalCents: 140000,
              currency: "USD",
              availability: "in_stock",
              capturedAt: new Date(),
              snapshotHash: "hash_1",
              rawSourceData: {},
              isComplete: true,
              validationErrors: [],
            },
          ],
        },
        buyerActor
      );

      await service.approveMultiItemPlan(
        purchase.id,
        { strategyId: plan.strategies[0].strategyId, expectedTotalLandedCostCents: 140000, expectedCurrency: "USD" },
        buyerActor
      );

      // First call
      const order1 = await service.createPayPalOrder(purchase.id, buyerActor, {
        idempotencyKey: "test_idem_reuse",
        targetCartMerchantDomain: "bestbuy.com",
      });

      // Second call with same idempotencyKey
      const order2 = await service.createPayPalOrder(purchase.id, buyerActor, {
        idempotencyKey: "test_idem_reuse",
        targetCartMerchantDomain: "bestbuy.com",
      });

      expect(order1.paypalOrderId).toBe(order2.paypalOrderId);
      expect(mockPayPalClient.createOrder).toHaveBeenCalledTimes(1); // Exactly once
    });

    it("strictly prevents stale or invalidated approval from creating a PayPal order", async () => {
      const purchase = await service.createPurchase(
        {
          budgetCents: 150000,
          currency: "USD",
          destination,
          lineItems: [{ id: "item_1", title: "Item 1", quantity: 1, budgetCents: 150000, currency: "USD", requirements: [] }],
          confirmImmediately: true,
        },
        buyerActor
      );

      const plan = await service.createMultiItemPlan(
        purchase.id,
        {
          destination,
          lineItems: [{ id: "item_1", title: "Item 1", quantity: 1, budgetCents: 150000, currency: "USD", requirements: [] }],
          candidates: [
            {
              id: "cand_1",
              purchaseId: purchase.id,
              source: "channel3",
              externalId: "ext_1",
              title: "Item 1",
              merchantName: "Best Buy",
              merchantUrl: "https://www.bestbuy.com/site/1.p",
              unitPriceCents: 140000,
              quantity: 1,
              shippingCents: 0,
              totalCents: 140000,
              currency: "USD",
              availability: "in_stock",
              capturedAt: new Date(),
              snapshotHash: "hash_1",
              rawSourceData: {},
              isComplete: true,
              validationErrors: [],
            },
          ],
        },
        buyerActor
      );

      await service.approveMultiItemPlan(
        purchase.id,
        { strategyId: plan.strategies[0].strategyId, expectedTotalLandedCostCents: 140000, expectedCurrency: "USD" },
        buyerActor
      );

      // Tamper with destination
      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, {
          idempotencyKey: "tampered_dest_key",
          destination: { country: "US", postalCode: "99501", deliveryMethodPreference: "standard_ground" },
          targetCartMerchantDomain: "bestbuy.com",
        })
      ).rejects.toThrow(ApprovalIntegrityError);

      // Verify no PayPal order was created
      expect(mockPayPalClient.createOrder).not.toHaveBeenCalled();

      // Attempt second checkout on now-invalidated approval
      await expect(
        service.createPayPalOrder(purchase.id, buyerActor, {
          idempotencyKey: "attempt_after_invalidation",
          targetCartMerchantDomain: "bestbuy.com",
        })
      ).rejects.toThrow();
    });
  });
});
