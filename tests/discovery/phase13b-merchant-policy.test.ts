import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  resolveGeographicZone,
  checkGeographicEligibility,
  GeographicZone,
} from "../../lib/discovery/geographic-zones";
import {
  evaluateMerchantShippingPolicy,
  computePolicyFingerprint,
  MerchantShippingPolicy,
} from "../../lib/discovery/merchant-policy";
import {
  DEFAULT_MERCHANT_POLICIES,
  MerchantPolicyRegistry,
} from "../../lib/discovery/merchant-policy-registry";
import { validateShippingEvidence } from "../../lib/discovery/shipping";
import { Channel3SourceAdapter } from "../../lib/discovery/channel3-adapter";
import {
  setShippingQuoteAdapter,
  getShippingQuoteAdapter,
  ShippingQuoteAdapter,
  ShippingQuoteResult,
  computeQuoteFingerprint,
} from "../../lib/discovery/shipping-quote";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { Actor, Currency } from "../../lib/state/types";

describe("Phase 13B — Shipping Evidence Acquisition and Deterministic Merchant Policy Engine", () => {
  const referenceDate = new Date("2026-10-28T12:00:00.000Z");

  // =========================================================================
  // Gate 1 Baseline Integrity Verification
  // =========================================================================
  describe("Gate 1 Baseline Preservation", () => {
    it("preserves Gate 1 script integrity exactly", () => {
      const gate1Path = "C:\\paypal-gate1\\gate1.mjs";
      const fileBytes = readFileSync(gate1Path);
      const computedHash = createHash("sha256").update(fileBytes).digest("hex").toUpperCase();
      const expectedHash = "F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451";
      expect(computedHash).toBe(expectedHash);
    });
  });

  // =========================================================================
  // Priority 3 — Geographic Eligibility & Destination Zone Resolver
  // =========================================================================
  describe("Priority 3 — Geographic Zone Resolution & Serviceability", () => {
    it("correctly identifies Contiguous US (CONUS) destinations", () => {
      const conusZips = ["10001", "98101", "30301", "73301", "90210", "60601", "02108"];
      for (const zip of conusZips) {
        const res = resolveGeographicZone(zip);
        expect(res.zone).toBe("contiguous_us");
        expect(res.isContiguousUs).toBe(true);
        expect(res.postalCode).toBe(zip);
      }
    });

    it("handles ZIP+4 postal codes correctly for Contiguous US", () => {
      const res = resolveGeographicZone("98101-1234");
      expect(res.zone).toBe("contiguous_us");
      expect(res.isContiguousUs).toBe(true);
      expect(res.postalCode).toBe("98101");
    });

    it("identifies Alaska destinations deterministically", () => {
      const alaskaZips = ["99501", "99701", "99801", "99901"];
      for (const zip of alaskaZips) {
        const res = resolveGeographicZone(zip);
        expect(res.zone).toBe("alaska");
        expect(res.isContiguousUs).toBe(false);
        expect(res.stateOrTerritory).toBe("AK");
      }
    });

    it("identifies Hawaii destinations deterministically", () => {
      const hawaiiZips = ["96801", "96701", "96720", "96790"];
      for (const zip of hawaiiZips) {
        const res = resolveGeographicZone(zip);
        expect(res.zone).toBe("hawaii");
        expect(res.isContiguousUs).toBe(false);
        expect(res.stateOrTerritory).toBe("HI");
      }
    });

    it("identifies US Territories deterministically (PR, VI, GU, MP, AS)", () => {
      // Puerto Rico (00601 - 00999)
      const prRes1 = resolveGeographicZone("00601");
      expect(prRes1.zone).toBe("us_territory");
      expect(prRes1.stateOrTerritory).toBe("PR");

      const prRes2 = resolveGeographicZone("00901");
      expect(prRes2.zone).toBe("us_territory");
      expect(prRes2.stateOrTerritory).toBe("PR");

      // US Virgin Islands (00801)
      const viRes = resolveGeographicZone("00801");
      expect(viRes.zone).toBe("us_territory");
      expect(viRes.stateOrTerritory).toBe("VI");

      // Guam (96910)
      const guamRes = resolveGeographicZone("96910");
      expect(guamRes.zone).toBe("us_territory");
      expect(guamRes.stateOrTerritory).toBe("GU");

      // Northern Mariana Islands (96950)
      const mpRes = resolveGeographicZone("96950");
      expect(mpRes.zone).toBe("us_territory");
      expect(mpRes.stateOrTerritory).toBe("MP");

      // American Samoa (96799 override)
      const asRes = resolveGeographicZone("96799");
      expect(asRes.zone).toBe("us_territory");
      expect(asRes.stateOrTerritory).toBe("AS");
    });

    it("identifies Military APO/FPO destinations (AE, AA, AP)", () => {
      // Military AE (09012)
      const aeRes = resolveGeographicZone("09012");
      expect(aeRes.zone).toBe("military_apo_fpo");
      expect(aeRes.stateOrTerritory).toBe("AE");

      // Military AA (34001)
      const aaRes = resolveGeographicZone("34001");
      expect(aaRes.zone).toBe("military_apo_fpo");
      expect(aaRes.stateOrTerritory).toBe("AA");

      // Military AP (96201)
      const apRes = resolveGeographicZone("96201");
      expect(apRes.zone).toBe("military_apo_fpo");
      expect(apRes.stateOrTerritory).toBe("AP");
    });

    it("classifies invalid or unassigned postal codes as unknown", () => {
      expect(resolveGeographicZone("invalid").zone).toBe("unknown");
      expect(resolveGeographicZone("123").zone).toBe("unknown");
      expect(resolveGeographicZone("").zone).toBe("unknown");
      expect(resolveGeographicZone(null).zone).toBe("unknown");
      expect(resolveGeographicZone(undefined).zone).toBe("unknown");
      expect(resolveGeographicZone("00000").zone).toBe("unknown");
    });

    it("evaluates geographic serviceability separately from monetary cost", () => {
      // Contiguous US destination with contiguous_us policy
      const eligibleConus = checkGeographicEligibility({
        destinationPostalCode: "98101",
        allowedZones: ["contiguous_us"],
        excludedZones: ["alaska", "hawaii", "us_territory"],
      });
      expect(eligibleConus.eligible).toBe(true);
      expect(eligibleConus.serviceability).toBe("serviceable");
      expect(eligibleConus.zone).toBe("contiguous_us");

      // Alaska excluded by policy
      const excludedAk = checkGeographicEligibility({
        destinationPostalCode: "99501",
        allowedZones: ["contiguous_us"],
        excludedZones: ["alaska", "hawaii", "us_territory"],
      });
      expect(excludedAk.eligible).toBe(false);
      expect(excludedAk.serviceability).toBe("excluded");
      expect(excludedAk.zone).toBe("alaska");

      // Hawaii excluded by policy
      const excludedHi = checkGeographicEligibility({
        destinationPostalCode: "96801",
        allowedZones: ["contiguous_us"],
        excludedZones: ["alaska", "hawaii", "us_territory"],
      });
      expect(excludedHi.eligible).toBe(false);
      expect(excludedHi.serviceability).toBe("excluded");
      expect(excludedHi.zone).toBe("hawaii");

      // Puerto Rico excluded by policy
      const excludedPr = checkGeographicEligibility({
        destinationPostalCode: "00901",
        allowedZones: ["contiguous_us"],
        excludedZones: ["alaska", "hawaii", "us_territory"],
      });
      expect(excludedPr.eligible).toBe(false);
      expect(excludedPr.serviceability).toBe("excluded");
      expect(excludedPr.zone).toBe("us_territory");

      // Explicit postal code exclusion
      const excludedZip = checkGeographicEligibility({
        destinationPostalCode: "98101",
        allowedZones: ["contiguous_us"],
        excludedPostalCodes: ["98101"],
      });
      expect(excludedZip.eligible).toBe(false);
      expect(excludedZip.serviceability).toBe("excluded");

      // Invalid ZIP is unknown serviceability
      const invalidRes = checkGeographicEligibility({
        destinationPostalCode: "bad_zip",
        allowedZones: ["contiguous_us"],
      });
      expect(invalidRes.eligible).toBe(false);
      expect(invalidRes.serviceability).toBe("unknown");
    });
  });

  // =========================================================================
  // Priority 2 — Deterministic Merchant Policy Engine
  // =========================================================================
  describe("Priority 2 — Merchant Policy Engine Evaluation", () => {
    const samplePolicy: MerchantShippingPolicy = {
      policyId: "pol_test_bestbuy_contiguous_us_v1",
      merchantDomain: "bestbuy.com",
      merchantName: "Best Buy",
      policySourceUrl: "https://www.bestbuy.com/site/help-topics/free-shipping/pcmcat204400050012.c",
      publisher: "Best Buy Co., Inc.",
      retrievedAt: "2026-10-28T00:00:00.000Z",
      effectiveFrom: "2024-01-01T00:00:00.000Z",
      expiresAt: null,
      deliveryMethod: "standard_ground",
      currency: "USD",
      thresholdCents: 3500, // $35.00
      shippingCostCents: 0,
      allowedZones: ["contiguous_us"],
      excludedZones: ["alaska", "hawaii", "us_territory", "military_apo_fpo"],
      excludedCategories: ["freight", "oversized"],
      policyVersion: "1.0.0",
      policyDocumentFingerprint: "",
    };

    // Calculate valid fingerprint
    const validFingerprint = computePolicyFingerprint(samplePolicy);
    const policyWithValidFingerprint: MerchantShippingPolicy = {
      ...samplePolicy,
      policyDocumentFingerprint: validFingerprint,
    };

    it("verifies policy fingerprint integrity and fails closed on tampering", () => {
      const tamperedPolicy: MerchantShippingPolicy = {
        ...policyWithValidFingerprint,
        policyDocumentFingerprint: "tampered_fingerprint_hash_1234567890abcdef",
      };

      const outcome = evaluateMerchantShippingPolicy(tamperedPolicy, {
        candidate: {
          externalId: "cand_1",
          unitPriceCents: 5000,
          quantity: 1,
          merchantName: "Best Buy",
        },
        destination: { country: "US", postalCode: "98101" },
        now: referenceDate,
      });

      expect(outcome.status).toBe("fingerprint_mismatch");
      expect(outcome.isApplicable).toBe(false);
      expect(outcome.isAuthoritative).toBe(false);
      expect(outcome.shippingCents).toBeNull();
    });

    it("evaluates exact threshold boundaries without floating-point errors", () => {
      // 1 cent below threshold ($34.99 vs $35.00) -> threshold_not_met
      const belowOutcome = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
        candidate: {
          externalId: "cand_below",
          unitPriceCents: 3499,
          quantity: 1,
          merchantName: "Best Buy",
        },
        destination: { country: "US", postalCode: "98101" },
        now: referenceDate,
      });
      expect(belowOutcome.status).toBe("threshold_not_met");
      expect(belowOutcome.isApplicable).toBe(false);
      expect(belowOutcome.shippingCents).toBeNull();

      // Exactly at threshold ($35.00) -> satisfied
      const exactOutcome = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
        candidate: {
          externalId: "cand_exact",
          unitPriceCents: 3500,
          quantity: 1,
          merchantName: "Best Buy",
        },
        destination: { country: "US", postalCode: "98101" },
        now: referenceDate,
      });
      expect(exactOutcome.status).toBe("satisfied");
      expect(exactOutcome.isApplicable).toBe(true);
      expect(exactOutcome.isAuthoritative).toBe(true);
      expect(exactOutcome.shippingCents).toBe(0);

      // 1 cent above threshold ($35.01) -> satisfied
      const aboveOutcome = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
        candidate: {
          externalId: "cand_above",
          unitPriceCents: 3501,
          quantity: 1,
          merchantName: "Best Buy",
        },
        destination: { country: "US", postalCode: "98101" },
        now: referenceDate,
      });
      expect(aboveOutcome.status).toBe("satisfied");
      expect(aboveOutcome.isApplicable).toBe(true);
      expect(aboveOutcome.shippingCents).toBe(0);
    });

    it("evaluates quantity multipliers correctly in total order threshold", () => {
      // Item price $18.00 (below $35.00), quantity 1 -> threshold_not_met
      const singleItem = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
        candidate: {
          externalId: "cand_qty1",
          unitPriceCents: 1800,
          quantity: 1,
          merchantName: "Best Buy",
        },
        destination: { country: "US", postalCode: "98101" },
        now: referenceDate,
      });
      expect(singleItem.status).toBe("threshold_not_met");
      expect(singleItem.isApplicable).toBe(false);

      // Item price $18.00, quantity 2 = $36.00 (above $35.00) -> satisfied
      const multiItem = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
        candidate: {
          externalId: "cand_qty2",
          unitPriceCents: 1800,
          quantity: 2,
          merchantName: "Best Buy",
        },
        destination: { country: "US", postalCode: "98101" },
        now: referenceDate,
      });
      expect(multiItem.status).toBe("satisfied");
      expect(multiItem.isApplicable).toBe(true);
      expect(multiItem.shippingCents).toBe(0);
    });

    it("rejects non-contiguous destinations by policy exclusion even with high order value", () => {
      // $1,999.99 laptop to Alaska -> geographic_exclusion
      const alaskaOutcome = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
        candidate: {
          externalId: "cand_ak",
          unitPriceCents: 199999,
          quantity: 1,
          merchantName: "Best Buy",
        },
        destination: { country: "US", postalCode: "99501" },
        now: referenceDate,
      });
      expect(alaskaOutcome.status).toBe("geographic_exclusion");
      expect(alaskaOutcome.isApplicable).toBe(false);
      expect(alaskaOutcome.serviceability).toBe("excluded");
      expect(alaskaOutcome.geographicZone).toBe("alaska");
      expect(alaskaOutcome.shippingCents).toBeNull();

      // $1,999.99 laptop to Hawaii -> geographic_exclusion
      const hawaiiOutcome = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
        candidate: {
          externalId: "cand_hi",
          unitPriceCents: 199999,
          quantity: 1,
          merchantName: "Best Buy",
        },
        destination: { country: "US", postalCode: "96801" },
        now: referenceDate,
      });
      expect(hawaiiOutcome.status).toBe("geographic_exclusion");
      expect(hawaiiOutcome.serviceability).toBe("excluded");
      expect(hawaiiOutcome.geographicZone).toBe("hawaii");

      // $1,999.99 laptop to Puerto Rico -> geographic_exclusion
      const prOutcome = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
        candidate: {
          externalId: "cand_pr",
          unitPriceCents: 199999,
          quantity: 1,
          merchantName: "Best Buy",
        },
        destination: { country: "US", postalCode: "00901" },
        now: referenceDate,
      });
      expect(prOutcome.status).toBe("geographic_exclusion");
      expect(prOutcome.serviceability).toBe("excluded");
      expect(prOutcome.geographicZone).toBe("us_territory");
    });

    it("fails closed on expired policies", () => {
      const expiredPolicyRaw = {
        ...samplePolicy,
        policyId: "pol_expired_bestbuy",
        expiresAt: "2026-01-01T00:00:00.000Z",
      };
      const expiredPolicy: MerchantShippingPolicy = {
        ...expiredPolicyRaw,
        policyDocumentFingerprint: computePolicyFingerprint(expiredPolicyRaw),
      };

      const outcome = evaluateMerchantShippingPolicy(expiredPolicy, {
        candidate: {
          externalId: "cand_exp",
          unitPriceCents: 5000,
          quantity: 1,
          merchantName: "Best Buy",
        },
        destination: { country: "US", postalCode: "98101" },
        now: referenceDate,
      });

      expect(outcome.status).toBe("policy_expired");
      expect(outcome.isApplicable).toBe(false);
      expect(outcome.isAuthoritative).toBe(false);
      expect(outcome.shippingCents).toBeNull();
    });

    it("fails closed on product and category exclusions (e.g. freight, oversized)", () => {
      // Product title indicates freight item
      const freightOutcome = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
        candidate: {
          externalId: "cand_freight",
          unitPriceCents: 85000,
          quantity: 1,
          merchantName: "Best Buy",
          title: "75-inch QLED 4K TV - Heavy Freight Item",
        },
        destination: { country: "US", postalCode: "98101" },
        now: referenceDate,
      });
      expect(freightOutcome.status).toBe("product_exclusion");
      expect(freightOutcome.isApplicable).toBe(false);
      expect(freightOutcome.shippingCents).toBeNull();

      // Product raw attributes indicate oversized
      const oversizedOutcome = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
        candidate: {
          externalId: "cand_oversized",
          unitPriceCents: 85000,
          quantity: 1,
          merchantName: "Best Buy",
          title: "Standing Desk",
          rawAttributes: { description: "Ships via oversized ground transport" },
        },
        destination: { country: "US", postalCode: "98101" },
        now: referenceDate,
      });
      expect(oversizedOutcome.status).toBe("product_exclusion");
      expect(oversizedOutcome.isApplicable).toBe(false);
      expect(oversizedOutcome.shippingCents).toBeNull();
    });

    it("fails closed on delivery method mismatch and currency mismatch", () => {
      // Delivery method mismatch
      const methodMismatch = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
        candidate: {
          externalId: "cand_fast",
          unitPriceCents: 5000,
          quantity: 1,
          merchantName: "Best Buy",
        },
        destination: {
          country: "US",
          postalCode: "98101",
          deliveryMethodPreference: "overnight_express",
        },
        now: referenceDate,
      });
      expect(methodMismatch.status).toBe("delivery_method_mismatch");
      expect(methodMismatch.isApplicable).toBe(false);

      // Currency mismatch
      const currMismatch = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
        candidate: {
          externalId: "cand_curr",
          unitPriceCents: 5000,
          quantity: 1,
          merchantName: "Best Buy",
        },
        destination: { country: "US", postalCode: "98101" },
        now: referenceDate,
        requestedCurrency: "EUR" as unknown as Currency,
      });
      expect(currMismatch.status).toBe("currency_mismatch");
      expect(currMismatch.isApplicable).toBe(false);
    });

    it("matches merchant aliases cleanly", () => {
      const aliasVariants = ["Best Buy", "Best Buy Co.", "Best Buy, Inc.", "bestbuy.com", "BEST BUY"];
      for (const alias of aliasVariants) {
        const outcome = evaluateMerchantShippingPolicy(policyWithValidFingerprint, {
          candidate: {
            externalId: `cand_${alias}`,
            unitPriceCents: 4500,
            quantity: 1,
            merchantName: alias,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });
        expect(outcome.status).toBe("satisfied");
        expect(outcome.isApplicable).toBe(true);
      }
    });
  });

  // =========================================================================
  // Policy Registry & Conflict Detection
  // =========================================================================
  describe("Merchant Policy Registry & Conflicting Policies", () => {
    it("loads default verified retailer policies (Best Buy, Walmart, Target, B&H)", () => {
      const registry = new MerchantPolicyRegistry();
      const all = registry.getAllPolicies();
      expect(all.length).toBeGreaterThanOrEqual(4);

      const bestBuyPolicies = registry.getPoliciesForMerchant("Best Buy");
      expect(bestBuyPolicies.length).toBe(1);
      expect(bestBuyPolicies[0].thresholdCents).toBe(3500);

      const walmartPolicies = registry.getPoliciesForMerchant("Walmart Inc");
      expect(walmartPolicies.length).toBe(1);
      expect(walmartPolicies[0].thresholdCents).toBe(3500);

      const targetPolicies = registry.getPoliciesForMerchant("Target");
      expect(targetPolicies.length).toBe(3);
      const standardTarget = targetPolicies.find((p) => p.policyId === "pol_target_contiguous_us_ground_v2");
      expect(standardTarget).toBeDefined();
      expect(standardTarget?.thresholdCents).toBe(3500);
      expect(standardTarget?.allowedZones).toContain("military_apo_fpo");

      const bhPolicies = registry.getPoliciesForMerchant("B&H Photo Video");
      expect(bhPolicies.length).toBe(2);
      const expeditedPolicy = bhPolicies.find((p) => p.deliveryMethod === "expedited");
      const standardPolicy = bhPolicies.find((p) => p.deliveryMethod === "standard_ground");
      expect(expeditedPolicy).toBeDefined();
      expect(expeditedPolicy?.thresholdCents).toBe(4900);
      expect(standardPolicy).toBeDefined();
      expect(standardPolicy?.thresholdCents).toBe(0);
      expect(standardPolicy?.itemSpecificQualificationRequired).toBe(true);
    });

    it("fails closed when conflicting policies exist with different rates", () => {
      const registry = new MerchantPolicyRegistry([]);

      const policy1Raw = {
        policyId: "pol_conflict_1",
        merchantDomain: "store.example.com",
        merchantName: "ConflictStore",
        policySourceUrl: "https://store.example.com/shipping-a",
        publisher: "Store Corp",
        retrievedAt: "2026-10-28T00:00:00.000Z",
        effectiveFrom: "2024-01-01T00:00:00.000Z",
        expiresAt: null,
        deliveryMethod: "standard_ground",
        currency: "USD" as Currency,
        thresholdCents: 2500,
        shippingCostCents: 0,
        allowedZones: ["contiguous_us" as GeographicZone],
        excludedZones: [],
        policyVersion: "1.0.0",
      };
      const p1: MerchantShippingPolicy = {
        ...policy1Raw,
        policyDocumentFingerprint: computePolicyFingerprint(policy1Raw),
      };

      const policy2Raw = {
        policyId: "pol_conflict_2",
        merchantDomain: "store.example.com",
        merchantName: "ConflictStore",
        policySourceUrl: "https://store.example.com/shipping-b",
        publisher: "Store Corp",
        retrievedAt: "2026-10-28T00:00:00.000Z",
        effectiveFrom: "2024-01-01T00:00:00.000Z",
        expiresAt: null,
        deliveryMethod: "standard_ground",
        currency: "USD" as Currency,
        thresholdCents: 2500,
        shippingCostCents: 500, // Conflict: $5.00 vs $0.00
        allowedZones: ["contiguous_us" as GeographicZone],
        excludedZones: [],
        policyVersion: "1.0.0",
      };
      const p2: MerchantShippingPolicy = {
        ...policy2Raw,
        policyDocumentFingerprint: computePolicyFingerprint(policy2Raw),
      };

      registry.registerPolicy(p1);
      registry.registerPolicy(p2);

      const outcome = registry.evaluateCandidate({
        candidate: {
          externalId: "cand_conf",
          unitPriceCents: 3000,
          quantity: 1,
          merchantName: "ConflictStore",
        },
        destination: { country: "US", postalCode: "98101" },
        now: referenceDate,
      });

      expect(outcome).not.toBeNull();
      expect(outcome?.status).toBe("conflicting_policies");
      expect(outcome?.isApplicable).toBe(false);
      expect(outcome?.shippingCents).toBeNull();
    });
  });

  // =========================================================================
  // Shipping Evidence Validation & Distinction Invariants
  // =========================================================================
  describe("Shipping Evidence Validation & Provenance Invariants", () => {
    it("preserves strict distinction: policy_derived is NEVER labeled as quoted", () => {
      const validPolicyEvidence = validateShippingEvidence({
        rawShippingCents: 0,
        shippingType: "policy_derived",
        deliveryMethod: "standard_ground",
        destinationPostalCode: "98101",
        destinationCountry: "US",
        sourceVerificationTimestamp: "2026-10-28T12:00:00.000Z",
        policyId: "pol_bestbuy_contiguous_us_ground_v1",
        policyDocumentFingerprint: "fingerprint_12345",
        policySourceUrl: "https://www.bestbuy.com/site/help-topics/free-shipping/pcmcat204400050012.c",
        geographicZone: "contiguous_us",
        serviceabilityStatus: "serviceable",
        thresholdCents: 3500,
      });

      expect(validPolicyEvidence.valid).toBe(true);
      expect(validPolicyEvidence.isComplete).toBe(true);
      expect(validPolicyEvidence.details?.type).toBe("policy_derived");
      expect(validPolicyEvidence.details?.type).not.toBe("quoted");
      expect(validPolicyEvidence.details?.isAuthoritative).toBe(true);
      expect(validPolicyEvidence.details?.policyId).toBe("pol_bestbuy_contiguous_us_ground_v1");
    });

    it("fails closed on unverified policy claims without policy metadata", () => {
      const unverifiedPolicy = validateShippingEvidence({
        rawShippingCents: 0,
        shippingType: "policy_derived",
        // Missing policyId, fingerprint, or sourceUrl
        destinationPostalCode: "98101",
      });

      expect(unverifiedPolicy.valid).toBe(false);
      expect(unverifiedPolicy.isComplete).toBe(false);
      expect(unverifiedPolicy.details?.isAuthoritative).toBe(false);
      expect(unverifiedPolicy.errors).toContain(
        "Policy-derived shipping cost lacks authoritative published policy verification."
      );
    });

    it("fails closed on invalid destination postal codes in policy evidence", () => {
      const invalidDestPolicy = validateShippingEvidence({
        rawShippingCents: 0,
        shippingType: "policy_derived",
        destinationPostalCode: "invalid_zip",
        policyId: "pol_bestbuy_contiguous_us_ground_v1",
        policyDocumentFingerprint: "fingerprint_12345",
        policySourceUrl: "https://www.bestbuy.com/site/help-topics/free-shipping/pcmcat204400050012.c",
      });

      expect(invalidDestPolicy.valid).toBe(false);
      expect(invalidDestPolicy.isComplete).toBe(false);
      expect(invalidDestPolicy.errors).toContain("Invalid destination postal code for merchant policy.");
    });
  });

  // =========================================================================
  // Priority 4 — End-to-End Channel3 Discovery & Integration
  // =========================================================================
  describe("Priority 4 — Channel3 Search Adapter Policy Integration", () => {
    let originalAdapter: ShippingQuoteAdapter | null = null;

    beforeEach(() => {
      originalAdapter = getShippingQuoteAdapter();
    });

    afterEach(() => {
      if (originalAdapter) {
        setShippingQuoteAdapter(originalAdapter);
      }
    });

    it("enriches candidate with authoritative policy_derived free shipping when order qualifies", async () => {
      // Mock carrier quote adapter returning unserviceable (dynamic quote unavailable)
      const mockQuoteAdapter: ShippingQuoteAdapter = {
        name: "mock-unavailable",
        supportedRetailers: ["bestbuy.com"],
        canQuote: () => true,
        getShippingQuote: vi.fn().mockResolvedValue({
          status: "unserviceable",
          currency: "USD",
          serviceable: false,
          carrier: "MockCarrier",
          service: "ground",
          reason: "Dynamic quote endpoint unavailable; fallback to policy",
        } as unknown as ShippingQuoteResult),
      };
      setShippingQuoteAdapter(mockQuoteAdapter);

      const mockSearchFn = vi.fn().mockResolvedValue({
        products: [
          {
            id: "bb_laptop_001",
            title: "Dell Inspiron 15.6 Laptop - Intel Core i5",
            offers: [
              {
                id: "bb_offer_001",
                domain: "bestbuy.com",
                url: "https://www.bestbuy.com/site/dell-inspiron/12345.p",
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
          query: "Dell Inspiron",
          purchaseId: "pur_test_ch3_1",
          constraints: {
            destination: {
              country: "US",
              postalCode: "98101",
              deliveryMethodPreference: "standard_ground",
            },
          },
        },
        { now: referenceDate }
      );

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.candidates.length).toBe(1);
        const cand = result.candidates[0];

        // Shipping must be enriched via deterministic merchant policy engine
        expect(cand.shippingCents).toBe(0);
        expect(cand.totalCents).toBe(74999);
        expect(cand.isComplete).toBe(true);
        expect(cand.shippingDetails?.type).toBe("policy_derived");
        expect(cand.shippingDetails?.policyId).toBe("pol_bestbuy_contiguous_us_ground_v2");
        expect(cand.shippingDetails?.destinationPostalCode).toBe("98101");
        expect(cand.shippingDetails?.geographicZone).toBe("contiguous_us");
        expect(cand.shippingDetails?.serviceabilityStatus).toBe("serviceable");
        expect(cand.shippingDetails?.isAuthoritative).toBe(true);
      }
    });

    it("leaves candidate unquoted when below policy threshold and carrier quote is unavailable", async () => {
      // Mock carrier quote adapter returning unserviceable
      setShippingQuoteAdapter({
        name: "mock-unavailable",
        supportedRetailers: ["bestbuy.com"],
        canQuote: () => true,
        getShippingQuote: vi.fn().mockResolvedValue({
          status: "unserviceable",
          currency: "USD",
          serviceable: false,
          carrier: "MockCarrier",
          service: "ground",
          reason: "Dynamic quote endpoint unavailable",
        } as unknown as ShippingQuoteResult),
      });

      const mockSearchFn = vi.fn().mockResolvedValue({
        products: [
          {
            id: "bb_acc_001",
            title: "USB-C to HDMI Adapter Cable",
            offers: [
              {
                id: "bb_offer_acc",
                domain: "bestbuy.com",
                url: "https://www.bestbuy.com/site/usb-adapter/54321.p",
                price: { price: 19.99, currency: "USD" }, // $19.99 is below $35.00 threshold
                availability: "instock",
              },
            ],
          },
        ],
      });

      const adapter = new Channel3SourceAdapter({ searchFn: mockSearchFn });

      const result = await adapter.search(
        {
          query: "USB Adapter",
          purchaseId: "pur_test_ch3_2",
          constraints: {
            destination: {
              country: "US",
              postalCode: "98101",
              deliveryMethodPreference: "standard_ground",
            },
          },
        },
        { now: referenceDate }
      );

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.candidates.length).toBe(1);
        const cand = result.candidates[0];

        // Candidate fails closed because shipping threshold is not met
        expect(cand.isComplete).toBe(false);
        expect(cand.shippingDetails?.type).toBe("missing");
        const rawAttrs = cand.rawSourceData?.rawAttributes as Record<string, unknown> | undefined;
        expect(rawAttrs?.shipping_policy_status).toBe("threshold_not_met");
      }
    });

    it("leaves candidate unquoted when destination is geographically excluded (Alaska)", async () => {
      setShippingQuoteAdapter({
        name: "mock-unavailable",
        supportedRetailers: ["bestbuy.com"],
        canQuote: () => true,
        getShippingQuote: vi.fn().mockResolvedValue({
          status: "unserviceable",
          currency: "USD",
          serviceable: false,
          carrier: "MockCarrier",
          service: "ground",
          reason: "Dynamic quote endpoint unavailable",
        } as unknown as ShippingQuoteResult),
      });

      const mockSearchFn = vi.fn().mockResolvedValue({
        products: [
          {
            id: "bb_laptop_ak",
            title: "Dell Inspiron 15.6 Laptop",
            offers: [
              {
                id: "bb_offer_ak",
                domain: "bestbuy.com",
                url: "https://www.bestbuy.com/site/dell-inspiron/12345.p",
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
          query: "Dell Inspiron",
          purchaseId: "pur_test_ch3_3",
          constraints: {
            destination: {
              country: "US",
              postalCode: "99501",
              deliveryMethodPreference: "standard_ground",
            },
          },
        },
        { now: referenceDate }
      );

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.candidates.length).toBe(1);
        const cand = result.candidates[0];

        // Geographically excluded
        expect(cand.isComplete).toBe(false);
        expect(cand.shippingDetails?.type).toBe("missing");
        const rawAttrs = cand.rawSourceData?.rawAttributes as Record<string, unknown> | undefined;
        expect(rawAttrs?.shipping_policy_status).toBe("geographic_exclusion");
      }
    });

    it("prefers carrier quote over merchant policy when dynamic quote succeeds", async () => {
      // Mock carrier quote adapter returning a success quote ($8.50)
      const dummyQuote = {
        status: "success" as const,
        amountCents: 850,
        currency: "USD" as Currency,
        deliveryMethod: "ground",
        destinationCountry: "US" as const,
        destinationPostalCode: "98101",
        expiresAt: "2026-10-28T14:00:00.000Z",
        externalId: "bb_laptop_carrier:bestbuy.com",
        merchantDomain: "bestbuy.com",
        quoteId: "quote_test_bb_ups",
        quotedAt: "2026-10-28T12:00:00.000Z",
        retailerId: "bestbuy.com",
        sourceUrl: "https://www.bestbuy.com/site/shipping",
        canonicalProductUrl: "https://www.bestbuy.com/site/dell-inspiron/12345.p",
        conditions: [],
        serviceable: true,
        carrier: "UPS",
        service: "ground",
      };
      const validQuoteFp = computeQuoteFingerprint(dummyQuote);

      const mockQuoteAdapter: ShippingQuoteAdapter = {
        name: "bestbuy-carrier-rate",
        supportedRetailers: ["bestbuy.com"],
        canQuote: () => true,
        getShippingQuote: vi.fn().mockResolvedValue({
          ...dummyQuote,
          quoteFingerprint: validQuoteFp,
        }),
      };
      setShippingQuoteAdapter(mockQuoteAdapter);

      const mockSearchFn = vi.fn().mockResolvedValue({
        products: [
          {
            id: "bb_laptop_carrier",
            title: "Dell Inspiron 15.6 Laptop",
            offers: [
              {
                id: "bb_offer_carrier",
                domain: "bestbuy.com",
                url: "https://www.bestbuy.com/site/dell-inspiron/12345.p",
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
          query: "Dell Inspiron",
          purchaseId: "pur_test_ch3_1",
          constraints: {
            destination: {
              country: "US",
              postalCode: "98101",
              deliveryMethodPreference: "standard_ground",
            },
          },
        },
        { now: referenceDate }
      );

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.candidates.length).toBe(1);
        const cand = result.candidates[0];

        // Carrier quote takes precedence over policy
        expect(cand.shippingCents).toBe(850);
        expect(cand.shippingDetails?.type).toBe("quoted");
        expect(cand.shippingDetails?.deliveryMethod).toBe("ground");
        expect(cand.isComplete).toBe(true);
      }
    });
  });

  // =========================================================================
  // Approval Snapshot Binding & Workflow Invariants
  // =========================================================================
  describe("Approval Snapshot Binding & Policy Mutation Invalidation", () => {
    it("invalidates approval if policy evidence changes between approval and execution", async () => {
      const repo = new InMemoryPurchaseRepository();
      const mockPayPal = {
        createOrder: vi.fn(),
        captureOrder: vi.fn(),
        getOrder: vi.fn(),
      } as unknown as PayPalSandboxClient;

      const service = new PurchaseWorkflowService(repo, mockPayPal);

      const userActor: Actor = { kind: "user", userId: "buyer_1" };
      const systemActor: Actor = { kind: "system", component: "discovery_engine" };

      // 1. Create purchase record with complete candidate backed by policy evidence
      const purchase = await service.createPurchase(
        {
          budgetCents: 150000,
          currency: "USD",
          requirements: ["laptop"],
        },
        userActor
      );

      // 2. Evaluate candidate backed by merchant policy
      const evalRes = await service.evaluatePurchaseCandidate(
        purchase.id,
        {
          rawCandidate: {
            externalId: "bb_laptop_001",
            title: "Dell XPS 15",
            merchantName: "Best Buy",
            merchantUrl: "https://www.bestbuy.com/site/laptop/1.p",
            unitPriceCents: 99900,
            quantity: 1,
            shippingCents: 0,
            shippingType: "policy_derived",
            deliveryMethod: "standard_ground",
            destinationPostalCode: "98101",
            destinationCountry: "US",
            policyId: "pol_bestbuy_contiguous_us_ground_v1",
            policyDocumentFingerprint: "fingerprint_initial_v1",
            policySourceUrl: "https://www.bestbuy.com/site/help-topics/free-shipping/pcmcat204400050012.c",
            geographicZone: "contiguous_us",
            serviceabilityStatus: "serviceable",
            thresholdCents: 3500,
            sourceVerificationTimestamp: referenceDate.toISOString(),
            currency: "USD",
            availability: "IN_STOCK",
          },
          rawObservations: [
            {
              requirementKey: "laptop",
              value: "Dell XPS 15",
              status: "supports",
              sourceUrl: "https://www.bestbuy.com/site/laptop/1.p",
              sourceType: "merchant_spec",
              capturedAt: referenceDate.toISOString(),
            },
          ],
          requiredRuleKeys: ["P-BUDGET", "P-CURRENCY", "P-AVAILABILITY"],
        },
        systemActor,
        referenceDate
      );

      expect(evalRes.status).toBe("POLICY_PASSED");

      // 3. Buyer approves the purchase at landed cost $999.00
      const approval = await service.approvePurchase(
        purchase.id,
        {
          expectedSnapshotHash: evalRes.snapshotHash,
          expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
          expectedTotalCents: 99900,
          expectedCurrency: "USD",
        },
        userActor,
        referenceDate
      );
      expect(approval.status).toBe("APPROVED");

      // 4. Stale approval rejection: if buyer attempts approval with mismatched snapshot hash
      await expect(
        service.approvePurchase(
          purchase.id,
          {
            expectedSnapshotHash: "0000000000000000000000000000000000000000000000000000000000000000",
            expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
            expectedTotalCents: 99900,
            expectedCurrency: "USD",
          },
          userActor,
          referenceDate
        )
      ).rejects.toThrow();

      // 5. Payment execution rejection: if candidate terms mutate (e.g. shipping changed post-approval)
      const aggregate = await repo.getPurchaseById(purchase.id);
      expect(aggregate).not.toBeNull();
      if (aggregate && aggregate.selectedCandidate) {
        aggregate.selectedCandidate.shippingCents = 1500;
        aggregate.selectedCandidate.totalCents = 101400;
        aggregate.selectedCandidate.snapshotHash = "mutated_snapshot_hash_1234567890";
      }

      // Creating a PayPal order fails closed with ApprovalIntegrityError because snapshot hash / total changed
      await expect(
        service.createPayPalOrder(purchase.id, userActor)
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // Phase 13B.1 — Merchant Policy Registry Correctness Audit and Remediation
  // =========================================================================
  describe("Phase 13B.1 — Merchant Policy Registry Correctness Audit and Remediation", () => {
    const registry = new MerchantPolicyRegistry(DEFAULT_MERCHANT_POLICIES);

    describe("1. Best Buy Marketplace and Scheduled Delivery Exclusions", () => {
      it("fails closed on Best Buy 3rd-party marketplace seller", () => {
        // Candidate on bestbuy.com sold by 3rd-party seller
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_bb_mp_1",
            merchantName: "Best Buy",
            sellerName: "Tech Outlet Pro",
            isMarketplace: true,
            unitPriceCents: 9999, // $99.99 well over $35
            quantity: 1,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome).not.toBeNull();
        expect(outcome?.status).toBe("marketplace_seller_excluded");
        expect(outcome?.isApplicable).toBe(false);
        expect(outcome?.shippingCents).toBeNull();
        expect(outcome?.explanation).toContain("third-party marketplace");
      });

      it("fails closed when seller name differs from retailer name", () => {
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_bb_mp_2",
            merchantName: "Best Buy",
            sellerName: "Refurbished Deals Depot",
            unitPriceCents: 4500,
            quantity: 1,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("marketplace_seller_excluded");
        expect(outcome?.shippingCents).toBeNull();
      });

      it("fails closed on scheduled delivery / major appliance items", () => {
        // Candidate requires scheduled / in-home delivery
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_bb_sched_1",
            merchantName: "Best Buy",
            title: "French Door Refrigerator with In-Home Scheduled Delivery",
            requiresSpecialDelivery: true,
            unitPriceCents: 159900,
            quantity: 1,
            rawAttributes: {
              fulfillmentMethod: "scheduled_delivery",
            },
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("special_delivery_required");
        expect(outcome?.isApplicable).toBe(false);
        expect(outcome?.shippingCents).toBeNull();
      });

      it("satisfies policy for qualifying direct Best Buy items over $35", () => {
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_bb_valid",
            merchantName: "Best Buy",
            sellerName: "Best Buy",
            unitPriceCents: 3999, // $39.99
            quantity: 1,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("satisfied");
        expect(outcome?.isApplicable).toBe(true);
        expect(outcome?.shippingCents).toBe(0);
        expect(outcome?.policyId).toBe("pol_bestbuy_contiguous_us_ground_v2");
      });

      it("fails closed with threshold_not_met for direct Best Buy items under $35", () => {
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_bb_under",
            merchantName: "Best Buy",
            unitPriceCents: 3499, // $34.99 < $35.00
            quantity: 1,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("threshold_not_met");
        expect(outcome?.isApplicable).toBe(false);
        expect(outcome?.shippingCents).toBeNull();
      });
    });

    describe("2. Walmart Marketplace, Seller, and Membership Invariants", () => {
      it("fails closed on Walmart 3rd-party marketplace seller", () => {
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_wm_mp",
            merchantName: "Walmart",
            sellerName: "Super Discounts LLC",
            isMarketplace: true,
            unitPriceCents: 7500,
            quantity: 1,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("marketplace_seller_excluded");
        expect(outcome?.shippingCents).toBeNull();
      });

      it("does not assume Walmart+ membership for standard shoppers", () => {
        // Standard shopper order under $35 ($28.00) without Walmart+ membership
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_wm_std_under",
            merchantName: "Walmart",
            sellerName: "Walmart",
            unitPriceCents: 2800,
            quantity: 1,
            buyerMembership: [], // No Walmart+ membership
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        // Must NOT assume membership; must fail with threshold_not_met
        expect(outcome?.status).toBe("threshold_not_met");
        expect(outcome?.shippingCents).toBeNull();
      });

      it("fails closed on Walmart excluded product categories (fresh grocery, hazmat, oversized)", () => {
        const outcomeGrocery = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_wm_grocery",
            merchantName: "Walmart",
            title: "Fresh Grocery Delivery - Organic Milk and Eggs",
            unitPriceCents: 4500,
            quantity: 1,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcomeGrocery?.status).toBe("product_exclusion");
        expect(outcomeGrocery?.shippingCents).toBeNull();

        const outcomeHazmat = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_wm_hazmat",
            merchantName: "Walmart",
            title: "Lithium Polymer Battery Hazardous Materials Pack",
            unitPriceCents: 5500,
            quantity: 1,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcomeHazmat?.status).toBe("product_exclusion");
        expect(outcomeHazmat?.shippingCents).toBeNull();
      });

      it("satisfies direct Walmart-fulfilled orders meeting $35 threshold", () => {
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_wm_valid",
            merchantName: "Walmart",
            sellerName: "Walmart",
            unitPriceCents: 3500,
            quantity: 1,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("satisfied");
        expect(outcome?.shippingCents).toBe(0);
        expect(outcome?.policyId).toBe("pol_walmart_contiguous_us_ground_v2");
      });
    });

    describe("3. Target Post-Discount Pre-Tax Boundary & Exclusions", () => {
      it("enforces $35 threshold strictly net of discounts/coupons", () => {
        // Gross merchandise: $40.00, Coupon: $10.00 -> Net qualifying merchandise: $30.00 (< $35.00)
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_tgt_discount_under",
            merchantName: "Target",
            sellerName: "Target",
            unitPriceCents: 4000,
            quantity: 1,
            discountCents: 1000, // $10 coupon
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("threshold_not_met");
        expect(outcome?.shippingCents).toBeNull();
        expect(outcome?.explanation).toContain("discounts/coupons reduced the qualifying amount");
      });

      it("satisfies threshold when net merchandise after discounts meets $35", () => {
        // Gross merchandise: $50.00, Coupon: $10.00 -> Net: $40.00 (>= $35.00)
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_tgt_discount_over",
            merchantName: "Target",
            sellerName: "Target",
            unitPriceCents: 5000,
            quantity: 1,
            discountCents: 1000,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("satisfied");
        expect(outcome?.shippingCents).toBe(0);
      });

      it("strictly excludes sales tax from satisfying merchandise threshold", () => {
        // Merchandise: $34.00, Tax: $2.50 -> Total $36.50
        // Merchandise is $34.00 which is below $35.00. Tax CANNOT push it over threshold!
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_tgt_tax",
            merchantName: "Target",
            sellerName: "Target",
            unitPriceCents: 3400,
            quantity: 1,
            estimatedTaxCents: 250,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("threshold_not_met");
        expect(outcome?.shippingCents).toBeNull();
        expect(outcome?.explanation).toContain("Estimated sales tax ($2.50) is excluded");
      });

      it("fails closed on Target Plus 3rd-party marketplace seller", () => {
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_tgt_plus",
            merchantName: "Target",
            sellerName: "Target Plus Partner - Home Goods Direct",
            isMarketplace: true,
            unitPriceCents: 6000,
            quantity: 1,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("marketplace_seller_excluded");
        expect(outcome?.shippingCents).toBeNull();
      });
    });

    describe("4. B&H Photo Video Separation: Standard Ground vs $49 Expedited", () => {
      it("does not apply a universal $49 minimum to all free shipping", () => {
        const bhPolicies = registry.getPoliciesForMerchant("B&H Photo Video");
        expect(bhPolicies.length).toBe(2);

        const standardPolicy = bhPolicies.find((p) => p.deliveryMethod === "standard_ground");
        const expeditedPolicy = bhPolicies.find((p) => p.deliveryMethod === "expedited");

        expect(standardPolicy).toBeDefined();
        expect(standardPolicy?.thresholdCents).toBe(0); // Item-specific, no universal minimum
        expect(standardPolicy?.itemSpecificQualificationRequired).toBe(true);

        expect(expeditedPolicy).toBeDefined();
        expect(expeditedPolicy?.thresholdCents).toBe(4900); // $49 for expedited
        expect(expeditedPolicy?.deliveryMethod).toBe("expedited");
      });

      it("fails closed with unconfirmed_qualification when standard shipping item eligibility is unverified", () => {
        // Standard delivery preference, item not verified as free-shipping eligible
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_bh_unverified",
            merchantName: "B&H Photo Video",
            sellerName: "B&H Photo Video",
            unitPriceCents: 2500, // $25.00
            quantity: 1,
            isFreeShippingEligibleItem: undefined, // Not verified
          },
          destination: {
            country: "US",
            postalCode: "98101",
            deliveryMethodPreference: "standard_ground",
          },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("unconfirmed_qualification");
        expect(outcome?.isApplicable).toBe(false);
        expect(outcome?.shippingCents).toBeNull();
      });

      it("satisfies standard ground policy when item-specific qualification is verified", () => {
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_bh_verified",
            merchantName: "B&H Photo Video",
            sellerName: "B&H Photo Video",
            unitPriceCents: 1999, // $19.99 (below $49!)
            quantity: 1,
            isFreeShippingEligibleItem: true, // Verified qualifying item!
          },
          destination: {
            country: "US",
            postalCode: "98101",
            deliveryMethodPreference: "standard_ground",
          },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("satisfied");
        expect(outcome?.isApplicable).toBe(true);
        expect(outcome?.shippingCents).toBe(0);
        expect(outcome?.deliveryMethod).toBe("standard_ground");
        expect(outcome?.policyId).toBe("pol_bhphoto_contiguous_us_free_standard_v2");
      });

      it("evaluates $49 threshold policy when delivery method preference is expedited", () => {
        // Expedited preference, cart >= $49 ($59.00)
        const outcomeOver = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_bh_exp_over",
            merchantName: "B&H Photo Video",
            sellerName: "B&H Photo Video",
            unitPriceCents: 5900,
            quantity: 1,
          },
          destination: {
            country: "US",
            postalCode: "98101",
            deliveryMethodPreference: "expedited",
          },
          now: referenceDate,
        });

        expect(outcomeOver?.status).toBe("satisfied");
        expect(outcomeOver?.shippingCents).toBe(0);
        expect(outcomeOver?.deliveryMethod).toBe("expedited");
        expect(outcomeOver?.policyId).toBe("pol_bhphoto_contiguous_us_expedited_v2");

        // Expedited preference, cart < $49 ($35.00)
        const outcomeUnder = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_bh_exp_under",
            merchantName: "B&H Photo Video",
            sellerName: "B&H Photo Video",
            unitPriceCents: 3500,
            quantity: 1,
          },
          destination: {
            country: "US",
            postalCode: "98101",
            deliveryMethodPreference: "expedited",
          },
          now: referenceDate,
        });

        expect(outcomeUnder?.status).toBe("threshold_not_met");
        expect(outcomeUnder?.shippingCents).toBeNull();
      });
    });

    describe("5. Policy Provenance, Semantics, and Cryptographic Fingerprints", () => {
      it("preserves exact provenance fields for all seeded policies", () => {
        const policies = registry.getAllPolicies();
        expect(policies.length).toBe(7);

        for (const policy of policies) {
          // Exact source URL
          expect(policy.policySourceUrl).toMatch(/^https:\/\/[a-z0-9.-]+\//);
          // Publisher
          expect(policy.publisher.length).toBeGreaterThan(0);
          // Retrieval timestamp (ISO 8601 UTC)
          expect(policy.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
          // Last reviewed timestamp (ISO 8601 UTC)
          expect(policy.lastReviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
          // Source stated effective date (null if unstated by retailer, never invented)
          expect(policy.sourceStatedEffectiveDate === null || typeof policy.sourceStatedEffectiveDate === "string").toBe(true);
          // Policy version
          expect(policy.policyVersion).toBe("2.0.0");
          // SHA-256 fingerprint verification
          const expectedFingerprint = computePolicyFingerprint(policy);
          expect(policy.policyDocumentFingerprint).toBe(expectedFingerprint);
          expect(policy.policyDocumentFingerprint).toMatch(/^[0-9a-f]{64}$/);
        }
      });

      it("re-evaluates and fails closed when policy fingerprint is tampered", () => {
        const bestBuyPolicy = registry.getPoliciesForMerchant("Best Buy")[0];
        const tampered = {
          ...bestBuyPolicy,
          thresholdCents: 1000, // Alter threshold without recalculating fingerprint
        };

        const outcome = evaluateMerchantShippingPolicy(tampered, {
          candidate: {
            externalId: "cand_tampered",
            merchantName: "Best Buy",
            unitPriceCents: 2000,
            quantity: 1,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome.status).toBe("fingerprint_mismatch");
        expect(outcome.isApplicable).toBe(false);
        expect(outcome.shippingCents).toBeNull();
      });
    });

    describe("6. End-to-End Tracing: Landed Cost, Policy Evaluation, Approval Snapshot, and Policy Invalidation", () => {
      it("traces candidate through normalization, landed cost, approval snapshot, and invalidates on policy alteration", async () => {
        const repo = new InMemoryPurchaseRepository();
        const mockPayPal = {
          createOrder: vi.fn(),
          captureOrder: vi.fn(),
          getOrder: vi.fn(),
        } as unknown as PayPalSandboxClient;

        const service = new PurchaseWorkflowService(repo, mockPayPal);
        const userActor: Actor = { kind: "user", userId: "usr_trace_13b" };
        const systemActor: Actor = { kind: "system", component: "discovery_engine" };

        // 1. Create purchase
        const purchase = await service.createPurchase(
          {
            budgetCents: 10000, // $100.00
            currency: "USD",
            requirements: ["keyboard"],
          },
          userActor
        );

        // 2. Evaluate candidate with Target policy free shipping ($45 > $35)
        const evalRes = await service.evaluatePurchaseCandidate(
          purchase.id,
          {
            rawCandidate: {
              externalId: "cand_tgt_trace_1",
              title: "Mechanical Keyboard",
              merchantName: "Target",
              merchantUrl: "https://www.target.com/p/mechanical-keyboard/-/A-12345",
              unitPriceCents: 4500,
              quantity: 1,
              shippingCents: 0,
              shippingType: "policy_derived",
              deliveryMethod: "standard_ground",
              destinationPostalCode: "98101",
              destinationCountry: "US",
              policyId: "pol_target_contiguous_us_ground_v2",
              policyDocumentFingerprint: registry.getPoliciesForMerchant("Target")[0].policyDocumentFingerprint,
              policySourceUrl: "https://help.target.com/help/subcategoryarticle?childcat=Free+shipping",
              geographicZone: "contiguous_us",
              serviceabilityStatus: "serviceable",
              thresholdCents: 3500,
              sourceVerificationTimestamp: referenceDate.toISOString(),
              currency: "USD",
              availability: "IN_STOCK",
            },
            rawObservations: [
              {
                requirementKey: "keyboard",
                value: "Mechanical Keyboard",
                status: "supports",
                sourceUrl: "https://www.target.com/p/mechanical-keyboard/-/A-12345",
                sourceType: "merchant_spec",
                capturedAt: referenceDate.toISOString(),
              },
            ],
            requiredRuleKeys: ["P-BUDGET", "P-CURRENCY", "P-AVAILABILITY"],
          },
          systemActor,
          referenceDate
        );

        expect(evalRes.status).toBe("POLICY_PASSED");

        // 3. Buyer approves purchase based on current policy evidence at landed cost $45.00
        const approval = await service.approvePurchase(
          purchase.id,
          {
            expectedSnapshotHash: evalRes.snapshotHash,
            expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
            expectedTotalCents: 4500,
            expectedCurrency: "USD",
          },
          userActor,
          referenceDate
        );

        expect(approval.status).toBe("APPROVED");

        // 4. Trace policy alteration / withdrawal invalidating the approval:
        // If the policy changes or is withdrawn, the candidate's shipping changes from $0 to $5.99 (599 cents).
        // Landed cost mutates to 5099 cents and snapshot hash changes.
        const aggregate = await repo.getPurchaseById(purchase.id);
        expect(aggregate).not.toBeNull();
        if (aggregate && aggregate.selectedCandidate) {
          aggregate.selectedCandidate.shippingCents = 599;
          aggregate.selectedCandidate.totalCents = 5099;
          aggregate.selectedCandidate.snapshotHash = "mutated_snapshot_due_to_policy_change";
        }

        // State machine invalidates approval and refuses to create PayPal order!
        await expect(
          service.createPayPalOrder(purchase.id, userActor)
        ).rejects.toThrow();
      });
    });
  });

  // =========================================================================
  // Phase 13B.2 — Policy Evidence Accuracy Review
  // =========================================================================
  describe("Phase 13B.2 — Policy Evidence Accuracy Review", () => {
    const registry = new MerchantPolicyRegistry(DEFAULT_MERCHANT_POLICIES);

    describe("1. Walmart Seller Eligibility vs Cart-Threshold Contribution", () => {
      it("excludes independent 3P seller-fulfilled items from Walmart free shipping even above $35", () => {
        // Independent seller fulfilling their own order ($50.00 > $35.00)
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_wm_seller_fulfilled",
            merchantName: "Walmart",
            sellerName: "Independent Audio Pro",
            isMarketplace: true,
            isWfsFulfilled: false,
            unitPriceCents: 5000,
            quantity: 1,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome).not.toBeNull();
        expect(outcome?.status).toBe("marketplace_seller_excluded");
        expect(outcome?.isApplicable).toBe(false);
        expect(outcome?.shippingCents).toBeNull();
        expect(outcome?.explanation).toContain("only covers shipping for items fulfilled by Walmart or Walmart Fulfillment Services (WFS)");
      });

      it("satisfies policy for Walmart Fulfillment Services (WFS) items over $35", () => {
        // Third-party seller using WFS (fulfilled by Walmart)
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_wm_wfs",
            merchantName: "Walmart",
            sellerName: "Quality Kitchen Goods",
            isMarketplace: true,
            isWfsFulfilled: true,
            unitPriceCents: 4500, // $45.00
            quantity: 1,
          },
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("satisfied");
        expect(outcome?.isApplicable).toBe(true);
        expect(outcome?.shippingCents).toBe(0);
        expect(outcome?.policyId).toBe("pol_walmart_contiguous_us_ground_v2");
      });

      it("allows eligible marketplace items to contribute toward the $35 minimum for Walmart-fulfilled items", () => {
        // Candidate item is Walmart direct ($20.00, below $35)
        // But cart includes $15.00 of eligible marketplace items -> cart total $35.00
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_wm_item",
            merchantName: "Walmart",
            sellerName: "Walmart",
            unitPriceCents: 2000,
            quantity: 1,
          },
          cartTotalCents: 3500, // $20 Walmart item + $15 Marketplace item = $35 qualifying total
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("satisfied");
        expect(outcome?.isApplicable).toBe(true);
        expect(outcome?.shippingCents).toBe(0);
      });

      it("fails closed with threshold_not_met when combined cart total is under $35", () => {
        // Candidate item is Walmart direct ($20.00) + marketplace items ($10.00) = $30.00 (< $35.00)
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_wm_under",
            merchantName: "Walmart",
            sellerName: "Walmart",
            unitPriceCents: 2000,
            quantity: 1,
          },
          cartTotalCents: 3000,
          destination: { country: "US", postalCode: "98101" },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("threshold_not_met");
        expect(outcome?.shippingCents).toBeNull();
      });
    });

    describe("2. Target Promotion vs Circle Card vs Circle 360 & Destination Eligibility", () => {
      it("satisfies standard $35 promotion for military APO/FPO addresses", () => {
        // Target official terms: free standard shipping applies to orders shipping to 48 continental states and APO/FPO
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_tgt_apo",
            merchantName: "Target",
            sellerName: "Target",
            unitPriceCents: 4500, // $45.00
            quantity: 1,
          },
          destination: {
            country: "US",
            postalCode: "09012", // Military AE
            deliveryMethodPreference: "standard_ground",
          },
          now: referenceDate,
        });

        expect(outcome?.status).toBe("satisfied");
        expect(outcome?.shippingCents).toBe(0);
        expect(outcome?.geographicZone).toBe("military_apo_fpo");
      });

      it("excludes Alaska and Hawaii from the standard $35 promotion", () => {
        // Target official terms: standard $35 offer excludes Alaska, Hawaii, and U.S. protectorates
        const outcomeAlaska = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_tgt_ak",
            merchantName: "Target",
            sellerName: "Target",
            unitPriceCents: 5000,
            quantity: 1,
          },
          destination: { country: "US", postalCode: "99501" }, // Anchorage, AK
          now: referenceDate,
        });

        expect(outcomeAlaska?.status).toBe("geographic_exclusion");
        expect(outcomeAlaska?.isApplicable).toBe(false);
        expect(outcomeAlaska?.shippingCents).toBeNull();

        const outcomeHawaii = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_tgt_hi",
            merchantName: "Target",
            sellerName: "Target",
            unitPriceCents: 5000,
            quantity: 1,
          },
          destination: { country: "US", postalCode: "96801" }, // Honolulu, HI
          now: referenceDate,
        });

        expect(outcomeHawaii?.status).toBe("geographic_exclusion");
        expect(outcomeHawaii?.shippingCents).toBeNull();
      });

      it("grants free shipping to Alaska and Hawaii when paying with verified Target Circle Card", () => {
        // Target official terms: Target Circle Card provides free shipping to all 50 states (including AK and HI)
        const outcomeAlaskaCard = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_tgt_ak_card",
            merchantName: "Target",
            sellerName: "Target",
            unitPriceCents: 2000, // Even under $35!
            quantity: 1,
            buyerMembership: ["target_circle_card"],
          },
          destination: { country: "US", postalCode: "99501" }, // Anchorage, AK
          now: referenceDate,
        });

        expect(outcomeAlaskaCard?.status).toBe("satisfied");
        expect(outcomeAlaskaCard?.shippingCents).toBe(0);
        expect(outcomeAlaskaCard?.policyId).toBe("pol_target_circle_card_v2");

        const outcomeHawaiiCard = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_tgt_hi_card",
            merchantName: "Target",
            sellerName: "Target",
            unitPriceCents: 2500,
            quantity: 1,
            buyerMembership: ["target_circle_card"],
          },
          destination: { country: "US", postalCode: "96801" }, // Honolulu, HI
          now: referenceDate,
        });

        expect(outcomeHawaiiCard?.status).toBe("satisfied");
        expect(outcomeHawaiiCard?.shippingCents).toBe(0);
        expect(outcomeHawaiiCard?.policyId).toBe("pol_target_circle_card_v2");
      });

      it("never silently assumes Circle Card or Circle 360 benefits for autonomous agents", () => {
        // Standard shopper without card or 360 to Alaska
        const outcome = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_tgt_no_card",
            merchantName: "Target",
            sellerName: "Target",
            unitPriceCents: 4500,
            quantity: 1,
            buyerMembership: [], // No card, no 360
          },
          destination: { country: "US", postalCode: "99501" },
          now: referenceDate,
        });

        // Must fail closed; must never grant free shipping
        expect(outcome?.isApplicable).toBe(false);
        expect(outcome?.shippingCents).toBeNull();
      });
    });

    describe("3. Absence of Invented Effective Dates", () => {
      it("preserves sourceStatedEffectiveDate as null for standing published help articles", () => {
        const policies = registry.getAllPolicies();
        for (const policy of policies) {
          // Standing online help articles do not state formal effective dates
          // We must never fabricate an effective date (e.g. "2024-01-01") when unstated by source
          expect(policy.sourceStatedEffectiveDate).toBeNull();
          expect(policy.effectiveFrom).toBeNull();

          // But retrievedAt and lastReviewedAt must be valid, authentic audit timestamps
          expect(policy.retrievedAt).toBe("2026-10-28T00:00:00.000Z");
          expect(policy.lastReviewedAt).toBe("2026-10-29T00:00:00.000Z");
        }
      });

      it("distinguishes retrieval timestamp, review timestamp, and source-declared effective date", () => {
        const bestBuyPolicy = registry.getPoliciesForMerchant("Best Buy")[0];
        expect(bestBuyPolicy.retrievedAt).not.toBe(bestBuyPolicy.lastReviewedAt);
        expect(bestBuyPolicy.sourceStatedEffectiveDate).toBeNull();
      });
    });

    describe("4. Best Buy & B&H Terms Strictness", () => {
      it("verifies Best Buy official shipping help hub URL", () => {
        const bestBuyPolicy = registry.getPoliciesForMerchant("Best Buy")[0];
        // Must point to official shipping help topic (pcmcat1504113264003.c), not old credit card topic
        expect(bestBuyPolicy.policySourceUrl).toBe(
          "https://www.bestbuy.com/site/help-topics/shipping-delivery-and-store-pickup/pcmcat1504113264003.c"
        );
      });

      it("correctly separates B&H expedited from standard ground across delivery preferences", () => {
        // Standard ground preference: evaluates standard ground ($0 threshold, item-specific)
        const outcomeStd = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_bh_std",
            merchantName: "B&H Photo Video",
            sellerName: "B&H Photo Video",
            unitPriceCents: 2000, // $20.00 < $49.00
            quantity: 1,
            isFreeShippingEligibleItem: true,
          },
          destination: {
            country: "US",
            postalCode: "98101",
            deliveryMethodPreference: "standard_ground",
          },
          now: referenceDate,
        });

        expect(outcomeStd?.status).toBe("satisfied");
        expect(outcomeStd?.shippingCents).toBe(0);
        expect(outcomeStd?.deliveryMethod).toBe("standard_ground");
        expect(outcomeStd?.policyId).toBe("pol_bhphoto_contiguous_us_free_standard_v2");

        // Expedited preference: evaluates $49 threshold policy
        const outcomeExp = registry.evaluateCandidate({
          candidate: {
            externalId: "cand_bh_exp",
            merchantName: "B&H Photo Video",
            sellerName: "B&H Photo Video",
            unitPriceCents: 5500, // $55.00 >= $49.00
            quantity: 1,
          },
          destination: {
            country: "US",
            postalCode: "98101",
            deliveryMethodPreference: "expedited",
          },
          now: referenceDate,
        });

        expect(outcomeExp?.status).toBe("satisfied");
        expect(outcomeExp?.shippingCents).toBe(0);
        expect(outcomeExp?.deliveryMethod).toBe("expedited");
        expect(outcomeExp?.policyId).toBe("pol_bhphoto_contiguous_us_expedited_v2");
      });
    });
  });
});
