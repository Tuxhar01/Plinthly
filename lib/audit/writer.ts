import { AuditEventDraft } from "../state/types";

export type AuditEventRecord = AuditEventDraft;

export interface AuditStore {
  append(records: AuditEventRecord[]): Promise<void>;
}

export class InMemoryAuditStore implements AuditStore {
  private records: AuditEventRecord[] = [];

  async append(records: AuditEventRecord[]): Promise<void> {
    for (const record of records) {
      validateRecord(record);
    }
    this.records.push(...records);
  }

  getRecords(): readonly AuditEventRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records = [];
  }
}

export interface PrismaAuditDelegate {
  auditEvent: {
    createMany(args: {
      data: Array<{
        purchaseId: string;
        type: string;
        actor: unknown;
        payload: unknown;
        createdAt: Date;
      }>;
    }): Promise<unknown>;
  };
}

export function createPrismaAuditStore(delegate: PrismaAuditDelegate): AuditStore {
  return {
    async append(records: AuditEventRecord[]): Promise<void> {
      for (const record of records) {
        validateRecord(record);
      }

      await delegate.auditEvent.createMany({
        data: records.map((r) => ({
          purchaseId: r.purchaseId,
          type: r.type,
          actor: r.actor,
          payload: r.payload,
          createdAt: r.occurredAt,
        })),
      });
    },
  };
}

const FORBIDDEN_KEY_REGEX = /secret|token|password|authorization|clientsecret/i;

function assertNoForbiddenKeys(obj: unknown, path = ""): void {
  if (obj === null || typeof obj !== "object") {
    return;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      assertNoForbiddenKeys(obj[i], `${path}[${i}]`);
    }
    return;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_REGEX.test(key)) {
      throw new Error(`Forbidden key "${key}" detected in payload at ${path ? `${path}.${key}` : key}`);
    }
    assertNoForbiddenKeys(value, path ? `${path}.${key}` : key);
  }
}

