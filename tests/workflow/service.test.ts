import { describe, it, expect, beforeEach } from "vitest";
import {
  PurchaseWorkflowService,
  NotFoundError,
  ValidationError,
  IllegalTransitionError,
  ApprovalIntegrityError,
} from "../../lib/workflow/service";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { Actor } from "../../lib/state/types";

describe("PurchaseWorkflowService", () => {
  let repo: InMemoryPurchaseRepository;
  let service: PurchaseWorkflowService;
  const userActor: Actor = { kind: "user", userId: "buyer_123" };
  const systemActor: Actor = { kind: "system", component: "auto_evaluator" };

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
    service = new PurchaseWorkflowService(repo);
  });

  describe("createPurchase", () => {
    it("creates a purchase and confirms requirements immediately by default", async () => {
      const res = await service.createPurchase(
        {
          budgetCents: 15000,
          currency: "USD",
          requirements: ["organic", { key: "voltage", expectedValue: "110V" }],
        },
        userActor
      );

      expect(res.id).toMatch(/^pur_/);
      expect(res.status).toBe("REQUIREMENTS_CONFIRMED");
      expect(res.budgetCents).toBe(15000);
      expect(res.currency).toBe("USD");
      expect(res.requirements).toHaveLength(2);

      const history = await service.getAuditHistory(res.id);
      expect(history.events).toHaveLength(2);
      expect(history.events[0].type).toBe("proposed");
      expect(history.events[1].type).toBe("requirements_confirmed");
    });

    it("creates a purchase in DRAFT when confirmImmediately is false", async () => {
      const res = await service.createPurchase(
        {
          budgetCents: 20000,
          currency: "USD",
          requirements: ["spec1"],
          confirmImmediately: false,
        },
        userActor
      );

      expect(res.status).toBe("DRAFT");
      const history = await service.getAuditHistory(res.id);
      expect(history.events).toHaveLength(1);
      expect(history.events[0].type).toBe("proposed");
    });
  });

  describe("getPurchase", () => {
    it("retrieves an existing purchase", async () => {
      const created = await service.createPurchase(
        {
          budgetCents: 5000,
          currency: "USD",
          requirements: ["spec1"],
        },
        userActor
      );

      const retrieved = await service.getPurchase(created.id);
      expect(retrieved.id).toBe(created.id);
      expect(retrieved.budgetCents).toBe(5000);
    });

    it("throws NotFoundError for nonexistent purchase", async () => {
      await expect(service.getPurchase("pur_nonexistent")).rejects.toThrow(NotFoundError);
    });
  });

  describe("evaluatePurchaseCandidate", () => {
    it("evaluates a compliant candidate and transitions to POLICY_PASSED", async () => {
      const purchase = await service.createPurchase(
        {
          budgetCents: 5000,
          currency: "USD",
          requirements: ["voltage"],
        },
        userActor
      );

      const now = new Date();
      const evalRes = await service.evaluatePurchaseCandidate(
        purchase.id,
        {
          rawCandidate: {
            externalId: "ext_item_1",
            title: "110V Adapter",
            merchantName: "Acme Power",
            merchantUrl: "https://acme.com/item1",
            unitPriceCents: 4500,
            quantity: 1,
            shippingCents: 0,
            currency: "USD",
            availability: "IN_STOCK",
          },
          rawObservations: [
            {
              requirementKey: "voltage",
              value: "110V",
              status: "supports",
              sourceUrl: "https://acme.com/item1",
              sourceType: "merchant_spec",
              capturedAt: now.toISOString(),
            },
          ],
          requiredRuleKeys: ["P-BUDGET", "P-CURRENCY", "P-EVIDENCE", "P-AVAILABILITY"],
        },
        systemActor,
        now
      );

      expect(evalRes.status).toBe("POLICY_PASSED");
      expect(evalRes.summary.allRequiredPassed).toBe(true);
      expect(evalRes.snapshotHash).toHaveLength(64);
      expect(evalRes.evidenceFingerprint).toHaveLength(64);

      // Verify updated purchase status
      const updated = await service.getPurchase(purchase.id);
      expect(updated.status).toBe("POLICY_PASSED");
      expect(updated.selectedCandidateId).toBe(evalRes.candidateId);
      expect(updated.policyEvidenceFingerprint).toBe(evalRes.evidenceFingerprint);
    });

    it("evaluates an over-budget candidate and transitions to POLICY_BLOCKED", async () => {
      const purchase = await service.createPurchase(
        {
          budgetCents: 5000,
          currency: "USD",
          requirements: ["spec1"],
        },
        userActor
      );

      const now = new Date();
      const evalRes = await service.evaluatePurchaseCandidate(
        purchase.id,
        {
          rawCandidate: {
            externalId: "ext_expensive",
            title: "Luxury Item",
            merchantName: "Acme",
            merchantUrl: "https://acme.com/item2",
            unitPriceCents: 10000, // Budget is 5000!
            quantity: 1,
            shippingCents: 0,
            currency: "USD",
            availability: "IN_STOCK",
          },
          rawObservations: [
            {
              requirementKey: "spec1",
              value: "val",
              status: "supports",
              sourceUrl: "https://acme.com/item2",
              sourceType: "merchant_spec",
              capturedAt: now.toISOString(),
            },
          ],
          requiredRuleKeys: ["P-BUDGET"],
        },
        systemActor,
        now
      );

      expect(evalRes.status).toBe("POLICY_BLOCKED");
      expect(evalRes.summary.allRequiredPassed).toBe(false);
      expect(evalRes.summary.blockingRuleKeys).toContain("P-BUDGET");

      const updated = await service.getPurchase(purchase.id);
      expect(updated.status).toBe("POLICY_BLOCKED");
    });

    it("rejects evaluation when rawCandidate fails normalization", async () => {
      const purchase = await service.createPurchase(
        {
          budgetCents: 5000,
          currency: "USD",
          requirements: ["spec1"],
        },
        userActor
      );

      await expect(
        service.evaluatePurchaseCandidate(
          purchase.id,
          {
            rawCandidate: {
              title: "", // Missing externalId, merchantName, etc.
            },
          },
          systemActor
        )
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("approvePurchase & Approval Integrity", () => {
    async function setupPassedPurchase() {
      const purchase = await service.createPurchase(
        {
          budgetCents: 10000,
          currency: "USD",
          requirements: ["color"],
        },
        userActor
      );

      const now = new Date();
      const evalRes = await service.evaluatePurchaseCandidate(
        purchase.id,
        {
          rawCandidate: {
            externalId: "ext_blue_shirt",
            title: "Blue Shirt",
            merchantName: "Clothing Co",
            merchantUrl: "https://cloth.com/shirt",
            unitPriceCents: 8000,
            quantity: 1,
            shippingCents: 500,
            currency: "USD",
            availability: "IN_STOCK",
          },
          rawObservations: [
            {
              requirementKey: "color",
              value: "blue",
              status: "supports",
              sourceUrl: "https://cloth.com/shirt",
              sourceType: "merchant_feed",
              capturedAt: now.toISOString(),
            },
          ],
          requiredRuleKeys: ["P-BUDGET", "P-CURRENCY", "P-AVAILABILITY"],
        },
        systemActor,
        now
      );

      return { purchase, evalRes, now };
    }

    it("successfully records buyer approval when integrity matches", async () => {
      const { purchase, evalRes, now } = await setupPassedPurchase();

      const approval = await service.approvePurchase(
        purchase.id,
        {
          expectedSnapshotHash: evalRes.snapshotHash,
          expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
          expectedTotalCents: 8500, // 8000 + 500 shipping
          expectedCurrency: "USD",
          policyVersion: "1.0.0",
        },
        userActor,
        now
      );

      expect(approval.status).toBe("APPROVED");
      expect(approval.approvalId).toMatch(/^appr_/);
      expect(approval.approverUserId).toBe("buyer_123");
      expect(approval.snapshotHash).toBe(evalRes.snapshotHash);

      const updated = await service.getPurchase(purchase.id);
      expect(updated.status).toBe("APPROVED");
      expect(updated.activeApproval?.id).toBe(approval.approvalId);
    });

    it("rejects approval by a system actor", async () => {
      const { purchase, evalRes } = await setupPassedPurchase();

      await expect(
        service.approvePurchase(
          purchase.id,
          {
            expectedSnapshotHash: evalRes.snapshotHash,
          },
          systemActor
        )
      ).rejects.toThrow(ValidationError);
    });

    it("rejects approval on a purchase that is not in POLICY_PASSED status", async () => {
      const draftPurchase = await service.createPurchase(
        {
          budgetCents: 5000,
          currency: "USD",
          requirements: ["spec"],
          confirmImmediately: false,
        },
        userActor
      );

      await expect(service.approvePurchase(draftPurchase.id, {}, userActor)).rejects.toThrow(
        IllegalTransitionError
      );
    });

    it("rejects approval when snapshot hash does not match (stale approval)", async () => {
      const { purchase } = await setupPassedPurchase();
      const fakeHash = "0".repeat(64);

      await expect(
        service.approvePurchase(
          purchase.id,
          {
            expectedSnapshotHash: fakeHash,
          },
          userActor
        )
      ).rejects.toThrow(ApprovalIntegrityError);
    });

    it("rejects approval when evidence fingerprint does not match", async () => {
      const { purchase, evalRes } = await setupPassedPurchase();
      const fakeFingerprint = "1".repeat(64);

      await expect(
        service.approvePurchase(
          purchase.id,
          {
            expectedSnapshotHash: evalRes.snapshotHash,
            expectedEvidenceFingerprint: fakeFingerprint,
          },
          userActor
        )
      ).rejects.toThrow(ApprovalIntegrityError);
    });

    it("rejects approval when total cents does not match", async () => {
      const { purchase, evalRes } = await setupPassedPurchase();

      await expect(
        service.approvePurchase(
          purchase.id,
          {
            expectedSnapshotHash: evalRes.snapshotHash,
            expectedTotalCents: 9999, // Actual is 8500
          },
          userActor
        )
      ).rejects.toThrow(ApprovalIntegrityError);
    });

    it("rejects approval when policy version does not match", async () => {
      const { purchase, evalRes } = await setupPassedPurchase();

      await expect(
        service.approvePurchase(
          purchase.id,
          {
            expectedSnapshotHash: evalRes.snapshotHash,
            policyVersion: "9.9.9",
          },
          userActor
        )
      ).rejects.toThrow(ApprovalIntegrityError);
    });
  });

  describe("getAuditHistory", () => {
    it("returns complete, chronological audit history", async () => {
      const purchase = await service.createPurchase(
        {
          budgetCents: 10000,
          currency: "USD",
          requirements: ["spec1"],
        },
        userActor
      );

      const history = await service.getAuditHistory(purchase.id);
      expect(history.purchaseId).toBe(purchase.id);
      expect(history.events.length).toBeGreaterThanOrEqual(2);
      expect(history.events[0].type).toBe("proposed");
      expect(history.events[1].type).toBe("requirements_confirmed");
    });
  });
});
