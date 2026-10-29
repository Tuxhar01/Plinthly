import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  Actor,
  AuditEventDraft,
  AuditEventType,
  CandidateSource,
  Currency,
  EvidenceStatus,
  PolicyOutcome,
  PurchaseStatus,
  PaymentAttemptStatus,
} from "../state/types";
import { validateRecord } from "../audit/writer";
import { normalizePolicyEvidenceFingerprint } from "../state/snapshot";
import { IdempotencyRecord } from "./types";

import { DatabaseUnavailableError } from "./errors";
export { DatabaseUnavailableError };

export interface PurchaseRecord {
  id: string;
  status: PurchaseStatus;
  requirements: unknown;
  budgetCents: number;
  currency: Currency;
  policyVersion: string | null;
  policyEvidenceFingerprint: string | null;
  selectedCandidateId: string | null;
  ownerUserId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CandidateRecord {
  id: string;
  purchaseId: string;
  source: CandidateSource;
  externalId: string;
  title: string;
  merchantName: string;
  merchantUrl: string;
  unitPriceCents: number;
  quantity: number;
  shippingCents: number;
  totalCents: number;
  currency: Currency;
  availability: string;
  capturedAt: Date;
  snapshotHash: string;
}

export interface EvidenceItemRecord {
  id: string;
  candidateId: string;
  requirementKey: string;
  value: string;
  sourceUrl: string;
  sourceType: string;
  capturedAt: Date;
  status: EvidenceStatus;
}

export interface PolicyResultRecord {
  id: string;
  purchaseId: string;
  policyVersion: string;
  ruleKey: string;
  outcome: PolicyOutcome;
  detail: string | null;
  evaluatedAt: Date;
}

export interface ApprovalRecord {
  id: string;
  purchaseId: string;
  candidateId: string;
  snapshotHash: string;
  totalCents: number;
  currency: Currency;
  policyVersion: string;
  evidenceFingerprint: string;
  approverUserId: string;
  approvedAt: Date;
  invalidatedAt: Date | null;
  invalidationReason: string | null;
}

export interface AuditEventRecord {
  id: string;
  purchaseId: string;
  type: AuditEventType;
  actor: Actor;
  payload: unknown;
  createdAt: Date;
}

export interface PaymentAttemptRecord {
  id: string;
  purchaseId: string;
  approvalId: string;
  idempotencyKey: string;
  paypalOrderId: string | null;
  status: PaymentAttemptStatus;
  requestedIntent?: "AUTHORIZE" | string | null;
  createdAt: Date;
  verifiedStatus: string | null;
  verifiedAt: Date | null;
  failureReason: string | null;
}

export interface PurchaseAggregate {
  purchase: PurchaseRecord;
  candidates: CandidateRecord[];
  selectedCandidate: CandidateRecord | null;
  evidence: EvidenceItemRecord[];
  approvals: ApprovalRecord[];
  policyResults: PolicyResultRecord[];
  paymentAttempts: PaymentAttemptRecord[];
}

export interface RecordEvaluationParams {
  purchaseId: string;
  expectedStatus: PurchaseStatus;
  expectedVersion: number;
  nextStatus: PurchaseStatus;
  selectedCandidateId: string;
  policyVersion: string;
  policyEvidenceFingerprint: string;
  policyResults: PolicyResultRecord[];
  auditEvents: AuditEventDraft[];
}

export interface RecordApprovalParams {
  purchaseId: string;
  expectedStatus: PurchaseStatus;
  expectedVersion: number;
  nextStatus: PurchaseStatus;
  approval: ApprovalRecord;
  auditEvents: AuditEventDraft[];
  selectedCandidateId?: string;
  requirements?: unknown;
}

export interface RecordOrderCreationParams {
  purchaseId: string;
  expectedStatus: PurchaseStatus;
  expectedVersion: number;
  nextStatus: PurchaseStatus;
  paymentAttempt: PaymentAttemptRecord;
  auditEvents: AuditEventDraft[];
}

export interface RecordBuyerApprovalParams {
  purchaseId: string;
  expectedStatus: PurchaseStatus;
  expectedVersion: number;
  nextStatus: PurchaseStatus;
  paymentAttemptId: string;
  verifiedStatus: string;
  verifiedAt: Date;
  auditEvents: AuditEventDraft[];
}

export interface RecordPaymentVerificationParams {
  purchaseId: string;
  paymentAttemptId: string;
  verifiedStatus: string;
  verifiedAt: Date;
  failureReason?: string | null;
  auditEvents?: AuditEventDraft[];
}

export interface RecordApprovalInvalidationParams {
  purchaseId: string;
  approvalId: string;
  invalidationReason: string;
  invalidatedAt: Date;
  auditEvents?: AuditEventDraft[];
}

export interface PurchaseRepository {
  createPurchase(
    purchase: PurchaseRecord,
    auditEvents: AuditEventDraft[],
    idempotencyRecord?: IdempotencyRecord
  ): Promise<PurchaseRecord>;
  getPurchaseById(id: string): Promise<PurchaseAggregate | null>;
  saveCandidateWithEvidence(candidate: CandidateRecord, evidence: EvidenceItemRecord[]): Promise<void>;
  recordEvaluation(params: RecordEvaluationParams): Promise<PurchaseAggregate>;
  recordApproval(params: RecordApprovalParams): Promise<PurchaseAggregate>;
  recordApprovalInvalidation(params: RecordApprovalInvalidationParams): Promise<void>;
  recordOrderCreation(params: RecordOrderCreationParams): Promise<PurchaseAggregate>;
  recordBuyerApproval(params: RecordBuyerApprovalParams): Promise<PurchaseAggregate>;
  recordPaymentVerification(params: RecordPaymentVerificationParams): Promise<PurchaseAggregate>;
  getAuditHistory(purchaseId: string): Promise<AuditEventRecord[]>;
  getIdempotencyRecord(actorId: string, operation: string, key: string): Promise<IdempotencyRecord | null>;
  saveIdempotencyRecord(record: IdempotencyRecord): Promise<void>;
  clear?(): void;
  disconnect?(): Promise<void>;
  ping?(): Promise<boolean>;
}

interface GlobalPrismaState {
  prismaClient?: PrismaClient;
  prismaClientUrl?: string;
  purchaseRepository?: PurchaseRepository;
}

const globalForPrisma = globalThis as unknown as GlobalPrismaState;

/**
 * Production-shaped PostgreSQL repository using Prisma with interactive transactions
 * and database-level conditional updates for optimistic concurrency control.
 */
export class PrismaPurchaseRepository implements PurchaseRepository {
  private prisma: PrismaClient | null = null;

