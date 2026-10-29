import {
  Actor,
  AuditEventDraft,
  CandidateFacts,
  Currency,
  InvalidationReason,
  PurchaseState,
  PurchaseStatus,
} from "../state/types";
import { transition } from "../state/transitions";
import {
  computeEvidenceFingerprint,
  computeSnapshotHash,
  EvidenceFingerprintItem,
  isValidEvidenceFingerprint,
} from "../state/snapshot";
import { evaluatePolicy, DEFAULT_POLICY_VERSION } from "../policy/evaluator";
import { EvidenceItemInput, RequiredAttributeSpec } from "../policy/types";
import { ParsedRequirement } from "../policy/rules/evidence";
import { normalizeCandidate } from "../discovery/normalize";
import {
  ingestCandidateEvidence,
  SourceObservation,
  UNKNOWN_TIMESTAMP_SENTINEL,
  UNKNOWN_TIMESTAMP_SENTINEL_ISO,
} from "../discovery/evidence";
import {
  ApproveMultiItemPlanRequest,
  ApprovePurchaseRequest,
  ApprovePurchaseResponse,
  AuditHistoryResponse,
  ConfirmBuyerApprovalRequest,
  CreateMultiItemPlanRequest,
  CreatePayPalOrderRequest,
  CreatePayPalOrderResponse,
  CreatePurchaseRequest,
  EvaluatePurchaseRequest,
  EvaluatePurchaseResponse,
  MultiItemPlanResponse,
  PurchaseResponse,
} from "./types";
import {
  convertLegacyRequirementsToLineItems,
  createMultiItemApprovalSnapshot,
  computeMultiItemSnapshotHash,
  generateProcurementStrategies,
  ProcurementLineItem,
  validateProcurementLineItems,
} from "../discovery/cart";
import { MultiItemApprovalSnapshot } from "../discovery/cart/types";
import { DestinationContext } from "../discovery/shipping";
import { Channel3SourceAdapter } from "../discovery/channel3-adapter";
import { SourceAdapter, ProductSearchRequest } from "../discovery/types";
import { deriveInvalidationReasons } from "../state/approval";
import { deriveTotalCents } from "../state/money";
import { getPayPalSandboxClient, PayPalSandboxClient, extractSafeApprovalLink } from "../paypal/client";
import {
  PayPalTimeoutError,
  PayPalUnknownOutcomeError,
  PayPalOrderResponse,
  PayPalGetOrderResponse,
  PayPalApiError,
} from "../paypal/types";
import { getMerchantPolicyRegistry } from "../discovery/merchant-policy-registry";
import { checkGeographicEligibility } from "../discovery/geographic-zones";
import { computePayloadHash } from "./idempotency";
import { IdempotencyConflictError } from "./errors";
import {
  PaymentVerificationService,
  PaymentVerificationResult,
} from "../paypal/verification";
import {
  ApprovalRecord,
  CandidateRecord,
  EvidenceItemRecord,
  getPurchaseRepository,
  PolicyResultRecord,
  PurchaseAggregate,
  PurchaseRecord,
  PurchaseRepository,
} from "./repository";
import { assertPurchaseAccess } from "./auth";
import { executeWithIdempotency, validateIdempotencyKey } from "./idempotency";

import {
  WorkflowError,
  NotFoundError,
  ValidationError,
  IllegalTransitionError,
  ApprovalIntegrityError,
  ConcurrencyConflictError,
} from "./errors";

export {
  WorkflowError,
  NotFoundError,
  ValidationError,
  IllegalTransitionError,
  ApprovalIntegrityError,
  ConcurrencyConflictError,
};

function generateId(prefix: string): string {
  const rand = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

/**
 * Safely converts an ingested evidence timestamp into a valid Date for persistence.
 * If the timestamp is missing, empty, malformed, unparseable, or already the sentinel,
 * it returns UNKNOWN_TIMESTAMP_SENTINEL (Unix epoch 0: 1970-01-01T00:00:00.000Z).
 * Never returns or constructs an Invalid Date instance.
 */
export function parseEvidenceCapturedAt(val: unknown): Date {
  if (val instanceof Date) {
    if (!isNaN(val.getTime()) && val.getTime() !== 0) {
      return val;
    }
    return UNKNOWN_TIMESTAMP_SENTINEL;
  }

  if (typeof val === "string" && val.trim().length > 0) {
    const trimmed = val.trim();
    if (trimmed === UNKNOWN_TIMESTAMP_SENTINEL_ISO) {
      return UNKNOWN_TIMESTAMP_SENTINEL;
    }
    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed) && parsed !== 0) {
      return new Date(parsed);
    }
  }

  return UNKNOWN_TIMESTAMP_SENTINEL;
}

function candidateRecordToFacts(c: CandidateRecord): CandidateFacts {
  return {
    id: c.id,
    purchaseId: c.purchaseId,
    source: c.source,
    unitPriceCents: c.unitPriceCents,
    quantity: c.quantity,
    shippingCents: c.shippingCents,
    totalCents: c.totalCents,
    currency: "USD",
    snapshotHash: c.snapshotHash,
  };
}

function buildPurchaseResponse(aggregate: PurchaseAggregate): PurchaseResponse {
  const { purchase, selectedCandidate, approvals } = aggregate;
  const activeApproval = approvals.find((a) => a.invalidatedAt === null) ?? null;
  const liveAttempt = aggregate.paymentAttempts?.find((a) => a.status === "OPEN") ?? null;

  let lineItems: readonly ProcurementLineItem[] | undefined;
  if (Array.isArray(purchase.requirements)) {
    lineItems = convertLegacyRequirementsToLineItems(
      purchase.requirements,
      purchase.budgetCents,
      purchase.currency as Currency
    );
  } else if (
    purchase.requirements &&
    typeof purchase.requirements === "object" &&
    Array.isArray((purchase.requirements as { lineItems?: unknown }).lineItems)
  ) {
    lineItems = (purchase.requirements as { lineItems: readonly ProcurementLineItem[] }).lineItems;
  }

  let destination: DestinationContext | undefined;
  if (
    purchase.requirements &&
    typeof purchase.requirements === "object" &&
    "destination" in (purchase.requirements as Record<string, unknown>)
  ) {
    destination = (purchase.requirements as { destination: DestinationContext }).destination;
  }

  let multiItemSnapshot: MultiItemApprovalSnapshot | null = null;
  if (
    purchase.requirements &&
    typeof purchase.requirements === "object" &&
    "approvedStrategy" in (purchase.requirements as Record<string, unknown>)
  ) {
    multiItemSnapshot = (purchase.requirements as { approvedStrategy: MultiItemApprovalSnapshot }).approvedStrategy;
    const latestApproval = aggregate.approvals[aggregate.approvals.length - 1];
    if (latestApproval?.invalidatedAt) {
      multiItemSnapshot = {
        ...multiItemSnapshot,
        invalidatedAt: latestApproval.invalidatedAt.toISOString(),
        invalidationReason: latestApproval.invalidationReason,
      };
    }
  }

  return {
    id: purchase.id,
    status: purchase.status,
    budgetCents: purchase.budgetCents,
    currency: purchase.currency,
    requirements: Array.isArray(purchase.requirements) ? purchase.requirements : (lineItems ?? []),
    lineItems,
    destination,
    multiItemSnapshot,
    policyVersion: purchase.policyVersion,
    policyEvidenceFingerprint: purchase.policyEvidenceFingerprint,
    selectedCandidateId: purchase.selectedCandidateId,
    ownerUserId: purchase.ownerUserId,
    version: purchase.version,
    selectedCandidate: selectedCandidate
      ? {
          id: selectedCandidate.id,
          externalId: selectedCandidate.externalId,
          title: selectedCandidate.title,
          merchantName: selectedCandidate.merchantName,
          merchantUrl: selectedCandidate.merchantUrl,
          unitPriceCents: selectedCandidate.unitPriceCents,
          quantity: selectedCandidate.quantity,
          shippingCents: selectedCandidate.shippingCents,
          totalCents: selectedCandidate.totalCents,
          currency: selectedCandidate.currency,
          availability: selectedCandidate.availability,
          snapshotHash: selectedCandidate.snapshotHash,
          capturedAt: selectedCandidate.capturedAt.toISOString(),
        }
      : null,
    activeApproval: activeApproval
      ? {
          id: activeApproval.id,
          candidateId: activeApproval.candidateId,
          snapshotHash: activeApproval.snapshotHash,
          totalCents: activeApproval.totalCents,
          currency: activeApproval.currency,
          policyVersion: activeApproval.policyVersion,
          evidenceFingerprint: activeApproval.evidenceFingerprint,
          approverUserId: activeApproval.approverUserId,
          approvedAt: activeApproval.approvedAt.toISOString(),
        }
      : null,
    livePaymentAttempt: liveAttempt
      ? {
          id: liveAttempt.id,
          paypalOrderId: liveAttempt.paypalOrderId,
          status: liveAttempt.status,
          requestedIntent: liveAttempt.requestedIntent ?? null,
          verifiedStatus: liveAttempt.verifiedStatus,
          verifiedAt: liveAttempt.verifiedAt ? liveAttempt.verifiedAt.toISOString() : null,
        }
      : null,
    createdAt: purchase.createdAt.toISOString(),
    updatedAt: purchase.updatedAt.toISOString(),
  };
}

export function aggregateToState(aggregate: PurchaseAggregate): PurchaseState {
  const selectedCandidate = aggregate.selectedCandidate
    ? candidateRecordToFacts(aggregate.selectedCandidate)
    : null;

  return {
    purchaseId: aggregate.purchase.id,
    status: aggregate.purchase.status,
    budgetCents: aggregate.purchase.budgetCents,
    currency: "USD",
    policyVersion: aggregate.purchase.policyVersion,
    requiredRuleKeys: [],
    selectedCandidate,
    currentEvidenceFingerprint: aggregate.purchase.policyEvidenceFingerprint,
    policyEvidenceFingerprint: aggregate.purchase.policyEvidenceFingerprint,
    approvals: aggregate.approvals.map((a) => ({
      id: a.id,
      purchaseId: a.purchaseId,
      candidateId: a.candidateId,
      snapshotHash: a.snapshotHash,
      totalCents: a.totalCents,
      currency: a.currency,
      policyVersion: a.policyVersion,
      evidenceFingerprint: a.evidenceFingerprint,
      approverUserId: a.approverUserId,
      approvedAt: a.approvedAt,
      invalidatedAt: a.invalidatedAt,
      invalidationReason: a.invalidationReason,
    })),
    paymentAttempts: (aggregate.paymentAttempts ?? []).map((pa) => ({
      id: pa.id,
      purchaseId: pa.purchaseId,
      approvalId: pa.approvalId,
      idempotencyKey: pa.idempotencyKey,
      paypalOrderId: pa.paypalOrderId,
      status: pa.status,
      requestedIntent: pa.requestedIntent ?? null,
      verifiedStatus: pa.verifiedStatus,
      verifiedAt: pa.verifiedAt,
      failureReason: pa.failureReason,
    })),
  };
}

export class PurchaseWorkflowService {
  private inFlightOrderCreations = new Map<string, Promise<CreatePayPalOrderResponse>>();

  constructor(
    private readonly repo: PurchaseRepository = getPurchaseRepository(),
    private readonly payPalClient: PayPalSandboxClient = getPayPalSandboxClient(),
    private readonly discoveryAdapter: SourceAdapter = new Channel3SourceAdapter()
  ) {}

