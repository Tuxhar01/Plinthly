/**
 * Dedicated Adversarial Idempotency Concurrency Test Suite
 * 
 * Verifies real PostgreSQL transactional isolation for:
 * 1. Two identical concurrent requests with the same actor, operation, idempotency key, and payload:
 *    - Exactly 1 purchase created
 *    - Exactly 1 idempotency record created
 *    - Both requests return identical successful purchase response
 *    - No unhandled Prisma P2002 or HTTP 500 error
 * 2. Two concurrent requests with different payloads but the same idempotency key:
 *    - Exactly 1 succeeds, conflicting request receives HTTP 409 (IdempotencyConflictError)
 * 3. A failed transaction leaves neither a purchase nor an idempotency record in the database
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { getPrismaClient } from "../../lib/workflow/repository";
import { PrismaClient } from "@prisma/client";
import {
  computeCanonicalDraftHash,
  signQuantityConfirmation,
  generateTokenJti,
  computeTokenHash,
} from "../../lib/workflow/quantity-confirmation";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { IdempotencyConflictError } from "../../lib/workflow/idempotency";

describe("Plinthly — Dedicated Adversarial Idempotency Concurrency Suite (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let service: PurchaseWorkflowService;

  const testActor = { kind: "user" as const, userId: "usr_idem_adversary" };

  beforeAll(() => {
    process.env.CONFIRMATION_SIGNING_SECRET = "plinthly_test_secret_32_characters_long_minimum!!";
    process.env.JUDGE_SESSION_SECRET = "plinthly_judge_session_signing_secret_2026_at_least_32_chars";
    prisma = getPrismaClient();
    service = new PurchaseWorkflowService();
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({
      where: { purchase: { ownerUserId: testActor.userId } },
    });
    await prisma.idempotencyRecord.deleteMany({
      where: { actorId: testActor.userId },
    });
    await prisma.quantityConfirmation.deleteMany({
      where: { actorId: testActor.userId },
    });
    await prisma.purchase.deleteMany({
      where: { ownerUserId: testActor.userId },
    });
    await prisma.procurementDraft.deleteMany({
      where: { actorId: testActor.userId },
    });
  });

  async function createDraftWithToken() {
    const draftId = `dft_idem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const lineItems = [
      {
        id: "li_server",
        title: "Enterprise Server",
        quantity: 1,
        quantitySource: "inferred",
        quantityConfirmed: false,
        originalInferredQuantity: 1,
        budgetCents: 500000,
        currency: "USD",
        requirements: [{ key: "cores", expectedValue: "64" }],
      },
    ];

    const draftHash = computeCanonicalDraftHash({
      draftId,
      version: 1,
      budgetCents: 500000,
      currency: "USD",
      destination: { country: "US", postalCode: "94105" },
      lineItems,
      requirements: [],
    });

    const draft = await prisma.procurementDraft.create({
      data: {
        id: draftId,
        actorId: testActor.userId,
        version: 1,
        budgetCents: 500000,
        currency: "USD",
        destination: { country: "US", postalCode: "94105" },
        lineItems: lineItems as object,
        requirements: [],
        draftHash,
        status: "ACTIVE",
      },
    });

    const tokenJti = generateTokenJti();
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const claims = {
      jti: tokenJti,
      draftId,
      draftVersion: 1,
      draftHash,
      lineItemId: "li_server",
      confirmedQuantity: 1,
      quantitySource: "inferred",
      actorId: testActor.userId,
      iat: nowSec,
      exp: nowSec + 3600,
    };
    const token = signQuantityConfirmation(claims);
    const tokenHash = computeTokenHash(token);

    await prisma.quantityConfirmation.create({
      data: {
        draftId,
        lineItemId: "li_server",
        actorId: testActor.userId,
        confirmedQuantity: 1,
        quantitySource: "inferred",
        draftHash,
        draftVersion: 1,
        tokenJti,
        tokenHash,
        expiresAt: new Date(now.getTime() + 3600000),
      },
    });

    await prisma.procurementDraft.update({
      where: { id: draftId },
      data: { status: "CONFIRMED" },
    });

    return { draft, token, tokenJti, draftHash };
  }

  // 1. Two identical requests sent simultaneously with the same key, actor, and payload
  it("Scenario 1: Two identical concurrent draft conversions -> exactly 1 purchase, 1 idempotency record, identical responses, no P2002 error", async () => {
    const { draft, token } = await createDraftWithToken();
    const idempotencyKey = `idem_race_exact_${Date.now()}`;

    const reqPayload = {
      draftId: draft.id,
      confirmationTokens: [token],
      idempotencyKey,
    };

    // Send two identical requests simultaneously
    const [res1, res2] = await Promise.all([
      service.createPurchase(reqPayload, testActor),
      service.createPurchase(reqPayload, testActor),
    ]);

    // Both requests must return the exact same successful purchase response
    expect(res1.id).toBeDefined();
    expect(res2.id).toBeDefined();
    expect(res1.id).toBe(res2.id);
    expect(res1.status).toBe(res2.status);
    expect(res1.budgetCents).toBe(res2.budgetCents);
    expect(res1.currency).toBe(res2.currency);
    expect(res1.createdAt).toBe(res2.createdAt);

    // Exactly one purchase was created in PostgreSQL
    const purchases = await prisma.purchase.findMany({
      where: { originatingDraftId: draft.id },
    });
    expect(purchases.length).toBe(1);

    // Exactly one idempotency record was created in PostgreSQL
    const idemRecords = await prisma.idempotencyRecord.findMany({
      where: {
        actorId: testActor.userId,
        operation: "create_purchase",
        key: idempotencyKey,
      },
    });
    expect(idemRecords.length).toBe(1);
    expect(idemRecords[0].responseStatus).toBe(201);
  });

  // 2. Direct purchase creation: two identical requests sent simultaneously with the same key
  it("Scenario 2: Two identical concurrent direct purchase creations -> exactly 1 purchase, 1 idempotency record, identical responses", async () => {
    const idempotencyKey = `idem_race_direct_${Date.now()}`;

    const reqPayload = {
      budgetCents: 15000,
      currency: "USD" as const,
      requirements: ["cloud_compute_cluster"],
      idempotencyKey,
    };

    // Send two identical direct requests simultaneously
    const [res1, res2] = await Promise.all([
      service.createPurchase(reqPayload, testActor, { workflowContext: "legacy_direct" }),
      service.createPurchase(reqPayload, testActor, { workflowContext: "legacy_direct" }),
    ]);

    // Both return identical purchase response
    expect(res1.id).toBe(res2.id);
    expect(res1.createdAt).toBe(res2.createdAt);

    // Exactly one purchase created
    const purchaseCount = await prisma.purchase.count({
      where: { id: res1.id },
    });
    expect(purchaseCount).toBe(1);

    // Exactly one idempotency record created
    const idemCount = await prisma.idempotencyRecord.count({
      where: {
        actorId: testActor.userId,
        operation: "create_purchase",
        key: idempotencyKey,
      },
    });
    expect(idemCount).toBe(1);
  });

  // 3. Two concurrent requests with different payloads but the same key -> HTTP 409 conflict
  it("Scenario 3: Two concurrent requests with different payloads but the same key -> exactly 1 succeeds, conflicting receives 409", async () => {
    const idempotencyKey = `idem_race_conflict_${Date.now()}`;

    const payloadA = {
      budgetCents: 20000,
      currency: "USD" as const,
      requirements: ["workstation_a"],
      idempotencyKey,
    };

    const payloadB = {
      budgetCents: 35000,
      currency: "USD" as const,
      requirements: ["workstation_b_different"],
      idempotencyKey,
    };

    const [resA, resB] = await Promise.allSettled([
      service.createPurchase(payloadA, testActor, { workflowContext: "legacy_direct" }),
      service.createPurchase(payloadB, testActor, { workflowContext: "legacy_direct" }),
    ]);

    const fulfilled = [resA, resB].filter((r) => r.status === "fulfilled");
    const rejected = [resA, resB].filter((r) => r.status === "rejected");

    // Exactly one must succeed, and one must be rejected with 409 IdempotencyConflictError
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejection = rejected[0] as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(IdempotencyConflictError);
    expect((rejection.reason as IdempotencyConflictError).statusCode).toBe(409);
    expect((rejection.reason as IdempotencyConflictError).code).toBe("idempotency_conflict");

    // Exactly one purchase created
    const winningPurchase = (fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value;
    const purchases = await prisma.purchase.findMany({
      where: { id: winningPurchase.id },
    });
    expect(purchases.length).toBe(1);

    // Exactly one idempotency record created
    const idemRecords = await prisma.idempotencyRecord.findMany({
      where: {
        actorId: testActor.userId,
        operation: "create_purchase",
        key: idempotencyKey,
      },
    });
    expect(idemRecords.length).toBe(1);
  });

  // 4. Sequential retry with different payload on existing committed key -> HTTP 409
  it("Scenario 4: Sequential retry with different payload on existing committed key -> rejects with HTTP 409", async () => {
    const idempotencyKey = `idem_seq_conflict_${Date.now()}`;

    const payload1 = {
      budgetCents: 10000,
      currency: "USD" as const,
      requirements: ["spec_original"],
      idempotencyKey,
    };

    const res1 = await service.createPurchase(payload1, testActor, { workflowContext: "legacy_direct" });
    expect(res1.id).toBeDefined();

    const payload2 = {
      budgetCents: 99999, // Modified budget
      currency: "USD" as const,
      requirements: ["spec_original"],
      idempotencyKey,
    };

    await expect(
      service.createPurchase(payload2, testActor, { workflowContext: "legacy_direct" })
    ).rejects.toThrow(IdempotencyConflictError);

    try {
      await service.createPurchase(payload2, testActor, { workflowContext: "legacy_direct" });
    } catch (err) {
      expect((err as IdempotencyConflictError).statusCode).toBe(409);
    }
  });

  // 5. Failed transaction leaves neither a purchase nor an idempotency record
  it("Scenario 5: Failed transaction leaves neither a purchase nor an idempotency record", async () => {
    const { draft } = await createDraftWithToken();
    const idempotencyKey = `idem_failed_tx_${Date.now()}`;

    // Pass a forged confirmation token that causes transaction failure
    const forgedToken = "header.payload.invalid_signature_that_fails_verification";

    await expect(
      service.createPurchase(
        {
          draftId: draft.id,
          confirmationTokens: [forgedToken],
          idempotencyKey,
        },
        testActor
      )
    ).rejects.toThrow(/Invalid or forged confirmation token|invalid_confirmation_token/);

    // Assert zero purchases created for this draft
    const purchases = await prisma.purchase.findMany({
      where: { originatingDraftId: draft.id },
    });
    expect(purchases.length).toBe(0);

    // Assert zero idempotency records created
    const idemRecords = await prisma.idempotencyRecord.findMany({
      where: {
        actorId: testActor.userId,
        operation: "create_purchase",
        key: idempotencyKey,
      },
    });
    expect(idemRecords.length).toBe(0);

    // Assert draft remains CONFIRMED, NOT CONVERTED
    const dbDraft = await prisma.procurementDraft.findUnique({
      where: { id: draft.id },
    });
    expect(dbDraft?.status).toBe("CONFIRMED");
  });
});

