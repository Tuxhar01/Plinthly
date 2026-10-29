import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PayPalSandboxClient,
  loadPayPalConfigFromEnv,
  validateSandboxBaseUrl,
  validateAppBaseUrl,
  DEFAULT_APP_BASE_URL,
  validateSandboxApprovalUrl,
  extractSafeApprovalLink,
  ALLOWED_SANDBOX_CHECKOUT_HOSTS,
} from "../../lib/paypal/client";
import {
  PayPalConfigError,
  PayPalTimeoutError,
  PayPalNetworkError,
  PayPalApiError,
} from "../../lib/paypal/types";

describe("PayPalSandboxClient - Configuration, Authentication & Network Hygiene", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.PAYPAL_API_BASE_URL;
    delete process.env.APP_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("Configuration and Sandbox-Only Enforcement", () => {
    it("fails closed when PAYPAL_CLIENT_ID is missing", () => {
      process.env.PAYPAL_CLIENT_SECRET = "secret_123";
      expect(() => loadPayPalConfigFromEnv()).toThrow(PayPalConfigError);
      expect(() => loadPayPalConfigFromEnv()).toThrow(/PAYPAL_CLIENT_ID/);
    });

    it("fails closed when PAYPAL_CLIENT_SECRET is missing", () => {
      process.env.PAYPAL_CLIENT_ID = "client_123";
      expect(() => loadPayPalConfigFromEnv()).toThrow(PayPalConfigError);
      expect(() => loadPayPalConfigFromEnv()).toThrow(/PAYPAL_CLIENT_SECRET/);
    });

    it("strictly prohibits production PayPal endpoints and fails closed", () => {
      expect(() => validateSandboxBaseUrl("https://api-m.paypal.com")).toThrow(PayPalConfigError);
      expect(() => validateSandboxBaseUrl("https://api.paypal.com")).toThrow(PayPalConfigError);
      expect(() => validateSandboxBaseUrl("https://paypal.com")).toThrow(PayPalConfigError);
    });

    it("strictly prohibits insecure HTTP endpoints", () => {
      expect(() => validateSandboxBaseUrl("http://api-m.sandbox.paypal.com")).toThrow(PayPalConfigError);
      expect(() => validateSandboxBaseUrl("http://api-m.sandbox.paypal.com")).toThrow(/HTTPS/);
    });

    it("accepts valid Sandbox HTTPS endpoints", () => {
      const valid = validateSandboxBaseUrl("https://api-m.sandbox.paypal.com");
      expect(valid).toBe("https://api-m.sandbox.paypal.com");
    });

    it("validates application base URL: accepts loopback HTTP and HTTPS endpoints", () => {
      expect(validateAppBaseUrl("http://127.0.0.1:3001")).toBe("http://127.0.0.1:3001");
      expect(validateAppBaseUrl("http://localhost:3001")).toBe("http://localhost:3001");
      expect(validateAppBaseUrl("https://127.0.0.1:3001")).toBe("https://127.0.0.1:3001");
      expect(validateAppBaseUrl("https://localhost:3001")).toBe("https://localhost:3001");
    });

    it("validates application base URL: accepts non-loopback HTTPS endpoints", () => {
      expect(validateAppBaseUrl("https://assurance.plinthly.com")).toBe("https://assurance.plinthly.com");
      expect(validateAppBaseUrl("https://staging.plinthly.dev:8443")).toBe("https://staging.plinthly.dev:8443");
    });

    it("fails closed when application base URL is missing, empty, or whitespace", () => {
      expect(() => validateAppBaseUrl("")).toThrow(PayPalConfigError);
      expect(() => validateAppBaseUrl("")).toThrow(/Missing required application base URL/);
      expect(() => validateAppBaseUrl(undefined)).toThrow(PayPalConfigError);
      expect(() => validateAppBaseUrl("   ")).toThrow(PayPalConfigError);
    });

    it("fails closed when application base URL is malformed", () => {
      expect(() => validateAppBaseUrl("not-a-valid-url")).toThrow(PayPalConfigError);
      expect(() => validateAppBaseUrl("not-a-valid-url")).toThrow(/Must be a valid URL/);
    });

    it("fails closed when non-loopback base URL uses insecure HTTP", () => {
      expect(() => validateAppBaseUrl("http://assurance.plinthly.com")).toThrow(PayPalConfigError);
      expect(() => validateAppBaseUrl("http://assurance.plinthly.com")).toThrow(/HTTPS/);
      expect(() => validateAppBaseUrl("http://192.168.1.50:3001")).toThrow(PayPalConfigError);
    });

    it("fails closed when application base URL uses non-HTTP/HTTPS protocol", () => {
      expect(() => validateAppBaseUrl("ftp://127.0.0.1:3001")).toThrow(PayPalConfigError);
      expect(() => validateAppBaseUrl("javascript:alert(1)")).toThrow(PayPalConfigError);
    });

    it("loadPayPalConfigFromEnv defaults to loopback http://127.0.0.1:3001 when APP_BASE_URL is not set", () => {
      process.env.PAYPAL_CLIENT_ID = "c_id";
      process.env.PAYPAL_CLIENT_SECRET = "c_sec";
      delete process.env.APP_BASE_URL;

      const cfg = loadPayPalConfigFromEnv();
      expect(cfg.appBaseUrl).toBe(DEFAULT_APP_BASE_URL);
    });

    it("loadPayPalConfigFromEnv uses configured APP_BASE_URL when valid", () => {
      process.env.PAYPAL_CLIENT_ID = "c_id";
      process.env.PAYPAL_CLIENT_SECRET = "c_sec";
      process.env.APP_BASE_URL = "https://custom.plinthly.dev";

      const cfg = loadPayPalConfigFromEnv();
      expect(cfg.appBaseUrl).toBe("https://custom.plinthly.dev");
    });

    it("loadPayPalConfigFromEnv fails closed when APP_BASE_URL is explicitly empty or invalid", () => {
      process.env.PAYPAL_CLIENT_ID = "c_id";
      process.env.PAYPAL_CLIENT_SECRET = "c_sec";
      process.env.APP_BASE_URL = "";
      expect(() => loadPayPalConfigFromEnv()).toThrow(PayPalConfigError);

      process.env.APP_BASE_URL = "http://insecure.example.com";
      expect(() => loadPayPalConfigFromEnv()).toThrow(PayPalConfigError);
    });
  });

  describe("OAuth Token Acquisition & In-Memory Caching", () => {
    it("acquires OAuth token with Basic Auth client credentials", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "mock_access_token_123",
          token_type: "Bearer",
          expires_in: 32400,
        }),
      });

      const client = new PayPalSandboxClient(
        {
          clientId: "test_client_id",
          clientSecret: "test_client_secret",
          baseUrl: "https://api-m.sandbox.paypal.com",
        },
        mockFetch as unknown as typeof fetch
      );

      const token = await client.getAccessToken();
      expect(token).toBe("mock_access_token_123");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
      expect(calledOpts.method).toBe("POST");

      const expectedBasic = Buffer.from("test_client_id:test_client_secret").toString("base64");
      expect(calledOpts.headers.Authorization).toBe(`Basic ${expectedBasic}`);
      expect(calledOpts.body).toBe("grant_type=client_credentials");
    });

    it("caches access token and reuses it without issuing duplicate token requests", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "cached_token_abc",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      });

      const client = new PayPalSandboxClient(
        {
          clientId: "test_client",
          clientSecret: "test_secret",
          baseUrl: "https://api-m.sandbox.paypal.com",
        },
        mockFetch as unknown as typeof fetch
      );

      const token1 = await client.getAccessToken();
      const token2 = await client.getAccessToken();

      expect(token1).toBe("cached_token_abc");
      expect(token2).toBe("cached_token_abc");
      expect(mockFetch).toHaveBeenCalledTimes(1); // Cached!
    });

    it("clears cached token when 401 Unauthorized is encountered", async () => {
      let callCount = 0;
      const mockFetch = vi.fn(async (url: string) => {
        callCount++;
        if (url.includes("/oauth2/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: `token_call_${callCount}`,
              expires_in: 3600,
            }),
          };
        }
        // Order endpoint returns 401
        return {
          ok: false,
          status: 401,
          json: async () => ({ name: "AUTHENTICATION_FAILURE", message: "Token expired" }),
        };
      });

      const client = new PayPalSandboxClient(
        {
          clientId: "c",
          clientSecret: "s",
          baseUrl: "https://api-m.sandbox.paypal.com",
        },
        mockFetch as unknown as typeof fetch
      );

      await expect(
        client.createOrder({
          referenceId: "pur_1",
          amountCents: 5000,
          currency: "USD",
          idempotencyKey: "idem_1",
        })
      ).rejects.toThrow(PayPalApiError);

      // Verify that next call requests a fresh token because cache was cleared
      const freshToken = await client.getAccessToken();
      expect(freshToken).toMatch(/^token_call_/);
    });
  });

  describe("Order Creation & Retrieval", () => {
    it("creates an order with correct idempotency key and purchase units", async () => {
      const mockFetch = vi.fn(async (url: string, opts: RequestInit) => {
        if (url.includes("/oauth2/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "valid_token", expires_in: 3600 }),
          };
        }

        const body = JSON.parse(opts.body as string);
        expect(body.intent).toBe("AUTHORIZE");
        expect(body.purchase_units[0].reference_id).toBe("pur_order_test");
        expect(body.purchase_units[0].amount.value).toBe("120.50");
        expect(body.purchase_units[0].amount.currency_code).toBe("USD");

        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "5O190127TN364715T",
            status: "CREATED",
            links: [
              {
                href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
                rel: "approve",
                method: "GET",
              },
            ],
          }),
        };
      });

      const client = new PayPalSandboxClient(
        {
          clientId: "c",
          clientSecret: "s",
          baseUrl: "https://api-m.sandbox.paypal.com",
        },
        mockFetch as unknown as typeof fetch
      );

      const order = await client.createOrder({
        referenceId: "pur_order_test",
        amountCents: 12050,
        currency: "USD",
        idempotencyKey: "client_idem_req_1",
      });

      expect(order.id).toBe("5O190127TN364715T");
      expect(order.status).toBe("CREATED");
      expect(order.links).toHaveLength(1);
    });

    it("creates an order with payment_source.paypal.experience_context including return_url, cancel_url, and user_action CONTINUE", async () => {
      let capturedPayload: {
        payment_source?: {
          paypal?: {
            experience_context?: {
              user_action?: string;
              return_url?: string;
              cancel_url?: string;
              shipping_preference?: string;
              brand_name?: string;
            };
          };
        };
      } | null = null;
      const mockFetch = vi.fn(async (url: string, opts: RequestInit) => {
        if (url.includes("/oauth2/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "valid_token", expires_in: 3600 }),
          };
        }

        capturedPayload = JSON.parse(opts.body as string);
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "ORDER_EXPERIENCE_TEST_1",
            status: "CREATED",
            links: [
              {
                href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER_EXPERIENCE_TEST_1",
                rel: "approve",
                method: "GET",
              },
            ],
          }),
        };
      });

      const client = new PayPalSandboxClient(
        {
          clientId: "c",
          clientSecret: "s",
          baseUrl: "https://api-m.sandbox.paypal.com",
          appBaseUrl: "http://127.0.0.1:3001",
        },
        mockFetch as unknown as typeof fetch
      );

      const order = await client.createOrder({
        referenceId: "pur_ctx_test_1",
        amountCents: 13000,
        currency: "USD",
        idempotencyKey: "client_idem_ctx_1",
      });

      expect(order.id).toBe("ORDER_EXPERIENCE_TEST_1");
      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload!.payment_source).toBeDefined();
      expect(capturedPayload!.payment_source?.paypal).toBeDefined();

      const expCtx = capturedPayload!.payment_source?.paypal?.experience_context;
      expect(expCtx).toBeDefined();
      expect(expCtx?.user_action).toBe("CONTINUE");
      expect(expCtx?.return_url).toBe("http://127.0.0.1:3001/api/purchases/pur_ctx_test_1/paypal/return");
      expect(expCtx?.cancel_url).toBe("http://127.0.0.1:3001/api/purchases/pur_ctx_test_1/paypal/cancel");
      expect(expCtx?.shipping_preference).toBe("NO_SHIPPING");
      expect(expCtx?.brand_name).toBe("Plinthly Purchase Assurance");

      // Verify that callback URLs do NOT point to synthetic product merchant URL
      expect(expCtx?.return_url).not.toContain("merchant.com");
      expect(expCtx?.cancel_url).not.toContain("merchant.com");

      // Verify no capture endpoint is called
      expect(mockFetch.mock.calls.every(([calledUrl]) => !calledUrl.includes("/capture"))).toBe(true);
    });

    it("creates an order with custom appBaseUrl and respects explicit returnUrl and cancelUrl if provided", async () => {
      let capturedPayload: {
        payment_source?: {
          paypal?: {
            experience_context?: {
              user_action?: string;
              return_url?: string;
              cancel_url?: string;
            };
          };
        };
      } | null = null;
      const mockFetch = vi.fn(async (url: string, opts: RequestInit) => {
        if (url.includes("/oauth2/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "valid_token", expires_in: 3600 }),
          };
        }

        capturedPayload = JSON.parse(opts.body as string);
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "ORDER_CUSTOM_URL_TEST",
            status: "CREATED",
            links: [],
          }),
        };
      });

      const client = new PayPalSandboxClient(
        {
          clientId: "c",
          clientSecret: "s",
          baseUrl: "https://api-m.sandbox.paypal.com",
          appBaseUrl: "https://custom.plinthly.dev",
        },
        mockFetch as unknown as typeof fetch
      );

      await client.createOrder({
        referenceId: "pur_custom",
        amountCents: 5000,
        currency: "USD",
        idempotencyKey: "client_idem_custom",
        returnUrl: "https://custom.plinthly.dev/custom-return",
        cancelUrl: "https://custom.plinthly.dev/custom-cancel",
      });

      expect(capturedPayload).not.toBeNull();
      const expCtx = capturedPayload!.payment_source?.paypal?.experience_context;
      expect(expCtx).toBeDefined();
      expect(expCtx?.return_url).toBe("https://custom.plinthly.dev/custom-return");
      expect(expCtx?.cancel_url).toBe("https://custom.plinthly.dev/custom-cancel");
      expect(expCtx?.user_action).toBe("CONTINUE");
    });

    it("retrieves order details independently from PayPal Sandbox", async () => {
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/oauth2/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "valid_token", expires_in: 3600 }),
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "5O190127TN364715T",
            status: "APPROVED",
            intent: "AUTHORIZE",
            purchase_units: [
              {
                reference_id: "pur_100",
                amount: { currency_code: "USD", value: "85.00" },
              },
            ],
          }),
        };
      });

      const client = new PayPalSandboxClient(
        {
          clientId: "c",
          clientSecret: "s",
          baseUrl: "https://api-m.sandbox.paypal.com",
        },
        mockFetch as unknown as typeof fetch
      );

      const retrieved = await client.getOrder("5O190127TN364715T");
      expect(retrieved.id).toBe("5O190127TN364715T");
      expect(retrieved.status).toBe("APPROVED");
      expect(retrieved.purchase_units[0].amount?.value).toBe("85.00");
    });
  });

  describe("Network Error and Timeout Handling", () => {
    it("translates fetch timeout to PayPalTimeoutError", async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        const timeoutError = new Error("The operation was aborted due to timeout");
        timeoutError.name = "TimeoutError";
        throw timeoutError;
      });

      const client = new PayPalSandboxClient(
        {
          clientId: "c",
          clientSecret: "s",
          baseUrl: "https://api-m.sandbox.paypal.com",
          timeoutMs: 100,
        },
        mockFetch as unknown as typeof fetch
      );

      await expect(client.getAccessToken()).rejects.toThrow(PayPalTimeoutError);
    });

    it("translates network failure to PayPalNetworkError without exposing secrets", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const client = new PayPalSandboxClient(
        {
          clientId: "super_secret_client_id",
          clientSecret: "super_secret_key",
          baseUrl: "https://api-m.sandbox.paypal.com",
        },
        mockFetch as unknown as typeof fetch
      );

      try {
        await client.getAccessToken();
        expect.unreachable();
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(PayPalNetworkError);
        const msg = (err as Error).message;
        expect(msg).not.toContain("super_secret_key");
        expect(msg).not.toContain("super_secret_client_id");
      }
    });
  });

  describe("Sandbox Checkout Approval URL Validation & Relation Extraction", () => {
    it("exports ALLOWED_SANDBOX_CHECKOUT_HOSTS containing official sandbox checkout hosts", () => {
      expect(ALLOWED_SANDBOX_CHECKOUT_HOSTS).toContain("sandbox.paypal.com");
      expect(ALLOWED_SANDBOX_CHECKOUT_HOSTS).toContain("www.sandbox.paypal.com");
      expect(ALLOWED_SANDBOX_CHECKOUT_HOSTS).toHaveLength(2);
    });

    it("accepts valid HTTPS URLs from explicitly allowlisted PayPal Sandbox hosts", () => {
      expect(
        validateSandboxApprovalUrl("https://sandbox.paypal.com/checkoutnow?token=ORDER123")
      ).toBe("https://sandbox.paypal.com/checkoutnow?token=ORDER123");

      expect(
        validateSandboxApprovalUrl("https://www.sandbox.paypal.com/checkoutnow?token=ORDER123")
      ).toBe("https://www.sandbox.paypal.com/checkoutnow?token=ORDER123");
    });

    it("rejects non-HTTPS URLs", () => {
      expect(validateSandboxApprovalUrl("http://sandbox.paypal.com/checkoutnow?token=123")).toBeNull();
      expect(validateSandboxApprovalUrl("ftp://sandbox.paypal.com/checkoutnow?token=123")).toBeNull();
    });

    it("rejects deceptive lookalike, unexpected, or subdomain-hijacking hosts", () => {
      expect(validateSandboxApprovalUrl("https://sandbox.paypal.com.evil.com/checkoutnow")).toBeNull();
      expect(validateSandboxApprovalUrl("https://evil-sandbox.paypal.com/checkoutnow")).toBeNull();
      expect(validateSandboxApprovalUrl("https://notpaypal.com/checkoutnow")).toBeNull();
      // Production host is also rejected for Sandbox checkout
      expect(validateSandboxApprovalUrl("https://www.paypal.com/checkoutnow?token=123")).toBeNull();
    });

    it("rejects URLs containing user credentials", () => {
      expect(validateSandboxApprovalUrl("https://user:pass@sandbox.paypal.com/checkoutnow?token=123")).toBeNull();
    });

    it("rejects null, undefined, empty, or malformed strings", () => {
      expect(validateSandboxApprovalUrl(null)).toBeNull();
      expect(validateSandboxApprovalUrl(undefined)).toBeNull();
      expect(validateSandboxApprovalUrl("")).toBeNull();
      expect(validateSandboxApprovalUrl("   ")).toBeNull();
      expect(validateSandboxApprovalUrl("not a valid url")).toBeNull();
    });

    it("extractSafeApprovalLink extracts valid URL from rel === 'approve'", () => {
      const links = [
        { rel: "self", href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/123" },
        { rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=123" },
      ];
      expect(extractSafeApprovalLink(links)).toBe("https://www.sandbox.paypal.com/checkoutnow?token=123");
    });

    it("extractSafeApprovalLink extracts valid URL from rel === 'payer-action'", () => {
      const links = [
        { rel: "self", href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/456" },
        { rel: "payer-action", href: "https://sandbox.paypal.com/checkoutnow?token=456" },
      ];
      expect(extractSafeApprovalLink(links)).toBe("https://sandbox.paypal.com/checkoutnow?token=456");
    });

    it("extractSafeApprovalLink prioritizes or matches either valid rel and rejects invalid URLs", () => {
      const linksWithInvalid = [
        { rel: "payer-action", href: "https://evil.com/phish?token=789" },
      ];
      expect(extractSafeApprovalLink(linksWithInvalid)).toBeNull();

      expect(extractSafeApprovalLink(null)).toBeNull();
      expect(extractSafeApprovalLink([])).toBeNull();
      expect(extractSafeApprovalLink([{ rel: "self", href: "https://api.sandbox.paypal.com" }])).toBeNull();
    });
  });
});
