import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("OpenAPI 3.1 Specification Contract Verification", () => {
  const openApiPath = path.resolve(__dirname, "../../docs/openapi.yaml");

  it("exists and is non-empty", () => {
    expect(fs.existsSync(openApiPath)).toBe(true);
    const content = fs.readFileSync(openApiPath, "utf-8");
    expect(content.length).toBeGreaterThan(1000);
    expect(content).toContain("openapi: 3.1.0");
  });

  it("defines all active operational route endpoints", () => {
    const content = fs.readFileSync(openApiPath, "utf-8");
    const requiredEndpoints = [
      "/api/health",
      "/api/ai/decompose",
      "/api/discovery/search",
      "/api/purchases",
      "/api/purchases/{id}",
      "/api/purchases/{id}/evaluate",
      "/api/purchases/{id}/approve",
      "/api/purchases/{id}/orders",
      "/api/purchases/{id}/paypal/verify",
      "/api/purchases/{id}/audit",
    ];

    for (const ep of requiredEndpoints) {
      expect(content).toContain(ep);
    }
  });

  it("documents security schemes and authentication headers", () => {
    const content = fs.readFileSync(openApiPath, "utf-8");
    expect(content).toContain("ActorHeaderAuth");
    expect(content).toContain("DemoTokenAuth");
    expect(content).toContain("x-actor-id");
  });

  it("documents standardized error response schemas", () => {
    const content = fs.readFileSync(openApiPath, "utf-8");
    expect(content).toContain("ErrorResponse:");
    expect(content).toContain("PurchaseAggregate:");
    expect(content).toContain("DecompositionResult:");
  });
});
