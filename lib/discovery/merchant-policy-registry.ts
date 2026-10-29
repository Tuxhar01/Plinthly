/**
 * Plinthly Phase 13B — Authoritative Published Merchant Policy Registry.
 *
 * Maintains deterministic, cryptographic policy definitions for verified retailer
 * free shipping thresholds published on official retailer domains.
 *
 * All published policy documents are backed by:
 * - Public policy source URL (https only)
 * - Publisher corporate identity
 * - Explicit contiguous US vs non-contiguous exclusions
 * - Order minimum thresholds in exact integer cents
 * - SHA-256 policy document fingerprints
 */

import {
  computePolicyFingerprint,
  evaluateMerchantShippingPolicy,
  MerchantShippingPolicy,
  PolicyEvaluationContext,
  PolicyEvaluationResult,
} from "./merchant-policy";
import { normalizeMerchantAlias } from "./normalize";

function createPolicy(
  raw: Omit<MerchantShippingPolicy, "policyDocumentFingerprint">
): MerchantShippingPolicy {
  return {
    ...raw,
    policyDocumentFingerprint: computePolicyFingerprint(raw),
  };
}

/**
 * Built-in authoritative merchant shipping policies for major US retailers.
 */
export const DEFAULT_MERCHANT_POLICIES: readonly MerchantShippingPolicy[] = [
  // 1. Best Buy: Free standard ground shipping on orders >= $35.00 in contiguous US
  // Excludes 3rd-party marketplace sellers, scheduled in-home delivery, major appliances
  createPolicy({
    policyId: "pol_bestbuy_contiguous_us_ground_v2",
    merchantDomain: "bestbuy.com",
    merchantName: "Best Buy",
    policySourceUrl: "https://www.bestbuy.com/site/help-topics/shipping-delivery-and-store-pickup/pcmcat1504113264003.c",
    publisher: "Best Buy Co., Inc.",
    sourceStatedEffectiveDate: null,
    retrievedAt: "2026-10-28T00:00:00.000Z",
    lastReviewedAt: "2026-10-29T00:00:00.000Z",
    effectiveFrom: null,
    expiresAt: null,
    deliveryMethod: "standard_ground",
    currency: "USD",
    thresholdCents: 3500, // $35.00
    shippingCostCents: 0,
    allowedZones: ["contiguous_us"],
    excludedZones: ["alaska", "hawaii", "us_territory", "military_apo_fpo"],
    excludedCategories: ["freight", "oversized", "special delivery", "major appliances", "scheduled delivery"],
    excludedSpecialFulfillmentMethods: ["scheduled_delivery", "in_home_delivery", "special_delivery", "freight"],
    requiresDirectRetailerSeller: true,
    requiresPreTaxMerchandiseThreshold: true,
    itemSpecificQualificationRequired: false,
    policyVersion: "2.0.0",
  }),

  // 2. Walmart: Free standard shipping on orders >= $35.00 fulfilled by Walmart or WFS in contiguous US
  // Candidate item must be fulfilled by Walmart or WFS; eligible Marketplace items contribute toward the $35 cart minimum
  createPolicy({
    policyId: "pol_walmart_contiguous_us_ground_v2",
    merchantDomain: "walmart.com",
    merchantName: "Walmart",
    policySourceUrl: "https://www.walmart.com/help/article/shipping-rates-and-delivery/4113264426aa41aa9d00da81691a5e1e",
    publisher: "Walmart Inc.",
    sourceStatedEffectiveDate: null,
    retrievedAt: "2026-10-28T00:00:00.000Z",
    lastReviewedAt: "2026-10-29T00:00:00.000Z",
    effectiveFrom: null,
    expiresAt: null,
    deliveryMethod: "standard_ground",
    currency: "USD",
    thresholdCents: 3500, // $35.00
    shippingCostCents: 0,
    allowedZones: ["contiguous_us"],
    excludedZones: ["alaska", "hawaii", "us_territory", "military_apo_fpo"],
    excludedCategories: ["freight", "oversized", "heavy", "hazardous materials", "fresh grocery", "pharmacy"],
    excludedSpecialFulfillmentMethods: ["freight", "scheduled_delivery", "delivery_from_store"],
    requiresDirectRetailerOrWfsFulfillment: true, // Only items fulfilled by Walmart or WFS receive Walmart-funded free shipping
    marketplaceItemsContributeToThreshold: true, // Eligible marketplace items contribute to the $35 cart minimum
    requiresMembership: null, // Autonomous agents do not assume Walmart+ without proof
    requiresPreTaxMerchandiseThreshold: true,
    itemSpecificQualificationRequired: false,
    policyVersion: "2.0.0",
  }),

  // 3. Target: Free standard ground shipping on orders >= $35.00 of qualifying merchandise
  // Calculated pre-tax and after discounts; excludes Target Plus marketplace items and special handling
  // Allowed destinations: 48 continental states (CONUS) and APO/FPO addresses; Excluded: AK, HI, protectorates
  createPolicy({
    policyId: "pol_target_contiguous_us_ground_v2",
    merchantDomain: "target.com",
    merchantName: "Target",
    policySourceUrl: "https://help.target.com/help/subcategoryarticle?childcat=Free+shipping",
    publisher: "Target Brands, Inc.",
    sourceStatedEffectiveDate: null,
    retrievedAt: "2026-10-28T00:00:00.000Z",
    lastReviewedAt: "2026-10-29T00:00:00.000Z",
    effectiveFrom: null,
    expiresAt: null,
    deliveryMethod: "standard_ground",
    currency: "USD",
    thresholdCents: 3500, // $35.00
    shippingCostCents: 0,
    allowedZones: ["contiguous_us", "military_apo_fpo"], // Explicitly includes 48 continental states & APO/FPO
    excludedZones: ["alaska", "hawaii", "us_territory"], // Explicitly excludes AK, HI, and protectorates
    excludedCategories: ["freight", "oversized", "special handling", "target plus"],
    excludedSpecialFulfillmentMethods: ["scheduled_delivery", "freight", "special_handling"],
    requiresDirectRetailerSeller: true,
    requiresMembership: null,
    requiresPreTaxMerchandiseThreshold: true,
    itemSpecificQualificationRequired: false,
    policyVersion: "2.0.0",
  }),

  // 4. Target Circle Card: Free standard shipping to all 50 states (including AK & HI) and APO/FPO
  // Requires payment with Target Circle Card (Credit, Debit, or Mastercard)
  createPolicy({
    policyId: "pol_target_circle_card_v2",
    merchantDomain: "target.com",
    merchantName: "Target",
    policySourceUrl: "https://help.target.com/help/subcategoryarticle?childcat=Free+shipping",
    publisher: "Target Brands, Inc.",
    sourceStatedEffectiveDate: null,
    retrievedAt: "2026-10-28T00:00:00.000Z",
    lastReviewedAt: "2026-10-29T00:00:00.000Z",
    effectiveFrom: null,
    expiresAt: null,
    deliveryMethod: "standard_ground",
    currency: "USD",
    thresholdCents: 0, // $0 minimum on eligible items
    shippingCostCents: 0,
    allowedZones: ["contiguous_us", "alaska", "hawaii", "military_apo_fpo"], // All 50 states + APO/FPO
    excludedZones: ["us_territory"],
    excludedCategories: ["freight", "oversized", "special handling", "target plus"],
    excludedSpecialFulfillmentMethods: ["scheduled_delivery", "freight", "special_handling"],
    requiresDirectRetailerSeller: true,
    requiresMembership: "target_circle_card", // Must be verified
    requiresPreTaxMerchandiseThreshold: false,
    itemSpecificQualificationRequired: false,
    policyVersion: "2.0.0",
  }),

  // 5. Target Circle 360: Free 2-day / expedited shipping and same-day delivery
  createPolicy({
    policyId: "pol_target_circle_360_v2",
    merchantDomain: "target.com",
    merchantName: "Target",
    policySourceUrl: "https://help.target.com/help/subcategoryarticle?childcat=Free+shipping",
    publisher: "Target Brands, Inc.",
    sourceStatedEffectiveDate: null,
    retrievedAt: "2026-10-28T00:00:00.000Z",
    lastReviewedAt: "2026-10-29T00:00:00.000Z",
    effectiveFrom: null,
    expiresAt: null,
    deliveryMethod: "expedited",
    currency: "USD",
    thresholdCents: 0,
    shippingCostCents: 0,
    allowedZones: ["contiguous_us", "alaska", "hawaii", "military_apo_fpo"],
    excludedZones: ["us_territory"],
    excludedCategories: ["freight", "oversized", "special handling"],
    excludedSpecialFulfillmentMethods: ["scheduled_delivery", "freight"],
    requiresDirectRetailerSeller: true,
    requiresMembership: "target_circle_360", // Must be verified
    requiresPreTaxMerchandiseThreshold: false,
    itemSpecificQualificationRequired: false,
    policyVersion: "2.0.0",
  }),

  // 6. B&H Photo Video: Free Expedited Shipping (1-2 Day) on orders >= $49.00 in contiguous US
  createPolicy({
    policyId: "pol_bhphoto_contiguous_us_expedited_v2",
    merchantDomain: "bhphotovideo.com",
    merchantName: "B&H Photo Video",
    policySourceUrl: "https://www.bhphotovideo.com/find/HelpCenter/Shipping.jsp",
    publisher: "B&H Foto & Electronics Corp.",
    sourceStatedEffectiveDate: null,
    retrievedAt: "2026-10-28T00:00:00.000Z",
    lastReviewedAt: "2026-10-29T00:00:00.000Z",
    effectiveFrom: null,
    expiresAt: null,
    deliveryMethod: "expedited",
    currency: "USD",
    thresholdCents: 4900, // $49.00
    shippingCostCents: 0,
    allowedZones: ["contiguous_us"],
    excludedZones: ["alaska", "hawaii", "us_territory", "military_apo_fpo"],
    excludedCategories: ["freight", "oversized", "drop ship", "special order"],
    excludedSpecialFulfillmentMethods: ["freight", "truck_delivery"],
    requiresDirectRetailerSeller: true,
    requiresPreTaxMerchandiseThreshold: true,
    itemSpecificQualificationRequired: false,
    policyVersion: "2.0.0",
  }),

  // 7. B&H Photo Video: Free Standard Ground Shipping on verified qualifying items (no universal $49 minimum)
  createPolicy({
    policyId: "pol_bhphoto_contiguous_us_free_standard_v2",
    merchantDomain: "bhphotovideo.com",
    merchantName: "B&H Photo Video",
    policySourceUrl: "https://www.bhphotovideo.com/find/HelpCenter/Shipping.jsp",
    publisher: "B&H Foto & Electronics Corp.",
    sourceStatedEffectiveDate: null,
    retrievedAt: "2026-10-28T00:00:00.000Z",
    lastReviewedAt: "2026-10-29T00:00:00.000Z",
    effectiveFrom: null,
    expiresAt: null,
    deliveryMethod: "standard_ground",
    currency: "USD",
    thresholdCents: 0, // No universal order minimum; item-specific qualification required
    shippingCostCents: 0,
    allowedZones: ["contiguous_us"],
    excludedZones: ["alaska", "hawaii", "us_territory", "military_apo_fpo"],
    excludedCategories: ["freight", "oversized"],
    requiresDirectRetailerSeller: true,
    requiresPreTaxMerchandiseThreshold: false,
    itemSpecificQualificationRequired: true,
    policyVersion: "2.0.0",
  }),
];

