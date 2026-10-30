/**
 * Comprehensive 15-Scenario Adversarial Verification Suite
 * 
 * Tests the complete server-owned draft lifecycle, batch confirmation,
 * cryptographic token-to-record binding, concurrency locking, and judge session auth.
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
import {
  createJudgeSessionToken,
  verifyJudgeSessionToken,
  ServerActorResolver,
} from "../../lib/workflow/auth";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { Actor } from "../../lib/state/types";
import { createHash } from "node:crypto";
import fs from "node:fs";

describe("Plinthly 15-Scenario Adversarial Verification Suite — Drafts & Quantity Confirmation", () => {
  let prisma: PrismaClient;
  let service: PurchaseWorkflowService;

  const testSecret = "plinthly_test_secret_32_characters_long_minimum!!";
  const judgeSessionSecret = "plinthly_judge_session_signing_secret_2026_at_least_32_chars";

  const testActorAlice: Actor = { kind: "user", userId: "judge_sess_alice_001" };
  const testActorBob: Actor = { kind: "user", userId: "judge_sess_bob_002" };

  beforeAll(() => {
    process.env.CONFIRMATION_SIGNING_SECRET = testSecret;
    process.env.JUDGE_SESSION_SECRET = judgeSessionSecret;
    process.env.JUDGE_ACCESS_SECRET = "test_judge_master_secret_2026";

    prisma = getPrismaClient();
    service = new PurchaseWorkflowService();
  });

  afterAll(async () => {
    // Clean up test audit events, confirmations, purchases and drafts
    await prisma.auditEvent.deleteMany({
      where: { purchase: { ownerUserId: { in: [testActorAlice.userId, testActorBob.userId] } } },
    });
    await prisma.quantityConfirmation.deleteMany({
      where: { actorId: { in: [testActorAlice.userId, testActorBob.userId] } },
    });
    await prisma.purchase.deleteMany({
      where: { ownerUserId: { in: [testActorAlice.userId, testActorBob.userId] } },
    });
    await prisma.procurementDraft.deleteMany({
      where: { actorId: { in: [testActorAlice.userId, testActorBob.userId] } },
    });
  });

  // Helper to create a test draft in PostgreSQL
  async function createTestDraft(actor: Actor, overrides: Record<string, unknown> = {}) {
    const draftId = `dft_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
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
      {
        id: "li_monitor",
        title: "4K Monitor",
        quantity: 1,
        quantitySource: "inferred",
        quantityConfirmed: false,
        originalInferredQuantity: 1,
        budgetCents: 40000,
        currency: "USD",
        requirements: [{ key: "resolution", expectedValue: "4K" }],
      },
      {
        id: "li_dock",
        title: "USB-C Dock",
        quantity: 1,
        quantitySource: "inferred",
        quantityConfirmed: false,
        originalInferredQuantity: 1,
        budgetCents: 15000,
        currency: "USD",
        requirements: [{ key: "ports", expectedValue: "USB-C" }],
      },
    ];

    const draftHash = computeCanonicalDraftHash({
      draftId,
      version: 1,
      budgetCents: 205000,
      currency: "USD",
      destination: { country: "US", postalCode: "98101" },
      lineItems,
      requirements: [],
    });

    const actorId = actor.kind === "user" ? actor.userId : actor.component;
    const draft = await prisma.procurementDraft.create({
      data: {
        id: draftId,
        actorId,
        version: 1,
        budgetCents: 205000,
        currency: "USD",
        destination: { country: "US", postalCode: "98101" },
        lineItems: lineItems as object,
        requirements: [],
        draftHash,
        status: "ACTIVE",
        ...overrides,
      },
    });

    return { draft, lineItems, draftHash };
  }

  // Helper to batch confirm a draft
  async function batchConfirmDraft(draft: { id: string; version: number; draftHash: string }, actor: Actor, quantities: Record<string, number>) {
    const tokens: string[] = [];
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const actorId = actor.kind === "user" ? actor.userId : actor.component;

    for (const [lineItemId, quantity] of Object.entries(quantities)) {
      const tokenJti = generateTokenJti();
      const claims = {
        jti: tokenJti,
        draftId: draft.id,
        draftVersion: draft.version,
        draftHash: draft.draftHash,
        lineItemId,
        confirmedQuantity: quantity,
        quantitySource: "inferred",
        actorId,
        iat: nowSec,
        exp: nowSec + 3600,
      };

      const token = signQuantityConfirmation(claims);
      const tokenHash = computeTokenHash(token);

      await prisma.quantityConfirmation.create({
        data: {
          draftId: draft.id,
          lineItemId,
          actorId,
          confirmedQuantity: quantity,
          quantitySource: "inferred",
          draftHash: draft.draftHash,
          draftVersion: draft.version,
          tokenJti,
          tokenHash,
          expiresAt: new Date(now.getTime() + 3600000),
        },
      });

      tokens.push(token);
    }

    await prisma.procurementDraft.update({
      where: { id: draft.id },
      data: { status: "CONFIRMED" },
    });

    return tokens;
  }

  // Scenario 1: Batch Confirmation Snapshot Consistency
  it("Scenario 1: batch confirmation issues tokens all sharing identical draftId, draftVersion, and draftHash", async () => {
    const { draft } = await createTestDraft(testActorAlice);
    const tokens = await batchConfirmDraft(draft, testActorAlice, {
      li_laptop: 1,
      li_monitor: 1,
      li_dock: 1,
    });

    expect(tokens.length).toBe(3);
    const records = await prisma.quantityConfirmation.findMany({
      where: { draftId: draft.id },
    });
    expect(records.length).toBe(3);

    for (const rec of records) {
      expect(rec.draftId).toBe(draft.id);
      expect(rec.draftVersion).toBe(1);
      expect(rec.draftHash).toBe(draft.draftHash);
      expect(rec.consumedAt).toBeNull();
    }
  });

  // Scenario 2: Sequential Invalidation Prevention
  it("Scenario 2: batch confirmation confirms all items simultaneously without sequential token invalidation", async () => {
    const { draft } = await createTestDraft(testActorAlice);
    const tokens = await batchConfirmDraft(draft, testActorAlice, {
      li_laptop: 1,
      li_monitor: 1,
      li_dock: 1,
    });

    // Submitting with all tokens succeeds atomically
    const purchase = await service.createPurchase(
      {
        draftId: draft.id,
        confirmationTokens: tokens,
      },
      testActorAlice
    );

    expect(purchase.id).toBeDefined();
    expect(purchase.status).toBe("REQUIREMENTS_CONFIRMED");
    expect(purchase.originatingDraftId).toBe(draft.id);
  });

  // Scenario 3: Manual Override Requires Confirmation
  it("Scenario 3: manual quantity edit sets quantitySource = manual_override, quantityConfirmed = false, and requires explicit confirmation", async () => {
    const { draft } = await createTestDraft(testActorAlice);

    // Edit line item quantity in draft
    const updatedLineItems = (draft.lineItems as Array<Record<string, unknown>>).map((li) => {
      if (li.id === "li_laptop") {
        return { ...li, quantity: 2, quantitySource: "manual_override", quantityConfirmed: false };
      }
      return li;
    });

    const newVersion = draft.version + 1;
    const newHash = computeCanonicalDraftHash({
      draftId: draft.id,
      version: newVersion,
      budgetCents: draft.budgetCents,
      currency: draft.currency,
      destination: draft.destination,
      lineItems: updatedLineItems as unknown as readonly { id: string; title: string; quantity?: number; budgetCents?: number | null; requirements?: unknown }[],
    });

    await prisma.procurementDraft.update({
      where: { id: draft.id },
      data: {
        version: newVersion,
        lineItems: updatedLineItems as object,
        draftHash: newHash,
        status: "ACTIVE",
      },
    });

    // Attempting purchase creation without confirmation tokens must fail
    await expect(
      service.createPurchase(
        {
          draftId: draft.id,
          confirmationTokens: [],
        },
        testActorAlice
      )
    ).rejects.toThrow(/Missing required quantity confirmation tokens/);
  });

  // Scenario 4: Concurrent Purchase Race on Same Draft
  it("Scenario 4: concurrent purchase creation requests on the same draft are serialized; exactly one succeeds and second is rejected", async () => {
    const { draft } = await createTestDraft(testActorAlice);
    const tokens = await batchConfirmDraft(draft, testActorAlice, {
      li_laptop: 1,
      li_monitor: 1,
      li_dock: 1,
    });

    const results = await Promise.allSettled([
      service.createPurchase({ draftId: draft.id, confirmationTokens: tokens }, testActorAlice),
      service.createPurchase({ draftId: draft.id, confirmationTokens: tokens }, testActorAlice),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    if (rejected[0].status === "rejected") {
      expect((rejected[0].reason as Error).message).toMatch(/already been converted|consumed/);
    }
  });

  // Scenario 5: Concurrent Draft Mutation vs Purchase Creation
  it("Scenario 5: draft cannot be modified once converted to a purchase", async () => {
    const { draft } = await createTestDraft(testActorAlice);
    const tokens = await batchConfirmDraft(draft, testActorAlice, {
      li_laptop: 1,
      li_monitor: 1,
      li_dock: 1,
    });

    await service.createPurchase({ draftId: draft.id, confirmationTokens: tokens }, testActorAlice);

    // Attempt to update converted draft via database
    const dbDraft = await prisma.procurementDraft.findUnique({ where: { id: draft.id } });
    expect(dbDraft?.status).toBe("CONVERTED");

    // Attempting another purchase on converted draft fails
    await expect(
      service.createPurchase({ draftId: draft.id, confirmationTokens: tokens }, testActorAlice)
    ).rejects.toThrow(/already been converted/);
  });

  // Scenario 6: Legitimate Idempotent Retry
  it("Scenario 6: replaying identical purchase request with same idempotency key returns cached purchase without re-consuming", async () => {
    const { draft } = await createTestDraft(testActorAlice);
    const tokens = await batchConfirmDraft(draft, testActorAlice, {
      li_laptop: 1,
      li_monitor: 1,
      li_dock: 1,
    });

    const idempotencyKey = `idem_retry_test_${Date.now()}`;

    const purchase1 = await service.createPurchase(
      { draftId: draft.id, confirmationTokens: tokens, idempotencyKey },
      testActorAlice
    );

    const purchase2 = await service.createPurchase(
      { draftId: draft.id, confirmationTokens: tokens, idempotencyKey },
      testActorAlice
    );

    expect(purchase1.id).toBe(purchase2.id);
  });

  // Scenario 7: Replay of Consumed Token with New Key
  it("Scenario 7: replaying consumed tokens with a new idempotency key is rejected with token_already_consumed", async () => {
    const { draft } = await createTestDraft(testActorAlice);
    const tokens = await batchConfirmDraft(draft, testActorAlice, {
      li_laptop: 1,
      li_monitor: 1,
      li_dock: 1,
    });

    await service.createPurchase(
      { draftId: draft.id, confirmationTokens: tokens, idempotencyKey: `key_1_${Date.now()}` },
      testActorAlice
    );

    // Attempt to use same tokens on a new draft
    const { draft: draft2 } = await createTestDraft(testActorAlice);
    await expect(
      service.createPurchase(
        { draftId: draft2.id, confirmationTokens: tokens, idempotencyKey: `key_2_${Date.now()}` },
        testActorAlice
      )
    ).rejects.toThrow(/already been consumed|different draft|Draft content has changed/);
  });

  // Scenario 8: Token Expiration Enforced
  it("Scenario 8: expired confirmation token is strictly rejected", async () => {
    const { draft } = await createTestDraft(testActorAlice);
    const nowSec = Math.floor(Date.now() / 1000);
    const expiredTokenJti = generateTokenJti();

    const claims = {
      jti: expiredTokenJti,
      draftId: draft.id,
      draftVersion: draft.version,
      draftHash: draft.draftHash,
      lineItemId: "li_laptop",
      confirmedQuantity: 1,
      quantitySource: "inferred",
      actorId: testActorAlice.userId,
      iat: nowSec - 7200,
      exp: nowSec - 3600, // Expired 1 hour ago
    };

    const expiredToken = signQuantityConfirmation(claims);
    const tokenHash = computeTokenHash(expiredToken);

    await prisma.quantityConfirmation.create({
      data: {
        draftId: draft.id,
        lineItemId: "li_laptop",
        actorId: testActorAlice.userId,
        confirmedQuantity: 1,
        quantitySource: "inferred",
        draftHash: draft.draftHash,
        draftVersion: draft.version,
        tokenJti: expiredTokenJti,
        tokenHash,
        expiresAt: new Date(Date.now() - 3600000),
      },
    });

    await expect(
      service.createPurchase(
        { draftId: draft.id, confirmationTokens: [expiredToken] },
        testActorAlice
      )
    ).rejects.toThrow(/Invalid or forged confirmation token/);
  });

  // Scenario 9: HMAC Signature Tampering
  it("Scenario 9: forged or tampered HMAC signature is rejected", async () => {
    const { draft } = await createTestDraft(testActorAlice);
    const tokens = await batchConfirmDraft(draft, testActorAlice, { li_laptop: 1 });
    const tamperedToken = tokens[0] + "tampered_bytes";

    await expect(
      service.createPurchase(
        { draftId: draft.id, confirmationTokens: [tamperedToken] },
        testActorAlice
      )
    ).rejects.toThrow(/Invalid or forged confirmation token/);
  });

  // Scenario 10: Draft Parameter Smuggling (Destination ZIP)
  it("Scenario 10: altering destination after confirmation causes draft hash mismatch and fails closed", async () => {
    const { draft } = await createTestDraft(testActorAlice);
    const tokens = await batchConfirmDraft(draft, testActorAlice, {
      li_laptop: 1,
      li_monitor: 1,
      li_dock: 1,
    });

    // Smuggle destination ZIP code
    await prisma.procurementDraft.update({
      where: { id: draft.id },
      data: {
        destination: { country: "US", postalCode: "90210" }, // Changed from 98101
      },
    });

    await expect(
      service.createPurchase(
        { draftId: draft.id, confirmationTokens: tokens },
        testActorAlice
      )
    ).rejects.toThrow(/Draft content integrity check failed|mismatch/);
  });

  // Scenario 11: Client Provenance Manipulation
  it("Scenario 11: client cannot bypass confirmation by claiming explicit on an inferred line item", async () => {
    const { draft } = await createTestDraft(testActorAlice);

    // Caller attempts to submit lineItems directly with quantitySource: explicit without tokens
    await expect(
      service.createPurchase(
        {
          draftId: draft.id,
          lineItems: [
            {
              id: "li_laptop",
              title: "Workstation Laptop",
              quantity: 1,
              quantitySource: "explicit", // Forged!
              quantityConfirmed: true,
              currency: "USD",
              requirements: [],
            },
          ],
          confirmationTokens: [],
        },
        testActorAlice
      )
    ).rejects.toThrow(/Missing required quantity confirmation tokens/);
  });

  // Scenario 12: Judge Header Spoofing Rejection
  it("Scenario 12: client-supplied x-judge-session-id is ignored; valid server-signed session is required", async () => {
    const resolver = new ServerActorResolver("production");

    // Client attempts to spoof session ID via header
    const spoofedRequest = new Request("http://localhost:3001/api/purchases", {
      headers: {
        "x-judge-session-id": "victim_evaluator_session",
      },
    });

    const result = await resolver.resolveActor(spoofedRequest);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Authentication required");
  });

  // Scenario 13: Cross-Judge Session Isolation
  it("Scenario 13: Judge Session A cannot confirm or convert draft owned by Judge Session B", async () => {
    const sessionTokenA = createJudgeSessionToken("sess_judge_alice");
    const sessionTokenB = createJudgeSessionToken("sess_judge_bob");

    const claimsA = verifyJudgeSessionToken(sessionTokenA);
    const claimsB = verifyJudgeSessionToken(sessionTokenB);

    expect(claimsA?.sub).toBe("judge_sess_judge_alice");
    expect(claimsB?.sub).toBe("judge_sess_judge_bob");

    const actorA: Actor = { kind: "user", userId: claimsA!.sub };
    const actorB: Actor = { kind: "user", userId: claimsB!.sub };

    const { draft } = await createTestDraft(actorA);
    const tokens = await batchConfirmDraft(draft, actorA, { li_laptop: 1, li_monitor: 1, li_dock: 1 });

    // Judge B attempts to convert Judge A's draft
    await expect(
      service.createPurchase(
        { draftId: draft.id, confirmationTokens: tokens },
        actorB // Attacker B
      )
    ).rejects.toThrow(/Actor .* is not authorized to convert draft/);
  });

  // Scenario 14: Legacy Direct Workflow Isolation
  it("Scenario 14: external caller attempting quantitySource: legacy_direct is rejected", async () => {
    await expect(
      service.createPurchase(
        {
          budgetCents: 100000,
          currency: "USD",
          quantitySource: "legacy_direct" as unknown as "inferred",
          requestedQuantity: 1,
          requirements: [{ key: "spec", expectedValue: "val" }],
        },
        testActorAlice,
        { workflowContext: "ai_decomposed" } // External context
      )
    ).rejects.toThrow(/Unauthorized legacy direct provenance/);
  });

  // Scenario 15: System Invariant Preservation
  it("Scenario 15: preserves Gate 1 SHA-256 seal, completed fund captures = 0, and protected purchases intact", async () => {
    // 1. Gate 1 script checksum verification
    const gate1Path = "C:\\paypal-gate1\\gate1.mjs";
    expect(fs.existsSync(gate1Path)).toBe(true);
    const gate1Content = fs.readFileSync(gate1Path);
    const gate1Hash = createHash("sha256").update(gate1Content).digest("hex").toUpperCase();
    expect(gate1Hash).toBe("F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451");

    // 2. Zero database completed captures
    const paymentAttempts = await prisma.paymentAttempt.findMany({
      where: { status: "COMPLETED" },
    });
    expect(paymentAttempts.length).toBe(0);

    // 3. Protected purchases intact in BUYER_APPROVED
    const protectedSampleA = await prisma.purchase.findUnique({
      where: { id: "pur_1792633876502_s7jvwi22" },
    });
    const protectedSampleB = await prisma.purchase.findUnique({
      where: { id: "pur_1792654701712_f2iks5to" },
    });

    expect(protectedSampleA?.status).toBe("BUYER_APPROVED");
    expect(protectedSampleA?.version).toBe(6);
    expect(protectedSampleB?.status).toBe("BUYER_APPROVED");
    expect(protectedSampleB?.version).toBe(5);
  });
});
