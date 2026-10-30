import { Actor, Currency, PurchaseStatus, AuditEventType } from "../state/types";
import { PolicySummary } from "../state/types";
import { RuleResult } from "../policy/types";

/**
 * Common API error response structure.
 */
export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * Structured buyer requirement item.
 */
export interface BuyerRequirementItem {
  readonly key: string;
  readonly expectedValue?: string;
  readonly description?: string;
}

/**
 * Request body for creating a new purchase request.
 */
export interface CreatePurchaseRequest {
  readonly draftId?: string;
  readonly confirmationTokens?: readonly string[];
  readonly budgetCents?: number;
  readonly currency?: Currency;
  readonly requirements?: readonly (string | BuyerRequirementItem)[];
  readonly requestedQuantity?: number;
  readonly quantitySource?: import("../discovery/cart").QuantityProvenanceSource;
  readonly quantityConfirmed?: boolean;
  readonly originalInferredQuantity?: number | null;
  readonly confirmationToken?: string;
  readonly lineItems?: readonly import("../discovery/cart").ProcurementLineItem[];
  readonly destination?: import("../discovery/shipping").DestinationContext;
  readonly confirmImmediately?: boolean;
  readonly idempotencyKey?: string;
}

/**
 * Request body for candidate evaluation on a purchase.
 */
export interface EvaluatePurchaseRequest {
  readonly candidateId?: string;
  readonly rawCandidate?: Record<string, unknown>;
  readonly rawObservations?: Record<string, unknown> | readonly Record<string, unknown>[];
  readonly requiredRuleKeys?: readonly string[];
  readonly maxEvidenceAgeMs?: number;
  readonly expectedVersion?: number;
  readonly policyVersion?: string;
}

/**
 * Request body for approving a purchase.
 */
export interface ApprovePurchaseRequest {
  readonly expectedSnapshotHash?: string;
  readonly expectedEvidenceFingerprint?: string;
  readonly expectedTotalCents?: number;
  readonly expectedCurrency?: Currency;
  readonly policyVersion?: string;
  readonly expectedVersion?: number;
  readonly expectedDestination?: import("../discovery/shipping").DestinationContext;
}

/**
 * Public response DTO for a purchase.
 */