  /**
   * Create a new purchase request with validated structured requirements.
   * Supports durable idempotency if idempotencyKey is supplied.
   */
  async createPurchase(
    req: CreatePurchaseRequest,
    actor: Actor,
    now: Date = new Date()
  ): Promise<PurchaseResponse> {
    const actorId = actor.kind === "user" ? actor.userId : actor.component;
    const validatedKey = req.idempotencyKey ? validateIdempotencyKey(req.idempotencyKey) : null;

    const execution = await executeWithIdempotency<PurchaseResponse>(this.repo, {
      actorId,
      operation: "create_purchase",
      idempotencyKey: validatedKey,
      payload: req,
      now,
      execute: async (idempotencyDraft) => {
        const purchaseId = generateId("pur");

        const draftState: PurchaseState = {
          purchaseId,
          status: "DRAFT",
          budgetCents: req.budgetCents,
          currency: "USD",
          policyVersion: null,
          requiredRuleKeys: [],
          selectedCandidate: null,
          currentEvidenceFingerprint: null,
          policyEvidenceFingerprint: null,
          approvals: [],
          paymentAttempts: [],
        };

        const auditEvents: AuditEventDraft[] = [
          {
            type: "proposed",
            purchaseId,
            actor,
            occurredAt: now,
            payload: {
              budgetCents: req.budgetCents,
              currency: "USD",
              ...(req.destination ? { destination: req.destination } : {}),
            },
          },
        ];

        let finalStatus: PurchaseStatus = "DRAFT";

        if (req.confirmImmediately !== false) {
          const transResult = transition(draftState, { kind: "confirm_requirements" }, { actor, now });
          if (!transResult.ok) {
            throw new IllegalTransitionError(transResult.error.code, transResult.error.message);
          }
          finalStatus = transResult.next.status;
          auditEvents.push(...transResult.events);
        }

        const ownerUserId = actor.kind === "user" ? actor.userId : "local_dev_user";

        let finalRequirements: unknown = req.requirements;
        let lineItems: readonly ProcurementLineItem[] | undefined;

        if (req.lineItems && req.lineItems.length > 0) {
          const valResult = validateProcurementLineItems(req.lineItems, req.currency);
          if (!valResult.ok) {
            throw new ValidationError("Invalid multi-item procurement line items", valResult.errors);
          }
          lineItems = valResult.lineItems;
          finalRequirements = {
            lineItems: valResult.lineItems,
            ...(req.destination ? { destination: req.destination } : {}),
          };
        } else if (req.requirements) {
          lineItems = convertLegacyRequirementsToLineItems(
            req.requirements,
            req.budgetCents,
            req.currency,
            req.requestedQuantity ?? 1
          );
        }

        const purchaseRecord: PurchaseRecord = {
          id: purchaseId,
          status: finalStatus,
          requirements: finalRequirements,
          budgetCents: req.budgetCents,
          currency: "USD",
          policyVersion: null,
          policyEvidenceFingerprint: null,
          selectedCandidateId: null,
          ownerUserId,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };

        const plannedResponse: PurchaseResponse = {
          id: purchaseRecord.id,
          status: purchaseRecord.status,
          budgetCents: purchaseRecord.budgetCents,
          currency: purchaseRecord.currency,
          requirements: Array.isArray(req.requirements) ? req.requirements : (lineItems ?? []),
          lineItems,
          policyVersion: purchaseRecord.policyVersion,
          policyEvidenceFingerprint: purchaseRecord.policyEvidenceFingerprint,
          selectedCandidateId: purchaseRecord.selectedCandidateId,
          ownerUserId: purchaseRecord.ownerUserId,
          version: purchaseRecord.version,
          selectedCandidate: null,
          activeApproval: null,
          createdAt: purchaseRecord.createdAt.toISOString(),
          updatedAt: purchaseRecord.updatedAt.toISOString(),
        };

        let recordToPersist = undefined;
        if (idempotencyDraft) {
          recordToPersist = {
            ...idempotencyDraft,
            responseStatus: 201,
            responseBody: plannedResponse,
          };
        }

        await this.repo.createPurchase(purchaseRecord, auditEvents, recordToPersist);

        return {
          status: 201,
          body: plannedResponse,
          persistedAtomically: !!recordToPersist,
        };
      },
    });

    return execution.body;
  }

  /**
   * Retrieve a purchase and its permitted workflow details.
   * If actor is supplied, enforces server-side access authorization.
   */
  async getPurchase(id: string, actor?: Actor): Promise<PurchaseResponse> {
    const aggregate = await this.repo.getPurchaseById(id);
    if (!aggregate) {
      throw new NotFoundError(`Purchase with id "${id}" not found.`);
    }

    if (actor) {
      assertPurchaseAccess(actor, aggregate.purchase.ownerUserId, "read");
    }

    return buildPurchaseResponse(aggregate);
  }

