export type PurchaseStatus =
  | "DRAFT"
  | "REQUIREMENTS_CONFIRMED"
  | "EVALUATED"
  | "POLICY_BLOCKED"
  | "POLICY_PASSED"
  | "APPROVED"
  | "ORDER_CREATED"
  | "BUYER_APPROVED"
  | "CAPTURE_ATTEMPTED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type AuditEventType =
  | "proposed"
  | "requirements_confirmed"
  | "evaluated"
  | "policy_blocked"
  | "policy_passed"
  | "approved"
  | "approval_invalidated"
  | "order_created"
  | "buyer_approved"
  | "capture_attempted"
  | "completed"
  | "failed"
  | "cancelled";

export type PaymentAttemptStatus = "OPEN" | "COMPLETED" | "FAILED" | "CANCELLED";

export type CandidateSource = "channel3" | "seeded";

export type PolicyOutcome = "pass" | "block" | "unknown";

export type EvidenceStatus = "supports" | "contradicts" | "missing";

export type InvalidationReason =
  | "candidate_changed"
  | "snapshot_hash_changed"
  | "total_changed"
  | "currency_changed"
  | "policy_version_changed"
  | "evidence_fingerprint_changed"
  | "policy_superseded"
  | "quote_expired"
  | "destination_changed"
  | "destination_excluded";

export type PayPalOrderStatus =
  | "CREATED"
  | "PAYER_ACTION_REQUIRED"
  | "APPROVED"
  | "COMPLETED"
  | "VOIDED";

export type Actor =
  | { kind: "user"; userId: string }
  | { kind: "system"; component: string };

export type Currency = "USD";

export interface VerifiedPayPalObservation {
  orderId: string;
  status: PayPalOrderStatus;
  source: "paypal_order_get";
  observedAt: Date;
}

export interface CandidateFacts {
  id: string;
  purchaseId: string;
  source: CandidateSource;
  unitPriceCents: number;
  quantity: number;
  shippingCents: number;
  totalCents: number;
  currency: "USD";
  snapshotHash: string;
}

export interface ApprovalFacts {
  id: string;
  purchaseId: string;
  candidateId: string;
  snapshotHash: string;
  totalCents: number;
  currency: "USD";
  policyVersion: string;
  evidenceFingerprint: string;
  approverUserId: string;
  approvedAt: Date;
  invalidatedAt: Date | null;
  invalidationReason: string | null;
}

export interface PaymentAttemptFacts {
  id: string;
  purchaseId: string;
  approvalId: string;
  idempotencyKey: string;
  paypalOrderId: string | null;
  status: PaymentAttemptStatus;
  requestedIntent?: "AUTHORIZE" | string | null;
  verifiedStatus: string | null;
  verifiedAt: Date | null;
  failureReason: string | null;
}

export interface PurchaseState {
  purchaseId: string;
  status: PurchaseStatus;
  budgetCents: number;
  currency: "USD";
  policyVersion: string | null;
  requiredRuleKeys: readonly string[];
  selectedCandidate: CandidateFacts | null;
  currentEvidenceFingerprint: string | null;
  policyEvidenceFingerprint: string | null;
  isPolicySuperseded?: boolean | null;
  approvals: readonly ApprovalFacts[];
  paymentAttempts: readonly PaymentAttemptFacts[];
}

export interface PolicySummary {
  allRequiredPassed: boolean;
  blockingRuleKeys: string[];
  unknownRuleKeys: string[];
}

export type Command =
  | { kind: "confirm_requirements" }
  | { kind: "select_candidate"; candidate: CandidateFacts; policyVersion: string | null }
  | { kind: "evaluate" }
  | { kind: "apply_policy_summary"; summary: PolicySummary; policyVersion: string }
  | { kind: "reevaluate" }
  | { kind: "approve" }
  | { kind: "create_order"; idempotencyKey: string; paypalOrderId: string }
  | { kind: "observe_paypal_order"; observation: VerifiedPayPalObservation }
  | { kind: "record_capture_attempt" }
  | { kind: "record_capture_rejected"; reason: string }
  | { kind: "cancel"; reason: string };

