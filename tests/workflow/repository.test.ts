import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryPurchaseRepository,
  PurchaseRecord,
  CandidateRecord,
} from "../../lib/workflow/repository";
import { AuditEventDraft, AuditPayloadMap } from "../../lib/state/types";

describe("InMemoryPurchaseRepository", () => {
  let repo: InMemoryPurchaseRepository;

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
  });

  it("creates and retrieves a purchase aggregate", async () => {
    const now = new Date();
    const purchase: PurchaseRecord = {
      id: "pur_test_1",
      status: "REQUIREMENTS_CONFIRMED",
      requirements: ["spec1"],
      budgetCents: 5000,
      currency: "USD",
      policyVersion: null,
      policyEvidenceFingerprint: null,
      selectedCandidateId: null,
      ownerUserId: "buyer_1",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    const auditDrafts: AuditEventDraft[] = [
      {
        type: "proposed",
        purchaseId: "pur_test_1",
        actor: { kind: "user", userId: "buyer_1" },
        occurredAt: now,
        payload: { budgetCents: 5000, currency: "USD" },
      },
    ];

    await repo.createPurchase(purchase, auditDrafts);

    const agg = await repo.getPurchaseById("pur_test_1");
    expect(agg).not.toBeNull();
    expect(agg?.purchase.id).toBe("pur_test_1");
    expect(agg?.purchase.budgetCents).toBe(5000);
    expect(agg?.purchase.version).toBe(1);
    expect(agg?.purchase.ownerUserId).toBe("buyer_1");
    expect(agg?.candidates).toHaveLength(0);
    expect(agg?.approvals).toHaveLength(0);

    const history = await repo.getAuditHistory("pur_test_1");
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("proposed");
  });

  it("rejects duplicate purchase creation", async () => {
    const now = new Date();
    const purchase: PurchaseRecord = {
      id: "pur_dup_1",
      status: "DRAFT",
      requirements: [],
      budgetCents: 1000,
      currency: "USD",
      policyVersion: null,
      policyEvidenceFingerprint: null,
      selectedCandidateId: null,
      ownerUserId: "buyer_1",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await repo.createPurchase(purchase, []);
    await expect(repo.createPurchase(purchase, [])).rejects.toThrow("already exists");
  });

  it("rolls back and does not save purchase if audit validation fails (forbidden keys)", async () => {
    const now = new Date();
    const purchase: PurchaseRecord = {
      id: "pur_fail_audit",
      status: "DRAFT",
      requirements: [],
      budgetCents: 1000,
      currency: "USD",
      policyVersion: null,
      policyEvidenceFingerprint: null,
      selectedCandidateId: null,
      ownerUserId: "buyer_1",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    const poisonedAudit: AuditEventDraft<"proposed"> = {
      type: "proposed",
      purchaseId: "pur_fail_audit",
      actor: { kind: "user", userId: "buyer_1" },
      occurredAt: now,
      payload: {
        budgetCents: 1000,
        currency: "USD",
        ...({ secret_token: "leaked_secret_here" } as Record<string, unknown>),
      } as unknown as AuditPayloadMap["proposed"],
    };

    await expect(repo.createPurchase(purchase, [poisonedAudit])).rejects.toThrow();

    const retrieved = await repo.getPurchaseById("pur_fail_audit");
    expect(retrieved).toBeNull();
  });

  it("records evaluation with optimistic concurrency check", async () => {
    const now = new Date();
    const purchase: PurchaseRecord = {
      id: "pur_eval_test",
      status: "REQUIREMENTS_CONFIRMED",
      requirements: ["spec1"],
      budgetCents: 5000,
      currency: "USD",
      policyVersion: null,
      policyEvidenceFingerprint: null,
      selectedCandidateId: null,
      ownerUserId: "buyer_1",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await repo.createPurchase(purchase, []);

    // Concurrency conflict: wrong expected status
    await expect(
      repo.recordEvaluation({
        purchaseId: "pur_eval_test",
        expectedStatus: "DRAFT",
        expectedVersion: 1,
        nextStatus: "POLICY_PASSED",
        selectedCandidateId: "cand_1",
        policyVersion: "1.0.0",
        policyEvidenceFingerprint: "fp123",
        policyResults: [],
        auditEvents: [],
      })
    ).rejects.toThrow("Concurrency conflict");

    // Concurrency conflict: wrong expected version
    await expect(
      repo.recordEvaluation({
        purchaseId: "pur_eval_test",
        expectedStatus: "REQUIREMENTS_CONFIRMED",
        expectedVersion: 99,
        nextStatus: "POLICY_PASSED",
        selectedCandidateId: "cand_1",
        policyVersion: "1.0.0",
        policyEvidenceFingerprint: "fp123",
        policyResults: [],
        auditEvents: [],
      })
    ).rejects.toThrow("Concurrency conflict");

    // Correct expected status and version succeeds
    const updated = await repo.recordEvaluation({
      purchaseId: "pur_eval_test",
      expectedStatus: "REQUIREMENTS_CONFIRMED",
      expectedVersion: 1,
      nextStatus: "POLICY_PASSED",
      selectedCandidateId: "cand_1",
      policyVersion: "1.0.0",
      policyEvidenceFingerprint: "fp123",
      policyResults: [],
      auditEvents: [],
    });

    expect(updated.purchase.status).toBe("POLICY_PASSED");
    expect(updated.purchase.version).toBe(2);
    expect(updated.purchase.selectedCandidateId).toBe("cand_1");
  });

  it("saves candidates with associated evidence", async () => {
    const now = new Date();
    const cand: CandidateRecord = {
      id: "cand_save_1",
      purchaseId: "pur_cand_test",
      source: "channel3",
      externalId: "ext_1",
      title: "Widget",
      merchantName: "Shop",
      merchantUrl: "https://shop.com/1",
      unitPriceCents: 100,
      quantity: 1,
      shippingCents: 0,
      totalCents: 100,
      currency: "USD",
      availability: "IN_STOCK",
      capturedAt: now,
      snapshotHash: "hash123",
    };

    await repo.saveCandidateWithEvidence(cand, [
      {
        id: "ev_1",
        candidateId: "cand_save_1",
        requirementKey: "voltage",
        value: "110V",
        sourceUrl: "https://shop.com/1",
        sourceType: "merchant_feed",
        capturedAt: now,
        status: "supports",
      },
    ]);

    const purchase: PurchaseRecord = {
      id: "pur_cand_test",
      status: "EVALUATED",
      requirements: [],
      budgetCents: 1000,
      currency: "USD",
      policyVersion: null,
      policyEvidenceFingerprint: null,
      selectedCandidateId: "cand_save_1",
      ownerUserId: "buyer_1",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await repo.createPurchase(purchase, []);

    const agg = await repo.getPurchaseById("pur_cand_test");
    expect(agg?.selectedCandidate?.id).toBe("cand_save_1");
    expect(agg?.evidence).toHaveLength(1);
    expect(agg?.evidence[0].requirementKey).toBe("voltage");
  });
});
