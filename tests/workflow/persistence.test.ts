import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { PurchaseWorkflowService } from "../../lib/workflow/service";
import { Actor } from "../../lib/state/types";

describe("Phase 4.1 Persistence Lifecycle and Aggregate Integrity", () => {
  let repo: InMemoryPurchaseRepository;
  let service: PurchaseWorkflowService;
  const userActor: Actor = { kind: "user", userId: "persist_user_1" };

  beforeEach(() => {
    repo = new InMemoryPurchaseRepository();
    service = new PurchaseWorkflowService(repo);
  });

  it("persists purchase lifecycle across operations, preserving version, owner, and audit history", async () => {
    // 1. Create purchase
    const created = await service.createPurchase(
      {
        budgetCents: 15000,
        currency: "USD",
        requirements: ["battery_life", { key: "weight", expectedValue: "500g" }],
      },
      userActor
    );

    expect(created.status).toBe("REQUIREMENTS_CONFIRMED");
    expect(created.version).toBe(1);
    expect(created.ownerUserId).toBe("persist_user_1");

    // 2. Evaluate candidate -> advances version to 2
    const now = new Date();
    const evalRes = await service.evaluatePurchaseCandidate(
      created.id,
      {
        rawCandidate: {
          externalId: "ext_drone_1",
          title: "Lightweight Drone",
          merchantName: "AeroTech",
          merchantUrl: "https://aerotech.com/drone",
          unitPriceCents: 12000,
          quantity: 1,
          shippingCents: 0,
          currency: "USD",
          availability: "IN_STOCK",
        },
        rawObservations: [
          {
            requirementKey: "battery_life",
            value: "30min",
            status: "supports",
            sourceUrl: "https://aerotech.com/drone",
            sourceType: "spec_sheet",
            capturedAt: now.toISOString(),
          },
          {
            requirementKey: "weight",
            value: "500g",
            status: "supports",
            sourceUrl: "https://aerotech.com/drone",
            sourceType: "spec_sheet",
            capturedAt: now.toISOString(),
          },
        ],
        requiredRuleKeys: ["P-BUDGET", "P-CURRENCY", "P-EVIDENCE"],
      },
      userActor,
      now
    );

    expect(evalRes.status).toBe("POLICY_PASSED");
    expect(evalRes.version).toBe(2);

    // 3. Verify retrieved aggregate before approval
    const midPurchase = await service.getPurchase(created.id, userActor);
    expect(midPurchase.status).toBe("POLICY_PASSED");
    expect(midPurchase.version).toBe(2);
    expect(midPurchase.selectedCandidateId).toBe(evalRes.candidateId);
    expect(midPurchase.policyEvidenceFingerprint).toBe(evalRes.evidenceFingerprint);

    // 4. Approve purchase -> advances version to 3
    const approval = await service.approvePurchase(
      created.id,
      {
        expectedSnapshotHash: evalRes.snapshotHash,
        expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
        expectedTotalCents: 12000,
        expectedCurrency: "USD",
        policyVersion: "1.0.0",
        expectedVersion: 2,
      },
      userActor,
      now
    );

    expect(approval.status).toBe("APPROVED");
    expect(approval.version).toBe(3);

    // 5. Simulate reading from a new service instance sharing the same repository
    const rehydratedService = new PurchaseWorkflowService(repo);
    const finalPurchase = await rehydratedService.getPurchase(created.id, userActor);

    expect(finalPurchase.status).toBe("APPROVED");
    expect(finalPurchase.version).toBe(3);
    expect(finalPurchase.ownerUserId).toBe("persist_user_1");
    expect(finalPurchase.activeApproval?.id).toBe(approval.approvalId);
    expect(finalPurchase.activeApproval?.snapshotHash).toBe(evalRes.snapshotHash);

    // 6. Verify audit history integrity across all lifecycle phases
    const auditHistory = await rehydratedService.getAuditHistory(created.id, userActor);
    expect(auditHistory.events.length).toBeGreaterThanOrEqual(4);

    const eventTypes = auditHistory.events.map((e) => e.type);
    expect(eventTypes).toContain("proposed");
    expect(eventTypes).toContain("requirements_confirmed");
    expect(eventTypes).toContain("policy_passed");
    expect(eventTypes).toContain("approved");

    // Proves audit events are chronologically ordered
    for (let i = 1; i < auditHistory.events.length; i++) {
      const prev = new Date(auditHistory.events[i - 1].occurredAt).getTime();
      const curr = new Date(auditHistory.events[i].occurredAt).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });
});
