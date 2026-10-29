/**
 * Plinthly Phase 13C — Merchant Policy Ingestion, Versioning, and Change Monitoring Types.
 *
 * Enforces:
 * 1. Separation of source retrieval, source-content hashing, policy extraction, policy validation, and publication.
 * 2. Versioned policy lifecycle with immutable audit trail.
 * 3. Human review gating for material policy changes before publication.
 * 4. Deterministic multi-item cart eligibility modeling.
 */

import { Currency, Actor } from "../../state/types";
import { GeographicZone } from "../geographic-zones";
import { MerchantShippingPolicy } from "../merchant-policy";

export const POLICY_PARSER_VERSION = "2.0.0";

/**
 * Result of fetching an authoritative retailer policy page.
 */
export interface PolicySourceRecord {
  readonly sourceUrl: string;
  readonly retrievedAt: string; // ISO 8601 UTC
  readonly httpStatus: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly rawContentHash: string; // SHA-256 of response body
  readonly contentLength: number;
  readonly isNotModified: boolean; // true on HTTP 304 or identical content hash
  readonly responseHeaders?: Record<string, string>;
  readonly redirectChain?: readonly string[];
}

/**
 * Categorization of detected policy changes between retrieval iterations.
 */
export type PolicyChangeType =
  | "no_change" // HTTP 304 or identical raw HTML content hash
  | "content_updated_terms_identical" // HTML body changed, but extracted policy canonical terms are identical
  | "material_terms_changed" // Extracted policy terms (threshold, seller, zones, exclusions) differed
  | "terms_ambiguous" // Extractor detected conflicting or ambiguous terms in page text
  | "source_removed" // HTTP 404, 410, or page missing
  | "fetch_failed" // HTTP 5xx, timeout, or network error
  | "parse_failed"; // Page HTML corrupted or unparseable

/**
 * Publication lifecycle status for a policy version or change proposal.
 */
export type PolicyPublicationStatus =
  | "proposed" // Extracted or mutated; pending validation / human approval
  | "validated" // Validated against rules and approved for publication
  | "active" // Currently live and evaluated against procurement candidates
  | "rejected" // Rejected by reviewer; not published
  | "superseded"; // Replaced by a newer active version; retained for historical audit

/**
 * Intermediate extracted policy terms prior to canonical validation.
 */
export interface ExtractedPolicyTerms {
  readonly merchantDomain: string;
  readonly merchantName: string;
  readonly deliveryMethod: string;
  readonly currency: Currency;
  readonly thresholdCents: number;
  readonly shippingCostCents: number;
  readonly allowedZones: readonly GeographicZone[];
  readonly excludedZones: readonly GeographicZone[];
  readonly excludedCategories?: readonly string[];
  readonly excludedSpecialFulfillmentMethods?: readonly string[];
  readonly requiresDirectRetailerSeller?: boolean;
  readonly requiresDirectRetailerOrWfsFulfillment?: boolean;
  readonly marketplaceItemsContributeToThreshold?: boolean;
  readonly requiresMembership?: string | null;
  readonly requiresPreTaxMerchandiseThreshold?: boolean;
  readonly itemSpecificQualificationRequired?: boolean;
}

/**
 * Result of executing an extractor on fetched policy HTML.
 */
export interface PolicyExtractionResult {
  readonly status: "extracted" | "ambiguous" | "parse_error";
  readonly terms?: ExtractedPolicyTerms;
  readonly parserVersion: string;
  readonly warnings: readonly string[];
  readonly explanation: string;
}

/**
 * Audited change proposal for updating or superseding a merchant shipping policy.
 */
export interface PolicyChangeProposal {
  readonly proposalId: string;
  readonly policyId: string;
  readonly changeType: PolicyChangeType;
  readonly currentPolicy: MerchantShippingPolicy | null;
  readonly proposedPolicy: MerchantShippingPolicy | null;
  readonly sourceRecord: PolicySourceRecord;
  readonly parserVersion: string;
  readonly status: PolicyPublicationStatus;
  readonly explanation: string;
  readonly createdAt: string; // ISO 8601 UTC
  readonly reviewedAt: string | null; // ISO 8601 UTC or null
  readonly reviewedBy: Actor | null;
  readonly rejectionReason: string | null;
}

/**
 * Context of an individual product item within a multi-item cart.
 */
export interface CartItemContext {
  readonly id: string;
  readonly title: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly sellerName?: string;
  readonly isDirectRetailerSeller?: boolean;
  readonly isWfsFulfilled?: boolean;
  readonly isMarketplace?: boolean;
  readonly requiresSpecialDelivery?: boolean;
  readonly isFreeShippingEligibleItem?: boolean;
  readonly category?: string;
  readonly rawAttributes?: Record<string, unknown>;
}

/**
 * Context for evaluating shipping across a complete multi-item cart.
 */
export interface CartShippingContext {
  readonly merchantName: string;
  readonly merchantDomain: string;
  readonly items: readonly CartItemContext[];
  readonly cartLevelDiscountsCents?: number;
  readonly estimatedTaxCents?: number;
  readonly destination: {
    readonly country: string;
    readonly postalCode: string;
    readonly deliveryMethodPreference?: string;
  };
  readonly buyerMembership?: readonly string[];
  readonly now: Date;
  readonly requestedCurrency?: Currency;
}

/**
 * Shipping evaluation outcome for an individual item in a cart.
 */
export interface CartItemShippingResult {
  readonly itemId: string;
  readonly sellerFulfillmentType: "direct_retailer" | "wfs" | "independent_marketplace";
  readonly eligibleForMerchantFreeShipping: boolean;
  readonly shippingCents: number | null;
  readonly blockerReason?: string;
}

/**
 * Overall shipping evaluation outcome for a multi-item cart.
 */
export interface CartShippingEvaluationResult {
  readonly status: "satisfied" | "partially_satisfied" | "threshold_not_met" | "blocked";
  readonly allItemsQualified: boolean;
  readonly qualifyingMerchandiseCents: number;
  readonly thresholdCents: number;
  readonly totalShippingCents: number;
  readonly policyId?: string;
  readonly policyVersion?: string;
  readonly itemResults: readonly CartItemShippingResult[];
  readonly explanation: string;
}

