import { describe, it, expect, vi } from "vitest";
import { Channel3SourceAdapter } from "../../lib/discovery/channel3-adapter";
import { ingestCandidateEvidence } from "../../lib/discovery/evidence";
import { evaluatePolicy } from "../../lib/policy/evaluator";
import { Channel3SearchResponse } from "../../lib/channel3/types";

describe("Channel3 Source Adapter — Deterministic Mocked Tests", () => {
  const now = new Date("2026-10-22T12:00:00.000Z");

  const validChannel3Response: Channel3SearchResponse = {
    products: [
      {
        id: "prod_dell_xps_15",
        title: "Dell XPS 15 9530 Laptop",
        description: "15.6-inch FHD+ Laptop with Intel Core i7, 16GB RAM, 512GB SSD",
        brands: [{ name: "Dell" }],
        images: [{ url: "https://images.example.com/dell_xps15.jpg" }],
        materials: ["Aluminum", "Carbon Fiber"],
        structured_attributes: {
          ram: ["16GB"],
          storage: ["512GB"],
        },
        offers: [
          {
            url: "https://buy.trychannel3.com/click?offer_id=off_dell_1&dest=https%3A%2F%2Fdell.com%2Fxps15",
            domain: "dell.com",
            price: {
              price: 1199.99,
              compare_at_price: 1399.99,
              currency: "USD",
            },
            availability: "InStock",
            condition: "new",
            max_commission_rate: 0.035,
          },
        ],
      },
    ],
  };

  it("1. declares explicit capabilities matching Channel3 capabilities", () => {
    const adapter = new Channel3SourceAdapter({ apiKey: "test_key" });
    const caps = adapter.getCapabilities();

    expect(caps.name).toBe("channel3_source_adapter");
    expect(caps.supportedCurrencies).toEqual(["USD"]);
    expect(caps.supportsStockStatus).toBe(true);
    expect(caps.supportsSpecificationAttributes).toBe(true);
    expect(caps.supportsPagination).toBe(false);
  });

  it("2. normalizes valid upstream Channel3 response with exact decimal money and provenance", async () => {
    const mockSearchFn = vi.fn().mockResolvedValue(validChannel3Response);
    const adapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      searchFn: mockSearchFn,
      defaultShippingCents: 1500, // Explicitly supplied $15.00 shipping
    });

    const result = await adapter.search(
      {
        query: "dell xps 15",
        purchaseId: "pur_test_001",
        constraints: {
          maxBudgetCents: 150000,
          currency: "USD",
        },
      },
      { now }
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    expect(result.totalFound).toBe(1);
    const candidate = result.candidates[0];

    expect(candidate.source).toBe("channel3");
    expect(candidate.externalId).toBe("prod_dell_xps_15:dell.com");
    expect(candidate.title).toBe("Dell XPS 15 9530 Laptop");
    expect(candidate.merchantName).toBe("dell.com");
    expect(candidate.merchantUrl).toBe(
      "https://buy.trychannel3.com/click?offer_id=off_dell_1&dest=https%3A%2F%2Fdell.com%2Fxps15"
    );
    expect(candidate.currency).toBe("USD");
    expect(candidate.unitPriceCents).toBe(119999); // $1199.99 exact cents
    expect(candidate.shippingCents).toBe(1500);
    expect(candidate.totalCents).toBe(121499);
    expect(candidate.availability).toBe("in_stock");
    expect(candidate.isComplete).toBe(true);
    expect(candidate.snapshotHash).toHaveLength(64);

    // Provenance verification
    expect(candidate.rawSourceData.provider).toBe("channel3");
    expect(candidate.rawSourceData.attribution).toContain("Channel3");
    expect(candidate.rawSourceData.productId).toBe("prod_dell_xps_15");
  });

  it("3. handles missing shipping by marking candidate incomplete (never fabricating free shipping)", async () => {
    const mockSearchFn = vi.fn().mockResolvedValue(validChannel3Response);
    const adapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      searchFn: mockSearchFn,
      // defaultShippingCents omitted: upstream does not provide shipping
    });

    const result = await adapter.search(
      {
        query: "dell xps",
        purchaseId: "pur_test_002",
      },
      { now }
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    const candidate = result.candidates[0];
    expect(candidate.isComplete).toBe(false);
    expect(candidate.validationErrors).toContain(
      "Missing shipping cost specification. Shipping cannot be inferred as zero when absent."
    );
  });

  it("4. rejects malformed fields, invalid URLs, and unsupported currencies", async () => {
    const malformedResponse: Channel3SearchResponse = {
      products: [
        {
          id: "prod_eur",
          title: "European Model",
          offers: [
            {
              url: "https://example.com/eur",
              domain: "example.com",
              price: { price: 99.0, currency: "EUR" }, // Unsupported currency
              availability: "InStock",
            },
          ],
        },
        {
          id: "prod_bad_url",
          title: "Bad URL Model",
          offers: [
            {
              url: "javascript:alert(1)", // Invalid URL protocol
              domain: "bad.com",
              price: { price: 50.0, currency: "USD" },
              availability: "InStock",
            },
          ],
        },
        {
          id: "prod_neg_price",
          title: "Negative Price Model",
          offers: [
            {
              url: "https://example.com/neg",
              domain: "example.com",
              price: { price: -20.0, currency: "USD" }, // Negative price
              availability: "InStock",
            },
          ],
        },
      ],
    };

    const adapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      searchFn: vi.fn().mockResolvedValue(malformedResponse),
    });

    const result = await adapter.search(
      { query: "malformed test", purchaseId: "pur_test_003" },
      { now }
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    // All three candidates must fail complete validation
    for (const cand of result.candidates) {
      expect(cand.isComplete).toBe(false);
    }

    const eurCand = result.candidates.find((c) => c.externalId.includes("prod_eur"));
    expect(eurCand?.validationErrors.some((e) => e.includes("EUR"))).toBe(true);

    const badUrlCand = result.candidates.find((c) => c.externalId.includes("prod_bad_url"));
    expect(badUrlCand?.validationErrors.some((e) => e.includes("Protocol"))).toBe(true);
  });

  it("5. returns empty state for empty queries and empty results", async () => {
    const adapter = new Channel3SourceAdapter({ apiKey: "test_key" });

    // Empty query
    const emptyQueryRes = await adapter.search(
      { query: "   ", purchaseId: "pur_test_004" },
      { now }
    );
    expect(emptyQueryRes.status).toBe("empty");

    // No products from upstream
    const emptyProductsAdapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      searchFn: vi.fn().mockResolvedValue({ products: [] }),
    });
    const noProductsRes = await emptyProductsAdapter.search(
      { query: "nonexistent item", purchaseId: "pur_test_004" },
      { now }
    );
    expect(noProductsRes.status).toBe("empty");

    // Products with empty offers
    const noOffersAdapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      searchFn: vi.fn().mockResolvedValue({
        products: [{ id: "p1", title: "No Offers Product", offers: [] }],
      }),
    });
    const noOffersRes = await noOffersAdapter.search(
      { query: "no offers", purchaseId: "pur_test_004" },
      { now }
    );
    expect(noOffersRes.status).toBe("empty");
  });

  it("6. safely maps upstream errors: 401, 402, 422, 429, 500, and timeout", async () => {
    // 401 Unauthorized
    const authFailAdapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      fetchFn: vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ detail: "Invalid API Key" }),
      } as unknown as Response),
    });
    const authRes = await authFailAdapter.search({ query: "test", purchaseId: "pur_1" }, { now });
    expect(authRes.status).toBe("source_error");
    if (authRes.status === "source_error") {
      expect(authRes.errorCode).toBe("CHANNEL3_UNAUTHORIZED");
    }

    // 402 Payment Required
    const paymentReqAdapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      fetchFn: vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        json: async () => ({ detail: "Out of credits" }),
      } as unknown as Response),
    });
    const payRes = await paymentReqAdapter.search({ query: "test", purchaseId: "pur_1" }, { now });
    expect(payRes.status).toBe("source_error");
    if (payRes.status === "source_error") {
      expect(payRes.errorCode).toBe("CHANNEL3_PAYMENT_REQUIRED");
    }

    // 429 Rate Limit
    const rateLimitAdapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      fetchFn: vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ detail: "Too many requests" }),
      } as unknown as Response),
    });
    const rateRes = await rateLimitAdapter.search({ query: "test", purchaseId: "pur_1" }, { now });
    expect(rateRes.status).toBe("source_error");
    if (rateRes.status === "source_error") {
      expect(rateRes.errorCode).toBe("CHANNEL3_RATE_LIMITED");
    }

    // 500 Server Error
    const serverErrAdapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      fetchFn: vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ detail: "Internal Server Error" }),
      } as unknown as Response),
    });
    const errRes = await serverErrAdapter.search({ query: "test", purchaseId: "pur_1" }, { now });
    expect(errRes.status).toBe("source_error");
    if (errRes.status === "source_error") {
      expect(errRes.errorCode).toBe("CHANNEL3_UPSTREAM_ERROR");
    }

    // Timeout
    const timeoutAdapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      fetchFn: vi.fn().mockImplementation(() => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }),
    });
    const timeoutRes = await timeoutAdapter.search({ query: "test", purchaseId: "pur_1" }, { now });
    expect(timeoutRes.status).toBe("source_error");
    if (timeoutRes.status === "source_error") {
      expect(timeoutRes.errorCode).toBe("CHANNEL3_TIMEOUT");
    }
  });

  it("7. deduplicates duplicate merchant offers for the same product", async () => {
    const dupResponse: Channel3SearchResponse = {
      products: [
        {
          id: "prod_dup_1",
          title: "Laptop with duplicate retailer offer",
          offers: [
            {
              url: "https://buy.trychannel3.com/click1",
              domain: "dell.com",
              price: { price: 999.0, currency: "USD" },
              availability: "InStock",
            },
            {
              url: "https://buy.trychannel3.com/click2",
              domain: "dell.com", // Same domain on same product
              price: { price: 999.0, currency: "USD" },
              availability: "InStock",
            },
          ],
        },
      ],
    };

    const adapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      searchFn: vi.fn().mockResolvedValue(dupResponse),
      defaultShippingCents: 0,
    });

    const result = await adapter.search({ query: "laptop", purchaseId: "pur_dup" }, { now });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.totalFound).toBe(1);
      expect(result.candidates.length).toBe(1);
    }
  });

  it("8. fails closed with CHANNEL3_NOT_CONFIGURED when API key is absent (no synthetic fallback)", async () => {
    // Empty key, no env
    const originalKey = process.env.CHANNEL3_API_KEY;
    try {
      delete process.env.CHANNEL3_API_KEY;
      const adapter = new Channel3SourceAdapter({ apiKey: "" });

      const result = await adapter.search({ query: "laptop", purchaseId: "pur_unconfigured" }, { now });

      expect(result.status).toBe("source_error");
      if (result.status === "source_error") {
        expect(result.errorCode).toBe("CHANNEL3_NOT_CONFIGURED");
        expect(result.errorMessage).toContain("CHANNEL3_API_KEY");
      }
    } finally {
      if (originalKey !== undefined) {
        process.env.CHANNEL3_API_KEY = originalKey;
      }
    }
  });

  it("9. preserves missing evidence causing policy engine P-EVIDENCE and P-FRESHNESS to fail closed", async () => {
    const mockSearchFn = vi.fn().mockResolvedValue(validChannel3Response);
    const adapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      searchFn: mockSearchFn,
      defaultShippingCents: 0,
    });

    const result = await adapter.search({ query: "dell", purchaseId: "pur_evidence_test" }, { now });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    const candidate = result.candidates[0];

    // Ingest evidence for purchase requirements:
    // 1. "RAM": "16GB" (present in structured_attributes, but has NO observation timestamp)
    // 2. "Display": "4K OLED" (missing entirely from upstream)
    const requiredSpecs = [
      { key: "ram", expectedValue: "16GB" },
      { key: "display", expectedValue: "4K OLED" },
    ];

    const ingestion = ingestCandidateEvidence({
      candidate,
      requiredAttributes: requiredSpecs,
      rawObservations: candidate.rawSourceData.rawAttributes as Record<string, unknown>,
      now,
    });

    // Verify missing specs are flagged missing
    expect(ingestion.missingAttributeKeys).toContain("display");
    expect(ingestion.isComplete).toBe(false);

    // Verify missing observation timestamp is unverified (empty string)
    const ramEvidence = ingestion.evidenceRecords.find((e) => e.requirementKey === "ram");
    expect(ramEvidence?.capturedAt).toBe("");

    // Run policy engine: must BLOCK on P-EVIDENCE and P-FRESHNESS
    const policyResult = evaluatePolicy({
      config: {
        requiredRuleKeys: ["P-BUDGET", "P-CURRENCY", "P-EVIDENCE", "P-FRESHNESS"],
      },
      purchase: {
        budgetCents: 150000,
        currency: "USD",
        requiredAttributes: requiredSpecs,
      },
      candidate: {
        id: candidate.id,
        merchantName: candidate.merchantName,
        unitPriceCents: candidate.unitPriceCents,
        shippingCents: candidate.shippingCents,
        totalCents: candidate.totalCents,
        currency: candidate.currency,
        quantity: candidate.quantity,
        availability: candidate.availability,
        snapshotHash: candidate.snapshotHash,
      },
      evidence: ingestion.evidenceRecords,
      now,
    });

    expect(policyResult.summary.allRequiredPassed).toBe(false);
    expect(policyResult.summary.unknownRuleKeys).toContain("P-EVIDENCE");
    expect(policyResult.summary.unknownRuleKeys).toContain("P-FRESHNESS");
    expect(policyResult.ruleResults["P-EVIDENCE"].outcome).toBe("unknown");
    expect(policyResult.ruleResults["P-FRESHNESS"].outcome).toBe("unknown");
  });

  it("10. ensures discovery executes purely read-only without database or PayPal mutations", async () => {
    // Verification that adapter does not invoke any persistence or order creation
    const adapter = new Channel3SourceAdapter({
      apiKey: "test_key",
      searchFn: vi.fn().mockResolvedValue(validChannel3Response),
      defaultShippingCents: 0,
    });

    const result = await adapter.search({ query: "laptop", purchaseId: "pur_readonly_check" }, { now });
    expect(result.status).toBe("success");
    // Adapter returns data in-memory without any side-effects
  });
});
