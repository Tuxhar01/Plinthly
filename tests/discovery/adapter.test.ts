import { describe, it, expect } from "vitest";
import { FixtureSourceAdapter } from "../../lib/discovery/fixture-adapter";

describe("Phase 3 Fixture Source Adapter Boundary", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const adapter = new FixtureSourceAdapter();

  it("declares explicit capabilities without masquerading as a live retailer", () => {
    const caps = adapter.getCapabilities();

    expect(caps.name).toBe("fixture_source_adapter");
    expect(caps.supportedCurrencies).toEqual(["USD"]);
    expect(caps.supportsStockStatus).toBe(true);
    expect(caps.supportsSpecificationAttributes).toBe(true);
    expect(caps.supportsPagination).toBe(false);
  });

  it("returns stable, reproducible normalized results for valid queries", async () => {
    const request = {
      query: "keyboard",
      purchaseId: "purch_kb_999",
    };

    const res1 = await adapter.search(request, { now });
    const res2 = await adapter.search(request, { now });

    expect(res1.status).toBe("success");
    expect(res2.status).toBe("success");

    if (res1.status === "success" && res2.status === "success") {
      expect(res1.totalFound).toBe(res2.totalFound);
      expect(res1.candidates.length).toBeGreaterThan(0);
      expect(res1.candidates[0].externalId).toBe(res2.candidates[0].externalId);
      expect(res1.candidates[0].snapshotHash).toBe(res2.candidates[0].snapshotHash);
    }
  });

  it("returns empty result when query does not match any fixture items", async () => {
    const result = await adapter.search(
      {
        query: "nonexistent_space_rocket_laser",
        purchaseId: "purch_empty_001",
      },
      { now }
    );

    expect(result.status).toBe("empty");
    if (result.status === "empty") {
      expect(result.reason).toContain("No products found matching query");
    }
  });

  it("returns empty result when query is empty or whitespace", async () => {
    const result = await adapter.search(
      {
        query: "   ",
        purchaseId: "purch_empty_002",
      },
      { now }
    );

    expect(result.status).toBe("empty");
    if (result.status === "empty") {
      expect(result.reason).toContain("Search query is empty");
    }
  });

  it("simulates upstream source error when trigger query is provided", async () => {
    const result = await adapter.search(
      {
        query: "__trigger_source_error__",
        purchaseId: "purch_err_001",
      },
      { now }
    );

    expect(result.status).toBe("source_error");
    if (result.status === "source_error") {
      expect(result.errorCode).toBe("FIXTURE_UPSTREAM_UNAVAILABLE");
      expect(result.errorMessage).toContain("Simulated upstream provider failure");
    }
  });

  it("filters search results by maxBudgetCents constraint", async () => {
    // Monitor is 349.99 + 15.00 = 364.99 ($364.99 = 36499 cents)
    const budgetUnderResult = await adapter.search(
      {
        query: "monitor",
        purchaseId: "purch_mon_001",
        constraints: {
          maxBudgetCents: 30000, // $300.00 max budget (cannot afford 364.99)
        },
      },
      { now }
    );

    // All matching monitors exceed $300 or are malformed/incomplete
    expect(budgetUnderResult.status).toBe("empty");

    const budgetAdequateResult = await adapter.search(
      {
        query: "monitor",
        purchaseId: "purch_mon_002",
        constraints: {
          maxBudgetCents: 40000, // $400.00 max budget (can afford 364.99)
        },
      },
      { now }
    );

    expect(budgetAdequateResult.status).toBe("success");
    if (budgetAdequateResult.status === "success") {
      expect(budgetAdequateResult.candidates.some((c) => c.externalId === "SKU-MON-4K-001")).toBe(true);
    }
  });

  it("filters search results by merchantAllowList constraint", async () => {
    const allowKeycaps = await adapter.search(
      {
        query: "keyboard",
        purchaseId: "purch_allow_001",
        constraints: {
          merchantAllowList: ["KeycapsDirect"],
        },
      },
      { now }
    );

    expect(allowKeycaps.status).toBe("success");
    if (allowKeycaps.status === "success") {
      for (const cand of allowKeycaps.candidates) {
        expect(cand.merchantName.toLowerCase()).toBe("keycapsdirect");
      }
    }
  });

  it("properly flags malformed and incomplete fixture items with validation errors", async () => {
    const badUrlResult = await adapter.search(
      {
        query: "bad-url",
        purchaseId: "purch_badurl_001",
      },
      { now }
    );

    expect(badUrlResult.status).toBe("success");
    if (badUrlResult.status === "success") {
      const candidate = badUrlResult.candidates[0];
      expect(candidate.isComplete).toBe(false);
      expect(candidate.validationErrors.some((e) => e.includes("Invalid merchantUrl"))).toBe(true);
    }
  });
});