  constructor(prismaClient?: PrismaClient) {
    if (prismaClient) {
      this.prisma = prismaClient;
    }
  }

  private getClient(): PrismaClient {
    if (this.prisma) {
      return this.prisma;
    }

    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl || databaseUrl.length === 0) {
      throw new DatabaseUnavailableError();
    }

    // Reuse existing client in non-production environments across Next.js HMR reloads
    // when targeting the exact same database connection string
    if (
      process.env.NODE_ENV !== "production" &&
      globalForPrisma.prismaClient &&
      globalForPrisma.prismaClientUrl === databaseUrl
    ) {
      this.prisma = globalForPrisma.prismaClient;
      return this.prisma;
    }

    try {
      const adapter = new PrismaPg({ connectionString: databaseUrl });
      const client = new PrismaClient({ adapter });
      if (process.env.NODE_ENV !== "production") {
        globalForPrisma.prismaClient = client;
        globalForPrisma.prismaClientUrl = databaseUrl;
      }
      this.prisma = client;
      return this.prisma;
    } catch {
      throw new DatabaseUnavailableError("Failed to initialize Prisma PostgreSQL client.");
    }
  }

  async disconnect(): Promise<void> {
    const clientToDisconnect = this.prisma;
    this.prisma = null;
    if (globalForPrisma.prismaClient === clientToDisconnect) {
      delete globalForPrisma.prismaClient;
      delete globalForPrisma.prismaClientUrl;
    }
    if (clientToDisconnect) {
      await clientToDisconnect.$disconnect().catch(() => {});
    }
  }

