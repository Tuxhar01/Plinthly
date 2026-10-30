/**
 * Plinthly Adversarial Verification Suite — Quantity Confirmation & Provenance Security
 *
 * Verifies 12 adversarial attack and edge case scenarios:
 *  1. Direct API submission of inferred item with quantityConfirmed: true without token (REJECTED)
 *  2. Forgery attempts for confirmedBy and confirmedAt (REJECTED or OVERWRITTEN)
 *  3. Missing quantitySource with quantityConfirmed: true and false in AI workflow (STRICTLY ENFORCED)
 *  4. Provenance combinations matrix: explicit, inferred, unresolved, legacy_direct
 *  5. External legacy_direct submission rejection (HTTP 400 / Zod validation error)
 *  6. Proposed audit event authentic actor and timestamp enforcement
 *  7. Quantity changed after confirmation invalidates prior confirmation
 *  8. Re-issued confirmation token required after quantity edit
 *  9. Token cross-item replay attack: token for line_1 rejected on line_2
 * 10. Token quantity tampering: token confirmed for qty 1 rejected when submitting qty 3
 * 11. Token actor mismatch / spoofing: token confirmed by Actor A rejected when submitted by Actor B
 * 12. Draft tampering attack: token issued for draft A rejected after budget or item modification
 */

import { describe, it, expect, beforeEach, beforeAll } from "vitest";

beforeAll(() => {
  process.env.CONFIRMATION_SIGNING_SECRET = "plinthly_test_secret_32_characters_long_minimum!!";
});
import {
  computeDraftHash,
  signQuantityConfirmation,
} from "../../lib/workflow/quantity-confirmation";
import { validateProcurementLineItems } from "../../lib/discovery/cart/line-item";
import { createPurchaseSchema } from "../../lib/workflow/validation";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { Actor, AuditPayloadProposed } from "../../lib/state/types";
import { CreatePurchaseRequest } from "../../lib/workflow/types";

