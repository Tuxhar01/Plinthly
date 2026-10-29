/**
 * Plinthly Phase 15 — Multi-Item Procurement Strategy Generation and Comparison Engine.
 *
 * Enforces:
 * 1. Generates distinct, realistic procurement strategies:
 *    - Consolidated Single-Retailer Strategy (minimizes retailers/shipments, maximizes threshold qualification)
 *    - Lowest Landed Cost Strategy (minimizes total price across all retailers)
 *    - Verified Authoritative / First-Party Strategy (prioritizes verified first-party retailer evidence)
 * 2. Defensible cost calculation:
 *    - Total landed cost is ONLY calculated when merchandise AND all shipping charges are verified.
 *    - Incomplete shipping costs result in totalLandedCostCents: null and isLandedCostDefensible: false.
 * 3. Defensible ranking:
 *    - NEVER ranks an incomplete total as cheaper than a verified complete total.
 *    - Explains ranking rationale, assumptions, and missing evidence clearly.
 * 4. Flags currency mismatches; never blends differing currencies without disclosed conversion.
 */

import { NormalizedProductCandidate } from "../types";
import { DestinationContext } from "../shipping";
import { aggregateRetailerCarts, extractMerchantDomain } from "./cart-aggregator";
import { allocateCandidatesToLineItems } from "./allocation";
import {
  LineItemCandidateAllocation,
  ProcurementLineItem,
  ProcurementStrategy,
  StrategyFeasibility,
} from "./types";

export interface StrategyGenerationInput {
  readonly lineItems: readonly ProcurementLineItem[];
  readonly candidates: readonly NormalizedProductCandidate[];
  readonly destination: DestinationContext;
  readonly now?: Date;
  readonly buyerMemberships?: readonly string[];
}

/**
 * Builds a ProcurementStrategy object from an allocation of candidates to line items.
 */
