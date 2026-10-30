/**
 * Plinthly Phase 15 — Multi-Item Procurement, Cart Aggregation, and Split-Shipment Planning Types.
 *
 * Provides strongly-typed data models for:
 * 1. Multi-item procurement line items and buyer requirements.
 * 2. Deterministic candidate allocation and duplicate prevention.
 * 3. Retailer cart aggregation, threshold qualification, and marketplace separation.
 * 4. Independent split-shipment planning (fulfillment methods, marketplace sellers, delivery dates).
 * 5. Purchase strategy generation, landed cost evaluation, and defensible ranking.
 * 6. Multi-item cryptographic approval snapshots and invalidation tracking.
 */

import { Currency } from "../../state/types";
import { DestinationContext } from "../shipping";
import { BuyerRequirementItem } from "../../workflow/types";

export type VerificationLevel = "strict" | "standard" | "flexible";

export type QuantityProvenanceSource = "explicit" | "inferred" | "unresolved" | "manual_override" | "legacy_direct";

/**
 * A discrete buyer requirement for a specific product and quantity in a multi-item purchase.
 */
export interface ProcurementLineItem {
  readonly id: string;
  readonly title: string;
  readonly quantity: number;
  readonly quantitySource?: QuantityProvenanceSource;
  readonly quantityConfirmed?: boolean;
  readonly originalInferredQuantity?: number | null;
  readonly confirmationToken?: string;
  readonly confirmedAt?: string | null;
  readonly confirmedBy?: string | null;
  readonly budgetCents?: number;
  readonly currency: Currency;
  readonly requirements: readonly (string | BuyerRequirementItem)[];
  readonly verificationLevel?: VerificationLevel;
  readonly selectedCandidateId?: string | null;
}

/**
 * Result of allocating candidates to line items.
 */
export interface LineItemCandidateAllocation {
  readonly lineItemId: string;
  readonly candidateId: string;
  readonly externalId: string;
  readonly title: string;
  readonly merchantName: string;
  readonly merchantUrl: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly currency: Currency;
  readonly availability: string;
  readonly sellerName: string;
  readonly isMarketplace: boolean;
  readonly isDirectRetailerSeller: boolean;
  readonly isWfsFulfilled?: boolean;
  readonly fulfillmentMethod: string;
  readonly requiresSpecialDelivery?: boolean;
  readonly rawAttributes?: Record<string, unknown>;
  readonly snapshotHash: string;
  readonly capturedAt: string;
}

/**
 * Represents an item inside a retailer cart.
 */
export interface CartItem {
  readonly lineItemId: string;
  readonly candidateId: string;
  readonly externalId: string;
  readonly title: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly lineItemTotalCents: number;
  readonly currency: Currency;
  readonly sellerName: string;
  readonly isMarketplace: boolean;
  readonly isDirectRetailerSeller: boolean;
  readonly isWfsFulfilled: boolean;
  readonly fulfillmentMethod: string;
  readonly requiresSpecialDelivery: boolean;
  /** Whether this item's merchandise subtotal contributes to the retailer free-shipping threshold */
  readonly contributesToCartThreshold: boolean;
  /** Whether this item individually receives retailer-funded free shipping once threshold is met */
  readonly isIndividuallyEligibleForFreeShipping: boolean;
  /** Specific item-level shipping fee if any, or null if unknown / covered by cart */
  readonly itemShippingCents: number | null;
}

/**
 * Policy threshold evaluation details for a retailer cart.
 */
export interface CartThresholdEvaluation {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyDocumentFingerprint: string;
  readonly thresholdCents: number;
  readonly qualifyingMerchandiseSubtotalCents: number;
  readonly thresholdSatisfied: boolean;
  readonly remainingToThresholdCents: number;
  readonly discountCents: number;
  readonly appliesPreTax: boolean;
  readonly explanation: string;
}

/**
 * Reason an item or group of items is partitioned into a separate shipment.
 */
export type SplitShipmentReason =
  | "single_consolidated_package"
  | "distinct_fulfillment_method"
  | "third_party_marketplace_seller"
  | "special_delivery_required"
  | "warehouse_partition"
  | "unverified_consolidation";

/**
 * Evidence classification of a shipment's shipping charge:
 * - "quoted": Retailer/carrier issued real-time rate bound to cart and destination.
 * - "policy_derived": Documented policy eligibility determination (threshold met, non-marketplace, standard zone).
 * - "missing": No shipping quote or policy applies.
 * - "estimated": Non-authoritative estimate.
 */
export type ShipmentShippingEvidenceType = "quoted" | "policy_derived" | "missing" | "estimated";