export interface SerializedPolicyRegistryState {
  readonly policies: readonly MerchantShippingPolicy[];
  readonly history: readonly {
    readonly policyId: string;
    readonly versions: readonly MerchantShippingPolicy[];
  }[];
}

export class MerchantPolicyRegistry {
  private readonly policies: Map<string, MerchantShippingPolicy[]> = new Map();
  private readonly history: Map<string, MerchantShippingPolicy[]> = new Map();

  constructor(initialPolicies: readonly MerchantShippingPolicy[] = DEFAULT_MERCHANT_POLICIES) {
    for (const p of initialPolicies) {
      this.registerPolicy(p);
    }
  }

  registerPolicy(policy: MerchantShippingPolicy): void {
    const norm = normalizeMerchantAlias(policy.merchantName);
    const existing = this.policies.get(norm) ?? [];
    this.policies.set(norm, [...existing, policy]);

    const hist = this.history.get(policy.policyId) ?? [];
    if (!hist.some((p) => p.policyVersion === policy.policyVersion)) {
      this.history.set(policy.policyId, [...hist, policy]);
    }
  }

  /**
   * Publishes a new version of a policy, superseding any prior active version
   * while preserving historical versions for audit tracking.
   */
  publishPolicy(policy: MerchantShippingPolicy): void {
    const norm = normalizeMerchantAlias(policy.merchantName);
    const existing = this.policies.get(norm) ?? [];

    const updated = existing.filter((p) => p.policyId !== policy.policyId);
    updated.push(policy);
    this.policies.set(norm, updated);

    const hist = this.history.get(policy.policyId) ?? [];
    this.history.set(
      policy.policyId,
      [...hist.filter((p) => p.policyVersion !== policy.policyVersion), policy]
    );
  }

