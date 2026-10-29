/**
 * Plinthly Phase 15 — Retailer Cart Aggregation and Policy Threshold Engine.
 *
 * Enforces:
 * 1. Groups candidates by normalized merchant domain into separate RetailerCarts.
 * 2. Evaluates published retailer shipping policies from the MerchantPolicyRegistry:
 *    - Best Buy ($35 threshold, excludes marketplace sellers, major appliances, special delivery)
 *    - Walmart ($35 threshold, marketplace items contribute to minimum, but only Walmart/WFS fulfilled items receive retailer-funded shipping)
 *    - Target ($35 threshold pre-tax/post-discounts, excludes Target Plus marketplace items)
 *    - B&H ($0 standard / $49 expedited)
 * 3. Keeps strictly separate:
 *    - Items contributing to free-shipping threshold
 *    - Items individually eligible for retailer-funded free shipping
 *    - Third-party marketplace items (separate shipping fees & shipments)
 *    - Membership benefits (never assumed without explicit proof)
 * 4. Aggregates physical shipments using planCartShipments.
 * 5. Flags incomplete or missing shipping evidence; never coerces missing to $0.
 */

import { DestinationContext } from "../shipping";
import { getMerchantPolicyRegistry } from "../merchant-policy-registry";
import { normalizeMerchantAlias } from "../normalize";
import { planCartShipments } from "./split-shipment";
import {
  CartItem,
  CartThresholdEvaluation,
  LineItemCandidateAllocation,
  RetailerCart,
} from "./types";

export interface AggregateRetailerCartsInput {
  readonly allocations: readonly LineItemCandidateAllocation[];
  readonly destination: DestinationContext;
  readonly now?: Date;
  readonly buyerMemberships?: readonly string[];
}

/**
 * Normalizes retailer domain from merchant URL or merchant name.
 */
export function extractMerchantDomain(merchantUrl?: string, merchantName?: string): string {
  if (merchantUrl) {
    try {
      const url = new URL(merchantUrl);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host.length > 0) return host;
    } catch {
      // Fall through to name alias
    }
  }

  const alias = normalizeMerchantAlias(merchantName ?? "");
  switch (alias) {
    case "walmart":
      return "walmart.com";
    case "target":
      return "target.com";
    case "bestbuy":
      return "bestbuy.com";
    case "bhphoto":
      return "bhphotovideo.com";
    case "newegg":
      return "newegg.com";
    case "amazon":
      return "amazon.com";
    default:
      return `${alias.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`;
  }
}

/**
 * Aggregates candidate allocations into retailer carts, evaluating merchant policies,
 * threshold qualification, marketplace eligibility, and shipment dispatch.
 */