/**
 * An independent planned shipment representing physical dispatch of items.
 */
export interface PlannedShipment {
  readonly shipmentId: string;
  readonly merchantDomain: string;
  readonly sellerName: string;
  readonly fulfillmentMethod: string;
  readonly splitReason: SplitShipmentReason;
  readonly items: readonly {
    readonly lineItemId: string;
    readonly candidateId: string;
    readonly title: string;
    readonly quantity: number;
    readonly unitPriceCents: number;
  }[];
  readonly merchandiseSubtotalCents: number;
  readonly shippingChargeCents: number | null;
  readonly isShippingVerified: boolean;
  /** Whether the shipping cost is backed by an actual retailer quote (true) vs policy threshold determination (false) */
  readonly isQuoteBound: boolean;
  /** Exact evidence classification of this shipment's shipping cost */
  readonly shippingEvidenceType: ShipmentShippingEvidenceType;
  readonly deliveryDate: string | null; // Null unless backed by explicit verified timestamped evidence
  readonly carrier?: string | null;
  readonly trackingAvailable: boolean;
  readonly explanation: string;
}

/**
 * An aggregated cart of items from a single retailer domain.
 */
export interface RetailerCart {
  readonly merchantDomain: string;
  readonly merchantName: string;
  readonly items: readonly CartItem[];
  readonly totalItemCount: number;
  readonly merchandiseSubtotalCents: number;
  readonly thresholdEvaluation: CartThresholdEvaluation | null;
  readonly cartLevelShippingCents: number | null;
  readonly itemLevelShippingTotalCents: number | null;
  readonly totalShippingCents: number | null;
  readonly isShippingComplete: boolean;
  readonly currency: Currency;
  readonly shipments: readonly PlannedShipment[];
}

export type StrategyFeasibility = "feasible" | "uncertain" | "blocked";

/**
 * A candidate purchasing strategy for fulfilling multi-item buyer requirements.
 */
export interface ProcurementStrategy {
  readonly strategyId: string;
  readonly name: string;
  readonly description: string;
  readonly feasibility: StrategyFeasibility;
  readonly allocations: readonly LineItemCandidateAllocation[];
  readonly carts: readonly RetailerCart[];
  readonly totalMerchandiseCents: number;
  readonly totalShippingCents: number | null;
  readonly totalDiscountCents: number;
  readonly totalEstimatedTaxCents: number;
  /** Total landed cost in integer cents. Null if any required shipping charge or fee is unknown */
  readonly totalLandedCostCents: number | null;
  readonly isLandedCostDefensible: boolean;
  readonly currency: Currency;
  readonly retailerCount: number;
  readonly shipmentCount: number;
  readonly missingShippingCostCount: number;
  readonly requirementSatisfactionScore: number; // 0.0 - 1.0
  readonly recommendationScore: number;
  readonly recommendationRationale: string;
  readonly riskDisclosures: readonly string[];
  /** Overall shipping evidence classification for the strategy */
  readonly shippingEvidenceType: "quoted" | "policy_derived" | "mixed" | "unverified";
  /** Whether all shipping costs are backed by retailer-issued quotes (false if policy-derived or unquoted) */
  readonly isQuoteBacked: boolean;
}

/**
 * Multi-item approval snapshot cryptographically bound to the complete plan state.
 */
export interface MultiItemApprovalSnapshot {
  readonly snapshotId: string;
  readonly purchaseId: string;
  readonly strategyId: string;
  readonly multiItemSnapshotHash: string;
  readonly evidenceFingerprint: string;
  readonly totalLandedCostCents: number;
  readonly currency: Currency;
  readonly destination: DestinationContext;
  readonly lineItems: readonly {
    readonly id: string;
    readonly quantity: number;
    readonly candidateId: string;
    readonly candidateSnapshotHash: string;
  }[];
  readonly carts: readonly {
    readonly merchantDomain: string;
    readonly merchandiseSubtotalCents: number;
    readonly shippingCents: number;
    readonly policyVersion: string | null;
    readonly shipmentCount: number;
  }[];
  readonly approverUserId: string;
  readonly approvedAt: string;
  readonly invalidatedAt: string | null;
  readonly invalidationReason: string | null;
}

/**
 * Complete evaluation plan response for a multi-item procurement request.
 */
export interface MultiItemProcurementPlan {
  readonly purchaseId: string;
  readonly lineItems: readonly ProcurementLineItem[];
  readonly destination: DestinationContext;
  readonly strategies: readonly ProcurementStrategy[];
  readonly selectedStrategyId: string | null;
  readonly planFingerprint: string;
  readonly evaluatedAt: string;
}
