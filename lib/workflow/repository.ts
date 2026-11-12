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
import {
  computeCanonicalDraftHash,
  verifyQuantityConfirmation,
  computeTokenHash,
} from "./quantity-confirmation";
import {
  NotFoundError,
  ForbiddenError,
  IllegalTransitionError,
  ApprovalIntegrityError,
  ValidationError,
  DatabaseUnavailableError,
  IdempotencyConflictError,
} from "./errors";
import { ProcurementLineItem } from "../discovery/cart/types";

export { DatabaseUnavailableError };

export interface ConvertDraftParams {
  readonly draftId: string;
  readonly actor: Actor;
  readonly actorId: string;
  readonly now: Date;
  readonly candidateTokens: string[];
  readonly purchaseId: string;
  readonly purchaseStatus: PurchaseStatus;
  readonly ownerUserId: string;
  readonly auditEvents: AuditEventDraft[];
  readonly idempotencyRecord?: IdempotencyRecord;
}

export interface ConvertDraftResult {
  readonly purchase: PurchaseRecord;
  readonly lineItems: readonly ProcurementLineItem[];
  readonly effectiveBudgetCents: number;
  readonly effectiveCurrency: Currency;
  readonly consumedTokenJtis: string[];
}

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
  originatingDraftId?: string | null;
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
    idempotencyRecord?: IdempotencyRecord,
    consumedTokenJtis?: string[]
  ): Promise<PurchaseRecord>;
  convertDraftToPurchase(params: ConvertDraftParams): Promise<ConvertDraftResult>;
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
    idempotencyRecord?: IdempotencyRecord,
    consumedTokenJtis?: string[]
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
          originatingDraftId: purchase.originatingDraftId ?? null,
          createdAt: purchase.createdAt,
          updatedAt: purchase.updatedAt,
        },
      });

      if (purchase.originatingDraftId) {
        await tx.procurementDraft.update({
          where: { id: purchase.originatingDraftId },
          data: { status: "CONVERTED", updatedAt: purchase.updatedAt },
        });
      }

      if (consumedTokenJtis && consumedTokenJtis.length > 0) {
        await tx.quantityConfirmation.updateMany({
          where: { tokenJti: { in: consumedTokenJtis } },
          data: {
            consumedAt: purchase.createdAt,
            consumedPurchaseId: created.id,
          },
        });
      }

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

  async convertDraftToPurchase(params: ConvertDraftParams): Promise<ConvertDraftResult> {
    const {
      draftId,
      actor,
      actorId,
      candidateTokens,
      purchaseId,
      purchaseStatus,
      ownerUserId,
      auditEvents,
      idempotencyRecord,
    } = params;

    void actor;
    const client = this.getClient();

    // Pre-validate all audit records before touching the database
    for (const draft of auditEvents) {
      validateRecord(draft);
    }

    return client.$transaction(async (tx) => {
      // 1. Acquire row lock on ProcurementDraft as first draft operation
      const rows = await tx.$queryRaw<Array<{
        id: string;
        actorId: string;
        version: number;
        budgetCents: number | null;
        currency: string;
        destination: unknown;
        lineItems: unknown;
        requirements: unknown;
        originalPrompt: string | null;
        draftHash: string;
        status: string;
        createdAt: Date;
        updatedAt: Date;
      }>>`
        SELECT * FROM "ProcurementDraft"
        WHERE "id" = ${draftId}
        FOR UPDATE
      `;

      // Obtain current timestamp strictly AFTER acquiring the row lock on ProcurementDraft.
      // This ensures any time spent waiting for a concurrent transaction to release the lock
      // is properly accounted for, preventing acceptance of tokens that expired during the lock wait.
      const lockAcquiredAt = new Date();
      const effectiveNow = lockAcquiredAt;

      const draft = rows[0];
      if (!draft) {
        throw new NotFoundError(`Procurement draft "${draftId}" not found.`);
      }

      // 2. Validate actor ownership
      if (draft.actorId !== actorId) {
        throw new ForbiddenError(`Actor "${actorId}" is not authorized to convert draft owned by "${draft.actorId}".`);
      }

      // 3. Validate status
      if (draft.status === "CONVERTED") {
        if (idempotencyRecord) {
          const committedIdem = await tx.idempotencyRecord.findUnique({
            where: {
              actorId_operation_key: {
                actorId,
                operation: idempotencyRecord.operation,
                key: idempotencyRecord.key,
              },
            },
          });
          if (committedIdem) {
            if (committedIdem.requestHash !== idempotencyRecord.requestHash) {
              throw new IdempotencyConflictError(
                `Idempotency key "${idempotencyRecord.key}" was previously used for operation "${idempotencyRecord.operation}" with different request parameters.`
              );
            }
            const body = committedIdem.responseBody as unknown as {
              id: string;
              status: string;
              budgetCents: number;
              currency: string;
              requirements: unknown;
              lineItems?: ProcurementLineItem[];
              policyVersion: string | null;
              policyEvidenceFingerprint: string | null;
              selectedCandidateId: string | null;
              ownerUserId: string;
              version: number;
              originatingDraftId?: string | null;
              selectedCandidate?: unknown;
              activeApproval?: unknown;
              createdAt: string;
              updatedAt: string;
            };
            return {
              purchase: {
                id: body.id,
                status: body.status as PurchaseStatus,
                requirements: body.requirements,
                budgetCents: body.budgetCents,
                currency: body.currency as Currency,
                policyVersion: body.policyVersion,
                policyEvidenceFingerprint: body.policyEvidenceFingerprint,
                selectedCandidateId: body.selectedCandidateId,
                ownerUserId: body.ownerUserId,
                version: body.version,
                originatingDraftId: body.originatingDraftId ?? draft.id,
                selectedCandidate: body.selectedCandidate as CandidateRecord | null,
                activeApproval: body.activeApproval as ApprovalRecord | null,
                createdAt: new Date(body.createdAt),
                updatedAt: new Date(body.updatedAt),
              },
              lineItems: body.lineItems ?? [],
              effectiveBudgetCents: body.budgetCents,
              effectiveCurrency: body.currency as Currency,
              consumedTokenJtis: [],
            };
          }
        }
        throw new IllegalTransitionError("draft_already_converted", "Draft has already been converted to a purchase.");
      }
      if (draft.status !== "ACTIVE" && draft.status !== "CONFIRMED") {
        throw new IllegalTransitionError("draft_not_active", `Draft cannot be converted in status "${draft.status}".`);
      }

      // 4. Validate canonical hash and version against locked draft
      const canonicalHash = computeCanonicalDraftHash({
        draftId: draft.id,
        version: draft.version,
        budgetCents: draft.budgetCents,
        currency: draft.currency,
        destination: draft.destination,
        lineItems: (draft.lineItems as unknown as readonly { id: string; title: string; quantity?: number; budgetCents?: number | null; requirements?: unknown }[]) || [],
        requirements: draft.requirements,
      });
      if (draft.draftHash !== canonicalHash) {
        throw new ApprovalIntegrityError("draft_integrity_mismatch", "Draft content integrity check failed. Hash mismatch.");
      }

      const draftLineItems = (draft.lineItems as unknown as ProcurementLineItem[]) || [];

      // 5. Decode and verify all candidate confirmation tokens
      const seenTokens = new Set<string>();
      for (const t of candidateTokens) {
        if (seenTokens.has(t)) {
          throw new ValidationError("Duplicate confirmation tokens detected in request.", [
            { code: "duplicate_confirmation_tokens", message: "Duplicate confirmation token provided." }
          ]);
        }
        seenTokens.add(t);
      }

      const unconfirmedItems = draftLineItems.filter(
        (li) =>
          li.quantityConfirmed === false ||
          li.quantitySource === "inferred" ||
          li.quantitySource === "unresolved" ||
          li.quantitySource === "manual_override"
      );

      if (unconfirmedItems.length > 0 && candidateTokens.length === 0) {
        throw new ValidationError("Missing required quantity confirmation tokens.", [
          { code: "unconfirmed_inferred_quantity", message: "Inferred or unverified quantity requires explicit buyer confirmation token." }
        ]);
      }

      const decodedTokens = candidateTokens.map((t) => {
        const claims = verifyQuantityConfirmation(t);
        if (!claims) {
          throw new ValidationError("Invalid or forged confirmation token.", [
            { code: "invalid_confirmation_token", message: "Token signature verification failed." }
          ]);
        }
        return { token: t, claims };
      });

      // Check for duplicate line item confirmations
      const confirmedLineItemIds = new Set<string>();
      for (const { claims } of decodedTokens) {
        if (confirmedLineItemIds.has(claims.lineItemId)) {
          throw new ValidationError(`Duplicate confirmation token for line item "${claims.lineItemId}".`, [
            { code: "duplicate_line_item_confirmation", message: `Line item "${claims.lineItemId}" confirmed multiple times.` }
          ]);
        }
        confirmedLineItemIds.add(claims.lineItemId);
      }

      // Check for unexpected extra tokens
      for (const { claims } of decodedTokens) {
        const matching = draftLineItems.find((li) => li.id === claims.lineItemId);
        if (!matching) {
          throw new ValidationError(`Unexpected extra confirmation token for line item "${claims.lineItemId}".`, [
            { code: "unexpected_confirmation_token", message: `Line item "${claims.lineItemId}" does not exist in draft.` }
          ]);
        }
      }

      // Check all unconfirmed items are covered
      for (const u of unconfirmedItems) {
        if (!confirmedLineItemIds.has(u.id)) {
          throw new ValidationError(`Line item "${u.id}" (${u.title}) requires buyer confirmation token.`, [
            { code: "unconfirmed_inferred_quantity", message: `Line item "${u.id}" has an unconfirmed quantity.` }
          ]);
        }
      }

      // Sort tokens deterministically by JTI
      decodedTokens.sort((a, b) => a.claims.jti.localeCompare(b.claims.jti));
      const tokenJtis = decodedTokens.map((t) => t.claims.jti);

      if (tokenJtis.length > 0) {
        const dbRecords = await tx.quantityConfirmation.findMany({
          where: { tokenJti: { in: tokenJtis } },
          orderBy: { tokenJti: "asc" },
        });

        if (dbRecords.length !== decodedTokens.length) {
          throw new ValidationError("One or more confirmation records not found in database.", [
            { code: "invalid_confirmation_token", message: "Durable confirmation record missing." }
          ]);
        }

        const dbMap = new Map(dbRecords.map((r) => [r.tokenJti, r]));

        for (const { token, claims } of decodedTokens) {
          const record = dbMap.get(claims.jti)!;

          if (computeTokenHash(token) !== record.tokenHash) {
            throw new ValidationError("Token hash does not match stored record hash.", [
              { code: "invalid_confirmation_token", message: "Token tampering detected." }
            ]);
          }
          if (claims.lineItemId !== record.lineItemId) {
            throw new ValidationError("Token line item does not match record.", [
              { code: "invalid_confirmation_token", message: "Line item mismatch." }
            ]);
          }
          if (claims.confirmedQuantity !== record.confirmedQuantity) {
            throw new ValidationError("Token confirmed quantity does not match record.", [
              { code: "confirmation_quantity_mismatch", message: "Quantity mismatch." }
            ]);
          }
          if (claims.draftId !== record.draftId || claims.draftVersion !== record.draftVersion || claims.draftHash !== record.draftHash) {
            throw new ValidationError("Token draft binding does not match record.", [
              { code: "confirmation_draft_mismatch", message: "Draft version/hash mismatch." }
            ]);
          }
          if (claims.draftHash !== draft.draftHash) {
            throw new ValidationError("Confirmation draft mismatch: Draft content has changed since confirmation.", [
              { code: "confirmation_draft_mismatch", message: "Draft content has changed since confirmation." }
            ]);
          }
          if (claims.actorId !== record.actorId || claims.actorId !== actorId) {
            throw new ValidationError("Confirmation actor mismatch.", [
              { code: "confirmation_actor_mismatch", message: "Actor mismatch." }
            ]);
          }
          if (record.consumedAt !== null) {
            throw new ValidationError("Confirmation token has already been consumed.", [
              { code: "token_already_consumed", message: "Token already consumed." }
            ]);
          }
          if (record.expiresAt < effectiveNow) {
            throw new ValidationError("Confirmation token has expired.", [
              { code: "token_expired", message: "Token expired." }
            ]);
          }
          const item = draftLineItems.find((li) => li.id === record.lineItemId);
          if (!item || item.quantity !== record.confirmedQuantity) {
            throw new ValidationError("Confirmed quantity does not match line item quantity.", [
              { code: "confirmation_quantity_mismatch", message: "Quantity mismatch with draft line item." }
            ]);
          }
        }
      }

      const finalLineItems = draftLineItems.map((li) => ({
        ...li,
        quantityConfirmed: true,
        confirmedAt: effectiveNow.toISOString(),
        confirmedBy: actorId,
      }));

      const finalRequirements = {
        lineItems: finalLineItems,
        ...(draft.destination ? { destination: draft.destination } : {}),
      };

      const effectiveBudgetCents = draft.budgetCents ?? 0;
      const effectiveCurrency = (draft.currency ?? "USD") as Currency;

      // 6. Write idempotency record if present (locking on unique constraint)
      const responseBody = {
        id: purchaseId,
        status: purchaseStatus,
        budgetCents: effectiveBudgetCents,
        currency: effectiveCurrency,
        requirements: finalLineItems,
        lineItems: finalLineItems,
        policyVersion: null,
        policyEvidenceFingerprint: null,
        selectedCandidateId: null,
        ownerUserId,
        version: 1,
        originatingDraftId: draft.id,
        selectedCandidate: null,
        activeApproval: null,
        createdAt: effectiveNow.toISOString(),
        updatedAt: effectiveNow.toISOString(),
      };

      if (idempotencyRecord) {
        await tx.idempotencyRecord.create({
          data: {
            id: idempotencyRecord.id,
            key: idempotencyRecord.key,
            actorId: idempotencyRecord.actorId,
            operation: idempotencyRecord.operation,
            requestHash: idempotencyRecord.requestHash,
            responseStatus: 201,
            responseBody: responseBody as Prisma.InputJsonValue,
            createdAt: idempotencyRecord.createdAt,
            expiresAt: idempotencyRecord.expiresAt,
          },
        });
      }

      // 7. Create Purchase record
      const created = await tx.purchase.create({
        data: {
          id: purchaseId,
          status: purchaseStatus,
          requirements: finalRequirements as Prisma.InputJsonValue,
          budgetCents: effectiveBudgetCents,
          currency: effectiveCurrency,
          policyVersion: null,
          policyEvidenceFingerprint: null,
          selectedCandidateId: null,
          ownerUserId,
          version: 1,
          originatingDraftId: draft.id,
          createdAt: effectiveNow,
          updatedAt: effectiveNow,
        },
      });

      // 8. Atomically and conditionally consume confirmation records (Requirement 2)
      if (tokenJtis.length > 0) {
        const updateResult = await tx.quantityConfirmation.updateMany({
          where: {
            tokenJti: { in: tokenJtis },
            consumedAt: null,
            draftId: draft.id,
            actorId: actorId,
          },
          data: {
            consumedAt: effectiveNow,
            consumedPurchaseId: created.id,
          },
        });

        if (updateResult.count !== tokenJtis.length) {
          throw new ValidationError("Token consumption failed: One or more tokens were already consumed or invalid.", [
            { code: "token_already_consumed", message: "Concurrent token consumption detected. Rolling back." }
          ]);
        }
      }

      // 9. Change draft status to CONVERTED
      await tx.procurementDraft.update({
        where: { id: draft.id },
        data: {
          status: "CONVERTED",
          updatedAt: effectiveNow,
        },
      });

      // 10. Write audit events
      const updatedAuditEvents = auditEvents.map((ae) => {
        if (ae.type === "proposed") {
          return {
            ...ae,
            payload: {
              budgetCents: effectiveBudgetCents,
              currency: effectiveCurrency,
              ...(draft.destination ? { destination: draft.destination } : {}),
              lineItems: finalLineItems,
            },
          };
        }
        return ae;
      });

      if (updatedAuditEvents.length > 0) {
        await tx.auditEvent.createMany({
          data: updatedAuditEvents.map((draftEvent) => ({
            purchaseId: draftEvent.purchaseId,
            type: draftEvent.type,
            actor: draftEvent.actor as unknown as Prisma.InputJsonValue,
            payload: draftEvent.payload as Prisma.InputJsonValue,
            createdAt: draftEvent.occurredAt,
          })),
        });
      }

      const purchaseRecord: PurchaseRecord = {
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
        originatingDraftId: created.originatingDraftId,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };

      return {
        purchase: purchaseRecord,
        lineItems: finalLineItems,
        effectiveBudgetCents,
        effectiveCurrency,
        consumedTokenJtis: tokenJtis,
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
        originatingDraftId: (() => {
          if (!("originatingDraftId" in purchase) || (purchase as Record<string, unknown>).originatingDraftId === undefined) {
            throw new Error(`Repository mapping failure: originatingDraftId is unexpectedly missing for purchase "${purchase.id}".`);
          }
          return purchase.originatingDraftId ?? null;
        })(),
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
          skipDuplicates: true,
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
    idempotencyRecord?: IdempotencyRecord,
    consumedTokenJtis?: string[]
  ): Promise<PurchaseRecord> {
    void consumedTokenJtis;
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

  async convertDraftToPurchase(params: ConvertDraftParams): Promise<ConvertDraftResult> {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (databaseUrl && databaseUrl.length > 0) {
      const prismaRepo = new PrismaPurchaseRepository();
      return prismaRepo.convertDraftToPurchase(params);
    }
    throw new Error("convertDraftToPurchase requires PostgreSQL database connection.");
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
        originatingDraftId: purchase.originatingDraftId ?? null,
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
    if (evidence.length > 0) {
      const existing = this.evidence.get(candidate.id) ?? [];
      const merged = [...existing];
      for (const e of evidence) {
        if (!merged.some((m) => m.id === e.id)) {
          merged.push({
            ...e,
            capturedAt:
              e.capturedAt instanceof Date && !isNaN(e.capturedAt.getTime()) ? e.capturedAt : new Date(0),
          });
        }
      }
      this.evidence.set(candidate.id, merged);
    }
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

export function getPrismaClient(): PrismaClient {
  const repo = getPurchaseRepository();
  if (repo instanceof PrismaPurchaseRepository) {
    return (repo as unknown as { getClient: () => PrismaClient }).getClient();
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new DatabaseUnavailableError();
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
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
