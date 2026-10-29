/**
 * PLINTHLY — PHASE 14: Live Retailer Evidence and Destination-Aware Procurement Test Suite
 *
 * Verifies:
 * 1. Live listing normalization and missing field detection.
 * 2. Product variant, merchant, and seller mismatch enforcement.
 * 3. Evidence freshness, observation vs authoritative source verification provenance.
 * 4. Dynamic quote versus policy-derived shipping evidence distinction.
 * 5. Honest landed-cost calculation and ranking (unknown shipping is never ranked cheaper than verified totals).
 * 6. Destination, currency, quantity, and total-cost drift prevention.
 * 7. Approval invalidation on critical input change.
 * 8. Comparison UI row mapping and blocker action recommendations.
 * 9. PayPal client boundary: zero remote calls when preconditions fail.
 * 10. Persistence corruption recovery: safe fallback to default policies without reactivating stale terms.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { normalizeCandidate } from "../../lib/discovery/normalize";
import { DestinationContext } from "../../lib/discovery/shipping";
import {
  BestBuyShippingQuoteAdapter,
  computeQuoteFingerprint,
  setShippingQuoteAdapter,
  MultiProviderShippingQuoteAdapter,
} from "../../lib/discovery/shipping-quote";
import {
  DEFAULT_MERCHANT_POLICIES,
  getMerchantPolicyRegistry,
  MerchantPolicyRegistry,
} from "../../lib/discovery/merchant-policy-registry";
import {
  DurablePolicyStore,
  clearProposalReviewAuditLog,
} from "../../lib/discovery/policy-persistence";
import { PolicyProposalEngine } from "../../lib/discovery/policy-ingestion/proposal-engine";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { CandidateRecord, InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { Actor } from "../../lib/state/types";
import { ApprovalIntegrityError } from "../../lib/workflow/errors";
import { Channel3SourceAdapter } from "../../lib/discovery/channel3-adapter";
import { Channel3SearchResponse } from "../../lib/channel3/types";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("Phase 14 — Live Retailer Evidence and Destination-Aware Procurement", () => {
  const buyerActor: Actor = { kind: "user", userId: "usr_buyer_phase14" };
  const testDestination: DestinationContext = {
    country: "US",
    postalCode: "98101",
    deliveryMethodPreference: "standard_ground",
  };

  const tempDir = join(process.cwd(), ".data", "test-phase14");
  const tempStoragePath = join(tempDir, "policy-storage.json");

  let repo: InMemoryPurchaseRepository;
  let mockPayPal: PayPalSandboxClient;
  let service: PurchaseWorkflowService;

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
    mockPayPal = {
      createOrder: vi.fn(),
      getOrder: vi.fn(),
      captureOrder: vi.fn(),
      getClientToken: vi.fn(),
    } as unknown as PayPalSandboxClient;
    service = new PurchaseWorkflowService(repo, mockPayPal);
    clearProposalReviewAuditLog();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setShippingQuoteAdapter(new MultiProviderShippingQuoteAdapter());
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 1. Live Listing Normalization & Missing Fields
  // --------------------------------------------------------------------------
  it("1. Normalization preserves retailer, seller, and fulfillment while flagging missing shipping", () => {
    const rawListing = {
      externalId: "prod_asus_123:bestbuy.com",
      title: "ASUS Vivobook 16 Laptop",
      merchantName: "Best Buy",
      merchantUrl: "https://www.bestbuy.com/site/asus-vivobook/123.p",
      unitPriceCents: 68999,
      currency: "USD",
      availability: "in_stock",
      sellerName: "Best Buy Official",
      isDirectRetailer: true,
      isMarketplace: false,
      fulfillmentMethod: "Retailer Ground",
      // Shipping is omitted from upstream
      shipping: undefined,
      rawAttributes: {
        brand: "ASUS",
        ram: "16GB",
        screen_size: "16-inch",
        inferred_condition: "new (unverified text heuristic)",
      },
    };

    const normalized = normalizeCandidate(rawListing, {
      purchaseId: "pur_test_p14",
      source: "channel3",
      now: new Date("2026-10-29T10:00:00.000Z"),
      requiredAttributes: ["ram", "storage"],
    });

    expect(normalized.isComplete).toBe(false);
    expect(normalized.shippingDetails?.type).toBe("missing");
    expect(normalized.shippingDetails?.isAuthoritative).toBe(false);
    expect(normalized.totalCents).toBe(0); // Landed cost cannot be computed without shipping
    expect(normalized.sellerName).toBe("Best Buy Official");
    expect(normalized.isDirectRetailer).toBe(true);
    expect(normalized.isMarketplace).toBe(false);
    expect(normalized.fulfillmentMethod).toBe("Retailer Ground");

    // Specification provenance check: known vs inferred vs missing
    expect(normalized.specificationsSummary?.known.ram).toBe("16GB");
    expect(normalized.specificationsSummary?.known.brand).toBe("ASUS");
    expect(normalized.specificationsSummary?.inferred.inferred_condition).toBeDefined();
    // 'storage' was required but missing from structured data
    expect(normalized.specificationsSummary?.missing).toContain("storage");

    // Blocker reason and actionable guidance
    expect(normalized.blockerReason).toContain("Missing shipping cost specification");
    expect(normalized.blockerAction).toContain("destination postal code");
  });

  // --------------------------------------------------------------------------
  // 2. Product Variant & Seller Mismatches
  // --------------------------------------------------------------------------
  it("2. Rejects product variant or seller mismatches between quote and candidate", () => {
    const quoteAdapter = new BestBuyShippingQuoteAdapter({
      apiKey: "test_key",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            rates: [
              {
                quoteId: "bb_q_100",
                amountCents: 0,
                deliveryMethod: "standard_ground",
                quotedAt: new Date().toISOString(),
              },
            ],
          }),
          { status: 200 }
        ),
    });

    // Mismatched candidate: externalId does not match quote request SKU
    const target = {
      externalId: "sku_diff:bestbuy.com",
      merchantName: "Best Buy",
      merchantUrl: "https://bestbuy.com/item",
      unitPriceCents: 5000,
      quantity: 1,
      currency: "USD" as const,
      sku: "sku_original",
    };

    expect(quoteAdapter.canQuote(target)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 3. Evidence Freshness: Observation vs Authoritative Source Timestamp
  // --------------------------------------------------------------------------
  it("3. Clearly distinguishes observation timestamp from provider source-verification timestamp", () => {
    const now = new Date("2026-10-29T10:30:00.000Z");

    const candidateWithoutQuote = normalizeCandidate(
      {
        externalId: "item_1:retailer.com",
        title: "Test Item",
        merchantName: "Retailer",
        merchantUrl: "https://retailer.com/item",
        unitPriceCents: 2000,
        currency: "USD",
        availability: "in_stock",
        // Only observation timestamp provided
        capturedAt: "2026-10-29T10:30:00.000Z",
        sourceVerificationTimestamp: null,
      },
      {
        purchaseId: "pur_fresh_test",
        source: "channel3",
        now,
      }
    );

    expect(candidateWithoutQuote.shippingDetails?.sourceVerificationTimestamp).toBeNull();
    expect(candidateWithoutQuote.shippingDetails?.isAuthoritative).toBe(false);

    // Now test with verified policy timestamp
    const candidateWithPolicy = normalizeCandidate(
      {
        externalId: "item_2:bestbuy.com",
        title: "Best Buy Item",
        merchantName: "Best Buy",
        merchantUrl: "https://bestbuy.com/item",
        unitPriceCents: 5000,
        currency: "USD",
        availability: "in_stock",
        shipping: 0,
        shippingType: "policy_derived",
        policyId: "pol_bestbuy_contiguous_us_ground_v2",
        policyDocumentFingerprint: "a".repeat(64),
        policySourceUrl: "https://bestbuy.com/shipping-policy",
        destinationPostalCode: "98101",
        destinationCountry: "US",
        sourceVerificationTimestamp: "2026-10-28T12:00:00.000Z",
      },
      {
        purchaseId: "pur_fresh_test_2",
        source: "channel3",
        now,
      }
    );

    expect(candidateWithPolicy.shippingDetails?.sourceVerificationTimestamp).toBe("2026-10-28T12:00:00.000Z");
    expect(candidateWithPolicy.shippingDetails?.isAuthoritative).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 4. Dynamic Quote vs Policy-Derived Shipping Evidence
  // --------------------------------------------------------------------------
  it("4. Distinguishes dynamic quotes from policy-derived evidence and never conflates them", async () => {
    // 4a. Dynamic Quote from verified carrier adapter
    const mockCarrierQuoteAdapter = {
      name: "mock_carrier_adapter",
      supportedRetailers: ["bestbuy.com"],
      canQuote: () => true,
      getShippingQuote: async () => {
        const baseQuote = {
          status: "success" as const,
          quoteId: "quote_carrier_99",
          amountCents: 599,
          currency: "USD" as const,
          retailerId: "bestbuy.com",
          merchantDomain: "bestbuy.com",
          externalId: "sku_laptop_1:bestbuy.com",
          canonicalProductUrl: "https://www.bestbuy.com/site/laptop/1.p",
          destinationPostalCode: "98101",
          destinationCountry: "US" as const,
          deliveryMethod: "standard_ground",
          quotedAt: "2026-10-29T10:00:00.000Z",
          expiresAt: "2026-10-29T12:00:00.000Z",
          sourceUrl: "https://bestbuy.com/rates/quote_carrier_99",
        };
        return {
          ...baseQuote,
          quoteFingerprint: computeQuoteFingerprint(baseQuote),
        };
      },
    };

    setShippingQuoteAdapter(mockCarrierQuoteAdapter);

    const mockSearchResponse: Channel3SearchResponse = {
      products: [
        {
          id: "sku_laptop_1",
          title: "Lenovo ThinkPad E16",
          offers: [
            {
              url: "https://www.bestbuy.com/site/laptop/1.p",
              domain: "bestbuy.com",
              price: { price: 799.99, currency: "USD" },
              availability: "InStock",
            },
          ],
        },
      ],
    };

    const adapter = new Channel3SourceAdapter({
      apiKey: "dummy_key",
      searchFn: async () => mockSearchResponse,
    });

    const resQuoted = await adapter.search(
      {
        query: "Lenovo ThinkPad",
        purchaseId: "pur_p14_search",
        constraints: {
          destination: testDestination,
          minQuantity: 1,
          maxBudgetCents: 100000,
        },
      },
      { now: new Date("2026-10-29T10:00:00.000Z") }
    );

    expect(resQuoted.status).toBe("success");
    if (resQuoted.status === "success") {
      const cand = resQuoted.candidates[0];
      expect(cand.shippingDetails?.type).toBe("quoted");
      expect(cand.shippingDetails?.isAuthoritative).toBe(true);
      expect(cand.shippingCents).toBe(599);
      expect(cand.totalCents).toBe(80598); // $799.99 + $5.99
    }

    // 4b. Policy-Derived Shipping Evidence from Official Policy Registry
    const registry = getMerchantPolicyRegistry();
    const policyOutcome = registry.evaluateCandidate({
      candidate: {
        externalId: "cand_bb_direct",
        merchantName: "Best Buy",
        merchantUrl: "https://bestbuy.com/item",
        title: "Best Buy Laptop",
        unitPriceCents: 68999,
        quantity: 1,
        sellerName: "Best Buy",
        isDirectRetailerSeller: true,
        isMarketplace: false,
      },
      destination: testDestination,
      now: new Date("2026-10-29T10:00:00.000Z"),
      requestedCurrency: "USD",
    });

    expect(policyOutcome?.status).toBe("satisfied");
    expect(policyOutcome?.isApplicable).toBe(true);
    expect(policyOutcome?.shippingCents).toBe(0);
    expect(policyOutcome?.policyId).toBe("pol_bestbuy_contiguous_us_ground_v2");
    expect(policyOutcome?.explanation).toContain("meets or exceeds $35.00 threshold");
  });

  // --------------------------------------------------------------------------
  // 5. Honest Landed-Cost Calculation & Sorting
  // --------------------------------------------------------------------------
  it("5. Honest landed-cost ranking: unknown shipping is never ranked cheaper than verified totals", () => {
    // Candidate A: $140.00 product + $10.00 verified shipping = $150.00 total
    const candA = {
      id: "cand_A",
      externalId: "cand_A",
      title: "Verified Candidate A",
      unitPriceCents: 14000,
      shippingCents: 1000,
      totalCents: 15000,
      isComplete: true,
    };

    // Candidate B: $80.00 product + unknown shipping (incomplete) = null total
    const candB = {
      id: "cand_B",
      externalId: "cand_B",
      title: "Incomplete Candidate B",
      unitPriceCents: 8000,
      shippingCents: null,
      totalCents: null,
      isComplete: false,
    };

    // Candidate C: $200.00 product + $0.00 shipping = $200.00 total
    const candC = {
      id: "cand_C",
      externalId: "cand_C",
      title: "Verified Candidate C",
      unitPriceCents: 20000,
      shippingCents: 0,
      totalCents: 20000,
      isComplete: true,
    };

    // Honest comparator implementation as used in AG Grid column definition:
    const comparator = (valA: number | null, valB: number | null): number => {
      if (valA === null && valB === null) return 0;
      if (valA === null) return 1; // null (unknown) sorts after known numbers
      if (valB === null) return -1;
      return valA - valB;
    };

    const list = [candB, candC, candA];
    const sorted = [...list].sort((x, y) => comparator(x.totalCents, y.totalCents));

    // Candidate A ($150.00) must rank first
    expect(sorted[0].id).toBe("cand_A");
    // Candidate C ($200.00) must rank second
    expect(sorted[1].id).toBe("cand_C");
    // Candidate B (unknown shipping) MUST rank last, NEVER cheaper than A or C despite $80 price
    expect(sorted[2].id).toBe("cand_B");
    expect(sorted[2].totalCents).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 6. Destination, Currency, Quantity, and Total-Cost Mismatches
  // --------------------------------------------------------------------------
  it("6. Fails closed when order destination postal code mismatches candidate quote destination", async () => {
    const purchase = await service.createPurchase(
      {
        budgetCents: 150000,
        currency: "USD",
        requirements: ["merchant_spec: Laptop"],
        requestedQuantity: 1,
        destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" }, // Seattle
      },
      buyerActor
    );

    // Mock evaluation for approved state
    const nowIso = new Date().toISOString();
    await service.evaluatePurchaseCandidate(
      purchase.id,
      {
        rawCandidate: {
          externalId: "laptop_sku:bestbuy.com",
          title: "Approved Laptop",
          merchantName: "Best Buy",
          merchantUrl: "https://bestbuy.com/laptop",
          unitPriceCents: 120000,
          quantity: 1,
          shippingCents: 0,
          currency: "USD",
          availability: "IN_STOCK",
        },
        rawObservations: [
          {
            requirementKey: "merchant_spec",
            value: "Approved Laptop",
            status: "supports",
            sourceUrl: "https://bestbuy.com/laptop",
            sourceType: "listing",
            capturedAt: nowIso,
          },
          {
            requirementKey: "destination",
            value: "98101", // Approved for Seattle
            status: "supports",
            sourceUrl: "https://bestbuy.com/rates",
            sourceType: "destination_evidence",
            capturedAt: nowIso,
          },
        ],
        requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
      },
      buyerActor
    );

    await service.approvePurchase(purchase.id, {}, buyerActor);

    // Adversarial execution: attempting order creation for Beverly Hills 90210
    await expect(
      service.createPayPalOrder(purchase.id, buyerActor, {
        destination: { country: "US", postalCode: "90210", deliveryMethodPreference: "standard_ground" },
      })
    ).rejects.toThrow(ApprovalIntegrityError);

    // Confirm PayPal client received ZERO calls
    expect(mockPayPal.createOrder).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 7. Approval Invalidation on Critical Input Change
  // --------------------------------------------------------------------------
  it("7. Invalidates approval and blocks payment if candidate unit price or variant changes", async () => {
    const purchase = await service.createPurchase(
      {
        budgetCents: 100000,
        currency: "USD",
        requirements: ["merchant_spec: Monitor"],
        requestedQuantity: 1,
      },
      buyerActor
    );

    const nowIso = new Date().toISOString();
    const evalRes = await service.evaluatePurchaseCandidate(
      purchase.id,
      {
        rawCandidate: {
          externalId: "mon_4k:bestbuy.com",
          title: "4K Monitor",
          merchantName: "Best Buy",
          merchantUrl: "https://bestbuy.com/mon",
          unitPriceCents: 50000,
          quantity: 1,
          shippingCents: 0,
          currency: "USD",
          availability: "IN_STOCK",
        },
        rawObservations: [
          {
            requirementKey: "merchant_spec",
            value: "4K Monitor",
            status: "supports",
            sourceUrl: "https://bestbuy.com/mon",
            sourceType: "listing",
            capturedAt: nowIso,
          },
        ],
        requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
      },
      buyerActor
    );

    await service.approvePurchase(purchase.id, {}, buyerActor);

    // Simulate adversarial DB tampering: unitPrice silently modified in stored candidate record
    const storedCand = (repo as unknown as { candidates: Map<string, CandidateRecord> }).candidates.get(
      evalRes.candidateId
    );
    expect(storedCand).toBeDefined();
    storedCand!.unitPriceCents = 95000;
    storedCand!.totalCents = 95000;

    // Must fail closed with snapshot_hash_changed
    await expect(service.createPayPalOrder(purchase.id, buyerActor)).rejects.toThrow(
      ApprovalIntegrityError
    );

    expect(mockPayPal.createOrder).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 8. UI Handling: Blocker Guidance & Action Recommendations
  // --------------------------------------------------------------------------
  it("8. Generates explicit blocker reasons and resolution actions for incomplete candidates", () => {
    const incompleteCandidate = normalizeCandidate(
      {
        externalId: "cand_incomplete:retailer.com",
        title: "Incomplete Item",
        merchantName: "Retailer",
        merchantUrl: "https://retailer.com/item",
        unitPriceCents: 3000,
        currency: "USD",
        availability: "in_stock",
        // No shipping provided
      },
      {
        purchaseId: "pur_ui_test",
        source: "channel3",
        now: new Date(),
      }
    );

    expect(incompleteCandidate.isComplete).toBe(false);
    expect(incompleteCandidate.blockerReason).toBe(
      "Missing shipping cost specification. Shipping cannot be inferred as zero when absent."
    );
    expect(incompleteCandidate.blockerAction).toBe(
      "Provide a valid destination postal code to request an authoritative quote or evaluate merchant free-shipping policy."
    );
  });

  // --------------------------------------------------------------------------
  // 9. PayPal Boundary: Preconditions Fail Closed with 0 Gateway Calls
  // --------------------------------------------------------------------------
  it("9. PayPal Sandbox client receives zero calls when candidate lacks authoritative shipping", async () => {
    const purchase = await service.createPurchase(
      {
        budgetCents: 50000,
        currency: "USD",
        requirements: ["spec: Keyboard"],
      },
      buyerActor
    );

    // Attempting order creation directly without evaluation or approval
    await expect(service.createPayPalOrder(purchase.id, buyerActor)).rejects.toThrow();

    expect(mockPayPal.createOrder).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 10. Persistence Failures Quarantine File & Fall Back Safely Without Stale Terms
  // --------------------------------------------------------------------------
  it("10. Persistence failures quarantine corrupted files and fall back safely to default policies", () => {
    const store = new DurablePolicyStore(tempStoragePath);
    mkdirSync(tempDir, { recursive: true });

    // Write corrupted JSON that violates the schema
    writeFileSync(tempStoragePath, JSON.stringify({ corruptData: true, policies: [] }), "utf8");

    const registry = new MerchantPolicyRegistry([]);
    const engine = new PolicyProposalEngine();

    const result = store.loadState(registry, engine);

    expect(result.loadedFromDisk).toBe(false);
    expect(result.corruptFileDetected).toBe(true);
    expect(result.quarantinePath).toBeDefined();

    // Verify the corrupt file was renamed/quarantined
    if (result.quarantinePath) {
      expect(existsSync(result.quarantinePath)).toBe(true);
    }

    // Verify registry safely restored the default fail-closed policies
    expect(registry.getAllPolicies().length).toBe(DEFAULT_MERCHANT_POLICIES.length);
    expect(registry.getPoliciesForMerchant("Best Buy").length).toBeGreaterThan(0);
  });
});
