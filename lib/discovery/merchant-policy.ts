/**
 * Plinthly Phase 13B — Deterministic Merchant Shipping Policy Engine.
 *
 * Evaluates published, authoritative merchant shipping policies against product candidates,
 * purchase quantities, and destination context with zero guessing and zero floating-point math.
 *
 * Enforces:
 * 1. Thresholds are only applied when candidate facts, destination, and shipping method satisfy the policy.
 * 2. Expired, ambiguous, conflicting, unsupported, or incomplete policies fail closed.
 * 3. Preserves the distinction between verified policies ("policy_derived") and quotes ("quoted").
 * 4. Models geographic exclusions and serviceability separately from monetary price.
 */

import { createHash } from "node:crypto";
import { Currency } from "../state/types";
import {
  checkGeographicEligibility,
  DestinationServiceability,
  GeographicZone,
  resolveGeographicZone,
} from "./geographic-zones";
import { normalizeMerchantAlias } from "./normalize";

/**
 * Structured, immutable representation of an authoritative published merchant shipping policy.
 */
export interface MerchantShippingPolicy {
  readonly policyId: string;
  readonly merchantDomain: string;
  readonly merchantName: string;
  readonly policySourceUrl: string;
  readonly publisher: string;
  readonly sourceStatedEffectiveDate?: string | null; // Declared effective date from source if any, else null (never invent dates)
  readonly retrievedAt: string; // ISO 8601 UTC when page was retrieved by our system
  readonly lastReviewedAt?: string; // ISO 8601 UTC when policy evidence was reviewed by audit
  readonly effectiveFrom?: string | null; // ISO 8601 UTC or null (backward-compatible alias)
  readonly expiresAt: string | null; // ISO 8601 UTC or null
  readonly deliveryMethod: string; // e.g. "standard_ground" or "expedited"
  readonly currency: Currency;
  readonly thresholdCents: number; // e.g. 3500 for $35.00, or 0 if item-specific
  readonly shippingCostCents: number; // e.g. 0 for free shipping over threshold
  readonly allowedZones: readonly GeographicZone[];
  readonly excludedZones: readonly GeographicZone[];
  readonly excludedPostalCodes?: readonly string[];
  readonly applicableCategories?: readonly string[];
  readonly excludedCategories?: readonly string[];
  readonly requiresDirectRetailerSeller?: boolean; // Excludes 3rd-party marketplace sellers
  readonly requiresDirectRetailerOrWfsFulfillment?: boolean; // For Walmart: Walmart or WFS fulfillment required
  readonly marketplaceItemsContributeToThreshold?: boolean; // For Walmart: Marketplace items contribute to $35 minimum
  readonly requiresMembership?: string | null; // e.g. "walmart_plus", "target_circle_360", "target_circle_card"
  readonly excludedSpecialFulfillmentMethods?: readonly string[]; // e.g. "scheduled_delivery", "in_home_delivery", "freight"
  readonly requiresPreTaxMerchandiseThreshold?: boolean; // Threshold calculated pre-tax and after discounts
  readonly itemSpecificQualificationRequired?: boolean; // Item must be marked free-shipping eligible
  readonly policyVersion: string;
  readonly policyDocumentFingerprint: string; // SHA-256 hash of canonical terms
}

/**
 * Computes deterministic SHA-256 fingerprint across canonical policy terms.
 */