const VALID_PURCHASE_STATUSES: Set<string> = new Set([
  "DRAFT",
  "REQUIREMENTS_CONFIRMED",
  "EVALUATED",
  "POLICY_BLOCKED",
  "POLICY_PASSED",
  "APPROVED",
  "ORDER_CREATED",
  "BUYER_APPROVED",
  "CAPTURE_ATTEMPTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

const VALID_AUDIT_TYPES: Set<string> = new Set([
  "proposed",
  "requirements_confirmed",
  "evaluated",
  "policy_blocked",
  "policy_passed",
  "approved",
  "approval_invalidated",
  "order_created",
  "buyer_approved",
  "capture_attempted",
  "completed",
  "failed",
  "cancelled",
]);

const VALID_EVALUATED_REASONS: Set<string> = new Set([
  "candidate_selected",
  "evaluation_recorded",
  "reassessment_required",
  "reevaluation_requested",
]);

const VALID_INVALIDATION_REASONS: Set<string> = new Set([
  "candidate_changed",
  "snapshot_hash_changed",
  "total_changed",
  "currency_changed",
  "policy_version_changed",
  "evidence_fingerprint_changed",
  "policy_superseded",
  "quote_expired",
  "destination_changed",
  "destination_excluded",
]);

export function validateRecord(record: AuditEventRecord): void {
  if (!record || typeof record !== "object") {
    throw new Error("Invalid audit event record: must be an object");
  }

  if (!record.purchaseId || typeof record.purchaseId !== "string" || record.purchaseId.trim().length === 0) {
    throw new Error("Invalid purchaseId: must be non-empty string");
  }

  if (!VALID_AUDIT_TYPES.has(record.type)) {
    throw new Error(`Invalid audit event type: ${record.type}`);
  }

  // Validate actor
  if (!record.actor || typeof record.actor !== "object") {
    throw new Error("Invalid actor: must be an object");
  }
  if (record.actor.kind === "user") {
    if (!record.actor.userId || typeof record.actor.userId !== "string" || record.actor.userId.trim().length === 0) {
      throw new Error("Invalid user actor: userId must be non-empty string");
    }
  } else if (record.actor.kind === "system") {
    if (!record.actor.component || typeof record.actor.component !== "string" || record.actor.component.trim().length === 0) {
      throw new Error("Invalid system actor: component must be non-empty string");
    }
  } else {
    throw new Error(`Invalid actor kind: ${(record.actor as { kind?: unknown }).kind}`);
  }

  // Validate occurredAt
  if (!record.occurredAt || !(record.occurredAt instanceof Date) || Number.isNaN(record.occurredAt.getTime())) {
    throw new Error("Invalid occurredAt: must be a valid Date instance");
  }

  // Validate payload keys for secrets
  assertNoForbiddenKeys(record.payload);

  const p = record.payload as Record<string, unknown>;
  if (!p || typeof p !== "object") {
    throw new Error(`Payload for ${record.type} must be an object`);
  }

  switch (record.type) {
    case "proposed": {
      if (typeof p.budgetCents !== "number" || !Number.isInteger(p.budgetCents) || p.budgetCents < 0) {
        throw new Error("proposed payload requires non-negative integer budgetCents");
      }
      if (p.currency !== "USD") {
        throw new Error("proposed payload requires currency 'USD'");
      }
      break;
    }

    case "requirements_confirmed": {
      break;
    }

    case "evaluated": {
      if (p.candidateId !== null && typeof p.candidateId !== "string") {
        throw new Error("evaluated payload candidateId must be string or null");
      }
      if (typeof p.reason !== "string" || !VALID_EVALUATED_REASONS.has(p.reason)) {
        throw new Error(`evaluated payload has invalid reason: ${String(p.reason)}`);
      }
      break;
    }

    case "policy_blocked": {
      if (!Array.isArray(p.blockingRuleKeys) || !Array.isArray(p.unknownRuleKeys)) {
        throw new Error("policy_blocked payload requires blockingRuleKeys and unknownRuleKeys arrays");
      }
      if (p.blockingRuleKeys.length === 0 && p.unknownRuleKeys.length === 0) {
        throw new Error("policy_blocked payload requires at least one key across blocking and unknown keys");
      }
      break;
    }

    case "policy_passed": {
      if (typeof p.policyVersion !== "string" || p.policyVersion.trim().length === 0) {
        throw new Error("policy_passed payload requires non-empty policyVersion");
      }
      break;
    }

    case "approved": {
      if (typeof p.approvalId !== "string" || p.approvalId.trim().length === 0) {
        throw new Error("approved payload requires non-empty approvalId");
      }
      if (typeof p.candidateId !== "string" || p.candidateId.trim().length === 0) {
        throw new Error("approved payload requires non-empty candidateId");
      }
      if (typeof p.snapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(p.snapshotHash)) {
        throw new Error("approved payload requires 64-char hex snapshotHash");
      }
      if (typeof p.totalCents !== "number" || !Number.isInteger(p.totalCents) || p.totalCents < 0) {
        throw new Error("approved payload requires non-negative integer totalCents");
      }
      if (p.currency !== "USD") {
        throw new Error("approved payload requires currency 'USD'");
      }
      if (typeof p.policyVersion !== "string" || p.policyVersion.trim().length === 0) {
        throw new Error("approved payload requires non-empty policyVersion");
      }
      if (typeof p.evidenceFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(p.evidenceFingerprint)) {
        throw new Error("approved payload requires 64-char hex evidenceFingerprint");
      }
      if (typeof p.approverUserId !== "string" || p.approverUserId.trim().length === 0) {
        throw new Error("approved payload requires non-empty approverUserId");
      }
      break;
    }

    case "approval_invalidated": {
      if (typeof p.approvalId !== "string" || p.approvalId.trim().length === 0) {
        throw new Error("approval_invalidated payload requires non-empty approvalId");
      }
      if (!Array.isArray(p.reasons) || p.reasons.length === 0) {
        throw new Error("approval_invalidated payload requires non-empty reasons array");
      }
      for (const r of p.reasons) {
        if (!VALID_INVALIDATION_REASONS.has(r)) {
          throw new Error(`approval_invalidated contains invalid reason: ${r}`);
        }
      }
      break;
    }

    case "order_created": {
      if (typeof p.paymentAttemptId !== "string" || p.paymentAttemptId.trim().length === 0) {
        throw new Error("order_created payload requires non-empty paymentAttemptId");
      }
      if (typeof p.approvalId !== "string" || p.approvalId.trim().length === 0) {
        throw new Error("order_created payload requires non-empty approvalId");
      }
      if (typeof p.paypalOrderId !== "string" || p.paypalOrderId.trim().length === 0) {
        throw new Error("order_created payload requires non-empty paypalOrderId");
      }
      if (typeof p.totalCents !== "number" || !Number.isInteger(p.totalCents) || p.totalCents < 0) {
        throw new Error("order_created payload requires non-negative integer totalCents");
      }
      if (p.requestedIntent !== undefined && p.requestedIntent !== "AUTHORIZE") {
        throw new Error("order_created payload requestedIntent must be AUTHORIZE if specified");
      }
      break;
    }

    case "buyer_approved": {
      if (typeof p.paymentAttemptId !== "string" || p.paymentAttemptId.trim().length === 0) {
        throw new Error("buyer_approved payload requires non-empty paymentAttemptId");
      }
      if (typeof p.paypalOrderId !== "string" || p.paypalOrderId.trim().length === 0) {
        throw new Error("buyer_approved payload requires non-empty paypalOrderId");
      }
      if (p.verifiedStatus !== "APPROVED") {
        throw new Error("buyer_approved payload requires verifiedStatus === 'APPROVED'");
      }
      if (typeof p.observedAt !== "string" || p.observedAt.trim().length === 0) {
        throw new Error("buyer_approved payload requires non-empty observedAt string");
      }
      break;
    }

    case "capture_attempted": {
      if (typeof p.paymentAttemptId !== "string" || p.paymentAttemptId.trim().length === 0) {
        throw new Error("capture_attempted payload requires non-empty paymentAttemptId");
      }
      break;
    }

    case "completed": {
      if (typeof p.paymentAttemptId !== "string" || p.paymentAttemptId.trim().length === 0) {
        throw new Error("completed payload requires non-empty paymentAttemptId");
      }
      if (typeof p.paypalOrderId !== "string" || p.paypalOrderId.trim().length === 0) {
        throw new Error("completed payload requires non-empty paypalOrderId");
      }
      if (p.verifiedStatus !== "COMPLETED") {
        throw new Error("completed payload requires verifiedStatus === 'COMPLETED'");
      }
      if (typeof p.observedAt !== "string" || p.observedAt.trim().length === 0) {
        throw new Error("completed payload requires non-empty observedAt string");
      }
      break;
    }

    case "failed": {
      if (!p.paymentAttemptId || typeof p.paymentAttemptId !== "string" || p.paymentAttemptId.trim().length === 0) {
        throw new Error("failed payload requires non-empty paymentAttemptId (must not be null)");
      }
      if (p.source !== "capture_rejected" && p.source !== "verified_status") {
        throw new Error(`failed payload has invalid source: ${p.source}`);
      }
      if (typeof p.reason !== "string" || p.reason.trim().length === 0) {
        throw new Error("failed payload requires non-empty reason string");
      }
      if (p.verifiedStatus !== null && typeof p.verifiedStatus !== "string") {
        throw new Error("failed payload verifiedStatus must be string or null");
      }
      break;
    }

    case "cancelled": {
      if (typeof p.fromStatus !== "string" || !VALID_PURCHASE_STATUSES.has(p.fromStatus)) {
        throw new Error(`cancelled payload has invalid fromStatus: ${String(p.fromStatus)}`);
      }
      if (p.paymentAttemptId !== null && (typeof p.paymentAttemptId !== "string" || p.paymentAttemptId.trim().length === 0)) {
        throw new Error("cancelled payload paymentAttemptId must be null or non-empty string");
      }
      if (typeof p.reason !== "string" || p.reason.trim().length === 0) {
        throw new Error("cancelled payload requires non-empty reason string");
      }
      break;
    }
  }
}
