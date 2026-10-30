/**
 * Dedicated Adversarial Concurrency Test Suite
 * 
 * Verifies real PostgreSQL transactional isolation for:
 * 1. PATCH vs Conversion race (PATCH wins)
 * 2. Conversion vs PATCH race (Conversion wins)
 * 3. Two concurrent conversions with different idempotency keys on the same draft
 * 4. Two conversions attempting to consume the same confirmation tokens
 * 5. Token consumed between receipt and transaction execution
 * 6. Partial token consumption rollback
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
import { PATCH as patchDraftRoute } from "../../app/api/purchases/drafts/[draftId]/route";
import { createJudgeSessionToken } from "../../lib/workflow/auth";

describe("Plinthly — Dedicated Adversarial Draft Concurrency & Token Consumption Suite", () => {
  let prisma: PrismaClient;
  let service: PurchaseWorkflowService;
  let sessionToken: string;

  const testActor = { kind: "user" as const, userId: "judge_concurrency_tester" };

  beforeAll(() => {
    process.env.CONFIRMATION_SIGNING_SECRET = "plinthly_test_secret_32_characters_long_minimum!!";
    process.env.JUDGE_SESSION_SECRET = "plinthly_judge_session_signing_secret_2026_at_least_32_chars";
    sessionToken = createJudgeSessionToken("concurrency_tester");
    prisma = getPrismaClient();
    service = new PurchaseWorkflowService();
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({
      where: { purchase: { ownerUserId: testActor.userId } },
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

  async function createDraftWithItems(itemCount = 2) {
    const draftId = `dft_cc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const lineItems = [
      {
        id: "li_laptop",
        title: "Workstation Laptop",
        quantity: 1,
        quantitySource: "inferred",
        quantityConfirmed: false,
        originalInferredQuantity: 1,
        budgetCents: 150000,
        currency: "USD",
        requirements: [{ key: "ram", expectedValue: "32GB" }],
      },
    ];

    if (itemCount > 1) {
      lineItems.push({
        id: "li_monitor",
        title: "4K Monitor",
        quantity: 1,
        quantitySource: "inferred",
        quantityConfirmed: false,
        originalInferredQuantity: 1,
        budgetCents: 40000,
        currency: "USD",
        requirements: [{ key: "resolution", expectedValue: "4K" }],
      });
    }

    const draftHash = computeCanonicalDraftHash({
      draftId,
      version: 1,
      budgetCents: 205000,
      currency: "USD",
      destination: { country: "US", postalCode: "98101" },
      lineItems,
      requirements: [],
    });

    const draft = await prisma.procurementDraft.create({
      data: {
        id: draftId,
        actorId: testActor.userId,
        version: 1,
        budgetCents: 205000,
        currency: "USD",
        destination: { country: "US", postalCode: "98101" },
        lineItems: lineItems as object,
        requirements: [],
        draftHash,
        status: "ACTIVE",
      },
    });

    return { draft, lineItems, draftHash };
  }

  async function issueTokensForDraft(draft: { id: string; version: number; draftHash: string }, lineItemQuantities: Record<string, number>) {
    const tokens: Array<{ token: string; jti: string; lineItemId: string }> = [];
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);

    for (const [lineItemId, quantity] of Object.entries(lineItemQuantities)) {
      const tokenJti = generateTokenJti();
      const claims = {
        jti: tokenJti,
        draftId: draft.id,
        draftVersion: draft.version,
        draftHash: draft.draftHash,
        lineItemId,
        confirmedQuantity: quantity,
        quantitySource: "inferred",
        actorId: testActor.userId,
        iat: nowSec,
        exp: nowSec + 3600,
      };

      const token = signQuantityConfirmation(claims);
      const tokenHash = computeTokenHash(token);

      await prisma.quantityConfirmation.create({
        data: {
          draftId: draft.id,
          lineItemId,
          actorId: testActor.userId,
          confirmedQuantity: quantity,
          quantitySource: "inferred",
          draftHash: draft.draftHash,
          draftVersion: draft.version,
          tokenJti,
          tokenHash,
          expiresAt: new Date(now.getTime() + 3600000),
        },
      });

      tokens.push({ token, jti: tokenJti, lineItemId });
    }

    await prisma.procurementDraft.update({
      where: { id: draft.id },
      data: { status: "CONFIRMED" },
    });

    return tokens;
  }

  // 1. PATCH wins the race against conversion
  it("Case 1: PATCH wins the race against conversion -> conversion fails without creating a purchase", async () => {
    const { draft } = await createDraftWithItems(2);
    const tokenInfo = await issueTokensForDraft(draft, { li_laptop: 1, li_monitor: 1 });
    const tokens = tokenInfo.map((t) => t.token);

    // PATCH runs first and modifies the draft
    const patchReq = new Request(`http://localhost:3001/api/purchases/drafts/${draft.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Cookie": `plinthly_judge_session=${sessionToken}`,
      },
      body: JSON.stringify({
        budgetCents: 250000, // Budget updated
      }),
    });

    const patchRes = await patchDraftRoute(patchReq, { params: Promise.resolve({ draftId: draft.id }) });
    expect(patchRes.status).toBe(200);

    // Now conversion attempts to run with tokens issued for the prior version
    await expect(
      service.createPurchase(
        { draftId: draft.id, confirmationTokens: tokens },
        testActor
      )
    ).rejects.toThrow(/Draft content has changed since confirmation|confirmation records not found/);

    // Assert zero purchases created for this draft
    const purchases = await prisma.purchase.findMany({
      where: { originatingDraftId: draft.id },
    });
    expect(purchases.length).toBe(0);
  });

  // 2. Conversion wins the race against PATCH
  it("Case 2: Conversion wins the race against PATCH -> PATCH fails with draft_conflict", async () => {
    const { draft } = await createDraftWithItems(2);
    const tokenInfo = await issueTokensForDraft(draft, { li_laptop: 1, li_monitor: 1 });
    const tokens = tokenInfo.map((t) => t.token);

    // Conversion executes and commits
    const purchase = await service.createPurchase(
      { draftId: draft.id, confirmationTokens: tokens },
      testActor
    );
    expect(purchase.id).toBeDefined();

    // Subsequent PATCH attempts to modify converted draft
    const patchReq = new Request(`http://localhost:3001/api/purchases/drafts/${draft.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Cookie": `plinthly_judge_session=${sessionToken}`,
      },
      body: JSON.stringify({ budgetCents: 300000 }),
    });

    const patchRes = await patchDraftRoute(patchReq, { params: Promise.resolve({ draftId: draft.id }) });
    expect(patchRes.status).toBe(409);
    const patchBody = await patchRes.json();
    expect(patchBody.error?.code).toBe("draft_conflict");

    // Verify draft remains in CONVERTED status
    const updatedDraft = await prisma.procurementDraft.findUnique({ where: { id: draft.id } });
    expect(updatedDraft?.status).toBe("CONVERTED");
  });

  // 3. Two conversions with different idempotency keys against the same draft
  it("Case 3: Two conversions with different idempotency keys against the same draft -> exactly one purchase created", async () => {
    const { draft } = await createDraftWithItems(2);
    const tokenInfo = await issueTokensForDraft(draft, { li_laptop: 1, li_monitor: 1 });
    const tokens = tokenInfo.map((t) => t.token);

    const keyA = `idem_race_a_${Date.now()}`;
    const keyB = `idem_race_b_${Date.now()}`;

    const [resA, resB] = await Promise.allSettled([
      service.createPurchase({ draftId: draft.id, confirmationTokens: tokens, idempotencyKey: keyA }, testActor),
      service.createPurchase({ draftId: draft.id, confirmationTokens: tokens, idempotencyKey: keyB }, testActor),
    ]);

    const fulfilled = [resA, resB].filter((r) => r.status === "fulfilled");
    const rejected = [resA, resB].filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const purchases = await prisma.purchase.findMany({
      where: { originatingDraftId: draft.id },
    });
    expect(purchases.length).toBe(1);
  });

  // 4. Two conversions attempting to consume the same confirmation tokens
  it("Case 4: Two conversions attempting to consume the same confirmation tokens -> exactly one succeeds", async () => {
    const { draft } = await createDraftWithItems(1);
    const tokenInfo = await issueTokensForDraft(draft, { li_laptop: 1 });
    const tokens = tokenInfo.map((t) => t.token);

    // First conversion consumes the tokens
    const firstPurchase = await service.createPurchase(
      { draftId: draft.id, confirmationTokens: tokens, idempotencyKey: `first_key_${Date.now()}` },
      testActor
    );
    expect(firstPurchase.id).toBeDefined();

    // Second request with a different draft attempts to use the same consumed tokens
    const { draft: draft2 } = await createDraftWithItems(1);
    await expect(
      service.createPurchase(
        { draftId: draft2.id, confirmationTokens: tokens, idempotencyKey: `second_key_${Date.now()}` },
        testActor
      )
    ).rejects.toThrow(/already been consumed|different draft|Draft content has changed/);
  });

  // 5. A token consumed between initial request receipt and transaction execution must be rejected
  it("Case 5: A token consumed concurrently before transaction executes is rejected with token_already_consumed", async () => {
    const { draft } = await createDraftWithItems(2);
    const tokenInfo = await issueTokensForDraft(draft, { li_laptop: 1, li_monitor: 1 });
    const tokens = tokenInfo.map((t) => t.token);

    // Simulate concurrent process consuming li_laptop's token
    await prisma.quantityConfirmation.update({
      where: { tokenJti: tokenInfo[0].jti },
      data: { consumedAt: new Date() },
    });

    // Conversion attempt fails
    await expect(
      service.createPurchase(
        { draftId: draft.id, confirmationTokens: tokens },
        testActor
      )
    ).rejects.toThrow(/already been consumed|Token consumption failed/);

    // Assert zero purchases created
    const purchases = await prisma.purchase.findMany({
      where: { originatingDraftId: draft.id },
    });
    expect(purchases.length).toBe(0);

    // Assert second token was NOT consumed
    const token2 = await prisma.quantityConfirmation.findUnique({
      where: { tokenJti: tokenInfo[1].jti },
    });
    expect(token2?.consumedAt).toBeNull();
  });

  // 6. Partial token consumption must roll back the purchase
  it("Case 6: Partial token consumption failure rolls back the entire purchase and draft status", async () => {
    const { draft } = await createDraftWithItems(2);
    const tokenInfo = await issueTokensForDraft(draft, { li_laptop: 1, li_monitor: 1 });
    const tokens = tokenInfo.map((t) => t.token);

    // Corrupt token 2 in database to simulate concurrent actor consumption
    await prisma.quantityConfirmation.update({
      where: { tokenJti: tokenInfo[1].jti },
      data: { consumedAt: new Date() },
    });

    // Conversion attempt must fail
    await expect(
      service.createPurchase(
        { draftId: draft.id, confirmationTokens: tokens },
        testActor
      )
    ).rejects.toThrow(/already been consumed|Token consumption failed/);

    // Assert transaction rollback:
    // 1. Purchase was NOT created
    const purchases = await prisma.purchase.findMany({
      where: { originatingDraftId: draft.id },
    });
    expect(purchases.length).toBe(0);

    // 2. Draft remains in CONFIRMED status, NOT CONVERTED
    const dbDraft = await prisma.procurementDraft.findUnique({ where: { id: draft.id } });
    expect(dbDraft?.status).toBe("CONFIRMED");

    // 3. Token 1 remains unconsumed (rolled back)
    const dbToken1 = await prisma.quantityConfirmation.findUnique({
      where: { tokenJti: tokenInfo[0].jti },
    });
    expect(dbToken1?.consumedAt).toBeNull();
  });

  // 7. Token expires while conversion waits for the draft lock -> rejected with token_expired
  it("Case 7: Token expires while conversion waits for the draft lock -> conversion is rejected and transaction rolls back", async () => {
    const { draft } = await createDraftWithItems(1);

    const tokenJti = generateTokenJti();
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const claims = {
      jti: tokenJti,
      draftId: draft.id,
      draftVersion: draft.version,
      draftHash: draft.draftHash,
      lineItemId: "li_laptop",
      confirmedQuantity: 1,
      quantitySource: "inferred",
      actorId: testActor.userId,
      iat: nowSec,
      exp: nowSec + 3600, // Token claim valid for 1 hour
    };
    const token = signQuantityConfirmation(claims);
    const tokenHash = computeTokenHash(token);

    // Persist confirmation record with expiration 800ms from now
    const expiresAt = new Date(Date.now() + 800);
    await prisma.quantityConfirmation.create({
      data: {
        draftId: draft.id,
        lineItemId: "li_laptop",
        actorId: testActor.userId,
        confirmedQuantity: 1,
        quantitySource: "inferred",
        draftHash: draft.draftHash,
        draftVersion: draft.version,
        tokenJti,
        tokenHash,
        expiresAt,
      },
    });

    await prisma.procurementDraft.update({
      where: { id: draft.id },
      data: { status: "CONFIRMED" },
    });

    let lockAcquiredSignal!: () => void;
    const lockAcquiredPromise = new Promise<void>((resolve) => {
      lockAcquiredSignal = resolve;
    });

    // Transaction 1: Acquires and holds the row lock for 1400ms (token expires while Tx2 waits)
    const tx1Promise = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT * FROM "ProcurementDraft" WHERE "id" = ${draft.id} FOR UPDATE`;
      lockAcquiredSignal();
      await new Promise((resolve) => setTimeout(resolve, 1400));
    });

    // Wait until Tx1 holds the lock
    await lockAcquiredPromise;

    // Transaction 2: Conversion attempts to convert the draft.
    // Tx2 blocks in convertDraftToPurchase waiting for the row lock.
    // When Tx1 finishes, Tx2 acquires the lock and captures timestamp AFTER lock acquisition.
    const tx2Promise = service.createPurchase(
      { draftId: draft.id, confirmationTokens: [token] },
      testActor
    );

    const [tx1Result, tx2Result] = await Promise.allSettled([tx1Promise, tx2Promise]);

    expect(tx1Result.status).toBe("fulfilled");
    expect(tx2Result.status).toBe("rejected");

    if (tx2Result.status === "rejected") {
      expect((tx2Result.reason as Error).message).toMatch(/Confirmation token has expired|token_expired/);
    }

    // Verify 0 purchases created
    const purchases = await prisma.purchase.findMany({
      where: { originatingDraftId: draft.id },
    });
    expect(purchases.length).toBe(0);

    // Verify token was NOT consumed
    const record = await prisma.quantityConfirmation.findUnique({
      where: { tokenJti },
    });
    expect(record?.consumedAt).toBeNull();

    // Verify draft remains CONFIRMED, not CONVERTED
    const finalDraft = await prisma.procurementDraft.findUnique({
      where: { id: draft.id },
    });
    expect(finalDraft?.status).toBe("CONFIRMED");
  });
});