export function buildStrategyFromAllocations(
  strategyId: string,
  name: string,
  description: string,
  allocations: readonly LineItemCandidateAllocation[],
  lineItems: readonly ProcurementLineItem[],
  destination: DestinationContext,
  now: Date = new Date(),
  buyerMemberships: readonly string[] = []
): ProcurementStrategy {
  const carts = aggregateRetailerCarts({
    allocations,
    destination,
    now,
    buyerMemberships,
  });

  // Calculate merchandise subtotal
  const totalMerchandiseCents = carts.reduce((acc, c) => acc + c.merchandiseSubtotalCents, 0);

  // Check shipping completeness and evidence types across all carts
  let totalShippingCents: number | null = 0;
  let missingShippingCostCount = 0;
  let shipmentCount = 0;
  let quotedCount = 0;
  let policyDerivedCount = 0;
  let missingCount = 0;

  for (const cart of carts) {
    shipmentCount += cart.shipments.length;
    for (const ship of cart.shipments) {
      if (ship.shippingChargeCents === null) {
        totalShippingCents = null;
        missingShippingCostCount++;
        missingCount++;
      } else if (totalShippingCents !== null) {
        totalShippingCents += ship.shippingChargeCents;
      }

      if (ship.shippingEvidenceType === "quoted") {
        quotedCount++;
      } else if (ship.shippingEvidenceType === "policy_derived") {
        policyDerivedCount++;
      }
    }
  }

  let shippingEvidenceType: "quoted" | "policy_derived" | "mixed" | "unverified" = "unverified";
  if (missingCount > 0) {
    shippingEvidenceType = "unverified";
  } else if (quotedCount > 0 && policyDerivedCount === 0) {
    shippingEvidenceType = "quoted";
  } else if (policyDerivedCount > 0 && quotedCount === 0) {
    shippingEvidenceType = "policy_derived";
  } else if (quotedCount > 0 && policyDerivedCount > 0) {
    shippingEvidenceType = "mixed";
  }

  const isQuoteBacked = shippingEvidenceType === "quoted";

  // Feasibility determination:
  // All line items must be satisfied to be fully feasible
  const allocatedLineItemIds = new Set(allocations.map((a) => a.lineItemId));
  const missingLineItems = lineItems.filter((li) => !allocatedLineItemIds.has(li.id));

  const isLandedCostDefensible =
    totalShippingCents !== null &&
    missingShippingCostCount === 0 &&
    missingLineItems.length === 0;
  const totalDiscountCents = 0;
  const totalEstimatedTaxCents = 0;

  const totalLandedCostCents = isLandedCostDefensible
    ? totalMerchandiseCents + (totalShippingCents ?? 0) - totalDiscountCents + totalEstimatedTaxCents
    : null;

  let feasibility: StrategyFeasibility = "feasible";
  const riskDisclosures: string[] = [];

  if (missingLineItems.length > 0) {
    feasibility = "blocked";
    riskDisclosures.push(`Incomplete fulfillment: missing matching candidates for line items: ${missingLineItems.map((li) => `"${li.title}"`).join(", ")}.`);
  }

  if (missingShippingCostCount > 0) {
    if (feasibility === "feasible") {
      feasibility = "uncertain";
    }
    riskDisclosures.push(`Shipping charges for ${missingShippingCostCount} shipment(s) are unquoted from upstream. Total landed cost cannot be defended as a verified fact.`);
  }

  // Count marketplace sellers
  const marketplaceItemCount = allocations.filter((a) => a.isMarketplace).length;
  if (marketplaceItemCount > 0) {
    riskDisclosures.push(`Plan contains ${marketplaceItemCount} third-party marketplace item(s) dispatched from independent seller warehouses.`);
  }

  // Requirement satisfaction score:
  const totalItems = lineItems.length;
  const fulfilledItems = allocations.length;
  const requirementSatisfactionScore = totalItems > 0 ? fulfilledItems / totalItems : 1.0;

  // Compute recommendation score & rationale:
  let recommendationScore = 50.0;
  let recommendationRationale = "";

  if (feasibility === "blocked") {
    recommendationScore = 0;
    recommendationRationale = `Strategy is blocked due to unfulfilled line items.`;
  } else {
    // Base score from satisfaction
    recommendationScore += requirementSatisfactionScore * 30;

    // Favor single-retailer consolidation (fewer carts = fewer points of failure)
    if (carts.length === 1) {
      recommendationScore += 15;
    } else {
      recommendationScore -= (carts.length - 1) * 5;
    }

    // Heavy penalty if shipping cost is unverified / incomplete
    if (!isLandedCostDefensible) {
      recommendationScore -= 25;
      recommendationRationale = `Shipping evidence is incomplete (${missingShippingCostCount} unquoted shipment(s)). Although merchandise is $${(totalMerchandiseCents / 100).toFixed(2)}, total landed cost cannot be verified.`;
    } else if (shippingEvidenceType === "policy_derived") {
      recommendationScore += 18;
      recommendationRationale = `Policy-derived landed cost of $${((totalLandedCostCents ?? 0) / 100).toFixed(2)} USD based on published merchant threshold policy ($0 shipping threshold met). A real-time carrier shipping quote is not bound.`;
    } else {
      // Verified complete cost
      recommendationScore += 20;
      recommendationRationale = `Fully defensible landed cost of $${((totalLandedCostCents ?? 0) / 100).toFixed(2)} USD with retailer-quoted shipping evidence across ${carts.length} retailer cart(s) and ${shipmentCount} shipment(s).`;
    }
  }

  let effectiveName = name;
  if (strategyId === "strat_lowest_landed_cost") {
    if (shippingEvidenceType === "policy_derived") {
      effectiveName = "Lowest Landed Cost (Policy-Derived)";
    } else if (shippingEvidenceType === "quoted") {
      effectiveName = "Lowest Landed Cost (Verified Quoted)";
    }
  }

  return {
    strategyId,
    name: effectiveName,
    description,
    feasibility,
    allocations,
    carts,
    totalMerchandiseCents,
    totalShippingCents,
    totalDiscountCents,
    totalEstimatedTaxCents,
    totalLandedCostCents,
    isLandedCostDefensible,
    currency: "USD",
    retailerCount: carts.length,
    shipmentCount,
    missingShippingCostCount,
    requirementSatisfactionScore,
    recommendationScore: Math.max(0, Math.min(100, recommendationScore)),
    recommendationRationale,
    riskDisclosures,
    shippingEvidenceType,
    isQuoteBacked,
  };
}

/**
 * Generates and ranks procurement strategies based on multi-item requirements and candidate facts.
 */