  async ping(): Promise<boolean> {
    try {
      const client = this.getClient();
      await client.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async createPurchase(
    purchase: PurchaseRecord,
    auditEvents: AuditEventDraft[],
    idempotencyRecord?: IdempotencyRecord
  ): Promise<PurchaseRecord> {
    const client = this.getClient();

    // Pre-validate all audit records before touching the database
    for (const draft of auditEvents) {
      validateRecord(draft);
    }

    return client.$transaction(async (tx) => {
      // 1. If idempotency record is supplied, write it inside the transaction first
      // to obtain the unique constraint lock on (actorId, operation, key)
      if (idempotencyRecord) {
        await tx.idempotencyRecord.create({
          data: {
            id: idempotencyRecord.id,
            key: idempotencyRecord.key,
            actorId: idempotencyRecord.actorId,
            operation: idempotencyRecord.operation,
            requestHash: idempotencyRecord.requestHash,
            responseStatus: idempotencyRecord.responseStatus,
            responseBody: idempotencyRecord.responseBody as Prisma.InputJsonValue,
            createdAt: idempotencyRecord.createdAt,
            expiresAt: idempotencyRecord.expiresAt,
          },
        });
      }

      const created = await tx.purchase.create({
        data: {
          id: purchase.id,
          status: purchase.status,
          requirements: purchase.requirements as Prisma.InputJsonValue,
          budgetCents: purchase.budgetCents,
          currency: purchase.currency,
          policyVersion: purchase.policyVersion,
          policyEvidenceFingerprint: purchase.policyEvidenceFingerprint,
          selectedCandidateId: purchase.selectedCandidateId,
          ownerUserId: purchase.ownerUserId,
          version: purchase.version,
          createdAt: purchase.createdAt,
          updatedAt: purchase.updatedAt,
        },
      });

      if (auditEvents.length > 0) {
        await tx.auditEvent.createMany({
          data: auditEvents.map((draft) => ({
            purchaseId: draft.purchaseId,
            type: draft.type,
            actor: draft.actor as unknown as Prisma.InputJsonValue,
            payload: draft.payload as Prisma.InputJsonValue,
            createdAt: draft.occurredAt,
          })),
        });
      }

      return {
        id: created.id,
        status: created.status as PurchaseStatus,
        requirements: created.requirements,
        budgetCents: created.budgetCents,
        currency: created.currency as Currency,
        policyVersion: created.policyVersion,
        policyEvidenceFingerprint: normalizePolicyEvidenceFingerprint(created.policyEvidenceFingerprint),
        selectedCandidateId: created.selectedCandidateId,
        ownerUserId: created.ownerUserId,
        version: created.version,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
    });
  }

  async getPurchaseById(id: string, txClient?: Prisma.TransactionClient): Promise<PurchaseAggregate | null> {
    const client = txClient ?? this.getClient();

    const purchase = await client.purchase.findUnique({
      where: { id },
      include: {
        candidates: {
          include: {
            evidence: true,
          },
        },
        selectedCandidate: true,
        approvals: true,
        policyResults: true,
        paymentAttempts: true,
        auditEvents: true,
      },
    });

    if (!purchase) return null;

    const allEvidence: EvidenceItemRecord[] = [];
    for (const cand of purchase.candidates) {
      for (const ev of cand.evidence) {
        allEvidence.push({
          id: ev.id,
          candidateId: ev.candidateId,
          requirementKey: ev.requirementKey,
          value: ev.value,
          sourceUrl: ev.sourceUrl,
          sourceType: ev.sourceType,
          capturedAt: ev.capturedAt,
          status: ev.status as EvidenceStatus,
        });
      }
    }

    return {
      purchase: {
        id: purchase.id,
        status: purchase.status as PurchaseStatus,
        requirements: purchase.requirements,
        budgetCents: purchase.budgetCents,
        currency: purchase.currency as Currency,
        policyVersion: purchase.policyVersion,
        policyEvidenceFingerprint: normalizePolicyEvidenceFingerprint(purchase.policyEvidenceFingerprint),
        selectedCandidateId: purchase.selectedCandidateId,
        ownerUserId: purchase.ownerUserId,
        version: purchase.version,
        createdAt: purchase.createdAt,
        updatedAt: purchase.updatedAt,
      },
      candidates: purchase.candidates.map((c) => ({
        id: c.id,
        purchaseId: c.purchaseId,
        source: c.source as CandidateSource,
        externalId: c.externalId,
        title: c.title,
        merchantName: c.merchantName,
        merchantUrl: c.merchantUrl,
        unitPriceCents: c.unitPriceCents,
        quantity: c.quantity,
        shippingCents: c.shippingCents,
        totalCents: c.totalCents,
        currency: c.currency as Currency,
        availability: c.availability,
        capturedAt: c.capturedAt,
        snapshotHash: c.snapshotHash,
      })),
      selectedCandidate: purchase.selectedCandidate
        ? {
            id: purchase.selectedCandidate.id,
            purchaseId: purchase.selectedCandidate.purchaseId,
            source: purchase.selectedCandidate.source as CandidateSource,
            externalId: purchase.selectedCandidate.externalId,
            title: purchase.selectedCandidate.title,
            merchantName: purchase.selectedCandidate.merchantName,
            merchantUrl: purchase.selectedCandidate.merchantUrl,
            unitPriceCents: purchase.selectedCandidate.unitPriceCents,
            quantity: purchase.selectedCandidate.quantity,
            shippingCents: purchase.selectedCandidate.shippingCents,
            totalCents: purchase.selectedCandidate.totalCents,
            currency: purchase.selectedCandidate.currency as Currency,
            availability: purchase.selectedCandidate.availability,
            capturedAt: purchase.selectedCandidate.capturedAt,
            snapshotHash: purchase.selectedCandidate.snapshotHash,
          }
        : null,
      evidence: allEvidence,
      approvals: purchase.approvals.map((a) => ({
        id: a.id,
        purchaseId: a.purchaseId,
        candidateId: a.candidateId,
        snapshotHash: a.snapshotHash,
        totalCents: a.totalCents,
        currency: a.currency as Currency,
        policyVersion: a.policyVersion,
        evidenceFingerprint: a.evidenceFingerprint,
        approverUserId: a.approverUserId,
        approvedAt: a.approvedAt,
        invalidatedAt: a.invalidatedAt,
        invalidationReason: a.invalidationReason,
      })),
      policyResults: purchase.policyResults.map((p) => ({
        id: p.id,
        purchaseId: p.purchaseId,
        policyVersion: p.policyVersion,
        ruleKey: p.ruleKey,
        outcome: p.outcome as PolicyOutcome,
        detail: p.detail,
        evaluatedAt: p.evaluatedAt,
      })),
      paymentAttempts: purchase.paymentAttempts.map((pa) => {
        const orderCreatedEvent = purchase.auditEvents?.find(
          (ev) =>
            ev.type === "order_created" &&
            ev.payload &&
            typeof ev.payload === "object" &&
            (ev.payload as Record<string, unknown>).paymentAttemptId === pa.id
        );
        const requestedIntent =
          (orderCreatedEvent?.payload as Record<string, unknown> | undefined)?.requestedIntent as string | undefined ?? null;
        return {
          id: pa.id,
          purchaseId: pa.purchaseId,
          approvalId: pa.approvalId,
          idempotencyKey: pa.idempotencyKey,
          paypalOrderId: pa.paypalOrderId,
          status: pa.status as PaymentAttemptStatus,
          requestedIntent,
          createdAt: pa.createdAt,
          verifiedStatus: pa.verifiedStatus,
          verifiedAt: pa.verifiedAt,
          failureReason: pa.failureReason,
        };
      }),
    };
  }

  async saveCandidateWithEvidence(candidate: CandidateRecord, evidence: EvidenceItemRecord[]): Promise<void> {
    const client = this.getClient();

    await client.$transaction(async (tx) => {
      const safeCandidateCapturedAt =
        candidate.capturedAt instanceof Date && !isNaN(candidate.capturedAt.getTime())
          ? candidate.capturedAt
          : new Date(0);

      await tx.candidate.upsert({
        where: {
          id_purchaseId: {
            id: candidate.id,
            purchaseId: candidate.purchaseId,
          },
        },
        create: {
          id: candidate.id,
          purchaseId: candidate.purchaseId,
          source: candidate.source,
          externalId: candidate.externalId,
          title: candidate.title,
          merchantName: candidate.merchantName,
          merchantUrl: candidate.merchantUrl,
          unitPriceCents: candidate.unitPriceCents,
          quantity: candidate.quantity,
          shippingCents: candidate.shippingCents,
          totalCents: candidate.totalCents,
          currency: candidate.currency,
          availability: candidate.availability,
          capturedAt: safeCandidateCapturedAt,
          snapshotHash: candidate.snapshotHash,
        },
        update: {
          source: candidate.source,
          externalId: candidate.externalId,
          title: candidate.title,
          merchantName: candidate.merchantName,
          merchantUrl: candidate.merchantUrl,
          unitPriceCents: candidate.unitPriceCents,
          quantity: candidate.quantity,
          shippingCents: candidate.shippingCents,
          totalCents: candidate.totalCents,
          currency: candidate.currency,
          availability: candidate.availability,
          capturedAt: safeCandidateCapturedAt,
          snapshotHash: candidate.snapshotHash,
        },
      });

      if (evidence.length > 0) {
        await tx.evidenceItem.createMany({
          data: evidence.map((e) => ({
            id: e.id,
            candidateId: e.candidateId,
            requirementKey: e.requirementKey,
            value: e.value,
            sourceUrl: e.sourceUrl,
            sourceType: e.sourceType,
            capturedAt:
              e.capturedAt instanceof Date && !isNaN(e.capturedAt.getTime())
                ? e.capturedAt
                : new Date(0),
            status: e.status,
          })),
        });
      }
    });
  }

  async recordEvaluation(params: RecordEvaluationParams): Promise<PurchaseAggregate> {
    const client = this.getClient();

    for (const draft of params.auditEvents) {
      validateRecord(draft);
    }

    return client.$transaction(async (tx) => {
      // Database-level conditional update for optimistic concurrency
      const updateResult = await tx.purchase.updateMany({
        where: {
          id: params.purchaseId,
          status: params.expectedStatus,
          version: params.expectedVersion,
        },
        data: {
          status: params.nextStatus,
          version: { increment: 1 },
          selectedCandidateId: params.selectedCandidateId,
          policyVersion: params.policyVersion,
          policyEvidenceFingerprint: params.policyEvidenceFingerprint,
          updatedAt: new Date(),
        },
      });

      if (updateResult.count === 0) {
        throw new Error(
          `Concurrency conflict: expected status "${params.expectedStatus}" and version "${params.expectedVersion}" failed conditional update.`
        );
      }

      if (params.policyResults.length > 0) {
        await tx.policyResult.createMany({
          data: params.policyResults.map((p) => ({
            id: p.id,
            purchaseId: p.purchaseId,
            policyVersion: p.policyVersion,
            ruleKey: p.ruleKey,
            outcome: p.outcome,
            detail: p.detail,
            evaluatedAt: p.evaluatedAt,
          })),
        });
      }

      if (params.auditEvents.length > 0) {
        await tx.auditEvent.createMany({
          data: params.auditEvents.map((draft) => ({
            purchaseId: draft.purchaseId,
            type: draft.type,
            actor: draft.actor as unknown as Prisma.InputJsonValue,
            payload: draft.payload as Prisma.InputJsonValue,
            createdAt: draft.occurredAt,
          })),
        });
      }

      const aggregate = await this.getPurchaseById(params.purchaseId, tx);
      return aggregate!;
    });
  }

  async recordApproval(params: RecordApprovalParams): Promise<PurchaseAggregate> {
    const client = this.getClient();

    for (const draft of params.auditEvents) {
      validateRecord(draft);
    }

    return client.$transaction(async (tx) => {
      // Database-level conditional update for optimistic concurrency
      const updateData: Prisma.PurchaseUncheckedUpdateManyInput = {
        status: params.nextStatus,
        version: { increment: 1 },
        updatedAt: new Date(),
      };
      if (params.selectedCandidateId !== undefined) {
        updateData.selectedCandidateId = params.selectedCandidateId;
      }
      if (params.requirements !== undefined) {
        updateData.requirements = params.requirements as Prisma.InputJsonValue;
      }

      const updateResult = await tx.purchase.updateMany({
        where: {
          id: params.purchaseId,
          status: params.expectedStatus,
          version: params.expectedVersion,
        },
        data: updateData,
      });

      if (updateResult.count === 0) {
        throw new Error(
          `Concurrency conflict: expected status "${params.expectedStatus}" and version "${params.expectedVersion}" failed conditional update.`
        );
      }

      await tx.approval.create({
        data: {
          id: params.approval.id,
          purchaseId: params.approval.purchaseId,
          candidateId: params.approval.candidateId,
          snapshotHash: params.approval.snapshotHash,
          totalCents: params.approval.totalCents,
          currency: params.approval.currency,
          policyVersion: params.approval.policyVersion,
          evidenceFingerprint: params.approval.evidenceFingerprint,
          approverUserId: params.approval.approverUserId,
          approvedAt: params.approval.approvedAt,
          invalidatedAt: params.approval.invalidatedAt,
          invalidationReason: params.approval.invalidationReason,
        },
      });

      if (params.auditEvents.length > 0) {
        await tx.auditEvent.createMany({
          data: params.auditEvents.map((draft) => ({
            purchaseId: draft.purchaseId,
            type: draft.type,
            actor: draft.actor as unknown as Prisma.InputJsonValue,
            payload: draft.payload as Prisma.InputJsonValue,
            createdAt: draft.occurredAt,
          })),
        });
      }

      const aggregate = await this.getPurchaseById(params.approval.purchaseId, tx);
      return aggregate!;
    });
  }

  async recordApprovalInvalidation(params: RecordApprovalInvalidationParams): Promise<void> {
    const client = this.getClient();

    if (params.auditEvents) {
      for (const draft of params.auditEvents) {
        validateRecord(draft);
      }
    }

    await client.$transaction(async (tx) => {
      await tx.approval.update({
        where: { id: params.approvalId },
        data: {
          invalidatedAt: params.invalidatedAt,
          invalidationReason: params.invalidationReason,
        },
      });

      if (params.auditEvents && params.auditEvents.length > 0) {
        await tx.auditEvent.createMany({
          data: params.auditEvents.map((draft) => ({
            purchaseId: draft.purchaseId,
            type: draft.type,
            actor: draft.actor as unknown as Prisma.InputJsonValue,
            payload: draft.payload as Prisma.InputJsonValue,
            createdAt: draft.occurredAt,
          })),
        });
      }
    });
  }

  async recordOrderCreation(params: RecordOrderCreationParams): Promise<PurchaseAggregate> {
    const client = this.getClient();

    for (const draft of params.auditEvents) {
      validateRecord(draft);
    }

    return client.$transaction(async (tx) => {
      const updateResult = await tx.purchase.updateMany({
        where: {
          id: params.purchaseId,
          status: params.expectedStatus,
          version: params.expectedVersion,
        },
        data: {
          status: params.nextStatus,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });

      if (updateResult.count === 0) {
        throw new Error(
          `Concurrency conflict: expected status "${params.expectedStatus}" and version "${params.expectedVersion}" failed conditional update.`
        );
      }

      await tx.paymentAttempt.create({
        data: {
          id: params.paymentAttempt.id,
          purchaseId: params.purchaseId,
          approvalId: params.paymentAttempt.approvalId,
          idempotencyKey: params.paymentAttempt.idempotencyKey,
          paypalOrderId: params.paymentAttempt.paypalOrderId,
          status: params.paymentAttempt.status,
          createdAt: params.paymentAttempt.createdAt,
          verifiedStatus: params.paymentAttempt.verifiedStatus,
          verifiedAt: params.paymentAttempt.verifiedAt,
          failureReason: params.paymentAttempt.failureReason,
        },
      });

      if (params.auditEvents.length > 0) {
        await tx.auditEvent.createMany({
          data: params.auditEvents.map((draft) => ({
            purchaseId: draft.purchaseId,
            type: draft.type,
            actor: draft.actor as unknown as Prisma.InputJsonValue,
            payload: draft.payload as Prisma.InputJsonValue,
            createdAt: draft.occurredAt,
          })),
        });
      }

      const aggregate = await this.getPurchaseById(params.purchaseId, tx);
      return aggregate!;
    });
  }

  async recordBuyerApproval(params: RecordBuyerApprovalParams): Promise<PurchaseAggregate> {
    const client = this.getClient();

    for (const draft of params.auditEvents) {
      validateRecord(draft);
    }

    return client.$transaction(async (tx) => {
      const updateResult = await tx.purchase.updateMany({
        where: {
          id: params.purchaseId,
          status: params.expectedStatus,
          version: params.expectedVersion,
        },
        data: {
          status: params.nextStatus,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });

      if (updateResult.count === 0) {
        throw new Error(
          `Concurrency conflict: expected status "${params.expectedStatus}" and version "${params.expectedVersion}" failed conditional update.`
        );
      }

      await tx.paymentAttempt.update({
        where: { id: params.paymentAttemptId },
        data: {
          verifiedStatus: params.verifiedStatus,
          verifiedAt: params.verifiedAt,
        },
      });

      if (params.auditEvents.length > 0) {
        await tx.auditEvent.createMany({
          data: params.auditEvents.map((draft) => ({
            purchaseId: draft.purchaseId,
            type: draft.type,
            actor: draft.actor as unknown as Prisma.InputJsonValue,
            payload: draft.payload as Prisma.InputJsonValue,
            createdAt: draft.occurredAt,
          })),
        });
      }

      const aggregate = await this.getPurchaseById(params.purchaseId, tx);
      return aggregate!;
    });
  }

  async recordPaymentVerification(params: RecordPaymentVerificationParams): Promise<PurchaseAggregate> {
    const client = this.getClient();

    if (params.auditEvents) {
      for (const draft of params.auditEvents) {
        validateRecord(draft);
      }
    }

    return client.$transaction(async (tx) => {
      await tx.paymentAttempt.update({
        where: { id: params.paymentAttemptId },
        data: {
          verifiedStatus: params.verifiedStatus,
          verifiedAt: params.verifiedAt,
          failureReason: params.failureReason ?? null,
        },
      });

      if (params.auditEvents && params.auditEvents.length > 0) {
        await tx.auditEvent.createMany({
          data: params.auditEvents.map((draft) => ({
            purchaseId: draft.purchaseId,
            type: draft.type,
            actor: draft.actor as unknown as Prisma.InputJsonValue,
            payload: draft.payload as Prisma.InputJsonValue,
            createdAt: draft.occurredAt,
          })),
        });
      }

      const aggregate = await this.getPurchaseById(params.purchaseId, tx);
      return aggregate!;
    });
  }

  async getAuditHistory(purchaseId: string): Promise<AuditEventRecord[]> {
    const client = this.getClient();

    const events = await client.auditEvent.findMany({
      where: { purchaseId },
      orderBy: { createdAt: "asc" },
    });

    return events.map((e) => ({
      id: e.id,
      purchaseId: e.purchaseId,
      type: e.type as AuditEventType,
      actor: e.actor as unknown as Actor,
      payload: e.payload,
      createdAt: e.createdAt,
    }));
  }

  async getIdempotencyRecord(actorId: string, operation: string, key: string): Promise<IdempotencyRecord | null> {
    const client = this.getClient();

    const record = await client.idempotencyRecord.findUnique({
      where: {
        actorId_operation_key: {
          actorId,
          operation,
          key,
        },
      },
    });

    if (!record) return null;

    return {
      id: record.id,
      key: record.key,
      actorId: record.actorId,
      operation: record.operation,
      requestHash: record.requestHash,
      responseStatus: record.responseStatus,
      responseBody: record.responseBody,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }

  async saveIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    const client = this.getClient();

    await client.idempotencyRecord.create({
      data: {
        id: record.id,
        key: record.key,
        actorId: record.actorId,
        operation: record.operation,
        requestHash: record.requestHash,
        responseStatus: record.responseStatus,
        responseBody: record.responseBody as Prisma.InputJsonValue,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      },
    });
  }
}

/**
 * In-memory repository implementing transactions, optimistic locking, and append-only audits.
 * Retained for isolated unit and integration testing without database dependencies.
 */
export class InMemoryPurchaseRepository implements PurchaseRepository {
  private purchases = new Map<string, PurchaseRecord>();
  private candidates = new Map<string, CandidateRecord>();
  private evidence = new Map<string, EvidenceItemRecord[]>();
  private approvals = new Map<string, ApprovalRecord[]>();
  private policyResults = new Map<string, PolicyResultRecord[]>();
  private paymentAttempts = new Map<string, PaymentAttemptRecord[]>();
  private auditEvents = new Map<string, AuditEventRecord[]>();
  private idempotencyRecords = new Map<string, IdempotencyRecord>();

  async createPurchase(
    purchase: PurchaseRecord,
    auditEvents: AuditEventDraft[],
    idempotencyRecord?: IdempotencyRecord
  ): Promise<PurchaseRecord> {
    // Pre-validate all audit records before modifying state
    for (const draft of auditEvents) {
      validateRecord(draft);
    }

    if (idempotencyRecord) {
      const compoundKey = `${idempotencyRecord.actorId}:${idempotencyRecord.operation}:${idempotencyRecord.key}`;
      if (this.idempotencyRecords.has(compoundKey)) {
        const error = new Error(`Unique constraint failed on the fields: (actor_id, operation, idempotency_key)`);
        (error as unknown as { code: string }).code = "P2002";
        throw error;
      }
    }

    if (this.purchases.has(purchase.id)) {
      const error = new Error(`Purchase with id "${purchase.id}" already exists.`);
      (error as unknown as { code: string }).code = "P2002";
      throw error;
    }

    if (idempotencyRecord) {
      const compoundKey = `${idempotencyRecord.actorId}:${idempotencyRecord.operation}:${idempotencyRecord.key}`;
      this.idempotencyRecords.set(compoundKey, { ...idempotencyRecord });
    }

    const savedPurchase: PurchaseRecord = { ...purchase };
    this.purchases.set(purchase.id, savedPurchase);

    const eventsList = this.auditEvents.get(purchase.id) ?? [];
    for (const draft of auditEvents) {
      eventsList.push({
        id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        purchaseId: draft.purchaseId,
        type: draft.type,
        actor: draft.actor,
        payload: draft.payload,
        createdAt: draft.occurredAt,
      });
    }
    this.auditEvents.set(purchase.id, eventsList);

    return { ...savedPurchase };
  }

  async getPurchaseById(id: string): Promise<PurchaseAggregate | null> {
    const purchase = this.purchases.get(id);
    if (!purchase) return null;

    const allCandidates = Array.from(this.candidates.values()).filter((c) => c.purchaseId === id);
    const selectedCandidate = purchase.selectedCandidateId
      ? this.candidates.get(purchase.selectedCandidateId) ?? null
      : null;

    const allEvidence: EvidenceItemRecord[] = [];
    for (const cand of allCandidates) {
      const items = this.evidence.get(cand.id) ?? [];
      allEvidence.push(...items);
    }

    const approvals = this.approvals.get(id) ?? [];
    const policyResults = this.policyResults.get(id) ?? [];
    const paymentAttempts = this.paymentAttempts.get(id) ?? [];

    return {
      purchase: {
        ...purchase,
        policyEvidenceFingerprint: normalizePolicyEvidenceFingerprint(purchase.policyEvidenceFingerprint),
      },
      candidates: allCandidates.map((c) => ({ ...c })),
      selectedCandidate: selectedCandidate ? { ...selectedCandidate } : null,
      evidence: allEvidence.map((e) => ({ ...e })),
      approvals: approvals.map((a) => ({ ...a })),
      policyResults: policyResults.map((p) => ({ ...p })),
      paymentAttempts: paymentAttempts.map((pa) => {
        let requestedIntent = pa.requestedIntent ?? null;
        if (!requestedIntent) {
          const events = this.auditEvents.get(id) ?? [];
          const ev = events.find(
            (e) =>
              e.type === "order_created" &&
              e.payload &&
              typeof e.payload === "object" &&
              (e.payload as Record<string, unknown>).paymentAttemptId === pa.id
          );
          if (ev && typeof (ev.payload as Record<string, unknown>).requestedIntent === "string") {
            requestedIntent = (ev.payload as Record<string, unknown>).requestedIntent as string;
          }
        }
        return {
          ...pa,
          requestedIntent,
        };
      }),
    };
  }

  async saveCandidateWithEvidence(candidate: CandidateRecord, evidence: EvidenceItemRecord[]): Promise<void> {
    const safeCandidateCapturedAt =
      candidate.capturedAt instanceof Date && !isNaN(candidate.capturedAt.getTime())
        ? candidate.capturedAt
        : new Date(0);
    this.candidates.set(candidate.id, { ...candidate, capturedAt: safeCandidateCapturedAt });
    this.evidence.set(
      candidate.id,
      evidence.map((e) => ({
        ...e,
        capturedAt:
          e.capturedAt instanceof Date && !isNaN(e.capturedAt.getTime()) ? e.capturedAt : new Date(0),
      }))
    );
  }

  async recordEvaluation(params: RecordEvaluationParams): Promise<PurchaseAggregate> {
    const purchase = this.purchases.get(params.purchaseId);
    if (!purchase) {
      throw new Error(`Purchase "${params.purchaseId}" not found.`);
    }

    // Database-shaped optimistic concurrency check on status AND version
    if (purchase.status !== params.expectedStatus || purchase.version !== params.expectedVersion) {
      throw new Error(
        `Concurrency conflict: expected status "${params.expectedStatus}" and version "${params.expectedVersion}", but found status "${purchase.status}" and version "${purchase.version}".`
      );
    }

    for (const draft of params.auditEvents) {
      validateRecord(draft);
    }

    const updatedPurchase: PurchaseRecord = {
      ...purchase,
      status: params.nextStatus,
      version: purchase.version + 1,
      selectedCandidateId: params.selectedCandidateId,
      policyVersion: params.policyVersion,
      policyEvidenceFingerprint: params.policyEvidenceFingerprint,
      updatedAt: new Date(),
    };
    this.purchases.set(params.purchaseId, updatedPurchase);

    const results = this.policyResults.get(params.purchaseId) ?? [];
    results.push(...params.policyResults.map((p) => ({ ...p })));
    this.policyResults.set(params.purchaseId, results);

    const eventsList = this.auditEvents.get(params.purchaseId) ?? [];
    for (const draft of params.auditEvents) {
      eventsList.push({
        id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        purchaseId: draft.purchaseId,
        type: draft.type,
        actor: draft.actor,
        payload: draft.payload,
        createdAt: draft.occurredAt,
      });
    }
    this.auditEvents.set(params.purchaseId, eventsList);

    const aggregate = await this.getPurchaseById(params.purchaseId);
    return aggregate!;
  }

  async recordApproval(params: RecordApprovalParams): Promise<PurchaseAggregate> {
    const purchase = this.purchases.get(params.purchaseId);
    if (!purchase) {
      throw new Error(`Purchase "${params.purchaseId}" not found.`);
    }

    // Database-shaped optimistic concurrency check on status AND version
    if (purchase.status !== params.expectedStatus || purchase.version !== params.expectedVersion) {
      throw new Error(
        `Concurrency conflict: expected status "${params.expectedStatus}" and version "${params.expectedVersion}", but found status "${purchase.status}" and version "${purchase.version}".`
      );
    }

    for (const draft of params.auditEvents) {
      validateRecord(draft);
    }

    const updatedPurchase: PurchaseRecord = {
      ...purchase,
      status: params.nextStatus,
      version: purchase.version + 1,
      updatedAt: new Date(),
      ...(params.selectedCandidateId !== undefined ? { selectedCandidateId: params.selectedCandidateId } : {}),
      ...(params.requirements !== undefined ? { requirements: params.requirements } : {}),
    };
    this.purchases.set(params.purchaseId, updatedPurchase);

    const apprList = this.approvals.get(params.purchaseId) ?? [];
    apprList.push({ ...params.approval });
    this.approvals.set(params.purchaseId, apprList);

    const eventsList = this.auditEvents.get(params.purchaseId) ?? [];
    for (const draft of params.auditEvents) {
      eventsList.push({
        id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        purchaseId: draft.purchaseId,
        type: draft.type,
        actor: draft.actor,
        payload: draft.payload,
        createdAt: draft.occurredAt,
      });
    }
    this.auditEvents.set(params.purchaseId, eventsList);

    const aggregate = await this.getPurchaseById(params.purchaseId);
    return aggregate!;
  }

  async recordApprovalInvalidation(params: RecordApprovalInvalidationParams): Promise<void> {
    const apprList = this.approvals.get(params.purchaseId) ?? [];
    const target = apprList.find((a) => a.id === params.approvalId);
    if (target) {
      target.invalidatedAt = params.invalidatedAt;
      target.invalidationReason = params.invalidationReason;
    }

    if (params.auditEvents) {
      const eventsList = this.auditEvents.get(params.purchaseId) ?? [];
      for (const draft of params.auditEvents) {
        validateRecord(draft);
        eventsList.push({
          id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          purchaseId: draft.purchaseId,
          type: draft.type,
          actor: draft.actor,
          payload: draft.payload,
          createdAt: draft.occurredAt,
        });
      }
      this.auditEvents.set(params.purchaseId, eventsList);
    }
  }

  async recordOrderCreation(params: RecordOrderCreationParams): Promise<PurchaseAggregate> {
    const purchase = this.purchases.get(params.purchaseId);
    if (!purchase) {
      throw new Error(`Purchase "${params.purchaseId}" not found.`);
    }

    if (purchase.status !== params.expectedStatus || purchase.version !== params.expectedVersion) {
      throw new Error(
        `Concurrency conflict: expected status "${params.expectedStatus}" and version "${params.expectedVersion}", but found status "${purchase.status}" and version "${purchase.version}".`
      );
    }

    for (const draft of params.auditEvents) {
      validateRecord(draft);
    }

    const updatedPurchase: PurchaseRecord = {
      ...purchase,
      status: params.nextStatus,
      version: purchase.version + 1,
      updatedAt: new Date(),
    };
    this.purchases.set(params.purchaseId, updatedPurchase);

    const attemptsList = this.paymentAttempts.get(params.purchaseId) ?? [];
    attemptsList.push({ ...params.paymentAttempt });
    this.paymentAttempts.set(params.purchaseId, attemptsList);

    const eventsList = this.auditEvents.get(params.purchaseId) ?? [];
    for (const draft of params.auditEvents) {
      eventsList.push({
        id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        purchaseId: draft.purchaseId,
        type: draft.type,
        actor: draft.actor,
        payload: draft.payload,
        createdAt: draft.occurredAt,
      });
    }
    this.auditEvents.set(params.purchaseId, eventsList);

    const aggregate = await this.getPurchaseById(params.purchaseId);
    return aggregate!;
  }

  async recordBuyerApproval(params: RecordBuyerApprovalParams): Promise<PurchaseAggregate> {
    const purchase = this.purchases.get(params.purchaseId);
    if (!purchase) {
      throw new Error(`Purchase "${params.purchaseId}" not found.`);
    }

    if (purchase.status !== params.expectedStatus || purchase.version !== params.expectedVersion) {
      throw new Error(
        `Concurrency conflict: expected status "${params.expectedStatus}" and version "${params.expectedVersion}", but found status "${purchase.status}" and version "${purchase.version}".`
      );
    }

    for (const draft of params.auditEvents) {
      validateRecord(draft);
    }

    const attemptsList = this.paymentAttempts.get(params.purchaseId) ?? [];
    const attempt = attemptsList.find((a) => a.id === params.paymentAttemptId);
    if (!attempt) {
      throw new Error(`Payment attempt "${params.paymentAttemptId}" not found.`);
    }
    attempt.verifiedStatus = params.verifiedStatus;
    attempt.verifiedAt = params.verifiedAt;

    const updatedPurchase: PurchaseRecord = {
      ...purchase,
      status: params.nextStatus,
      version: purchase.version + 1,
      updatedAt: new Date(),
    };
    this.purchases.set(params.purchaseId, updatedPurchase);

    const eventsList = this.auditEvents.get(params.purchaseId) ?? [];
    for (const draft of params.auditEvents) {
      eventsList.push({
        id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        purchaseId: draft.purchaseId,
        type: draft.type,
        actor: draft.actor,
        payload: draft.payload,
        createdAt: draft.occurredAt,
      });
    }
    this.auditEvents.set(params.purchaseId, eventsList);

    const aggregate = await this.getPurchaseById(params.purchaseId);
    return aggregate!;
  }

  async recordPaymentVerification(params: RecordPaymentVerificationParams): Promise<PurchaseAggregate> {
    const purchase = this.purchases.get(params.purchaseId);
    if (!purchase) {
      throw new Error(`Purchase "${params.purchaseId}" not found.`);
    }

    const attemptsList = this.paymentAttempts.get(params.purchaseId) ?? [];
    const attempt = attemptsList.find((a) => a.id === params.paymentAttemptId);
    if (!attempt) {
      throw new Error(`Payment attempt "${params.paymentAttemptId}" not found.`);
    }
    attempt.verifiedStatus = params.verifiedStatus;
    attempt.verifiedAt = params.verifiedAt;
    attempt.failureReason = params.failureReason ?? null;

    if (params.auditEvents && params.auditEvents.length > 0) {
      for (const draft of params.auditEvents) {
        validateRecord(draft);
      }
      const eventsList = this.auditEvents.get(params.purchaseId) ?? [];
      for (const draft of params.auditEvents) {
        eventsList.push({
          id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          purchaseId: draft.purchaseId,
          type: draft.type,
          actor: draft.actor,
          payload: draft.payload,
          createdAt: draft.occurredAt,
        });
      }
      this.auditEvents.set(params.purchaseId, eventsList);
    }

    const aggregate = await this.getPurchaseById(params.purchaseId);
    return aggregate!;
  }

  async getAuditHistory(purchaseId: string): Promise<AuditEventRecord[]> {
    const list = this.auditEvents.get(purchaseId) ?? [];
    return list.map((e) => ({ ...e }));
  }

  async getIdempotencyRecord(actorId: string, operation: string, key: string): Promise<IdempotencyRecord | null> {
    const compoundKey = `${actorId}:${operation}:${key}`;
    const found = this.idempotencyRecords.get(compoundKey);
    return found ? { ...found } : null;
  }

  async saveIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    const compoundKey = `${record.actorId}:${record.operation}:${record.key}`;
    if (this.idempotencyRecords.has(compoundKey)) {
      const error = new Error(`Unique constraint failed on the fields: (actor_id, operation, idempotency_key)`);
      (error as unknown as { code: string }).code = "P2002";
      throw error;
    }
    this.idempotencyRecords.set(compoundKey, { ...record });
  }

  clear(): void {
    this.purchases.clear();
    this.candidates.clear();
    this.evidence.clear();
    this.approvals.clear();
    this.policyResults.clear();
    this.auditEvents.clear();
    this.idempotencyRecords.clear();
  }

  async disconnect(): Promise<void> {
    // In-memory repository has no external connections
  }
}

// Active repository instance defaults to PrismaPurchaseRepository (persisted across dev hot-reloads)
let globalRepository: PurchaseRepository =
  (process.env.NODE_ENV !== "production" ? globalForPrisma.purchaseRepository : undefined) ??
  new PrismaPurchaseRepository();

if (process.env.NODE_ENV !== "production" && !globalForPrisma.purchaseRepository) {
  globalForPrisma.purchaseRepository = globalRepository;
}

export function getPurchaseRepository(): PurchaseRepository {
  if (process.env.NODE_ENV !== "production" && globalForPrisma.purchaseRepository) {
    return globalForPrisma.purchaseRepository;
  }
  return globalRepository;
}

export function setPurchaseRepository(repo: PurchaseRepository): void {
  globalRepository = repo;
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.purchaseRepository = repo;
  }
}

export async function disconnectPurchaseRepository(): Promise<void> {
  const repo = getPurchaseRepository();
  if (repo.disconnect) {
    await repo.disconnect();
  }
}

export function resetPurchaseRepository(): void {
  const repo = new PrismaPurchaseRepository();
  globalRepository = repo;
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.purchaseRepository = repo;
  }
}

export async function pingDatabase(): Promise<boolean> {
  try {
    const repo = getPurchaseRepository();
    if (typeof (repo as { ping?: () => Promise<boolean> }).ping === "function") {
      return await (repo as { ping: () => Promise<boolean> }).ping!();
    }
    await repo.getIdempotencyRecord("__health__", "ping", "probe");
    return true;
  } catch {
    return false;
  }
}
