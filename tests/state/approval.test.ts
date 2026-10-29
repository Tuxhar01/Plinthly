import { describe, expect, expectTypeOf, it } from "vitest";
import {
  deriveInvalidationReasons,
  isCandidateUnchanged,
  proposedState,
} from "../../lib/state/approval";
import { transition } from "../../lib/state/transitions";
import {
  ApprovalFacts,
  CandidateFacts,
  Command,
  Context,
  PurchaseState,
} from "../../lib/state/types";

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

const mockNow = new Date("2026-10-20T12:00:00Z");

const baseCandidate: CandidateFacts = {
  id: "cand-1",
  purchaseId: "pur-1",
  source: "seeded",
  unitPriceCents: 1000,
  quantity: 2,
  shippingCents: 200,
  totalCents: 2200,
  currency: "USD",
  snapshotHash: "a".repeat(64),
};

const baseApproval: ApprovalFacts = {
  id: "app-1",
  purchaseId: "pur-1",
  candidateId: "cand-1",
  snapshotHash: "a".repeat(64),
  totalCents: 2200,
  currency: "USD",
  policyVersion: "v1.0",
  evidenceFingerprint: "e".repeat(64),
  approverUserId: "user-1",
  approvedAt: mockNow,
  invalidatedAt: null,
  invalidationReason: null,
};

const basePolicyPassedState: PurchaseState = {
  purchaseId: "pur-1",
  status: "POLICY_PASSED",
  budgetCents: 5000,
  currency: "USD",
  policyVersion: "v1.0",
  requiredRuleKeys: ["rule-1"],
  selectedCandidate: baseCandidate,
  currentEvidenceFingerprint: "e".repeat(64),
  policyEvidenceFingerprint: "e".repeat(64),
  approvals: [],
  paymentAttempts: [],
};

const baseApprovedState: PurchaseState = {
  ...basePolicyPassedState,
  status: "APPROVED",
  approvals: [baseApproval],
};

