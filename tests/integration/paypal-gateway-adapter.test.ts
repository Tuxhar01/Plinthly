import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "crypto";
import {
  PayPalRestV2Client,
  PayPalClientError,
  PayPalCaptureResult,
} from "../../lib/paypal/paypal-rest-v2-client";
import {
  PayPalSandboxGatewayAdapter,
  PayPalProductionGatewayAdapter,
  MockPaymentGatewayClient,
  getPaymentGatewayClient,
  setPaymentGatewayClientForTesting,
  assertZeroLandedCostVariance,
  LandedCostVarianceError,
  GatewayCaptureInput,
  GatewayRefundInput,
} from "../../lib/workflow/payment-gateway-adapter";

describe("Stage 3 Phase 2 — PayPal Gateway Adapters & Zero-Variance Invariants", () => {
  beforeEach(() => {
    setPaymentGatewayClientForTesting(null);
    delete process.env.PAYPAL_MODE;
  });

  // PRV-01: PayPal Sandbox / Prod Adapter Decoupling
  describe("PRV-01: PayPal Sandbox / Production Adapter Decoupling", () => {
    it("binds PayPalSandboxGatewayAdapter when mode is explicitly sandbox", () => {
      const adapter = getPaymentGatewayClient({
        mode: "sandbox",
        clientId: "test_sandbox_client_id",
        clientSecret: "test_sandbox_client_secret",
      });

      expect(adapter).toBeInstanceOf(PayPalSandboxGatewayAdapter);
      expect((adapter as PayPalSandboxGatewayAdapter).isProduction).toBe(false);
      expect((adapter as PayPalSandboxGatewayAdapter).restClient.getBaseUrl()).toBe(
        "https://api-m.sandbox.paypal.com"
      );
    });

    it("binds PayPalSandboxGatewayAdapter when PAYPAL_MODE=sandbox environment variable is set", () => {
      process.env.PAYPAL_MODE = "sandbox";
      const adapter = getPaymentGatewayClient({
        clientId: "test_sandbox_client_id",
        clientSecret: "test_sandbox_client_secret",
      });

      expect(adapter).toBeInstanceOf(PayPalSandboxGatewayAdapter);
      expect((adapter as PayPalSandboxGatewayAdapter).isProduction).toBe(false);
    });

    it("binds PayPalProductionGatewayAdapter when mode is explicitly production with credentials", () => {
      const adapter = getPaymentGatewayClient({
        mode: "production",
        clientId: "prod_live_client_id_123",
        clientSecret: "prod_live_client_secret_xyz",
      });

      expect(adapter).toBeInstanceOf(PayPalProductionGatewayAdapter);
      expect((adapter as PayPalProductionGatewayAdapter).isProduction).toBe(true);
      expect((adapter as PayPalProductionGatewayAdapter).restClient.getBaseUrl()).toBe(
        "https://api-m.paypal.com"
      );
    });

    it("fails closed in production mode when client credentials are missing", () => {
      delete process.env.PAYPAL_CLIENT_ID;
      delete process.env.PAYPAL_CLIENT_SECRET;

      expect(() => {
        new PayPalProductionGatewayAdapter();
      }).toThrow(/ERR_PAYPAL_PRODUCTION_CONFIG/);
    });

    it("binds MockPaymentGatewayClient by default in non-production test mode", () => {
      const adapter = getPaymentGatewayClient({ mode: "mock" });
      expect(adapter).toBeInstanceOf(MockPaymentGatewayClient);
    });
  });

  // PRV-02: Landed-Cost Zero-Variance Invariant
  describe("PRV-02: Landed-Cost Zero-Variance Assertion (INV-302)", () => {
    it("passes when quoted subtotal + shipping + statutory tax exactly equals authorized total", () => {
      // 10000 + 1500 + 825 = 12325 cents ($123.25)
      expect(() => {
        assertZeroLandedCostVariance(10000, 1500, 825, 12325);
      }).not.toThrow();
    });

    it("fails closed with ERR_LANDED_COST_VARIANCE when variance is +1 cent ($0.01)", () => {
      expect(() => {
        // 10000 + 1500 + 825 = 12325, authorized is 12324 (1 cent variance)
        assertZeroLandedCostVariance(10000, 1500, 825, 12324);
      }).toThrow(LandedCostVarianceError);

      try {
        assertZeroLandedCostVariance(10000, 1500, 825, 12324);
      } catch (err: any) {
        expect(err.code).toBe("ERR_LANDED_COST_VARIANCE");
        expect(err.details.deltaCents).toBe("1");
      }
    });

    it("fails closed with ERR_LANDED_COST_VARIANCE when variance is -1 cent (-$0.01)", () => {
      expect(() => {
        // 10000 + 1500 + 825 = 12325, authorized is 12326 (-1 cent variance)
        assertZeroLandedCostVariance(10000, 1500, 825, 12326);
      }).toThrow(LandedCostVarianceError);

      try {
        assertZeroLandedCostVariance(10000, 1500, 825, 12326);
      } catch (err: any) {
        expect(err.code).toBe("ERR_LANDED_COST_VARIANCE");
        expect(err.details.deltaCents).toBe("-1");
      }
    });

    it("aborts capture before touching gateway when landed cost variance is detected", async () => {
      const mockFetch = vi.fn();
      const adapter = new PayPalSandboxGatewayAdapter({
        clientId: "sandbox_id",
        clientSecret: "sandbox_secret",
        fetchFn: mockFetch as any,
      });

      const captureInput: GatewayCaptureInput = {
        orderId: "5O190127TN364715T",
        cartId: "cart_uuid_001",
        amountCents: 10000,
        currency: "USD",
        payeeEmail: "merchant@example.com",
        idempotencyKey: crypto.randomUUID(),
        quotedSubtotalCents: 8000,
        quotedShippingCents: 1000,
        quotedTaxCents: 500, // Sum = 9500 != 10000
      };

      await expect(adapter.capturePayment(captureInput)).rejects.toThrow(LandedCostVarianceError);
      // Ensure zero HTTP calls were made
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // PRV-03: Capture Idempotency Header
  describe("PRV-03: Capture Idempotency Header (PayPal-Request-Id)", () => {
    it("sets PayPal-Request-Id header strictly to idempotencyKey (MerchantCartCapture.id)", async () => {
      const idempotencyKey = crypto.randomUUID();
      const orderId = "ORDER-CAPTURE-123";
      const headersSeen: Record<string, string> = {};

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "mock_token_abc", token_type: "Bearer", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.includes("/v2/checkout/orders")) {
          const headers = init?.headers as Record<string, string>;
          Object.assign(headersSeen, headers);
          return new Response(
            JSON.stringify({
              id: orderId,
              status: "COMPLETED",
              purchase_units: [
                {
                  payments: {
                    captures: [
                      {
                        id: "CAP-0987654321",
                        status: "COMPLETED",
                        amount: { value: "100.00", currency_code: "USD" },
                        payee: { email_address: "seller@store.com" },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("Not found", { status: 404 });
      });

      const adapter = new PayPalSandboxGatewayAdapter({
        clientId: "client_id",
        clientSecret: "client_secret",
        fetchFn: mockFetch as any,
      });

      const result = await adapter.capturePayment({
        orderId,
        cartId: "cart-001",
        amountCents: 10000,
        currency: "USD",
        payeeEmail: "seller@store.com",
        idempotencyKey,
        quotedSubtotalCents: 8500,
        quotedShippingCents: 1000,
        quotedTaxCents: 500,
      });

      expect(result.outcome).toBe("COMPLETED");
      expect(result.captureId).toBe("CAP-0987654321");
      expect(headersSeen["PayPal-Request-Id"]).toBe(idempotencyKey);
      expect(headersSeen["Authorization"]).toBe("Bearer mock_token_abc");
    });

    it("passes idempotencyKey in refund request header", async () => {
      const refundIdempotencyKey = crypto.randomUUID();
      const headersSeen: Record<string, string> = {};

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "mock_token_abc", token_type: "Bearer", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.includes("/v2/payments/captures")) {
          const headers = init?.headers as Record<string, string>;
          Object.assign(headersSeen, headers);
          return new Response(
            JSON.stringify({
              id: "REF-11223344",
              status: "COMPLETED",
              amount: { value: "25.00", currency_code: "USD" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("Not found", { status: 404 });
      });

      const adapter = new PayPalSandboxGatewayAdapter({
        clientId: "client_id",
        clientSecret: "client_secret",
        fetchFn: mockFetch as any,
      });

      const refundResult = await adapter.refundPayment({
        captureId: "CAP-0987654321",
        cartId: "cart-001",
        amountCents: 2500,
        currency: "USD",
        reason: "Customer requested return",
        idempotencyKey: refundIdempotencyKey,
      });

      expect(refundResult.outcome).toBe("COMPLETED");
      expect(refundResult.refundId).toBe("REF-11223344");
      expect(headersSeen["PayPal-Request-Id"]).toBe(refundIdempotencyKey);
    });
  });

  // PRV-04: Ambiguous Capture Timeout Handling
  describe("PRV-04: Ambiguous Capture Timeout Handling (INV-305)", () => {
    it("returns AMBIGUOUS_TIMEOUT when PayPal returns HTTP 504 Gateway Timeout", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "mock_token", token_type: "Bearer", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.includes("/v2/checkout/orders")) {
          return new Response("Gateway Timeout", { status: 504 });
        }

        return new Response("Not found", { status: 404 });
      });

      const adapter = new PayPalSandboxGatewayAdapter({
        clientId: "client_id",
        clientSecret: "client_secret",
        fetchFn: mockFetch as any,
      });

      const result = await adapter.capturePayment({
        orderId: "ORDER-TIMEOUT-504",
        cartId: "cart-002",
        amountCents: 5000,
        currency: "USD",
        payeeEmail: "seller@store.com",
        idempotencyKey: crypto.randomUUID(),
      });

      expect(result.outcome).toBe("AMBIGUOUS_TIMEOUT");
      expect(result.outcome).not.toBe("FAILED");
      expect(result.errorCode).toBe("GATEWAY_HTTP_504");
    });

    it("returns AMBIGUOUS_TIMEOUT when network socket aborts or times out in flight", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "mock_token", token_type: "Bearer", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.includes("/v2/checkout/orders")) {
          const err = new Error("Connection reset by peer");
          err.name = "AbortError";
          throw err;
        }

        return new Response("Not found", { status: 404 });
      });

      const adapter = new PayPalSandboxGatewayAdapter({
        clientId: "client_id",
        clientSecret: "client_secret",
        fetchFn: mockFetch as any,
      });

      const result = await adapter.capturePayment({
        orderId: "ORDER-ABORT",
        cartId: "cart-003",
        amountCents: 7500,
        currency: "USD",
        payeeEmail: "seller@store.com",
        idempotencyKey: crypto.randomUUID(),
      });

      expect(result.outcome).toBe("AMBIGUOUS_TIMEOUT");
      expect(result.outcome).not.toBe("FAILED");
      expect(result.errorCode).toBe("GATEWAY_TIMEOUT");
    });

    it("returns FAILED for explicit 422 UNPROCESSABLE_ENTITY payment failure", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "mock_token", token_type: "Bearer", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.includes("/v2/checkout/orders")) {
          return new Response(
            JSON.stringify({
              name: "UNPROCESSABLE_ENTITY",
              message: "The requested action could not be performed, semantically incorrect.",
              details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument presented was declined." }],
            }),
            { status: 422, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("Not found", { status: 404 });
      });

      const adapter = new PayPalSandboxGatewayAdapter({
        clientId: "client_id",
        clientSecret: "client_secret",
        fetchFn: mockFetch as any,
      });

      const result = await adapter.capturePayment({
        orderId: "ORDER-DECLINED",
        cartId: "cart-004",
        amountCents: 5000,
        currency: "USD",
        payeeEmail: "seller@store.com",
        idempotencyKey: crypto.randomUUID(),
      });

      expect(result.outcome).toBe("FAILED");
      expect(result.errorCode).toBe("UNPROCESSABLE_ENTITY");
      expect(result.errorMessage).toContain("declined");
    });
  });
});

