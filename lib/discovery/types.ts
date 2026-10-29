import { CandidateSource, Currency, EvidenceStatus } from "../state/types";
import { EvidenceItemInput } from "../policy/types";
import { ShippingEvidenceDetails } from "./shipping";

/**
 * Explicit search constraints for product discovery.
 */
export interface SearchConstraints {
  readonly maxBudgetCents?: number;
  readonly currency?: Currency;
  readonly minQuantity?: number;
  readonly requiredAttributes?: readonly string[];
  readonly merchantAllowList?: readonly string[];
  readonly destination?: import("./shipping").DestinationContext;
}

/**
 * A product search request with an explicit query and constraints.
 */
export interface ProductSearchRequest {
  readonly query: string;
  readonly purchaseId: string;
  readonly constraints?: SearchConstraints;
}

/**
 * Duplicate group metadata for candidate comparison.
 */
export interface CandidateDuplicateInfo {
  readonly isDuplicate: boolean;
  readonly duplicateGroupKey: string;
  readonly canonicalExternalId?: string;
  readonly duplicateReason?: string;
}

/**
 * Summary breakdown of candidate specifications distinguishing verified from unverified/missing.
 */
export interface CandidateSpecificationsSummary {
  readonly known: Record<string, string>;
  readonly inferred: Record<string, string>;
  readonly missing: readonly string[];
}

/**
 * Raw, un-normalized candidate data as received from an external or fixture source.
 * Discovered data is treated as untrusted input.
 */
export interface RawDiscoveredCandidate {
  readonly externalId?: unknown;
  readonly title?: unknown;
  readonly merchantName?: unknown;
  readonly merchantUrl?: unknown;
  readonly unitPrice?: unknown;
  readonly unitPriceCents?: unknown;
  readonly shipping?: unknown;
  readonly shippingCents?: unknown;
  readonly quantity?: unknown;
  readonly currency?: unknown;
  readonly availability?: unknown;
  readonly rawAttributes?: unknown;
  readonly sourceUrl?: unknown;
  readonly capturedAt?: unknown;
  readonly sourceVerificationTimestamp?: unknown;
  readonly requiresDestination?: unknown;
  readonly policyId?: unknown;
  readonly policyDocumentFingerprint?: unknown;
  readonly policySourceUrl?: unknown;
  readonly geographicZone?: unknown;
  readonly serviceabilityStatus?: unknown;
  readonly thresholdCents?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Normalized product candidate ready for commercial snapshot computation,
 * policy evaluation, and state machine integration.
 */
export interface NormalizedProductCandidate {
  readonly id: string;
  readonly purchaseId: string;
  readonly source: CandidateSource;
  readonly externalId: string;
  readonly title: string;
  readonly merchantName: string;
  readonly merchantUrl: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly shippingCents: number;
  readonly totalCents: number;
  readonly currency: Currency;
  readonly availability: string;
  readonly capturedAt: Date;
  readonly snapshotHash: string;
  readonly rawSourceData: Record<string, unknown>;
  readonly shippingDetails?: ShippingEvidenceDetails;
  readonly duplicateInfo?: CandidateDuplicateInfo;
  readonly specificationsSummary?: CandidateSpecificationsSummary;
  readonly isComplete: boolean;
  readonly validationErrors: readonly string[];
  readonly sellerName?: string;
  readonly isMarketplace?: boolean;
  readonly isDirectRetailer?: boolean;
  readonly isDirectRetailerSeller?: boolean;
  readonly isWfsFulfilled?: boolean;
  readonly requiresSpecialDelivery?: boolean;
  readonly rawAttributes?: Record<string, unknown>;
  readonly observationList?: readonly Record<string, unknown>[];
  readonly fulfillmentMethod?: string;
  readonly blockerReason?: string;
  readonly blockerAction?: string;
}

/**
 * Declared operational capabilities of a source adapter.
 */
export interface SourceAdapterCapabilities {
  readonly name: string;
  readonly supportedCurrencies: readonly Currency[];
  readonly supportsStockStatus: boolean;
  readonly supportsSpecificationAttributes: boolean;
  readonly supportsPagination: boolean;
}

/**
 * Successful discovery result containing normalized candidates.
 */
export interface DiscoverySuccessResult {
  readonly status: "success";
  readonly candidates: readonly NormalizedProductCandidate[];
  readonly totalFound: number;
  readonly timestamp: Date;
}

/**
 * Empty discovery result with explicit reason.
 */
export interface DiscoveryEmptyResult {
  readonly status: "empty";
  readonly reason: string;
  readonly timestamp: Date;
}

/**
 * Source adapter failure with code and message.
 */
export interface DiscoverySourceErrorResult {
  readonly status: "source_error";
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly timestamp: Date;
}

/**
 * Discriminated union of all possible discovery results.
 */
export type DiscoveryResult =
  | DiscoverySuccessResult
  | DiscoveryEmptyResult
  | DiscoverySourceErrorResult;

/**
 * Discovery execution context.
 */
export interface DiscoveryContext {
  readonly now: Date;
  readonly candidateIdGenerator?: () => string;
}

/**
 * Source adapter boundary interface.
 */
export interface SourceAdapter {
  readonly name: string;
  readonly source: CandidateSource;
  getCapabilities(): SourceAdapterCapabilities;
  search(request: ProductSearchRequest, context: DiscoveryContext): Promise<DiscoveryResult>;
}

/**
 * Evidence record representing an observed fact about a candidate product.
 * Fully compatible with Phase 1 EvidenceFingerprintItem and Phase 2 EvidenceItemInput.
 */
export interface EvidenceRecord extends EvidenceItemInput {
  readonly id: string;
  readonly candidateId: string;
  readonly requirementKey: string;
  readonly value: string;
  readonly sourceUrl: string;
  readonly sourceType: string;
  readonly capturedAt: string; // ISO 8601 UTC string
  readonly status: EvidenceStatus;
  readonly rawObservedValue?: unknown;
}

/**
 * Result of evidence ingestion for a candidate.
 */
export interface EvidenceIngestionResult {
  readonly candidateId: string;
  readonly evidenceRecords: readonly EvidenceRecord[];
  readonly evidenceFingerprint: string;
  readonly missingAttributeKeys: readonly string[];
  readonly contradictedAttributeKeys: readonly string[];
  readonly supportedAttributeKeys: readonly string[];
  readonly conflictingAttributeKeys: readonly string[];
  readonly invalidTimestampAttributeKeys?: readonly string[];
  readonly isComplete: boolean;
}
