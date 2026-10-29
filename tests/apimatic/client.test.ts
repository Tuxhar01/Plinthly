import { describe, it, expect, vi } from "vitest";
import { PlinthlyApiClient } from "../../lib/apimatic/client";

describe("APIMatic Integration: Typed Agent Client with Least Privilege", () => {
  it("probes health endpoint successfully", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "healthy", timestamp: "2026-10-23T10:00:00Z" }),
    });

    const client = new PlinthlyApiClient({
      baseUrl: "http://localhost:3000",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const health = await client.checkHealth();
    expect(health.status).toBe("healthy");
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/api/health", expect.any(Object));
  });

  it("submits AI decomposition request with headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { budgetCents: 10000 } }),
    });

    const client = new PlinthlyApiClient({
      baseUrl: "http://localhost:3000",
      actorId: "agent_decomposer",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const res = await client.decompose("I need a keyboard under $100");
    expect(res).toEqual({ ok: true, data: { budgetCents: 10000 } });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/ai/decompose",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: "I need a keyboard under $100" }),
      })
    );
  });

  it("strictly enforces least privilege: blocks system actors from approving purchases", async () => {
    const mockFetch = vi.fn();
    const client = new PlinthlyApiClient({
      baseUrl: "http://localhost:3000",
      actorKind: "system",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      client.approve("pur_123", "cand_456", 1)
    ).rejects.toThrow("Security Invariant Violation: System actors cannot approve purchases");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("allows human user actors to submit approvals", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, status: "APPROVED" }),
    });

    const client = new PlinthlyApiClient({
      baseUrl: "http://localhost:3000",
      actorKind: "user",
      actorId: "human_buyer_1",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const res = await client.approve("pur_123", "cand_456", 1);
    expect(res).toEqual({ ok: true, status: "APPROVED" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/purchases/pur_123/approve",
      expect.objectContaining({
        method: "POST",
      })
    );
  });
});
