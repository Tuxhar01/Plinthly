import { describe, it, expect } from "vitest";
import {
  BestBuyShippingQuoteAdapter,
  ShopifyShippingQuoteAdapter,
  MultiProviderShippingQuoteAdapter,
  ShippingQuoteRequest,
  validateQuoteForCandidate,
  computeQuoteFingerprint,
  SuccessfulShippingQuote,
} from "../../lib/discovery/shipping-quote";
import { computeSnapshotHash } from "../../lib/state/snapshot";
import { transition } from "../../lib/state/transitions";
import { PurchaseState, CandidateFacts } from "../../lib/state/types";

describe("Plinthly Phase 11F — Shipping Quote Adapter Feasibility", () => {
  const now = new Date("2026-10-23T12:00:00.000Z");

  const baseRequest: ShippingQuoteRequest = {
    candidate: {
      externalId: "U74AJi2:bestbuy.com",
      merchantName: "Best Buy",
      merchantUrl: "https://bestbuy.com/products/6534567",
      unitPriceCents: 99999,
      quantity: 1,
      currency: "USD",
      sku: "6534567",
    },
    canonicalProductUrl: "https://bestbuy.com/products/6534567",
    destination: {
      country: "US",
      postalCode: "98101",
      deliveryMethodPreference: "standard_ground",
    },
    requestedCurrency: "USD",
    now,
  };

  // 1. Unconfigured adapter reports documented blocker (CAPI partner boundary)
  it("1. reports documented blocker when enterprise CAPI credentials are not configured", async () => {
    const adapter = new BestBuyShippingQuoteAdapter(); // No API key configured
    expect(adapter.canQuote(baseRequest.candidate)).toBe(true);

    const res = await adapter.getShippingQuote(baseRequest);
    expect(res.status).toBe("unavailable");
    if (res.status === "unavailable") {
      expect(res.reason).toContain("Commerce API (CAPI)");
      expect(res.reason).toContain("anti-automation policies prohibit undocumented scraping");
    }

    const validation = validateQuoteForCandidate(res, baseRequest);
    expect(validation.valid).toBe(false);
    expect(validation.isAuthoritative).toBe(false);
    expect(validation.shippingCents).toBeNull(); // Never turns into 0
    expect(validation.details.type).toBe("missing");
  });

  // 2. Unsupported retailer fails cleanly
  it("2. returns unsupported for non-supported merchant", async () => {
    const adapter = new BestBuyShippingQuoteAdapter({ apiKey: "test_key" });
    const unsupportedReq: ShippingQuoteRequest = {
      ...baseRequest,
      candidate: {
        ...baseRequest.candidate,
        merchantName: "RandomRetailer",
        merchantUrl: "https://randomretailer.example.com",
        externalId: "SKU-999:random",
      },
    };

    expect(adapter.canQuote(unsupportedReq.candidate)).toBe(false);

    const res = await adapter.getShippingQuote(unsupportedReq);
    expect(res.status).toBe("unsupported");
    if (res.status === "unsupported") {
      expect(res.reason).toContain("is not Best Buy");
    }

    const validation = validateQuoteForCandidate(res, unsupportedReq);
    expect(validation.valid).toBe(false);
    expect(validation.shippingCents).toBeNull();
  });

  // 3. Successful quote using mocked retailer transport
  it("3. processes authoritative quote with mocked retailer transport", async () => {
    const mockFetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rates: [
            {
              quoteId: "bb_quote_test_001",
              deliveryMethod: "standard_ground",
              amountCents: 1599,
              currency: "USD",
              quotedAt: "2026-10-23T11:55:00.000Z",
              expiresAt: "2026-10-23T12:55:00.000Z",
              conditions: ["curbside_or_home_delivery"],
            },
          ],
        }),
      } as Response;
    }) as typeof fetch;

    const adapter = new BestBuyShippingQuoteAdapter({
      apiKey: "test_capi_key",
      fetchFn: mockFetch,
    });

    const quoteRes = await adapter.getShippingQuote(baseRequest);
    expect(quoteRes.status).toBe("success");

    if (quoteRes.status === "success") {
      expect(quoteRes.amountCents).toBe(1599);
      expect(quoteRes.currency).toBe("USD");
      expect(quoteRes.destinationPostalCode).toBe("98101");
      expect(quoteRes.destinationCountry).toBe("US");
      expect(quoteRes.quoteFingerprint.length).toBe(64);

      const validation = validateQuoteForCandidate(quoteRes, baseRequest);
      expect(validation.valid).toBe(true);
      expect(validation.isAuthoritative).toBe(true);
      expect(validation.shippingCents).toBe(1599);
      expect(validation.details.type).toBe("quoted");
      expect(validation.details.destinationPostalCode).toBe("98101");
      expect(validation.details.sourceVerificationTimestamp).toBe("2026-10-23T11:55:00.000Z");
    }
  });

  // 4. Malformed amount from retailer fails closed
  it("4. rejects malformed or negative shipping amount from retailer", async () => {
    const mockFetchNegative = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rates: [
            {
              quoteId: "bb_bad_quote",
              deliveryMethod: "standard_ground",
              amountCents: -500, // Negative amount
            },
          ],
        }),
      } as Response;
    }) as typeof fetch;

    const adapter = new BestBuyShippingQuoteAdapter({
      apiKey: "test_capi_key",
      fetchFn: mockFetchNegative,
    });

    const res = await adapter.getShippingQuote(baseRequest);
    expect(res.status).toBe("failed");
    if (res.status === "failed") {
      expect(res.errorCode).toBe("MALFORMED_AMOUNT");
    }

    const validation = validateQuoteForCandidate(res, baseRequest);
    expect(validation.valid).toBe(false);
    expect(validation.shippingCents).toBeNull();
  });

  // 5. Expired quote is rejected
  it("5. rejects expired quote", () => {
    const expiredQuote: SuccessfulShippingQuote = {
      status: "success",
      quoteId: "quote_exp_001",
      amountCents: 999,
      currency: "USD",
      retailerId: "bestbuy.com",
      merchantDomain: "bestbuy.com",
      externalId: baseRequest.candidate.externalId,
      destinationPostalCode: "98101",
      destinationCountry: "US",
      deliveryMethod: "standard_ground",
      quotedAt: "2026-10-22T10:00:00.000Z",
      expiresAt: "2026-10-22T11:00:00.000Z", // Expired yesterday relative to now
      sourceUrl: "https://api.bestbuy.com/quotes/exp_001",
      quoteFingerprint: "a".repeat(64),
    };

    const validation = validateQuoteForCandidate(expiredQuote, baseRequest);
    expect(validation.valid).toBe(false);
    expect(validation.isAuthoritative).toBe(false);
    expect(validation.shippingCents).toBeNull();
    expect(validation.rejectionReason).toContain("Quote expired");
  });

  // 6. Mismatched external ID or destination postal code fails validation
  it("6. rejects mismatched product externalId or destination postal code", () => {
    const validQuote: SuccessfulShippingQuote = {
      status: "success",
      quoteId: "quote_mismatch_001",
      amountCents: 999,
      currency: "USD",
      retailerId: "bestbuy.com",
      merchantDomain: "bestbuy.com",
      externalId: "OTHER-SKU:bestbuy.com", // Mismatched SKU
      destinationPostalCode: "98101",
      destinationCountry: "US",
      deliveryMethod: "standard_ground",
      quotedAt: "2026-10-23T11:55:00.000Z",
      expiresAt: "2026-10-23T12:55:00.000Z",
      sourceUrl: "https://api.bestbuy.com/quotes/001",
      quoteFingerprint: "b".repeat(64),
    };

    const extIdValidation = validateQuoteForCandidate(validQuote, baseRequest);
    expect(extIdValidation.valid).toBe(false);
    expect(extIdValidation.rejectionReason).toContain("does not match candidate externalId");

    // Destination postal code mismatch
    const destMismatchQuote: SuccessfulShippingQuote = {
      ...validQuote,
      externalId: baseRequest.candidate.externalId,
      destinationPostalCode: "90210", // Beverly Hills instead of Seattle 98101
    };

    const destValidation = validateQuoteForCandidate(destMismatchQuote, baseRequest);
    expect(destValidation.valid).toBe(false);
    expect(destValidation.rejectionReason).toContain("does not match requested destination");
  });

  // 7. No delivery rates available
  it("7. handles retailer response with no available delivery rates", async () => {
    const mockFetchNoRates = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ rates: [] }),
      } as Response;
    }) as typeof fetch;

    const adapter = new BestBuyShippingQuoteAdapter({
      apiKey: "test_capi_key",
      fetchFn: mockFetchNoRates,
    });

    const res = await adapter.getShippingQuote(baseRequest);
    expect(res.status).toBe("unavailable");
    if (res.status === "unavailable") {
      expect(res.reason).toContain("No shipping rates available");
    }
  });

  // 8. Deterministic quote fingerprinting binds quote facts
  it("8. deterministic quote fingerprinting binds quote facts", () => {
    const quoteData = {
      status: "success" as const,
      quoteId: "quote_fp_001",
      amountCents: 1200,
      currency: "USD" as const,
      retailerId: "bestbuy.com",
      merchantDomain: "bestbuy.com",
      externalId: "U74AJi2:bestbuy.com",
      destinationPostalCode: "98101",
      destinationCountry: "US" as const,
      deliveryMethod: "standard_ground",
      quotedAt: "2026-10-23T11:55:00.000Z",
      expiresAt: "2026-10-23T12:55:00.000Z",
      sourceUrl: "https://api.bestbuy.com/quotes/001",
    };

    const fp1 = computeQuoteFingerprint(quoteData);
    expect(fp1.length).toBe(64);

    // Any change changes the fingerprint
    const fp2 = computeQuoteFingerprint({ ...quoteData, amountCents: 1400 });
    expect(fp2).not.toBe(fp1);

    const fp3 = computeQuoteFingerprint({ ...quoteData, destinationPostalCode: "10001" });
    expect(fp3).not.toBe(fp1);
  });

  // 9. Shipping change from new quote invalidates approval before order creation
  it("9. changing shipping quote invalidates stale buyer approval", () => {
    const origCand: CandidateFacts = {
      id: "cand_bb_01",
      purchaseId: "pur_quote_test_01",
      source: "channel3",
      unitPriceCents: 99900,
      quantity: 1,
      shippingCents: 0,
      totalCents: 99900,
      currency: "USD",
      snapshotHash: "c".repeat(64),
    };

    // New quote obtained: shipping is $15.99 (1599 cents)
    const updatedCand: CandidateFacts = {
      ...origCand,
      shippingCents: 1599,
      totalCents: 101499,
      snapshotHash: computeSnapshotHash({
        availability: "in_stock",
        currency: "USD",
        externalId: "U74AJi2:bestbuy.com",
        merchantName: "Best Buy",
        merchantUrl: "https://bestbuy.com/item",
        quantity: 1,
        shippingCents: 1599,
        source: "channel3",
        totalCents: 101499,
        unitPriceCents: 99900,
      }),
    };

    const approvedState: PurchaseState = {
      purchaseId: "pur_quote_test_01",
      status: "APPROVED",
      policyVersion: "1.0.0",
      budgetCents: 120000,
      currency: "USD",
      requiredRuleKeys: ["P-BUDGET"],
      selectedCandidate: updatedCand, // Candidate has updated quote
      approvals: [
        {
          id: "appr_orig",
          purchaseId: "pur_quote_test_01",
          candidateId: "cand_bb_01",
          snapshotHash: "c".repeat(64), // Approved against old snapshot
          totalCents: 99900,
          currency: "USD",
          policyVersion: "1.0.0",
          evidenceFingerprint: "d".repeat(64),
          approverUserId: "usr_buyer_1",
          approvedAt: now,
          invalidatedAt: null,
          invalidationReason: null,
        },
      ],
      paymentAttempts: [],
      currentEvidenceFingerprint: "d".repeat(64),
      policyEvidenceFingerprint: "d".repeat(64),
    };

    const res = transition(
      approvedState,
      {
        kind: "create_order",
        idempotencyKey: "idem_quote_1",
        paypalOrderId: "PAYPAL-ORDER-QUOTE",
      },
      {
        now,
        actor: { kind: "system", component: "quote_validator" },
        newPaymentAttemptId: "pay_att_quote_1",
      }
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("approval_invalidated");
      expect(res.error.message).toContain("snapshot_hash_changed");
      expect(res.error.message).toContain("total_changed");
    }
  });

  // 10. Shopify adapter reports documented blocker when unconfigured
  it("10. reports documented blocker when Shopify Storefront credentials are not configured", async () => {
    const adapter = new ShopifyShippingQuoteAdapter();
    const shopifyCandidate = {
      ...baseRequest.candidate,
      merchantName: "Shopify Merchant",
      merchantUrl: "https://example-shop.myshopify.com/products/item1",
      externalId: "item1:myshopify.com",
    };

    expect(adapter.canQuote(shopifyCandidate)).toBe(true);

    const res = await adapter.getShippingQuote({
      ...baseRequest,
      candidate: shopifyCandidate,
    });

    expect(res.status).toBe("unavailable");
    if (res.status === "unavailable") {
      expect(res.reason).toContain("Storefront API Access Token");
      expect(res.reason).toContain("Anti-automation policies prohibit undocumented scraping");
    }
  });

  // 11. Shopify adapter processes authoritative quote with mocked Storefront GraphQL transport
  it("11. processes authoritative quote with mocked Shopify GraphQL transport", async () => {
    const mockFetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            cart: {
              deliveryGroups: {
                edges: [
                  {
                    node: {
                      deliveryOptions: [
                        {
                          handle: "shopify-standard-ground",
                          title: "Standard Ground",
                          estimatedCost: {
                            amount: "12.50",
                            currencyCode: "USD",
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        }),
      } as Response;
    }) as typeof fetch;

    const adapter = new ShopifyShippingQuoteAdapter({
      storefrontAccessToken: "shpat_mock_token_123",
      shopDomain: "demo-electronics.myshopify.com",
      fetchFn: mockFetch,
    });

    const shopifyCandidate = {
      ...baseRequest.candidate,
      merchantName: "Shopify Electronics",
      merchantUrl: "https://demo-electronics.myshopify.com/products/laptop",
      externalId: "laptop_01:myshopify.com",
    };

    const res = await adapter.getShippingQuote({
      ...baseRequest,
      candidate: shopifyCandidate,
      canonicalProductUrl: "https://demo-electronics.myshopify.com/products/laptop",
    });

    expect(res.status).toBe("success");
    if (res.status === "success") {
      expect(res.amountCents).toBe(1250);
      expect(res.deliveryMethod).toBe("Standard Ground");
      expect(res.retailerId).toBe("shopify.com");
      expect(res.quoteFingerprint).toBeDefined();

      const validation = validateQuoteForCandidate(res, {
        ...baseRequest,
        candidate: shopifyCandidate,
        canonicalProductUrl: "https://demo-electronics.myshopify.com/products/laptop",
      });
      expect(validation.valid).toBe(true);
      expect(validation.isAuthoritative).toBe(true);
      expect(validation.shippingCents).toBe(1250);
    }
  });

  // 12. MultiProviderShippingQuoteAdapter dispatches correctly
  it("12. MultiProviderShippingQuoteAdapter routes candidates to matching providers", async () => {
    const multiAdapter = new MultiProviderShippingQuoteAdapter();

    expect(multiAdapter.canQuote({ merchantName: "Best Buy Official" })).toBe(true);
    expect(multiAdapter.canQuote({ merchantUrl: "https://store.myshopify.com" })).toBe(true);
    expect(multiAdapter.canQuote({ merchantName: "Random Unsupported Store" })).toBe(false);

    const unsupportedRes = await multiAdapter.getShippingQuote({
      ...baseRequest,
      candidate: {
        ...baseRequest.candidate,
        merchantName: "Unknown Retailer",
        merchantUrl: "https://unknown.example.org",
        externalId: "item:unknown.example.org",
      },
    });

    expect(unsupportedRes.status).toBe("unsupported");
    if (unsupportedRes.status === "unsupported") {
      expect(unsupportedRes.reason).toContain("No registered shipping adapter supports retailer");
    }
  });
});