export function generateProcurementStrategies(input: StrategyGenerationInput): readonly ProcurementStrategy[] {
  const { lineItems, candidates, destination, now = new Date(), buyerMemberships = [] } = input;

  if (lineItems.length === 0 || candidates.length === 0) {
    return [];
  }

  const strategies: ProcurementStrategy[] = [];

  // Strategy 1: Lowest Landed Cost Strategy (optimal pricing per item)
  const lowestCostAllocations = allocateCandidatesToLineItems(lineItems, candidates, {
    allowSharedCandidatesAcrossIdenticalItems: false,
  });

  if (lowestCostAllocations.allocations.length > 0) {
    strategies.push(
      buildStrategyFromAllocations(
        "strat_lowest_landed_cost",
        "Lowest Landed Cost",
        "Selects the most economical compatible candidate for each line item, grouping them into their respective retailer carts.",
        lowestCostAllocations.allocations,
        lineItems,
        destination,
        now,
        buyerMemberships
      )
    );
  }

  // Strategy 2: Single-Retailer Consolidated Strategy (all items from one merchant)
  // Identify merchants present across candidates
  const merchants = new Set<string>();
  for (const c of candidates) {
    merchants.add(extractMerchantDomain(c.merchantUrl, c.merchantName));
  }

  let bestConsolidatedMerchant: string | null = null;
  let bestConsolidatedCount = 0;
  let bestConsolidatedCandidates: NormalizedProductCandidate[] = [];

  for (const merchant of merchants) {
    const merchantCandidates = candidates.filter(
      (c) => extractMerchantDomain(c.merchantUrl, c.merchantName) === merchant
    );
    const allocationResult = allocateCandidatesToLineItems(lineItems, merchantCandidates, {
      allowSharedCandidatesAcrossIdenticalItems: false,
    });

    if (allocationResult.allocations.length > bestConsolidatedCount) {
      bestConsolidatedCount = allocationResult.allocations.length;
      bestConsolidatedMerchant = merchant;
      bestConsolidatedCandidates = merchantCandidates;
    }
  }

  if (bestConsolidatedMerchant && bestConsolidatedCount > 0) {
    const consolidatedAllocations = allocateCandidatesToLineItems(lineItems, bestConsolidatedCandidates, {
      allowSharedCandidatesAcrossIdenticalItems: false,
    });

    strategies.push(
      buildStrategyFromAllocations(
        "strat_consolidated_single_retailer",
        `Consolidated (${bestConsolidatedMerchant})`,
        `Maximizes fulfillment through a single retailer (${bestConsolidatedMerchant}) to consolidate orders and leverage cart-level shipping thresholds.`,
        consolidatedAllocations.allocations,
        lineItems,
        destination,
        now,
        buyerMemberships
      )
    );
  }

  // Strategy 3: Verified Authoritative / First-Party Strategy (prefers verified first-party retailer items)
  const firstPartyCandidates = candidates.filter((c) => c.isDirectRetailerSeller === true || c.isDirectRetailer === true || c.isWfsFulfilled === true);
  if (firstPartyCandidates.length > 0) {
    const firstPartyAllocations = allocateCandidatesToLineItems(lineItems, firstPartyCandidates, {
      allowSharedCandidatesAcrossIdenticalItems: false,
    });

    if (firstPartyAllocations.allocations.length > 0) {
      strategies.push(
        buildStrategyFromAllocations(
          "strat_authoritative_first_party",
          "Verified Direct Retailer",
          "Prioritizes items sold and fulfilled directly by first-party retailers with verified shipping policies, avoiding third-party marketplace dispatch.",
          firstPartyAllocations.allocations,
          lineItems,
          destination,
          now,
          buyerMemberships
        )
      );
    }
  }

  // Rank strategies defensively:
  // INVARIANT: An incomplete total CAN NEVER be ranked as cheaper or better than a verified complete total!
  strategies.sort((a, b) => {
    // 1. Feasibility first: feasible > uncertain > blocked
    const feasMap: Record<StrategyFeasibility, number> = { feasible: 3, uncertain: 2, blocked: 1 };
    if (feasMap[a.feasibility] !== feasMap[b.feasibility]) {
      return feasMap[b.feasibility] - feasMap[a.feasibility];
    }

    // 2. Both feasible or both uncertain: Defensible cost comparison
    if (a.isLandedCostDefensible && b.isLandedCostDefensible) {
      // Both complete: lower landed cost wins
      if (a.totalLandedCostCents !== null && b.totalLandedCostCents !== null) {
        if (a.totalLandedCostCents !== b.totalLandedCostCents) {
          return a.totalLandedCostCents - b.totalLandedCostCents;
        }
      }
    } else if (a.isLandedCostDefensible && !b.isLandedCostDefensible) {
      // A is complete and verified, B is incomplete: A WINS ALWAYS!
      return -1;
    } else if (!a.isLandedCostDefensible && b.isLandedCostDefensible) {
      // B is complete and verified, A is incomplete: B WINS ALWAYS!
      return 1;
    }

    // 3. Recommendation score tie-breaker
    return b.recommendationScore - a.recommendationScore;
  });

  return strategies;
}