  /**
   * Evaluate a candidate against the purchase requirements using deterministic policy engine.
   */
  async evaluatePurchaseCandidate(
    purchaseId: string,
    req: EvaluatePurchaseRequest,
    actor: Actor,
    now: Date = new Date()
  ): Promise<EvaluatePurchaseResponse> {
    const aggregate = await this.repo.getPurchaseById(purchaseId);
    if (!aggregate) {
      throw new NotFoundError(`Purchase with id "${purchaseId}" not found.`);
    }

    assertPurchaseAccess(actor, aggregate.purchase.ownerUserId, "evaluate");

    const expectedVersion = req.expectedVersion ?? aggregate.purchase.version;
    if (req.expectedVersion !== undefined && req.expectedVersion !== aggregate.purchase.version) {
      throw new ConcurrencyConflictError(
        `Concurrency conflict: expected version "${req.expectedVersion}", but current version is "${aggregate.purchase.version}".`
      );
    }

    let candidateFacts: CandidateFacts;
    let candidateRecordForEval: CandidateRecord;
    let evidenceItemsForPolicy: EvidenceItemInput[];
    let evidenceFingerprint: string;

    const auditEventsToAppend: AuditEventDraft[] = [];

    // Step 1: Process candidate data (either raw candidate or existing candidate)
    if (req.rawCandidate) {
      const normalizedCandidate = normalizeCandidate(req.rawCandidate, {
        purchaseId,
        source: "channel3",
        now,
        candidateId: req.candidateId,
      });

      if (!normalizedCandidate.isComplete) {
        throw new ValidationError("Candidate normalization failed", normalizedCandidate.validationErrors);
      }

      // Destination consistency verification between purchase request and candidate quote
      const purchaseAuditEvents = await this.repo.getAuditHistory(purchaseId);
      const proposedEvent = purchaseAuditEvents.find((e) => e.type === "proposed");
      const purchaseDest = (
        proposedEvent?.payload as { destination?: { postalCode?: string } } | undefined
      )?.destination?.postalCode?.trim();
      const candidateDest = normalizedCandidate.shippingDetails?.destinationPostalCode?.trim();

      if (purchaseDest && candidateDest && purchaseDest !== candidateDest) {
        throw new ValidationError(
          `Candidate quote destination "${candidateDest}" does not match purchase delivery destination "${purchaseDest}".`
        );
      }

      const rawReqs = Array.isArray(aggregate.purchase.requirements)
        ? aggregate.purchase.requirements
        : [];

      const ingestion = ingestCandidateEvidence({
        candidate: normalizedCandidate,
        rawObservations: req.rawObservations as readonly SourceObservation[] | Record<string, unknown> | undefined,
        requiredAttributes: rawReqs as readonly (string | ParsedRequirement | Record<string, unknown>)[],
        now,
      });

      evidenceFingerprint = ingestion.evidenceFingerprint;

      const candidateRecord: CandidateRecord = {
        id: normalizedCandidate.id,
        purchaseId,
        source: normalizedCandidate.source,
        externalId: normalizedCandidate.externalId,
        title: normalizedCandidate.title,
        merchantName: normalizedCandidate.merchantName,
        merchantUrl: normalizedCandidate.merchantUrl,
        unitPriceCents: normalizedCandidate.unitPriceCents,
        quantity: normalizedCandidate.quantity,
        shippingCents: normalizedCandidate.shippingCents,
        totalCents: normalizedCandidate.totalCents,
        currency: "USD",
        availability: normalizedCandidate.availability,
        capturedAt: normalizedCandidate.capturedAt,
        snapshotHash: normalizedCandidate.snapshotHash,
      };

      const evidenceRecords: EvidenceItemRecord[] = ingestion.evidenceRecords.map((e) => ({
        id: e.id,
        candidateId: normalizedCandidate.id,
        requirementKey: e.requirementKey,
        value: typeof e.value === "string" ? e.value : JSON.stringify(e.value),
        sourceUrl: e.sourceUrl,
        sourceType: e.sourceType,
        capturedAt: parseEvidenceCapturedAt(e.capturedAt),
        status: e.status,
      }));

      await this.repo.saveCandidateWithEvidence(candidateRecord, evidenceRecords);

      candidateFacts = candidateRecordToFacts(candidateRecord);
      candidateRecordForEval = candidateRecord;

      evidenceItemsForPolicy = ingestion.evidenceRecords.map((e) => ({
        id: e.id,
        candidateId: e.candidateId,
        requirementKey: e.requirementKey,
        value: e.value,
        sourceUrl: e.sourceUrl,
        sourceType: e.sourceType,
        capturedAt: e.capturedAt,
        status: e.status,
      }));
    } else if (req.candidateId) {
      const existingCand = aggregate.candidates.find((c) => c.id === req.candidateId);
      if (!existingCand) {
        throw new ValidationError(`Candidate with id "${req.candidateId}" not found for this purchase.`);
      }

      candidateFacts = candidateRecordToFacts(existingCand);
      candidateRecordForEval = existingCand;

      const existingEvidence = aggregate.evidence.filter((e) => e.candidateId === req.candidateId);
      evidenceItemsForPolicy = existingEvidence.map((e) => ({
        id: e.id,
        candidateId: e.candidateId,
        requirementKey: e.requirementKey,
        value: e.value,
        sourceUrl: e.sourceUrl,
        sourceType: e.sourceType,
        capturedAt:
          e.capturedAt instanceof Date && !isNaN(e.capturedAt.getTime()) && e.capturedAt.getTime() !== 0
            ? e.capturedAt.toISOString()
            : "",
        status: e.status,
      }));

      const hasIncompleteOrInvalidEvidence = existingEvidence.some(
        (e) =>
          e.status === "missing" ||
          !(e.capturedAt instanceof Date) ||
          isNaN(e.capturedAt.getTime()) ||
          e.capturedAt.getTime() === 0
      );

      if (!hasIncompleteOrInvalidEvidence && existingEvidence.length > 0) {
        try {
          const fpItems: EvidenceFingerprintItem[] = existingEvidence.map((e) => ({
            requirementKey: e.requirementKey,
            value: e.value,
            sourceUrl: e.sourceUrl,
            sourceType: e.sourceType,
            capturedAt: e.capturedAt.toISOString(),
            status: e.status,
          }));
          evidenceFingerprint = computeEvidenceFingerprint(fpItems);
        } catch {
          evidenceFingerprint = "";
        }
      } else if (existingEvidence.length === 0) {
        evidenceFingerprint = computeEvidenceFingerprint([]);
      } else {
        evidenceFingerprint = "";
      }
    } else {
      throw new ValidationError("Must provide rawCandidate or candidateId for evaluation.");
    }

    // Step 2: Assemble in-memory PurchaseState to check state machine transition
    let currentState: PurchaseState = {
      purchaseId: aggregate.purchase.id,
      status: aggregate.purchase.status,
      budgetCents: aggregate.purchase.budgetCents,
      currency: aggregate.purchase.currency,
      policyVersion: aggregate.purchase.policyVersion,
      requiredRuleKeys: req.requiredRuleKeys ?? [],
      selectedCandidate: aggregate.selectedCandidate ? candidateRecordToFacts(aggregate.selectedCandidate) : null,
      currentEvidenceFingerprint: aggregate.purchase.policyEvidenceFingerprint,
      policyEvidenceFingerprint: aggregate.purchase.policyEvidenceFingerprint,
      approvals: aggregate.approvals.map((a) => ({
        id: a.id,
        purchaseId: a.purchaseId,
        candidateId: a.candidateId,
        snapshotHash: a.snapshotHash,
        totalCents: a.totalCents,
        currency: a.currency,
        policyVersion: a.policyVersion,
        evidenceFingerprint: a.evidenceFingerprint,
        approverUserId: a.approverUserId,
        approvedAt: a.approvedAt,
        invalidatedAt: a.invalidatedAt,
        invalidationReason: a.invalidationReason,
      })),
      paymentAttempts: [],
    };

    const needsCandidateSelection =
      currentState.status !== "EVALUATED" ||
      !currentState.selectedCandidate ||
      currentState.selectedCandidate.id !== candidateFacts.id;

    if (needsCandidateSelection) {
      const selectResult = transition(
        currentState,
        {
          kind: "select_candidate",
          candidate: candidateFacts,
          policyVersion: DEFAULT_POLICY_VERSION,
        },
        { actor, now }
      );

      if (!selectResult.ok) {
        throw new IllegalTransitionError(selectResult.error.code, selectResult.error.message);
      }

      currentState = selectResult.next;
      auditEventsToAppend.push(...selectResult.events);
    }

    currentState = {
      ...currentState,
      currentEvidenceFingerprint: evidenceFingerprint,
    };

    // Step 3: Run deterministic policy evaluator
    const rawReqs = Array.isArray(aggregate.purchase.requirements)
      ? aggregate.purchase.requirements
      : [];

    const evalResult = evaluatePolicy({
      candidate: {
        id: candidateFacts.id,
        purchaseId: candidateFacts.purchaseId,
        source: candidateFacts.source,
        externalId: candidateRecordForEval.externalId,
        title: candidateRecordForEval.title,
        merchantName: candidateRecordForEval.merchantName,
        merchantUrl: candidateRecordForEval.merchantUrl,
        unitPriceCents: candidateFacts.unitPriceCents,
        quantity: candidateFacts.quantity,
        shippingCents: candidateFacts.shippingCents,
        totalCents: candidateFacts.totalCents,
        currency: candidateFacts.currency,
        availability: candidateRecordForEval.availability,
        snapshotHash: candidateFacts.snapshotHash,
      },
      purchase: {
        id: aggregate.purchase.id,
        budgetCents: aggregate.purchase.budgetCents,
        currency: aggregate.purchase.currency,
        requestedQuantity: candidateFacts.quantity,
        requiredAttributes: rawReqs as readonly (string | RequiredAttributeSpec)[],
      },
      evidence: evidenceItemsForPolicy,
      config: {
        requiredRuleKeys: req.requiredRuleKeys,
        maxEvidenceAgeMs: req.maxEvidenceAgeMs,
      },
      now,
      policyVersion:
        req.policyVersion ??
        (typeof req.rawCandidate?.policyVersion === "string" ? req.rawCandidate.policyVersion : undefined) ??
        DEFAULT_POLICY_VERSION,
    });

    // Step 4: Apply policy summary through state machine
    const applyResult = transition(
      currentState,
      {
        kind: "apply_policy_summary",
        summary: evalResult.summary,
        policyVersion: evalResult.policyVersion,
      },
      { actor, now }
    );

    if (!applyResult.ok) {
      throw new IllegalTransitionError(applyResult.error.code, applyResult.error.message);
    }

    auditEventsToAppend.push(...applyResult.events);

    // Step 5: Save policy results and update purchase state atomically
    const policyResultRecords: PolicyResultRecord[] = Object.values(evalResult.ruleResults).map((r) => ({
      id: generateId("polres"),
      purchaseId,
      policyVersion: evalResult.policyVersion,
      ruleKey: r.ruleKey,
      outcome: r.outcome,
      detail: r.explanation ? JSON.stringify(r.explanation) : null,
      evaluatedAt: evalResult.evaluatedAt,
    }));

    try {
      await this.repo.recordEvaluation({
        purchaseId,
        expectedStatus: aggregate.purchase.status,
        expectedVersion,
        nextStatus: applyResult.next.status,
        selectedCandidateId: candidateFacts.id,
        policyVersion: evalResult.policyVersion,
        policyEvidenceFingerprint: evidenceFingerprint,
        policyResults: policyResultRecords,
        auditEvents: auditEventsToAppend,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("Concurrency conflict")) {
        throw new ConcurrencyConflictError(err.message);
      }
      throw err;
    }

    return {
      purchaseId,
      status: applyResult.next.status,
      version: expectedVersion + 1,
      summary: evalResult.summary,
      ruleResults: evalResult.ruleResults,
      candidateId: candidateFacts.id,
      snapshotHash: candidateFacts.snapshotHash,
      evidenceFingerprint,
      evaluatedAt: evalResult.evaluatedAt.toISOString(),
    };
  }

  /**
   * Record buyer approval bound strictly to the evaluated snapshot.
   */
  async approvePurchase(
    purchaseId: string,
    req: ApprovePurchaseRequest,
    actor: Actor,
    now: Date = new Date()
  ): Promise<ApprovePurchaseResponse> {
    if (actor.kind !== "user") {
      throw new ValidationError("Only a user actor can approve a purchase.");
    }

    const aggregate = await this.repo.getPurchaseById(purchaseId);
    if (!aggregate) {
      throw new NotFoundError(`Purchase with id "${purchaseId}" not found.`);
    }

    assertPurchaseAccess(actor, aggregate.purchase.ownerUserId, "approve");

    const expectedVersion = req.expectedVersion ?? aggregate.purchase.version;
    if (req.expectedVersion !== undefined && req.expectedVersion !== aggregate.purchase.version) {
      throw new ConcurrencyConflictError(
        `Concurrency conflict: expected version "${req.expectedVersion}", but current version is "${aggregate.purchase.version}".`
      );
    }

    if (aggregate.purchase.status !== "POLICY_PASSED") {
      throw new IllegalTransitionError(
        "illegal_transition",
        `Cannot approve purchase in status "${aggregate.purchase.status}". Only POLICY_PASSED purchases can be approved.`
      );
    }

    if (!aggregate.selectedCandidate) {
      throw new ApprovalIntegrityError("missing_candidate", "No candidate selected for approval.");
    }

    const selectedCand = aggregate.selectedCandidate;

    // Strict Approval Integrity Checks:
    // 1. Snapshot hash
    if (req.expectedSnapshotHash && req.expectedSnapshotHash !== selectedCand.snapshotHash) {
      throw new ApprovalIntegrityError(
        "snapshot_hash_mismatch",
        `Expected snapshot hash "${req.expectedSnapshotHash}" does not match authoritative candidate snapshot hash "${selectedCand.snapshotHash}".`
      );
    }

    // 2. Evidence fingerprint
    const authoritativeFp = aggregate.purchase.policyEvidenceFingerprint;
    if (!authoritativeFp || !isValidEvidenceFingerprint(authoritativeFp)) {
      throw new ApprovalIntegrityError(
        "evidence_fingerprint_invalid",
        `Authoritative policy evidence fingerprint "${authoritativeFp}" is missing or not a valid 64-character lowercase hex string.`
      );
    }

    if (
      req.expectedEvidenceFingerprint &&
      req.expectedEvidenceFingerprint !== authoritativeFp
    ) {
      throw new ApprovalIntegrityError(
        "evidence_fingerprint_mismatch",
        `Expected evidence fingerprint "${req.expectedEvidenceFingerprint}" does not match authoritative policy evidence fingerprint "${authoritativeFp}".`
      );
    }

    // 3. Total cents
    if (req.expectedTotalCents !== undefined && req.expectedTotalCents !== selectedCand.totalCents) {
      throw new ApprovalIntegrityError(
        "amount_mismatch",
        `Expected total cents "${req.expectedTotalCents}" does not match candidate total cents "${selectedCand.totalCents}".`
      );
    }

    // 4. Currency
    if (req.expectedCurrency && req.expectedCurrency !== selectedCand.currency) {
      throw new ApprovalIntegrityError(
        "currency_mismatch",
        `Expected currency "${req.expectedCurrency}" does not match candidate currency "${selectedCand.currency}".`
      );
    }

    // 5. Policy version
    if (req.policyVersion && req.policyVersion !== aggregate.purchase.policyVersion) {
      throw new ApprovalIntegrityError(
        "policy_version_mismatch",
        `Expected policy version "${req.policyVersion}" does not match evaluated policy version "${aggregate.purchase.policyVersion}".`
      );
    }

    // 6. Destination consistency check
    if (req.expectedDestination?.postalCode) {
      const expectedPostal = req.expectedDestination.postalCode.trim();
      const candDest = aggregate.evidence
        ?.find((e) => e.candidateId === selectedCand.id && e.requirementKey === "destination")
        ?.value?.trim();
      if (candDest && candDest !== expectedPostal) {
        throw new ApprovalIntegrityError(
          "destination_changed",
          `Expected destination "${expectedPostal}" does not match candidate evaluated destination "${candDest}".`
        );
      }
    }

    // Reconstruct state for transition
    const candFacts = candidateRecordToFacts(selectedCand);
    const currentState: PurchaseState = {
      purchaseId: aggregate.purchase.id,
      status: aggregate.purchase.status,
      budgetCents: aggregate.purchase.budgetCents,
      currency: "USD",
      policyVersion: aggregate.purchase.policyVersion,
      requiredRuleKeys: [],
      selectedCandidate: candFacts,
      currentEvidenceFingerprint: aggregate.purchase.policyEvidenceFingerprint,
      policyEvidenceFingerprint: aggregate.purchase.policyEvidenceFingerprint,
      approvals: aggregate.approvals.map((a) => ({
        id: a.id,
        purchaseId: a.purchaseId,
        candidateId: a.candidateId,
        snapshotHash: a.snapshotHash,
        totalCents: a.totalCents,
        currency: a.currency,
        policyVersion: a.policyVersion,
        evidenceFingerprint: a.evidenceFingerprint,
        approverUserId: a.approverUserId,
        approvedAt: a.approvedAt,
        invalidatedAt: a.invalidatedAt,
        invalidationReason: a.invalidationReason,
      })),
      paymentAttempts: [],
    };

    const newApprovalId = generateId("appr");

    const transResult = transition(
      currentState,
      { kind: "approve" },
      {
        actor,
        now,
        newApprovalId,
      }
    );

    if (!transResult.ok) {
      throw new IllegalTransitionError(transResult.error.code, transResult.error.message);
    }

    const approvalRecord: ApprovalRecord = {
      id: newApprovalId,
      purchaseId,
      candidateId: selectedCand.id,
      snapshotHash: selectedCand.snapshotHash,
      totalCents: selectedCand.totalCents,
      currency: selectedCand.currency,
      policyVersion: aggregate.purchase.policyVersion!,
      evidenceFingerprint: aggregate.purchase.policyEvidenceFingerprint!,
      approverUserId: actor.userId,
      approvedAt: now,
      invalidatedAt: null,
      invalidationReason: null,
    };

    try {
      await this.repo.recordApproval({
        purchaseId,
        expectedStatus: "POLICY_PASSED",
        expectedVersion,
        nextStatus: "APPROVED",
        approval: approvalRecord,
        auditEvents: transResult.events,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("Concurrency conflict")) {
        throw new ConcurrencyConflictError(err.message);
      }
      throw err;
    }

    return {
      purchaseId,
      status: "APPROVED",
      version: expectedVersion + 1,
      approvalId: newApprovalId,
      candidateId: selectedCand.id,
      snapshotHash: selectedCand.snapshotHash,
      evidenceFingerprint: aggregate.purchase.policyEvidenceFingerprint!,
      totalCents: selectedCand.totalCents,
      currency: selectedCand.currency,
      policyVersion: aggregate.purchase.policyVersion!,
      approverUserId: actor.userId,
      approvedAt: now.toISOString(),
    };
  }

  /**
   * Retrieve audit history for a purchase.
   * If actor is supplied, enforces server-side access authorization.
   */
  async getAuditHistory(purchaseId: string, actor?: Actor): Promise<AuditHistoryResponse> {
    const aggregate = await this.repo.getPurchaseById(purchaseId);
    if (!aggregate) {
      throw new NotFoundError(`Purchase with id "${purchaseId}" not found.`);
    }

    if (actor) {
      assertPurchaseAccess(actor, aggregate.purchase.ownerUserId, "audit");
    }

    const records = await this.repo.getAuditHistory(purchaseId);

    return {
      purchaseId,
      events: records.map((r) => ({
        id: r.id,
        purchaseId: r.purchaseId,
        type: r.type,
        actor: r.actor,
        payload: r.payload,
        occurredAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Creates a PayPal Sandbox order only after verifying active approval,
   * snapshot consistency, policy success, and matching purchase terms.
   */
  async createPayPalOrder(
    purchaseId: string,
    actor: Actor,
    options?: CreatePayPalOrderRequest
  ): Promise<CreatePayPalOrderResponse> {
    const inFlight = this.inFlightOrderCreations.get(purchaseId);
    if (inFlight) {
      return inFlight;
    }

    const task = this.executeCreatePayPalOrder(purchaseId, actor, options);
    this.inFlightOrderCreations.set(purchaseId, task);
    try {
      return await task;
    } finally {
      this.inFlightOrderCreations.delete(purchaseId);
    }
  }

  private async executeCreatePayPalOrder(
    purchaseId: string,
    actor: Actor,
    options?: CreatePayPalOrderRequest
  ): Promise<CreatePayPalOrderResponse> {
    const aggregate = await this.repo.getPurchaseById(purchaseId);
    if (!aggregate) {
      throw new NotFoundError(`Purchase with id "${purchaseId}" not found.`);
    }

    // 1. Ownership & authorization check
    assertPurchaseAccess(actor, aggregate.purchase.ownerUserId, "create_order");

    const actorId = actor.kind === "user" ? actor.userId : "system";

    // 1b. Early Idempotency Check: if caller provided an idempotency key, verify hash matches
    if (options?.idempotencyKey) {
      const validatedKey = validateIdempotencyKey(options.idempotencyKey);
      if (validatedKey) {
        const existingIdem = await this.repo.getIdempotencyRecord(actorId, "create_paypal_order", validatedKey);
        if (existingIdem) {
          const eff = aggregate.approvals.find((a) => a.invalidatedAt === null);
          const requestPayload = {
            purchaseId,
            approvalId: eff?.id ?? "",
            amountCents: eff?.totalCents ?? aggregate.purchase.budgetCents,
            currency: eff?.currency ?? aggregate.purchase.currency,
          };
          const reqHash = computePayloadHash(requestPayload);
          if (existingIdem.requestHash !== reqHash) {
            throw new IdempotencyConflictError(
              `Idempotency key "${validatedKey}" was previously used for operation "create_paypal_order" with different request parameters.`
            );
          }
          if (existingIdem.responseBody) {
            return existingIdem.responseBody as CreatePayPalOrderResponse;
          }
        }
      }
    }

    // 2. Idempotent recovery: If status is already ORDER_CREATED, return existing attempt
    if (aggregate.purchase.status === "ORDER_CREATED") {
      const liveAttempt = aggregate.paymentAttempts.find((a) => a.status === "OPEN");
      if (liveAttempt && liveAttempt.paypalOrderId) {
        let approvalUrl: string | null = null;
        try {
          const remoteOrder = await this.payPalClient.getOrder(liveAttempt.paypalOrderId);
          approvalUrl = extractSafeApprovalLink(remoteOrder.links);
        } catch {
          // Re-fetch failure should not block returning the existing order ID
        }

        const eff = aggregate.approvals.find((a) => a.invalidatedAt === null);
        return {
          purchaseId,
          paypalOrderId: liveAttempt.paypalOrderId,
          status: "ORDER_CREATED",
          approvalUrl,
          paymentAttemptId: liveAttempt.id,
          amountCents: eff?.totalCents ?? aggregate.purchase.budgetCents,
          currency: eff?.currency ?? aggregate.purchase.currency,
        };
      }
    }

    // 3. Workflow status check: must be in APPROVED
    if (aggregate.purchase.status !== "APPROVED") {
      throw new IllegalTransitionError(
        "illegal_transition",
        `Cannot create PayPal order for purchase in status "${aggregate.purchase.status}". Only APPROVED purchases can create orders.`
      );
    }

    // 4. Validate active approval exists
    const eff = aggregate.approvals.find((a) => a.invalidatedAt === null);
    if (!eff) {
      throw new ApprovalIntegrityError("no_effective_approval", "No active approval exists for purchase.");
    }

    const now = new Date();
    let purchaseState = aggregateToState(aggregate);

    // Check for multi-item approval snapshot
    const multiItemSnapshot = (
      aggregate.purchase.requirements &&
      typeof aggregate.purchase.requirements === "object" &&
      "approvedStrategy" in (aggregate.purchase.requirements as Record<string, unknown>)
    )
      ? ((aggregate.purchase.requirements as { approvedStrategy: MultiItemApprovalSnapshot }).approvedStrategy)
      : null;

    let targetedCart: {
      merchantDomain: string;
      merchandiseSubtotalCents: number;
      shippingCents: number;
      shipmentCount: number;
    } | null = null;

    if (multiItemSnapshot) {
      // 5a. Transaction boundary enforcement
      if (multiItemSnapshot.carts.length > 1) {
        if (!options?.targetCartMerchantDomain) {
          const availableDomains = multiItemSnapshot.carts.map((c) => c.merchantDomain).join(", ");
          throw new ValidationError(
            `Multi-item strategy spans ${multiItemSnapshot.carts.length} retailer carts (${availableDomains}). You must specify targetCartMerchantDomain to check out a single merchant cart.`
          );
        }
      }

      if (options?.targetCartMerchantDomain) {
        const targetDomain = options.targetCartMerchantDomain.toLowerCase().trim();
        const matched = multiItemSnapshot.carts.find(
          (c) =>
            c.merchantDomain.toLowerCase().includes(targetDomain) ||
            targetDomain.includes(c.merchantDomain.toLowerCase())
        );
        if (!matched) {
          const availableDomains = multiItemSnapshot.carts.map((c) => c.merchantDomain).join(", ");
          throw new ValidationError(
            `Target cart merchant domain "${options.targetCartMerchantDomain}" does not match any approved cart (${availableDomains}).`
          );
        }
        targetedCart = matched;
      } else {
        targetedCart = multiItemSnapshot.carts[0] ?? null;
      }

      // 5b. Multi-item approval snapshot hash integrity check
      if (eff.snapshotHash !== multiItemSnapshot.multiItemSnapshotHash) {
        throw new ApprovalIntegrityError(
          "snapshot_hash_changed",
          `Approval snapshot hash "${eff.snapshotHash}" does not match multi-item snapshot hash "${multiItemSnapshot.multiItemSnapshotHash}".`
        );
      }

      // 5b.1 Verify totalCents matches strategy landed cost
      if (eff.totalCents !== multiItemSnapshot.totalLandedCostCents) {
        throw new ApprovalIntegrityError(
          "amount_mismatch",
          `Approval total (${eff.totalCents}) does not match multi-item strategy landed cost (${multiItemSnapshot.totalLandedCostCents}).`
        );
      }

      // 5b.2 Verify line items count matches purchase requirements
      let purchaseLineItems: readonly ProcurementLineItem[] = [];
      if (
        aggregate.purchase.requirements &&
        typeof aggregate.purchase.requirements === "object" &&
        Array.isArray((aggregate.purchase.requirements as { lineItems?: unknown }).lineItems)
      ) {
        purchaseLineItems = (aggregate.purchase.requirements as { lineItems: readonly ProcurementLineItem[] }).lineItems;
      }
      if (purchaseLineItems.length > 0 && purchaseLineItems.length !== multiItemSnapshot.lineItems.length) {
        throw new ApprovalIntegrityError(
          "snapshot_hash_changed",
          "Multi-item approval snapshot line items count does not match purchase requirements. Tampering detected."
        );
      }

      // 5c. Multi-item Pre-order revalidation: destination
      const requestedDest = options?.destination?.postalCode?.trim();
      const approvedDest = multiItemSnapshot.destination?.postalCode?.trim();
      if (requestedDest && approvedDest && requestedDest !== approvedDest) {
        try {
          await this.repo.recordApprovalInvalidation({
            purchaseId,
            approvalId: eff.id,
            invalidationReason: "destination_changed",
            invalidatedAt: now,
            auditEvents: [
              {
                purchaseId,
                type: "approval_invalidated",
                actor,
                payload: {
                  approvalId: eff.id,
                  reasons: ["destination_changed"],
                },
                occurredAt: now,
              },
            ],
          });
        } catch {}

        throw new ApprovalIntegrityError(
          "destination_changed",
          `Requested destination "${requestedDest}" does not match approved multi-item destination "${approvedDest}".`
        );
      }

      // 5d. Multi-item Pre-order revalidation: candidate facts for each line item
      for (const snapItem of multiItemSnapshot.lineItems) {
        const candRecord = aggregate.candidates?.find(
          (c) => c.id === snapItem.candidateId || c.externalId === snapItem.candidateId
        );
        if (!candRecord) {
          try {
            await this.repo.recordApprovalInvalidation({
              purchaseId,
              approvalId: eff.id,
              invalidationReason: "candidate_changed",
              invalidatedAt: now,
              auditEvents: [
                {
                  purchaseId,
                  type: "approval_invalidated",
                  actor,
                  payload: {
                    approvalId: eff.id,
                    reasons: ["candidate_changed"],
                  },
                  occurredAt: now,
                },
              ],
            });
          } catch {}

          throw new ApprovalIntegrityError(
            "candidate_changed",
            `Candidate for line item "${snapItem.id}" is missing since approval.`
          );
        }

        const recomputedCandidateHash = computeSnapshotHash({
          id: candRecord.id,
          purchaseId: candRecord.purchaseId,
          source: candRecord.source,
          externalId: candRecord.externalId,
          title: candRecord.title,
          merchantName: candRecord.merchantName,
          merchantUrl: candRecord.merchantUrl,
          unitPriceCents: candRecord.unitPriceCents,
          quantity: candRecord.quantity,
          shippingCents: candRecord.shippingCents,
          totalCents: candRecord.totalCents,
          currency: candRecord.currency,
          availability: candRecord.availability,
        });

        const derivedTotal = deriveTotalCents(
          candRecord.unitPriceCents,
          candRecord.quantity,
          candRecord.shippingCents
        );

        if (
          candRecord.snapshotHash !== snapItem.candidateSnapshotHash ||
          recomputedCandidateHash !== snapItem.candidateSnapshotHash ||
          candRecord.totalCents !== derivedTotal ||
          candRecord.availability !== "in_stock"
        ) {
          const reason: InvalidationReason = "candidate_changed";
          try {
            await this.repo.recordApprovalInvalidation({
              purchaseId,
              approvalId: eff.id,
              invalidationReason: reason,
              invalidatedAt: now,
              auditEvents: [
                {
                  purchaseId,
                  type: "approval_invalidated",
                  actor,
                  payload: {
                    approvalId: eff.id,
                    reasons: [reason],
                  },
                  occurredAt: now,
                },
              ],
            });
          } catch {}

          throw new ApprovalIntegrityError(
            reason,
            `Candidate for line item "${snapItem.id}" has changed, total cost is inconsistent, or item is ${candRecord.availability} since approval.`
          );
        }
      }

      // 5e. Revalidate budget against cart total
      const activeCartTotal = targetedCart
        ? targetedCart.merchandiseSubtotalCents + targetedCart.shippingCents
        : eff.totalCents;
      if (activeCartTotal > aggregate.purchase.budgetCents) {
        throw new ApprovalIntegrityError(
          "budget_exceeded",
          `Order total $${(activeCartTotal / 100).toFixed(2)} exceeds purchase budget $${(aggregate.purchase.budgetCents / 100).toFixed(2)}.`
        );
      }

      // 5f. Policy Freshness and Version Revalidation across multi-item carts
      let isPolicySuperseded = false;
      const registry = getMerchantPolicyRegistry();
      for (const cart of multiItemSnapshot.carts) {
        const merchantPolicies = registry.getPoliciesForMerchant(cart.merchantDomain);
        if (merchantPolicies.length > 0) {
          if (
            cart.policyVersion &&
            cart.policyVersion !== "1.0.0"
          ) {
            const isVersionActive = merchantPolicies.some(
              (p) => p.policyVersion === cart.policyVersion
            );
            if (!isVersionActive) {
              isPolicySuperseded = true;
            }
          }
        }
      }
      if (isPolicySuperseded) {
        try {
          await this.repo.recordApprovalInvalidation({
            purchaseId,
            approvalId: eff.id,
            invalidationReason: "policy_superseded",
            invalidatedAt: now,
            auditEvents: [
              {
                purchaseId,
                type: "approval_invalidated",
                actor,
                payload: {
                  approvalId: eff.id,
                  reasons: ["policy_superseded"],
                },
                occurredAt: now,
              },
            ],
          });
        } catch {}

        throw new ApprovalIntegrityError(
          "policy_superseded",
          "Merchant shipping policy has been superseded since approval."
        );
      }

      // 5g. Destination Geographic Eligibility Check
      const effectiveDest = requestedDest || approvedDest;
      if (effectiveDest) {
        for (const cart of multiItemSnapshot.carts) {
          const policies = registry.getPoliciesForMerchant(cart.merchantDomain);
          if (policies.length > 0) {
            const geoCheck = checkGeographicEligibility({
              destinationPostalCode: effectiveDest,
              allowedZones: policies[0].allowedZones,
              excludedZones: policies[0].excludedZones,
            });
            if (!geoCheck.eligible) {
              try {
                await this.repo.recordApprovalInvalidation({
                  purchaseId,
                  approvalId: eff.id,
                  invalidationReason: "destination_excluded",
                  invalidatedAt: now,
                  auditEvents: [
                    {
                      purchaseId,
                      type: "approval_invalidated",
                      actor,
                      payload: {
                        approvalId: eff.id,
                        reasons: ["destination_excluded"],
                      },
                      occurredAt: now,
                    },
                  ],
                });
              } catch {}

              throw new ApprovalIntegrityError(
                "destination_excluded",
                `Destination postal code "${effectiveDest}" is not serviceable under merchant policy "${policies[0].policyId}" (${geoCheck.reason}).`
              );
            }
          }
        }
      }

      // 5h. Pre-order Shipping Quote Expiration Check
      if (options?.shippingQuote?.expiresAt) {
        const expTime = Date.parse(options.shippingQuote.expiresAt);
        if (!isNaN(expTime) && expTime <= now.getTime()) {
          try {
            await this.repo.recordApprovalInvalidation({
              purchaseId,
              approvalId: eff.id,
              invalidationReason: "quote_expired",
              invalidatedAt: now,
              auditEvents: [
                {
                  purchaseId,
                  type: "approval_invalidated",
                  actor,
                  payload: {
                    approvalId: eff.id,
                    reasons: ["quote_expired"],
                  },
                  occurredAt: now,
                },
              ],
            });
          } catch {}

          throw new ApprovalIntegrityError(
            "quote_expired",
            `Shipping quote expired at ${options.shippingQuote.expiresAt} (current time: ${now.toISOString()}) before PayPal order creation.`
          );
        }
      }

      if (aggregate.evidence && aggregate.evidence.length > 0) {
        for (const item of aggregate.evidence) {
          if (item.requirementKey === "shipping" || item.requirementKey === "shipping_quote") {
            let parsed: { expiresAt?: string } | undefined;
            try {
              parsed = JSON.parse(item.value);
            } catch {}
            if (parsed && typeof parsed.expiresAt === "string") {
              const expTime = Date.parse(parsed.expiresAt);
              if (!isNaN(expTime) && expTime <= now.getTime()) {
                try {
                  await this.repo.recordApprovalInvalidation({
                    purchaseId,
                    approvalId: eff.id,
                    invalidationReason: "quote_expired",
                    invalidatedAt: now,
                    auditEvents: [
                      {
                        purchaseId,
                        type: "approval_invalidated",
                        actor,
                        payload: {
                          approvalId: eff.id,
                          reasons: ["quote_expired"],
                        },
                        occurredAt: now,
                      },
                    ],
                  });
                } catch {}

                throw new ApprovalIntegrityError(
                  "quote_expired",
                  `Shipping quote for candidate "${item.candidateId}" expired at ${parsed.expiresAt} (current time: ${now.toISOString()}) before PayPal order creation.`
                );
              }
            }
          }
        }
      }
    } else {
      // 5. Selected candidate check
      const cand = aggregate.selectedCandidate;
      if (!cand) {
        throw new WorkflowError("guard_failed", "No selected candidate found for approved purchase.");
      }

      // 5b. Transaction boundary check: if targetCartMerchantDomain is specified, enforce domain match
      if (options?.targetCartMerchantDomain) {
        const targetDomain = options.targetCartMerchantDomain.toLowerCase().trim();
        const candMerchant = cand.merchantUrl.toLowerCase();
        const candName = cand.merchantName.toLowerCase();
        if (!candMerchant.includes(targetDomain) && !candName.includes(targetDomain)) {
          throw new ValidationError(
            `Target cart merchant domain "${options.targetCartMerchantDomain}" does not match the approved transaction retailer.`
          );
        }
      }

      // 6. Strict integrity checks against server-side candidate
      const currentCandidateHash = computeSnapshotHash({
        id: cand.id,
        purchaseId: cand.purchaseId,
        source: cand.source,
        externalId: cand.externalId,
        title: cand.title,
        merchantName: cand.merchantName,
        merchantUrl: cand.merchantUrl,
        unitPriceCents: cand.unitPriceCents,
        quantity: cand.quantity,
        shippingCents: cand.shippingCents,
        totalCents: cand.totalCents,
        currency: cand.currency,
        availability: cand.availability,
      });

      if (eff.snapshotHash !== cand.snapshotHash || eff.snapshotHash !== currentCandidateHash) {
        throw new ApprovalIntegrityError(
          "snapshot_hash_changed",
          `Candidate snapshot hash "${cand.snapshotHash}" does not match approved snapshot hash "${eff.snapshotHash}".`
        );
      }

      const derivedTotal = deriveTotalCents(cand.unitPriceCents, cand.quantity, cand.shippingCents);
      if (eff.totalCents !== derivedTotal) {
        throw new ApprovalIntegrityError(
          "amount_mismatch",
          `Approval total ${eff.totalCents} does not match candidate total ${derivedTotal}.`
        );
      }

      if (eff.currency !== cand.currency) {
        throw new ApprovalIntegrityError(
          "currency_changed",
          `Approval currency "${eff.currency}" does not match candidate currency "${cand.currency}".`
        );
      }

      const candEvidence = aggregate.evidence?.filter((e) => e.candidateId === cand.id) ?? [];

      // 6b. Budget and Landed Cost Revalidation
      if (cand.totalCents > aggregate.purchase.budgetCents) {
        throw new ApprovalIntegrityError(
          "budget_exceeded",
          `Candidate total cost $${(cand.totalCents / 100).toFixed(2)} exceeds purchase budget $${(aggregate.purchase.budgetCents / 100).toFixed(2)}.`
        );
      }

      // 6c. Policy Freshness and Version Revalidation
      let isPolicySuperseded = false;
      const registry = getMerchantPolicyRegistry();
      const merchantPolicies = registry.getPoliciesForMerchant(cand.merchantName);

      if (merchantPolicies.length > 0) {
        // Check if policy version from approval has been superseded in registry
        if (eff.policyVersion && eff.policyVersion !== "1.0.0") {
          const isVersionActive = merchantPolicies.some((p) => p.policyVersion === eff.policyVersion);
          if (!isVersionActive) {
            isPolicySuperseded = true;
          }
        }

        // Check candidate's shipping evidence for policy fingerprint
        const shippingEvidence = candEvidence.find(
          (e) => e.requirementKey === "shipping" || e.requirementKey === "shipping_policy"
        );
        if (shippingEvidence) {
          let parsedShipping: { policyFingerprint?: string; policyDocumentFingerprint?: string } | undefined;
          try {
            parsedShipping = JSON.parse(shippingEvidence.value);
          } catch {
            // non-JSON evidence value
          }
          const policyFp = parsedShipping?.policyFingerprint || parsedShipping?.policyDocumentFingerprint;
          if (policyFp && !registry.isFingerprintActive(policyFp)) {
            isPolicySuperseded = true;
          }
        }
      }

      // 6d. Destination Postal Code Consistency and Geographic Serviceability Check
      const requestedDest = options?.destination?.postalCode?.trim();
      const approvedDest = candEvidence.find((e) => e.requirementKey === "destination")?.value?.trim();
      const effectiveDest = requestedDest || approvedDest;

      if (requestedDest && approvedDest && requestedDest !== approvedDest) {
        try {
          await this.repo.recordApprovalInvalidation({
            purchaseId,
            approvalId: eff.id,
            invalidationReason: "destination_changed",
            invalidatedAt: now,
            auditEvents: [
              {
                purchaseId,
                type: "approval_invalidated",
                actor,
                payload: {
                  approvalId: eff.id,
                  reasons: ["destination_changed"],
                },
                occurredAt: now,
              },
            ],
          });
        } catch {}

        throw new ApprovalIntegrityError(
          "destination_changed",
          `Requested destination "${requestedDest}" does not match approved candidate destination "${approvedDest}".`
        );
      }

      if (effectiveDest && merchantPolicies.length > 0) {
        const policy = merchantPolicies[0];
        const geoCheck = checkGeographicEligibility({
          destinationPostalCode: effectiveDest,
          allowedZones: policy.allowedZones,
          excludedZones: policy.excludedZones,
        });
        if (!geoCheck.eligible) {
          try {
            await this.repo.recordApprovalInvalidation({
              purchaseId,
              approvalId: eff.id,
              invalidationReason: "destination_excluded",
              invalidatedAt: now,
              auditEvents: [
                {
                  purchaseId,
                  type: "approval_invalidated",
                  actor,
                  payload: {
                    approvalId: eff.id,
                    reasons: ["destination_excluded"],
                  },
                  occurredAt: now,
                },
              ],
            });
          } catch {}

          throw new ApprovalIntegrityError(
            "destination_excluded",
            `Destination postal code "${effectiveDest}" is not serviceable under merchant policy "${policy.policyId}" (${geoCheck.reason}).`
          );
        }
      }

      // 7. Check for approval invalidation via pure transition helper
      purchaseState = {
        ...purchaseState,
        isPolicySuperseded: isPolicySuperseded ? true : undefined,
      };
      const invReasons = deriveInvalidationReasons(eff, purchaseState);
      if (invReasons.length > 0) {
        try {
          await this.repo.recordApprovalInvalidation({
            purchaseId,
            approvalId: eff.id,
            invalidationReason: invReasons.join(","),
            invalidatedAt: now,
            auditEvents: [
              {
                purchaseId,
                type: "approval_invalidated",
                actor,
                payload: {
                  approvalId: eff.id,
                  reasons: invReasons,
                },
                occurredAt: now,
              },
            ],
          });
        } catch {
          // If repo write fails, fail closed to protect PayPal boundary
        }

        throw new ApprovalIntegrityError(
          invReasons[0] ?? "approval_invalidated",
          `Approval has been invalidated by changes: ${invReasons.join(", ")}`
        );
      }

      // 7b. Pre-order quote expiration check: reject expired shipping quotes immediately before PayPal order creation
      if (options?.shippingQuote?.expiresAt) {
        const expTime = Date.parse(options.shippingQuote.expiresAt);
        if (!isNaN(expTime) && expTime <= now.getTime()) {
          try {
            await this.repo.recordApprovalInvalidation({
              purchaseId,
              approvalId: eff.id,
              invalidationReason: "quote_expired",
              invalidatedAt: now,
              auditEvents: [
                {
                  purchaseId,
                  type: "approval_invalidated",
                  actor,
                  payload: {
                    approvalId: eff.id,
                    reasons: ["quote_expired"],
                  },
                  occurredAt: now,
                },
              ],
            });
          } catch {}

          throw new ApprovalIntegrityError(
            "quote_expired",
            `Shipping quote expired at ${options.shippingQuote.expiresAt} (current time: ${now.toISOString()}) before PayPal order creation.`
          );
        }
      }

      for (const item of candEvidence) {
        if (item.requirementKey === "shipping" || item.requirementKey === "shipping_quote") {
          let parsed: { expiresAt?: string } | undefined;
          try {
            parsed = JSON.parse(item.value);
          } catch {
            // non-JSON evidence value
          }
          if (parsed && typeof parsed.expiresAt === "string") {
            const expTime = Date.parse(parsed.expiresAt);
            if (!isNaN(expTime) && expTime <= now.getTime()) {
              try {
                await this.repo.recordApprovalInvalidation({
                  purchaseId,
                  approvalId: eff.id,
                  invalidationReason: "quote_expired",
                  invalidatedAt: now,
                  auditEvents: [
                    {
                      purchaseId,
                      type: "approval_invalidated",
                      actor,
                      payload: {
                        approvalId: eff.id,
                        reasons: ["quote_expired"],
                      },
                      occurredAt: now,
                    },
                  ],
                });
              } catch {}

              throw new ApprovalIntegrityError(
                "quote_expired",
                `Shipping quote for candidate "${cand.id}" expired at ${parsed.expiresAt} (current time: ${now.toISOString()}) before PayPal order creation.`
              );
            }
          }
        }
      }
    }

    // 8. Generate attempt identifier and determine external idempotency key
    const newPaymentAttemptId = generateId("pay_att");
    const rawKey = options?.idempotencyKey;
    const idempotencyKey = (rawKey && validateIdempotencyKey(rawKey)) || `pay_${purchaseId}_${eff.id}`;

    // 8c. Server calculates amount strictly from approved terms (cart-specific for multi-item, total for single)
    const amountCents =
      multiItemSnapshot && targetedCart
        ? targetedCart.merchandiseSubtotalCents + targetedCart.shippingCents
        : eff.totalCents;
    const currency = eff.currency;

    // 8b. Idempotency Check: if a completed record exists for this key, return cached order without calling PayPal
    const existingIdem = await this.repo.getIdempotencyRecord(actorId, "create_paypal_order", idempotencyKey);
    if (existingIdem) {
      const requestPayload = {
        purchaseId,
        approvalId: eff.id,
        amountCents,
        currency,
      };
      const reqHash = computePayloadHash(requestPayload);
      if (existingIdem.requestHash !== reqHash) {
        throw new IdempotencyConflictError(
          `Idempotency key "${idempotencyKey}" was previously used for operation "create_paypal_order" with different request parameters.`
        );
      }
      if (existingIdem.responseBody) {
        return existingIdem.responseBody as CreatePayPalOrderResponse;
      }
    }

    // 9. Call PayPal Sandbox API (explicit AUTHORIZE intent)
    let payPalOrder: PayPalOrderResponse;
    try {
      payPalOrder = await this.payPalClient.createOrder({
        referenceId: purchaseId,
        amountCents,
        currency,
        idempotencyKey,
        description: `Plinthly Purchase: ${purchaseId}`,
        intent: "AUTHORIZE",
      });
    } catch (err) {
      if (err instanceof PayPalTimeoutError) {
        throw new PayPalUnknownOutcomeError(
          "PayPal Sandbox order creation timed out. Outcome is unknown; state retained to prevent duplicate order creation on retry.",
          { purchaseId, idempotencyKey }
        );
      }
      throw err;
    }

    // 11. Advance state machine through pure transition
    const stateForTransition = multiItemSnapshot
      ? {
          ...purchaseState,
          selectedCandidate: {
            id: eff.candidateId,
            purchaseId,
            source: "channel3" as const,
            unitPriceCents: amountCents,
            quantity: 1,
            shippingCents: 0,
            totalCents: amountCents,
            currency: "USD" as const,
            snapshotHash: eff.snapshotHash,
          },
          approvals: purchaseState.approvals.map((a) =>
            a.id === eff.id ? { ...a, totalCents: amountCents } : a
          ),
          policyVersion: eff.policyVersion,
          policyEvidenceFingerprint: eff.evidenceFingerprint,
          currentEvidenceFingerprint: eff.evidenceFingerprint,
        }
      : purchaseState;

    const transResult = transition(
      stateForTransition,
      {
        kind: "create_order",
        idempotencyKey,
        paypalOrderId: payPalOrder.id,
      },
      {
        actor,
        now,
        newPaymentAttemptId,
      }
    );

    if (!transResult.ok) {
      throw new WorkflowError(transResult.error.code, transResult.error.message);
    }

    // 12. Record order creation in repository atomically
    const newAttemptFacts = transResult.next.paymentAttempts.find(
      (a) => a.paypalOrderId === payPalOrder.id
    )!;

    try {
      await this.repo.recordOrderCreation({
        purchaseId,
        expectedStatus: "APPROVED",
        expectedVersion: aggregate.purchase.version,
        nextStatus: "ORDER_CREATED",
        paymentAttempt: {
          id: newAttemptFacts.id,
          purchaseId,
          approvalId: newAttemptFacts.approvalId,
          idempotencyKey: newAttemptFacts.idempotencyKey,
          paypalOrderId: newAttemptFacts.paypalOrderId,
          status: "OPEN",
          requestedIntent: "AUTHORIZE",
          createdAt: now,
          verifiedStatus: null,
          verifiedAt: null,
          failureReason: null,
        },
        auditEvents: transResult.events,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("Concurrency conflict")) {
        throw new ConcurrencyConflictError(err.message);
      }
      throw err;
    }

    const approvalUrl = extractSafeApprovalLink(payPalOrder.links);

    const orderResponse: CreatePayPalOrderResponse = {
      purchaseId,
      paypalOrderId: payPalOrder.id,
      status: "ORDER_CREATED",
      requestedIntent: "AUTHORIZE",
      approvalUrl,
      paymentAttemptId: newPaymentAttemptId,
      amountCents,
      currency,
    };

    // Save idempotency record with completed order response
    try {
      const requestPayload = {
        purchaseId,
        approvalId: eff.id,
        amountCents: eff.totalCents,
        currency: eff.currency,
      };
      await this.repo.saveIdempotencyRecord({
        id: generateId("idem"),
        key: idempotencyKey,
        actorId,
        operation: "create_paypal_order",
        requestHash: computePayloadHash(requestPayload),
        responseStatus: 201,
        responseBody: orderResponse,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      });
    } catch {
      // Non-fatal if idempotency table collision or persistence error
    }

    return orderResponse;
  }

  /**
   * Confirms buyer approval on a PayPal order by independently querying
   * PayPal Sandbox API to verify external order status before advancing state.
   */
  async confirmBuyerApproval(
    purchaseId: string,
    actor: Actor,
    options?: ConfirmBuyerApprovalRequest
  ): Promise<PurchaseResponse> {
    const aggregate = await this.repo.getPurchaseById(purchaseId);
    if (!aggregate) {
      throw new NotFoundError(`Purchase with id "${purchaseId}" not found.`);
    }

    // 1. Authorization check
    assertPurchaseAccess(actor, aggregate.purchase.ownerUserId, "confirm_approval");

    // 2. Idempotent replay: if already BUYER_APPROVED, return current response
    if (aggregate.purchase.status === "BUYER_APPROVED") {
      return buildPurchaseResponse(aggregate);
    }

    // 3. Workflow status check: must be in ORDER_CREATED
    if (aggregate.purchase.status !== "ORDER_CREATED") {
      throw new IllegalTransitionError(
        "illegal_transition",
        `Cannot confirm buyer approval: purchase status is "${aggregate.purchase.status}", expected "ORDER_CREATED".`
      );
    }

    // 4. Live payment attempt check
    const liveAttempt = aggregate.paymentAttempts.find((a) => a.status === "OPEN");
    if (!liveAttempt || !liveAttempt.paypalOrderId) {
      throw new WorkflowError("inconsistent_state", "No active payment attempt found for purchase.");
    }

    // 5. If caller provided an order ID, verify it matches
    if (options?.paypalOrderId && options.paypalOrderId.trim() !== liveAttempt.paypalOrderId) {
      throw new WorkflowError(
        "order_id_mismatch",
        `Supplied PayPal order ID "${options.paypalOrderId}" does not match active payment attempt order ID "${liveAttempt.paypalOrderId}".`
      );
    }

    // 6. Independently retrieve order status from PayPal Sandbox API (never trust client)
    let remoteOrder: PayPalGetOrderResponse;
    try {
      remoteOrder = await this.payPalClient.getOrder(liveAttempt.paypalOrderId);
    } catch (err) {
      if (
        err instanceof PayPalApiError &&
        (err.statusCode === 404 ||
          err.errorName === "404" ||
          err.errorName === "RESOURCE_NOT_FOUND")
      ) {
        try {
          await this.repo.recordPaymentVerification({
            purchaseId,
            paymentAttemptId: liveAttempt.id,
            verifiedStatus: "NOT_FOUND",
            verifiedAt: new Date(),
            failureReason: "remote_order_not_found",
          });
        } catch {}
        throw new WorkflowError(
          "order_not_found",
          `PayPal Sandbox returned HTTP 404 for order "${liveAttempt.paypalOrderId}". Order not found.`
        );
      }
      throw err;
    }

    // 7. Verify remote order ID matches active payment attempt
    if (!remoteOrder.id || remoteOrder.id !== liveAttempt.paypalOrderId) {
      throw new WorkflowError(
        "order_id_mismatch",
        `PayPal order ID "${remoteOrder.id}" does not match active payment attempt order ID "${liveAttempt.paypalOrderId}".`
      );
    }

    // 8. Verify active approval exists
    const eff = aggregate.approvals.find((a) => a.invalidatedAt === null);
    if (!eff) {
      throw new ApprovalIntegrityError("no_effective_approval", "No active approval exists for purchase.");
    }

    // 9. Fail-closed validation of purchase units structure
    // Purchase Assurance orders strictly define exactly 1 purchase unit referencing purchaseId
    if (!Array.isArray(remoteOrder.purchase_units) || remoteOrder.purchase_units.length === 0) {
      throw new WorkflowError(
        "invalid_purchase_unit",
        "PayPal order does not contain any purchase units."
      );
    }

    if (remoteOrder.purchase_units.length !== 1) {
      throw new WorkflowError(
        "invalid_purchase_unit",
        `PayPal order contains ${remoteOrder.purchase_units.length} purchase units; Purchase Assurance requires exactly 1 purchase unit.`
      );
    }

    const unit = remoteOrder.purchase_units[0];
    if (!unit.reference_id || unit.reference_id.trim().length === 0) {
      throw new WorkflowError(
        "reference_id_missing",
        "PayPal purchase unit is missing required reference_id."
      );
    }

    if (unit.reference_id !== purchaseId) {
      throw new WorkflowError(
        "reference_id_mismatch",
        `PayPal purchase unit reference_id "${unit.reference_id}" does not match internal purchase ID "${purchaseId}".`
      );
    }

    if (!unit.amount || !unit.amount.value || !unit.amount.currency_code) {
      throw new WorkflowError(
        "invalid_amount_structure",
        "PayPal purchase unit amount structure is missing or malformed."
      );
    }

    if (unit.amount.currency_code !== eff.currency) {
      throw new WorkflowError(
        "currency_mismatch",
        `PayPal order currency "${unit.amount.currency_code}" does not match approved currency "${eff.currency}".`
      );
    }

    const remoteCents = Math.round(parseFloat(unit.amount.value) * 100);
    const multiItemSnapshot = (
      aggregate.purchase.requirements &&
      typeof aggregate.purchase.requirements === "object" &&
      "approvedStrategy" in (aggregate.purchase.requirements as Record<string, unknown>)
    )
      ? ((aggregate.purchase.requirements as { approvedStrategy: MultiItemApprovalSnapshot }).approvedStrategy)
      : null;

    let isAmountValid = (remoteCents === eff.totalCents);
    if (!isAmountValid && multiItemSnapshot) {
      const matchingCart = multiItemSnapshot.carts.find(
        (c) => c.merchandiseSubtotalCents + c.shippingCents === remoteCents
      );
      if (matchingCart) {
        isAmountValid = true;
      }
    }

    if (!Number.isFinite(remoteCents) || isNaN(remoteCents) || !isAmountValid) {
      throw new WorkflowError(
        "amount_mismatch",
        `PayPal order amount "${remoteCents}" cents does not match approved total "${eff.totalCents}" cents.`
      );
    }

    // 9b. Verify intent is AUTHORIZE (Plinthly strictly operates an authorization-only workflow)
    if (remoteOrder.intent && remoteOrder.intent !== "AUTHORIZE") {
      try {
        await this.repo.recordPaymentVerification({
          purchaseId,
          paymentAttemptId: liveAttempt.id,
          verifiedStatus: "INTENT_INCOMPATIBLE",
          verifiedAt: new Date(),
          failureReason: "legacy_capture_intent_incompatible",
        });
      } catch {}
      throw new WorkflowError(
        "incompatible_payment_intent",
        `PayPal order "${liveAttempt.paypalOrderId}" has intent "${remoteOrder.intent}", which is incompatible with Plinthly's authorization-only workflow. Legacy CAPTURE orders cannot be approved or authorized.`
      );
    }

    // 10. Verify status is APPROVED
    if (remoteOrder.status !== "APPROVED") {
      throw new WorkflowError(
        "payment_not_yet_approved",
        `PayPal Sandbox order status is "${remoteOrder.status}". Order has not been approved by buyer in PayPal Sandbox.`
      );
    }

    const now = new Date();

    // 9. Advance state machine through pure transition
    const purchaseState = aggregateToState(aggregate);
    const transResult = transition(
      purchaseState,
      {
        kind: "observe_paypal_order",
        observation: {
          orderId: liveAttempt.paypalOrderId,
          status: "APPROVED",
          source: "paypal_order_get",
          observedAt: now,
        },
      },
      { actor, now }
    );

    if (!transResult.ok) {
      throw new WorkflowError(transResult.error.code, transResult.error.message);
    }

    // 10. Persist buyer approval in repository atomically
    const updated = await this.repo.recordBuyerApproval({
      purchaseId,
      expectedStatus: "ORDER_CREATED",
      expectedVersion: aggregate.purchase.version,
      nextStatus: "BUYER_APPROVED",
      paymentAttemptId: liveAttempt.id,
      verifiedStatus: "APPROVED",
      verifiedAt: now,
      auditEvents: transResult.events,
    });

    return buildPurchaseResponse(updated);
  }

  /**
   * Generates and evaluates feasible multi-item procurement strategies, cart groupings,
   * split shipments, and defensible landed costs.
   */
  async createMultiItemPlan(
    purchaseId: string,
    req: CreateMultiItemPlanRequest,
    actor: Actor,
    now: Date = new Date()
  ): Promise<MultiItemPlanResponse> {
    const aggregate = await this.repo.getPurchaseById(purchaseId);
    if (!aggregate) {
      throw new NotFoundError(`Purchase with id "${purchaseId}" not found.`);
    }

    assertPurchaseAccess(actor, aggregate.purchase.ownerUserId, "evaluate");

    const validatedLineItems = validateProcurementLineItems(req.lineItems, aggregate.purchase.currency);
    if (!validatedLineItems.ok) {
      throw new ValidationError("Invalid line items in multi-item plan request", validatedLineItems.errors);
    }
    const lineItems = validatedLineItems.lineItems;

    // Resolve destination
    const purchaseAuditEvents = await this.repo.getAuditHistory(purchaseId);
    const proposedEvent = purchaseAuditEvents.find((e) => e.type === "proposed");
    const proposedPayload = proposedEvent?.payload as
      | { destination?: import("../discovery/shipping").DestinationContext }
      | undefined;

    const destination: import("../discovery/shipping").DestinationContext = req.destination ?? proposedPayload?.destination ?? {
      country: "US",
      postalCode: "94103",
      deliveryMethodPreference: "standard_ground",
    };

    // Candidate pool
    let candidatePool: import("../discovery/types").NormalizedProductCandidate[] = [];
    if (req.candidates && req.candidates.length > 0) {
      const normalizedPool: import("../discovery/types").NormalizedProductCandidate[] = [];
      for (const rawCand of req.candidates as unknown as import("../discovery/types").NormalizedProductCandidate[]) {
        const safeCapturedAt =
          rawCand.capturedAt instanceof Date && !isNaN(rawCand.capturedAt.getTime())
            ? rawCand.capturedAt
            : typeof rawCand.capturedAt === "string"
            ? parseEvidenceCapturedAt(rawCand.capturedAt)
            : new Date(0);
        const effectiveSnapshotHash =
          rawCand.snapshotHash ||
          computeSnapshotHash({
            id: rawCand.id,
            purchaseId,
            source: rawCand.source,
            externalId: rawCand.externalId,
            title: rawCand.title,
            merchantName: rawCand.merchantName,
            merchantUrl: rawCand.merchantUrl,
            unitPriceCents: rawCand.unitPriceCents,
            quantity: rawCand.quantity,
            shippingCents: rawCand.shippingCents,
            totalCents: rawCand.totalCents,
            currency: "USD",
            availability: rawCand.availability,
          });
        const cand = {
          ...rawCand,
          snapshotHash: effectiveSnapshotHash,
        };
        normalizedPool.push(cand);
        const candRecord: CandidateRecord = {
          id: cand.id,
          purchaseId,
          source: cand.source === "channel3" ? "channel3" : "seeded",
          externalId: cand.externalId,
          title: cand.title,
          merchantName: cand.merchantName,
          merchantUrl: cand.merchantUrl,
          unitPriceCents: cand.unitPriceCents,
          quantity: cand.quantity,
          shippingCents: cand.shippingCents,
          totalCents: cand.totalCents,
          currency: "USD",
          availability: cand.availability,
          capturedAt: safeCapturedAt,
          snapshotHash: effectiveSnapshotHash,
        };
        await this.repo.saveCandidateWithEvidence(candRecord, []);
      }
      candidatePool = normalizedPool;
    } else if (aggregate.candidates && aggregate.candidates.length > 0) {
      candidatePool = aggregate.candidates.map((c) => ({
        id: c.id,
        purchaseId: c.purchaseId,
        externalId: c.externalId,
        title: c.title,
        merchantName: c.merchantName,
        merchantUrl: c.merchantUrl,
        unitPriceCents: c.unitPriceCents,
        quantity: c.quantity,
        shippingCents: c.shippingCents,
        totalCents: c.totalCents,
        currency: c.currency as "USD",
        availability: c.availability,
        source: c.source,
        capturedAt: c.capturedAt,
        snapshotHash: c.snapshotHash,
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: c.merchantName,
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
      }));
    } else {
      // Execute live/mocked per-line-item discovery through discoveryAdapter
      for (const item of lineItems) {
        try {
          const searchReq: ProductSearchRequest = {
            purchaseId,
            query: item.title,
            constraints: {
              maxBudgetCents: item.budgetCents,
              minQuantity: item.quantity,
              destination,
              currency: item.currency,
            },
          };
          const discResult = await this.discoveryAdapter.search(searchReq, {
            now,
          });
          if (discResult.status === "success" && discResult.candidates.length > 0) {
            for (const cand of discResult.candidates) {
              candidatePool.push(cand);
              const safeCapturedAt =
                cand.capturedAt instanceof Date && !isNaN(cand.capturedAt.getTime())
                  ? cand.capturedAt
                  : typeof cand.capturedAt === "string"
                  ? parseEvidenceCapturedAt(cand.capturedAt)
                  : new Date(0);
              const candRecord: CandidateRecord = {
                id: cand.id,
                purchaseId,
                source: cand.source,
                externalId: cand.externalId,
                title: cand.title,
                merchantName: cand.merchantName,
                merchantUrl: cand.merchantUrl,
                unitPriceCents: cand.unitPriceCents,
                quantity: cand.quantity,
                shippingCents: cand.shippingCents,
                totalCents: cand.totalCents,
                currency: "USD",
                availability: cand.availability,
                capturedAt: safeCapturedAt,
                snapshotHash: cand.snapshotHash,
              };
              await this.repo.saveCandidateWithEvidence(candRecord, []);
            }
          }
        } catch {
          // Discovery failure fails closed without inventing synthetic products
        }
      }
    }

    const strategies = generateProcurementStrategies({
      lineItems,
      candidates: candidatePool,
      destination,
      now,
      buyerMemberships: req.buyerMemberships,
    });

    let activeApproval: MultiItemApprovalSnapshot | null = null;
    if (
      aggregate.purchase.requirements &&
      typeof aggregate.purchase.requirements === "object" &&
      "approvedStrategy" in (aggregate.purchase.requirements as Record<string, unknown>)
    ) {
      activeApproval = (aggregate.purchase.requirements as { approvedStrategy: MultiItemApprovalSnapshot }).approvedStrategy;
      const latestApproval = aggregate.approvals[aggregate.approvals.length - 1];
      if (latestApproval?.invalidatedAt) {
        activeApproval = {
          ...activeApproval,
          invalidatedAt: latestApproval.invalidatedAt.toISOString(),
          invalidationReason: latestApproval.invalidationReason,
        };
      }
    }

    return {
      purchaseId,
      status: aggregate.purchase.status,
      version: aggregate.purchase.version,
      lineItems,
      destination,
      strategies,
      activeApproval,
      evaluatedAt: now.toISOString(),
    };
  }

  /**
   * Binds buyer approval to the exact complete multi-item procurement snapshot.
   */
  async approveMultiItemPlan(
    purchaseId: string,
    req: ApproveMultiItemPlanRequest,
    actor: Actor,
    now: Date = new Date()
  ): Promise<MultiItemPlanResponse> {
    const aggregate = await this.repo.getPurchaseById(purchaseId);
    if (!aggregate) {
      throw new NotFoundError(`Purchase with id "${purchaseId}" not found.`);
    }

    if (actor.kind !== "user") {
      throw new IllegalTransitionError("invalid_actor", "Multi-item purchase approval requires a verified human buyer.");
    }
    assertPurchaseAccess(actor, aggregate.purchase.ownerUserId, "approve");

    // Reconstruct line items
    let lineItems: readonly ProcurementLineItem[] = [];
    if (Array.isArray(aggregate.purchase.requirements)) {
      lineItems = convertLegacyRequirementsToLineItems(
        aggregate.purchase.requirements,
        aggregate.purchase.budgetCents,
        aggregate.purchase.currency
      );
    } else if (
      aggregate.purchase.requirements &&
      typeof aggregate.purchase.requirements === "object" &&
      Array.isArray((aggregate.purchase.requirements as { lineItems?: unknown }).lineItems)
    ) {
      lineItems = (aggregate.purchase.requirements as { lineItems: readonly ProcurementLineItem[] }).lineItems;
    }

    const purchaseAuditEvents = await this.repo.getAuditHistory(purchaseId);
    const proposedEvent = purchaseAuditEvents.find((e) => e.type === "proposed");
    const proposedPayload = proposedEvent?.payload as
      | { destination?: import("../discovery/shipping").DestinationContext }
      | undefined;

    const destination: import("../discovery/shipping").DestinationContext = req.destination ?? proposedPayload?.destination ?? {
      country: "US",
      postalCode: "94103",
      deliveryMethodPreference: "standard_ground",
    };

    // Reconstruct candidates
    let candidatePool: import("../discovery/types").NormalizedProductCandidate[] = [];
    if (req.candidates && req.candidates.length > 0) {
      candidatePool = req.candidates as unknown as import("../discovery/types").NormalizedProductCandidate[];
    } else if (aggregate.candidates && aggregate.candidates.length > 0) {
      candidatePool = aggregate.candidates.map((c) => ({
        id: c.id,
        purchaseId: c.purchaseId,
        externalId: c.externalId,
        title: c.title,
        merchantName: c.merchantName,
        merchantUrl: c.merchantUrl,
        unitPriceCents: c.unitPriceCents,
        quantity: c.quantity,
        shippingCents: c.shippingCents,
        totalCents: c.totalCents,
        currency: c.currency as "USD",
        availability: c.availability,
        source: c.source,
        capturedAt: c.capturedAt,
        snapshotHash: c.snapshotHash,
        rawSourceData: {},
        isComplete: true,
        validationErrors: [],
        sellerName: c.merchantName,
        isMarketplace: false,
        isDirectRetailerSeller: true,
        fulfillmentMethod: "standard_ground",
      }));
    }

    const strategies = generateProcurementStrategies({
      lineItems,
      candidates: candidatePool,
      destination,
      now,
    });

    const targetStrategy = strategies.find((s) => s.strategyId === req.strategyId);
    if (!targetStrategy) {
      throw new ValidationError(`Strategy "${req.strategyId}" was not found in evaluated strategies.`);
    }

    if (targetStrategy.feasibility !== "feasible" || !targetStrategy.isLandedCostDefensible) {
      throw new ValidationError(
        `Cannot approve strategy "${targetStrategy.name}": strategy is ${targetStrategy.feasibility} and landed cost is not defensible.`
      );
    }

    if (
      req.expectedTotalLandedCostCents !== undefined &&
      targetStrategy.totalLandedCostCents !== req.expectedTotalLandedCostCents
    ) {
      throw new ApprovalIntegrityError(
        "amount_mismatch",
        `Expected total landed cost (${req.expectedTotalLandedCostCents}) does not match strategy total (${targetStrategy.totalLandedCostCents}).`
      );
    }

    if (req.expectedCurrency !== undefined && targetStrategy.currency !== req.expectedCurrency) {
      throw new ApprovalIntegrityError(
        "currency_changed",
        `Expected currency "${req.expectedCurrency}" does not match strategy currency "${targetStrategy.currency}".`
      );
    }

    const computedSnapshotHash = computeMultiItemSnapshotHash(targetStrategy, lineItems, destination);
    if (req.expectedSnapshotHash !== undefined && computedSnapshotHash !== req.expectedSnapshotHash) {
      throw new ApprovalIntegrityError(
        "snapshot_hash_changed",
        `Computed multi-item snapshot hash "${computedSnapshotHash}" does not match expected "${req.expectedSnapshotHash}".`
      );
    }

    const snapshotId = generateId("snap");
    const activeApproval = createMultiItemApprovalSnapshot({
      snapshotId,
      purchaseId,
      strategy: targetStrategy,
      lineItems,
      destination,
      approverUserId: actor.userId,
      evidenceFingerprint: aggregate.purchase.policyEvidenceFingerprint ?? computedSnapshotHash,
      approvedAt: now.toISOString(),
    });

    // Save all allocated candidates with evidence into repository
    for (const alloc of targetStrategy.allocations) {
      const matching = candidatePool.find(
        (c) => c.id === alloc.candidateId || c.externalId === alloc.candidateId || c.externalId === alloc.externalId
      );
      if (matching) {
        const safeCapturedAt =
          matching.capturedAt instanceof Date && !isNaN(matching.capturedAt.getTime())
            ? matching.capturedAt
            : typeof matching.capturedAt === "string"
            ? parseEvidenceCapturedAt(matching.capturedAt)
            : new Date(0);
        const candRecord: CandidateRecord = {
          id: matching.id,
          purchaseId,
          source: matching.source === "channel3" ? "channel3" : "seeded",
          externalId: matching.externalId,
          title: matching.title,
          merchantName: matching.merchantName,
          merchantUrl: matching.merchantUrl,
          unitPriceCents: matching.unitPriceCents,
          quantity: matching.quantity,
          shippingCents: matching.shippingCents,
          totalCents: matching.totalCents,
          currency: "USD",
          availability: matching.availability,
          capturedAt: safeCapturedAt,
          snapshotHash: alloc.snapshotHash,
        };
        await this.repo.saveCandidateWithEvidence(candRecord, []);
      }
    }

    if (targetStrategy.totalLandedCostCents === null) {
      throw new ValidationError("Cannot approve strategy: total landed cost is null.");
    }

    const primaryCandidateId =
      targetStrategy.allocations[0]?.candidateId ??
      aggregate.purchase.selectedCandidateId ??
      (candidatePool[0]?.id || "cand_multi_primary");

    const newApprovalId = generateId("appr");
    const approvalRecord: ApprovalRecord = {
      id: newApprovalId,
      purchaseId,
      candidateId: primaryCandidateId,
      snapshotHash: computedSnapshotHash,
      totalCents: targetStrategy.totalLandedCostCents,
      currency: targetStrategy.currency,
      policyVersion: targetStrategy.carts[0]?.thresholdEvaluation?.policyVersion ?? "1.0.0",
      evidenceFingerprint: aggregate.purchase.policyEvidenceFingerprint ?? computedSnapshotHash,
      approverUserId: actor.userId,
      approvedAt: now,
      invalidatedAt: null,
      invalidationReason: null,
    };

    const auditEvents: AuditEventDraft[] = [
      {
        purchaseId,
        type: "approved",
        actor,
        occurredAt: now,
        payload: {
          approvalId: newApprovalId,
          candidateId: primaryCandidateId,
          snapshotHash: computedSnapshotHash,
          totalCents: targetStrategy.totalLandedCostCents,
          currency: "USD",
          policyVersion: targetStrategy.carts[0]?.thresholdEvaluation?.policyVersion ?? "1.0.0",
          evidenceFingerprint: aggregate.purchase.policyEvidenceFingerprint ?? computedSnapshotHash,
          approverUserId: actor.userId,
        },
      },
    ];

    let updatedAggregate: PurchaseAggregate;
    try {
      updatedAggregate = await this.repo.recordApproval({
        purchaseId,
        expectedStatus: aggregate.purchase.status,
        expectedVersion: aggregate.purchase.version,
        nextStatus: "APPROVED",
        approval: approvalRecord,
        auditEvents,
        selectedCandidateId: primaryCandidateId,
        requirements: {
          lineItems,
          approvedStrategy: activeApproval,
          destination,
        },
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("Concurrency conflict")) {
        throw new ConcurrencyConflictError(err.message);
      }
      throw err;
    }

    return {
      purchaseId,
      status: updatedAggregate.purchase.status,
      version: updatedAggregate.purchase.version,
      lineItems,
      destination,
      strategies,
      activeApproval,
      evaluatedAt: now.toISOString(),
    };
  }

  /**
   * Independently queries PayPal Sandbox to verify payment status, terms, and buyer approval.
   */
  async verifyPayPalPayment(
    purchaseId: string,
    actor: Actor
  ): Promise<PaymentVerificationResult> {
    const verifier = new PaymentVerificationService(this.repo, this.payPalClient);
    return verifier.verifyPayment(purchaseId, actor);
  }
}

// Global service instance
let globalService: PurchaseWorkflowService = new PurchaseWorkflowService();

export function getPurchaseWorkflowService(): PurchaseWorkflowService {
  return globalService;
}

export function setPurchaseWorkflowService(service: PurchaseWorkflowService): void {
  globalService = service;
}

export { PaymentVerificationService };
export type { PaymentVerificationResult };