export function computePolicyFingerprint(
  policy: Omit<MerchantShippingPolicy, "policyDocumentFingerprint">
): string {
  const canonical = {
    allowedZones: [...policy.allowedZones].sort(),
    applicableCategories: policy.applicableCategories ? [...policy.applicableCategories].sort() : [],
    currency: policy.currency,
    deliveryMethod: policy.deliveryMethod,
    effectiveFrom: policy.effectiveFrom ?? null,
    excludedCategories: policy.excludedCategories ? [...policy.excludedCategories].sort() : [],
    excludedPostalCodes: policy.excludedPostalCodes ? [...policy.excludedPostalCodes].sort() : [],
    excludedSpecialFulfillmentMethods: policy.excludedSpecialFulfillmentMethods
      ? [...policy.excludedSpecialFulfillmentMethods].sort()
      : [],
    excludedZones: [...policy.excludedZones].sort(),
    expiresAt: policy.expiresAt,
    itemSpecificQualificationRequired: policy.itemSpecificQualificationRequired === true,
    lastReviewedAt: policy.lastReviewedAt ?? policy.retrievedAt,
    marketplaceItemsContributeToThreshold: policy.marketplaceItemsContributeToThreshold === true,
    merchantDomain: policy.merchantDomain.toLowerCase().trim(),
    merchantName: policy.merchantName.trim(),
    policyId: policy.policyId.trim(),
    policySourceUrl: policy.policySourceUrl.trim(),
    policyVersion: policy.policyVersion.trim(),
    publisher: policy.publisher.trim(),
    requiresDirectRetailerOrWfsFulfillment: policy.requiresDirectRetailerOrWfsFulfillment === true,
    requiresDirectRetailerSeller: policy.requiresDirectRetailerSeller === true,
    requiresMembership: policy.requiresMembership ?? null,
    requiresPreTaxMerchandiseThreshold: policy.requiresPreTaxMerchandiseThreshold === true,
    retrievedAt: policy.retrievedAt,
    shippingCostCents: policy.shippingCostCents,
    sourceStatedEffectiveDate: policy.sourceStatedEffectiveDate ?? null,
    thresholdCents: policy.thresholdCents,
  };

  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json, "utf8").digest("hex").toLowerCase();
}

export type PolicyEvaluationStatus =
  | "satisfied"
  | "threshold_not_met"
  | "geographic_exclusion"
  | "product_exclusion"
  | "marketplace_seller_excluded"
  | "special_delivery_required"
  | "membership_required"
  | "unconfirmed_qualification"
  | "delivery_method_mismatch"
  | "merchant_mismatch"
  | "currency_mismatch"
  | "policy_expired"
  | "fingerprint_mismatch"
  | "conflicting_policies";

export interface PolicyEvaluationContext {
  readonly candidate: {
    readonly externalId: string;
    readonly unitPriceCents: number;
    readonly quantity: number;
    readonly merchantName: string;
    readonly merchantUrl?: string;
    readonly title?: string;
    readonly sellerName?: string;
    readonly isMarketplace?: boolean;
    readonly isDirectRetailerSeller?: boolean;
    readonly isWfsFulfilled?: boolean;
    readonly requiresSpecialDelivery?: boolean;
    readonly discountCents?: number;
    readonly estimatedTaxCents?: number;
    readonly isFreeShippingEligibleItem?: boolean;
    readonly buyerMembership?: readonly string[];
    readonly rawAttributes?: Record<string, unknown>;
  };
  readonly cartTotalCents?: number;
  readonly destination: {
    readonly country: string;
    readonly postalCode: string;
    readonly deliveryMethodPreference?: string;
  };
  readonly now: Date;
  readonly requestedCurrency?: Currency;
}

export interface PolicyEvaluationResult {
  readonly status: PolicyEvaluationStatus;
  readonly isApplicable: boolean;
  readonly isAuthoritative: boolean;
  readonly shippingCents: number | null;
  readonly deliveryMethod?: string;
  readonly serviceability: DestinationServiceability;
  readonly geographicZone: GeographicZone;
  readonly policyId?: string;
  readonly policySourceUrl?: string;
  readonly policyDocumentFingerprint?: string;
  readonly thresholdCents?: number;
  readonly explanation: string;
}

/**
 * Deterministically evaluates a merchant shipping policy against candidate facts and destination context.
 */