export interface Context {
  actor: Actor;
  now: Date;
  newApprovalId?: string;
  newPaymentAttemptId?: string;
}

export type TransitionErrorCode =
  | "illegal_transition"
  | "invalid_actor"
  | "invalid_input"
  | "guard_failed"
  | "approval_invalidated"
  | "change_blocked_by_open_payment"
  | "payment_not_yet_approved"
  | "unexpected_paypal_status"
  | "attempt_already_open"
  | "order_id_mismatch"
  | "amount_mismatch"
  | "cross_purchase_reference"
  | "inconsistent_state";

export interface AuditPayloadProposed {
  budgetCents: number;
  currency: "USD";
}

export type AuditPayloadRequirementsConfirmed = Record<string, never>;

export interface AuditPayloadEvaluated {
  candidateId: string | null;
  reason:
    | "candidate_selected"
    | "evaluation_recorded"
    | "reassessment_required"
    | "reevaluation_requested";
}

export interface AuditPayloadPolicyBlocked {
  blockingRuleKeys: string[];
  unknownRuleKeys: string[];
}

export interface AuditPayloadPolicyPassed {
  policyVersion: string;
}

export interface AuditPayloadApproved {
  approvalId: string;
  candidateId: string;
  snapshotHash: string;
  totalCents: number;
  currency: "USD";
  policyVersion: string;
  evidenceFingerprint: string;
  approverUserId: string;
}

export interface AuditPayloadApprovalInvalidated {
  approvalId: string;
  reasons: InvalidationReason[];
}

export interface AuditPayloadOrderCreated {
  paymentAttemptId: string;
  approvalId: string;
  paypalOrderId: string;
  totalCents: number;
  requestedIntent?: "AUTHORIZE" | string | null;
}

export interface AuditPayloadBuyerApproved {
  paymentAttemptId: string;
  paypalOrderId: string;
  verifiedStatus: "APPROVED";
  observedAt: string;
}

export interface AuditPayloadCaptureAttempted {
  paymentAttemptId: string;
}

export interface AuditPayloadCompleted {
  paymentAttemptId: string;
  paypalOrderId: string;
  verifiedStatus: "COMPLETED";
  observedAt: string;
}

export interface AuditPayloadFailed {
  paymentAttemptId: string;
  source: "capture_rejected" | "verified_status";
  reason: string;
  verifiedStatus: string | null;
}

export interface AuditPayloadCancelled {
  fromStatus: PurchaseStatus;
  paymentAttemptId: string | null;
  reason: string;
}

export type AuditPayloadMap = {
  proposed: AuditPayloadProposed;
  requirements_confirmed: AuditPayloadRequirementsConfirmed;
  evaluated: AuditPayloadEvaluated;
  policy_blocked: AuditPayloadPolicyBlocked;
  policy_passed: AuditPayloadPolicyPassed;
  approved: AuditPayloadApproved;
  approval_invalidated: AuditPayloadApprovalInvalidated;
  order_created: AuditPayloadOrderCreated;
  buyer_approved: AuditPayloadBuyerApproved;
  capture_attempted: AuditPayloadCaptureAttempted;
  completed: AuditPayloadCompleted;
  failed: AuditPayloadFailed;
  cancelled: AuditPayloadCancelled;
};

export type AuditEventDraft<T extends AuditEventType = AuditEventType> = {
  type: T;
  purchaseId: string;
  actor: Actor;
  occurredAt: Date;
  payload: AuditPayloadMap[T];
};

export type TransitionResult =
  | { ok: true; next: PurchaseState; events: AuditEventDraft[] }
  | { ok: false; error: { code: TransitionErrorCode; message: string } };