describe("Approval and invalidation logic", () => {
  it("confirms commands carry no reasons fields (expectTypeOf)", () => {
    type ReevaluateCmd = Extract<Command, { kind: "reevaluate" }>;
    type SelectCandidateCmd = Extract<Command, { kind: "select_candidate" }>;
    type CreateOrderCmd = Extract<Command, { kind: "create_order" }>;
    type ApproveCmd = Extract<Command, { kind: "approve" }>;

    expectTypeOf<ReevaluateCmd>().not.toHaveProperty("reasons");
    expectTypeOf<SelectCandidateCmd>().not.toHaveProperty("reasons");
    expectTypeOf<CreateOrderCmd>().not.toHaveProperty("reasons");
    expectTypeOf<ApproveCmd>().not.toHaveProperty("reasons");
  });

  describe("T8 approve command", () => {
    it("approve by user actor succeeds and binds all required fields", () => {
      const context: Context = {
        actor: { kind: "user", userId: "user-123" },
        now: mockNow,
        newApprovalId: "new-app-1",
      };

      const res = transition(deepFreeze(basePolicyPassedState), { kind: "approve" }, context);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.next.status).toBe("APPROVED");
        expect(res.next.approvals).toHaveLength(1);
        const app = res.next.approvals[0];
        expect(app.id).toBe("new-app-1");
        expect(app.candidateId).toBe(baseCandidate.id);
        expect(app.snapshotHash).toBe(baseCandidate.snapshotHash);
        expect(app.totalCents).toBe(baseCandidate.totalCents);
        expect(app.currency).toBe(baseCandidate.currency);
        expect(app.policyVersion).toBe(basePolicyPassedState.policyVersion);
        expect(app.evidenceFingerprint).toBe(basePolicyPassedState.currentEvidenceFingerprint);
        expect(app.approverUserId).toBe("user-123");
        expect(app.invalidatedAt).toBeNull();
      }
    });

    it("approve by system actor returns invalid_actor", () => {
      const context: Context = {
        actor: { kind: "system", component: "auto-approver" },
        now: mockNow,
        newApprovalId: "new-app-1",
      };

      const res = transition(deepFreeze(basePolicyPassedState), { kind: "approve" }, context);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("invalid_actor");
      }
    });

    it("approve with currentEvidenceFingerprint null returns guard_failed", () => {
      const stateWithoutFp: PurchaseState = deepFreeze({
        ...basePolicyPassedState,
        currentEvidenceFingerprint: null,
      });
      const context: Context = {
        actor: { kind: "user", userId: "user-123" },
        now: mockNow,
        newApprovalId: "new-app-1",
      };

      const res = transition(stateWithoutFp, { kind: "approve" }, context);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toContain("evidence_fingerprint_missing");
      }
    });
  });

  describe("deriveInvalidationReasons (current facts)", () => {
    it("returns [] when nothing changed", () => {
      const reasons = deriveInvalidationReasons(baseApproval, baseApprovedState);
      expect(reasons).toEqual([]);
    });

    it("detects candidate_changed when selectedCandidate id differs", () => {
      const state: PurchaseState = {
        ...baseApprovedState,
        selectedCandidate: { ...baseCandidate, id: "cand-2" },
      };
      const reasons = deriveInvalidationReasons(baseApproval, state);
      expect(reasons).toEqual(["candidate_changed"]);
    });

    it("candidate_changed suppresses snapshot, total, and currency comparisons", () => {
      const state: PurchaseState = {
        ...baseApprovedState,
        selectedCandidate: {
          ...baseCandidate,
          id: "cand-2",
          snapshotHash: "b".repeat(64),
          totalCents: 9999,
          currency: "USD",
        },
      };
      const reasons = deriveInvalidationReasons(baseApproval, state);
      expect(reasons).toEqual(["candidate_changed"]);
    });

    it("detects snapshot_hash_changed", () => {
      const state: PurchaseState = {
        ...baseApprovedState,
        selectedCandidate: { ...baseCandidate, snapshotHash: "b".repeat(64) },
      };
      const reasons = deriveInvalidationReasons(baseApproval, state);
      expect(reasons).toEqual(["snapshot_hash_changed"]);
    });

    it("detects total_changed", () => {
      const state: PurchaseState = {
        ...baseApprovedState,
        selectedCandidate: { ...baseCandidate, totalCents: 3300 },
      };
      const reasons = deriveInvalidationReasons(baseApproval, state);
      expect(reasons).toEqual(["total_changed"]);
    });

    it("detects currency_changed", () => {
      const state: PurchaseState = {
        ...baseApprovedState,
        selectedCandidate: { ...baseCandidate, currency: "USD" }, // test with approval differing
      };
      const approvalOtherCurrency: ApprovalFacts = {
        ...baseApproval,
        currency: "EUR" as unknown as "USD",
      };
      const reasons = deriveInvalidationReasons(approvalOtherCurrency, state);
      expect(reasons).toEqual(["currency_changed"]);
    });

    it("detects policy_version_changed", () => {
      const state: PurchaseState = {
        ...baseApprovedState,
        policyVersion: "v2.0",
      };
      const reasons = deriveInvalidationReasons(baseApproval, state);
      expect(reasons).toEqual(["policy_version_changed"]);
    });

    it("detects evidence_fingerprint_changed", () => {
      const state: PurchaseState = {
        ...baseApprovedState,
        currentEvidenceFingerprint: "f".repeat(64),
      };
      const reasons = deriveInvalidationReasons(baseApproval, state);
      expect(reasons).toEqual(["evidence_fingerprint_changed"]);
    });

    it("detects evidence_fingerprint_changed when currentEvidenceFingerprint is null and approval has value", () => {
      const state: PurchaseState = {
        ...baseApprovedState,
        currentEvidenceFingerprint: null,
      };
      const reasons = deriveInvalidationReasons(baseApproval, state);
      expect(reasons).toEqual(["evidence_fingerprint_changed"]);
    });

    it("returns multiple reasons in fixed order when multiple fields change", () => {
      const state: PurchaseState = {
        ...baseApprovedState,
        selectedCandidate: {
          ...baseCandidate,
          snapshotHash: "b".repeat(64),
          totalCents: 9999,
        },
        policyVersion: "v2.0",
        currentEvidenceFingerprint: "f".repeat(64),
      };
      const reasons = deriveInvalidationReasons(baseApproval, state);
      expect(reasons).toEqual([
        "snapshot_hash_changed",
        "total_changed",
        "policy_version_changed",
        "evidence_fingerprint_changed",
      ]);
    });
  });

  describe("Proposed-state derivation for T2e (Section 8.3A)", () => {
    it("preserves known fingerprint for policy-version-only change with identical candidate id and snapshotHash", () => {
      const command = {
        candidate: { ...baseCandidate },
        policyVersion: "v2.0",
      };
      const prop = proposedState(baseApprovedState, command);
      expect(prop.currentEvidenceFingerprint).toBe(baseApprovedState.currentEvidenceFingerprint);

      const reasons = deriveInvalidationReasons(baseApproval, prop);
      expect(reasons).toEqual(["policy_version_changed"]);
    });

    it("sets proposed fingerprint to null when candidate id changes", () => {
      const command = {
        candidate: { ...baseCandidate, id: "cand-new" },
        policyVersion: "v1.0",
      };
      const prop = proposedState(baseApprovedState, command);
      expect(prop.currentEvidenceFingerprint).toBeNull();

      const reasons = deriveInvalidationReasons(baseApproval, prop);
      expect(reasons).toEqual(["candidate_changed", "evidence_fingerprint_changed"]);
    });

    it("sets proposed fingerprint to null when snapshotHash changes", () => {
      const command = {
        candidate: { ...baseCandidate, snapshotHash: "b".repeat(64) },
        policyVersion: "v1.0",
      };
      const prop = proposedState(baseApprovedState, command);
      expect(prop.currentEvidenceFingerprint).toBeNull();

      const reasons = deriveInvalidationReasons(baseApproval, prop);
      expect(reasons).toEqual(["snapshot_hash_changed", "evidence_fingerprint_changed"]);
    });

    it("detects candidate_unchanged when all fields match EFF", () => {
      const command = {
        candidate: { ...baseCandidate },
        policyVersion: "v1.0",
      };
      expect(isCandidateUnchanged(baseApproval, command)).toBe(true);
    });
  });

  describe("Re-approval and invalidation lifecycle", () => {
    it("an approval with invalidatedAt non-null is not effective: create_order sees no effective approval", () => {
      const invalidatedApproval: ApprovalFacts = {
        ...baseApproval,
        invalidatedAt: mockNow,
        invalidationReason: "policy_version_changed",
      };
      const state: PurchaseState = deepFreeze({
        ...baseApprovedState,
        approvals: [invalidatedApproval],
      });
      const context: Context = {
        actor: { kind: "user", userId: "user-1" },
        now: mockNow,
        newPaymentAttemptId: "pay-1",
      };

      const res = transition(
        state,
        { kind: "create_order", idempotencyKey: "idem-1", paypalOrderId: "order-1" },
        context
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toContain("no_effective_approval");
      }
    });
  });
});
