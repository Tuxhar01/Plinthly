import { describe, expect, it } from "vitest";
import {
  ALLOWLISTED_POLICY_URLS,
  PolicyFetchError,
  PolicySourceFetcher,
} from "../../lib/discovery/policy-ingestion/fetcher";
import { PolicyExtractor } from "../../lib/discovery/policy-ingestion/extractor";
import { PolicyProposalEngine } from "../../lib/discovery/policy-ingestion/proposal-engine";
import { CartShippingEngine } from "../../lib/discovery/policy-ingestion/cart-engine";
import {
  MerchantPolicyRegistry,
  DEFAULT_MERCHANT_POLICIES,
} from "../../lib/discovery/merchant-policy-registry";
import {
  PolicyExtractionResult,
  PolicySourceRecord,
  CartShippingContext,
} from "../../lib/discovery/policy-ingestion/types";
import { deriveInvalidationReasons } from "../../lib/state/approval";
import { ApprovalFacts, PurchaseState } from "../../lib/state/types";

describe("Phase 13C — Merchant Policy Ingestion, Versioning, and Cart Monitoring", () => {
  // --------------------------------------------------------------------------
  // 1. Safe Source Fetcher & Allowlist Security
  // --------------------------------------------------------------------------
  describe("PolicySourceFetcher — Allowlist & Safe Ingestion", () => {
    it("refuses non-HTTPS schemes", async () => {
      const fetcher = new PolicySourceFetcher();
      await expect(
        fetcher.fetchSource("http://www.bestbuy.com/site/help-topics/shipping")
      ).rejects.toThrow(PolicyFetchError);

      try {
        await fetcher.fetchSource("http://www.bestbuy.com/site/help-topics/shipping");
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyFetchError);
        expect((err as PolicyFetchError).code).toBe("insecure_scheme");
      }
    });

    it("refuses unapproved retailer URLs outside allowlist", async () => {
      const fetcher = new PolicySourceFetcher();
      await expect(
        fetcher.fetchSource("https://malicious-retailer.com/free-shipping")
      ).rejects.toThrow(PolicyFetchError);

      try {
        await fetcher.fetchSource("https://malicious-retailer.com/free-shipping");
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyFetchError);
        expect((err as PolicyFetchError).code).toBe("disallowed_url");
      }
    });

    it("successfully fetches an allowlisted URL and hashes raw content with SHA-256", async () => {
      const mockHtml = "<html><body><h1>Best Buy Free Shipping on orders $35 and up</h1></body></html>";
      const mockFetch = async () =>
        new Response(mockHtml, {
          status: 200,
          headers: {
            "Content-Type": "text/html",
            "ETag": '"abc123etag"',
            "Last-Modified": "Wed, 28 Oct 2026 12:00:00 GMT",
          },
        });

      const fetcher = new PolicySourceFetcher({ fetchFn: mockFetch as unknown as typeof fetch });
      const record = await fetcher.fetchSource(ALLOWLISTED_POLICY_URLS[0]);

      expect(record.httpStatus).toBe(200);
      expect(record.etag).toBe('"abc123etag"');
      expect(record.lastModified).toBe("Wed, 28 Oct 2026 12:00:00 GMT");
      expect(record.rawContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(record.isNotModified).toBe(false);
      expect(record.contentLength).toBe(mockHtml.length);
    });

    it("handles HTTP 304 Not Modified correctly with conditional headers", async () => {
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        if (headers?.["If-None-Match"] === '"matching-etag"') {
          return new Response(null, { status: 304 });
        }
        return new Response("content", { status: 200 });
      };

      const fetcher = new PolicySourceFetcher({ fetchFn: mockFetch as unknown as typeof fetch });
      const record = await fetcher.fetchSource(ALLOWLISTED_POLICY_URLS[0], {
        etag: '"matching-etag"',
        previousRawContentHash: "priorhash123",
      });

      expect(record.httpStatus).toBe(304);
      expect(record.isNotModified).toBe(true);
      expect(record.rawContentHash).toBe("priorhash123");
      expect(record.contentLength).toBe(0);
    });

    it("handles HTTP 404 page removal without crashing", async () => {
      const mockFetch = async () => new Response("Not Found", { status: 404 });
      const fetcher = new PolicySourceFetcher({ fetchFn: mockFetch as unknown as typeof fetch });
      const record = await fetcher.fetchSource(ALLOWLISTED_POLICY_URLS[0]);

      expect(record.httpStatus).toBe(404);
      expect(record.isNotModified).toBe(false);
      expect(record.rawContentHash).toBe("");
    });

    it("rejects responses that exceed the bounded size limit", async () => {
      const largeContent = "x".repeat(3000);
      const mockFetch = async () =>
        new Response(largeContent, {
          status: 200,
          headers: { "Content-Length": "3000" },
        });

      const fetcher = new PolicySourceFetcher({ fetchFn: mockFetch as unknown as typeof fetch });
      await expect(
        fetcher.fetchSource(ALLOWLISTED_POLICY_URLS[0], { maxBytes: 2000 })
      ).rejects.toThrow(PolicyFetchError);

      try {
        await fetcher.fetchSource(ALLOWLISTED_POLICY_URLS[0], { maxBytes: 2000 });
      } catch (err) {
        expect((err as PolicyFetchError).code).toBe("response_too_large");
      }
    });

    it("rejects redirects that point to hosts outside the allowlist", async () => {
      const mockResponse = new Response("redirected", { status: 200 });
      Object.defineProperty(mockResponse, "url", { value: "https://disallowed-hijack.com/policy" });
      const mockFetch = async () => mockResponse;

      const fetcher = new PolicySourceFetcher({ fetchFn: mockFetch as unknown as typeof fetch });
      await expect(fetcher.fetchSource(ALLOWLISTED_POLICY_URLS[0])).rejects.toThrow(PolicyFetchError);

      try {
        await fetcher.fetchSource(ALLOWLISTED_POLICY_URLS[0]);
      } catch (err) {
        expect((err as PolicyFetchError).code).toBe("disallowed_redirect");
      }
    });

    it("times out using AbortController on hanging connections", async () => {
      const hangingFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        });
      };

      const fetcher = new PolicySourceFetcher({ fetchFn: hangingFetch as unknown as typeof fetch });
      await expect(
        fetcher.fetchSource(ALLOWLISTED_POLICY_URLS[0], { timeoutMs: 30 })
      ).rejects.toThrow(PolicyFetchError);

      try {
        await fetcher.fetchSource(ALLOWLISTED_POLICY_URLS[0], { timeoutMs: 30 });
      } catch (err) {
        expect((err as PolicyFetchError).code).toBe("fetch_timeout");
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Policy Extraction & Ambiguity Detection
  // --------------------------------------------------------------------------
  describe("PolicyExtractor — Retailer Parsing & Ambiguity Detection", () => {
    const extractor = new PolicyExtractor();

    it("extracts Best Buy $35 free shipping terms from HTML fixture", () => {
      const html = `
        <div>
          <h1>Best Buy Shipping & Delivery</h1>
          <p>Get Free standard shipping on orders $35 and up. Excludes marketplace sellers and scheduled delivery.</p>
        </div>
      `;
      const res = extractor.extract(html, ALLOWLISTED_POLICY_URLS[0]);

      expect(res.status).toBe("extracted");
      expect(res.terms?.thresholdCents).toBe(3500);
      expect(res.terms?.merchantDomain).toBe("bestbuy.com");
      expect(res.terms?.requiresDirectRetailerSeller).toBe(true);
      expect(res.terms?.allowedZones).toContain("contiguous_us");
      expect(res.terms?.excludedZones).toContain("alaska");
      expect(res.terms?.excludedZones).toContain("hawaii");
    });

    it("extracts Walmart $35 terms including WFS fulfillment and marketplace contribution", () => {
      const html = `
        <div>
          <h1>Walmart Shipping Rates</h1>
          <p>Orders of $35 or more get free standard shipping when fulfilled by Walmart or Walmart Fulfillment Services (WFS).</p>
          <p>Eligible marketplace items contribute to the $35 order minimum, but independent seller items may have separate shipping.</p>
        </div>
      `;
      const res = extractor.extract(html, ALLOWLISTED_POLICY_URLS[1]);

      expect(res.status).toBe("extracted");
      expect(res.terms?.thresholdCents).toBe(3500);
      expect(res.terms?.merchantDomain).toBe("walmart.com");
      expect(res.terms?.requiresDirectRetailerOrWfsFulfillment).toBe(true);
      expect(res.terms?.marketplaceItemsContributeToThreshold).toBe(true);
    });

    it("extracts Target standard $35 terms including continental states + APO/FPO", () => {
      const html = `
        <div>
          <h1>Target Free Shipping</h1>
          <p>Free standard shipping on orders of $35 or more of qualifying merchandise after discounts and before tax.</p>
          <p>Applies to the 48 continental states and APO/FPO addresses. Excludes Target Plus items, Alaska, and Hawaii.</p>
        </div>
      `;
      const res = extractor.extract(html, ALLOWLISTED_POLICY_URLS[2]);

      expect(res.status).toBe("extracted");
      expect(res.terms?.thresholdCents).toBe(3500);
      expect(res.terms?.merchantDomain).toBe("target.com");
      expect(res.terms?.allowedZones).toEqual(["contiguous_us", "military_apo_fpo"]);
      expect(res.terms?.excludedZones).toEqual(["alaska", "hawaii", "us_territory"]);
      expect(res.terms?.requiresDirectRetailerSeller).toBe(true);
    });

    it("extracts Target Circle Card policy ($0 minimum across all 50 states + APO/FPO)", () => {
      const html = `
        <div>
          <h1>Target Circle Card Free Shipping</h1>
          <p>Target Circle Card holders enjoy free standard shipping on eligible items with no minimum purchase ($0 minimum) to all 50 states and APO/FPO.</p>
        </div>
      `;
      const res = extractor.extract(html, ALLOWLISTED_POLICY_URLS[2], { targetVariant: "circle_card" });

      expect(res.status).toBe("extracted");
      expect(res.terms?.thresholdCents).toBe(0);
      expect(res.terms?.requiresMembership).toBe("target_circle_card");
      expect(res.terms?.allowedZones).toContain("alaska");
      expect(res.terms?.allowedZones).toContain("hawaii");
      expect(res.terms?.allowedZones).toContain("military_apo_fpo");
    });

    it("extracts B&H Expedited ($49 minimum) vs Standard Ground (item-specific qualification)", () => {
      const expeditedHtml = `
        <div>
          <h1>B&H Shipping Options</h1>
          <p>Free Expedited Shipping on orders of $49 or more in the contiguous US.</p>
        </div>
      `;
      const expRes = extractor.extract(expeditedHtml, ALLOWLISTED_POLICY_URLS[3], { targetVariant: "expedited" });
      expect(expRes.status).toBe("extracted");
      expect(expRes.terms?.thresholdCents).toBe(4900);
      expect(expRes.terms?.deliveryMethod).toBe("expedited");

      const standardHtml = `
        <div>
          <h1>B&H Free Standard Shipping</h1>
          <p>Free standard ground shipping on thousands of qualifying items with no order minimum.</p>
        </div>
      `;
      const stdRes = extractor.extract(standardHtml, ALLOWLISTED_POLICY_URLS[3], { targetVariant: "standard" });
      expect(stdRes.status).toBe("extracted");
      expect(stdRes.terms?.thresholdCents).toBe(0);
      expect(stdRes.terms?.itemSpecificQualificationRequired).toBe(true);
    });

    it("detects conflicting thresholds and returns status 'ambiguous' without guessing", () => {
      const ambiguousHtml = `
        <div>
          <h1>Best Buy Free Shipping</h1>
          <p>Get free shipping on orders of $35 or more!</p>
          <p>Special notice: free standard shipping on orders of $50 or more applies to standard deliveries.</p>
        </div>
      `;
      const res = extractor.extract(ambiguousHtml, ALLOWLISTED_POLICY_URLS[0]);

      expect(res.status).toBe("ambiguous");
      expect(res.terms).toBeUndefined();
      expect(res.warnings[0]).toContain("conflicting");
    });

    it("returns 'parse_error' when HTML content is empty or unparseable", () => {
      const emptyHtml = "<html><body>   </body></html>";
      const res = extractor.extract(emptyHtml, ALLOWLISTED_POLICY_URLS[0]);

      expect(res.status).toBe("parse_error");
      expect(res.terms).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Proposal Engine & Human Review Gating
  // --------------------------------------------------------------------------
  describe("PolicyProposalEngine — Safe Change Detection & Review Workflow", () => {
    const proposalEngine = new PolicyProposalEngine();
    const existingBestBuy = DEFAULT_MERCHANT_POLICIES.find((p) => p.merchantDomain === "bestbuy.com")!;

    it("detects unchanged policy on HTTP 304 and maintains 'active' status", () => {
      const sourceRecord: PolicySourceRecord = {
        sourceUrl: existingBestBuy.policySourceUrl,
        retrievedAt: new Date().toISOString(),
        httpStatus: 304,
        etag: '"etag123"',
        lastModified: "Wed, 28 Oct 2026 12:00:00 GMT",
        rawContentHash: existingBestBuy.policyDocumentFingerprint,
        contentLength: 0,
        isNotModified: true,
      };

      const mockExtract: PolicyExtractionResult = {
        status: "extracted",
        parserVersion: "2.0.0",
        warnings: [],
        explanation: "Unchanged source.",
      };

      const proposal = proposalEngine.evaluateIngestion(sourceRecord, mockExtract, existingBestBuy);

      expect(proposal.changeType).toBe("no_change");
      expect(proposal.status).toBe("active");
    });

    it("handles non-material HTML change (identical canonical terms) as active without disruption", () => {
      const sourceRecord: PolicySourceRecord = {
        sourceUrl: existingBestBuy.policySourceUrl,
        retrievedAt: new Date().toISOString(),
        httpStatus: 200,
        etag: '"newetag"',
        lastModified: null,
        rawContentHash: "brand_new_hash_due_to_ad_banner_change",
        contentLength: 1200,
        isNotModified: false,
      };

      const mockExtract: PolicyExtractionResult = {
        status: "extracted",
        parserVersion: "2.0.0",
        warnings: [],
        explanation: "Identical terms extracted.",
        terms: {
          merchantDomain: existingBestBuy.merchantDomain,
          merchantName: existingBestBuy.merchantName,
          deliveryMethod: existingBestBuy.deliveryMethod,
          currency: existingBestBuy.currency,
          thresholdCents: existingBestBuy.thresholdCents,
          shippingCostCents: existingBestBuy.shippingCostCents,
          allowedZones: existingBestBuy.allowedZones,
          excludedZones: existingBestBuy.excludedZones,
          excludedCategories: existingBestBuy.excludedCategories,
          excludedSpecialFulfillmentMethods: existingBestBuy.excludedSpecialFulfillmentMethods,
          requiresDirectRetailerSeller: existingBestBuy.requiresDirectRetailerSeller,
          requiresDirectRetailerOrWfsFulfillment: existingBestBuy.requiresDirectRetailerOrWfsFulfillment,
          marketplaceItemsContributeToThreshold: existingBestBuy.marketplaceItemsContributeToThreshold,
          requiresMembership: existingBestBuy.requiresMembership,
          requiresPreTaxMerchandiseThreshold: existingBestBuy.requiresPreTaxMerchandiseThreshold,
          itemSpecificQualificationRequired: existingBestBuy.itemSpecificQualificationRequired,
        },
      };

      const proposal = proposalEngine.evaluateIngestion(sourceRecord, mockExtract, existingBestBuy);

      expect(proposal.changeType).toBe("content_updated_terms_identical");
      expect(proposal.status).toBe("active");
    });

    it("gates material policy changes (e.g. threshold raised to $45) behind human approval as 'proposed'", () => {
      const sourceRecord: PolicySourceRecord = {
        sourceUrl: existingBestBuy.policySourceUrl,
        retrievedAt: new Date().toISOString(),
        httpStatus: 200,
        etag: null,
        lastModified: null,
        rawContentHash: "hash_material_change",
        contentLength: 1500,
        isNotModified: false,
      };

      const mockExtract: PolicyExtractionResult = {
        status: "extracted",
        parserVersion: "2.0.0",
        warnings: [],
        explanation: "Best Buy threshold increased to $45.",
        terms: {
          merchantDomain: existingBestBuy.merchantDomain,
          merchantName: existingBestBuy.merchantName,
          deliveryMethod: existingBestBuy.deliveryMethod,
          currency: existingBestBuy.currency,
          thresholdCents: 4500, // Raised from 3500 to 4500!
          shippingCostCents: 0,
          allowedZones: existingBestBuy.allowedZones,
          excludedZones: existingBestBuy.excludedZones,
          excludedCategories: existingBestBuy.excludedCategories,
          excludedSpecialFulfillmentMethods: existingBestBuy.excludedSpecialFulfillmentMethods,
          requiresDirectRetailerSeller: true,
          requiresPreTaxMerchandiseThreshold: true,
          itemSpecificQualificationRequired: false,
        },
      };

      const proposal = proposalEngine.evaluateIngestion(sourceRecord, mockExtract, existingBestBuy);

      expect(proposal.changeType).toBe("material_terms_changed");
      expect(proposal.status).toBe("proposed"); // Human review required!
      expect(proposal.proposedPolicy?.thresholdCents).toBe(4500);
      expect(proposal.proposedPolicy?.policyVersion).toBe("2.1.0");
    });

    it("allows human reviewer to approve proposal and publishes new version while superseding old version", () => {
      const registry = new MerchantPolicyRegistry();
      const proposalEngine = new PolicyProposalEngine();

      const sourceRecord: PolicySourceRecord = {
        sourceUrl: existingBestBuy.policySourceUrl,
        retrievedAt: new Date().toISOString(),
        httpStatus: 200,
        etag: null,
        lastModified: null,
        rawContentHash: "hash_material_change_approved",
        contentLength: 1500,
        isNotModified: false,
      };

      const mockExtract: PolicyExtractionResult = {
        status: "extracted",
        parserVersion: "2.0.0",
        warnings: [],
        explanation: "Best Buy threshold changed to $45.",
        terms: {
          merchantDomain: existingBestBuy.merchantDomain,
          merchantName: existingBestBuy.merchantName,
          deliveryMethod: existingBestBuy.deliveryMethod,
          currency: existingBestBuy.currency,
          thresholdCents: 4500,
          shippingCostCents: 0,
          allowedZones: existingBestBuy.allowedZones,
          excludedZones: existingBestBuy.excludedZones,
          requiresDirectRetailerSeller: true,
          requiresPreTaxMerchandiseThreshold: true,
          itemSpecificQualificationRequired: false,
        },
      };

      const proposal = proposalEngine.evaluateIngestion(sourceRecord, mockExtract, existingBestBuy);
      expect(proposal.status).toBe("proposed");

      // Verify active version before approval is 2.0.0
      expect(registry.isPolicyActive(existingBestBuy.policyId, "2.0.0")).toBe(true);
      expect(registry.isPolicyActive(existingBestBuy.policyId, "2.1.0")).toBe(false);

      // Approve proposal
      const humanActor = { kind: "user" as const, userId: "usr_admin_verifier" };
      const outcome = proposalEngine.approveProposal(proposal.proposalId, humanActor, registry);

      expect(outcome.approvedProposal.status).toBe("validated");
      expect(outcome.approvedProposal.reviewedBy).toEqual(humanActor);
      expect(outcome.publishedPolicy.thresholdCents).toBe(4500);

      // Verify active version is now 2.1.0, and 2.0.0 is superseded in history
      expect(registry.isPolicyActive(existingBestBuy.policyId, "2.1.0")).toBe(true);
      expect(registry.isPolicyActive(existingBestBuy.policyId, "2.0.0")).toBe(false);
      expect(registry.getPolicyVersion(existingBestBuy.policyId, "2.0.0")?.thresholdCents).toBe(3500);
      expect(registry.getPolicyVersion(existingBestBuy.policyId, "2.1.0")?.thresholdCents).toBe(4500);
    });

    it("allows human reviewer to reject proposal leaving active registry untouched", () => {
      const registry = new MerchantPolicyRegistry();
      const proposalEngine = new PolicyProposalEngine();

      const sourceRecord: PolicySourceRecord = {
        sourceUrl: existingBestBuy.policySourceUrl,
        retrievedAt: new Date().toISOString(),
        httpStatus: 200,
        etag: null,
        lastModified: null,
        rawContentHash: "hash_material_change_rejected",
        contentLength: 1500,
        isNotModified: false,
      };

      const mockExtract: PolicyExtractionResult = {
        status: "extracted",
        parserVersion: "2.0.0",
        warnings: [],
        explanation: "Proposed threshold change.",
        terms: {
          merchantDomain: existingBestBuy.merchantDomain,
          merchantName: existingBestBuy.merchantName,
          deliveryMethod: existingBestBuy.deliveryMethod,
          currency: existingBestBuy.currency,
          thresholdCents: 5000,
          shippingCostCents: 0,
          allowedZones: existingBestBuy.allowedZones,
          excludedZones: existingBestBuy.excludedZones,
        },
      };

      const proposal = proposalEngine.evaluateIngestion(sourceRecord, mockExtract, existingBestBuy);
      const rejected = proposalEngine.rejectProposal(
        proposal.proposalId,
        "Retailer source is promotional banner, not permanent terms",
        { kind: "user", userId: "usr_compliance_lead" }
      );

      expect(rejected.status).toBe("rejected");
      expect(rejected.rejectionReason).toContain("promotional banner");

      // Active registry remains on 2.0.0 ($35 threshold)
      expect(registry.isPolicyActive(existingBestBuy.policyId, "2.0.0")).toBe(true);
      const activePolicy = registry.getPoliciesForMerchant("Best Buy")[0];
      expect(activePolicy.thresholdCents).toBe(3500);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Deterministic Multi-Item Cart Engine
  // --------------------------------------------------------------------------
  describe("CartShippingEngine — Multi-Item Cart Eligibility Boundary", () => {
    const registry = new MerchantPolicyRegistry();
    const cartEngine = new CartShippingEngine(registry);

    it("qualifies a multi-item cart when direct retailer items meet or exceed threshold", () => {
      const context: CartShippingContext = {
        merchantName: "Walmart",
        merchantDomain: "walmart.com",
        items: [
          {
            id: "item_walmart_direct_1",
            title: "Direct Retailer Notebook",
            unitPriceCents: 2000, // $20.00
            quantity: 1,
            isDirectRetailerSeller: true,
          },
          {
            id: "item_walmart_direct_2",
            title: "Direct Retailer USB-C Cable",
            unitPriceCents: 1800, // $18.00
            quantity: 1,
            isDirectRetailerSeller: true,
          },
        ],
        destination: { country: "US", postalCode: "10001" }, // New York, NY (contiguous US)
        now: new Date("2026-10-29T10:00:00Z"),
      };

      const result = cartEngine.evaluateCart(context);

      expect(result.status).toBe("satisfied");
      expect(result.allItemsQualified).toBe(true);
      expect(result.qualifyingMerchandiseCents).toBe(3800); // $38.00 >= $35.00
      expect(result.totalShippingCents).toBe(0);
      expect(result.itemResults[0].shippingCents).toBe(0);
      expect(result.itemResults[1].shippingCents).toBe(0);
    });

    it("disaggregates independent 3rd-party marketplace items from direct/WFS items", () => {
      // Walmart policy allows marketplace items to contribute to the $35 cart minimum,
      // but independent 3rd-party seller items do NOT receive Walmart-funded free shipping.
      const context: CartShippingContext = {
        merchantName: "Walmart",
        merchantDomain: "walmart.com",
        items: [
          {
            id: "item_walmart_direct",
            title: "Walmart Direct Coffee Maker",
            unitPriceCents: 2500, // $25.00
            quantity: 1,
            isDirectRetailerSeller: true,
          },
          {
            id: "item_walmart_independent_seller",
            title: "Independent Seller Coffee Filters",
            unitPriceCents: 1200, // $12.00
            quantity: 1,
            sellerName: "ThirdPartyStore",
            isMarketplace: true,
            isWfsFulfilled: false,
          },
        ],
        destination: { country: "US", postalCode: "94103" }, // San Francisco, CA
        now: new Date("2026-10-29T10:00:00Z"),
      };

      const result = cartEngine.evaluateCart(context);

      // Cart total = $25 + $12 = $37 >= $35.
      // Direct item receives Walmart free shipping.
      // Independent seller item is excluded from Walmart free shipping.
      expect(result.status).toBe("partially_satisfied");
      expect(result.allItemsQualified).toBe(false);
      expect(result.qualifyingMerchandiseCents).toBe(3700);

      const directRes = result.itemResults.find((r) => r.itemId === "item_walmart_direct")!;
      expect(directRes.eligibleForMerchantFreeShipping).toBe(true);
      expect(directRes.shippingCents).toBe(0);

      const mktRes = result.itemResults.find((r) => r.itemId === "item_walmart_independent_seller")!;
      expect(mktRes.eligibleForMerchantFreeShipping).toBe(false);
      expect(mktRes.shippingCents).toBeNull();
      expect(mktRes.blockerReason).toBe("marketplace_seller_excluded");
    });

    it("enforces pre-tax cart discounts reducing net merchandise below threshold", () => {
      // Items subtotal = $40.00.
      // Cart discount = $10.00.
      // Net qualifying merchandise = $30.00 < $35.00 threshold!
      const context: CartShippingContext = {
        merchantName: "Target",
        merchantDomain: "target.com",
        items: [
          {
            id: "item_target_1",
            title: "Target Direct Desk Lamp",
            unitPriceCents: 4000, // $40.00
            quantity: 1,
            isDirectRetailerSeller: true,
          },
        ],
        cartLevelDiscountsCents: 1000, // $10.00 discount pre-tax
        destination: { country: "US", postalCode: "60601" }, // Chicago, IL
        now: new Date("2026-10-29T10:00:00Z"),
      };

      const result = cartEngine.evaluateCart(context);

      expect(result.status).toBe("threshold_not_met");
      expect(result.allItemsQualified).toBe(false);
      expect(result.qualifyingMerchandiseCents).toBe(3000); // $30.00 < $35.00
      expect(result.itemResults[0].shippingCents).toBeNull();
      expect(result.itemResults[0].blockerReason).toBe("threshold_not_met");
    });

    it("strictly excludes estimated tax from counting toward threshold", () => {
      // Subtotal = $32.00 (< $35.00).
      // Estimated tax = $4.00.
      // Total with tax would be $36.00, but tax NEVER counts toward free shipping!
      const context: CartShippingContext = {
        merchantName: "Best Buy",
        merchantDomain: "bestbuy.com",
        items: [
          {
            id: "item_bb_mouse",
            title: "Wireless Mouse",
            unitPriceCents: 3200, // $32.00
            quantity: 1,
            isDirectRetailerSeller: true,
          },
        ],
        estimatedTaxCents: 400, // $4.00 tax
        destination: { country: "US", postalCode: "77001" }, // Houston, TX
        now: new Date("2026-10-29T10:00:00Z"),
      };

      const result = cartEngine.evaluateCart(context);

      expect(result.status).toBe("threshold_not_met");
      expect(result.qualifyingMerchandiseCents).toBe(3200); // Only merchandise total, tax excluded
      expect(result.itemResults[0].shippingCents).toBeNull();
      expect(result.itemResults[0].blockerReason).toBe("threshold_not_met");
    });

    it("honors Target APO/FPO inclusion vs Alaska/Hawaii exclusion under standard policy", () => {
      // Target standard policy includes 48 continental states + APO/FPO (military), but excludes AK and HI.
      const apoContext: CartShippingContext = {
        merchantName: "Target",
        merchantDomain: "target.com",
        items: [
          {
            id: "item_target_military",
            title: "Target Direct Bed Sheets",
            unitPriceCents: 5000,
            quantity: 1,
            isDirectRetailerSeller: true,
          },
        ],
        destination: { country: "US", postalCode: "09012" }, // Military APO AE
        now: new Date("2026-10-29T10:00:00Z"),
      };

      const apoResult = cartEngine.evaluateCart(apoContext);
      expect(apoResult.status).toBe("satisfied");
      expect(apoResult.itemResults[0].shippingCents).toBe(0);

      // Alaska destination under standard $35 policy is excluded
      const akContext: CartShippingContext = {
        merchantName: "Target",
        merchantDomain: "target.com",
        items: [
          {
            id: "item_target_ak",
            title: "Target Direct Bed Sheets",
            unitPriceCents: 5000,
            quantity: 1,
            isDirectRetailerSeller: true,
          },
        ],
        destination: { country: "US", postalCode: "99501" }, // Anchorage, AK
        now: new Date("2026-10-29T10:00:00Z"),
      };

      const akResult = cartEngine.evaluateCart(akContext);
      expect(akResult.status).toBe("blocked");
      expect(akResult.itemResults[0].blockerReason).toBe("geographic_exclusion");
    });
  });

  // --------------------------------------------------------------------------
  // 5. Workflow Invalidation on Policy Changes
  // --------------------------------------------------------------------------
  describe("Procurement Invalidation Integrity", () => {
    it("invalidates stale approval snapshots when policy version or evidence fingerprint changes", () => {
      const originalFingerprint = "a".repeat(64);
      const updatedFingerprint = "b".repeat(64);

      const approval: ApprovalFacts = {
        id: "appr_test_123",
        purchaseId: "pur_test_123",
        candidateId: "cand_test_123",
        snapshotHash: "hash123",
        totalCents: 5000,
        currency: "USD",
        policyVersion: "2.0.0",
        evidenceFingerprint: originalFingerprint,
        approverUserId: "usr_buyer_1",
        approvedAt: new Date(),
        invalidatedAt: null,
        invalidationReason: null,
      };

      // State when policy evidence fingerprint changes (e.g. policy superseded)
      const purchaseState: PurchaseState = {
        purchaseId: "pur_test_123",
        status: "APPROVED",
        budgetCents: 10000,
        currency: "USD",
        policyVersion: "2.1.0", // Bumped version!
        requiredRuleKeys: ["shipping"],
        selectedCandidate: {
          id: "cand_test_123",
          purchaseId: "pur_test_123",
          source: "channel3",
          unitPriceCents: 5000,
          quantity: 1,
          shippingCents: 0,
          totalCents: 5000,
          currency: "USD",
          snapshotHash: "hash123",
        },
        currentEvidenceFingerprint: updatedFingerprint, // Fingerprint changed!
        policyEvidenceFingerprint: updatedFingerprint,
        isPolicySuperseded: true, // Marked superseded!
        approvals: [approval],
        paymentAttempts: [],
      };

      const reasons = deriveInvalidationReasons(approval, purchaseState);

      expect(reasons).toContain("policy_version_changed");
      expect(reasons).toContain("evidence_fingerprint_changed");
      expect(reasons).toContain("policy_superseded");
    });
  });
});