describe("Plinthly Adversarial Verification — Quantity Confirmation Security", () => {
  let repo: InMemoryPurchaseRepository;
  let service: PurchaseWorkflowService;

  const actorBuyerA: Actor = { kind: "user", userId: "usr_buyer_alice" };
  const actorBuyerB: Actor = { kind: "user", userId: "usr_attacker_bob" };

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
    service = new PurchaseWorkflowService(repo);
  });

  // Scenario 1: Direct API submission with quantityConfirmed: true without server token
  it("Scenario 1: rejects direct API submission of inferred item with quantityConfirmed: true lacking confirmationToken", async () => {
    const maliciousPayload = {
      budgetCents: 150000,
      currency: "USD",
      lineItems: [
        {
          id: "item_laptop",
          title: "Workstation Laptop",
          quantity: 1,
          quantitySource: "inferred" as const,
          quantityConfirmed: true, // Attacker attempts to bypass confirmation
          originalInferredQuantity: 1,
          currency: "USD",
          requirements: [],
        },
      ],
    };

    // Schema level rejection
    const zodResult = createPurchaseSchema.safeParse(maliciousPayload);
    expect(zodResult.success).toBe(false);
    if (!zodResult.success) {
      expect(zodResult.error.issues[0]?.message).toContain("confirmation token");
    }

    // Service level rejection
    await expect(
      service.createPurchase(
        maliciousPayload as unknown as CreatePurchaseRequest,
        actorBuyerA,
        { workflowContext: "ai_decomposed" }
      )
    ).rejects.toThrow(/Invalid multi-item procurement line items/);
  });

  // Scenario 2: Attempt to forge confirmedBy and confirmedAt at top-level and line-item levels
  it("Scenario 2: rejects forged client-provided confirmedBy and confirmedAt; authenticates via server context", async () => {
    const forgedToken = "not_a_real_token.unsigned_signature";
    const forgedPayload = {
      budgetCents: 150000,
      currency: "USD",
      lineItems: [
        {
          id: "item_laptop",
          title: "Workstation Laptop",
          quantity: 1,
          quantitySource: "inferred" as const,
          quantityConfirmed: true,
          confirmationToken: forgedToken,
          confirmedBy: "forged_admin_user",
          confirmedAt: "2020-01-01T00:00:00.000Z",
          currency: "USD",
          requirements: [],
        },
      ],
    };

    await expect(
      service.createPurchase(
        forgedPayload as unknown as CreatePurchaseRequest,
        actorBuyerA,
        { workflowContext: "ai_decomposed" }
      )
    ).rejects.toThrow(/Invalid multi-item procurement line items/);
  });

  // Scenario 3: Missing quantitySource with quantityConfirmed: true and false
  it("Scenario 3: missing quantitySource in AI workflow is treated as unconfirmed and strictly requires confirmation token", async () => {
    const missingSourceTrue = {
      budgetCents: 150000,
      currency: "USD",
      lineItems: [
        {
          id: "item_1",
          title: "Monitor",
          quantity: 1,
          quantityConfirmed: true, // missing quantitySource
          currency: "USD",
          requirements: [],
        },
      ],
    };

    const res = createPurchaseSchema.safeParse(missingSourceTrue);
    expect(res.success).toBe(false);

    await expect(
      service.createPurchase(
        missingSourceTrue as unknown as CreatePurchaseRequest,
        actorBuyerA,
        { workflowContext: "ai_decomposed" }
      )
    ).rejects.toThrow(/Invalid multi-item procurement line items/);
  });

  // Scenario 4: Provenance combinations matrix
  it("Scenario 4: matrix testing of explicit, inferred, unresolved, and legacy_direct provenance", async () => {
    // Explicit integer quantity: accepted without token
    const explicitItem = {
      id: "line_exp",
      title: "Laptop",
      quantity: 2,
      quantitySource: "explicit" as const,
      currency: "USD",
      requirements: [],
    };
    const explicitVal = validateProcurementLineItems([explicitItem]);
    expect(explicitVal.ok).toBe(true);

    // Inferred without token: rejected
    const inferredNoToken = {
      id: "line_inf",
      title: "Monitor",
      quantity: 1,
      quantitySource: "inferred" as const,
      currency: "USD",
      requirements: [],
    };
    const inferredVal = validateProcurementLineItems([inferredNoToken]);
    expect(inferredVal.ok).toBe(false);

    // Unresolved without token: rejected
    const unresolvedNoToken = {
      id: "line_unres",
      title: "Dock",
      quantity: 1,
      quantitySource: "unresolved" as const,
      currency: "USD",
      requirements: [],
    };
    const unresVal = validateProcurementLineItems([unresolvedNoToken]);
    expect(unresVal.ok).toBe(false);

    // Legacy direct in standard context: rejected
    const legacyItem = {
      id: "line_leg",
      title: "Cable",
      quantity: 1,
      quantitySource: "legacy_direct" as const,
      currency: "USD",
      requirements: [],
    };
    const legacyVal = validateProcurementLineItems([legacyItem]);
    expect(legacyVal.ok).toBe(false);
  });

  // Scenario 5: External legacy_direct cannot be submitted by external caller
  it("Scenario 5: external API caller specifying legacy_direct provenance is rejected with HTTP 400", async () => {
    const maliciousLegacyPayload = {
      budgetCents: 10000,
      currency: "USD",
      quantitySource: "legacy_direct",
      requirements: [{ key: "spec", expectedValue: "standard" }],
    };

    const zodResult = createPurchaseSchema.safeParse(maliciousLegacyPayload);
    expect(zodResult.success).toBe(false);

    // When submitted to service without trusted server context
    await expect(
      service.createPurchase(
        maliciousLegacyPayload as unknown as CreatePurchaseRequest,
        actorBuyerA
      )
    ).rejects.toThrow(/Unauthorized legacy direct provenance/);
  });

  // Scenario 6: Proposed audit event records actual authenticated actor and server timestamp
  it("Scenario 6: proposed audit event records authentic server actor and timestamp, ignoring client metadata", async () => {
    const draftHash = computeDraftHash({
      budgetCents: 205000,
      currency: "USD",
      lineItems: [{ id: "item_valid", title: "Valid Item", budgetCents: 205000 }],
    });

    const token = signQuantityConfirmation({
      actorId: actorBuyerA.userId,
      lineItemId: "item_valid",
      confirmedQuantity: 1,
      draftHash,
      confirmedAt: new Date().toISOString(),
    });

    const startTime = Date.now();
    const purchase = await service.createPurchase(
      {
        budgetCents: 205000,
        currency: "USD",
        lineItems: [
          {
            id: "item_valid",
            title: "Valid Item",
            quantity: 1,
            quantitySource: "inferred",
            quantityConfirmed: true,
            confirmationToken: token,
            budgetCents: 205000,
            currency: "USD",
            requirements: [],
          },
        ],
      },
      actorBuyerA
    );
    const endTime = Date.now();

    const auditHistory = await repo.getAuditHistory(purchase.id);
    const proposed = auditHistory.find((e) => e.type === "proposed");
    expect(proposed).toBeDefined();

    const payload = proposed!.payload as unknown as AuditPayloadProposed;
    expect(payload.lineItems![0].confirmedBy).toBe(actorBuyerA.userId);
    const recordedTime = new Date(payload.lineItems![0].confirmedAt!).getTime();
    expect(recordedTime).toBeGreaterThanOrEqual(startTime - 2000);
    expect(recordedTime).toBeLessThanOrEqual(endTime + 2000);
  });

  // Scenario 7 & 8: Quantity changed after confirmation invalidates prior confirmation and requires re-confirmation
  it("Scenario 7 & 8: quantity changed after confirmation requires a re-issued confirmation token for the new quantity", async () => {
    const draftHash = computeDraftHash({
      budgetCents: 205000,
      currency: "USD",
      lineItems: [{ id: "item_edit", title: "Laptop", budgetCents: 205000 }],
    });

    // Token confirmed for quantity 1
    const tokenQty1 = signQuantityConfirmation({
      actorId: actorBuyerA.userId,
      lineItemId: "item_edit",
      confirmedQuantity: 1,
      draftHash,
      confirmedAt: new Date().toISOString(),
    });

    // Submitting quantity 2 with token for quantity 1 must fail
    await expect(
      service.createPurchase(
        {
          budgetCents: 205000,
          currency: "USD",
          lineItems: [
            {
              id: "item_edit",
              title: "Laptop",
              quantity: 2, // Modified quantity!
              quantitySource: "inferred",
              quantityConfirmed: true,
              confirmationToken: tokenQty1, // Old token!
              budgetCents: 205000,
              currency: "USD",
              requirements: [],
            },
          ],
        },
        actorBuyerA
      )
    ).rejects.toThrow(/Invalid multi-item procurement line items/);

    // Re-issuing token for quantity 2 succeeds with updated draft hash
    const draftHashQty2 = computeDraftHash({
      budgetCents: 205000,
      currency: "USD",
      lineItems: [{ id: "item_edit", title: "Laptop", quantity: 2, budgetCents: 205000 }],
    });

    const tokenQty2 = signQuantityConfirmation({
      actorId: actorBuyerA.userId,
      lineItemId: "item_edit",
      confirmedQuantity: 2,
      draftHash: draftHashQty2,
      confirmedAt: new Date().toISOString(),
    });

    const purchase = await service.createPurchase(
      {
        budgetCents: 205000,
        currency: "USD",
        lineItems: [
          {
            id: "item_edit",
            title: "Laptop",
            quantity: 2,
            quantitySource: "inferred",
            quantityConfirmed: true,
            confirmationToken: tokenQty2,
            budgetCents: 205000,
            currency: "USD",
            requirements: [],
          },
        ],
      },
      actorBuyerA
    );
    expect(purchase.id).toBeDefined();
  });

  // Scenario 9: Cross-item replay attack (Token for Line Item A used on Line Item B)
  it("Scenario 9: token for Line Item A cannot be used on Line Item B (cross-item replay protection)", async () => {
    const draftHash = computeDraftHash({
      budgetCents: 300000,
      currency: "USD",
      lineItems: [
        { id: "line_item_A", title: "Laptop", budgetCents: 150000 },
        { id: "line_item_B", title: "Monitor", budgetCents: 150000 },
      ],
    });

    const tokenForA = signQuantityConfirmation({
      actorId: actorBuyerA.userId,
      lineItemId: "line_item_A",
      confirmedQuantity: 1,
      draftHash,
      confirmedAt: new Date().toISOString(),
    });

    // Attempting to attach tokenForA to line_item_B
    const valResult = validateProcurementLineItems(
      [
        {
          id: "line_item_B",
          title: "Monitor",
          quantity: 1,
          quantitySource: "inferred",
          confirmationToken: tokenForA,
          budgetCents: 150000,
          currency: "USD",
        },
      ],
      "USD",
      { actorId: actorBuyerA.userId, draftHash }
    );

    expect(valResult.ok).toBe(false);
    if (!valResult.ok) {
      expect(valResult.errors[0]?.code).toBe("invalid_confirmation_token");
      expect(valResult.errors[0]?.message).toContain("different line item");
    }
  });

  // Scenario 10: Token quantity tampering
  it("Scenario 10: confirmation token for Quantity X is rejected when submitting Quantity Y", async () => {
    const draftHash = computeDraftHash({
      budgetCents: 100000,
      currency: "USD",
      lineItems: [{ id: "line_qty_test", title: "Dock", budgetCents: 100000 }],
    });

    const tokenQty1 = signQuantityConfirmation({
      actorId: actorBuyerA.userId,
      lineItemId: "line_qty_test",
      confirmedQuantity: 1,
      draftHash,
      confirmedAt: new Date().toISOString(),
    });

    const valResult = validateProcurementLineItems(
      [
        {
          id: "line_qty_test",
          title: "Dock",
          quantity: 5, // Tampered count
          quantitySource: "inferred",
          confirmationToken: tokenQty1,
          budgetCents: 100000,
          currency: "USD",
        },
      ],
      "USD",
      { actorId: actorBuyerA.userId, draftHash }
    );

    expect(valResult.ok).toBe(false);
    if (!valResult.ok) {
      expect(valResult.errors[0]?.code).toBe("confirmation_quantity_mismatch");
    }
  });

  // Scenario 11: Actor mismatch / token theft attack
  it("Scenario 11: confirmation token signed for Actor A cannot be used by Actor B", async () => {
    const draftHash = computeDraftHash({
      budgetCents: 100000,
      currency: "USD",
      lineItems: [{ id: "line_actor_test", title: "Keyboard", budgetCents: 100000 }],
    });

    const tokenActorA = signQuantityConfirmation({
      actorId: actorBuyerA.userId,
      lineItemId: "line_actor_test",
      confirmedQuantity: 1,
      draftHash,
      confirmedAt: new Date().toISOString(),
    });

    // Attacker Bob tries to submit Alice's token
    await expect(
      service.createPurchase(
        {
          budgetCents: 100000,
          currency: "USD",
          lineItems: [
            {
              id: "line_actor_test",
              title: "Keyboard",
              quantity: 1,
              quantitySource: "inferred",
              quantityConfirmed: true,
              confirmationToken: tokenActorA,
              budgetCents: 100000,
              currency: "USD",
              requirements: [],
            },
          ],
        },
        actorBuyerB // Attacker Bob
      )
    ).rejects.toThrow(/Invalid multi-item procurement line items/);
  });

  // Scenario 12: Draft tampering attack (budget or requirements changed after confirmation)
  it("Scenario 12: altering purchase draft after confirmation invalidates previously issued confirmation tokens", async () => {
    // Draft 1: Budget $1,500
    const originalDraft = {
      budgetCents: 150000,
      currency: "USD",
      lineItems: [{ id: "line_draft_test", title: "Laptop", budgetCents: 150000 }],
    };
    const draftHash1 = computeDraftHash(originalDraft);

    const tokenForDraft1 = signQuantityConfirmation({
      actorId: actorBuyerA.userId,
      lineItemId: "line_draft_test",
      confirmedQuantity: 1,
      draftHash: draftHash1,
      confirmedAt: new Date().toISOString(),
    });

    // Attacker or user alters budget to $2,500
    const tamperedDraft = {
      budgetCents: 250000, // Altered!
      currency: "USD",
      lineItems: [
        {
          id: "line_draft_test",
          title: "Laptop",
          quantity: 1,
          quantitySource: "inferred" as const,
          quantityConfirmed: true,
          confirmationToken: tokenForDraft1, // Token from draft 1
          budgetCents: 250000, // Altered!
          currency: "USD" as const,
          requirements: [],
        },
      ],
    };

    await expect(
      service.createPurchase(tamperedDraft as unknown as CreatePurchaseRequest, actorBuyerA)
    ).rejects.toThrow(/Invalid multi-item procurement line items/);
  });
});
