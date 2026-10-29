import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServerActorResolver, assertPurchaseAccess } from "../../lib/workflow/auth";
import { UnauthorizedError, ForbiddenError } from "../../lib/workflow/errors";
import { RateLimiter, enforceRateLimit } from "../../lib/workflow/rate-limiter";
import { redactSensitiveData, getLogger } from "../../lib/workflow/logger";
import { GET as healthCheckGet } from "../../app/api/health/route";
import * as repo from "../../lib/workflow/repository";
import { MultiProviderShippingQuoteAdapter } from "../../lib/discovery/shipping-quote";

describe("Phase 12D: Production Readiness & Security Invariants", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("1. Fail-Closed Authentication & Judge Access", () => {
    it("fails closed in production mode when no credentials are provided", async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      process.env.JUDGE_ACCESS_SECRET = "super-secret-judge-key-12345678";

      const resolver = new ServerActorResolver("production");
      const req = new Request("http://localhost:3000/api/purchases");
      const result = await resolver.resolveActor(req);

      expect(result.ok).toBe(false);
      expect(result.error).toBeInstanceOf(UnauthorizedError);
      expect(result.actor).toBeUndefined();
    });

    it("strictly rejects untrusted x-actor-id headers in production mode", async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      process.env.JUDGE_ACCESS_SECRET = "super-secret-judge-key-12345678";

      const resolver = new ServerActorResolver("production");
      const req = new Request("http://localhost:3000/api/purchases", {
        headers: {
          "x-actor-id": "spoofed_admin",
          "x-actor-kind": "user",
        },
      });
      const result = await resolver.resolveActor(req);

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("Authentication required");
      expect(result.actor).toBeUndefined();
    });

    it("authenticates valid judge token via Authorization Bearer and assigns isolated session", async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      process.env.JUDGE_ACCESS_SECRET = "super-secret-judge-key-12345678";

      const resolver = new ServerActorResolver("production");
      const req = new Request("http://localhost:3000/api/purchases", {
        headers: {
          authorization: "Bearer super-secret-judge-key-12345678",
          "x-judge-session-id": "panel_alpha",
        },
      });
      const result = await resolver.resolveActor(req);

      expect(result.ok).toBe(true);
      expect(result.actor).toEqual({
        kind: "user",
        userId: "judge_panel_alpha",
      });
    });

    it("authenticates valid judge token via x-judge-access-token header", async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      process.env.JUDGE_ACCESS_SECRET = "super-secret-judge-key-12345678";

      const resolver = new ServerActorResolver("production");
      const req = new Request("http://localhost:3000/api/purchases", {
        headers: {
          "x-judge-access-token": "super-secret-judge-key-12345678",
        },
      });
      const result = await resolver.resolveActor(req);

      expect(result.ok).toBe(true);
      expect(result.actor).toEqual({
        kind: "user",
        userId: "judge_evaluator",
      });
    });

    it("rejects invalid or tampered judge credentials with UnauthorizedError", async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      process.env.JUDGE_ACCESS_SECRET = "super-secret-judge-key-12345678";

      const resolver = new ServerActorResolver("production");
      const req = new Request("http://localhost:3000/api/purchases", {
        headers: {
          authorization: "Bearer invalid-tampered-token",
        },
      });
      const result = await resolver.resolveActor(req);

      expect(result.ok).toBe(false);
      expect(result.error).toBeInstanceOf(UnauthorizedError);
    });
  });

  describe("2. Server-Side Authorization & Anti-Tampering", () => {
    it("blocks cross-user purchase access with ForbiddenError", () => {
      expect(() => {
        assertPurchaseAccess(
          { kind: "user", userId: "judge_alpha" },
          "judge_beta",
          "approve"
        );
      }).toThrow(ForbiddenError);
    });

    it("permits owner to access their own purchase", () => {
      expect(() => {
        assertPurchaseAccess(
          { kind: "user", userId: "judge_alpha" },
          "judge_alpha",
          "approve"
        );
      }).not.toThrow();
    });

    it("strictly blocks system actors from approving purchases", () => {
      expect(() => {
        assertPurchaseAccess(
          { kind: "system", component: "ai_orchestrator" },
          "user_123",
          "approve"
        );
      }).toThrow(ForbiddenError);
    });
  });

  describe("3. Rate Limiter Behavior", () => {
    it("permits requests within burst limit and injects X-RateLimit headers", () => {
      const limiter = new RateLimiter({ windowMs: 10000, maxRequests: 3 });
      const req = new Request("http://localhost:3000/api/ai/decompose", {
        headers: { "x-forwarded-for": "203.0.113.1" },
      });

      const res1 = enforceRateLimit(limiter, req, "test_api");
      expect(res1.ok).toBe(true);
      if (res1.ok) {
        expect(res1.headers["X-RateLimit-Limit"]).toBe("3");
        expect(res1.headers["X-RateLimit-Remaining"]).toBe("2");
      }

      const res2 = enforceRateLimit(limiter, req, "test_api");
      expect(res2.ok).toBe(true);
      if (res2.ok) {
        expect(res2.headers["X-RateLimit-Remaining"]).toBe("1");
      }

      const res3 = enforceRateLimit(limiter, req, "test_api");
      expect(res3.ok).toBe(true);
      if (res3.ok) {
        expect(res3.headers["X-RateLimit-Remaining"]).toBe("0");
      }

      // 4th request must be rejected with 429
      const res4 = enforceRateLimit(limiter, req, "test_api");
      expect(res4.ok).toBe(false);
      if (!res4.ok) {
        expect(res4.response.status).toBe(429);
        expect(res4.response.headers.get("Retry-After")).toBeDefined();
      }
    });

    it("resets capacity after sliding window expiry", () => {
      const limiter = new RateLimiter({ windowMs: 50, maxRequests: 1 });
      const now = Date.now();

      const r1 = limiter.check("client_a", now);
      expect(r1.allowed).toBe(true);

      const r2 = limiter.check("client_a", now + 10);
      expect(r2.allowed).toBe(false);

      const r3 = limiter.check("client_a", now + 60);
      expect(r3.allowed).toBe(true);
    });
  });

  describe("4. Health Check Endpoint Readiness", () => {
    it("returns HTTP 200 { status: 'healthy' } when database responds", async () => {
      vi.spyOn(repo, "pingDatabase").mockResolvedValueOnce(true);

      const res = await healthCheckGet();
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("healthy");
      expect(body.timestamp).toBeDefined();
      // Ensure zero internal secrets or diagnostics are exposed
      expect(body.database).toBeUndefined();
      expect(body.connectionString).toBeUndefined();
      expect(body.password).toBeUndefined();
    });

    it("returns HTTP 503 { status: 'unhealthy' } when database is unavailable", async () => {
      vi.spyOn(repo, "pingDatabase").mockResolvedValueOnce(false);

      const res = await healthCheckGet();
      expect(res.status).toBe(503);

      const body = await res.json();
      expect(body.status).toBe("unhealthy");
      expect(body.timestamp).toBeDefined();
      // Ensure error diagnostics remain masked
      expect(body.error).toBeUndefined();
      expect(body.stack).toBeUndefined();
    });
  });

  describe("5. Structured Logging & Secret Redaction", () => {
    it("redacts sensitive fields from objects and strings", () => {
      const payload = {
        userId: "user_42",
        apiKey: "AIzaSyABC123456789",
        clientSecret: "paypal_secret_val",
        authHeader: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token123",
        creditCard: "4111222233334444",
        nested: {
          token: "secret_token_val",
          safeField: "safe_data",
        },
      };

      const redacted = redactSensitiveData(payload) as Record<string, unknown>;
      expect(redacted.userId).toBe("user_42");
      expect(redacted.apiKey).toBe("[REDACTED]");
      expect(redacted.clientSecret).toBe("[REDACTED]");
      expect(redacted.creditCard).toBe("[REDACTED]");
      expect(redacted.authHeader).toBe("Bearer [REDACTED]");
      expect((redacted.nested as Record<string, unknown>).token).toBe("[REDACTED]");
      expect((redacted.nested as Record<string, unknown>).safeField).toBe("safe_data");
    });

    it("logs structured entries with correlation IDs", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = getLogger(undefined, { correlationId: "req_test_123" });

      logger.info("purchase_evaluated", { purchaseId: "pur_100", amountCents: 5000 });

      expect(consoleSpy).toHaveBeenCalledOnce();
      const loggedJson = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(loggedJson.event).toBe("purchase_evaluated");
      expect(loggedJson.correlationId).toBe("req_test_123");
      expect(loggedJson.meta.purchaseId).toBe("pur_100");
    });
  });

  describe("6. Shipping Adapters Fail-Closed Configuration", () => {
    it("fails closed with status 'unavailable' when partner credentials are absent", async () => {
      delete process.env.BESTBUY_COMMERCE_API_KEY;
      delete process.env.BESTBUY_API_KEY;
      delete process.env.SHOPIFY_STORE_DOMAIN;
      delete process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;

      const multi = new MultiProviderShippingQuoteAdapter();

      const quoteResult = await multi.getShippingQuote({
        candidate: {
          externalId: "cand_shopify_1",
          merchantName: "shopify store",
          merchantUrl: "https://myshop.myshopify.com/products/item1",
          unitPriceCents: 5000,
          quantity: 1,
          currency: "USD",
        },
        canonicalProductUrl: "https://myshop.myshopify.com/products/item1",
        destination: { postalCode: "94103", country: "US", deliveryMethodPreference: "standard_ground" },
        now: new Date(),
      });

      expect(quoteResult.status).toBe("unavailable");
      // Must NOT return $0.00 or free shipping
      expect((quoteResult as { amountCents?: number }).amountCents).toBeUndefined();
    });
  });
});
