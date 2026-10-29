import { describe, it, expect, beforeEach } from "vitest";
import {
  PurchaseWorkflowService,
  IllegalTransitionError,
  ConcurrencyConflictError,
} from "../../lib/workflow/service";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { Actor } from "../../lib/state/types";

describe("Concurrency and Idempotency Protections", () => {
  let repo: InMemoryPurchaseRepository;
  let service: PurchaseWorkflowService;
  const userActor: Actor = { kind: "user", userId: "buyer_concurrency" };

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
    service = new PurchaseWorkflowService(repo);
  });

  it("prevents duplicate approvals on an already approved purchase", async () => {
    const purchase = await service.createPurchase(
      {
        budgetCents: 10000,
        currency: "USD",
        requirements: ["spec"],
      },
      userActor
    );

    const now = new Date();
    const evalRes = await service.evaluatePurchaseCandidate(
      purchase.id,
      {
        rawCandidate: {
          externalId: "ext_item",
          title: "Widget",
          merchantName: "Shop",
          merchantUrl: "https://shop.com/w",
          unitPriceCents: 5000,
          quantity: 1,
          shippingCents: 0,
          currency: "USD",
          availability: "IN_STOCK",
        },
        rawObservations: [
          {
            requirementKey: "spec",
            value: "ok",
            status: "supports",
            sourceUrl: "https://shop.com/w",
            sourceType: "feed",
            capturedAt: now.toISOString(),
          },
        ],
        requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
      },
      { kind: "system", component: "sys" },
      now
    );

    // First approval succeeds
    const approval1 = await service.approvePurchase(
      purchase.id,
      {
        expectedSnapshotHash: evalRes.snapshotHash,
      },
      userActor,
      now
    );
    expect(approval1.status).toBe("APPROVED");

    // Second approval attempt on now-APPROVED state fails (cannot approve from APPROVED)
    await expect(
      service.approvePurchase(
        purchase.id,
        {
          expectedSnapshotHash: evalRes.snapshotHash,
        },
        userActor,
        now
      )
    ).rejects.toThrow(IllegalTransitionError);
  });

  it("detects concurrent mutation conflict when state or version has advanced", async () => {
    const purchase = await service.createPurchase(
      {
        budgetCents: 10000,
        currency: "USD",
        requirements: ["spec"],
      },
      userActor
    );

    const current = await repo.getPurchaseById(purchase.id);
    expect(current?.purchase.status).toBe("REQUIREMENTS_CONFIRMED");
    expect(current?.purchase.version).toBe(1);

    // Status mismatch fails
    await expect(
      repo.recordEvaluation({
        purchaseId: purchase.id,
        expectedStatus: "DRAFT",
        expectedVersion: 1,
        nextStatus: "POLICY_PASSED",
        selectedCandidateId: "cand_1",
        policyVersion: "1.0.0",
        policyEvidenceFingerprint: "fp",
        policyResults: [],
        auditEvents: [],
      })
    ).rejects.toThrow("Concurrency conflict");

    // Version mismatch fails
    await expect(
      repo.recordEvaluation({
        purchaseId: purchase.id,
        expectedStatus: "REQUIREMENTS_CONFIRMED",
        expectedVersion: 99,
        nextStatus: "POLICY_PASSED",
        selectedCandidateId: "cand_1",
        policyVersion: "1.0.0",
        policyEvidenceFingerprint: "fp",
        policyResults: [],
        auditEvents: [],
      })
    ).rejects.toThrow("Concurrency conflict");
  });

  it("prevents two concurrent operations from both succeeding with the same stale version", async () => {
    const purchase = await service.createPurchase(
      {
        budgetCents: 10000,
        currency: "USD",
        requirements: ["spec"],
      },
      userActor
    );

    const initial = await service.getPurchase(purchase.id, userActor);
    const staleVersion = initial.version;

    const candidatePayload = {
      rawCandidate: {
        externalId: "ext_concurrent",
        title: "Widget",
        merchantName: "Shop",
        merchantUrl: "https://shop.com/w",
        unitPriceCents: 5000,
        quantity: 1,
        shippingCents: 0,
        currency: "USD",
        availability: "IN_STOCK",
      },
      rawObservations: [
        {
          requirementKey: "spec",
          value: "verified",
          status: "supports",
          sourceUrl: "https://shop.com/w",
          sourceType: "merchant_spec",
          capturedAt: new Date().toISOString(),
        },
      ],
      requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
    };

    // First evaluation succeeds with staleVersion (1) and increments version to 2
    const firstEval = await service.evaluatePurchaseCandidate(
      purchase.id,
      { ...candidatePayload, expectedVersion: staleVersion },
      { kind: "system", component: "eval_worker_1" }
    );
    expect(firstEval.version).toBe(staleVersion + 1);

    // Second concurrent evaluation using staleVersion (1) fails with ConcurrencyConflictError
    await expect(
      service.evaluatePurchaseCandidate(
        purchase.id,
        { ...candidatePayload, expectedVersion: staleVersion },
        { kind: "system", component: "eval_worker_2" }
      )
    ).rejects.toThrow(ConcurrencyConflictError);
  });
});