  getPoliciesForMerchant(merchantName: string): readonly MerchantShippingPolicy[] {
    const norm = normalizeMerchantAlias(merchantName);
    return this.policies.get(norm) ?? [];
  }

  getPolicyForDomain(domain: string): MerchantShippingPolicy | null {
    const norm = normalizeMerchantAlias(domain);
    const policies = this.policies.get(norm) ?? [];
    if (policies.length > 0) return policies[0];
    for (const policy of this.getAllPolicies()) {
      if (policy.merchantDomain.toLowerCase() === domain.toLowerCase()) {
        return policy;
      }
    }
    return null;
  }

  getAllPolicies(): readonly MerchantShippingPolicy[] {
    const all: MerchantShippingPolicy[] = [];
    for (const list of this.policies.values()) {
      all.push(...list);
    }
    return all;
  }

  /**
   * Retrieves a historical or current policy by policyId and version.
   */
  getPolicyVersion(policyId: string, version: string): MerchantShippingPolicy | null {
    const hist = this.history.get(policyId) ?? [];
    return hist.find((p) => p.policyVersion === version) ?? null;
  }

  /**
   * Returns complete historical audit of all registered versions for a policyId.
   */
  getPolicyHistory(policyId: string): readonly MerchantShippingPolicy[] {
    return this.history.get(policyId) ?? [];
  }

