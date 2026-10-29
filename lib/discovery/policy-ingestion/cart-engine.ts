/**
 * Plinthly Phase 13C — Deterministic Multi-Item Cart Shipping Engine.
 *
 * Enforces the strict boundary between per-product evaluation and multi-item cart qualification:
 * 1. A single product evaluation cannot assume the contents of a multi-item cart.
 * 2. Multi-item cart evaluation models qualifying items, fulfillment boundaries (direct retailer vs WFS vs independent 3rd-party marketplace),
 *    pre-tax discounts, tax exclusion, and seller-specific shipping independently.
 * 3. Pre-tax merchandise threshold: cart-level discounts are subtracted pre-tax from qualifying subtotal before threshold check.
 * 4. Taxes never count toward free shipping thresholds.
 * 5. Independent 3rd-party marketplace items do not receive retailer-funded free shipping even if they contribute to cart threshold.
 */

import {
  checkGeographicEligibility,
  resolveGeographicZone,
} from "../geographic-zones";
import { MerchantPolicyRegistry } from "../merchant-policy-registry";
import { normalizeMerchantAlias } from "../normalize";
import {
  CartItemContext,
  CartItemShippingResult,
  CartShippingContext,
  CartShippingEvaluationResult,
} from "./types";

export class CartShippingEngine {
  constructor(private readonly registry: MerchantPolicyRegistry) {}