export function aggregateRetailerCarts(input: AggregateRetailerCartsInput): readonly RetailerCart[] {
  const { allocations, destination } = input;
  const registry = getMerchantPolicyRegistry();

  // 1. Group allocations by merchant domain
  const domainGroups = new Map<string, { merchantName: string; allocations: LineItemCandidateAllocation[] }>();

  for (const alloc of allocations) {
    const domain = extractMerchantDomain(alloc.merchantUrl, alloc.merchantName);
    const existing = domainGroups.get(domain);
    if (existing) {
      existing.allocations.push(alloc);
    } else {
      domainGroups.set(domain, { merchantName: alloc.merchantName, allocations: [alloc] });
    }
  }

  const carts: RetailerCart[] = [];

  for (const [domain, group] of domainGroups) {
    // Lookup authoritative published merchant policy
    const policy = registry.getPolicyForDomain(domain);

    // 2. Classify each item in the cart:
    // - contributesToCartThreshold
    // - isIndividuallyEligibleForFreeShipping
    // - itemShippingCents
    const cartItems: CartItem[] = [];

    for (const alloc of group.allocations) {
      const lineItemTotalCents = alloc.unitPriceCents * alloc.quantity;
      let contributesToCartThreshold = false;
      let isIndividuallyEligibleForFreeShipping = false;

      // Extract raw shipping cost if available in attributes
      let itemShippingCents: number | null = null;
      if (typeof alloc.rawAttributes?.shippingCents === "number") {
        itemShippingCents = alloc.rawAttributes.shippingCents;
      } else if (typeof alloc.rawAttributes?.shippingCostCents === "number") {
        itemShippingCents = alloc.rawAttributes.shippingCostCents;
      }

      const isMarketplace = alloc.isMarketplace === true;
      const isDirectRetailer = alloc.isDirectRetailerSeller === true;
      const isWfsFulfilled = alloc.isWfsFulfilled === true;
      const requiresSpecialDelivery = alloc.requiresSpecialDelivery === true ||
        alloc.fulfillmentMethod === "freight" ||
        alloc.fulfillmentMethod === "scheduled_delivery";

      if (policy) {
        // Evaluate threshold contribution:
        if (requiresSpecialDelivery) {
          contributesToCartThreshold = false;
        } else if (policy.requiresDirectRetailerSeller && isMarketplace) {
          // Target, Best Buy: 3rd-party marketplace items DO NOT contribute to threshold
          contributesToCartThreshold = false;
        } else if (policy.marketplaceItemsContributeToThreshold && isMarketplace) {
          // Walmart: Eligible marketplace items contribute to the $35 minimum
          contributesToCartThreshold = true;
        } else if (isDirectRetailer || isWfsFulfilled) {
          contributesToCartThreshold = true;
        }

        // Evaluate free-shipping eligibility:
        if (requiresSpecialDelivery) {
          isIndividuallyEligibleForFreeShipping = false;
        } else if (policy.requiresDirectRetailerOrWfsFulfillment) {
          // Walmart: Only items fulfilled by Walmart or WFS receive retailer-funded free shipping
          isIndividuallyEligibleForFreeShipping = isDirectRetailer || isWfsFulfilled;
        } else if (policy.requiresDirectRetailerSeller) {
          // Target, Best Buy: Only direct retailer items receive retailer-funded free shipping
          isIndividuallyEligibleForFreeShipping = isDirectRetailer;
        } else {
          isIndividuallyEligibleForFreeShipping = !isMarketplace;
        }
      } else {
        // No authoritative policy in registry
        contributesToCartThreshold = false;
        isIndividuallyEligibleForFreeShipping = false;
      }

      cartItems.push({
        lineItemId: alloc.lineItemId,
        candidateId: alloc.candidateId,
        externalId: alloc.externalId,
        title: alloc.title,
        unitPriceCents: alloc.unitPriceCents,
        quantity: alloc.quantity,
        lineItemTotalCents,
        currency: alloc.currency,
        sellerName: alloc.sellerName,
        isMarketplace,
        isDirectRetailerSeller: isDirectRetailer,
        isWfsFulfilled,
        fulfillmentMethod: alloc.fulfillmentMethod,
        requiresSpecialDelivery,
        contributesToCartThreshold,
        isIndividuallyEligibleForFreeShipping,
        itemShippingCents,
      });
    }

    // 3. Compute cart subtotals
    const merchandiseSubtotalCents = cartItems.reduce(
      (sum, item) => sum + item.lineItemTotalCents,
      0
    );

    const qualifyingMerchandiseSubtotalCents = cartItems
      .filter((item) => item.contributesToCartThreshold)
      .reduce((sum, item) => sum + item.lineItemTotalCents, 0);

    // 4. Policy evaluation for cart threshold
    let thresholdEvaluation: CartThresholdEvaluation | null = null;
    let cartLevelFreeShippingEarned = false;

    if (policy) {
      const discountCents = 0; // If explicit discounts exist, subtract before checking threshold
      const preTaxQualifyingCents = qualifyingMerchandiseSubtotalCents - discountCents;
      const thresholdSatisfied = preTaxQualifyingCents >= policy.thresholdCents;
      const remainingToThresholdCents = Math.max(0, policy.thresholdCents - preTaxQualifyingCents);

      cartLevelFreeShippingEarned = thresholdSatisfied;

      let explanation = "";
      if (thresholdSatisfied) {
        explanation = `Cart qualified for ${policy.merchantName} free ${policy.deliveryMethod} shipping ($${(qualifyingMerchandiseSubtotalCents / 100).toFixed(2)} qualifying merchandise >= $${(policy.thresholdCents / 100).toFixed(2)} threshold).`;
      } else {
        explanation = `Threshold not met: $${(qualifyingMerchandiseSubtotalCents / 100).toFixed(2)} of qualifying merchandise does not reach the $${(policy.thresholdCents / 100).toFixed(2)} minimum ($${(remainingToThresholdCents / 100).toFixed(2)} more needed).`;
      }

      thresholdEvaluation = {
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        policyDocumentFingerprint: policy.policyDocumentFingerprint,
        thresholdCents: policy.thresholdCents,
        qualifyingMerchandiseSubtotalCents,
        thresholdSatisfied,
        remainingToThresholdCents,
        discountCents,
        appliesPreTax: policy.requiresPreTaxMerchandiseThreshold === true,
        explanation,
      };
    }

    // 5. Plan physical shipments for this cart
    const shipments = planCartShipments({
      merchantDomain: domain,
      merchantName: group.merchantName,
      items: cartItems,
      cartLevelFreeShippingEarned,
      destinationPostalCode: destination.postalCode,
    });

    // 6. Calculate total shipping across shipments
    let totalShippingCents: number | null = 0;
    let isShippingComplete = true;

    for (const ship of shipments) {
      if (ship.shippingChargeCents === null) {
        totalShippingCents = null;
        isShippingComplete = false;
        break;
      }
      totalShippingCents += ship.shippingChargeCents;
    }

    carts.push({
      merchantDomain: domain,
      merchantName: group.merchantName,
      items: cartItems,
      totalItemCount: cartItems.reduce((acc, it) => acc + it.quantity, 0),
      merchandiseSubtotalCents,
      thresholdEvaluation,
      cartLevelShippingCents: cartLevelFreeShippingEarned ? 0 : null,
      itemLevelShippingTotalCents: null,
      totalShippingCents,
      isShippingComplete,
      currency: "USD",
      shipments,
    });
  }

  return carts;
}