  /**
   * Checks whether a specific policy version is currently active in the registry.
   */
  isPolicyActive(policyId: string, version: string): boolean {
    const all = this.getAllPolicies();
    return all.some((p) => p.policyId === policyId && p.policyVersion === version);
  }

  /**
   * Checks whether a policy document fingerprint corresponds to any currently active policy.
   */
  isFingerprintActive(fingerprint: string): boolean {
    const all = this.getAllPolicies();
    return all.some((p) => p.policyDocumentFingerprint === fingerprint);
  }

  /**
   * Serializes active policies and version history for cross-restart durability.
   */
  exportState(): SerializedPolicyRegistryState {
    return {
      policies: this.getAllPolicies(),
      history: Array.from(this.history.entries()).map(([policyId, versions]) => ({
        policyId,
        versions: [...versions],
      })),
    };
  }

  /**
   * Restores active policies and version history from persistent state.
   */
  importState(state: SerializedPolicyRegistryState): void {
    this.policies.clear();
    this.history.clear();
    for (const h of state.history) {
      this.history.set(h.policyId, [...h.versions]);
    }
    for (const p of state.policies) {
      this.publishPolicy(p);
    }
  }

  /**
   * Evaluates all registered policies for a candidate's merchant.
   * If exactly one policy is satisfied, returns the satisfied result.
   * If multiple policies produce conflicting rate outcomes, fails closed.
   * If no policy satisfies, returns the most specific blocker diagnostic.
   */
  evaluateCandidate(context: PolicyEvaluationContext): PolicyEvaluationResult | null {
    const policies = this.getPoliciesForMerchant(context.candidate.merchantName);
    if (policies.length === 0) {
      return null;
    }

    const results: PolicyEvaluationResult[] = [];
    for (const p of policies) {
      results.push(evaluateMerchantShippingPolicy(p, context));
    }

    const satisfied = results.filter((r) => r.status === "satisfied");

    // Conflicting satisfied policies with different rates
    if (satisfied.length > 1) {
      const distinctRates = new Set(satisfied.map((s) => s.shippingCents));
      if (distinctRates.size > 1) {
        return {
          status: "conflicting_policies",
          isApplicable: false,
          isAuthoritative: false,
          shippingCents: null,
          serviceability: "serviceable",
          geographicZone: satisfied[0].geographicZone,
          explanation: `Multiple conflicting merchant shipping policies satisfied with different rates: ${satisfied.map((s) => `${s.policyId}: $${((s.shippingCents ?? 0) / 100).toFixed(2)}`).join(", ")}. Fails closed.`,
        };
      }
      return satisfied[0];
    }

    if (satisfied.length === 1) {
      return satisfied[0];
    }

    // Return the most informative blocker in order of diagnosis specificity
    const blockerPriority: PolicyEvaluationResult["status"][] = [
      "marketplace_seller_excluded",
      "special_delivery_required",
      "unconfirmed_qualification",
      "threshold_not_met",
      "geographic_exclusion",
      "product_exclusion",
      "membership_required",
      "delivery_method_mismatch",
      "policy_expired",
      "currency_mismatch",
      "merchant_mismatch",
      "fingerprint_mismatch",
    ];

    for (const status of blockerPriority) {
      const match = results.find((r) => r.status === status);
      if (match) return match;
    }

    return results[0];
  }
}

let globalRegistry: MerchantPolicyRegistry = new MerchantPolicyRegistry();

export function getMerchantPolicyRegistry(): MerchantPolicyRegistry {
  return globalRegistry;
}

export function setMerchantPolicyRegistry(registry: MerchantPolicyRegistry): void {
  globalRegistry = registry;
}

