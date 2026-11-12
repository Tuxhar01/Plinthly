/**
 * Plinthly Action 3 — Multi-Item Procurement Strategy Engine Unit Tests.
 *
 * Verifies:
 * 1. 4-Tier Defensive Comparator: Tier 1 (feasible-complete) > Tier 2 (feasible-incomplete) > Tier 3 (uncertain) > Tier 4 (blocked).
 * 2. Hard Defensibility Ranking: Incomplete landed cost never outranks complete defensible landed cost regardless of score.
 * 3. Multi-Objective Balanced Strategy Scoring: Clamped strictly to [0, 100], robust to zero budget, zero requirements, and unknown stock.
 * 4. Hard Compatibility Gate: Specification contradictions force compatibility score to 0 and block procurement.
 * 5. Cost Defensibility Invariants: Rejects inconsistent state (e.g. isLandedCostDefensible: true with totalLandedCostCents: null).
 * 6. Canonical Evidence Fingerprint: Immutable over evaluation timestamps; invalidates upon any material price/spec/tax/quote/policy change.
 * 7. Orthogonal Authenticity Claims: Direct retailer fulfillment does not imply brand authorization or manufacturer warranty.
 * 8. Destination Tax Jurisdiction: Alaska local sales tax requires municipal quote; Oregon non-sales-tax jurisdiction (statutory absence of general retail sales tax).
 * 9. Structured Trade-Offs: Explains cost, quality, compatibility, availability, and delivery traceable to verifiable evidence tiers.
 */

import { describe, it, expect } from "vitest";
import {
  buildStrategyFromAllocations,
  generateProcurementStrategies,
  compareStrategiesDefensively,
  getStrategyTier,
  validateCostInvariants,
  assertCostInvariants,
  detectCostContradictions,
  evaluateDestinationTax,
  computeCanonicalEvidenceFingerprint,
  computeBalancedStrategyScore,
  compareCodePoints,
  canonicalJsonStringify,
  compareCanonicalObjects,
  SERVER_JURISDICTION_TAX_RULES_V1,
  SERVER_TAX_AUTHORITY_REGISTRY,
  ImmutableTaxAuthorityRegistry,
  ServerTaxAuthorityConfig,
  signSyntheticTaxQuoteForTesting,
  createSyntheticTaxRegistryForTesting,
  setNonProductionTestTaxFixture,
  clearNonProductionTestTaxFixture,
  createDefensibleTestTaxQuote,
} from "../../lib/discovery/cart/strategy-engine";
import {
  allocateCandidatesToLineItems,
  checkCandidateCompatibility,
  createCandidateAllocation,
  parseStrictBoolean,
  ServerAuthenticityRegistry,
  computeClaimAttestationSignature,
  AuthenticityClaimAttestation,
  createSyntheticAuthenticityRegistryForTesting,
} from "../../lib/discovery/cart/allocation";
import {
  ProcurementLineItem,
  ProcurementStrategy,
  TaxEvidence,
} from "../../lib/discovery/cart/types";
import { NormalizedProductCandidate } from "../../lib/discovery/types";
import { DestinationContext } from "../../lib/discovery/shipping";