  /**
   * Evaluates shipping across an entire cart of items against authoritative merchant policies.
   */
  evaluateCart(context: CartShippingContext): CartShippingEvaluationResult {
    if (!context.items || context.items.length === 0) {
      return {
        status: "blocked",
        allItemsQualified: false,
        qualifyingMerchandiseCents: 0,
        thresholdCents: 0,
        totalShippingCents: 0,
        itemResults: [],
        explanation: "Cart contains no items to evaluate.",
      };
    }

    // Resolve geographic zone
    const geo = resolveGeographicZone(context.destination.postalCode);
    const zone = geo.zone;

    // Get policies for merchant
    const policies = this.registry.getPoliciesForMerchant(context.merchantName);
    if (policies.length === 0) {
      return {
        status: "blocked",
        allItemsQualified: false,
        qualifyingMerchandiseCents: 0,
        thresholdCents: 0,
        totalShippingCents: 0,
        itemResults: context.items.map((it) => ({
          itemId: it.id,
          sellerFulfillmentType: this.determineFulfillmentType(it, context.merchantName),
          eligibleForMerchantFreeShipping: false,
          shippingCents: null,
          blockerReason: "merchant_mismatch",
        })),
        explanation: `No authoritative shipping policies registered for merchant "${context.merchantName}".`,
      };
    }

    // Select the applicable policy for preferred delivery method (defaults to standard_ground)
    const targetMethod = context.destination.deliveryMethodPreference ?? "standard_ground";
    const policy =
      policies.find((p) => p.deliveryMethod === targetMethod) ?? policies[0];

    // Check geographic eligibility
    const geoCheck = checkGeographicEligibility({
      destinationPostalCode: context.destination.postalCode,
      allowedZones: policy.allowedZones,
      excludedZones: policy.excludedZones,
      excludedPostalCodes: policy.excludedPostalCodes,
    });

    if (!geoCheck.eligible) {
      return {
        status: "blocked",
        allItemsQualified: false,
        qualifyingMerchandiseCents: 0,
        thresholdCents: policy.thresholdCents,
        totalShippingCents: 0,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        itemResults: context.items.map((it) => ({
          itemId: it.id,
          sellerFulfillmentType: this.determineFulfillmentType(it, context.merchantName),
          eligibleForMerchantFreeShipping: false,
          shippingCents: null,
          blockerReason: "geographic_exclusion",
        })),
        explanation: `Destination zone "${zone}" is not eligible for ${policy.merchantName} policy "${policy.policyId}" (${geoCheck.reason}).`,
      };
    }

    // Check membership requirement
    if (policy.requiresMembership) {
      const hasMembership =
        context.buyerMembership &&
        context.buyerMembership.includes(policy.requiresMembership);
      if (!hasMembership) {
        return {
          status: "blocked",
          allItemsQualified: false,
          qualifyingMerchandiseCents: 0,
          thresholdCents: policy.thresholdCents,
          totalShippingCents: 0,
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          itemResults: context.items.map((it) => ({
            itemId: it.id,
            sellerFulfillmentType: this.determineFulfillmentType(it, context.merchantName),
            eligibleForMerchantFreeShipping: false,
            shippingCents: null,
            blockerReason: "membership_required",
          })),
          explanation: `Policy "${policy.policyId}" requires verified membership "${policy.requiresMembership}".`,
        };
      }
    }

    // Classify each item and compute threshold contribution
    let contributingMerchandiseCents = 0;
    const itemDiagnostics: Array<{
      item: CartItemContext;
      fulfillmentType: "direct_retailer" | "wfs" | "independent_marketplace";
      qualifiesForRetailerFreeShipping: boolean;
      contributesToThreshold: boolean;
      blockerReason?: string;
    }> = [];

    for (const item of context.items) {
      const fulfillmentType = this.determineFulfillmentType(item, context.merchantName);

      // Check special delivery / category exclusions
      if (item.requiresSpecialDelivery) {
        itemDiagnostics.push({
          item,
          fulfillmentType,
          qualifiesForRetailerFreeShipping: false,
          contributesToThreshold: false,
          blockerReason: "special_delivery_required",
        });
        continue;
      }

      if (
        item.category &&
        policy.excludedCategories?.some(
          (ex) => ex.toLowerCase() === item.category!.toLowerCase()
        )
      ) {
        itemDiagnostics.push({
          item,
          fulfillmentType,
          qualifiesForRetailerFreeShipping: false,
          contributesToThreshold: false,
          blockerReason: "product_exclusion",
        });
        continue;
      }

      // Check item-specific qualification requirement (e.g. B&H free standard)
      if (policy.itemSpecificQualificationRequired && !item.isFreeShippingEligibleItem) {
        itemDiagnostics.push({
          item,
          fulfillmentType,
          qualifiesForRetailerFreeShipping: false,
          contributesToThreshold: false,
          blockerReason: "unconfirmed_qualification",
        });
        continue;
      }

      // Evaluate fulfillment boundaries
      if (fulfillmentType === "direct_retailer") {
        const itemSubtotal = item.unitPriceCents * item.quantity;
        contributingMerchandiseCents += itemSubtotal;
        itemDiagnostics.push({
          item,
          fulfillmentType,
          qualifiesForRetailerFreeShipping: true,
          contributesToThreshold: true,
        });
      } else if (fulfillmentType === "wfs") {
        if (policy.requiresDirectRetailerOrWfsFulfillment) {
          const itemSubtotal = item.unitPriceCents * item.quantity;
          contributingMerchandiseCents += itemSubtotal;
          itemDiagnostics.push({
            item,
            fulfillmentType,
            qualifiesForRetailerFreeShipping: true,
            contributesToThreshold: true,
          });
        } else {
          itemDiagnostics.push({
            item,
            fulfillmentType,
            qualifiesForRetailerFreeShipping: false,
            contributesToThreshold: false,
            blockerReason: "marketplace_seller_excluded",
          });
        }
      } else {
        // Independent Marketplace Seller
        if (policy.marketplaceItemsContributeToThreshold) {
          // Contributes to reaching cart threshold, but does NOT receive retailer-funded free shipping
          const itemSubtotal = item.unitPriceCents * item.quantity;
          contributingMerchandiseCents += itemSubtotal;
          itemDiagnostics.push({
            item,
            fulfillmentType,
            qualifiesForRetailerFreeShipping: false,
            contributesToThreshold: true,
            blockerReason: "marketplace_seller_excluded",
          });
        } else {
          itemDiagnostics.push({
            item,
            fulfillmentType,
            qualifiesForRetailerFreeShipping: false,
            contributesToThreshold: false,
            blockerReason: "marketplace_seller_excluded",
          });
        }
      }
    }

    // Apply pre-tax cart discounts
    const discountsCents = context.cartLevelDiscountsCents ?? 0;
    const netQualifyingMerchandiseCents = Math.max(
      0,
      contributingMerchandiseCents - discountsCents
    );

    // Note: Estimated tax is strictly excluded from qualifying calculation
    const thresholdMet = netQualifyingMerchandiseCents >= policy.thresholdCents;

    // Generate per-item results
    const itemResults: CartItemShippingResult[] = [];
    let allItemsQualified = true;
    const totalShippingCents = 0;

    for (const diag of itemDiagnostics) {
      if (diag.qualifiesForRetailerFreeShipping && thresholdMet) {
        itemResults.push({
          itemId: diag.item.id,
          sellerFulfillmentType: diag.fulfillmentType,
          eligibleForMerchantFreeShipping: true,
          shippingCents: 0,
        });
      } else if (!thresholdMet && diag.qualifiesForRetailerFreeShipping) {
        allItemsQualified = false;
        itemResults.push({
          itemId: diag.item.id,
          sellerFulfillmentType: diag.fulfillmentType,
          eligibleForMerchantFreeShipping: false,
          shippingCents: null,
          blockerReason: "threshold_not_met",
        });
      } else {
        // Ineligible or independent marketplace seller
        allItemsQualified = false;
        itemResults.push({
          itemId: diag.item.id,
          sellerFulfillmentType: diag.fulfillmentType,
          eligibleForMerchantFreeShipping: false,
          shippingCents: null,
          blockerReason: diag.blockerReason ?? "marketplace_seller_excluded",
        });
      }
    }

    if (thresholdMet) {
      if (allItemsQualified) {
        return {
          status: "satisfied",
          allItemsQualified: true,
          qualifyingMerchandiseCents: netQualifyingMerchandiseCents,
          thresholdCents: policy.thresholdCents,
          totalShippingCents: 0,
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          itemResults,
          explanation: `All cart items qualify for free ${policy.deliveryMethod} shipping under ${policy.merchantName} policy "${policy.policyId}" (net qualifying subtotal $${(netQualifyingMerchandiseCents / 100).toFixed(2)} meets threshold $${(policy.thresholdCents / 100).toFixed(2)}).`,
        };
      }

      return {
        status: "partially_satisfied",
        allItemsQualified: false,
        qualifyingMerchandiseCents: netQualifyingMerchandiseCents,
        thresholdCents: policy.thresholdCents,
        totalShippingCents,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        itemResults,
        explanation: `Retailer direct/WFS items qualify for free shipping under ${policy.merchantName} policy "${policy.policyId}", but cart contains independent marketplace items that require seller-specific shipping quotes.`,
      };
    }

    return {
      status: "threshold_not_met",
      allItemsQualified: false,
      qualifyingMerchandiseCents: netQualifyingMerchandiseCents,
      thresholdCents: policy.thresholdCents,
      totalShippingCents: 0,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      itemResults,
      explanation: `Cart net qualifying merchandise total $${(netQualifyingMerchandiseCents / 100).toFixed(2)} is below the $${(policy.thresholdCents / 100).toFixed(2)} threshold required by ${policy.merchantName} policy "${policy.policyId}" (pre-tax merchandise: $${(contributingMerchandiseCents / 100).toFixed(2)}, pre-tax discounts: -$${(discountsCents / 100).toFixed(2)}).`,
    };
  }

  private determineFulfillmentType(
    item: CartItemContext,
    merchantName: string
  ): "direct_retailer" | "wfs" | "independent_marketplace" {
    if (item.isWfsFulfilled) {
      return "wfs";
    }

    if (item.isDirectRetailerSeller === true) {
      return "direct_retailer";
    }

    if (item.isMarketplace === true) {
      return "independent_marketplace";
    }

    if (
      item.sellerName &&
      normalizeMerchantAlias(item.sellerName) === normalizeMerchantAlias(merchantName)
    ) {
      return "direct_retailer";
    }

    if (item.sellerName) {
      return "independent_marketplace";
    }

    // Default to direct retailer if no seller specified and not marked marketplace
    return "direct_retailer";
  }
}
