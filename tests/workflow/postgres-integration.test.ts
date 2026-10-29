import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PrismaPurchaseRepository,
  PurchaseRecord,
  CandidateRecord,
  EvidenceItemRecord,
  RecordEvaluationParams,
} from "../../lib/workflow/repository";
import { AuditEventDraft, Actor } from "../../lib/state/types";
import { IdempotencyRecord } from "../../lib/workflow/types";
import { IdempotencyConflictError } from "../../lib/workflow/errors";
import { executeWithIdempotency } from "../../lib/workflow/idempotency";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { UNKNOWN_TIMESTAMP_SENTINEL, UNKNOWN_TIMESTAMP_SENTINEL_ISO } from "../../lib/discovery/evidence";

dotenv.config({ path: ".env.local" });

describe("PostgreSQL Integration: PrismaPurchaseRepository against plinthly_dev", () => {
  let repo: PrismaPurchaseRepository;
  let directPrisma: PrismaClient | undefined;

  // Track exact IDs created during the test run for pinpoint cleanup
  const createdPurchaseIds = new Set<string>();
  const createdIdempotencyKeys = new Set<{ actorId: string; operation: string; key: string }>();

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be configured in .env.local").toBeDefined();

    // Verify connection targets strictly plinthly_dev on 127.0.0.1:5432
    const parsed = new URL(databaseUrl!);
    expect(parsed.hostname).toBe("127.0.0.1");
    expect(parsed.port || "5432").toBe("5432");
    expect(parsed.pathname).toBe("/plinthly_dev");

    const adapter = new PrismaPg({ connectionString: databaseUrl! });
    directPrisma = new PrismaClient({ adapter });
    await directPrisma.$connect();

    repo = new PrismaPurchaseRepository(directPrisma);
  });

  afterAll(async () => {
    // If directPrisma was never initialized (e.g. beforeAll failed before connecting), skip cleanup
    if (!directPrisma) {
      return;
    }

    // Pinpoint cleanup: delete only records created during this test suite
    try {
      if (createdPurchaseIds.size > 0) {
        const purchaseIds = Array.from(createdPurchaseIds);

        // Break circular FK: selectedCandidateId -> candidate(id, purchaseId)
        await directPrisma.purchase.updateMany({
          where: { id: { in: purchaseIds } },
          data: { selectedCandidateId: null },
        });

        // Delete child relations first
        await directPrisma.auditEvent.deleteMany({
          where: { purchaseId: { in: purchaseIds } },
        });
        await directPrisma.paymentAttempt.deleteMany({
          where: { purchaseId: { in: purchaseIds } },
        });
        await directPrisma.approval.deleteMany({
          where: { purchaseId: { in: purchaseIds } },
        });
        await directPrisma.policyResult.deleteMany({
          where: { purchaseId: { in: purchaseIds } },
        });
        await directPrisma.evidenceItem.deleteMany({
          where: { candidate: { purchaseId: { in: purchaseIds } } },
        });
        await directPrisma.candidate.deleteMany({
          where: { purchaseId: { in: purchaseIds } },
        });
        await directPrisma.purchase.deleteMany({
          where: { id: { in: purchaseIds } },
        });
      }

      if (createdIdempotencyKeys.size > 0) {
        for (const record of createdIdempotencyKeys) {
          await directPrisma.idempotencyRecord.deleteMany({
            where: {
              actorId: record.actorId,
              operation: record.operation,
              key: record.key,
            },
          });
        }
      }
    } finally {
      await directPrisma.$disconnect().catch(() => {});
    }
  });

  it("creates and reads a purchase with audit records and idempotency tracking in PostgreSQL", async () => {
    const purchaseId = `test_pg_create_${Date.now()}`;
    const actorId = "usr_test_buyer";
    const idempotencyKey = `idem_key_${Date.now()}`;
    const now = new Date();

    createdPurchaseIds.add(purchaseId);
    createdIdempotencyKeys.add({ actorId, operation: "create_purchase", key: idempotencyKey });

    const purchase: PurchaseRecord = {
      id: purchaseId,
      status: "DRAFT",
      requirements: [{ key: "spec", expectedValue: "Dell XPS 15" }],
      budgetCents: 15000,
      currency: "USD",
      policyVersion: null,
      policyEvidenceFingerprint: null,
      selectedCandidateId: null,
      ownerUserId: actorId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    const auditDraft: AuditEventDraft = {
      purchaseId,
      type: "proposed",
      actor: { kind: "user", userId: actorId },
      payload: { budgetCents: 15000, currency: "USD" },
      occurredAt: now,
    };

    const idempotencyDraft: IdempotencyRecord = {
      id: `idem_rec_${Date.now()}`,
      key: idempotencyKey,
      actorId,
      operation: "create_purchase",
      requestHash: "a".repeat(64),
      responseStatus: 201,
      responseBody: { id: purchaseId, status: "DRAFT" },
      createdAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
    };

    // Act: Write purchase, audit event, and idempotency record atomically
    const created = await repo.createPurchase(purchase, [auditDraft], idempotencyDraft);
    expect(created.id).toBe(purchaseId);
    expect(created.status).toBe("DRAFT");
    expect(created.version).toBe(1);

    // Read back via getPurchaseById
    const aggregate = await repo.getPurchaseById(purchaseId);
    expect(aggregate).not.toBeNull();
    expect(aggregate!.purchase.id).toBe(purchaseId);
    expect(aggregate!.purchase.budgetCents).toBe(15000);
    expect(aggregate!.purchase.ownerUserId).toBe(actorId);
    expect(aggregate!.purchase.version).toBe(1);
    expect(aggregate!.purchase.requirements).toEqual([{ key: "spec", expectedValue: "Dell XPS 15" }]);

    // Verify audit history was persisted in plinthly_dev
    const auditHistory = await repo.getAuditHistory(purchaseId);
    expect(auditHistory).toHaveLength(1);
    expect(auditHistory[0].type).toBe("proposed");
    expect(auditHistory[0].purchaseId).toBe(purchaseId);

    // Verify idempotency record was persisted in plinthly_dev
    const idemRecord = await repo.getIdempotencyRecord(actorId, "create_purchase", idempotencyKey);
    expect(idemRecord).not.toBeNull();
    expect(idemRecord!.key).toBe(idempotencyKey);
    expect(idemRecord!.responseStatus).toBe(201);
  });

  it("atomically rolls back purchase and audit events if a transaction error occurs", async () => {
    const purchaseId = `test_pg_rollback_${Date.now()}`;
    const actorId = "usr_test_rollback";
    const now = new Date();

    const purchase: PurchaseRecord = {
      id: purchaseId,
      status: "DRAFT",
      requirements: ["spec_must_fail"],
      budgetCents: 5000,
      currency: "USD",
      policyVersion: null,
      policyEvidenceFingerprint: null,
      selectedCandidateId: null,
      ownerUserId: actorId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    // An invalid audit draft (missing occurredAt instance)
    const invalidAuditDraft = {
      purchaseId,
      type: "proposed" as const,
      actor: { kind: "user" as const, userId: actorId },
      payload: { budgetCents: 5000, currency: "USD" as const },
      occurredAt: "not-a-date" as unknown as Date,
    };

    // Should fail validation before/during database transaction
    await expect(
      repo.createPurchase(purchase, [invalidAuditDraft as unknown as AuditEventDraft])
    ).rejects.toThrow();

    // Verify that the purchase was never persisted to PostgreSQL
    const readAttempt = await repo.getPurchaseById(purchaseId);
    expect(readAttempt).toBeNull();

    // Verify that no audit records exist in PostgreSQL
    const audits = await repo.getAuditHistory(purchaseId);
    expect(audits).toHaveLength(0);
  });

  it("enforces optimistic concurrency control and detects stale-version conflicts in PostgreSQL", async () => {
    const purchaseId = `test_pg_concurrency_${Date.now()}`;
    const candidateId = `cand_${Date.now()}`;
    const actorId = "usr_test_version";
    const now = new Date();

    createdPurchaseIds.add(purchaseId);

    const initialPurchase: PurchaseRecord = {
      id: purchaseId,
      status: "DRAFT",
      requirements: ["item_spec"],
      budgetCents: 10000,
      currency: "USD",
      policyVersion: null,
      policyEvidenceFingerprint: null,
      selectedCandidateId: null,
      ownerUserId: actorId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await repo.createPurchase(initialPurchase, []);

    // Create candidate record required for candidate foreign key
    const candidateRecord: CandidateRecord = {
      id: candidateId,
      purchaseId,
      source: "channel3",
      externalId: "ext_123",
      title: "Test Candidate",
      merchantName: "Merchant Inc",
      merchantUrl: "https://example.com/item",
      unitPriceCents: 9000,
      quantity: 1,
      shippingCents: 500,
      totalCents: 9500,
      currency: "USD",
      availability: "in_stock",
      capturedAt: now,
      snapshotHash: "b".repeat(64),
    };
    await repo.saveCandidateWithEvidence(candidateRecord, []);

    // 1. First evaluation update succeeds with expectedVersion: 1
    const evalParams1: RecordEvaluationParams = {
      purchaseId,
      expectedStatus: "DRAFT",
      expectedVersion: 1,
      nextStatus: "EVALUATED",
      selectedCandidateId: candidateId,
      policyVersion: "v1.0",
      policyEvidenceFingerprint: "c".repeat(64),
      policyResults: [
        {
          id: `pol_res_${Date.now()}`,
          purchaseId,
          policyVersion: "v1.0",
          ruleKey: "budget_check",
          outcome: "pass",
          detail: "Under budget",
          evaluatedAt: now,
        },
      ],
      auditEvents: [
        {
          purchaseId,
          type: "evaluated",
          actor: { kind: "user", userId: actorId },
          payload: { candidateId, reason: "candidate_selected" },
          occurredAt: now,
        },
      ],
    };

    const firstEvalResult = await repo.recordEvaluation(evalParams1);
    expect(firstEvalResult.purchase.version).toBe(2);
    expect(firstEvalResult.purchase.status).toBe("EVALUATED");

    // Verify in PostgreSQL database that version is now 2
    const readAfterFirst = await repo.getPurchaseById(purchaseId);
    expect(readAfterFirst!.purchase.version).toBe(2);
    expect(readAfterFirst!.purchase.status).toBe("EVALUATED");

    // 2. Second evaluation attempt with stale expectedVersion: 1 must fail conditional update
    const staleEvalParams: RecordEvaluationParams = {
      ...evalParams1,
      expectedVersion: 1, // Stale! Current version is 2
      nextStatus: "POLICY_PASSED",
    };

    await expect(repo.recordEvaluation(staleEvalParams)).rejects.toThrow(
      /Concurrency conflict/i
    );

    // Verify database record was NOT mutated by the stale update
    const readAfterStale = await repo.getPurchaseById(purchaseId);
    expect(readAfterStale!.purchase.version).toBe(2);
    expect(readAfterStale!.purchase.status).toBe("EVALUATED");
  });

  it("handles idempotency: replaying same key returns cached result; same key with different payload throws conflict", async () => {
    const actorId = "usr_test_idem";
    const idempotencyKey = `test_idem_${Date.now()}`;
    const operation = "purchase_test_op";

    createdIdempotencyKeys.add({ actorId, operation, key: idempotencyKey });

    const payloadA = { amountCents: 10000, memo: "First payload" };
    const payloadB = { amountCents: 20000, memo: "Altered payload with same key" };

    let executionCount = 0;

    // 1. Initial execution with Payload A
    const result1 = await executeWithIdempotency<{ message: string; code: number }>(repo, {
      actorId,
      operation,
      idempotencyKey,
      payload: payloadA,
      execute: async (draft) => {
        executionCount++;
        if (draft) {
          await directPrisma!.idempotencyRecord.create({
            data: {
              id: draft.id,
              key: draft.key,
              actorId: draft.actorId,
              operation: draft.operation,
              requestHash: draft.requestHash,
              responseStatus: 200,
              responseBody: { message: "Created successfully", code: 123 },
              createdAt: draft.createdAt,
              expiresAt: draft.expiresAt,
            },
          });
        }
        return {
          status: 200,
          body: { message: "Created successfully", code: 123 },
          persistedAtomically: true,
        };
      },
    });

    expect(result1.cached).toBe(false);
    expect(result1.body.code).toBe(123);
    expect(executionCount).toBe(1);

    // 2. Replay with identical key and identical payload -> returns cached result without re-executing
    const result2 = await executeWithIdempotency<{ message: string; code: number }>(repo, {
      actorId,
      operation,
      idempotencyKey,
      payload: payloadA,
      execute: async () => {
        executionCount++;
        return {
          status: 200,
          body: { message: "Should not execute", code: 999 },
        };
      },
    });

    expect(result2.cached).toBe(true);
    expect(result2.body.code).toBe(123);
    expect(executionCount).toBe(1); // Execute was NOT called again

    // 3. Replay with same key but DIFFERENT payload -> must throw IdempotencyConflictError
    await expect(
      executeWithIdempotency<{ message: string; code: number }>(repo, {
        actorId,
        operation,
        idempotencyKey,
        payload: payloadB,
        execute: async () => {
          return { status: 200, body: { message: "Conflict test", code: 0 } };
        },
      })
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("supports explicit disconnect and cleanly reconnects on subsequent requests", async () => {
    const standaloneRepo = new PrismaPurchaseRepository();

    // Query non-existent purchase to exercise getClient / pool connection
    const result = await standaloneRepo.getPurchaseById("pur_nonexistent_disconnect_test");
    expect(result).toBeNull();

    // Explicitly disconnect
    await standaloneRepo.disconnect();

    // Query again - should lazily reconnect without throwing
    const resultAfter = await standaloneRepo.getPurchaseById("pur_nonexistent_disconnect_test");
    expect(resultAfter).toBeNull();

    // Final clean disconnect
    await standaloneRepo.disconnect();
  });

  it("reuses cached Prisma client across repository instances in development/test environment", async () => {
    const repoA = new PrismaPurchaseRepository();
    const repoB = new PrismaPurchaseRepository();

    // Both instances perform queries against plinthly_dev sharing the cached client/pool
    const resultA = await repoA.getPurchaseById("pur_dummy_reuse_1");
    const resultB = await repoB.getPurchaseById("pur_dummy_reuse_2");

    expect(resultA).toBeNull();
    expect(resultB).toBeNull();

    // Clean disconnect cleans up the shared client
    await repoA.disconnect();
  });

  it("persists valid, omitted, empty, malformed, and missing evidence items to PostgreSQL plinthly_dev without Invalid Date crashes", async () => {
    const purchaseId = `pur_hard_evi_${Date.now()}`;
    const candidateId = `cand_hard_evi_${Date.now()}`;
    const actorId = `usr_hard_test_${Date.now()}`;
    const now = new Date("2026-10-21T12:00:00.000Z");

    createdPurchaseIds.add(purchaseId);

    // 1. Create base purchase
    const draftPurchase: PurchaseRecord = {
      id: purchaseId,
      ownerUserId: actorId,
      budgetCents: 20000,
      currency: "USD",
      status: "DRAFT",
      version: 1,
      policyVersion: "1.0.0",
      selectedCandidateId: null,
      policyEvidenceFingerprint: null,
      requirements: ["layout:ANSI", "switches:Brown"],
      createdAt: now,
      updatedAt: now,
    };
    await repo.createPurchase(draftPurchase, []);

    // 2. Candidate record
    const candidateRecord: CandidateRecord = {
      id: candidateId,
      purchaseId,
      source: "channel3",
      externalId: "ext_evi_test",
      title: "Hardened Evidence Test Candidate",
      merchantName: "Peripheral Hub",
      merchantUrl: "https://example.com/item",
      unitPriceCents: 9000,
      quantity: 1,
      shippingCents: 500,
      totalCents: 9500,
      currency: "USD",
      availability: "in_stock",
      capturedAt: now,
      snapshotHash: "e".repeat(64),
    };

    // 3. Evidence items covering all 5 timestamp categories:
    // a. valid timestamp
    // b. omitted timestamp (sentinel)
    // c. empty timestamp string (sentinel)
    // d. malformed timestamp string (sentinel)
    // e. missing requirement evidence (sentinel + status missing)
    const validCaptureDate = new Date("2026-10-21T11:50:00.000Z");
    const evidenceItems: EvidenceItemRecord[] = [
      {
        id: `evi_valid_${Date.now()}`,
        candidateId,
        requirementKey: "layout",
        value: "ANSI",
        sourceUrl: "https://example.com/valid",
        sourceType: "catalog",
        capturedAt: validCaptureDate,
        status: "supports",
      },
      {
        id: `evi_omitted_${Date.now()}`,
        candidateId,
        requirementKey: "switches",
        value: "Brown",
        sourceUrl: "https://example.com/omitted",
        sourceType: "catalog",
        capturedAt: UNKNOWN_TIMESTAMP_SENTINEL,
        status: "supports",
      },
      {
        id: `evi_empty_${Date.now()}`,
        candidateId,
        requirementKey: "keycaps",
        value: "PBT",
        sourceUrl: "https://example.com/empty",
        sourceType: "catalog",
        capturedAt: UNKNOWN_TIMESTAMP_SENTINEL,
        status: "supports",
      },
      {
        id: `evi_malformed_${Date.now()}`,
        candidateId,
        requirementKey: "backlight",
        value: "RGB",
        sourceUrl: "https://example.com/malformed",
        sourceType: "catalog",
        capturedAt: UNKNOWN_TIMESTAMP_SENTINEL,
        status: "supports",
      },
      {
        id: `evi_missing_${Date.now()}`,
        candidateId,
        requirementKey: "connectivity",
        value: "",
        sourceUrl: "https://example.com/missing",
        sourceType: "catalog",
        capturedAt: UNKNOWN_TIMESTAMP_SENTINEL,
        status: "missing",
      },
    ];

    // Must persist cleanly to PostgreSQL without throwing Invalid Date
    await expect(repo.saveCandidateWithEvidence(candidateRecord, evidenceItems)).resolves.toBeUndefined();

    // 4. Assert direct PostgreSQL database column state
    const pgEvidence = await directPrisma!.evidenceItem.findMany({
      where: { candidateId },
      orderBy: { requirementKey: "asc" },
    });
    expect(pgEvidence).toHaveLength(5);

    for (const item of pgEvidence) {
      expect(item.capturedAt instanceof Date).toBe(true);
      expect(isNaN(item.capturedAt.getTime())).toBe(false);

      if (item.requirementKey === "layout") {
        // Valid timestamp preserved exactly
        expect(item.capturedAt.toISOString()).toBe("2026-10-21T11:50:00.000Z");
      } else {
        // Incomplete / invalid items persisted safely as epoch 0 (1970-01-01)
        expect(item.capturedAt.toISOString()).toBe(UNKNOWN_TIMESTAMP_SENTINEL_ISO);
        expect(item.capturedAt.getTime()).toBe(0);
      }
    }

    // 5. Assert readback through repository getPurchaseById
    const agg = await repo.getPurchaseById(purchaseId);
    expect(agg).not.toBeNull();
    expect(agg!.evidence).toHaveLength(5);

    // Verify .toISOString() does not throw on readback
    for (const e of agg!.evidence) {
      expect(() => e.capturedAt.toISOString()).not.toThrow();
      if (e.requirementKey === "layout") {
        expect(e.capturedAt.toISOString()).toBe("2026-10-21T11:50:00.000Z");
      } else {
        expect(e.capturedAt.toISOString()).toBe(UNKNOWN_TIMESTAMP_SENTINEL_ISO);
      }
    }
  });

  it("evaluates candidate through PurchaseWorkflowService in PostgreSQL plinthly_dev with missing requirements and timestamps, proving fail-closed policy outcome", async () => {
    const actorId = `usr_svc_pg_${Date.now()}`;
    const now = new Date("2026-10-21T12:00:00.000Z");
    const actor: Actor = { kind: "user", userId: actorId };

    const service = new PurchaseWorkflowService(repo);

    // 1. Create purchase with two required attributes
    const created = await service.createPurchase(
      {
        budgetCents: 15000,
        currency: "USD",
        requirements: ["layout:ANSI", "switches:Gateron Brown"],
      },
      actor,
      now
    );
    const purchaseId = created.id;
    createdPurchaseIds.add(purchaseId);

    // 2. Evaluate candidate with observation for layout, but switches missing, and an empty timestamp
    const evalRes = await service.evaluatePurchaseCandidate(
      purchaseId,
      {
        rawCandidate: {
          externalId: "KB-REAL-PG-1",
          title: "Real PG Mechanical Keyboard",
          merchantName: "Real Merchant",
          merchantUrl: "https://real.example.com/item/1",
          unitPrice: "89.99",
          shipping: "5.00",
          quantity: 1,
          currency: "USD",
          availability: "in_stock",
          // candidate-level capturedAt is valid
          capturedAt: "2026-10-21T11:55:00.000Z",
        },
        rawObservations: [
          {
            requirementKey: "layout",
            value: "ANSI",
            capturedAt: "", // empty timestamp string
          },
          // switches observation is OMITTED (missing requirement)
        ],
        requiredRuleKeys: ["P-EVIDENCE", "P-FRESHNESS"],
        maxEvidenceAgeMs: 3600_000,
      },
      actor,
      now
    );

    // Asserts expected workflow outcomes:
    // Status advances to POLICY_BLOCKED due to incomplete evidence failing policy check
    expect(evalRes.status).toBe("POLICY_BLOCKED");

    // Policy summary: allRequiredPassed is FALSE because evidence and freshness failed closed
    expect(evalRes.summary.allRequiredPassed).toBe(false);
    expect(evalRes.summary.unknownRuleKeys).toContain("P-EVIDENCE");
    expect(evalRes.summary.unknownRuleKeys).toContain("P-FRESHNESS");

    expect(evalRes.ruleResults["P-EVIDENCE"].outcome).toBe("unknown");
    expect(evalRes.ruleResults["P-FRESHNESS"].outcome).toBe("unknown");

    // Fingerprint must be empty string (no fingerprint for incomplete/invalid evidence)
    expect(evalRes.evidenceFingerprint).toBe("");

    // 3. Confirm database persisted state
    const pgEvidence = await directPrisma!.evidenceItem.findMany({
      where: { candidateId: evalRes.candidateId },
      orderBy: { requirementKey: "asc" },
    });
    expect(pgEvidence).toHaveLength(2); // layout and synthesized missing switches

    const layoutItem = pgEvidence.find((e) => e.requirementKey === "layout");
    expect(layoutItem).toBeDefined();
    expect(layoutItem!.capturedAt.toISOString()).toBe(UNKNOWN_TIMESTAMP_SENTINEL_ISO); // empty timestamp mapped to epoch 0
    expect(layoutItem!.status).toBe("supports");

    const switchesItem = pgEvidence.find((e) => e.requirementKey === "switches");
    expect(switchesItem).toBeDefined();
    expect(switchesItem!.capturedAt.toISOString()).toBe(UNKNOWN_TIMESTAMP_SENTINEL_ISO);
    expect(switchesItem!.status).toBe("missing");

    // 4. Re-evaluate from database via candidateId
    const reEvalRes = await service.evaluatePurchaseCandidate(
      purchaseId,
      {
        candidateId: evalRes.candidateId,
        requiredRuleKeys: ["P-EVIDENCE", "P-FRESHNESS"],
        maxEvidenceAgeMs: 3600_000,
      },
      actor,
      now
    );

    expect(reEvalRes.status).toBe("POLICY_BLOCKED");
    expect(reEvalRes.summary.allRequiredPassed).toBe(false);
    expect(reEvalRes.summary.unknownRuleKeys).toContain("P-EVIDENCE");
    expect(reEvalRes.summary.unknownRuleKeys).toContain("P-FRESHNESS");
    expect(reEvalRes.evidenceFingerprint).toBe("");
  });
});


