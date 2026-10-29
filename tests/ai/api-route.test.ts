import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as decomposeRoute } from "../../app/api/ai/decompose/route";
import { setActorResolver, ServerActorResolver } from "../../lib/workflow/auth";
import { InMemoryPurchaseRepository, setPurchaseRepository } from "../../lib/workflow/repository";
import { PurchaseWorkflowService, setPurchaseWorkflowService } from "../../lib/workflow/service";
import * as parserModule from "../../lib/ai/intent-parser";
import { DecomposedIntent } from "../../lib/ai/types";

describe("POST /api/ai/decompose", () => {
  const originalEnv = { ...process.env };
  let repo: InMemoryPurchaseRepository;
  let service: PurchaseWorkflowService;

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
    repo = new InMemoryPurchaseRepository();
    service = new PurchaseWorkflowService(repo);
    setPurchaseRepository(repo);
    setPurchaseWorkflowService(service);
  });

  afterEach(() => {
    setNodeEnv(originalEnv.NODE_ENV);
    if (originalEnv.AUTH_MODE !== undefined) {
      process.env.AUTH_MODE = originalEnv.AUTH_MODE;
    } else {
      delete process.env.AUTH_MODE;
    }
    vi.restoreAllMocks();
  });

  it("returns 200 with structured decomposed intent on valid request", async () => {
    const mockIntent: DecomposedIntent = {
      budgetCents: 150000,
      currency: "USD",
      quantity: 1,
      productKeywords: "Dell XPS 15",
      requirements: [
        {
          key: "ram",
          expectedValue: "32GB",
          description: "32GB RAM",
        },
      ],
      unresolvedAmbiguities: [],
      confidenceEstimate: {
        score: 0.9,
        label: "high",
        notes: "Clear intent",
        isCalibratedProbability: false,
      },
    };

    vi.spyOn(parserModule, "decomposePurchaseIntent").mockResolvedValueOnce(mockIntent);

    const req = new Request("http://localhost:3000/api/ai/decompose", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-actor-id": "buyer_test_user",
      },
      body: JSON.stringify({
        prompt: "I need a Dell XPS 15 laptop with 32GB RAM for under $1500",
      }),
    });

    const res = await decomposeRoute(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.budgetCents).toBe(150000);
    expect(body.data.productKeywords).toBe("Dell XPS 15");
    expect(body.data.confidenceEstimate.isCalibratedProbability).toBe(false);
  });

  it("fails closed with 401 when unauthenticated in production", async () => {
    setNodeEnv("production");
    setActorResolver(new ServerActorResolver("production"));

    const req = new Request("http://localhost:3000/api/ai/decompose", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Client tries to spoof actor header
        "x-actor-id": "spoofed_user",
      },
      body: JSON.stringify({
        prompt: "I need a laptop",
      }),
    });

    const res = await decomposeRoute(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 400 when JSON body is malformed", async () => {
    const req = new Request("http://localhost:3000/api/ai/decompose", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-actor-id": "buyer_test_user",
      },
      body: "not-json{",
    });

    const res = await decomposeRoute(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  it("returns 400 when prompt is empty or too short", async () => {
    const req = new Request("http://localhost:3000/api/ai/decompose", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-actor-id": "buyer_test_user",
      },
      body: JSON.stringify({ prompt: "ab" }),
    });

    const res = await decomposeRoute(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation_error");
  });

  it("returns 400 when prompt exceeds maximum bounded length", async () => {
    const req = new Request("http://localhost:3000/api/ai/decompose", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-actor-id": "buyer_test_user",
      },
      body: JSON.stringify({ prompt: "x".repeat(2001) }),
    });

    const res = await decomposeRoute(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation_error");
  });

  it("returns 503 when Gemini API key is missing", async () => {
    delete process.env.GEMINI_API_KEY;

    const req = new Request("http://localhost:3000/api/ai/decompose", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-actor-id": "buyer_test_user",
      },
      body: JSON.stringify({ prompt: "I need a Dell XPS laptop" }),
    });

    const res = await decomposeRoute(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("ai_not_configured");
  });

  it("guarantees model output NEVER automatically creates purchases or alters records", async () => {
    const mockIntent: DecomposedIntent = {
      budgetCents: 150000,
      currency: "USD",
      quantity: 1,
      productKeywords: "Dell XPS 15",
      requirements: [{ key: "condition", expectedValue: "new" }],
      unresolvedAmbiguities: [],
      confidenceEstimate: {
        score: 0.99,
        label: "high",
        notes: "test",
        isCalibratedProbability: false,
      },
    };

    vi.spyOn(parserModule, "decomposePurchaseIntent").mockResolvedValueOnce(mockIntent);

    const req = new Request("http://localhost:3000/api/ai/decompose", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-actor-id": "buyer_test_user",
      },
      body: JSON.stringify({ prompt: "Buy a new Dell XPS 15 for $1500" }),
    });

    const createSpy = vi.spyOn(repo, "createPurchase");

    const res = await decomposeRoute(req);
    expect(res.status).toBe(200);

    // Verify repository was never touched: zero purchases created
    expect(createSpy).not.toHaveBeenCalled();
    expect((repo as unknown as { purchases: Map<string, unknown> }).purchases.size).toBe(0);
  });
});
