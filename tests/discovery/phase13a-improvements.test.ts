import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Channel3SourceAdapter } from "../../lib/discovery/channel3-adapter";
import {
  computeDuplicateGroupKey,
  summarizeCandidateSpecifications,
  normalizeCandidate,
} from "../../lib/discovery/normalize";
import {
  BestBuyShippingQuoteAdapter,
  getShippingQuoteAdapter,
  setShippingQuoteAdapter,
  ShippingQuoteAdapter,
  ShippingQuoteRequest,
  ShippingQuoteResult,
  computeQuoteFingerprint,
} from "../../lib/discovery/shipping-quote";
import { PaymentVerificationService } from "../../lib/paypal/verification";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { PayPalApiError } from "../../lib/paypal/types";
import { Actor, Currency } from "../../lib/state/types";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

describe("Phase 13A — Real Evidence Integration & Procurement Workflow Advancement", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");

  // 1. Gate 1 Baseline Integrity Verification
  describe("Gate 1 Baseline Preservation", () => {
    it("preserves Gate 1 script integrity exactly", () => {
      const gate1Path = "C:\\paypal-gate1\\gate1.mjs";
      const fileBytes = readFileSync(gate1Path);
      const computedHash = createHash("sha256").update(fileBytes).digest("hex").toUpperCase();
      const expectedHash = "F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451";
      expect(computedHash).toBe(expectedHash);
    });
  });

  // 2. Candidate Duplicate Detection & Grouping
  describe("Candidate Duplicate Detection and Grouping", () => {
    it("computes deterministic duplicate group keys for offers of the same product", () => {
      const key1 = computeDuplicateGroupKey({
        merchantName: "Best Buy",
        merchantUrl: "https://www.bestbuy.com/site/dell-xps-15/6534567.p",
        title: "Dell XPS 15 9530 Laptop - Intel Core i7 - 16GB RAM",
      });

      const key2 = computeDuplicateGroupKey({
        merchantName: "Best Buy Co.",
        merchantUrl: "https://bestbuy.com/site/dell-xps-15/6534567.p",
        title: "Dell XPS 15 9530 Laptop - Intel Core i7 - 16GB RAM",
      });

      // Same canonical URL and title yields matching duplicate group key
      expect(key1).toBe(key2);
    });

    it("distinguishes different products with similar titles into different duplicate groups", () => {
      // Products with similar initial words but different items (e.g. Headphones vs Case)
      const keyHeadphones = computeDuplicateGroupKey({
        merchantName: "Best Buy",
        merchantUrl: "https://bestbuy.com/site/sony-wh1000xm5-headphones/111.p",
        title: "Sony WH-1000XM5 Wireless Noise-Canceling Headphones - Black",
      });

      const keyCase = computeDuplicateGroupKey({
        merchantName: "Best Buy",
        merchantUrl: "https://bestbuy.com/site/sony-wh1000xm5-case/222.p",
        title: "Sony WH-1000XM5 Wireless Noise-Canceling Headphones Case - Black",
      });

      expect(keyHeadphones).not.toBe(keyCase);

      // Model size distinctions (11-inch vs 13-inch)
      const keyIpad11 = computeDuplicateGroupKey({
        merchantName: "Apple",
        merchantUrl: "https://apple.com/shop/buy-ipad/ipad-pro-11",
        title: "Apple iPad Pro 11-inch M4 chip 256GB Space Black",
      });

      const keyIpad13 = computeDuplicateGroupKey({
        merchantName: "Apple",
        merchantUrl: "https://apple.com/shop/buy-ipad/ipad-pro-13",
        title: "Apple iPad Pro 13-inch M4 chip 256GB Space Black",
      });

      expect(keyIpad11).not.toBe(keyIpad13);
    });

    it("distinguishes different variants identified via URL query parameters", () => {
      const keyVariantA = computeDuplicateGroupKey({
        merchantName: "Google Store",
        merchantUrl: "https://store.google.com/product/pixel_9?variant=hazel_128",
        title: "Google Pixel 9",
      });

      const keyVariantB = computeDuplicateGroupKey({
        merchantName: "Google Store",
        merchantUrl: "https://store.google.com/product/pixel_9?variant=obsidian_256",
        title: "Google Pixel 9",
      });

      expect(keyVariantA).not.toBe(keyVariantB);
    });

    it("normalizes merchant aliases and strips corporate legal entity suffixes", () => {
      const keyBestBuy = computeDuplicateGroupKey({
        merchantName: "Best Buy",
        merchantUrl: "https://bestbuy.com/site/dell-xps/6534567.p",
        title: "Dell XPS 15",
      });

      const keyBestBuyInc = computeDuplicateGroupKey({
        merchantName: "Best Buy, Inc.",
        merchantUrl: "https://www.bestbuy.com/site/dell-xps/6534567.p",
        title: "Dell XPS 15",
      });

      const keyBestBuyLLC = computeDuplicateGroupKey({
        merchantName: "Best Buy Co., LLC",
        merchantUrl: "https://bestbuy.com/site/dell-xps/6534567.p",
        title: "Dell XPS 15",
      });

      expect(keyBestBuy).toBe(keyBestBuyInc);
      expect(keyBestBuy).toBe(keyBestBuyLLC);
    });

    it("strips URL tracking parameters while preserving canonical identity", () => {
      const keyWithTracking = computeDuplicateGroupKey({
        merchantName: "Best Buy",
        merchantUrl: "https://www.bestbuy.com/site/dell-xps/6534567.p?skuId=6534567&utm_source=google&utm_medium=cpc&utm_campaign=laptops&gclid=xyz987",
        title: "Dell XPS 15",
      });

      const keyClean = computeDuplicateGroupKey({
        merchantName: "Best Buy",
        merchantUrl: "https://bestbuy.com/site/dell-xps/6534567.p/?skuId=6534567&ref=affiliate&fbclid=abc123",
        title: "Dell XPS 15",
      });

      expect(keyWithTracking).toBe(keyClean);
    });

    it("handles missing or empty identifiers safely without throwing", () => {
      expect(() => {
        computeDuplicateGroupKey({});
      }).not.toThrow();

      expect(() => {
        computeDuplicateGroupKey({ merchantName: "", merchantUrl: "", title: "", externalId: "" });
      }).not.toThrow();

      const key1 = computeDuplicateGroupKey({ externalId: "ext_item_1" });
      const key2 = computeDuplicateGroupKey({ externalId: "ext_item_2" });
      expect(key1).not.toBe(key2);
    });

    it("tags secondary listings as duplicates pointing to canonical external ID in Channel3SourceAdapter", async () => {
      const mockSearchFn = vi.fn().mockResolvedValue({
        products: [
          {
            id: "prod_dell_xps",
            title: "Dell XPS 15 Laptop",
            offers: [
              {
                domain: "bestbuy.com",
                url: "https://bestbuy.com/products/dell-xps-15-a",
                price: { price: 1199.99, currency: "USD" },
                availability: "instock",
              },
              {
                domain: "bestbuy.com",
                url: "https://bestbuy.com/products/dell-xps-15-a", // Identical offer URL
                price: { price: 1199.99, currency: "USD" },
                availability: "instock",
              },
            ],
          },
        ],
      });

      const adapter = new Channel3SourceAdapter({ searchFn: mockSearchFn });
      const result = await adapter.search(
        { query: "laptop", purchaseId: "pur_test_dup" },
        { now }
      );

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.candidates.length).toBe(1); // Seen external IDs deduplicated at offer level
        expect(result.candidates[0].duplicateInfo).toBeDefined();
        expect(result.candidates[0].duplicateInfo?.isDuplicate).toBe(false);
      }
    });
  });

  // 3. Specification Classification & Provenance
  describe("Candidate Specification Breakdown & Provenance", () => {
    it("categorizes known, inferred, and missing attributes accurately", () => {
      const rawAttrs = {
        ram: "16 GB",
        storage: "512 GB SSD",
        inferred_gpu: "RTX 4050",
        brand: "Dell",
      };

      const summary = summarizeCandidateSpecifications(rawAttrs, ["ram", "storage", "cpu"]);
      expect(summary.known.ram).toBe("16 GB");
      expect(summary.known.storage).toBe("512 GB SSD");
      expect(summary.known.brand).toBe("Dell");
      expect(summary.inferred.inferred_gpu).toBe("RTX 4050");
      expect(summary.missing).toContain("cpu");
      expect(summary.missing).not.toContain("ram");
    });

    it("ensures inferred values never satisfy required specifications as verified facts", () => {
      const rawAttrs = {
        title: "Gaming Laptop",
        inferred_ram: "32 GB",
        unverified_battery: "99 Wh",
      };

      // Requirements include "ram" and "battery". Since they are only inferred, they MUST remain in missing.
      const summary = summarizeCandidateSpecifications(rawAttrs, ["ram", "battery"]);
      expect(summary.known.ram).toBeUndefined();
      expect(summary.inferred.inferred_ram).toBe("32 GB");
      expect(summary.inferred.unverified_battery).toBe("99 Wh");
      expect(summary.missing).toContain("ram");
      expect(summary.missing).toContain("battery");
    });
  });

  // 4. Destination-Aware Shipping Quote Enrichment & Validation
  describe("Destination-Aware Shipping Quote Enrichment & Hardening", () => {
    let originalAdapter: ShippingQuoteAdapter;

    beforeEach(() => {
      originalAdapter = getShippingQuoteAdapter();
    });

    afterEach(() => {
      setShippingQuoteAdapter(originalAdapter);
    });

    it("attaches authoritative shipping quote when destination is supplied and provider succeeds", async () => {
      const mockQuoteAdapter: ShippingQuoteAdapter = {
        name: "mock_quote_adapter",
        supportedRetailers: ["bestbuy.com"],
        canQuote: () => true,
        getShippingQuote: async (req: ShippingQuoteRequest): Promise<ShippingQuoteResult> => {
          const baseQuote = {
            status: "success" as const,
            quoteId: "quote_test_bb_98101",
            amountCents: 1299,
            currency: "USD" as Currency,
            retailerId: "bestbuy.com",
            merchantDomain: "bestbuy.com",
            externalId: req.candidate.externalId,
            destinationPostalCode: req.destination.postalCode,
            destinationCountry: "US" as const,
            deliveryMethod: "standard_ground",
            quotedAt: req.now.toISOString(),
            expiresAt: new Date(req.now.getTime() + 3600000).toISOString(),
            sourceUrl: "https://api.bestbuy.com/v1/rates/quote_test_bb_98101",
          };
          return {
            ...baseQuote,
            quoteFingerprint: computeQuoteFingerprint(baseQuote),
          };
        },
      };

      setShippingQuoteAdapter(mockQuoteAdapter);

      const mockSearchFn = vi.fn().mockResolvedValue({
        products: [
          {
            id: "prod_bb_1",
            title: "Asus ZenBook 14",
            offers: [
              {
                domain: "bestbuy.com",
                url: "https://bestbuy.com/zenbook",
                price: { price: 899.99, currency: "USD" },
                availability: "instock",
              },
            ],
          },
        ],
      });

      const adapter = new Channel3SourceAdapter({ searchFn: mockSearchFn });
      const result = await adapter.search(
        {
          query: "zenbook",
          purchaseId: "pur_test_quote",
          constraints: {
            destination: {
              country: "US",
              postalCode: "98101",
              deliveryMethodPreference: "standard_ground",
            },
          },
        },
        { now }
      );

      expect(result.status).toBe("success");
      if (result.status === "success") {
        const cand = result.candidates[0];
        expect(cand.shippingCents).toBe(1299);
        expect(cand.shippingDetails?.isAuthoritative).toBe(true);
        expect(cand.shippingDetails?.destinationPostalCode).toBe("98101");
        expect(cand.shippingDetails?.sourceVerificationTimestamp).toBe(now.toISOString());
        expect(cand.isComplete).toBe(true);
        expect(cand.snapshotHash).toHaveLength(64);
      }
    });

    it("rejects expired quotes from quote adapter and prevents treating as free shipping", async () => {
      // Mock quote adapter returning a quote that expired 5 minutes ago
      const expiredQuoteAdapter: ShippingQuoteAdapter = {
        name: "mock_expired_adapter",
        supportedRetailers: ["bestbuy.com"],
        canQuote: () => true,
        getShippingQuote: async (req: ShippingQuoteRequest): Promise<ShippingQuoteResult> => {
          const baseQuote = {
            status: "success" as const,
            quoteId: "quote_expired",
            amountCents: 1500,
            currency: "USD" as Currency,
            retailerId: "bestbuy.com",
            merchantDomain: "bestbuy.com",
            externalId: req.candidate.externalId,
            destinationPostalCode: req.destination.postalCode,
            destinationCountry: "US" as const,
            deliveryMethod: "standard_ground",
            quotedAt: new Date(req.now.getTime() - 7200000).toISOString(),
            expiresAt: new Date(req.now.getTime() - 300000).toISOString(), // Expired!
            sourceUrl: "https://api.bestbuy.com/v1/rates/quote_expired",
          };
          return {
            ...baseQuote,
            quoteFingerprint: computeQuoteFingerprint(baseQuote),
          };
        },
      };

      setShippingQuoteAdapter(expiredQuoteAdapter);

      const mockSearchFn = vi.fn().mockResolvedValue({
        products: [
          {
            id: "prod_bb_expired",
            title: "Lenovo ThinkPad",
            offers: [
              {
                domain: "bestbuy.com",
                url: "https://bestbuy.com/thinkpad",
                price: { price: 999.99, currency: "USD" },
                availability: "instock",
              },
            ],
          },
        ],
      });

      const adapter = new Channel3SourceAdapter({ searchFn: mockSearchFn });
      const result = await adapter.search(
        {
          query: "thinkpad",
          purchaseId: "pur_test_expired",
          constraints: {
            destination: {
              country: "US",
              postalCode: "98101",
              deliveryMethodPreference: "standard_ground",
            },
          },
        },
        { now }
      );

      expect(result.status).toBe("success");
      if (result.status === "success") {
        const cand = result.candidates[0];
        // Must fail closed: incomplete, shippingDetails missing, blocker documented
        expect(cand.isComplete).toBe(false);
        expect(cand.shippingDetails?.type).toBe("missing");
        expect(cand.shippingDetails?.isAuthoritative).toBe(false);
        const rawAttrs = cand.rawSourceData.rawAttributes as Record<string, unknown>;
        expect(rawAttrs).toHaveProperty("shipping_blocker_status", "quote_validation_failed");
        expect(rawAttrs?.shipping_blocker_reason).toContain("expired");
        expect(cand.validationErrors).toContain(
          "Missing shipping cost specification. Shipping cannot be inferred as zero when absent."
        );
      }
    });

    it("rejects quotes with mismatched destination postal code", async () => {
      // Mock quote adapter returning quote for 90210 when 98101 was requested
      const mismatchAdapter: ShippingQuoteAdapter = {
        name: "mock_mismatch_adapter",
        supportedRetailers: ["bestbuy.com"],
        canQuote: () => true,
        getShippingQuote: async (req: ShippingQuoteRequest): Promise<ShippingQuoteResult> => {
          const baseQuote = {
            status: "success" as const,
            quoteId: "quote_mismatch",
            amountCents: 999,
            currency: "USD" as Currency,
            retailerId: "bestbuy.com",
            merchantDomain: "bestbuy.com",
            externalId: req.candidate.externalId,
            destinationPostalCode: "90210", // Mismatch!
            destinationCountry: "US" as const,
            deliveryMethod: "standard_ground",
            quotedAt: req.now.toISOString(),
            expiresAt: new Date(req.now.getTime() + 3600000).toISOString(),
            sourceUrl: "https://api.bestbuy.com/v1/rates/quote_mismatch",
          };
          return {
            ...baseQuote,
            quoteFingerprint: computeQuoteFingerprint(baseQuote),
          };
        },
      };

      setShippingQuoteAdapter(mismatchAdapter);

      const mockSearchFn = vi.fn().mockResolvedValue({
        products: [
          {
            id: "prod_bb_mismatch",
            title: "HP Pavilion",
            offers: [
              {
                domain: "bestbuy.com",
                url: "https://bestbuy.com/hp-pavilion",
                price: { price: 699.99, currency: "USD" },
                availability: "instock",
              },
            ],
          },
        ],
      });

      const adapter = new Channel3SourceAdapter({ searchFn: mockSearchFn });
      const result = await adapter.search(
        {
          query: "hp pavilion",
          purchaseId: "pur_test_mismatch",
          constraints: {
            destination: {
              country: "US",
              postalCode: "98101",
              deliveryMethodPreference: "standard_ground",
            },
          },
        },
        { now }
      );

      expect(result.status).toBe("success");
      if (result.status === "success") {
        const cand = result.candidates[0];
        expect(cand.isComplete).toBe(false);
        expect(cand.shippingDetails?.type).toBe("missing");
        const rawAttrs = cand.rawSourceData.rawAttributes as Record<string, unknown>;
        expect(rawAttrs?.shipping_blocker_reason).toContain("does not match requested destination");
      }
    });

    it("retains typed unavailable status when partner credentials are unconfigured without guessing free shipping", async () => {
      const unconfiguredAdapter = new BestBuyShippingQuoteAdapter();
      setShippingQuoteAdapter(unconfiguredAdapter);

      const mockSearchFn = vi.fn().mockResolvedValue({
        products: [
          {
            id: "prod_bb_2",
            title: "Dell Inspiron 16",
            offers: [
              {
                domain: "bestbuy.com",
                url: "https://bestbuy.com/inspiron",
                price: { price: 749.99, currency: "USD" },
                availability: "instock",
              },
            ],
          },
        ],
      });

      const adapter = new Channel3SourceAdapter({ searchFn: mockSearchFn });
      const result = await adapter.search(
        {
          query: "inspiron",
          purchaseId: "pur_test_unavail",
          constraints: {
            destination: {
              country: "US",
              postalCode: "90210",
              deliveryMethodPreference: "standard_ground",
            },
          },
        },
        { now }
      );

      expect(result.status).toBe("success");
      if (result.status === "success") {
        const cand = result.candidates[0];
        expect(cand.isComplete).toBe(false);
        expect(cand.shippingDetails?.type).toBe("missing");
        expect(cand.shippingDetails?.isAuthoritative).toBe(false);
        // Blocker reason preserved in raw attributes for auditability
        expect(cand.rawSourceData.rawAttributes).toHaveProperty("shipping_blocker_status", "unavailable");
        expect(cand.validationErrors).toContain(
          "Missing shipping cost specification. Shipping cannot be inferred as zero when absent."
        );
      }
    });
  });

  // 5. Freshness & Timestamp Provenance
  describe("Freshness & Timestamp Provenance", () => {
    it("never labels an observation timestamp as a provider-verified quote timestamp", () => {
      const crawlTime = new Date("2026-10-25T10:00:00.000Z");

      // Candidate with only crawl/observation time (no verified quote timestamp)
      const cand = normalizeCandidate(
        {
          externalId: "ext_test_fresh",
          title: "Test Item",
          merchantName: "Merchant",
          merchantUrl: "https://merchant.com/item",
          unitPriceCents: 5000,
          currency: "USD",
          availability: "in_stock",
          shippingCents: 500,
          capturedAt: crawlTime.toISOString(),
          // sourceVerificationTimestamp is intentionally absent
        },
        {
          purchaseId: "pur_test_fresh",
          source: "seeded",
          now,
        }
      );

      // Verify that shippingDetails sourceVerificationTimestamp is null
      expect(cand.shippingDetails?.sourceVerificationTimestamp).toBeNull();
      // Observation timestamp is recorded
      expect(cand.shippingDetails?.observationTimestamp).toBe(now.toISOString());
    });

    it("records verified quote timestamp strictly when provided by authoritative provider", () => {
      const quoteTime = "2026-10-28T11:45:00.000Z";

      const cand = normalizeCandidate(
        {
          externalId: "ext_test_verified_quote",
          title: "Test Item with Verified Quote",
          merchantName: "Merchant",
          merchantUrl: "https://merchant.com/item",
          unitPriceCents: 5000,
          currency: "USD",
          availability: "in_stock",
          shippingCents: 850,
          shippingType: "quoted",
          destinationPostalCode: "98101",
          capturedAt: now.toISOString(),
          sourceVerificationTimestamp: quoteTime,
        },
        {
          purchaseId: "pur_test_verified",
          source: "seeded",
          now,
        }
      );

      expect(cand.shippingDetails?.isAuthoritative).toBe(true);
      expect(cand.shippingDetails?.sourceVerificationTimestamp).toBe(quoteTime);
    });
  });

  // 6. PayPal Sandbox HTTP 404 Recovery & Invariant Preservation
  describe("PayPal Sandbox Verification 404 Recovery & Safety Invariants", () => {
    let repo: InMemoryPurchaseRepository;
    let workflowService: PurchaseWorkflowService;
    let verificationService: PaymentVerificationService;
    let mockPayPalClient: PayPalSandboxClient;

    const userActor: Actor = { kind: "user", userId: "usr_buyer_13a" };
    const sysActor: Actor = { kind: "system", component: "sys_13a" };

    beforeEach(() => {
      repo = new InMemoryPurchaseRepository();

      mockPayPalClient = {
        getAccessToken: vi.fn().mockResolvedValue("mock_token"),
        createOrder: vi.fn().mockResolvedValue({
          id: "PAYPAL_EXP_ORDER_404",
          status: "CREATED",
          links: [
            {
              href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_EXP_ORDER_404",
              rel: "approve",
              method: "GET",
            },
          ],
        }),
        getOrder: vi.fn(),
        clearCachedToken: vi.fn(),
      } as unknown as PayPalSandboxClient;

      workflowService = new PurchaseWorkflowService(repo, mockPayPalClient);
      verificationService = new PaymentVerificationService(repo, mockPayPalClient);
    });

    it("handles remote 404 safely with REMOTE_NOT_FOUND outcome, updates attempt record, and preserves local audit history", async () => {
      // Setup purchase in APPROVED state
      const purchase = await workflowService.createPurchase(
        {
          budgetCents: 15000,
          currency: "USD",
          requirements: ["laptop_spec"],
          destination: { country: "US", postalCode: "98101", deliveryMethodPreference: "standard_ground" },
        },
        userActor
      );

      await workflowService.evaluatePurchaseCandidate(
        purchase.id,
        {
          rawCandidate: {
            externalId: "ext_dell_404",
            title: "Dell XPS 15",
            merchantName: "Dell",
            merchantUrl: "https://dell.com/xps",
            unitPriceCents: 12000,
            quantity: 1,
            shippingCents: 1000,
            destinationPostalCode: "98101",
            currency: "USD",
            availability: "IN_STOCK",
          },
          rawObservations: [
            {
              requirementKey: "laptop_spec",
              value: "pass",
              status: "supports",
              sourceUrl: "https://dell.com/xps",
              sourceType: "feed",
              capturedAt: now.toISOString(),
            },
          ],
          requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
        },
        sysActor,
        now
      );

      const postEval = await repo.getPurchaseById(purchase.id);
      const cand = postEval?.candidates[0];

      await workflowService.approvePurchase(
        purchase.id,
        {
          expectedSnapshotHash: cand?.snapshotHash,
          expectedTotalCents: 13000,
          expectedCurrency: "USD",
          expectedVersion: postEval?.purchase.version,
        },
        userActor,
        now
      );

      // Create order
      await workflowService.createPayPalOrder(purchase.id, userActor, { idempotencyKey: "idemp_404_test" });

      // Mock PayPal returning HTTP 404 (RESOURCE_NOT_FOUND - expired sandbox order)
      vi.mocked(mockPayPalClient.getOrder).mockRejectedValueOnce(
        new PayPalApiError(404, "RESOURCE_NOT_FOUND", "Specified resource ID was not found", "debug_404_id")
      );

      // Independently verify
      const result = await verificationService.verifyPayment(purchase.id, userActor);

      expect(result.verified).toBe(false);
      expect(result.outcome).toBe("REMOTE_NOT_FOUND");
      expect(result.remoteStatus).toBe("NOT_FOUND");
      expect(result.message).toContain("HTTP 404");
      expect(result.details?.historicalAuditPreserved).toBe(true);

      // Check database state: payment attempt record was updated with NOT_FOUND verifiedStatus
      const current = await repo.getPurchaseById(purchase.id);
      expect(current?.purchase.status).toBe("ORDER_CREATED"); // Never advances to COMPLETED or changes status
      const attempt = current?.paymentAttempts.find((a) => a.paypalOrderId === "PAYPAL_EXP_ORDER_404");
      expect(attempt?.verifiedStatus).toBe("NOT_FOUND");
      expect(attempt?.failureReason).toBe("remote_order_not_found");

      // Verify audit history is preserved and accessible
      const audit = await repo.getAuditHistory(purchase.id);
      expect(audit.length).toBeGreaterThan(0);

      // Verify calling createPayPalOrder after 404 does NOT create a duplicate order
      const idempotentOrder = await workflowService.createPayPalOrder(purchase.id, userActor);
      expect(idempotentOrder.paypalOrderId).toBe("PAYPAL_EXP_ORDER_404");
      expect(mockPayPalClient.createOrder).toHaveBeenCalledTimes(1); // Exactly 1 call, zero duplicates!
    });
  });
});