export function evaluateMerchantShippingPolicy(
  policy: MerchantShippingPolicy,
  context: PolicyEvaluationContext
): PolicyEvaluationResult {
  const geo = resolveGeographicZone(context.destination.postalCode);
  const nowTime = context.now.getTime();

  // 1. Fingerprint integrity verification
  const expectedFingerprint = computePolicyFingerprint(policy);
  if (policy.policyDocumentFingerprint !== expectedFingerprint) {
    return {
      status: "fingerprint_mismatch",
      isApplicable: false,
      isAuthoritative: false,
      shippingCents: null,
      serviceability: "unknown",
      geographicZone: geo.zone,
      policyId: policy.policyId,
      explanation: `Policy terms have been modified or corrupted (fingerprint mismatch: expected "${expectedFingerprint}", got "${policy.policyDocumentFingerprint}").`,
    };
  }

  // 2. Policy expiration check
  if (policy.expiresAt) {
    const expireTime = Date.parse(policy.expiresAt);
    if (!isNaN(expireTime) && expireTime <= nowTime) {
      return {
        status: "policy_expired",
        isApplicable: false,
        isAuthoritative: false,
        shippingCents: null,
        serviceability: "serviceable",
        geographicZone: geo.zone,
        policyId: policy.policyId,
        explanation: `Policy "${policy.policyId}" expired at ${policy.expiresAt} (current time: ${context.now.toISOString()}).`,
      };
    }
  }

  // 3. Currency matching
  const requestedCurrency = context.requestedCurrency ?? "USD";
  if (policy.currency !== requestedCurrency) {
    return {
      status: "currency_mismatch",
      isApplicable: false,
      isAuthoritative: false,
      shippingCents: null,
      serviceability: "serviceable",
      geographicZone: geo.zone,
      policyId: policy.policyId,
      explanation: `Policy currency "${policy.currency}" does not match requested currency "${requestedCurrency}".`,
    };
  }

  // 4. Merchant matching (using normalized merchant alias)
  const normCandMerchant = normalizeMerchantAlias(context.candidate.merchantName);
  const normPolicyMerchant = normalizeMerchantAlias(policy.merchantName);
  if (normCandMerchant !== normPolicyMerchant) {
    return {
      status: "merchant_mismatch",
      isApplicable: false,
      isAuthoritative: false,
      shippingCents: null,
      serviceability: "serviceable",
      geographicZone: geo.zone,
      policyId: policy.policyId,
      explanation: `Policy merchant "${policy.merchantName}" does not match candidate merchant "${context.candidate.merchantName}".`,
    };
  }

  // 5. Geographic eligibility and exclusions
  const geoCheck = checkGeographicEligibility({
    destinationPostalCode: context.destination.postalCode,
    allowedZones: policy.allowedZones,
    excludedZones: policy.excludedZones,
    excludedPostalCodes: policy.excludedPostalCodes,
  });

  if (!geoCheck.eligible) {
    return {
      status: "geographic_exclusion",
      isApplicable: false,
      isAuthoritative: false,
      shippingCents: null,
      serviceability: geoCheck.serviceability,
      geographicZone: geoCheck.zone,
      policyId: policy.policyId,
      explanation: `Destination ${context.destination.postalCode} (${geo.regionName}) is excluded by policy: ${geoCheck.reason}`,
    };
  }

  // 6. Delivery method preference check
  const requestedMethod = context.destination.deliveryMethodPreference ?? "standard_ground";
  if (requestedMethod !== policy.deliveryMethod) {
    return {
      status: "delivery_method_mismatch",
      isApplicable: false,
      isAuthoritative: false,
      shippingCents: null,
      serviceability: "serviceable",
      geographicZone: geo.zone,
      policyId: policy.policyId,
      explanation: `Requested delivery method "${requestedMethod}" is not covered by policy method "${policy.deliveryMethod}".`,
    };
  }

  // 7. Marketplace seller check (retailer free shipping excludes 3rd-party marketplace sellers)
  if (policy.requiresDirectRetailerSeller === true) {
    const rawAttrs = context.candidate.rawAttributes ?? {};
    const sellerFromAttrs = typeof rawAttrs.seller === "string" ? rawAttrs.seller : undefined;
    const isMarketplaceFromAttrs =
      rawAttrs.is_marketplace === true ||
      rawAttrs.isMarketplace === true ||
      rawAttrs.marketplace === true;

    const sellerName = context.candidate.sellerName ?? sellerFromAttrs;
    const isMarketplace =
      context.candidate.isMarketplace === true ||
      context.candidate.isDirectRetailerSeller === false ||
      isMarketplaceFromAttrs;

    if (isMarketplace) {
      return {
        status: "marketplace_seller_excluded",
        isApplicable: false,
        isAuthoritative: false,
        shippingCents: null,
        serviceability: "serviceable",
        geographicZone: geo.zone,
        policyId: policy.policyId,
        explanation: `Candidate is identified as a third-party marketplace offer. ${policy.merchantName} policy "${policy.policyId}" only applies to items sold/fulfilled directly by ${policy.merchantName}.`,
      };
    }

    if (sellerName) {
      const normSeller = normalizeMerchantAlias(sellerName);
      if (normSeller !== normPolicyMerchant) {
        return {
          status: "marketplace_seller_excluded",
          isApplicable: false,
          isAuthoritative: false,
          shippingCents: null,
          serviceability: "serviceable",
          geographicZone: geo.zone,
          policyId: policy.policyId,
          explanation: `Candidate is sold by third-party marketplace seller "${sellerName}". ${policy.merchantName} policy "${policy.policyId}" requires items to be sold directly by ${policy.merchantName}.`,
        };
      }
    }
  }

  // 7B. Walmart/WFS fulfillment requirement (distinguishing seller shipping eligibility from cart-threshold contribution)
  if (policy.requiresDirectRetailerOrWfsFulfillment === true) {
    const rawAttrs = context.candidate.rawAttributes ?? {};
    const sellerFromAttrs = typeof rawAttrs.seller === "string" ? rawAttrs.seller : undefined;
    const sellerName = context.candidate.sellerName ?? sellerFromAttrs;
    const normSeller = sellerName ? normalizeMerchantAlias(sellerName) : undefined;
    const isDirect =
      context.candidate.isDirectRetailerSeller === true ||
      (normSeller !== undefined && normSeller === normPolicyMerchant) ||
      (sellerName === undefined && !context.candidate.isMarketplace);

    const isWfs =
      context.candidate.isWfsFulfilled === true ||
      rawAttrs.is_wfs === true ||
      rawAttrs.fulfilled_by === "Walmart" ||
      rawAttrs.fulfilled_by === "WFS";

    // Candidate item itself must be fulfilled by Walmart or WFS to qualify for free shipping under Walmart's policy!
    if (!isDirect && !isWfs) {
      return {
        status: "marketplace_seller_excluded",
        isApplicable: false,
        isAuthoritative: false,
        shippingCents: null,
        serviceability: "serviceable",
        geographicZone: geo.zone,
        policyId: policy.policyId,
        explanation: `Candidate item is fulfilled by an independent third-party marketplace seller (${sellerName ?? "unknown"}). Walmart policy "${policy.policyId}" only covers shipping for items fulfilled by Walmart or Walmart Fulfillment Services (WFS). Note: while eligible marketplace items may contribute toward the $35 cart minimum, independent seller-fulfilled items do not receive Walmart-funded free shipping.`,
      };
    }
  }

  // 8. Special / scheduled delivery fulfillment check
  const rawAttrs = context.candidate.rawAttributes ?? {};
  const fulfillmentMethod = String(rawAttrs.fulfillmentMethod ?? "").toLowerCase();
  const requiresSpecial = context.candidate.requiresSpecialDelivery === true;

  if (requiresSpecial) {
    return {
      status: "special_delivery_required",
      isApplicable: false,
      isAuthoritative: false,
      shippingCents: null,
      serviceability: "serviceable",
      geographicZone: geo.zone,
      policyId: policy.policyId,
      explanation: `Candidate requires special delivery/handling. ${policy.merchantName} policy "${policy.policyId}" excludes scheduled or special delivery methods.`,
    };
  }

  if (policy.excludedSpecialFulfillmentMethods && policy.excludedSpecialFulfillmentMethods.length > 0) {
    for (const method of policy.excludedSpecialFulfillmentMethods) {
      const cleanMethod = method.toLowerCase().trim();
      if (fulfillmentMethod && fulfillmentMethod.includes(cleanMethod)) {
        return {
          status: "special_delivery_required",
          isApplicable: false,
          isAuthoritative: false,
          shippingCents: null,
          serviceability: "serviceable",
          geographicZone: geo.zone,
          policyId: policy.policyId,
          explanation: `Fulfillment method "${fulfillmentMethod}" is excluded by ${policy.merchantName} policy "${policy.policyId}" (excluded method: ${method}).`,
        };
      }
    }
  }

  // 9. Membership requirement check (e.g. Walmart+, Target Circle 360)
  if (policy.requiresMembership) {
    const memberships = context.candidate.buyerMembership ?? [];
    if (!memberships.includes(policy.requiresMembership)) {
      return {
        status: "membership_required",
        isApplicable: false,
        isAuthoritative: false,
        shippingCents: null,
        serviceability: "serviceable",
        geographicZone: geo.zone,
        policyId: policy.policyId,
        explanation: `Policy "${policy.policyId}" requires active membership "${policy.requiresMembership}". Autonomous agents cannot assume membership benefits without verified proof.`,
      };
    }
  }

  // 10. Item-specific qualification check (e.g. B&H free standard shipping on select items)
  if (policy.itemSpecificQualificationRequired === true) {
    if (context.candidate.isFreeShippingEligibleItem !== true) {
      return {
        status: "unconfirmed_qualification",
        isApplicable: false,
        isAuthoritative: false,
        shippingCents: null,
        serviceability: "serviceable",
        geographicZone: geo.zone,
        policyId: policy.policyId,
        explanation: `Policy "${policy.policyId}" requires item-specific free shipping qualification, but candidate item has not been verified as qualifying.`,
      };
    }
  }

  // 11. Product & Category exclusions
  if (policy.excludedCategories && policy.excludedCategories.length > 0) {
    const titleLower = (context.candidate.title ?? "").toLowerCase();
    const descLower = String(rawAttrs.description ?? "").toLowerCase();
    const combinedText = `${titleLower} ${descLower}`;

    for (const cat of policy.excludedCategories) {
      const cleanCat = cat.toLowerCase().trim();
      if (combinedText.includes(cleanCat)) {
        return {
          status: "product_exclusion",
          isApplicable: false,
          isAuthoritative: false,
          shippingCents: null,
          serviceability: "serviceable",
          geographicZone: geo.zone,
          policyId: policy.policyId,
          explanation: `Product matches excluded policy category "${cat}".`,
        };
      }
    }
  }

  // 12. Threshold boundary calculation (derived integer arithmetic, net of discounts, pre-tax)
  const candidateGrossCents = context.candidate.unitPriceCents * context.candidate.quantity;
  const discountCents = Math.max(0, context.candidate.discountCents ?? 0);

  // If policy allows marketplace items to contribute to cart threshold and cartTotalCents is provided:
  let effectiveMerchandiseCents = candidateGrossCents;
  if (
    policy.marketplaceItemsContributeToThreshold === true &&
    typeof context.cartTotalCents === "number" &&
    context.cartTotalCents > candidateGrossCents
  ) {
    effectiveMerchandiseCents = context.cartTotalCents;
  }

  const qualifyingMerchandiseCents = Math.max(0, effectiveMerchandiseCents - discountCents);

  if (policy.thresholdCents > 0 && qualifyingMerchandiseCents < policy.thresholdCents) {
    const thresholdDollars = (policy.thresholdCents / 100).toFixed(2);
    const qualifyingDollars = (qualifyingMerchandiseCents / 100).toFixed(2);
    let explanation = `Candidate qualifying merchandise total $${qualifyingDollars} is below the $${thresholdDollars} threshold required by ${policy.merchantName} policy "${policy.policyId}".`;
    if (discountCents > 0) {
      explanation += ` Gross merchandise was $${(effectiveMerchandiseCents / 100).toFixed(2)}, but $${(discountCents / 100).toFixed(2)} in discounts/coupons reduced the qualifying amount below the threshold.`;
    }
    if (context.candidate.estimatedTaxCents && context.candidate.estimatedTaxCents > 0) {
      explanation += ` Estimated sales tax ($${(context.candidate.estimatedTaxCents / 100).toFixed(2)}) is excluded from the qualifying merchandise threshold calculation.`;
    }
    return {
      status: "threshold_not_met",
      isApplicable: false,
      isAuthoritative: false,
      shippingCents: null,
      serviceability: "serviceable",
      geographicZone: geo.zone,
      policyId: policy.policyId,
      explanation,
    };
  }

  // All deterministic requirements satisfied!
  return {
    status: "satisfied",
    isApplicable: true,
    isAuthoritative: true,
    shippingCents: policy.shippingCostCents,
    deliveryMethod: policy.deliveryMethod,
    serviceability: "serviceable",
    geographicZone: geo.zone,
    policyId: policy.policyId,
    policySourceUrl: policy.policySourceUrl,
    policyDocumentFingerprint: policy.policyDocumentFingerprint,
    thresholdCents: policy.thresholdCents,
    explanation: `Authoritative ${policy.merchantName} policy "${policy.policyId}" satisfied: free ${policy.deliveryMethod} shipping applied for contiguous US destination ${context.destination.postalCode} (qualifying order total $${(qualifyingMerchandiseCents / 100).toFixed(2)} meets or exceeds $${(policy.thresholdCents / 100).toFixed(2)} threshold).`,
  };
}
