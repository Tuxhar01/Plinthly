import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST as handlePurchaseDiscover } from "../../app/api/purchases/[id]/discover/route";
import { POST as handleGlobalDiscover } from "../../app/api/discovery/search/route";
import { setActorResolver, ServerActorResolver } from "../../lib/workflow/auth";
import * as channel3Client from "../../lib/channel3/client";
import { Channel3SearchResponse } from "../../lib/channel3/types";

describe("Discovery API Routes — Authentication and Contract Validation", () => {
  const originalEnv = { ...process.env };

  const setNodeEnv = (val: string | undefined) => {
    const env = process.env as Record<string, string | undefined>;
    if (val === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = val;
    }
  };

  beforeEach(() => {
    setNodeEnv("development");
    process.env.AUTH_MODE = "local_demo";
    setActorResolver(new ServerActorResolver("local_demo"));
  });

  afterEach(() => {
    setNodeEnv(originalEnv.NODE_ENV);
    if (originalEnv.AUTH_MODE !== undefined) {
      process.env.AUTH_MODE = originalEnv.AUTH_MODE;
    } else {
      delete process.env.AUTH_MODE;
    }
    if (originalEnv.CHANNEL3_API_KEY !== undefined) {
      process.env.CHANNEL3_API_KEY = originalEnv.CHANNEL3_API_KEY;
    } else {
      delete process.env.CHANNEL3_API_KEY;
    }
    setActorResolver(new ServerActorResolver());
    vi.restoreAllMocks();
  });

  const mockSuccessResponse: Channel3SearchResponse = {
    products: [
      {
        id: "prod_1",
        title: "Test Keyboard",
        offers: [
          {
            url: "https://example.com/item1",
            domain: "example.com",
            price: { price: 89.99, currency: "USD" },
            availability: "InStock",
          },
        ],
      },
    ],
  };

  describe("POST /api/purchases/[id]/discover", () => {
    it("returns 401 when unauthenticated in production mode", async () => {
      setActorResolver(new ServerActorResolver("production"));

      const request = new Request("http://localhost:3000/api/purchases/pur_1/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "laptop" }),
      });

      const response = await handlePurchaseDiscover(request, {
        params: Promise.resolve({ id: "pur_1" }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("unauthorized");
    });

    it("returns 400 when query is empty or whitespace", async () => {
      const request = new Request("http://localhost:3000/api/purchases/pur_1/discover", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-actor-id": "buyer_1",
          "x-actor-kind": "user",
        },
        body: JSON.stringify({ query: "   " }),
      });

      const response = await handlePurchaseDiscover(request, {
        params: Promise.resolve({ id: "pur_1" }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("validation_error");
    });

    it("returns 503 with CHANNEL3_NOT_CONFIGURED when API key is missing", async () => {
      delete process.env.CHANNEL3_API_KEY;

      const request = new Request("http://localhost:3000/api/purchases/pur_1/discover", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-actor-id": "buyer_1",
          "x-actor-kind": "user",
        },
        body: JSON.stringify({ query: "laptop" }),
      });

      const response = await handlePurchaseDiscover(request, {
        params: Promise.resolve({ id: "pur_1" }),
      });

      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error.code).toBe("CHANNEL3_NOT_CONFIGURED");
    });

    it("returns 200 with normalized discovery result when authenticated and upstream succeeds", async () => {
      process.env.CHANNEL3_API_KEY = "dummy_test_key";
      vi.spyOn(channel3Client, "searchChannel3").mockResolvedValue(mockSuccessResponse);

      const request = new Request("http://localhost:3000/api/purchases/pur_1/discover", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-actor-id": "buyer_1",
          "x-actor-kind": "user",
        },
        body: JSON.stringify({
          query: "keyboard",
          constraints: {
            maxBudgetCents: 10000,
            currency: "USD",
          },
        }),
      });

      const response = await handlePurchaseDiscover(request, {
        params: Promise.resolve({ id: "pur_1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe("success");
      expect(data.candidates).toHaveLength(1);
      expect(data.candidates[0].merchantName).toBe("example.com");
      expect(data.candidates[0].unitPriceCents).toBe(8999);
    });
  });

  describe("POST /api/discovery/search", () => {
    it("returns 401 when unauthenticated in production mode", async () => {
      setActorResolver(new ServerActorResolver("production"));

      const request = new Request("http://localhost:3000/api/discovery/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "laptop", purchaseId: "pur_1" }),
      });

      const response = await handleGlobalDiscover(request);
      expect(response.status).toBe(401);
    });

    it("returns 400 when purchaseId is missing", async () => {
      const request = new Request("http://localhost:3000/api/discovery/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-actor-id": "buyer_1",
          "x-actor-kind": "user",
        },
        body: JSON.stringify({ query: "laptop" }), // Missing purchaseId
      });

      const response = await handleGlobalDiscover(request);
      expect(response.status).toBe(400);
    });

    it("returns 200 with discovery results when authenticated", async () => {
      process.env.CHANNEL3_API_KEY = "dummy_test_key";
      vi.spyOn(channel3Client, "searchChannel3").mockResolvedValue(mockSuccessResponse);

      const request = new Request("http://localhost:3000/api/discovery/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-actor-id": "buyer_1",
          "x-actor-kind": "user",
        },
        body: JSON.stringify({ query: "keyboard", purchaseId: "pur_99" }),
      });

      const response = await handleGlobalDiscover(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe("success");
      expect(data.candidates).toHaveLength(1);
    });
  });
});