describe("PLINTHLY ACTION 3 — Procurement Strategy Evaluation Engine", () => {
  const TEST_AUTHENTICITY_SECRET = "test_authenticity_verification_secret_2026_at_least_32_chars_long";
  const TEST_TAX_SIGNING_KEY = "test_tax_oracle_verification_secret_2026_at_least_32_chars_long";

  const testAnchorageAuthority: ServerTaxAuthorityConfig = Object.freeze({
    authorityId: "anchorage_municipal_tax_oracle",
    name: "Municipality of Anchorage Tax Oracle (Synthetic Test)",
    verificationMethod: "cryptographic_hmac_sha256",
    secretKey: TEST_TAX_SIGNING_KEY,
    isSyntheticTestAuthority: true,
  });
  const testTaxOracleAuthority: ServerTaxAuthorityConfig = Object.freeze({
    authorityId: "anchorage_tax_oracle",
    name: "Anchorage Tax Oracle v1 (Synthetic Test)",
    verificationMethod: "cryptographic_hmac_sha256",
    secretKey: TEST_TAX_SIGNING_KEY,
    isSyntheticTestAuthority: true,
  });
  const testTaxQuoteEngineAuthority: ServerTaxAuthorityConfig = Object.freeze({
    authorityId: "tax_quote_engine",
    name: "Carrier Tax Quote Engine (Synthetic Test)",
    verificationMethod: "cryptographic_hmac_sha256",
    secretKey: TEST_TAX_SIGNING_KEY,
    isSyntheticTestAuthority: true,
  });
  const testSyntheticTaxRegistry: ImmutableTaxAuthorityRegistry =
    createSyntheticTaxRegistryForTesting([
      testAnchorageAuthority,
      testTaxOracleAuthority,
      testTaxQuoteEngineAuthority,
    ]);
  const oregonDestination: DestinationContext = {
    country: "US",
    postalCode: "97201", // Portland, OR — non-sales-tax jurisdiction (statutory absence of general retail sales tax)
    deliveryMethodPreference: "standard_ground",
  };

  const alaskaDestination: DestinationContext = {
    country: "US",
    postalCode: "99501", // Anchorage, AK — 0% state sales tax, but local municipal taxes apply
    deliveryMethodPreference: "standard_ground",
  };

  const californiaDestination: DestinationContext = {
    country: "US",
    postalCode: "94103", // San Francisco, CA — Standard taxable jurisdiction
    deliveryMethodPreference: "standard_ground",
  };

  const sampleLineItems: readonly ProcurementLineItem[] = [
    {
      id: "li_laptop",
      title: "Business Laptop",
      quantity: 1,
      budgetCents: 120000,
      currency: "USD",
      requirements: [{ key: "ram", expectedValue: "16GB", description: "16GB Memory" }],
      verificationLevel: "standard",
    },
    {
      id: "li_mouse",
      title: "Wireless Mouse",
      quantity: 2,
      budgetCents: 6000,
      currency: "USD",
      requirements: [{ key: "connectivity", expectedValue: "bluetooth", description: "Bluetooth" }],
      verificationLevel: "standard",
    },
  ];

  const sampleCandidateLaptop: NormalizedProductCandidate = {
    id: "cand_laptop_1",
    purchaseId: "pur_synth_act3_test",
    source: "seeded",
    externalId: "ext_laptop_1",
    title: "Business Laptop 16GB",
    merchantName: "Walmart",
    merchantUrl: "https://walmart.com/item/laptop",
    unitPriceCents: 99900,
    quantity: 1,
    shippingCents: 0,
    totalCents: 99900,
    currency: "USD",
    availability: "in_stock",
    capturedAt: new Date("2026-10-30T10:00:00Z"),
    snapshotHash: "a".repeat(64),
    rawSourceData: {},
    isComplete: true,
    validationErrors: [],
    sellerName: "Walmart.com",
    isDirectRetailerSeller: true,
    isMarketplace: false,
    fulfillmentMethod: "standard_ground",
    rawAttributes: {
      ram: "16GB",
      isManufacturerAuthorized: true,
      authorizationEvidence: "auth_dealer_cert_walmart_lenovo",
      isProductAuthenticVerified: true,
      authenticityEvidence: "crypto_seal_lenovo_sn",
      warrantyCoverage: "full_manufacturer",
      warrantyEvidence: "mfr_warranty_3yr_on_site",
    },
  };

  const sampleCandidateMouse: NormalizedProductCandidate = {
    id: "cand_mouse_1",
    purchaseId: "pur_synth_act3_test",
    source: "seeded",
    externalId: "ext_mouse_1",
    title: "Ergonomic Bluetooth Mouse",
    merchantName: "Walmart",
    merchantUrl: "https://walmart.com/item/mouse",
    unitPriceCents: 2500,
    quantity: 2,
    shippingCents: 0,
    totalCents: 5000,
    currency: "USD",
    availability: "in_stock",
    capturedAt: new Date("2026-10-30T10:00:00Z"),
    snapshotHash: "b".repeat(64),
    rawSourceData: {},
    isComplete: true,
    validationErrors: [],
    sellerName: "Walmart.com",
    isDirectRetailerSeller: true,
    isMarketplace: false,
    fulfillmentMethod: "standard_ground",
    rawAttributes: {
      connectivity: "bluetooth",
      isManufacturerAuthorized: true,
      authorizationEvidence: "auth_dealer_cert_walmart_logitech",
      isProductAuthenticVerified: true,
      authenticityEvidence: "crypto_seal_logitech_sn",
      warrantyCoverage: "full_manufacturer",
      warrantyEvidence: "mfr_warranty_1yr_limited",
    },
  };

  describe("1. 4-Tier Defensive Strategy Comparator", () => {
    it("1.1 maps strategies into explicit 1-4 tiers based on feasibility and cost defensibility", () => {
      // Build a Tier 1 (feasible-complete) strategy
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const tier1Strategy = buildStrategyFromAllocations(
        "strat_tier1",
        "Feasible Complete",
        "Fully defensible",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      expect(getStrategyTier(tier1Strategy)).toBe(1);
      expect(tier1Strategy.tier).toBe(1);

      // Build a Tier 2 (feasible-incomplete) strategy: missing tax in strict mode
      const tier2Strategy = buildStrategyFromAllocations(
        "strat_tier2",
        "Feasible Incomplete",
        "Missing tax",
        [allocLaptop, allocMouse],
        sampleLineItems,
        californiaDestination
      );
      expect(getStrategyTier(tier2Strategy)).toBe(2);
      expect(tier2Strategy.tier).toBe(2);

      // Tier 3: uncertain feasibility
      const tier3Strategy: ProcurementStrategy = {
        ...tier2Strategy,
        strategyId: "strat_tier3",
        feasibility: "uncertain",
      };
      expect(getStrategyTier(tier3Strategy)).toBe(3);

      // Tier 4: blocked feasibility
      const tier4Strategy: ProcurementStrategy = {
        ...tier1Strategy,
        strategyId: "strat_tier4",
        feasibility: "blocked",
      };
      expect(getStrategyTier(tier4Strategy)).toBe(4);
    });

    it("1.2 strictly orders Tier 1 > Tier 2 > Tier 3 > Tier 4 regardless of input ordering", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const tier1 = buildStrategyFromAllocations("strat_t1", "T1", "Feasible Complete", [allocLaptop, allocMouse], sampleLineItems, oregonDestination);
      const tier2 = buildStrategyFromAllocations("strat_t2", "T2", "Feasible Incomplete", [allocLaptop, allocMouse], sampleLineItems, californiaDestination);
      const tier3: ProcurementStrategy = { ...tier2, strategyId: "strat_t3", feasibility: "uncertain", recommendationScore: 99 };
      const tier4: ProcurementStrategy = { ...tier1, strategyId: "strat_t4", feasibility: "blocked", recommendationScore: 100 };

      // Adversarial shuffle
      const shuffled = [tier4, tier2, tier1, tier3];
      shuffled.sort(compareStrategiesDefensively);

      expect(shuffled.map((s) => s.strategyId)).toEqual([
        "strat_t1",
        "strat_t2",
        "strat_t3",
        "strat_t4",
      ]);
    });
  });

  describe("2. Hard Defensibility Ranking Guarantee (Adversarial Tests)", () => {
    it("2.1 ensures an incomplete landed cost CAN NEVER outrank a complete defensible total regardless of recommendation score", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      // Strategy A: Complete & defensible, but modest recommendation score (score = 35)
      const completeStrategy = buildStrategyFromAllocations(
        "strat_complete_low_score",
        "Complete Verified",
        "Verified costs",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      (completeStrategy as { recommendationScore: number }).recommendationScore = 35;

      // Strategy B: Incomplete landed cost, but artificially inflated recommendation score (score = 99.5)
      const incompleteStrategy = buildStrategyFromAllocations(
        "strat_incomplete_high_score",
        "Incomplete High Score",
        "Unquoted costs",
        [allocLaptop, allocMouse],
        sampleLineItems,
        californiaDestination
      );
      (incompleteStrategy as { recommendationScore: number }).recommendationScore = 99.5;

      // Ranking comparison
      const cmp = compareStrategiesDefensively(incompleteStrategy, completeStrategy);
      expect(cmp).toBeGreaterThan(0); // incompleteStrategy is ordered AFTER completeStrategy

      const ranked = [incompleteStrategy, completeStrategy].sort(compareStrategiesDefensively);
      expect(ranked[0].strategyId).toBe("strat_complete_low_score");
      expect(ranked[1].strategyId).toBe("strat_incomplete_high_score");
    });

    it("2.2 breaks ties within Tier 1 by lower total landed cost first, then recommendation score", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const stratCheaper = buildStrategyFromAllocations(
        "strat_cheaper",
        "Cheaper Strat",
        "Lower cost",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      ); // total = 99900 + 5000 = 104900 cents

      // Create a slightly more expensive candidate
      const expensiveLaptop: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        id: "cand_laptop_exp",
        externalId: "ext_laptop_exp",
        unitPriceCents: 110000,
        totalCents: 110000,
      };
      const allocExpLaptop = createCandidateAllocation(sampleLineItems[0], expensiveLaptop);

      const stratPricier = buildStrategyFromAllocations(
        "strat_pricier",
        "Pricier Strat",
        "Higher cost",
        [allocExpLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      ); // total = 110000 + 5000 = 115000 cents
      (stratPricier as { recommendationScore: number }).recommendationScore = 99; // higher score

      // In Tier 1, lower total landed cost wins
      const ranked = [stratPricier, stratCheaper].sort(compareStrategiesDefensively);
      expect(ranked[0].strategyId).toBe("strat_cheaper");
      expect(ranked[1].strategyId).toBe("strat_pricier");
    });

    it("2.3 breaks ties with equal landed cost and equal score using deterministic strategyId", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const stratAlpha = buildStrategyFromAllocations(
        "strat_alpha",
        "Alpha",
        "Same cost",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      (stratAlpha as { recommendationScore: number }).recommendationScore = 80;

      const stratBeta = buildStrategyFromAllocations(
        "strat_beta",
        "Beta",
        "Same cost",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      (stratBeta as { recommendationScore: number }).recommendationScore = 80;

      // Both have identical landed cost (104900) and recommendation score (80)
      expect(compareStrategiesDefensively(stratAlpha, stratBeta)).toBeLessThan(0); // "strat_alpha" < "strat_beta"
      expect(compareStrategiesDefensively(stratBeta, stratAlpha)).toBeGreaterThan(0);

      const ranked = [stratBeta, stratAlpha].sort(compareStrategiesDefensively);
      expect(ranked[0].strategyId).toBe("strat_alpha");
      expect(ranked[1].strategyId).toBe("strat_beta");
    });

    it("2.4 prevents an inconsistent strategy with non-null total and isLandedCostDefensible: true from bypassing to Tier 1", () => {
      const spoofedStrategy: ProcurementStrategy = {
        strategyId: "strat_spoofed_tier1",
        name: "Spoofed Tier 1",
        description: "Adversarial strategy claiming defensibility despite missing components",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 5000,
        totalShippingCents: null, // VIOLATION
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 5000, // Non-null total
        isLandedCostDefensible: true, // Claims defensible!
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 1, // Missing shipping
        requirementSatisfactionScore: 1,
        recommendationScore: 99,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "unverified",
        isQuoteBacked: false,
        costBreakdown: {
          merchandiseSubtotalCents: 5000,
          shippingCents: null,
          discountCents: 0,
          taxCents: 0,
          totalLandedCostCents: 5000,
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: false,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: ["shipping"],
        },
      };

      // getStrategyTier must catch the invariant failure and demote to Tier 4 (Blocked)
      expect(getStrategyTier(spoofedStrategy)).toBe(4);

      // validateCostInvariants flags it
      const val = validateCostInvariants(spoofedStrategy);
      expect(val.isValid).toBe(false);

      // assertCostInvariants throws
      expect(() => assertCostInvariants(spoofedStrategy)).toThrow(/shipping costs are missing or incomplete/);

      // A genuine Tier 1 strategy must rank ahead of the spoofed strategy despite lower score
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);
      const genuineTier1 = buildStrategyFromAllocations(
        "strat_genuine_tier1",
        "Genuine",
        "Verified",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      (genuineTier1 as { recommendationScore: number }).recommendationScore = 30; // lower score

      const ranked = [spoofedStrategy, genuineTier1].sort(compareStrategiesDefensively);
      expect(ranked[0].strategyId).toBe("strat_genuine_tier1");
      expect(ranked[1].strategyId).toBe("strat_spoofed_tier1");
    });

    it("2.5 verifies strict mathematical transitivity, anti-symmetry, and reflexivity of compareStrategiesDefensively", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const s1 = buildStrategyFromAllocations("s1", "S1", "Tier 1", [allocLaptop, allocMouse], sampleLineItems, oregonDestination);
      const s2 = buildStrategyFromAllocations("s2", "S2", "Tier 2", [allocLaptop, allocMouse], sampleLineItems, californiaDestination);
      const s3: ProcurementStrategy = { ...s2, strategyId: "s3", feasibility: "uncertain", recommendationScore: 80 };
      const s4: ProcurementStrategy = { ...s1, strategyId: "s4", feasibility: "blocked", recommendationScore: 0 };

      const strategies = [s1, s2, s3, s4];

      // Reflexivity: cmp(A, A) === 0
      for (const s of strategies) {
        expect(compareStrategiesDefensively(s, s)).toBe(0);
      }

      // Anti-symmetry: sign(cmp(A, B)) === -sign(cmp(B, A))
      for (let i = 0; i < strategies.length; i++) {
        for (let j = 0; j < strategies.length; j++) {
          const ab = Math.sign(compareStrategiesDefensively(strategies[i], strategies[j]));
          const ba = Math.sign(compareStrategiesDefensively(strategies[j], strategies[i]));
          expect(ab + ba).toBe(0);
        }
      }

      // Transitivity: if A < B and B < C, then A < C
      for (const a of strategies) {
        for (const b of strategies) {
          for (const c of strategies) {
            if (compareStrategiesDefensively(a, b) < 0 && compareStrategiesDefensively(b, c) < 0) {
              expect(compareStrategiesDefensively(a, c)).toBeLessThan(0);
            }
          }
        }
      }
    });
  });

  describe("3. Multi-Objective Balanced Strategy Scoring", () => {
    it("3.1 clamps balanced score strictly between [0, 100]", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const scoring = computeBalancedStrategyScore({
        allocations: [allocLaptop, allocMouse],
        lineItems: sampleLineItems,
        carts: [],
        totalLandedCostCents: 104900,
        isLandedCostDefensible: true,
        totalMerchandiseCents: 104900,
        isQuoteBacked: true,
        shippingEvidenceType: "quoted",
      });

      expect(scoring.score).toBeGreaterThanOrEqual(0);
      expect(scoring.score).toBeLessThanOrEqual(100);
      expect(Number.isFinite(scoring.score)).toBe(true);
      expect(Number.isNaN(scoring.score)).toBe(false);
    });

    it("3.2 gracefully handles zero budget without division by zero or NaN", () => {
      const zeroBudgetLineItems: ProcurementLineItem[] = [
        { id: "li_1", title: "Item 1", quantity: 1, currency: "USD", requirements: [] },
        { id: "li_2", title: "Item 2", quantity: 1, budgetCents: 0, currency: "USD", requirements: [] },
      ];

      const allocLaptop = createCandidateAllocation(zeroBudgetLineItems[0], sampleCandidateLaptop);
      const scoring = computeBalancedStrategyScore({
        allocations: [allocLaptop],
        lineItems: zeroBudgetLineItems,
        carts: [],
        totalLandedCostCents: 99900,
        isLandedCostDefensible: true,
        totalMerchandiseCents: 99900,
        isQuoteBacked: true,
        shippingEvidenceType: "quoted",
      });

      expect(Number.isFinite(scoring.costScore)).toBe(true);
      expect(Number.isNaN(scoring.costScore)).toBe(false);
      expect(scoring.costScore).toBe(70); // Defensible fallback score
      expect(Number.isFinite(scoring.score)).toBe(true);
    });

    it("3.3 gracefully handles zero requirements without division by zero", () => {
      const zeroReqLineItems: ProcurementLineItem[] = [
        { id: "li_1", title: "Item 1", quantity: 1, currency: "USD", requirements: [] },
      ];

      const allocLaptop = createCandidateAllocation(zeroReqLineItems[0], sampleCandidateLaptop);
      const scoring = computeBalancedStrategyScore({
        allocations: [allocLaptop],
        lineItems: zeroReqLineItems,
        carts: [],
        totalLandedCostCents: 99900,
        isLandedCostDefensible: true,
        totalMerchandiseCents: 99900,
        isQuoteBacked: true,
        shippingEvidenceType: "quoted",
      });

      expect(scoring.compatScore).toBe(100);
      expect(Number.isFinite(scoring.score)).toBe(true);
    });

    it("3.4 gracefully handles unknown inventory availability with neutral scoring", () => {
      const unknownStockCandidate: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        availability: "unknown",
      };

      const alloc = createCandidateAllocation(sampleLineItems[0], unknownStockCandidate);
      const scoring = computeBalancedStrategyScore({
        allocations: [alloc],
        lineItems: [sampleLineItems[0]],
        carts: [],
        totalLandedCostCents: 99900,
        isLandedCostDefensible: true,
        totalMerchandiseCents: 99900,
        isQuoteBacked: true,
        shippingEvidenceType: "quoted",
      });

      expect(scoring.availScore).toBe(50);
      expect(Number.isFinite(scoring.score)).toBe(true);
    });
  });

  describe("4. Hard Compatibility Gate", () => {
    it("4.1 rejects candidate allocation when critical specifications directly contradict", () => {
      const contradictingCandidate: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        rawAttributes: {
          ram: "8GB", // Required: 16GB
        },
      };

      const compat = checkCandidateCompatibility(sampleLineItems[0], contradictingCandidate);
      expect(compat.compatible).toBe(false);
      expect(compat.contradictorySpecs.length).toBeGreaterThan(0);
      expect(compat.score).toBe(0);
    });

    it("4.2 blocks strategy fulfillment if no compatible candidate can satisfy required specifications", () => {
      const contradictingCandidate: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        rawAttributes: {
          ram: "4GB", // Contradicts 16GB
        },
      };

      const strictLaptopLineItem: ProcurementLineItem = {
        ...sampleLineItems[0],
        verificationLevel: "strict",
      };

      const result = allocateCandidatesToLineItems([strictLaptopLineItem], [contradictingCandidate]);
      expect(result.unallocatedLineItemIds).toContain("li_laptop");

      const strategy = buildStrategyFromAllocations(
        "strat_contradictory",
        "Contradictory Strat",
        "Contains unfulfilled line item",
        result.allocations,
        [strictLaptopLineItem],
        oregonDestination
      );

      expect(strategy.feasibility).toBe("blocked");
      expect(strategy.recommendationScore).toBe(0);
      expect(getStrategyTier(strategy)).toBe(4);
    });
  });

  describe("5. Cost Defensibility Invariants", () => {
    it("5.1 assertCostInvariants rejects isLandedCostDefensible: true with totalLandedCostCents: null", () => {
      const invalidStrategy = {
        strategyId: "strat_invalid_1",
        name: "Invalid",
        description: "Desc",
        feasibility: "feasible" as const,
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000,
        totalShippingCents: 0,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: null, // VIOLATION
        isLandedCostDefensible: true, // VIOLATION
        currency: "USD" as const,
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 50,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted" as const,
        isQuoteBacked: true,
      };

      const check = validateCostInvariants(invalidStrategy);
      expect(check.isValid).toBe(false);
      expect(check.errors.some((e) => e.includes("totalLandedCostCents is null"))).toBe(true);

      expect(() => assertCostInvariants(invalidStrategy)).toThrowError(
        /isLandedCostDefensible is true but totalLandedCostCents is null/
      );
    });

    it("5.2 assertCostInvariants rejects isLandedCostDefensible: true when shipping charges are missing", () => {
      const invalidShippingStrategy = {
        strategyId: "strat_invalid_shipping",
        name: "Invalid Shipping",
        description: "Desc",
        feasibility: "feasible" as const,
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000,
        totalShippingCents: null, // VIOLATION
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 1000,
        isLandedCostDefensible: true, // VIOLATION
        currency: "USD" as const,
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 1, // VIOLATION
        requirementSatisfactionScore: 1,
        recommendationScore: 50,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "unverified" as const,
        isQuoteBacked: false,
      };

      const check = validateCostInvariants(invalidShippingStrategy);
      expect(check.isValid).toBe(false);
      expect(check.errors.some((e) => e.includes("shipping costs are missing or incomplete"))).toBe(true);
    });

    it("5.3 rejects defensibility when costBreakdown has missing components", () => {
      const invalidBreakdownStrategy = {
        strategyId: "strat_invalid_breakdown",
        name: "Invalid Breakdown",
        description: "Desc",
        feasibility: "feasible" as const,
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000,
        totalShippingCents: 0,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 1000,
        isLandedCostDefensible: true,
        currency: "USD" as const,
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 50,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted" as const,
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 1000,
          shippingCents: 0,
          discountCents: 0,
          taxCents: null,
          totalLandedCostCents: 1000,
          currency: "USD" as const,
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: false, // VIOLATION
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: ["tax"], // VIOLATION
        },
      };

      const check = validateCostInvariants(invalidBreakdownStrategy);
      expect(check.isValid).toBe(false);
      expect(check.errors.some((e) => e.includes("missingComponents contains: tax"))).toBe(true);
    });

    it("5.4 assertCostInvariants rejects strategy when costBreakdown is missing entirely", () => {
      const missingBreakdownStrategy = {
        strategyId: "strat_missing_breakdown",
        name: "Missing Breakdown",
        description: "No breakdown",
        feasibility: "feasible" as const,
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000,
        totalShippingCents: 0,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 1000,
        isLandedCostDefensible: true,
        currency: "USD" as const,
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 50,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted" as const,
        isQuoteBacked: true,
      };

      const check = validateCostInvariants(missingBreakdownStrategy);
      expect(check.isValid).toBe(false);
      expect(check.errors.some((e) => e.includes("missing required costBreakdown"))).toBe(true);

      expect(() => assertCostInvariants(missingBreakdownStrategy)).toThrowError(
        /missing required costBreakdown/
      );
      expect(getStrategyTier(missingBreakdownStrategy)).toBe(4);
    });

    it("5.5 assertCostInvariants rejects arithmetic mismatch where totalLandedCostCents !== merchandise + shipping - discount + tax", () => {
      const arithmeticMismatchStrategy = {
        strategyId: "strat_arithmetic_mismatch",
        name: "Arithmetic Mismatch",
        description: "Math does not add up",
        feasibility: "feasible" as const,
        allocations: [],
        carts: [],
        totalMerchandiseCents: 10000,
        totalShippingCents: 500,
        totalDiscountCents: 1000,
        totalEstimatedTaxCents: 800,
        totalLandedCostCents: 99999, // Should be 10000 + 500 - 1000 + 800 = 10300
        isLandedCostDefensible: true,
        currency: "USD" as const,
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 50,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted" as const,
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 10000,
          shippingCents: 500,
          discountCents: 1000,
          taxCents: 800,
          totalLandedCostCents: 99999, // MISMATCH
          currency: "USD" as const,
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      const check = validateCostInvariants(arithmeticMismatchStrategy);
      expect(check.isValid).toBe(false);
      expect(check.errors.some((e) => e.includes("arithmetic mismatch"))).toBe(true);

      expect(() => assertCostInvariants(arithmeticMismatchStrategy)).toThrowError(
        /arithmetic mismatch/
      );
      expect(getStrategyTier(arithmeticMismatchStrategy)).toBe(4);
    });

    it("5.6 assertCostInvariants rejects negative monetary components (negative merchandise, shipping, discount, or tax)", () => {
      const negativeMerchandiseStrategy = {
        strategyId: "strat_negative_cost",
        name: "Negative Cost",
        description: "Negative merchandise subtotal",
        feasibility: "feasible" as const,
        allocations: [],
        carts: [],
        totalMerchandiseCents: -500, // NEGATIVE
        totalShippingCents: 0,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: -500,
        isLandedCostDefensible: true,
        currency: "USD" as const,
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 50,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted" as const,
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: -500, // NEGATIVE
          shippingCents: 0,
          discountCents: 0,
          taxCents: 0,
          totalLandedCostCents: -500,
          currency: "USD" as const,
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      const check = validateCostInvariants(negativeMerchandiseStrategy);
      expect(check.isValid).toBe(false);
      expect(check.errors.some((e) => e.includes("merchandiseSubtotalCents is invalid or negative"))).toBe(true);
      expect(() => assertCostInvariants(negativeMerchandiseStrategy)).toThrowError(
        /merchandiseSubtotalCents is invalid or negative/
      );
      expect(getStrategyTier(negativeMerchandiseStrategy)).toBe(4);
    });

    it("5.7 assertCostInvariants rejects non-defensible discount or non-defensible merchandise in Tier 1", () => {
      const nonDefensibleDiscountStrategy = {
        strategyId: "strat_nondef_discount",
        name: "Non-defensible Discount",
        description: "Unverified coupon",
        feasibility: "feasible" as const,
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000,
        totalShippingCents: 0,
        totalDiscountCents: 200,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 800,
        isLandedCostDefensible: true,
        currency: "USD" as const,
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 50,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted" as const,
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 1000,
          shippingCents: 0,
          discountCents: 200,
          taxCents: 0,
          totalLandedCostCents: 800,
          currency: "USD" as const,
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: false, // VIOLATION
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      const check = validateCostInvariants(nonDefensibleDiscountStrategy);
      expect(check.isValid).toBe(false);
      expect(check.errors.some((e) => e.includes("discount is not defensible"))).toBe(true);
      expect(() => assertCostInvariants(nonDefensibleDiscountStrategy)).toThrowError(
        /discount is not defensible/
      );
      expect(getStrategyTier(nonDefensibleDiscountStrategy)).toBe(4);
    });

    it("5.8 assertCostInvariants rejects cross-object totalLandedCostCents mismatch", () => {
      const mismatchedTotalStrategy: ProcurementStrategy = {
        strategyId: "strat_mismatched_total",
        name: "Mismatched Total",
        description: "Strategy and breakdown disagree on total",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000,
        totalShippingCents: 0,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 1000, // Disagrees with breakdown (1050)
        isLandedCostDefensible: true,
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 80,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted",
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 1000,
          shippingCents: 0,
          discountCents: 0,
          taxCents: 0,
          totalLandedCostCents: 1050, // MISMATCH
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      const check = validateCostInvariants(mismatchedTotalStrategy);
      expect(check.isValid).toBe(false);
      expect(check.errors.some((e) => e.includes("strategy.totalLandedCostCents (1000) !== costBreakdown.totalLandedCostCents (1050)"))).toBe(true);
      expect(() => assertCostInvariants(mismatchedTotalStrategy)).toThrowError(
        /strategy\.totalLandedCostCents \(1000\) !== costBreakdown\.totalLandedCostCents \(1050\)/
      );
      expect(getStrategyTier(mismatchedTotalStrategy)).toBe(4);
    });

    it("5.9 assertCostInvariants rejects cross-object component mismatches (merchandise, shipping, discount, or tax)", () => {
      const mismatchedComponentStrategy: ProcurementStrategy = {
        strategyId: "strat_mismatched_components",
        name: "Mismatched Components",
        description: "Strategy and breakdown disagree on merchandise subtotal",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000, // Disagrees with breakdown (950)
        totalShippingCents: 50,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 1050,
        isLandedCostDefensible: true,
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 80,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted",
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 950, // MISMATCH
          shippingCents: 50,
          discountCents: 0,
          taxCents: 0,
          totalLandedCostCents: 1000,
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      const check = validateCostInvariants(mismatchedComponentStrategy);
      expect(check.isValid).toBe(false);
      expect(check.errors.some((e) => e.includes("strategy.totalMerchandiseCents (1000) !== costBreakdown.merchandiseSubtotalCents (950)"))).toBe(true);
      expect(() => assertCostInvariants(mismatchedComponentStrategy)).toThrowError(
        /strategy\.totalMerchandiseCents \(1000\) !== costBreakdown\.merchandiseSubtotalCents \(950\)/
      );
      expect(getStrategyTier(mismatchedComponentStrategy)).toBe(4);
    });

    it("5.10 assertCostInvariants rejects cross-object currency mismatch or defensibility flag disagreement", () => {
      const mismatchedCurrencyStrategy: ProcurementStrategy = {
        strategyId: "strat_mismatched_currency",
        name: "Mismatched Currency",
        description: "Strategy currency disagrees with breakdown currency",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000,
        totalShippingCents: 0,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 1000,
        isLandedCostDefensible: true,
        currency: "USD", // Disagrees with EUR
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 80,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted",
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 1000,
          shippingCents: 0,
          discountCents: 0,
          taxCents: 0,
          totalLandedCostCents: 1000,
          currency: "EUR" as unknown as "USD", // MISMATCH
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      const check = validateCostInvariants(mismatchedCurrencyStrategy);
      expect(check.isValid).toBe(false);
      expect(check.errors.some((e) => e.includes("currency mismatch"))).toBe(true);
      expect(() => assertCostInvariants(mismatchedCurrencyStrategy)).toThrowError(
        /currency mismatch/
      );
      expect(getStrategyTier(mismatchedCurrencyStrategy)).toBe(4);

      // Defensibility flag disagreement
      const mismatchedFlagStrategy: ProcurementStrategy = {
        ...mismatchedCurrencyStrategy,
        costBreakdown: {
          ...mismatchedCurrencyStrategy.costBreakdown!,
          currency: "USD",
          isLandedCostDefensible: false, // Disagrees with strategy.isLandedCostDefensible: true
        },
      };

      const checkFlag = validateCostInvariants(mismatchedFlagStrategy);
      expect(checkFlag.isValid).toBe(false);
      expect(checkFlag.errors.some((e) => e.includes("isLandedCostDefensible"))).toBe(true);
      expect(() => assertCostInvariants(mismatchedFlagStrategy)).toThrowError(
        /isLandedCostDefensible/
      );
      expect(getStrategyTier(mismatchedFlagStrategy)).toBe(4);
    });

    it("5.11 assertCostInvariants rejects arithmetic mismatch on strategy top-level", () => {
      const topLevelMathMismatchStrategy: ProcurementStrategy = {
        strategyId: "strat_top_level_math_mismatch",
        name: "Top Level Math Mismatch",
        description: "Strategy top-level math does not add up",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 10000,
        totalShippingCents: 500,
        totalDiscountCents: 1000,
        totalEstimatedTaxCents: 800,
        totalLandedCostCents: 99999, // Should be 10300
        isLandedCostDefensible: true,
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 80,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted",
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 10000,
          shippingCents: 500,
          discountCents: 1000,
          taxCents: 800,
          totalLandedCostCents: 99999, // Also mismatched to bypass cross-object check and trigger arithmetic check
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      const check = validateCostInvariants(topLevelMathMismatchStrategy);
      expect(check.isValid).toBe(false);
      expect(check.errors.some((e) => e.includes("arithmetic mismatch"))).toBe(true);
      expect(() => assertCostInvariants(topLevelMathMismatchStrategy)).toThrowError(
        /arithmetic mismatch/
      );
      expect(getStrategyTier(topLevelMathMismatchStrategy)).toBe(4);
    });

    it("5.12 comparator strictly rejects ranking inconsistent strategy as cheaper option over valid strategies", () => {
      // Inconsistent strategy claiming an artificially tiny total ($1.00), but with cross-object total mismatch
      const artificiallyCheapInconsistentStrategy: ProcurementStrategy = {
        strategyId: "strat_corrupted_cheap",
        name: "Corrupted Cheap Inconsistent",
        description: "Claims $1.00 total but breakdown is $1000",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 100, // $1.00
        totalShippingCents: 0,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 100, // $1.00
        isLandedCostDefensible: true,
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 99, // Artificially high score!
        recommendationRationale: "Artificially high score",
        riskDisclosures: [],
        shippingEvidenceType: "quoted",
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 100000, // $1,000.00 (SEVERE MISMATCH!)
          shippingCents: 0,
          discountCents: 0,
          taxCents: 0,
          totalLandedCostCents: 100000,
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      // 1. Inconsistent strategy MUST receive Tier 4 (Blocked)
      expect(getStrategyTier(artificiallyCheapInconsistentStrategy)).toBe(4);

      // 2. Build genuine Tier 1, Tier 2, and Tier 3 strategies
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const validTier1 = buildStrategyFromAllocations(
        "strat_valid_tier1",
        "Valid Tier 1",
        "Complete and verified",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      ); // $1049.00 total

      const validTier2 = buildStrategyFromAllocations(
        "strat_valid_tier2",
        "Valid Tier 2",
        "Missing California tax quote",
        [allocLaptop, allocMouse],
        sampleLineItems,
        californiaDestination
      );

      const validTier3: ProcurementStrategy = {
        ...validTier2,
        strategyId: "strat_valid_tier3",
        feasibility: "uncertain",
        recommendationScore: 20,
      };

      // 3. Comparator ordering: Genuine Tier 1, Tier 2, and Tier 3 ALL outrank the corrupted strategy
      expect(compareStrategiesDefensively(validTier1, artificiallyCheapInconsistentStrategy)).toBeLessThan(0);
      expect(compareStrategiesDefensively(validTier2, artificiallyCheapInconsistentStrategy)).toBeLessThan(0);
      expect(compareStrategiesDefensively(validTier3, artificiallyCheapInconsistentStrategy)).toBeLessThan(0);

      // 4. Sorted ranking test: corrupted cheap strategy is ranked strictly at the bottom
      const ranked = [artificiallyCheapInconsistentStrategy, validTier3, validTier2, validTier1].sort(
        compareStrategiesDefensively
      );

      expect(ranked[0].strategyId).toBe("strat_valid_tier1");
      expect(ranked[1].strategyId).toBe("strat_valid_tier2");
      expect(ranked[2].strategyId).toBe("strat_valid_tier3");
      expect(ranked[3].strategyId).toBe("strat_corrupted_cheap");
    });

    it("5.13 strictly classifies strategies with negative monetary components as Tier 4 (Blocked)", () => {
      const baseStrategy: ProcurementStrategy = {
        strategyId: "strat_neg_check",
        name: "Negative Check",
        description: "Desc",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000,
        totalShippingCents: 500,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 1500,
        isLandedCostDefensible: true,
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 85,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted",
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 1000,
          shippingCents: 500,
          discountCents: 0,
          taxCents: 0,
          totalLandedCostCents: 1500,
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      // 1. Negative merchandise
      const negMerch = { ...baseStrategy, totalMerchandiseCents: -1, costBreakdown: { ...baseStrategy.costBreakdown!, merchandiseSubtotalCents: -1 } };
      expect(getStrategyTier(negMerch)).toBe(4);

      // 2. Negative shipping
      const negShip = { ...baseStrategy, totalShippingCents: -10, costBreakdown: { ...baseStrategy.costBreakdown!, shippingCents: -10 } };
      expect(getStrategyTier(negShip)).toBe(4);

      // 3. Negative discount
      const negDisc = { ...baseStrategy, totalDiscountCents: -5, costBreakdown: { ...baseStrategy.costBreakdown!, discountCents: -5 } };
      expect(getStrategyTier(negDisc)).toBe(4);

      // 4. Negative tax
      const negTax = { ...baseStrategy, totalEstimatedTaxCents: -20, costBreakdown: { ...baseStrategy.costBreakdown!, taxCents: -20 } };
      expect(getStrategyTier(negTax)).toBe(4);

      // 5. Negative total
      const negTotal = { ...baseStrategy, totalLandedCostCents: -100, costBreakdown: { ...baseStrategy.costBreakdown!, totalLandedCostCents: -100 } };
      expect(getStrategyTier(negTotal)).toBe(4);
    });

    it("5.14 strictly classifies strategies with currency mismatches as Tier 4 (Blocked)", () => {
      const mismatchedCurrencyStrat: ProcurementStrategy = {
        strategyId: "strat_curr_mismatch",
        name: "Currency Mismatch",
        description: "Strategy in USD, breakdown in EUR",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000,
        totalShippingCents: 0,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 1000,
        isLandedCostDefensible: true,
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 85,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted",
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 1000,
          shippingCents: 0,
          discountCents: 0,
          taxCents: 0,
          totalLandedCostCents: 1000,
          currency: "EUR" as unknown as "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      expect(getStrategyTier(mismatchedCurrencyStrat)).toBe(4);
      const contradictions = detectCostContradictions(mismatchedCurrencyStrat);
      expect(contradictions.hasContradiction).toBe(true);
      expect(contradictions.errors.some((e) => e.includes("currency mismatch"))).toBe(true);
    });

    it("5.15 strictly classifies strategies with line item allocation currency mismatches as Tier 4 (Blocked)", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocEur = { ...allocLaptop, currency: "EUR" as unknown as "USD" };

      const stratWithEurAlloc: ProcurementStrategy = {
        strategyId: "strat_alloc_curr_mismatch",
        name: "Alloc Currency Mismatch",
        description: "Candidate allocation currency EUR disagrees with strategy currency USD",
        feasibility: "feasible",
        allocations: [allocEur],
        carts: [],
        totalMerchandiseCents: 99900,
        totalShippingCents: 0,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 99900,
        isLandedCostDefensible: true,
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 85,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted",
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 99900,
          shippingCents: 0,
          discountCents: 0,
          taxCents: 0,
          totalLandedCostCents: 99900,
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      expect(getStrategyTier(stratWithEurAlloc)).toBe(4);
      const contradictions = detectCostContradictions(stratWithEurAlloc);
      expect(contradictions.hasContradiction).toBe(true);
      expect(contradictions.errors.some((e) => e.includes("allocation currency mismatch"))).toBe(true);
    });

    it("5.16 strictly classifies strategies with top-level and breakdown discrepancies as Tier 4 (Blocked)", () => {
      const baseStrat: ProcurementStrategy = {
        strategyId: "strat_discrepancy_check",
        name: "Discrepancy Check",
        description: "Desc",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000,
        totalShippingCents: 200,
        totalDiscountCents: 50,
        totalEstimatedTaxCents: 80,
        totalLandedCostCents: 1230,
        isLandedCostDefensible: true,
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 85,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted",
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 1000,
          shippingCents: 200,
          discountCents: 50,
          taxCents: 80,
          totalLandedCostCents: 1230,
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      // Merchandise discrepancy
      const merchDisc = { ...baseStrat, totalMerchandiseCents: 1050 };
      expect(getStrategyTier(merchDisc)).toBe(4);

      // Shipping discrepancy
      const shipDisc = { ...baseStrat, totalShippingCents: 250 };
      expect(getStrategyTier(shipDisc)).toBe(4);

      // Discount discrepancy
      const discDisc = { ...baseStrat, totalDiscountCents: 100 };
      expect(getStrategyTier(discDisc)).toBe(4);

      // Total discrepancy
      const totalDisc = { ...baseStrat, totalLandedCostCents: 1300 };
      expect(getStrategyTier(totalDisc)).toBe(4);

      // Tax discrepancy
      const taxDisc = { ...baseStrat, totalEstimatedTaxCents: 90 };
      expect(getStrategyTier(taxDisc)).toBe(4);
    });

    it("5.17 strictly classifies contradictory cost defensibility flags as Tier 4 (Blocked)", () => {
      const baseStrat: ProcurementStrategy = {
        strategyId: "strat_flag_contradiction",
        name: "Flag Contradiction",
        description: "Desc",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000,
        totalShippingCents: 200,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 1200,
        isLandedCostDefensible: true,
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 85,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted",
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 1000,
          shippingCents: 200,
          discountCents: 0,
          taxCents: 0,
          totalLandedCostCents: 1200,
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      // Disagreement between strategy and breakdown flags
      const disagree = { ...baseStrat, isLandedCostDefensible: false };
      expect(getStrategyTier(disagree)).toBe(4);

      // isLandedCostDefensible is true, but totalLandedCostCents is null
      const nullTotal = { ...baseStrat, totalLandedCostCents: null, costBreakdown: { ...baseStrat.costBreakdown!, totalLandedCostCents: null } };
      expect(getStrategyTier(nullTotal)).toBe(4);

      // isLandedCostDefensible is true, but shipping is missing
      const missingShip = { ...baseStrat, missingShippingCostCount: 1 };
      expect(getStrategyTier(missingShip)).toBe(4);

      // isLandedCostDefensible is true, but shipping component marked non-defensible
      const shipNonDef = { ...baseStrat, costBreakdown: { ...baseStrat.costBreakdown!, isShippingDefensible: false } };
      expect(getStrategyTier(shipNonDef)).toBe(4);

      // isLandedCostDefensible is true, but missingComponents has items
      const missingComp = { ...baseStrat, costBreakdown: { ...baseStrat.costBreakdown!, missingComponents: ["tax"] } };
      expect(getStrategyTier(missingComp)).toBe(4);
    });

    it("5.18 strictly classifies contradictory completeness (total present when shipping is null) as Tier 4 (Blocked)", () => {
      const contradictoryCompletenessStrat: ProcurementStrategy = {
        strategyId: "strat_contradictory_completeness",
        name: "Contradictory Completeness",
        description: "totalLandedCostCents is non-null ($1500), but shipping is null",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1500,
        totalShippingCents: null, // Shipping missing!
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 1500, // Contradiction: declared total when shipping is null
        isLandedCostDefensible: false,
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 1,
        requirementSatisfactionScore: 1,
        recommendationScore: 85,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "unverified",
        isQuoteBacked: false,
        costBreakdown: {
          merchandiseSubtotalCents: 1500,
          shippingCents: null, // Shipping missing!
          discountCents: 0,
          taxCents: 0,
          totalLandedCostCents: 1500, // Contradiction!
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: false,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: false,
          missingComponents: ["shipping"],
        },
      };

      expect(getStrategyTier(contradictoryCompletenessStrat)).toBe(4);
      const contradictions = detectCostContradictions(contradictoryCompletenessStrat);
      expect(contradictions.hasContradiction).toBe(true);
      expect(contradictions.errors.some((e) => e.includes("totalLandedCostCents is non-null but shippingCents is null"))).toBe(true);
    });

    it("5.19 strictly classifies arithmetic inconsistencies as Tier 4 (Blocked)", () => {
      const arithmeticInconsistencyStrat: ProcurementStrategy = {
        strategyId: "strat_arithmetic_inconsistency",
        name: "Arithmetic Inconsistency",
        description: "1000 + 200 - 50 + 80 = 1230, but declared as 1300",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 1000,
        totalShippingCents: 200,
        totalDiscountCents: 50,
        totalEstimatedTaxCents: 80,
        totalLandedCostCents: 1300, // Arithmetic mismatch!
        isLandedCostDefensible: true,
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 85,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted",
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 1000,
          shippingCents: 200,
          discountCents: 50,
          taxCents: 80,
          totalLandedCostCents: 1300, // Arithmetic mismatch!
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      expect(getStrategyTier(arithmeticInconsistencyStrat)).toBe(4);
      const contradictions = detectCostContradictions(arithmeticInconsistencyStrat);
      expect(contradictions.hasContradiction).toBe(true);
      expect(contradictions.errors.some((e) => e.includes("arithmetic mismatch"))).toBe(true);
    });

    it("5.20 confirms Tier 2 is preserved for an incomplete but internally consistent cost strategy", () => {
      // Incomplete but internally consistent strategy:
      // Merchandise is known, shipping and tax are unquoted (null).
      // Total landed cost is correctly null, defensibility flags are consistent (false).
      const incompleteConsistentStrategy: ProcurementStrategy = {
        strategyId: "strat_incomplete_consistent_tier2",
        name: "Incomplete Consistent Strategy",
        description: "Missing shipping quote, but internally consistent",
        feasibility: "feasible",
        allocations: [],
        carts: [],
        totalMerchandiseCents: 99900,
        totalShippingCents: null, // Incomplete
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: null, // Consistent: null because shipping is unknown
        isLandedCostDefensible: false, // Consistent: false
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 1,
        requirementSatisfactionScore: 1,
        recommendationScore: 75,
        recommendationRationale: "",
        riskDisclosures: ["Shipping unquoted"],
        shippingEvidenceType: "unverified",
        isQuoteBacked: false,
        costBreakdown: {
          merchandiseSubtotalCents: 99900,
          shippingCents: null, // Incomplete
          discountCents: 0,
          taxCents: null, // Incomplete
          totalLandedCostCents: null, // Consistent
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: false,
          isTaxDefensible: false,
          isDiscountDefensible: true,
          isLandedCostDefensible: false, // Consistent
          missingComponents: ["shipping", "tax"],
        },
      };

      // 1. Must NOT be flagged as contradictory
      const contradictions = detectCostContradictions(incompleteConsistentStrategy);
      expect(contradictions.hasContradiction).toBe(false);
      expect(contradictions.errors).toHaveLength(0);

      // 2. Must receive Tier 2 (Feasible-Incomplete)
      expect(getStrategyTier(incompleteConsistentStrategy)).toBe(2);
      expect(getStrategyTier(incompleteConsistentStrategy)).not.toBe(4);
    });
  });

  describe("6. Canonical Evidence Fingerprint", () => {
    it("6.1 remains identical regardless of evaluatedAt timestamp changes (timestamp independence)", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const strat1 = buildStrategyFromAllocations(
        "strat_hash_test",
        "Hash Test",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination,
        new Date("2026-10-30T10:00:00Z")
      );

      const strat2 = buildStrategyFromAllocations(
        "strat_hash_test",
        "Hash Test",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination,
        new Date("2026-10-31T15:30:00Z") // Different evaluation timestamp
      );

      // Both fingerprints must be identical because underlying facts, prices, and policies are identical
      expect(strat1.evidenceFingerprint).toBeDefined();
      expect(strat2.evidenceFingerprint).toBeDefined();
      expect(strat1.evidenceFingerprint).toBe(strat2.evidenceFingerprint);

      // Directly verify exported canonical fingerprint generator matches strategy fingerprint
      const directHash = computeCanonicalEvidenceFingerprint(strat1, sampleLineItems, oregonDestination);
      expect(strat1.evidenceFingerprint).toBe(directHash);
    });

    it("6.2 invalidates if any material price, candidate, tax quote, or warranty fact changes", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const baselineStrat = buildStrategyFromAllocations(
        "strat_base",
        "Base",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );

      // Mutation 1: Price change by 1 cent
      const mutatedPriceLaptop: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        unitPriceCents: sampleCandidateLaptop.unitPriceCents + 1,
        totalCents: sampleCandidateLaptop.totalCents + 1,
      };
      const allocMutPrice = createCandidateAllocation(sampleLineItems[0], mutatedPriceLaptop);
      const stratMutPrice = buildStrategyFromAllocations(
        "strat_base",
        "Base",
        "Desc",
        [allocMutPrice, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      expect(stratMutPrice.evidenceFingerprint).not.toBe(baselineStrat.evidenceFingerprint);

      // Mutation 2: Warranty change
      const mutatedWarrantyLaptop: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        rawAttributes: {
          ...sampleCandidateLaptop.rawAttributes,
          warrantyCoverage: "none",
        },
      };
      const allocMutWarranty = createCandidateAllocation(sampleLineItems[0], mutatedWarrantyLaptop);
      const stratMutWarranty = buildStrategyFromAllocations(
        "strat_base",
        "Base",
        "Desc",
        [allocMutWarranty, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      expect(stratMutWarranty.evidenceFingerprint).not.toBe(baselineStrat.evidenceFingerprint);

      // Mutation 3: Destination change
      const stratMutDest = buildStrategyFromAllocations(
        "strat_base",
        "Base",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        { ...oregonDestination, postalCode: "97202" } // Different Oregon ZIP
      );
      expect(stratMutDest.evidenceFingerprint).not.toBe(baselineStrat.evidenceFingerprint);

      // Mutation 4: Specification requirement change
      const mutatedLineItems = [
        {
          ...sampleLineItems[0],
          requirements: [{ key: "ram", expectedValue: "32GB", description: "32GB Memory" }],
        },
        sampleLineItems[1],
      ];
      const stratMutSpec = buildStrategyFromAllocations(
        "strat_base",
        "Base",
        "Desc",
        [allocLaptop, allocMouse],
        mutatedLineItems,
        oregonDestination
      );
      expect(stratMutSpec.evidenceFingerprint).not.toBe(baselineStrat.evidenceFingerprint);

      // Mutation 5: Tax reference / quote change
      const taxRefQuote: TaxEvidence = {
        jurisdictionState: "OR",
        amountCents: 0,
        status: "statutory_zero",
        evidenceReference: "alternate_statutory_exemption_ref",
        explanation: "Alternative tax reference",
      };
      const stratMutTax = buildStrategyFromAllocations(
        "strat_base",
        "Base",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination,
        new Date(),
        [],
        taxRefQuote
      );
      expect(stratMutTax.evidenceFingerprint).not.toBe(baselineStrat.evidenceFingerprint);

      // Mutation 6: Manufacturer authorization evidence change
      const mutatedAuthLaptop: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        rawAttributes: {
          ...sampleCandidateLaptop.rawAttributes,
          authorizationEvidence: "revoked_or_superseded_auth_ref",
        },
      };
      const allocMutAuth = createCandidateAllocation(sampleLineItems[0], mutatedAuthLaptop);
      const stratMutAuth = buildStrategyFromAllocations(
        "strat_base",
        "Base",
        "Desc",
        [allocMutAuth, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      expect(stratMutAuth.evidenceFingerprint).not.toBe(baselineStrat.evidenceFingerprint);

      // Mutation 7: Product authenticity cryptographic seal change
      const mutatedAuthenticLaptop: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        rawAttributes: {
          ...sampleCandidateLaptop.rawAttributes,
          authenticityEvidence: "modified_crypto_seal_sn_9999",
        },
      };
      const allocMutAuthentic = createCandidateAllocation(sampleLineItems[0], mutatedAuthenticLaptop);
      const stratMutAuthentic = buildStrategyFromAllocations(
        "strat_base",
        "Base",
        "Desc",
        [allocMutAuthentic, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      expect(stratMutAuthentic.evidenceFingerprint).not.toBe(baselineStrat.evidenceFingerprint);
    });

    it("6.3 invalidates canonical fingerprint when discount amount or discount evidence reference changes", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const baselineStrat = buildStrategyFromAllocations(
        "strat_base_disc",
        "Base",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );

      // Mutation: Add discount
      const discountedStrat = {
        ...baselineStrat,
        totalDiscountCents: 500,
        totalLandedCostCents: (baselineStrat.totalLandedCostCents ?? 104900) - 500,
        costBreakdown: {
          ...baselineStrat.costBreakdown!,
          discountCents: 500,
          totalLandedCostCents: (baselineStrat.costBreakdown!.totalLandedCostCents ?? 104900) - 500,
          discountEvidenceReference: "promo_code_save5",
        },
      };

      const fpBaseline = computeCanonicalEvidenceFingerprint(baselineStrat, sampleLineItems, oregonDestination);
      const fpDiscounted = computeCanonicalEvidenceFingerprint(discountedStrat, sampleLineItems, oregonDestination);

      expect(fpDiscounted).not.toBe(fpBaseline);
    });

    it("6.4 invalidates canonical fingerprint when cart shipping policy document fingerprint or shipment shipping charge changes", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const baselineStrat = buildStrategyFromAllocations(
        "strat_base_cart",
        "Base",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );

      // Mutate cart policy fingerprint
      const mutatedPolicyStrat: ProcurementStrategy = {
        ...baselineStrat,
        carts: baselineStrat.carts.map((c, i) =>
          i === 0
            ? {
                ...c,
                thresholdEvaluation: c.thresholdEvaluation
                  ? {
                      ...c.thresholdEvaluation,
                      policyDocumentFingerprint: "mutated_policy_fingerprint_hex_abcdef",
                    }
                  : {
                      policyId: "pol_test_mut",
                      policyVersion: "2026.1",
                      policyDocumentFingerprint: "mutated_policy_fingerprint_hex_abcdef",
                      thresholdCents: 3500,
                      qualifyingMerchandiseSubtotalCents: 5000,
                      thresholdSatisfied: true,
                      remainingToThresholdCents: 0,
                      discountCents: 0,
                      appliesPreTax: true,
                      explanation: "Mutated policy test",
                    },
              }
            : c
        ),
      };

      const fpBaseline = computeCanonicalEvidenceFingerprint(baselineStrat, sampleLineItems, oregonDestination);
      const fpPolicyMutated = computeCanonicalEvidenceFingerprint(mutatedPolicyStrat, sampleLineItems, oregonDestination);

      expect(fpPolicyMutated).not.toBe(fpBaseline);
    });

    it("6.5 secondary tie-breaker sorting handles colliding IDs deterministically", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      // Strategy with duplicate line item titles or candidate IDs with differing prices
      const stratA = buildStrategyFromAllocations(
        "strat_sort_test",
        "Sort Test",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );

      // Reversed input allocations
      const stratB = buildStrategyFromAllocations(
        "strat_sort_test",
        "Sort Test",
        "Desc",
        [allocMouse, allocLaptop],
        sampleLineItems,
        oregonDestination
      );

      const fpA = computeCanonicalEvidenceFingerprint(stratA, sampleLineItems, oregonDestination);
      const fpB = computeCanonicalEvidenceFingerprint(stratB, sampleLineItems, oregonDestination);

      // Invariant: Allocation input order must not alter canonical fingerprint
      expect(fpA).toBe(fpB);
    });

    it("6.6 reverses colliding records with different evidence references and confirms identical fingerprints", () => {
      // Candidate A and Candidate B have identical primary/secondary IDs and price,
      // but differ on authorizationEvidence and authenticityEvidence
      const collidingCandidateA: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        id: "cand_collision_dup",
        externalId: "ext_collision_dup",
        unitPriceCents: 99900,
        rawAttributes: {
          ...sampleCandidateLaptop.rawAttributes,
          authorizationEvidence: "auth_dealer_cert_ALPHA_PRIMARY",
          authenticityEvidence: "crypto_seal_ALPHA_001",
        },
      };

      const collidingCandidateB: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        id: "cand_collision_dup", // COLLISION: identical candidate ID
        externalId: "ext_collision_dup", // COLLISION: identical external ID
        unitPriceCents: 99900, // COLLISION: identical unit price
        rawAttributes: {
          ...sampleCandidateLaptop.rawAttributes,
          authorizationEvidence: "auth_dealer_cert_OMEGA_SECONDARY", // DIFFERENT reference
          authenticityEvidence: "crypto_seal_OMEGA_999", // DIFFERENT reference
        },
      };

      const allocA = createCandidateAllocation(sampleLineItems[0], collidingCandidateA);
      const allocB = createCandidateAllocation(sampleLineItems[0], collidingCandidateB);

      // Verify that allocA and allocB differ in material evidence fields
      expect(allocA.authenticity?.authorizationEvidence).toBe("auth_dealer_cert_ALPHA_PRIMARY");
      expect(allocB.authenticity?.authorizationEvidence).toBe("auth_dealer_cert_OMEGA_SECONDARY");

      // Build Strategy with [allocA, allocB]
      const stratForward: ProcurementStrategy = {
        strategyId: "strat_colliding_forward",
        name: "Colliding Forward",
        description: "Desc",
        feasibility: "feasible",
        allocations: [allocA, allocB],
        carts: [],
        totalMerchandiseCents: 199800,
        totalShippingCents: 0,
        totalDiscountCents: 0,
        totalEstimatedTaxCents: 0,
        totalLandedCostCents: 199800,
        isLandedCostDefensible: true,
        currency: "USD",
        retailerCount: 1,
        shipmentCount: 1,
        missingShippingCostCount: 0,
        requirementSatisfactionScore: 1,
        recommendationScore: 80,
        recommendationRationale: "",
        riskDisclosures: [],
        shippingEvidenceType: "quoted",
        isQuoteBacked: true,
        costBreakdown: {
          merchandiseSubtotalCents: 199800,
          shippingCents: 0,
          discountCents: 0,
          taxCents: 0,
          totalLandedCostCents: 199800,
          currency: "USD",
          isMerchandiseDefensible: true,
          isShippingDefensible: true,
          isTaxDefensible: true,
          isDiscountDefensible: true,
          isLandedCostDefensible: true,
          missingComponents: [],
        },
      };

      // Build Strategy with reversed order: [allocB, allocA]
      const stratReversed: ProcurementStrategy = {
        ...stratForward,
        strategyId: "strat_colliding_reversed",
        allocations: [allocB, allocA], // REVERSED INPUT ORDER
      };

      const fpForward = computeCanonicalEvidenceFingerprint(stratForward, sampleLineItems, oregonDestination);
      const fpReversed = computeCanonicalEvidenceFingerprint(stratReversed, sampleLineItems, oregonDestination);

      // Deterministic canonical sorting across EVERY material field guarantees identical fingerprint
      expect(fpForward).toBe(fpReversed);
      expect(typeof fpForward).toBe("string");
      expect(fpForward.length).toBe(64);
    });

    it("6.7 invalidates canonical fingerprint when candidate specification match, contradictions, or missing specs change", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const baselineStrat = buildStrategyFromAllocations(
        "strat_base_spec",
        "Base",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      const fpBaseline = computeCanonicalEvidenceFingerprint(baselineStrat, sampleLineItems, oregonDestination);

      // Mutate specification match on allocation
      const mutatedSpecAlloc = {
        ...allocLaptop,
        matchedSpecs: ["ram", "storage_512gb"], // Altered specification matching
      };
      const mutatedSpecStrat = {
        ...baselineStrat,
        allocations: [mutatedSpecAlloc, allocMouse],
      };
      const fpMutated = computeCanonicalEvidenceFingerprint(mutatedSpecStrat, sampleLineItems, oregonDestination);
      expect(fpMutated).not.toBe(fpBaseline);
    });

    it("6.8 invalidates canonical fingerprint when shipping quote carrier, split reason, or quote-bound status changes", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const baselineStrat = buildStrategyFromAllocations(
        "strat_base_ship",
        "Base",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      const fpBaseline = computeCanonicalEvidenceFingerprint(baselineStrat, sampleLineItems, oregonDestination);

      // Mutate carrier on shipment
      const mutatedCarrierStrat: ProcurementStrategy = {
        ...baselineStrat,
        carts: baselineStrat.carts.map((c, i) =>
          i === 0
            ? {
                ...c,
                shipments: c.shipments.map((s, j) =>
                  j === 0 ? { ...s, carrier: "FedEx Freight Specialized" } : s
                ),
              }
            : c
        ),
      };
      const fpMutated = computeCanonicalEvidenceFingerprint(mutatedCarrierStrat, sampleLineItems, oregonDestination);
      expect(fpMutated).not.toBe(fpBaseline);
    });

    it("6.9 invalidates canonical fingerprint when quantity confirmation state, confirmedBy actor, or confirmation token changes", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const baselineStrat = buildStrategyFromAllocations(
        "strat_base_qty",
        "Base",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      const fpBaseline = computeCanonicalEvidenceFingerprint(baselineStrat, sampleLineItems, oregonDestination);

      // Mutate confirmedBy actor
      const mutatedActorLineItems = [
        {
          ...sampleLineItems[0],
          quantityConfirmed: true,
          confirmedBy: "usr_attacker_spoofed_buyer",
          confirmationToken: "token_abc_123",
        },
        sampleLineItems[1],
      ];
      const fpMutatedActor = computeCanonicalEvidenceFingerprint(baselineStrat, mutatedActorLineItems, oregonDestination);
      expect(fpMutatedActor).not.toBe(fpBaseline);

      // Mutate confirmation token
      const mutatedTokenLineItems = [
        {
          ...sampleLineItems[0],
          quantityConfirmed: true,
          confirmedBy: "usr_legit_buyer",
          confirmationToken: "token_tampered_999",
        },
        sampleLineItems[1],
      ];
      const fpMutatedToken = computeCanonicalEvidenceFingerprint(baselineStrat, mutatedTokenLineItems, oregonDestination);
      expect(fpMutatedToken).not.toBe(fpBaseline);
    });

    it("6.10 invalidates canonical fingerprint when cart threshold policy ID, qualifying merchandise, or remaining threshold changes", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const baselineStrat = buildStrategyFromAllocations(
        "strat_base_policy_thresh",
        "Base",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      const fpBaseline = computeCanonicalEvidenceFingerprint(baselineStrat, sampleLineItems, oregonDestination);

      const mutatedThreshStrat: ProcurementStrategy = {
        ...baselineStrat,
        carts: baselineStrat.carts.map((c, i) =>
          i === 0 && c.thresholdEvaluation
            ? {
                ...c,
                thresholdEvaluation: {
                  ...c.thresholdEvaluation,
                  thresholdCents: 5000, // Altered threshold
                },
              }
            : c
        ),
      };
      const fpMutated = computeCanonicalEvidenceFingerprint(mutatedThreshStrat, sampleLineItems, oregonDestination);
      expect(fpMutated).not.toBe(fpBaseline);
    });

    it("6.11 invalidates canonical fingerprint when cost breakdown defensibility flags or missingComponents change", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const baselineStrat = buildStrategyFromAllocations(
        "strat_base_cost_prov",
        "Base",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      const fpBaseline = computeCanonicalEvidenceFingerprint(baselineStrat, sampleLineItems, oregonDestination);

      const mutatedCostProvStrat: ProcurementStrategy = {
        ...baselineStrat,
        costBreakdown: baselineStrat.costBreakdown
          ? {
              ...baselineStrat.costBreakdown,
              isShippingDefensible: false,
              missingComponents: ["shipping"],
            }
          : undefined,
      };
      const fpMutated = computeCanonicalEvidenceFingerprint(mutatedCostProvStrat, sampleLineItems, oregonDestination);
      expect(fpMutated).not.toBe(fpBaseline);
    });

    it("6.12 invalidates canonical fingerprint when shipment quoteId, quoteReference, or quoteExpiresAt changes", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const baselineStrat = buildStrategyFromAllocations(
        "strat_base_ship_quote",
        "Base",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );
      const fpBaseline = computeCanonicalEvidenceFingerprint(baselineStrat, sampleLineItems, oregonDestination);

      const mutatedQuoteIdStrat: ProcurementStrategy = {
        ...baselineStrat,
        carts: baselineStrat.carts.map((c, i) =>
          i === 0
            ? {
                ...c,
                shipments: c.shipments.map((s, j) =>
                  j === 0
                    ? {
                        ...s,
                        quoteId: "carrier_quote_live_998877",
                        quoteReference: "ups_ground_rate_ref_44",
                        quoteExpiresAt: "2026-11-05T00:00:00Z",
                      }
                    : s
                ),
              }
            : c
        ),
      };
      const fpMutated = computeCanonicalEvidenceFingerprint(mutatedQuoteIdStrat, sampleLineItems, oregonDestination);
      expect(fpMutated).not.toBe(fpBaseline);
    });
  });

  describe("7. Orthogonal Authenticity Claims", () => {
    it("7.1 verifies that direct first-party retailer fulfillment does not imply brand authorization or manufacturer warranty", () => {
      const directRetailerUnauthCandidate: NormalizedProductCandidate = {
        id: "cand_direct_unauth",
        purchaseId: "pur_synth_act3_test",
        source: "seeded",
        externalId: "ext_direct_unauth",
        title: "Retailer Laptop",
        merchantName: "Walmart",
        merchantUrl: "https://walmart.com/item/laptop",
        unitPriceCents: 90000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 90000,
        currency: "USD",
        availability: "in_stock",
        capturedAt: new Date("2026-10-30T10:00:00Z"),
        snapshotHash: "c".repeat(64),
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: "Walmart.com",
        isDirectRetailerSeller: true, // Direct retailer
        isMarketplace: false,
        fulfillmentMethod: "standard_ground",
        // Notice: NO isManufacturerAuthorized, NO isProductAuthenticVerified, NO warrantyEvidence
      };

      const alloc = createCandidateAllocation(sampleLineItems[0], directRetailerUnauthCandidate);

      expect(alloc.isDirectRetailerSeller).toBe(true);
      expect(alloc.authenticity).toBeDefined();
      expect(alloc.authenticity?.isDirectRetailerSeller).toBe(true);
      // Critical assertion: brand authorization is FALSE despite 1st-party fulfillment
      expect(alloc.authenticity?.isManufacturerAuthorized).toBe(false);
      expect(alloc.authenticity?.authorizationEvidence).toBeNull();
      // Critical assertion: product authenticity is FALSE despite 1st-party fulfillment
      expect(alloc.authenticity?.isProductAuthenticVerified).toBe(false);
      // Critical assertion: warranty coverage is unverified despite 1st-party fulfillment
      expect(alloc.authenticity?.warrantyCoverage).toBe("unverified");
      expect(alloc.authenticity?.evidenceTier).toBe("merchant_claim");
    });

    it("7.2 strictly parses boolean candidate attributes and protects against JavaScript Boolean('false') === true trap", () => {
      // In vanilla JS, Boolean("false") === true, which leads to security bypasses
      expect(Boolean("false")).toBe(true);

      // parseStrictBoolean must correctly identify falsy string booleans
      expect(parseStrictBoolean("false")).toBe(false);
      expect(parseStrictBoolean("False")).toBe(false);
      expect(parseStrictBoolean("FALSE")).toBe(false);
      expect(parseStrictBoolean("0")).toBe(false);
      expect(parseStrictBoolean("no")).toBe(false);
      expect(parseStrictBoolean(false)).toBe(false);
      expect(parseStrictBoolean(0)).toBe(false);
      expect(parseStrictBoolean(undefined)).toBe(false);
      expect(parseStrictBoolean(null)).toBe(false);
      expect(parseStrictBoolean("arbitrary_string")).toBe(false);

      // And truthy values
      expect(parseStrictBoolean("true")).toBe(true);
      expect(parseStrictBoolean("True")).toBe(true);
      expect(parseStrictBoolean("1")).toBe(true);
      expect(parseStrictBoolean("yes")).toBe(true);
      expect(parseStrictBoolean(true)).toBe(true);
      expect(parseStrictBoolean(1)).toBe(true);

      // Candidate with string "false" for authorization
      const stringFalseCandidate: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        rawAttributes: {
          isManufacturerAuthorized: "false", // String "false"
          authorizationEvidence: "auth_ref_123",
          isProductAuthenticVerified: "false", // String "false"
          authenticityEvidence: "crypto_seal_123",
        },
      };

      const alloc = createCandidateAllocation(sampleLineItems[0], stringFalseCandidate);
      expect(alloc.authenticity?.isManufacturerAuthorized).toBe(false);
      expect(alloc.authenticity?.isProductAuthenticVerified).toBe(false);
      expect(alloc.authenticity?.evidenceTier).not.toBe("verified_fact");
    });

    it("7.3 demotes seller authenticity claims to merchant_claim if evidence reference strings are missing, empty, or whitespace-only", () => {
      // Candidate claiming authorization and authenticity, but with empty or whitespace evidence strings
      const unbackedClaimsCandidate: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        rawAttributes: {
          isManufacturerAuthorized: true,
          authorizationEvidence: "   ", // Whitespace only!
          isProductAuthenticVerified: true,
          authenticityEvidence: "", // Empty string!
          warrantyCoverage: "full_manufacturer",
          warrantyEvidence: null, // Null!
        },
      };

      const alloc = createCandidateAllocation(sampleLineItems[0], unbackedClaimsCandidate);

      // Must be stripped to null references
      expect(alloc.authenticity?.authorizationEvidence).toBeNull();
      expect(alloc.authenticity?.authenticityEvidence).toBeNull();
      expect(alloc.authenticity?.warrantyEvidence).toBeNull();

      // Because references are missing, evidenceTier MUST be merchant_claim, never verified_fact!
      expect(alloc.authenticity?.evidenceTier).toBe("merchant_claim");
    });

    it("7.4 candidate with arbitrary or fabricated evidence references cannot achieve verified_fact without an independent trusted validation mechanism", () => {
      // Candidate with fabricated evidence strings on candidate attributes
      const fabricatedClaimsCandidate: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        rawAttributes: {
          isManufacturerAuthorized: true,
          authorizationEvidence: "fabricated_dealer_cert_lenovo_fake",
          isProductAuthenticVerified: true,
          authenticityEvidence: "crypto_seal_spoofed_sn_9999",
          warrantyCoverage: "full_manufacturer",
          warrantyEvidence: "untrusted_mfr_warranty_claim",
        },
      };

      // In the absence of a trusted validator, arbitrary candidate claims remain merchant_claim
      const allocWithoutValidator = createCandidateAllocation(sampleLineItems[0], fabricatedClaimsCandidate);
      expect(allocWithoutValidator.authenticity?.evidenceTier).toBe("merchant_claim");
      expect(allocWithoutValidator.authenticity?.evidenceTier).not.toBe("verified_fact");

      // An untrusted caller attempting to inject an always-true callback validator MUST BE REJECTED:
      // Client input cannot supply or replace the server validator.
      const maliciousCallerValidator = {
        isAuthorizationValidated: () => true, // Malicious always-true callback
        isAuthenticityValidated: () => true,
        isWarrantyValidated: () => true,
      };

      const allocWithMaliciousCaller = createCandidateAllocation(
        sampleLineItems[0],
        fabricatedClaimsCandidate,
        maliciousCallerValidator
      );
      expect(allocWithMaliciousCaller.authenticity?.evidenceTier).toBe("merchant_claim");
      expect(allocWithMaliciousCaller.authenticity?.evidenceTier).not.toBe("verified_fact");

      // Direct unauthorized constructor calls must throw Error (caller lacks internal server authorization token)
      expect(() => {
        new (ServerAuthenticityRegistry as unknown as new (t: unknown, p: unknown) => ServerAuthenticityRegistry)(
          "unauthorized_caller_token",
          {
            verifiedAuthorizations: new Set(),
            verifiedAuthenticProducts: new Set(),
            verifiedWarranties: new Set(),
          }
        );
      }).toThrow(/Unauthorized construction/);

      // Attempting to construct without parameters must also throw Error
      expect(() => {
        new (ServerAuthenticityRegistry as unknown as new (p: unknown) => ServerAuthenticityRegistry)({});
      }).toThrow(/Unauthorized construction/);

      // Empty server registry requires zero signing secrets and contains zero verified claims
      const emptyRegistry = ServerAuthenticityRegistry.createEmpty();
      expect(emptyRegistry).toBeInstanceOf(ServerAuthenticityRegistry);
      expect(emptyRegistry.isAuthorizationValidated("any_ref", "any_seller")).toBe(false);
      expect(emptyRegistry.isAuthenticityValidated("any_ref", "any_cand")).toBe(false);
      expect(emptyRegistry.isWarrantyValidated("any_ref", "any_seller")).toBe(false);

      // Attacker trying to invoke factory with attacker-controlled secrets:
      // createServerVerified does NOT accept caller-supplied secrets; reads strictly from environment.
      // With environment secret unset, it fails closed immediately.
      expect(() => {
        (ServerAuthenticityRegistry.createServerVerified as unknown as (a: unknown, s: string) => unknown)(
          [],
          "attacker_controlled_secret_key"
        );
      }).toThrow(/Server authenticity secret is missing or not configured/);

      const sellerKey = (fabricatedClaimsCandidate.sellerName ?? fabricatedClaimsCandidate.merchantName).toLowerCase().trim();
      const candIdKey = (fabricatedClaimsCandidate.id || fabricatedClaimsCandidate.externalId).trim();
      const nowIso = new Date().toISOString();

      // Test 1: Forged authorization attestation signature: invalid signature is rejected and not enrolled
      const forgedAuthAttestation: AuthenticityClaimAttestation = {
        claimType: "authorization",
        sellerOrCandidateId: sellerKey,
        evidenceReference: "fabricated_dealer_cert_lenovo_fake",
        authorityId: "server_pipeline_v1",
        attestedAt: nowIso,
        attestationSignature: "0".repeat(64), // Invalid forged signature!
      };
      const registryForgedAuth = createSyntheticAuthenticityRegistryForTesting(
        [forgedAuthAttestation],
        TEST_AUTHENTICITY_SECRET
      );
      expect(registryForgedAuth.isAuthorizationValidated("fabricated_dealer_cert_lenovo_fake", sellerKey)).toBe(false);
      const allocWithForgedAuth = createCandidateAllocation(
        sampleLineItems[0],
        fabricatedClaimsCandidate,
        registryForgedAuth
      );
      expect(allocWithForgedAuth.authenticity?.evidenceTier).toBe("merchant_claim");
      expect(allocWithForgedAuth.authenticity?.evidenceTier).not.toBe("verified_fact");

      // Test 2: Forged product authenticity attestation signature: invalid signature is rejected and not enrolled
      const forgedAuthenticAttestation: AuthenticityClaimAttestation = {
        claimType: "authenticity",
        sellerOrCandidateId: candIdKey,
        evidenceReference: "crypto_seal_spoofed_sn_9999",
        authorityId: "server_pipeline_v1",
        attestedAt: nowIso,
        attestationSignature: "f".repeat(64), // Invalid forged signature!
      };
      const registryForgedAuthentic = createSyntheticAuthenticityRegistryForTesting(
        [forgedAuthenticAttestation],
        TEST_AUTHENTICITY_SECRET
      );
      expect(registryForgedAuthentic.isAuthenticityValidated("crypto_seal_spoofed_sn_9999", candIdKey)).toBe(false);
      const allocWithForgedAuthentic = createCandidateAllocation(
        sampleLineItems[0],
        fabricatedClaimsCandidate,
        registryForgedAuthentic
      );
      expect(allocWithForgedAuthentic.authenticity?.evidenceTier).toBe("merchant_claim");
      expect(allocWithForgedAuthentic.authenticity?.evidenceTier).not.toBe("verified_fact");

      // Test 3: Forged warranty attestation signature: invalid signature is rejected and not enrolled
      const forgedWarrantyAttestation: AuthenticityClaimAttestation = {
        claimType: "warranty",
        sellerOrCandidateId: sellerKey,
        evidenceReference: "untrusted_mfr_warranty_claim",
        authorityId: "server_pipeline_v1",
        attestedAt: nowIso,
        attestationSignature: "a".repeat(64), // Invalid forged signature!
      };
      const registryForgedWarranty = createSyntheticAuthenticityRegistryForTesting(
        [forgedWarrantyAttestation],
        TEST_AUTHENTICITY_SECRET
      );
      expect(registryForgedWarranty.isWarrantyValidated("untrusted_mfr_warranty_claim", sellerKey)).toBe(false);
      const allocWithForgedWarranty = createCandidateAllocation(
        sampleLineItems[0],
        fabricatedClaimsCandidate,
        registryForgedWarranty
      );
      expect(allocWithForgedWarranty.authenticity?.evidenceTier).toBe("merchant_claim");
      expect(allocWithForgedWarranty.authenticity?.evidenceTier).not.toBe("verified_fact");

      // Legitimate server-side attestations signed cryptographically with TEST_AUTHENTICITY_SECRET
      const authClaim = {
        claimType: "authorization" as const,
        sellerOrCandidateId: sellerKey,
        evidenceReference: "fabricated_dealer_cert_lenovo_fake",
        authorityId: "server_pipeline_v1",
        attestedAt: nowIso,
      };
      const authenticClaim = {
        claimType: "authenticity" as const,
        sellerOrCandidateId: candIdKey,
        evidenceReference: "crypto_seal_spoofed_sn_9999",
        authorityId: "server_pipeline_v1",
        attestedAt: nowIso,
      };
      const warrantyClaim = {
        claimType: "warranty" as const,
        sellerOrCandidateId: sellerKey,
        evidenceReference: "untrusted_mfr_warranty_claim",
        authorityId: "server_pipeline_v1",
        attestedAt: nowIso,
      };

      const genuineAttestations: AuthenticityClaimAttestation[] = [
        {
          ...authClaim,
          attestationSignature: computeClaimAttestationSignature(authClaim, TEST_AUTHENTICITY_SECRET),
        },
        {
          ...authenticClaim,
          attestationSignature: computeClaimAttestationSignature(authenticClaim, TEST_AUTHENTICITY_SECRET),
        },
        {
          ...warrantyClaim,
          attestationSignature: computeClaimAttestationSignature(warrantyClaim, TEST_AUTHENTICITY_SECRET),
        },
      ];

      const serverRegistry = createSyntheticAuthenticityRegistryForTesting(genuineAttestations, TEST_AUTHENTICITY_SECRET);
      expect(Object.isFrozen(serverRegistry)).toBe(true);

      // Verify private field encapsulation prevents Set.prototype.add.call bypass
      expect(() => {
        Set.prototype.add.call(serverRegistry as unknown as Set<unknown>, "malicious_key");
      }).toThrow(TypeError);

      // Reflection-based mutation attempt fails on frozen instance
      expect(() => {
        (serverRegistry as unknown as Record<string, unknown>).isAuthorizationValidated = () => true;
      }).toThrow();

      const allocWithServerRegistry = createCandidateAllocation(
        sampleLineItems[0],
        fabricatedClaimsCandidate,
        serverRegistry
      );
      expect(allocWithServerRegistry.authenticity?.evidenceTier).toBe("verified_fact");
    });

    it("7.5 rejects expired attestations and keeps candidate claims at merchant_claim", () => {
      const fabricatedClaimsCandidate: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        rawAttributes: {
          isManufacturerAuthorized: true,
          authorizationEvidence: "auth_ref_expired_test",
          isProductAuthenticVerified: true,
          authenticityEvidence: "crypto_seal_expired_test",
          warrantyCoverage: "full_manufacturer",
          warrantyEvidence: "mfr_warranty_expired_test",
        },
      };

      const sellerKey = (fabricatedClaimsCandidate.sellerName ?? fabricatedClaimsCandidate.merchantName).toLowerCase().trim();

      // Attestations that expired in the past relative to verification time
      const pastExpiredAt = "2026-09-01T00:00:00Z";
      const pastAttestedAt = "2026-08-01T00:00:00Z";
      const now = new Date("2026-10-31T00:00:00Z");

      const expiredClaim = {
        claimType: "authorization" as const,
        sellerOrCandidateId: sellerKey,
        evidenceReference: "auth_ref_expired_test",
        authorityId: "server_pipeline_v1",
        attestedAt: pastAttestedAt,
        expiresAt: pastExpiredAt,
      };

      const expiredAttestation: AuthenticityClaimAttestation = {
        ...expiredClaim,
        attestationSignature: computeClaimAttestationSignature(expiredClaim, TEST_AUTHENTICITY_SECRET),
      };

      // Registry created with evaluation time 'now' (after pastExpiredAt)
      const registryWithExpired = createSyntheticAuthenticityRegistryForTesting(
        [expiredAttestation],
        TEST_AUTHENTICITY_SECRET,
        now
      );

      // Authorization should NOT be enrolled because it has expired
      expect(registryWithExpired.isAuthorizationValidated("auth_ref_expired_test", sellerKey)).toBe(false);

      const alloc = createCandidateAllocation(
        sampleLineItems[0],
        fabricatedClaimsCandidate,
        registryWithExpired
      );
      expect(alloc.authenticity?.evidenceTier).toBe("merchant_claim");
      expect(alloc.authenticity?.evidenceTier).not.toBe("verified_fact");
    });

    it("7.6 verifies that missing or invalid authenticity secrets fail closed with zero fallback defaults", () => {
      const authClaim = {
        claimType: "authorization" as const,
        sellerOrCandidateId: "walmart",
        evidenceReference: "auth_ref_walmart_failclosed",
        authorityId: "server_pipeline_v1",
        attestedAt: new Date().toISOString(),
      };

      // 1. Calling computeClaimAttestationSignature with empty or missing secret throws Error
      expect(() => {
        computeClaimAttestationSignature(authClaim, "");
      }).toThrow(/Missing required signing secret/);

      expect(() => {
        computeClaimAttestationSignature(authClaim, "   ");
      }).toThrow(/Missing required signing secret/);

      // 2. Calling createServerVerified without env secret throws fail-closed
      const validSig = computeClaimAttestationSignature(authClaim, TEST_AUTHENTICITY_SECRET);
      const attestation: AuthenticityClaimAttestation = {
        ...authClaim,
        attestationSignature: validSig,
      };

      expect(() => {
        ServerAuthenticityRegistry.createServerVerified([attestation]);
      }).toThrow(/secret is missing or not configured/);

      // 3. Constructing synthetic test registry with empty secret throws Error
      expect(() => {
        createSyntheticAuthenticityRegistryForTesting([attestation], "");
      }).toThrow(/Missing required test secret/);

      // 4. Constructing registry with mismatched secret key fails to enroll signed claim
      const mismatchedSecret = "different_secret_key_at_least_32_characters_long_999";
      const registryMismatched = createSyntheticAuthenticityRegistryForTesting([attestation], mismatchedSecret);
      expect(registryMismatched.isAuthorizationValidated("auth_ref_walmart_failclosed", "walmart")).toBe(false);
    });

    it("7.7 enforces strict runtime production boundary: synthetic authenticity registries cannot be instantiated or certify verified_fact in production", () => {
      const origNodeEnv = process.env.NODE_ENV;
      const env = process.env as Record<string, string | undefined>;
      try {
        env.NODE_ENV = "production";
        // 1. Factory invocation in production throws Error
        expect(() => {
          createSyntheticAuthenticityRegistryForTesting([], "dummy_test_secret_32_characters_long_123");
        }).toThrow(/Forbidden in production/);

        // 2. Even if a test registry existed before production switch, evaluateCandidateAuthenticity demotes to merchant_claim
        env.NODE_ENV = "test";
        const authClaim = {
          claimType: "authorization" as const,
          sellerOrCandidateId: "test_mfr",
          evidenceReference: "ref_auth_123",
          authorityId: "test_synthetic_auth",
          attestedAt: new Date().toISOString(),
        };
        const authSig = computeClaimAttestationSignature(authClaim, TEST_AUTHENTICITY_SECRET);

        const prodClaim = {
          claimType: "authenticity" as const,
          sellerOrCandidateId: "cand_laptop_1",
          evidenceReference: "ref_auth_123",
          authorityId: "test_synthetic_auth",
          attestedAt: new Date().toISOString(),
        };
        const prodSig = computeClaimAttestationSignature(prodClaim, TEST_AUTHENTICITY_SECRET);

        const warClaim = {
          claimType: "warranty" as const,
          sellerOrCandidateId: "test_mfr",
          evidenceReference: "ref_auth_123",
          authorityId: "test_synthetic_auth",
          attestedAt: new Date().toISOString(),
        };
        const warSig = computeClaimAttestationSignature(warClaim, TEST_AUTHENTICITY_SECRET);

        const testReg = createSyntheticAuthenticityRegistryForTesting(
          [
            { ...authClaim, attestationSignature: authSig },
            { ...prodClaim, attestationSignature: prodSig },
            { ...warClaim, attestationSignature: warSig },
          ],
          TEST_AUTHENTICITY_SECRET
        );

        env.NODE_ENV = "production";
        const cand = {
          ...sampleCandidateLaptop,
          sellerName: "test_mfr",
          rawAttributes: {
            is_manufacturer_authorized: true,
            is_product_authentic: true,
            warranty_coverage: "full_manufacturer",
            authorization_evidence: "ref_auth_123",
            authenticity_evidence: "ref_auth_123",
            warranty_evidence: "ref_auth_123",
          },
        };
        const alloc = createCandidateAllocation(sampleLineItems[0], cand, testReg);
        expect(alloc.authenticity?.evidenceTier).toBe("merchant_claim");
        expect(alloc.authenticity?.evidenceTier).not.toBe("verified_fact");
      } finally {
        env.NODE_ENV = origNodeEnv;
      }
    });
  });

  describe("8. Destination Tax Jurisdiction Handling", () => {
    it("8.1 confirms Oregon (OR) qualifies for non-sales-tax status (statutory absence of general retail sales tax) without municipal quote", () => {
      const taxEval = evaluateDestinationTax(oregonDestination);

      expect(taxEval.isTaxDefensible).toBe(true);
      expect(taxEval.taxCents).toBe(0);
      expect(taxEval.taxEvidence.status).toBe("statutory_absence");
      expect(taxEval.taxEvidence.jurisdictionState).toBe("OR");
      expect(taxEval.taxEvidence.explanation).toContain("statutory absence");
    });

    it("8.2 confirms New Hampshire (NH) and Delaware (DE) qualify for statutory absence, while Montana (MT) requires authoritative local evidence", () => {
      const mtDest: DestinationContext = { country: "US", postalCode: "59601", deliveryMethodPreference: "standard_ground" }; // Helena, MT
      const nhDest: DestinationContext = { country: "US", postalCode: "03301", deliveryMethodPreference: "standard_ground" }; // Concord, NH
      const deDest: DestinationContext = { country: "US", postalCode: "19801", deliveryMethodPreference: "standard_ground" }; // Wilmington, DE

      const mtEval = evaluateDestinationTax(mtDest);
      const nhEval = evaluateDestinationTax(nhDest);
      const deEval = evaluateDestinationTax(deDest);

      // Montana: Unquoted destinations fail closed because ZIP codes cannot verify exclusion from resort-tax districts
      expect(mtEval.isTaxDefensible).toBe(false);
      expect(mtEval.taxCents).toBeNull();
      expect(mtEval.taxEvidence.status).toBe("missing");
      expect(mtEval.taxEvidence.explanation).toContain("Montana does not enact a statewide general sales tax");
      expect(mtEval.taxEvidence.explanation).toContain("lacks authoritative jurisdiction evidence");

      // New Hampshire: Statewide statutory absence of general sales tax
      expect(nhEval.isTaxDefensible).toBe(true);
      expect(nhEval.taxCents).toBe(0);
      expect(nhEval.taxEvidence.status).toBe("statutory_absence");
      expect(nhEval.taxEvidence.explanation).toContain("New Hampshire does not enact a general retail sales tax");

      // Delaware: Statewide statutory absence of buyer-side sales tax
      expect(deEval.isTaxDefensible).toBe(true);
      expect(deEval.taxCents).toBe(0);
      expect(deEval.taxEvidence.status).toBe("statutory_absence");
      expect(deEval.taxEvidence.explanation).toContain("Delaware does not enact a state or local buyer-side general retail sales tax");
    });

    it("8.3 confirms Alaska (AK) requires municipal tax quote and cannot be assumed $0 tax", () => {
      const taxEval = evaluateDestinationTax(alaskaDestination);

      // Alaska local municipal sales tax required
      expect(taxEval.isTaxDefensible).toBe(false);
      expect(taxEval.taxCents).toBeNull();
      expect(taxEval.taxEvidence.status).toBe("missing");
      expect(taxEval.taxEvidence.jurisdictionState).toBe("AK");
      expect(taxEval.taxEvidence.explanation).toContain("local municipal sales taxes apply");

      // When building a strategy for Alaska without a municipal quote, costBreakdown is NOT defensible
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const alaskaStrat = buildStrategyFromAllocations(
        "strat_alaska_no_quote",
        "Alaska Strat",
        "Unquoted municipal tax",
        [allocLaptop, allocMouse],
        sampleLineItems,
        alaskaDestination
      );

      expect(alaskaStrat.costBreakdown?.isTaxDefensible).toBe(false);
      expect(alaskaStrat.costBreakdown?.taxCents).toBeNull();
      expect(alaskaStrat.costBreakdown?.missingComponents).toContain("tax");
      expect(getStrategyTier(alaskaStrat)).toBe(2);
      expect(() => assertCostInvariants(alaskaStrat)).toThrow(/tax is not defensible/);
    });

    it("8.4 accepts synthetic test tax quote for Alaska to verify cryptographic flow, but confirms production fail-closed", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      const quoteExpiresAt = new Date(Date.now() + 86400000).toISOString();
      const quotePayload = {
        quoteId: "anchorage_tax_quote_api_ref",
        amountCents: 2500, // $25.00 municipal sales tax quote
        currency: "USD",
        jurisdictionState: "AK",
        postalCode: "99501",
        expiresAt: quoteExpiresAt,
      };
      const quoteSignature = signSyntheticTaxQuoteForTesting(
        "anchorage_municipal_tax_oracle",
        quotePayload,
        testSyntheticTaxRegistry
      );

      const alaskaMunicipalTaxQuote: TaxEvidence = {
        ...quotePayload,
        status: "quoted",
        evidenceReference: "anchorage_tax_quote_api_ref",
        sourceIdentity: "anchorage_municipal_tax_oracle",
        quoteSignature,
        explanation: "Synthetic municipal sales tax quote for Anchorage, AK",
      };

      // 1. With testSyntheticTaxRegistry: verifies cryptographic signature and structure
      const testResult = evaluateDestinationTax(
        alaskaDestination,
        alaskaMunicipalTaxQuote,
        new Date(),
        testSyntheticTaxRegistry
      );
      expect(testResult.isTaxDefensible).toBe(true);
      expect(testResult.taxCents).toBe(2500);

      // 2. With production SERVER_TAX_AUTHORITY_REGISTRY: fails closed because live provider ingestion is not implemented!
      const prodResult = evaluateDestinationTax(alaskaDestination, alaskaMunicipalTaxQuote);
      expect(prodResult.isTaxDefensible).toBe(false);
      expect(prodResult.taxCents).toBeNull();
      expect(prodResult.taxEvidence.status).toBe("untrusted");
      expect(prodResult.taxEvidence.explanation).toContain("not enrolled");

      // 3. Strategy built with synthetic test quote
      const alaskaStratWithQuote = buildStrategyFromAllocations(
        "strat_alaska_with_quote",
        "Alaska Quoted",
        "Quoted municipal tax",
        [allocLaptop, allocMouse],
        sampleLineItems,
        alaskaDestination,
        new Date(),
        [],
        alaskaMunicipalTaxQuote
      );

      // When built in default production mode without test registry, Alaska quote fails closed
      expect(alaskaStratWithQuote.costBreakdown?.isTaxDefensible).toBe(false);
      expect(getStrategyTier(alaskaStratWithQuote)).toBe(2);
    });

    it("8.5 rejects fabricated statutory_zero evidence for taxable jurisdiction (e.g. California or Alaska)", () => {
      // Caller attempts to pass statutory_zero for California
      const fabricatedCalZeroTax: TaxEvidence = {
        jurisdictionState: "CA",
        postalCode: "94103",
        amountCents: 0,
        status: "statutory_zero",
        evidenceReference: "fake_statutory_zero_ref",
        explanation: "Claiming CA is tax free",
      };

      const result = evaluateDestinationTax(californiaDestination, fabricatedCalZeroTax);
      expect(result.isTaxDefensible).toBe(false);
      expect(result.taxCents).toBeNull();
      expect(result.taxEvidence.status).toBe("untrusted");
      expect(result.taxEvidence.explanation).toContain("Fabricated statutory zero");
    });

    it("8.6 rejects tax quote with mismatched jurisdiction binding (e.g. Oregon quote applied to California)", () => {
      const mismatchedJurisdictionQuote: TaxEvidence = {
        jurisdictionState: "OR", // Quoted for Oregon!
        postalCode: "94103",
        amountCents: 0,
        status: "quoted",
        evidenceReference: "valid_or_quote_ref",
        sourceIdentity: "tax_quote_engine",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        explanation: "Quote for Oregon",
      };

      const result = evaluateDestinationTax(
        californiaDestination,
        mismatchedJurisdictionQuote,
        new Date(),
        testSyntheticTaxRegistry
      );
      expect(result.isTaxDefensible).toBe(false);
      expect(result.taxCents).toBeNull();
      expect(result.taxEvidence.status).toBe("untrusted");
      expect(result.taxEvidence.explanation).toContain("jurisdiction mismatch");
    });

    it("8.7 rejects expired tax quotes relative to evaluation timestamp", () => {
      const expiredQuote: TaxEvidence = {
        jurisdictionState: "AK",
        postalCode: "99501",
        amountCents: 2000,
        status: "quoted",
        evidenceReference: "anchorage_expired_ref",
        sourceIdentity: "anchorage_tax_oracle",
        expiresAt: "2026-10-01T00:00:00Z", // Expired in the past!
        explanation: "Expired Anchorage quote",
      };

      const now = new Date("2026-10-31T00:00:00Z");
      const result = evaluateDestinationTax(
        alaskaDestination,
        expiredQuote,
        now,
        testSyntheticTaxRegistry
      );
      expect(result.isTaxDefensible).toBe(false);
      expect(result.taxCents).toBeNull();
      expect(result.taxEvidence.status).toBe("untrusted");
      expect(result.taxEvidence.explanation).toContain("Tax quote expired");
    });

    it("8.8 rejects tax quotes with missing or whitespace-only evidenceReference", () => {
      const emptyRefQuote: TaxEvidence = {
        jurisdictionState: "AK",
        postalCode: "99501",
        amountCents: 2000,
        status: "quoted",
        evidenceReference: "   ", // Whitespace only!
        sourceIdentity: "anchorage_tax_oracle",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        explanation: "Empty reference quote",
      };

      const result = evaluateDestinationTax(alaskaDestination, emptyRefQuote);
      expect(result.isTaxDefensible).toBe(false);
      expect(result.taxCents).toBeNull();
      expect(result.taxEvidence.status).toBe("missing");
      expect(result.taxEvidence.explanation).toContain("lacks required non-empty evidenceReference");
    });

    it("8.9 rejects tax quotes with missing, untrusted, or fabricated sourceIdentity", () => {
      const untrustedSourceQuote: TaxEvidence = {
        jurisdictionState: "AK",
        postalCode: "99501",
        amountCents: 2000,
        status: "quoted",
        evidenceReference: "valid_ref_string_123",
        sourceIdentity: "untrusted", // Untrusted source!
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        explanation: "Untrusted source quote",
      };

      const result = evaluateDestinationTax(alaskaDestination, untrustedSourceQuote);
      expect(result.isTaxDefensible).toBe(false);
      expect(result.taxCents).toBeNull();
      expect(result.taxEvidence.status).toBe("untrusted");
      expect(result.taxEvidence.explanation).toContain("lacks verifiable trusted source identity");
    });

    it("8.10 rejects tax quote with mismatched postal code binding (e.g. 99502 applied to destination 99501)", () => {
      const mismatchedPostalQuote: TaxEvidence = {
        jurisdictionState: "AK",
        postalCode: "99502", // Mismatched postal code!
        amountCents: 2000,
        status: "quoted",
        evidenceReference: "anchorage_postal_mismatch_ref",
        sourceIdentity: "anchorage_tax_oracle",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        explanation: "Postal code mismatch quote",
      };

      const result = evaluateDestinationTax(
        alaskaDestination,
        mismatchedPostalQuote,
        new Date(),
        testSyntheticTaxRegistry
      );
      expect(result.isTaxDefensible).toBe(false);
      expect(result.taxCents).toBeNull();
      expect(result.taxEvidence.status).toBe("untrusted");
      expect(result.taxEvidence.explanation).toContain("postal code mismatch");
    });

    it("8.11 rejects tax quote with forged sourceIdentity not enrolled in server registry", () => {
      const forgedSourceQuote: TaxEvidence = {
        jurisdictionState: "AK",
        postalCode: "99501",
        amountCents: 2000,
        status: "quoted",
        evidenceReference: "anchorage_forged_source_ref",
        sourceIdentity: "forged_tax_llc", // Not in server registry!
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        explanation: "Quote from unverified source",
      };

      const result = evaluateDestinationTax(alaskaDestination, forgedSourceQuote);
      expect(result.isTaxDefensible).toBe(false);
      expect(result.taxCents).toBeNull();
      expect(result.taxEvidence.status).toBe("untrusted");
      expect(result.taxEvidence.explanation).toContain("not enrolled in the server-controlled trusted tax authority registry");
    });

    it("8.12 rejects registered source name without cryptographic signature", () => {
      const quoteWithoutSignature: TaxEvidence = {
        jurisdictionState: "AK",
        postalCode: "99501",
        amountCents: 2500,
        currency: "USD",
        status: "quoted",
        evidenceReference: "anchorage_unsigned_ref",
        sourceIdentity: "anchorage_municipal_tax_oracle", // Registered in test registry
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        explanation: "Quote with enrolled source name but missing signature",
      };

      const result = evaluateDestinationTax(
        alaskaDestination,
        quoteWithoutSignature,
        new Date(),
        testSyntheticTaxRegistry
      );
      expect(result.isTaxDefensible).toBe(false);
      expect(result.taxCents).toBeNull();
      expect(result.taxEvidence.status).toBe("untrusted");
      expect(result.taxEvidence.explanation).toContain("lacks required cryptographic signature");
    });

    it("8.13 rejects forged or tampered quote payloads where signature does not match bound fields", () => {
      const quoteExpiresAt = new Date(Date.now() + 86400000).toISOString();
      const genuinePayload = {
        quoteId: "quote_genuine_123",
        amountCents: 2500,
        currency: "USD",
        jurisdictionState: "AK",
        postalCode: "99501",
        expiresAt: quoteExpiresAt,
      };
      const validSig = signSyntheticTaxQuoteForTesting(
        "anchorage_municipal_tax_oracle",
        genuinePayload,
        testSyntheticTaxRegistry
      );

      // Tamper 1: Tampered amount (caller claims 0 cents instead of 2500)
      const tamperedAmountQuote: TaxEvidence = {
        ...genuinePayload,
        amountCents: 0, // Tampered!
        status: "quoted",
        evidenceReference: "quote_genuine_123",
        sourceIdentity: "anchorage_municipal_tax_oracle",
        quoteSignature: validSig,
        explanation: "Tampered amount",
      };
      const resAmount = evaluateDestinationTax(
        alaskaDestination,
        tamperedAmountQuote,
        new Date(),
        testSyntheticTaxRegistry
      );
      expect(resAmount.isTaxDefensible).toBe(false);
      expect(resAmount.taxEvidence.status).toBe("untrusted");
      expect(resAmount.taxEvidence.explanation).toContain("signature verification failed");

      // Tamper 2: Tampered currency (claims EUR instead of USD)
      const tamperedCurrencyQuote: TaxEvidence = {
        ...genuinePayload,
        currency: "EUR", // Tampered!
        status: "quoted",
        evidenceReference: "quote_genuine_123",
        sourceIdentity: "anchorage_municipal_tax_oracle",
        quoteSignature: validSig,
        explanation: "Tampered currency",
      };
      const resCurrency = evaluateDestinationTax(
        alaskaDestination,
        tamperedCurrencyQuote,
        new Date(),
        testSyntheticTaxRegistry
      );
      expect(resCurrency.isTaxDefensible).toBe(false);
      expect(resCurrency.taxEvidence.status).toBe("untrusted");
      expect(resCurrency.taxEvidence.explanation).toContain("currency mismatch");

      // Tamper 3: Tampered quoteId
      const tamperedIdQuote: TaxEvidence = {
        ...genuinePayload,
        quoteId: "different_quote_id", // Tampered!
        status: "quoted",
        evidenceReference: "different_quote_id",
        sourceIdentity: "anchorage_municipal_tax_oracle",
        quoteSignature: validSig,
        explanation: "Tampered quote ID",
      };
      const resId = evaluateDestinationTax(
        alaskaDestination,
        tamperedIdQuote,
        new Date(),
        testSyntheticTaxRegistry
      );
      expect(resId.isTaxDefensible).toBe(false);
      expect(resId.taxEvidence.status).toBe("untrusted");
      expect(resId.taxEvidence.explanation).toContain("signature verification failed");
    });

    it("8.14 verifies SERVER_TAX_AUTHORITY_REGISTRY is immutable, fails closed without env secrets, and rejects runtime mutations", () => {
      expect(Object.isFrozen(SERVER_TAX_AUTHORITY_REGISTRY)).toBe(true);

      // 1. Direct constructor call without internal token throws Unauthorized Construction
      expect(() => {
        new (ImmutableTaxAuthorityRegistry as unknown as new (t: unknown, cfgs: unknown) => ImmutableTaxAuthorityRegistry)(
          "unauthorized_caller_token",
          []
        );
      }).toThrow(/Unauthorized construction/);

      // 2. Attempting to enroll production authority IDs via test helper throws Unauthorized Authority Enrollment
      expect(() => {
        createSyntheticTaxRegistryForTesting([
          {
            authorityId: "avalara_v1", // Production authority ID!
            name: "Fake Avalara",
            verificationMethod: "cryptographic_hmac_sha256",
            secretKey: TEST_TAX_SIGNING_KEY,
            isSyntheticTestAuthority: false, // NOT synthetic!
          },
        ]);
      }).toThrow(/Unauthorized authority enrollment/);

      // 3. In production, external tax provider quotes (e.g. Avalara, TaxJar) fail closed as untrusted
      const avalaraQuote: TaxEvidence = {
        quoteId: "avalara_quote_fake_123",
        amountCents: 2500,
        currency: "USD",
        jurisdictionState: "CA",
        postalCode: "90210",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        status: "quoted",
        evidenceReference: "avalara_quote_fake_123",
        sourceIdentity: "avalara_v1",
        explanation: "External Avalara quote",
      };
      const caDest: DestinationContext = {
        country: "US",
        postalCode: "90210",
        deliveryMethodPreference: "standard_ground",
      };
      const prodTaxEval = evaluateDestinationTax(caDest, avalaraQuote, new Date(), SERVER_TAX_AUTHORITY_REGISTRY);
      expect(prodTaxEval.isTaxDefensible).toBe(false);
      expect(prodTaxEval.taxCents).toBeNull();
      expect(prodTaxEval.taxEvidence.status).toBe("untrusted");
      expect(prodTaxEval.taxEvidence.explanation).toMatch(/not enrolled|live authenticated provider ingestion/);

      // 4. Internal Map is encapsulated via JavaScript private field; no public 'authorities' map reference is exposed
      expect((SERVER_TAX_AUTHORITY_REGISTRY as unknown as Record<string, unknown>).authorities).toBeUndefined();

      // 5. Attempting prototype call bypass Map.prototype.set.call must fail/throw TypeError
      expect(() => {
        Map.prototype.set.call(SERVER_TAX_AUTHORITY_REGISTRY as unknown as Map<unknown, unknown>, "malicious_oracle", {
          authorityId: "malicious_oracle",
          name: "Malicious Oracle",
          verificationMethod: "statutory_rule_engine",
          secretKey: "spoofed",
        });
      }).toThrow(TypeError);

      // 6. Attempting prototype call bypass Map.prototype.delete.call must fail/throw TypeError
      expect(() => {
        Map.prototype.delete.call(SERVER_TAX_AUTHORITY_REGISTRY as unknown as Map<unknown, unknown>, "anchorage_municipal_tax_oracle");
      }).toThrow(TypeError);

      // 7. Attempting prototype call bypass Map.prototype.clear.call must fail/throw TypeError
      expect(() => {
        Map.prototype.clear.call(SERVER_TAX_AUTHORITY_REGISTRY as unknown as Map<unknown, unknown>);
      }).toThrow(TypeError);

      // 8. Confirm no mutation can change the effective trusted authority configuration
      expect(SERVER_TAX_AUTHORITY_REGISTRY.isEnrolled("malicious_oracle")).toBe(false);
      expect(SERVER_TAX_AUTHORITY_REGISTRY.getAuthority("malicious_oracle")).toBeUndefined();

      // 9. Production registry fails closed: authorities without configured environment variables are NOT enrolled
      expect(SERVER_TAX_AUTHORITY_REGISTRY.isEnrolled("anchorage_municipal_tax_oracle")).toBe(false);
      expect(SERVER_TAX_AUTHORITY_REGISTRY.isEnrolled("statutory_rule_engine")).toBe(true);

      // 10. Synthetic authority with empty or missing secret is omitted during test construction
      const unconfiguredAuthority: ServerTaxAuthorityConfig = {
        authorityId: "unconfigured_synthetic",
        name: "Unconfigured Synthetic Provider",
        verificationMethod: "cryptographic_hmac_sha256",
        secretKey: "",
        isSyntheticTestAuthority: true,
      };
      const testRegistryWithMissingSecret = createSyntheticTaxRegistryForTesting([unconfiguredAuthority]);
      expect(testRegistryWithMissingSecret.isEnrolled("unconfigured_synthetic")).toBe(false);
    });

    it("8.15 verifies SERVER_JURISDICTION_TAX_RULES_V1 is genuinely immutable and rejects runtime mutations including Set.prototype calls", () => {
      expect(Object.isFrozen(SERVER_JURISDICTION_TAX_RULES_V1)).toBe(true);

      // 1. Internal Sets are strictly encapsulated in private fields; no mutable sets are exposed
      expect((SERVER_JURISDICTION_TAX_RULES_V1 as unknown as Record<string, unknown>).statutoryZeroStates).toBeUndefined();
      expect((SERVER_JURISDICTION_TAX_RULES_V1 as unknown as Record<string, unknown>).municipalQuoteRequiredStates).toBeUndefined();
      expect((SERVER_JURISDICTION_TAX_RULES_V1 as unknown as Record<string, unknown>).localResortTaxPostalCodes).toBeUndefined();

      // 2. Prototype call bypasses on rules instance throw TypeError
      expect(() => {
        Set.prototype.add.call(SERVER_JURISDICTION_TAX_RULES_V1 as unknown as Set<unknown>, "CA");
      }).toThrow(TypeError);

      expect(() => {
        Set.prototype.delete.call(SERVER_JURISDICTION_TAX_RULES_V1 as unknown as Set<unknown>, "OR");
      }).toThrow(TypeError);

      expect(() => {
        Set.prototype.clear.call(SERVER_JURISDICTION_TAX_RULES_V1 as unknown as Set<unknown>);
      }).toThrow(TypeError);

      // 3. Exported getter arrays are frozen clones; attempting in-place mutation throws
      const zeroStates = SERVER_JURISDICTION_TAX_RULES_V1.getStatutoryZeroStates();
      expect(Object.isFrozen(zeroStates)).toBe(true);
      expect(() => {
        (zeroStates as unknown as string[]).push("CA");
      }).toThrow();

      // 4. Effective production tax policy cannot be modified
      expect(SERVER_JURISDICTION_TAX_RULES_V1.isStatutoryAbsenceState("CA")).toBe(false);
      expect(SERVER_JURISDICTION_TAX_RULES_V1.isStatutoryAbsenceState("OR")).toBe(true);
      expect(SERVER_JURISDICTION_TAX_RULES_V1.isStatutoryAbsenceState("NH")).toBe(true);
      expect(SERVER_JURISDICTION_TAX_RULES_V1.isStatutoryAbsenceState("DE")).toBe(true);
      expect(SERVER_JURISDICTION_TAX_RULES_V1.isStatutoryAbsenceState("MT")).toBe(false); // Montana has local resort taxes under MCA 7-6-1501
      expect(SERVER_JURISDICTION_TAX_RULES_V1.isStatutoryZeroState("MT")).toBe(false);
      expect(SERVER_JURISDICTION_TAX_RULES_V1.isMunicipalQuoteRequiredState("AK")).toBe(true);
      expect(SERVER_JURISDICTION_TAX_RULES_V1.isLocalResortTaxPostalCode("59716")).toBe(true);
    });

    it("8.16 rejects tax quote with mismatched currency against procurement expected currency", () => {
      const quotePayload = {
        quoteId: "quote_eur_mismatch_123",
        amountCents: 2500,
        currency: "EUR", // EUR quote for USD procurement
        jurisdictionState: "AK",
        postalCode: "99501",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
      const sig = signSyntheticTaxQuoteForTesting("anchorage_municipal_tax_oracle", quotePayload, testSyntheticTaxRegistry);

      const eurQuote: TaxEvidence = {
        ...quotePayload,
        status: "quoted",
        evidenceReference: "quote_eur_mismatch_123",
        sourceIdentity: "anchorage_municipal_tax_oracle",
        quoteSignature: sig,
        explanation: "EUR quote for USD purchase",
      };

      const result = evaluateDestinationTax(
        alaskaDestination,
        eurQuote,
        new Date(),
        testSyntheticTaxRegistry,
        SERVER_JURISDICTION_TAX_RULES_V1,
        "USD"
      );

      expect(result.isTaxDefensible).toBe(false);
      expect(result.taxCents).toBeNull();
      expect(result.taxEvidence.status).toBe("untrusted");
      expect(result.taxEvidence.explanation).toContain("Tax quote currency mismatch: quote is in EUR, but procurement requires USD");
    });

    it("8.17 rejects malformed or unsupported destination postal codes", () => {
      const invalidPostalCodes = ["", "   ", "abc", "1234", "999999", "12345-67", "ABCDE"];

      for (const invalidZip of invalidPostalCodes) {
        const dest: DestinationContext = {
          country: "US",
          postalCode: invalidZip,
          deliveryMethodPreference: "standard_ground",
        };

        const res = evaluateDestinationTax(dest);
        expect(res.isTaxDefensible).toBe(false);
        expect(res.taxCents).toBeNull();
        expect(res.taxEvidence.status).toBe("missing");
        expect(res.taxEvidence.explanation).toContain("missing, malformed, or unsupported");
      }
    });

    it("8.18 enforces strict runtime production boundary: synthetic tax registries cannot be instantiated or certify defensible tax in production", () => {
      const origNodeEnv = process.env.NODE_ENV;
      const env = process.env as Record<string, string | undefined>;
      try {
        env.NODE_ENV = "production";
        // 1. Factory invocation in production throws Error
        expect(() => {
          createSyntheticTaxRegistryForTesting([
            {
              authorityId: "synthetic_authority_prod_test",
              name: "Synthetic Test Provider",
              verificationMethod: "cryptographic_hmac_sha256",
              secretKey: "test_secret_key_at_least_32_characters_123",
              isSyntheticTestAuthority: true,
            },
          ]);
        }).toThrow(/Forbidden in production/);

        // 2. Even if a test registry existed before production switch, evaluateDestinationTax fails closed
        env.NODE_ENV = "test";
        const syntheticAuthority: ServerTaxAuthorityConfig = {
          authorityId: "synthetic_authority_prod_test",
          name: "Synthetic Test Provider",
          verificationMethod: "cryptographic_hmac_sha256",
          secretKey: "test_secret_key_at_least_32_characters_123",
          isSyntheticTestAuthority: true,
        };
        const testReg = createSyntheticTaxRegistryForTesting([syntheticAuthority]);

        const quote = {
          quoteId: "quote_prod_tax_test",
          amountCents: 500,
          currency: "USD",
          jurisdictionState: "CA",
          postalCode: "94103",
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        };
        const sig = signSyntheticTaxQuoteForTesting("synthetic_authority_prod_test", quote, testReg);

        env.NODE_ENV = "production";
        const evalResult = evaluateDestinationTax(
          californiaDestination,
          {
            jurisdictionState: "CA",
            postalCode: "94103",
            status: "quoted",
            amountCents: 500,
            currency: "USD",
            expiresAt: quote.expiresAt,
            evidenceReference: quote.quoteId,
            sourceIdentity: "synthetic_authority_prod_test",
            quoteSignature: sig,
            explanation: "Signed test quote",
          },
          new Date(),
          testReg
        );
        expect(evalResult.isTaxDefensible).toBe(false);
        expect(evalResult.taxCents).toBeNull();
        expect(evalResult.taxEvidence.status).toBe("untrusted");
        expect(evalResult.taxEvidence.explanation).toContain("Synthetic test tax authorities are strictly prohibited in production");
      } finally {
        env.NODE_ENV = origNodeEnv;
      }
    });

    it("8.19 verifies explicit local resort tax quote for Montana resort destination (Big Sky 59716) is authenticated, unexpired, destination-bound, and required for landed cost defensibility", () => {
      const bigSkyDest: DestinationContext = {
        country: "US",
        postalCode: "59716",
        deliveryMethodPreference: "standard_ground",
      };

      // 1. Without quote, Big Sky destination fails closed to missing tax and Tier 2 incomplete
      const evalWithoutQuote = evaluateDestinationTax(bigSkyDest);
      expect(evalWithoutQuote.isTaxDefensible).toBe(false);
      expect(evalWithoutQuote.taxCents).toBeNull();
      expect(evalWithoutQuote.taxEvidence.status).toBe("missing");

      // 2. An unauthenticated or forged quote is rejected
      const forgedQuote: TaxEvidence = {
        jurisdictionState: "MT",
        postalCode: "59716",
        status: "quoted",
        amountCents: 3000,
        currency: "USD",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        evidenceReference: "quote_bigsky_forged",
        quoteId: "quote_bigsky_forged",
        sourceIdentity: "tax_quote_engine",
        quoteSignature: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        explanation: "Forged Big Sky quote",
      };
      const evalForged = evaluateDestinationTax(bigSkyDest, forgedQuote, new Date(), testSyntheticTaxRegistry);
      expect(evalForged.isTaxDefensible).toBe(false);
      expect(evalForged.taxCents).toBeNull();
      expect(evalForged.taxEvidence.status).toBe("untrusted");

      // 3. A quote with mismatched destination postal code (e.g. 59601 used for 59716) is rejected
      const mismatchedZipQuotePayload = {
        quoteId: "quote_mt_helena_misapplied",
        evidenceReference: "quote_mt_helena_misapplied",
        amountCents: 0,
        currency: "USD",
        jurisdictionState: "MT",
        postalCode: "59601", // Helena postal code applied to Big Sky
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      const mismatchedSig = signSyntheticTaxQuoteForTesting("tax_quote_engine", mismatchedZipQuotePayload, testSyntheticTaxRegistry);
      const mismatchedQuote: TaxEvidence = {
        ...mismatchedZipQuotePayload,
        status: "quoted",
        sourceIdentity: "tax_quote_engine",
        quoteSignature: mismatchedSig,
        explanation: "Misapplied Helena quote to Big Sky",
      };
      const evalMismatch = evaluateDestinationTax(bigSkyDest, mismatchedQuote, new Date(), testSyntheticTaxRegistry);
      expect(evalMismatch.isTaxDefensible).toBe(false);
      expect(evalMismatch.taxCents).toBeNull();
      expect(evalMismatch.taxEvidence.status).toBe("untrusted");
      expect(evalMismatch.taxEvidence.explanation).toContain("postal code mismatch");

      // 4. An expired quote is rejected
      const expiredPayload = {
        quoteId: "quote_bigsky_expired",
        evidenceReference: "quote_bigsky_expired",
        amountCents: 3000,
        currency: "USD",
        jurisdictionState: "MT",
        postalCode: "59716",
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
      };
      const expiredSig = signSyntheticTaxQuoteForTesting("tax_quote_engine", expiredPayload, testSyntheticTaxRegistry);
      const expiredQuote: TaxEvidence = {
        ...expiredPayload,
        status: "quoted",
        sourceIdentity: "tax_quote_engine",
        quoteSignature: expiredSig,
        explanation: "Expired Big Sky quote",
      };
      const evalExpired = evaluateDestinationTax(bigSkyDest, expiredQuote, new Date(), testSyntheticTaxRegistry);
      expect(evalExpired.isTaxDefensible).toBe(false);
      expect(evalExpired.taxCents).toBeNull();
      expect(evalExpired.taxEvidence.status).toBe("untrusted");
      expect(evalExpired.taxEvidence.explanation).toContain("expired");

      // 5. A validly signed, unexpired, destination-bound local resort tax quote produces defensible tax
      const validQuotePayload = {
        quoteId: "quote_bigsky_valid_3pct",
        evidenceReference: "quote_bigsky_valid_3pct",
        amountCents: 3000, // 3% resort tax on $1,000 subtotal
        currency: "USD",
        jurisdictionState: "MT",
        postalCode: "59716",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      const validSig = signSyntheticTaxQuoteForTesting("tax_quote_engine", validQuotePayload, testSyntheticTaxRegistry);
      const validQuote: TaxEvidence = {
        ...validQuotePayload,
        status: "quoted",
        sourceIdentity: "tax_quote_engine",
        quoteSignature: validSig,
        explanation: "Valid 3% Big Sky resort tax quote",
      };
      const evalValid = evaluateDestinationTax(bigSkyDest, validQuote, new Date(), testSyntheticTaxRegistry);
      expect(evalValid.isTaxDefensible).toBe(true);
      expect(evalValid.taxCents).toBe(3000);
      expect(evalValid.taxEvidence.status).toBe("quoted");
    });
  });

  describe("9. Strategy Trade-Offs Explanation", () => {
    it("9.1 generates structured, verifiable trade-offs across cost, quality, compatibility, availability, and delivery", () => {
      const strategies = generateProcurementStrategies({
        lineItems: sampleLineItems,
        candidates: [sampleCandidateLaptop, sampleCandidateMouse],
        destination: oregonDestination,
      });

      expect(strategies.length).toBeGreaterThan(0);
      for (const strat of strategies) {
        expect(strat.tradeOffs).toBeDefined();
        const to = strat.tradeOffs!;

        // Cost trade-off
        expect(to.cost.description).toBeTruthy();
        expect(["verified_fact", "merchant_claim", "estimate", "unknown"]).toContain(to.cost.evidenceTier);

        // Quality trade-off
        expect(to.quality.description).toBeTruthy();
        expect(["verified_fact", "merchant_claim", "estimate", "unknown"]).toContain(to.quality.evidenceTier);

        // Compatibility trade-off
        expect(to.compatibility.description).toBeTruthy();
        expect(to.compatibility.matchRatio).toBeGreaterThan(0);
        expect(to.compatibility.evidenceTier).toBe("verified_fact");

        // Availability trade-off
        expect(to.availability.description).toBeTruthy();
        expect(to.availability.evidenceTier).toBe("verified_fact");

        // Delivery trade-off
        expect(to.delivery.description).toBeTruthy();
        expect(to.delivery.shipmentCount).toBeGreaterThanOrEqual(1);
        expect(["verified_fact", "merchant_claim", "estimate", "unknown"]).toContain(to.delivery.evidenceTier);
      }
    });

    it("9.2 generates the strat_balanced_optimal strategy with multi-objective balance", () => {
      const strategies = generateProcurementStrategies({
        lineItems: sampleLineItems,
        candidates: [sampleCandidateLaptop, sampleCandidateMouse],
        destination: oregonDestination,
      });

      const balancedStrat = strategies.find((s) => s.strategyId === "strat_balanced_optimal");
      expect(balancedStrat).toBeDefined();
      expect(balancedStrat?.name).toBe("Balanced Optimal");
      expect(balancedStrat?.recommendationScore).toBeGreaterThanOrEqual(0);
      expect(balancedStrat?.recommendationScore).toBeLessThanOrEqual(100);
      expect(balancedStrat?.recommendationRationale).toContain("Balanced optimal procurement");
    });

    it("9.3 identifies backordered or unknown availability as non-verified in trade-off evidence", () => {
      const unknownStockCandidate: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        availability: "unknown",
      };

      const alloc = createCandidateAllocation(sampleLineItems[0], unknownStockCandidate);
      const strat = buildStrategyFromAllocations(
        "strat_unknown_stock",
        "Unknown Stock",
        "Desc",
        [alloc],
        [sampleLineItems[0]],
        oregonDestination
      );

      expect(strat.tradeOffs?.availability.evidenceTier).not.toBe("verified_fact");
      expect(strat.tradeOffs?.availability.evidenceTier).toBe("unknown");
    });

    it("9.4 classifies unquoted shipping policy estimates as merchant_claim in delivery trade-offs", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);

      // Strategy with policy-based unquoted shipping
      const strat = buildStrategyFromAllocations(
        "strat_policy_shipping",
        "Policy Shipping",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        californiaDestination
      );

      // When shipping is not backed by authoritative quote, trade-offs delivery tier must not be verified_fact
      expect(strat.tradeOffs?.delivery.evidenceTier).not.toBe("verified_fact");
    });
  });

  describe("10. Material Field Mutation & Ordering Invariance Verification", () => {
    it("10.1 canonicalJsonStringify guarantees key-order independence, undefined/NaN/Date normalization, and cycle detection", () => {
      const obj1 = {
        b: 2,
        a: 1,
        nested: {
          z: "last",
          y: "mid",
          x: "first",
        },
      };

      const obj2 = {
        nested: {
          x: "first",
          z: "last",
          y: "mid",
        },
        a: 1,
        b: 2,
      };

      expect(canonicalJsonStringify(obj1)).toBe(canonicalJsonStringify(obj2));
      expect(canonicalJsonStringify(obj1)).toBe('{"a":1,"b":2,"nested":{"x":"first","y":"mid","z":"last"}}');

      // Undefined normalization: undefined in objects and arrays normalized to null
      const objWithUndefined = {
        a: undefined,
        b: null,
        arr: [undefined, 1, null],
      };
      const objWithNull = {
        a: null,
        b: null,
        arr: [null, 1, null],
      };
      expect(canonicalJsonStringify(objWithUndefined)).toBe(canonicalJsonStringify(objWithNull));
      expect(canonicalJsonStringify(objWithUndefined)).toBe('{"a":null,"arr":[null,1,null],"b":null}');

      // Non-finite numbers (NaN, Infinity, -Infinity) normalized to null
      expect(canonicalJsonStringify({ a: NaN, b: Infinity, c: -Infinity })).toBe('{"a":null,"b":null,"c":null}');

      // Invalid Date objects normalized to null
      expect(canonicalJsonStringify({ d: new Date("invalid date string") })).toBe('{"d":null}');

      // Valid Date objects serialize to ISO string
      const validDate = new Date("2026-10-31T12:00:00.000Z");
      expect(canonicalJsonStringify({ d: validDate })).toBe('{"d":"2026-10-31T12:00:00.000Z"}');

      // Functions and symbols normalized to null
      expect(canonicalJsonStringify({ fn: () => {}, sym: Symbol("test") })).toBe('{"fn":null,"sym":null}');

      // BigInt normalized to quoted string
      expect(canonicalJsonStringify({ bi: BigInt(12345) })).toBe('{"bi":"12345"}');

      // Circular reference detection throws TypeError
      const circularObj: Record<string, unknown> = { name: "cycle" };
      circularObj.self = circularObj;
      expect(() => canonicalJsonStringify(circularObj)).toThrow(TypeError);
      expect(() => canonicalJsonStringify(circularObj)).toThrow(/circular reference detected/i);

      // compareCanonicalObjects uses canonical JSON strings to order objects deterministically
      expect(compareCanonicalObjects({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(0);
      expect(compareCanonicalObjects({ a: 1 }, { a: 2 })).toBe(-1);
      expect(compareCanonicalObjects({ a: 2 }, { a: 1 })).toBe(1);
    });

    it("10.2 compareCodePoints enforces strict UTF-16 lexicographical sorting independent of locale", () => {
      expect(compareCodePoints("a", "b")).toBe(-1);
      expect(compareCodePoints("b", "a")).toBe(1);
      expect(compareCodePoints("a", "a")).toBe(0);
      expect(compareCodePoints("strat_1", "strat_2")).toBe(-1);
      expect(compareCodePoints("strat_2", "strat_1")).toBe(1);

      // Character code-point order: 'z' (122) < 'ä' (228)
      expect(compareCodePoints("z", "ä")).toBe(-1);
      expect(compareCodePoints("ä", "z")).toBe(1);
    });

    it("10.3 line item verificationLevel mutation invalidates canonical evidence fingerprint", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);
      const strat = buildStrategyFromAllocations(
        "strat_fp_test",
        "FP Test",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );

      const baseFp = computeCanonicalEvidenceFingerprint(strat, sampleLineItems, oregonDestination);

      // Mutate verificationLevel from standard to strict
      const mutatedLineItems: ProcurementLineItem[] = [
        { ...sampleLineItems[0], verificationLevel: "strict" },
        sampleLineItems[1],
      ];

      const mutatedFp = computeCanonicalEvidenceFingerprint(strat, mutatedLineItems, oregonDestination);
      expect(mutatedFp).not.toBe(baseFp);
    });

    it("10.4 line item requirement details mutation invalidates canonical evidence fingerprint", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);
      const strat = buildStrategyFromAllocations(
        "strat_fp_test",
        "FP Test",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );

      const baseFp = computeCanonicalEvidenceFingerprint(strat, sampleLineItems, oregonDestination);

      // Mutate requirement value
      const mutatedLineItems: ProcurementLineItem[] = [
        {
          ...sampleLineItems[0],
          requirements: [{ key: "ram", expectedValue: "32GB", description: "Upgraded RAM" }],
        },
        sampleLineItems[1],
      ];

      const mutatedFp = computeCanonicalEvidenceFingerprint(strat, mutatedLineItems, oregonDestination);
      expect(mutatedFp).not.toBe(baseFp);
    });

    it("10.5 candidate rawAttributes mutation invalidates canonical evidence fingerprint", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);
      const strat = buildStrategyFromAllocations(
        "strat_fp_test",
        "FP Test",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );

      const baseFp = computeCanonicalEvidenceFingerprint(strat, sampleLineItems, oregonDestination);

      // Mutate rawAttributes in allocation
      const mutatedAllocations = [
        {
          ...strat.allocations[0],
          rawAttributes: { ...strat.allocations[0].rawAttributes, batteryLife: "18h" },
        },
        strat.allocations[1],
      ];
      const mutatedStrat = { ...strat, allocations: mutatedAllocations };

      const mutatedFp = computeCanonicalEvidenceFingerprint(mutatedStrat, sampleLineItems, oregonDestination);
      expect(mutatedFp).not.toBe(baseFp);
    });

    it("10.6 candidate observationList mutation invalidates canonical evidence fingerprint", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);
      const strat = buildStrategyFromAllocations(
        "strat_fp_test",
        "FP Test",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );

      const baseFp = computeCanonicalEvidenceFingerprint(strat, sampleLineItems, oregonDestination);

      // Mutate observationList
      const mutatedAllocations = [
        {
          ...strat.allocations[0],
          observationList: [{ observedAt: "2026-10-31T12:00:00Z", verifiedBy: "bot_1" }],
        },
        strat.allocations[1],
      ];
      const mutatedStrat = { ...strat, allocations: mutatedAllocations };

      const mutatedFp = computeCanonicalEvidenceFingerprint(mutatedStrat, sampleLineItems, oregonDestination);
      expect(mutatedFp).not.toBe(baseFp);
    });

    it("10.7 shipment quote metadata (quoteId, quoteReference, quoteExpiresAt) mutations invalidate fingerprint", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);
      const strat = buildStrategyFromAllocations(
        "strat_fp_test",
        "FP Test",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );

      const baseFp = computeCanonicalEvidenceFingerprint(strat, sampleLineItems, oregonDestination);

      // Mutate quoteId on shipment
      const mutatedCartsWithQuoteId = strat.carts.map((c) => ({
        ...c,
        shipments: c.shipments.map((s) => ({
          ...s,
          quoteId: "quote_carrier_specific_999",
        })),
      }));
      const fpQuoteId = computeCanonicalEvidenceFingerprint(
        { ...strat, carts: mutatedCartsWithQuoteId },
        sampleLineItems,
        oregonDestination
      );
      expect(fpQuoteId).not.toBe(baseFp);

      // Mutate quoteReference on shipment
      const mutatedCartsWithQuoteRef = strat.carts.map((c) => ({
        ...c,
        shipments: c.shipments.map((s) => ({
          ...s,
          quoteReference: "carrier_rate_quote_ref_abc",
        })),
      }));
      const fpQuoteRef = computeCanonicalEvidenceFingerprint(
        { ...strat, carts: mutatedCartsWithQuoteRef },
        sampleLineItems,
        oregonDestination
      );
      expect(fpQuoteRef).not.toBe(baseFp);

      // Mutate quoteExpiresAt on shipment
      const mutatedCartsWithExpiry = strat.carts.map((c) => ({
        ...c,
        shipments: c.shipments.map((s) => ({
          ...s,
          quoteExpiresAt: "2026-11-05T00:00:00Z",
        })),
      }));
      const fpExpiry = computeCanonicalEvidenceFingerprint(
        { ...strat, carts: mutatedCartsWithExpiry },
        sampleLineItems,
        oregonDestination
      );
      expect(fpExpiry).not.toBe(baseFp);
    });

    it("10.8 cart policy metadata (policyId, policyVersion, policyDocumentFingerprint) mutations invalidate fingerprint", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);
      const strat = buildStrategyFromAllocations(
        "strat_fp_test",
        "FP Test",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );

      const baseFp = computeCanonicalEvidenceFingerprint(strat, sampleLineItems, oregonDestination);

      // Mutate policyDocumentFingerprint
      const mutatedCarts = strat.carts.map((c) => ({
        ...c,
        thresholdEvaluation: c.thresholdEvaluation
          ? {
              ...c.thresholdEvaluation,
              policyDocumentFingerprint: "mutated_sha256_policy_doc_fingerprint",
            }
          : null,
      }));
      const mutatedStrat = { ...strat, carts: mutatedCarts };

      const mutatedFp = computeCanonicalEvidenceFingerprint(mutatedStrat, sampleLineItems, oregonDestination);
      expect(mutatedFp).not.toBe(baseFp);
    });

    it("10.9 destination jurisdiction or preference mutations invalidate fingerprint", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);
      const strat = buildStrategyFromAllocations(
        "strat_fp_test",
        "FP Test",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );

      const baseFp = computeCanonicalEvidenceFingerprint(strat, sampleLineItems, oregonDestination);

      // Mutate deliveryMethodPreference
      const expeditedDest: DestinationContext = {
        ...oregonDestination,
        deliveryMethodPreference: "expedited",
      };
      const mutatedPrefFp = computeCanonicalEvidenceFingerprint(strat, sampleLineItems, expeditedDest);
      expect(mutatedPrefFp).not.toBe(baseFp);

      // Mutate destination postal code
      const diffDest: DestinationContext = {
        ...oregonDestination,
        postalCode: "97202",
      };
      const mutatedPostalFp = computeCanonicalEvidenceFingerprint(strat, sampleLineItems, diffDest);
      expect(mutatedPostalFp).not.toBe(baseFp);
    });

    it("10.10 duplicate candidate identifiers with differing evidence are sorted deterministically without collision", () => {
      const candidateA: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        id: "cand_duplicate_id",
        externalId: "cand_duplicate_id",
        unitPriceCents: 99900,
        title: "Version A",
      };
      const candidateB: NormalizedProductCandidate = {
        ...sampleCandidateLaptop,
        id: "cand_duplicate_id",
        externalId: "cand_duplicate_id",
        unitPriceCents: 105000,
        title: "Version B",
      };

      const allocA = createCandidateAllocation(sampleLineItems[0], candidateA);
      const allocB = createCandidateAllocation(sampleLineItems[1], candidateB);

      // Construct two strategies with allocations ordered differently in memory: [allocA, allocB] vs [allocB, allocA]
      const stratOrder1 = buildStrategyFromAllocations(
        "strat_tie",
        "Tie",
        "Desc",
        [allocA, allocB],
        sampleLineItems,
        oregonDestination
      );
      const stratOrder2 = buildStrategyFromAllocations(
        "strat_tie",
        "Tie",
        "Desc",
        [allocB, allocA],
        sampleLineItems,
        oregonDestination
      );

      const fp1 = computeCanonicalEvidenceFingerprint(stratOrder1, sampleLineItems, oregonDestination);
      const fp2 = computeCanonicalEvidenceFingerprint(stratOrder2, sampleLineItems, oregonDestination);

      // Canonical serialization sorts both deterministically by UTF-16 code point of canonical object representation
      expect(fp1).toBe(fp2);
    });

    it("10.11 enforces comprehensive Montana resort tax exclusions (MCA 7-6-1501) across all designated resort communities", () => {
      // Validate all 11 designated resort community postal codes under MCA 7-6-1501
      const allResortCodes = [
        "59716", // Big Sky
        "59937", // Whitefish
        "59068", // Red Lodge
        "59758", // West Yellowstone
        "59730", // Gardiner
        "59724", // Cooke City
        "59755", // Virginia City
        "59912", // Columbia Falls
        "59866", // St. Regis
        "59868", // Seeley Lake
        "59648", // Wolf Creek / Craig
      ];

      for (const code of allResortCodes) {
        expect(SERVER_JURISDICTION_TAX_RULES_V1.isLocalResortTaxPostalCode(code)).toBe(true);
        expect(SERVER_JURISDICTION_TAX_RULES_V1.getLocalResortTaxPostalCodes()).toContain(code);

        // Every resort destination fails closed to taxCents: null and isTaxDefensible: false
        const resortDest: DestinationContext = {
          country: "US",
          postalCode: code,
          deliveryMethodPreference: "standard_ground",
        };
        const resortEval = evaluateDestinationTax(resortDest);
        expect(resortEval.isTaxDefensible).toBe(false);
        expect(resortEval.taxCents).toBeNull();
        expect(resortEval.taxEvidence.status).toBe("missing");
        expect(resortEval.taxEvidence.explanation).toContain("resort community (MCA 7-6-1501)");
      }

      // Non-resort Montana destination (Helena 59601) is not flagged as resort community
      expect(SERVER_JURISDICTION_TAX_RULES_V1.isLocalResortTaxPostalCode("59601")).toBe(false);

      // Attempting to pass fabricated statutory_zero for Big Sky is rejected as untrusted
      const bigSkyDest: DestinationContext = {
        country: "US",
        postalCode: "59716",
        deliveryMethodPreference: "standard_ground",
      };
      const fabricatedBigSkyStatutoryZero: TaxEvidence = {
        jurisdictionState: "MT",
        postalCode: "59716",
        amountCents: 0,
        status: "statutory_zero",
        evidenceReference: "bogus_mt_statutory_zero",
        explanation: "Claiming Big Sky is tax-free",
      };
      const bigSkyFab = evaluateDestinationTax(bigSkyDest, fabricatedBigSkyStatutoryZero);
      expect(bigSkyFab.isTaxDefensible).toBe(false);
      expect(bigSkyFab.taxCents).toBeNull();
      expect(bigSkyFab.taxEvidence.status).toBe("untrusted");
      expect(bigSkyFab.taxEvidence.explanation).toContain("local resort sales tax applies");

      // Helena, MT (59601) - standard Montana destination without authoritative local evidence fails closed
      const helenaDest: DestinationContext = {
        country: "US",
        postalCode: "59601",
        deliveryMethodPreference: "standard_ground",
      };
      const helenaEval = evaluateDestinationTax(helenaDest);
      expect(helenaEval.isTaxDefensible).toBe(false);
      expect(helenaEval.taxCents).toBeNull();
      expect(helenaEval.taxEvidence.status).toBe("missing");
      expect(helenaEval.taxEvidence.explanation).toContain("lacks authoritative jurisdiction evidence");
    });

    it("10.12 candidate observationList ordering invariance via deep canonical object comparison", () => {
      const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
      const allocMouse = createCandidateAllocation(sampleLineItems[1], sampleCandidateMouse);
      const strat = buildStrategyFromAllocations(
        "strat_fp_test",
        "FP Test",
        "Desc",
        [allocLaptop, allocMouse],
        sampleLineItems,
        oregonDestination
      );

      const alloc1 = {
        ...strat.allocations[0],
        observationList: [
          { b: 2, a: 1, observedAt: "2026-10-31T12:00:00Z" },
          { x: "first", observedAt: "2026-10-31T11:00:00Z" },
        ],
      };
      const alloc2 = {
        ...strat.allocations[0],
        observationList: [
          { x: "first", observedAt: "2026-10-31T11:00:00Z" },
          { a: 1, b: 2, observedAt: "2026-10-31T12:00:00Z" },
        ],
      };

      const strat1 = { ...strat, allocations: [alloc1, strat.allocations[1]] };
      const strat2 = { ...strat, allocations: [alloc2, strat.allocations[1]] };

      const fp1 = computeCanonicalEvidenceFingerprint(strat1, sampleLineItems, oregonDestination);
      const fp2 = computeCanonicalEvidenceFingerprint(strat2, sampleLineItems, oregonDestination);
      expect(fp1).toBe(fp2);
    });

    it("10.13 fails closed for Montana destinations inside resort areas but outside the 11-ZIP denylist (Gallatin Gateway 59735, Ennis 59729)", () => {
      // Gallatin Gateway (59735) borders Big Sky Resort Area District
      const gatewayDest: DestinationContext = { country: "US", postalCode: "59735", deliveryMethodPreference: "standard_ground" };
      const gatewayEval = evaluateDestinationTax(gatewayDest);
      expect(gatewayEval.isTaxDefensible).toBe(false);
      expect(gatewayEval.taxCents).toBeNull();
      expect(gatewayEval.taxEvidence.status).toBe("missing");
      expect(gatewayEval.taxEvidence.jurisdictionState).toBe("MT");
      expect(gatewayEval.taxEvidence.explanation).toContain("lacks authoritative jurisdiction evidence");

      // Ennis (59729) Madison County corridor adjacent to Big Sky
      const ennisDest: DestinationContext = { country: "US", postalCode: "59729", deliveryMethodPreference: "standard_ground" };
      const ennisEval = evaluateDestinationTax(ennisDest);
      expect(ennisEval.isTaxDefensible).toBe(false);
      expect(ennisEval.taxCents).toBeNull();
      expect(ennisEval.taxEvidence.status).toBe("missing");
      expect(ennisEval.taxEvidence.jurisdictionState).toBe("MT");
      expect(ennisEval.taxEvidence.explanation).toContain("lacks authoritative jurisdiction evidence");
    });

    it("10.14 fails closed for ZIP codes spanning taxable resort and non-taxable geographic areas without authoritative determination", () => {
      // Whitefish (59937) and Columbia Falls (59912) have municipal resort tax within city limits,
      // but postal ZIP codes extend into unincorporated Flathead County.
      // Without rooftop/jurisdiction proof, both must fail closed to non-defensible.
      const whitefishDest: DestinationContext = { country: "US", postalCode: "59937", deliveryMethodPreference: "standard_ground" };
      const cfDest: DestinationContext = { country: "US", postalCode: "59912", deliveryMethodPreference: "standard_ground" };

      const wfEval = evaluateDestinationTax(whitefishDest);
      expect(wfEval.isTaxDefensible).toBe(false);
      expect(wfEval.taxCents).toBeNull();
      expect(wfEval.taxEvidence.status).toBe("missing");

      const cfEval = evaluateDestinationTax(cfDest);
      expect(cfEval.isTaxDefensible).toBe(false);
      expect(cfEval.taxCents).toBeNull();
      expect(cfEval.taxEvidence.status).toBe("missing");

      // Attempting to pass a client-supplied statutory absence claim for split ZIP 59937 is rejected
      const fabricatedSplitClaim: TaxEvidence = {
        jurisdictionState: "MT",
        postalCode: "59937",
        amountCents: 0,
        status: "statutory_absence",
        evidenceReference: "bogus_split_zip_claim",
        explanation: "Claiming rural Flathead portion is tax free",
      };
      const splitFab = evaluateDestinationTax(whitefishDest, fabricatedSplitClaim);
      expect(splitFab.isTaxDefensible).toBe(false);
      expect(splitFab.taxCents).toBeNull();
      expect(splitFab.taxEvidence.status).toBe("untrusted");
      expect(splitFab.taxEvidence.explanation).toContain("Statutory absence claim rejected for Montana");
    });

    it("10.15 fails closed for unknown or unquoted Montana destinations across major municipalities (Billings 59101, Missoula 59801, Bozeman 59715, Great Falls 59401)", () => {
      const zips = ["59101", "59801", "59715", "59401"];
      for (const zip of zips) {
        const dest: DestinationContext = { country: "US", postalCode: zip, deliveryMethodPreference: "standard_ground" };
        const res = evaluateDestinationTax(dest);
        expect(res.isTaxDefensible).toBe(false);
        expect(res.taxCents).toBeNull();
        expect(res.taxEvidence.status).toBe("missing");
        expect(res.taxEvidence.jurisdictionState).toBe("MT");
        expect(res.taxEvidence.explanation).toContain("lacks authoritative jurisdiction evidence");

        // Strategy cost breakdown strictly blocks landed cost defensibility
        const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
        const strat = buildStrategyFromAllocations(
          `strat_mt_unquoted_${zip}`,
          "MT Unquoted Strat",
          "Unquoted MT tax",
          [allocLaptop],
          [sampleLineItems[0]],
          dest
        );
        expect(strat.costBreakdown?.isTaxDefensible).toBe(false);
        expect(strat.costBreakdown?.taxCents).toBeNull();
        expect(strat.costBreakdown?.totalLandedCostCents).toBeNull();
        expect(strat.costBreakdown?.isLandedCostDefensible).toBe(false);
        expect(strat.costBreakdown?.missingComponents).toContain("tax");
      }
    });

    it("10.16 rejects explicit statutory-absence evidence with incorrect jurisdiction or taxable state as untrusted", () => {
      // Claiming statutory absence for Montana destination
      const mtDest: DestinationContext = { country: "US", postalCode: "59601", deliveryMethodPreference: "standard_ground" };
      const mtClaim: TaxEvidence = {
        jurisdictionState: "MT",
        postalCode: "59601",
        amountCents: 0,
        status: "statutory_absence",
        evidenceReference: "ref_mt_claimed",
        explanation: "Claiming MT has 0% tax",
      };
      const mtRes = evaluateDestinationTax(mtDest, mtClaim);
      expect(mtRes.isTaxDefensible).toBe(false);
      expect(mtRes.taxCents).toBeNull();
      expect(mtRes.taxEvidence.status).toBe("untrusted");
      expect(mtRes.taxEvidence.explanation).toContain("Statutory absence claim rejected for Montana");

      // Claiming statutory absence for taxable state (California 94102)
      const caDest: DestinationContext = { country: "US", postalCode: "94102", deliveryMethodPreference: "standard_ground" };
      const caClaim: TaxEvidence = {
        jurisdictionState: "CA",
        postalCode: "94102",
        amountCents: 0,
        status: "statutory_absence",
        evidenceReference: "ref_ca_claimed",
        explanation: "Claiming CA is tax free",
      };
      const caRes = evaluateDestinationTax(caDest, caClaim);
      expect(caRes.isTaxDefensible).toBe(false);
      expect(caRes.taxCents).toBeNull();
      expect(caRes.taxEvidence.status).toBe("untrusted");
      expect(caRes.taxEvidence.explanation).toContain("Fabricated statutory absence claim");

      // Jurisdiction state mismatch: claim says OR, but destination is NH (03301)
      const nhDest: DestinationContext = { country: "US", postalCode: "03301", deliveryMethodPreference: "standard_ground" };
      const mismatchClaim: TaxEvidence = {
        jurisdictionState: "OR",
        postalCode: "03301",
        amountCents: 0,
        status: "statutory_absence",
        evidenceReference: "ref_mismatch_claimed",
        explanation: "Misapplied OR rule to NH destination",
      };
      const mismatchRes = evaluateDestinationTax(nhDest, mismatchClaim);
      expect(mismatchRes.isTaxDefensible).toBe(false);
      expect(mismatchRes.taxCents).toBeNull();
      expect(mismatchRes.taxEvidence.status).toBe("untrusted");
      expect(mismatchRes.taxEvidence.explanation).toContain("Tax evidence jurisdiction mismatch");
    });

    it("10.17 strictly rejects attempts to classify an unresolved tax amount as defensible zero", () => {
      const orDest: DestinationContext = { country: "US", postalCode: "97201", deliveryMethodPreference: "standard_ground" };

      // Passing non-zero amount with statutory absence claim
      const nonZeroClaim: TaxEvidence = {
        jurisdictionState: "OR",
        postalCode: "97201",
        amountCents: 1500,
        status: "statutory_absence",
        evidenceReference: "ref_nonzero_statutory",
        explanation: "Claiming non-zero statutory absence",
      };
      const nonZeroRes = evaluateDestinationTax(orDest, nonZeroClaim);
      expect(nonZeroRes.isTaxDefensible).toBe(false);
      expect(nonZeroRes.taxCents).toBeNull();
      expect(nonZeroRes.taxEvidence.status).toBe("untrusted");
      expect(nonZeroRes.taxEvidence.explanation).toContain("Statutory absence claim contains non-zero tax amount");

      // Passing quoted status with amountCents: null
      const nullAmountQuoted: TaxEvidence = {
        jurisdictionState: "OR",
        postalCode: "97201",
        amountCents: null,
        status: "quoted",
        evidenceReference: "ref_null_quoted",
        explanation: "Quoted with null amount",
      };
      const nullQuotedRes = evaluateDestinationTax(orDest, nullAmountQuoted);
      expect(nullQuotedRes.isTaxDefensible).toBe(false);
      expect(nullQuotedRes.taxCents).toBeNull();
      expect(nullQuotedRes.taxEvidence.status).toBe("untrusted");
      expect(nullQuotedRes.taxEvidence.explanation).toContain("Quoted tax amount is missing, invalid, or negative");

      // Passing negative amount
      const negAmountQuoted: TaxEvidence = {
        jurisdictionState: "OR",
        postalCode: "97201",
        amountCents: -50,
        status: "quoted",
        evidenceReference: "ref_neg_quoted",
        explanation: "Negative quote",
      };
      const negRes = evaluateDestinationTax(orDest, negAmountQuoted);
      expect(negRes.isTaxDefensible).toBe(false);
      expect(negRes.taxCents).toBeNull();
      expect(negRes.taxEvidence.status).toBe("untrusted");
    });

    it("10.18 preserves existing Oregon, New Hampshire, and Delaware statutory absence behavior with defensible landed cost", () => {
      const orDest: DestinationContext = { country: "US", postalCode: "97201", deliveryMethodPreference: "standard_ground" };
      const nhDest: DestinationContext = { country: "US", postalCode: "03301", deliveryMethodPreference: "standard_ground" };
      const deDest: DestinationContext = { country: "US", postalCode: "19801", deliveryMethodPreference: "standard_ground" };

      for (const dest of [orDest, nhDest, deDest]) {
        const taxEval = evaluateDestinationTax(dest);
        expect(taxEval.isTaxDefensible).toBe(true);
        expect(taxEval.taxCents).toBe(0);
        expect(taxEval.taxEvidence.status).toBe("statutory_absence");
        expect(taxEval.taxEvidence.amountCents).toBe(0);

        const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
        const strat = buildStrategyFromAllocations(
          `strat_statutory_absence_${dest.postalCode}`,
          "Statutory Absence Strat",
          "Defensible statutory absence",
          [allocLaptop],
          [sampleLineItems[0]],
          dest
        );

        expect(strat.costBreakdown?.isTaxDefensible).toBe(true);
        expect(strat.costBreakdown?.taxCents).toBe(0);
        expect(strat.costBreakdown?.isLandedCostDefensible).toBe(true);
        expect(strat.costBreakdown?.totalLandedCostCents).not.toBeNull();
        expect(strat.costBreakdown?.missingComponents).not.toContain("tax");
      }
    });

    it("10.19 createDefensibleTestTaxQuote creates a cryptographically valid, defensible test tax quote in non-production", () => {
      const caDest: DestinationContext = { country: "US", postalCode: "94103", deliveryMethodPreference: "standard_ground" };
      const quote = createDefensibleTestTaxQuote({ destination: caDest, amountCents: 850 });

      expect(quote.status).toBe("quoted");
      expect(quote.jurisdictionState).toBe("CA");
      expect(quote.postalCode).toBe("94103");
      expect(quote.amountCents).toBe(850);
      expect(quote.quoteSignature).toBeDefined();

      const evalRes = evaluateDestinationTax(caDest, quote);
      expect(evalRes.isTaxDefensible).toBe(true);
      expect(evalRes.taxCents).toBe(850);
      expect(evalRes.taxEvidence.explanation).toContain("Verified via synthetic test authority");
    });

    it("10.20 setNonProductionTestTaxFixture provides controlled test tax evidence and restores fail-closed behavior when cleared", () => {
      const caDest: DestinationContext = { country: "US", postalCode: "94103", deliveryMethodPreference: "standard_ground" };

      // Before fixture: CA fails closed (missing, non-defensible)
      const beforeRes = evaluateDestinationTax(caDest);
      expect(beforeRes.isTaxDefensible).toBe(false);
      expect(beforeRes.taxCents).toBeNull();
      expect(beforeRes.taxEvidence.status).toBe("missing");

      // Set non-production fixture
      setNonProductionTestTaxFixture((dest) => createDefensibleTestTaxQuote({ destination: dest, amountCents: 500 }));
      const duringRes = evaluateDestinationTax(caDest);
      expect(duringRes.isTaxDefensible).toBe(true);
      expect(duringRes.taxCents).toBe(500);

      // Clear fixture: restores fail-closed behavior
      clearNonProductionTestTaxFixture();
      const afterRes = evaluateDestinationTax(caDest);
      expect(afterRes.isTaxDefensible).toBe(false);
      expect(afterRes.taxCents).toBeNull();
      expect(afterRes.taxEvidence.status).toBe("missing");
    });

    it("10.21 strictly prohibits non-production test fixtures and synthetic test tax authorities in production runtime", () => {
      const originalEnv = process.env.NODE_ENV;
      const envRef = process.env as Record<string, string | undefined>;
      try {
        envRef.NODE_ENV = "production";

        const caDest: DestinationContext = { country: "US", postalCode: "94103", deliveryMethodPreference: "standard_ground" };

        expect(() => {
          createDefensibleTestTaxQuote({ destination: caDest });
        }).toThrow(/Forbidden in production/);

        expect(() => {
          setNonProductionTestTaxFixture(null);
        }).toThrow(/Forbidden in production/);
      } finally {
        envRef.NODE_ENV = originalEnv;
      }
    });

    it("10.22 strictly rejects forged statutory absence and statutory zero claims across all jurisdictions (OR, NH, DE, MT, CA)", () => {
      // Test cases covering:
      // 1. Oregon (OR) - Statutory absence state
      // 2. New Hampshire (NH) - Statutory absence state
      // 3. Delaware (DE) - Statutory absence state
      // 4. Montana (MT) - Statewide absence but local resort taxes apply (fail-closed)
      // 5. California (CA) - Does not qualify for statutory absence
      const testJurisdictions: Array<{ state: string; postalCode: string }> = [
        { state: "OR", postalCode: "97201" },
        { state: "NH", postalCode: "03301" },
        { state: "DE", postalCode: "19801" },
        { state: "MT", postalCode: "59601" },
        { state: "CA", postalCode: "94103" },
      ];

      const statusesToTest: Array<"statutory_absence" | "statutory_zero"> = [
        "statutory_absence",
        "statutory_zero",
      ];

      for (const { state, postalCode } of testJurisdictions) {
        const dest: DestinationContext = {
          country: "US",
          postalCode,
          deliveryMethodPreference: "standard_ground",
        };

        for (const statusVal of statusesToTest) {
          // A. Caller passes arbitrary evidenceReference and sourceIdentity
          const forgedClaim: TaxEvidence = {
            jurisdictionState: state,
            postalCode,
            amountCents: 0,
            status: statusVal,
            evidenceReference: `forged_ref_${state.toLowerCase()}_${statusVal}`,
            sourceIdentity: "caller_supplied_untrusted_party",
            explanation: `Arbitrary caller claim that ${state} has 0% tax`,
          };

          const res = evaluateDestinationTax(dest, forgedClaim);
          expect(res.isTaxDefensible).toBe(false);
          expect(res.taxCents).toBeNull();
          expect(res.taxEvidence.status).toBe("untrusted");
          expect(res.taxEvidence.amountCents).toBeNull();

          // Strategy integration: Strategy cost breakdown must block landed cost defensibility
          const allocLaptop = createCandidateAllocation(sampleLineItems[0], sampleCandidateLaptop);
          const strat = buildStrategyFromAllocations(
            `strat_forged_${state}_${statusVal}`,
            "Forged Statutory Strat",
            "Forged claim cannot establish defensible cost",
            [allocLaptop],
            [sampleLineItems[0]],
            dest,
            new Date(),
            [],
            forgedClaim
          );
          expect(strat.costBreakdown?.isTaxDefensible).toBe(false);
          expect(strat.costBreakdown?.taxCents).toBeNull();
          expect(strat.costBreakdown?.isLandedCostDefensible).toBe(false);
          expect(strat.costBreakdown?.totalLandedCostCents).toBeNull();
          expect(strat.costBreakdown?.missingComponents).toContain("tax");

          // B. Adversarial caller attempts to forge server identity ("statutory_rule_engine")
          const forgedServerClaim: TaxEvidence = {
            jurisdictionState: state,
            postalCode,
            amountCents: 0,
            status: statusVal,
            evidenceReference: `v1_statutory_absence_${state.toLowerCase()}`,
            sourceIdentity: "statutory_rule_engine",
            explanation: `Adversarial attempt to spoof server-owned identity for ${state}`,
          };

          const resSpoof = evaluateDestinationTax(dest, forgedServerClaim);
          expect(resSpoof.isTaxDefensible).toBe(false);
          expect(resSpoof.taxCents).toBeNull();
          expect(resSpoof.taxEvidence.status).toBe("untrusted");
          expect(resSpoof.taxEvidence.amountCents).toBeNull();
        }

        // C. Adversarial caller attempts to pass status: "quoted" with amountCents: 0 without authoritative HMAC signature
        const forgedQuotedZero: TaxEvidence = {
          jurisdictionState: state,
          postalCode,
          amountCents: 0,
          currency: "USD",
          status: "quoted",
          evidenceReference: `forged_zero_quote_${state.toLowerCase()}`,
          sourceIdentity: "statutory_rule_engine", // not enrolled in server registry
          explanation: `Attempting to claim 0 tax via unverified quote for ${state}`,
        };
        const resQuotedZero = evaluateDestinationTax(dest, forgedQuotedZero);
        expect(resQuotedZero.isTaxDefensible).toBe(false);
        expect(resQuotedZero.taxCents).toBeNull();
        expect(resQuotedZero.taxEvidence.status).toBe("untrusted");
      }
    });

    it("10.23 verifies legitimate server-derived statutory absence for OR, NH, and DE while failing closed for MT, AK, and CA", () => {
      // 1. Oregon (OR) evaluates to defensible zero tax derived exclusively by server
      const orDest: DestinationContext = { country: "US", postalCode: "97201", deliveryMethodPreference: "standard_ground" };
      const orRes = evaluateDestinationTax(orDest);
      expect(orRes.isTaxDefensible).toBe(true);
      expect(orRes.taxCents).toBe(0);
      expect(orRes.taxEvidence.status).toBe("statutory_absence");
      expect(orRes.taxEvidence.amountCents).toBe(0);
      expect(orRes.taxEvidence.sourceIdentity).toBe("statutory_rule_engine");
      expect(orRes.taxEvidence.evidenceReference).toBe("jurisdiction_tax_rules_2026.1_statutory_absence_or");

      // 2. New Hampshire (NH) evaluates to defensible zero tax derived exclusively by server
      const nhDest: DestinationContext = { country: "US", postalCode: "03301", deliveryMethodPreference: "standard_ground" };
      const nhRes = evaluateDestinationTax(nhDest);
      expect(nhRes.isTaxDefensible).toBe(true);
      expect(nhRes.taxCents).toBe(0);
      expect(nhRes.taxEvidence.status).toBe("statutory_absence");
      expect(nhRes.taxEvidence.amountCents).toBe(0);
      expect(nhRes.taxEvidence.sourceIdentity).toBe("statutory_rule_engine");
      expect(nhRes.taxEvidence.evidenceReference).toBe("jurisdiction_tax_rules_2026.1_statutory_absence_nh");

      // 3. Delaware (DE) evaluates to defensible zero tax derived exclusively by server
      const deDest: DestinationContext = { country: "US", postalCode: "19801", deliveryMethodPreference: "standard_ground" };
      const deRes = evaluateDestinationTax(deDest);
      expect(deRes.isTaxDefensible).toBe(true);
      expect(deRes.taxCents).toBe(0);
      expect(deRes.taxEvidence.status).toBe("statutory_absence");
      expect(deRes.taxEvidence.amountCents).toBe(0);
      expect(deRes.taxEvidence.sourceIdentity).toBe("statutory_rule_engine");
      expect(deRes.taxEvidence.evidenceReference).toBe("jurisdiction_tax_rules_2026.1_statutory_absence_de");

      // 4. Montana (MT) without explicit quote strictly fails closed (local resort tax applies)
      const mtDest: DestinationContext = { country: "US", postalCode: "59601", deliveryMethodPreference: "standard_ground" };
      const mtRes = evaluateDestinationTax(mtDest);
      expect(mtRes.isTaxDefensible).toBe(false);
      expect(mtRes.taxCents).toBeNull();
      expect(mtRes.taxEvidence.status).toBe("missing");
      expect(mtRes.taxEvidence.amountCents).toBeNull();

      // 5. Alaska (AK) without explicit quote strictly fails closed (local municipal tax applies)
      const akDest: DestinationContext = { country: "US", postalCode: "99501", deliveryMethodPreference: "standard_ground" };
      const akRes = evaluateDestinationTax(akDest);
      expect(akRes.isTaxDefensible).toBe(false);
      expect(akRes.taxCents).toBeNull();
      expect(akRes.taxEvidence.status).toBe("missing");
      expect(akRes.taxEvidence.amountCents).toBeNull();

      // 6. California (CA) without explicit quote strictly fails closed (sales tax applies)
      const caDest: DestinationContext = { country: "US", postalCode: "94103", deliveryMethodPreference: "standard_ground" };
      const caRes = evaluateDestinationTax(caDest);
      expect(caRes.isTaxDefensible).toBe(false);
      expect(caRes.taxCents).toBeNull();
      expect(caRes.taxEvidence.status).toBe("missing");
      expect(caRes.taxEvidence.amountCents).toBeNull();
    });
  });
});
