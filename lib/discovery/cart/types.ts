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
 * Verifiable evidence integrity classification:
 * - "verified_fact": Independently verified via cryptographic proof, authoritative quote, or statutory rule.
 * - "merchant_claim": Published merchant or seller policy assertion without carrier/first-party binding.
 * - "estimate": Heuristic or statistical approximation; never authoritative for buyer approval.
 * - "unknown": Missing or unresolved evidence.
 */
export type EvidenceTier = "verified_fact" | "merchant_claim" | "estimate" | "unknown";

/**
 * Deterministic product suitability classification for professional procurement requests:
 * - "compatible": Candidate meets verified modern baseline specifications for the stated purpose.
 * - "compatible_with_limitations": Candidate meets functional thresholds but carries disclosed limitations (e.g. 8GB RAM, refurbished).
 * - "insufficient_evidence": Provider data lacks critical technical evidence (missing CPU gen or RAM).
 * - "unsuitable": Product is objectively unsuitable (e.g. obsolete 10-year-old hardware, Windows 11 incompatible, <=4GB RAM).
 */
export type ProductSuitabilityTier =
  | "compatible"
  | "compatible_with_limitations"
  | "insufficient_evidence"
  | "unsuitable";

export interface ProductSuitabilityAssessment {
  readonly tier: ProductSuitabilityTier;
  readonly isProfessionalDevelopmentRequest: boolean;
  readonly isVintageOrBudgetExplicitlyRequested: boolean;
  readonly disclosures: readonly string[];
  readonly detectedSpecs: {
    readonly cpuGeneration?: string;
    readonly ramGb?: number;
    readonly storage?: string;
    readonly isRefurbishedOrUsed?: boolean;
    readonly isWindows11Capable?: boolean;
    readonly isObsoleteHardware?: boolean;
  };
  readonly reason: string;
}

/**
 * Orthogonal seller authenticity and warranty evidence claims.
 * Enforces that direct first-party retailer fulfillment does NOT independently imply
 * brand authorization, product authenticity verification, or manufacturer warranty coverage.
 */
export interface SellerAuthenticityEvidence {
  readonly sellerName: string;
  readonly isDirectRetailerSeller: boolean;
  readonly isMarketplace: boolean;
  readonly isManufacturerAuthorized: boolean;
  readonly authorizationEvidence?: string | null;
  readonly isProductAuthenticVerified: boolean;
  readonly authenticityEvidence?: string | null;
  readonly warrantyCoverage: "full_manufacturer" | "limited_merchant" | "unverified" | "none";
  readonly warrantyEvidence?: string | null;
  readonly evidenceTier: EvidenceTier;
}

/**
 * Destination-specific tax evidence.
 * Tracks statutory general sales-tax absence jurisdictions (e.g. OR, NH, DE), authoritative quotes,
 * or identifies missing municipal/resort tax quotes (e.g. Alaska local sales tax, Montana local resort sales tax).
 */
export interface TaxEvidence {
  readonly jurisdictionState?: string;
  readonly amountCents: number | null;
  readonly status: "quoted" | "statutory_absence" | "statutory_zero" | "unknown" | "missing" | "untrusted";
  readonly evidenceReference?: string | null;
  readonly explanation: string;
  readonly sourceIdentity?: string;
  readonly quotedAt?: string;
  readonly expiresAt?: string;
  readonly postalCode?: string;
  readonly currency?: string;
  readonly quoteSignature?: string | null;
  readonly quoteId?: string;
}

/**
 * Defensible landed cost breakdown isolating each cost component and its defensibility.
 */
export interface StrategyCostBreakdown {
  readonly merchandiseSubtotalCents: number;
  readonly shippingCents: number | null;
  readonly discountCents: number;
  readonly taxCents: number | null;
  readonly totalLandedCostCents: number | null;
  readonly currency: Currency;
  readonly isMerchandiseDefensible: boolean;
  readonly isShippingDefensible: boolean;
  readonly isTaxDefensible: boolean;
  readonly isDiscountDefensible: boolean;
  readonly isLandedCostDefensible: boolean;
  readonly missingComponents: readonly string[];
  readonly discountEvidenceReference?: string | null;
}

/**
 * Structured trade-off analysis across cost, quality, compatibility, availability, and delivery.
 * Every trade-off is bound to a verifiable evidence tier and reference.
 */
export interface StrategyTradeOffs {
  readonly cost: {
    readonly description: string;
    readonly evidenceTier: EvidenceTier;
    readonly evidenceReference?: string;
  };
  readonly quality: {
    readonly description: string;
    readonly evidenceTier: EvidenceTier;
    readonly evidenceReference?: string;
  };
  readonly compatibility: {
    readonly description: string;
    readonly matchRatio: number;
    readonly contradictoryCount: number;
    readonly evidenceTier: EvidenceTier;
  };
  readonly availability: {
    readonly description: string;
    readonly allInStock: boolean;
    readonly evidenceTier: EvidenceTier;
  };
  readonly delivery: {
    readonly description: string;
    readonly shipmentCount: number;
    readonly isQuoteBound: boolean;
    readonly deliveryDate: string | null;
    readonly evidenceTier: EvidenceTier;
  };
}

/**
 * 4-tier strategy ranking classification:
 * - 1: Feasible-Complete (feasible + defensible complete landed cost)
 * - 2: Feasible-Incomplete (feasible + missing/unverified cost component)
 * - 3: Uncertain (unresolved shipping/availability/eligibility)
 * - 4: Blocked (unfulfilled line items or critical contradiction)
 */
export type StrategyTier = 1 | 2 | 3 | 4;

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
  readonly authenticity?: SellerAuthenticityEvidence;
  readonly matchedSpecs?: readonly string[];
  readonly contradictorySpecs?: readonly string[];
  readonly missingSpecs?: readonly string[];
  readonly observationList?: readonly Record<string, unknown>[];
  readonly suitability?: ProductSuitabilityAssessment;
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
  readonly quoteId?: string | null;
  readonly quoteReference?: string | null;
  readonly quoteExpiresAt?: string | null;
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
  /** Detailed defensible cost breakdown */
  readonly costBreakdown?: StrategyCostBreakdown;
  /** Structured verifiable trade-offs across cost, quality, compatibility, availability, and delivery */
  readonly tradeOffs?: StrategyTradeOffs;
  /** Cryptographic evidence-content fingerprint (independent of evaluatedAt timestamp) */
  readonly evidenceFingerprint?: string;
  /** Explicit 1-4 ranking tier */
  readonly tier?: StrategyTier;
}

/**
 * Append-only invalidation record for buyer approval snapshots.
 * Preserves the original approval record and audit history intact.
 */
export interface ApprovalInvalidationRecord {
  readonly id: string;
  readonly approvalId: string;
  readonly reason: string;
  readonly evidenceReference: string;
  readonly timestamp: string;
  readonly sourceActorId: string;
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