export interface PurchaseResponse {
  readonly id: string;
  readonly status: PurchaseStatus;
  readonly budgetCents: number;
  readonly currency: Currency;
  readonly requirements: readonly unknown[];
  readonly policyVersion: string | null;
  readonly policyEvidenceFingerprint: string | null;
  readonly selectedCandidateId: string | null;
  readonly ownerUserId: string;
  readonly version: number;
  readonly originatingDraftId?: string | null;
  readonly lineItems?: readonly import("../discovery/cart").ProcurementLineItem[];
  readonly destination?: import("../discovery/shipping").DestinationContext;
  readonly multiItemSnapshot?: import("../discovery/cart").MultiItemApprovalSnapshot | null;
  readonly selectedCandidate?: {
    readonly id: string;
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
    readonly snapshotHash: string;
    readonly capturedAt: string;
  } | null;
  readonly activeApproval?: {
    readonly id: string;
    readonly candidateId: string;
    readonly snapshotHash: string;
    readonly totalCents: number;
    readonly currency: Currency;
    readonly policyVersion: string;
    readonly evidenceFingerprint: string;
    readonly approverUserId: string;
    readonly approvedAt: string;
  } | null;
  readonly livePaymentAttempt?: {
    readonly id: string;
    readonly paypalOrderId: string | null;
    readonly status: string;
    readonly requestedIntent?: "AUTHORIZE" | string | null;
    readonly verifiedStatus: string | null;
    readonly verifiedAt: string | null;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Response DTO for candidate evaluation.
 */
export interface EvaluatePurchaseResponse {
  readonly purchaseId: string;
  readonly status: PurchaseStatus;
  readonly version: number;
  readonly summary: PolicySummary;
  readonly ruleResults: Record<string, RuleResult>;
  readonly candidateId: string;
  readonly snapshotHash: string;
  readonly evidenceFingerprint: string;
  readonly evaluatedAt: string;
}

/**
 * Response DTO for purchase approval.
 */
export interface ApprovePurchaseResponse {
  readonly purchaseId: string;
  readonly status: "APPROVED";
  readonly version: number;
  readonly approvalId: string;
  readonly candidateId: string;
  readonly snapshotHash: string;
  readonly evidenceFingerprint: string;
  readonly totalCents: number;
  readonly currency: Currency;
  readonly policyVersion: string;
  readonly approverUserId: string;
  readonly approvedAt: string;
}

/**
 * Public DTO for an audit event entry.
 */
export interface AuditEventEntry {
  readonly id: string;
  readonly purchaseId: string;
  readonly type: AuditEventType;
  readonly actor: Actor;
  readonly payload: unknown;
  readonly occurredAt: string;
}

/**
 * Response DTO for audit history.
 */
export interface AuditHistoryResponse {
  readonly purchaseId: string;
  readonly events: readonly AuditEventEntry[];
}

/**
 * Durable idempotency record interface.
 */
export interface IdempotencyRecord {
  readonly id: string;
  readonly key: string;
  readonly actorId: string;
  readonly operation: string;
  readonly requestHash: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

/**
 * Request DTO for creating a PayPal Sandbox order.
 */
export interface CreatePayPalOrderRequest {
  readonly idempotencyKey?: string;
  readonly shippingQuote?: {
    readonly expiresAt?: string | null;
    readonly [key: string]: unknown;
  };
  readonly destination?: import("../discovery/shipping").DestinationContext;
  readonly targetCartMerchantDomain?: string;
}

/**
 * Response DTO for created PayPal Sandbox order.
 */
export interface CreatePayPalOrderResponse {
  readonly purchaseId: string;
  readonly paypalOrderId: string;
  readonly status: PurchaseStatus;
  readonly requestedIntent?: "AUTHORIZE" | string;
  readonly approvalUrl: string | null;
  readonly paymentAttemptId: string;
  readonly amountCents: number;
  readonly currency: Currency;
}

/**
 * Request DTO for confirming buyer approval on a PayPal order.
 */
export interface ConfirmBuyerApprovalRequest {
  readonly paypalOrderId?: string;
}

/**
 * Request DTO for creating / evaluating a multi-item procurement plan.
 */
export interface CreateMultiItemPlanRequest {
  readonly lineItems: readonly import("../discovery/cart").ProcurementLineItem[];
  readonly candidates?: readonly import("../discovery/types").NormalizedProductCandidate[];
  readonly destination?: import("../discovery/shipping").DestinationContext;
  readonly buyerMemberships?: readonly string[];
}

/**
 * Request DTO for approving a multi-item procurement strategy.
 */
export interface ApproveMultiItemPlanRequest {
  readonly strategyId: string;
  readonly expectedSnapshotHash?: string;
  readonly expectedTotalLandedCostCents?: number;
  readonly expectedCurrency?: Currency;
  readonly destination?: import("../discovery/shipping").DestinationContext;
  readonly candidates?: readonly import("../discovery/types").NormalizedProductCandidate[];
}

/**
 * Response DTO for a multi-item procurement plan.
 */
export interface MultiItemPlanResponse {
  readonly purchaseId: string;
  readonly status: PurchaseStatus;
  readonly version: number;
  readonly lineItems: readonly import("../discovery/cart").ProcurementLineItem[];
  readonly destination: import("../discovery/shipping").DestinationContext;
  readonly strategies: readonly import("../discovery/cart").ProcurementStrategy[];
  readonly activeApproval?: import("../discovery/cart").MultiItemApprovalSnapshot | null;
  readonly evaluatedAt: string;
}
