import { describe, expect, it } from "vitest";
import { transition } from "../../lib/state/transitions";
import {
  ApprovalFacts,
  CandidateFacts,
  Command,
  Context,
  PaymentAttemptFacts,
  PurchaseState,
  PurchaseStatus,
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
const userActor = { kind: "user" as const, userId: "user-123" };

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
  approverUserId: "user-123",
  approvedAt: mockNow,
  invalidatedAt: null,
  invalidationReason: null,
};

const baseLiveAttempt: PaymentAttemptFacts = {
  id: "pay-1",
  purchaseId: "pur-1",
  approvalId: "app-1",
  idempotencyKey: "idem-1",
  paypalOrderId: "order-1",
  status: "OPEN",
  verifiedStatus: null,
  verifiedAt: null,
  failureReason: null,
};

const baseState: PurchaseState = {
  purchaseId: "pur-1",
  status: "DRAFT",
  budgetCents: 5000,
  currency: "USD",
  policyVersion: null,
  requiredRuleKeys: ["rule-1"],
  selectedCandidate: null,
  currentEvidenceFingerprint: null,
  policyEvidenceFingerprint: null,
  approvals: [],
  paymentAttempts: [],
};

const defaultContext: Context = deepFreeze({
  actor: userActor,
  now: mockNow,
  newApprovalId: "new-app-1",
  newPaymentAttemptId: "new-pay-1",
});

describe("Transition Table Rows (T1 to T17)", () => {
  it("T1: DRAFT + confirm_requirements -> REQUIREMENTS_CONFIRMED", () => {
    const state: PurchaseState = deepFreeze({ ...baseState, status: "DRAFT" });
    const res = transition(state, { kind: "confirm_requirements" }, defaultContext);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("REQUIREMENTS_CONFIRMED");
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("requirements_confirmed");
    }
  });

  it("T2: REQUIREMENTS_CONFIRMED + select_candidate -> EVALUATED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "REQUIREMENTS_CONFIRMED",
    });
    const res = transition(
      state,
      { kind: "select_candidate", candidate: baseCandidate, policyVersion: "v1.0" },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("EVALUATED");
      expect(res.next.selectedCandidate).toEqual(baseCandidate);
      expect(res.next.policyVersion).toBe("v1.0");
      expect(res.next.currentEvidenceFingerprint).toBeNull();
      expect(res.next.policyEvidenceFingerprint).toBeNull();
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("evaluated");
      expect((res.events[0].payload as Record<string, unknown>).reason).toBe("candidate_selected");
    }
  });

  it("T2b: EVALUATED + select_candidate -> EVALUATED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "EVALUATED",
      selectedCandidate: baseCandidate,
    });
    const newCand = { ...baseCandidate, id: "cand-new" };
    const res = transition(
      state,
      { kind: "select_candidate", candidate: newCand, policyVersion: "v2.0" },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("EVALUATED");
      expect(res.next.selectedCandidate).toEqual(newCand);
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("evaluated");
    }
  });

  it("T2c: POLICY_PASSED + select_candidate -> EVALUATED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "POLICY_PASSED",
      selectedCandidate: baseCandidate,
      policyVersion: "v1.0",
      currentEvidenceFingerprint: "e".repeat(64),
      policyEvidenceFingerprint: "e".repeat(64),
    });
    const newCand = { ...baseCandidate, id: "cand-new" };
    const res = transition(
      state,
      { kind: "select_candidate", candidate: newCand, policyVersion: "v2.0" },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("EVALUATED");
      expect(res.next.selectedCandidate).toEqual(newCand);
      expect(res.next.policyEvidenceFingerprint).toBeNull();
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("evaluated");
    }
  });

  it("T2d: POLICY_BLOCKED + select_candidate -> EVALUATED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "POLICY_BLOCKED",
      selectedCandidate: baseCandidate,
      policyVersion: "v1.0",
      policyEvidenceFingerprint: "e".repeat(64),
    });
    const newCand = { ...baseCandidate, id: "cand-new" };
    const res = transition(
      state,
      { kind: "select_candidate", candidate: newCand, policyVersion: "v2.0" },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("EVALUATED");
      expect(res.next.selectedCandidate).toEqual(newCand);
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("evaluated");
    }
  });

  it("T2e: APPROVED + select_candidate -> EVALUATED with invalidation", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "APPROVED",
      selectedCandidate: baseCandidate,
      policyVersion: "v1.0",
      currentEvidenceFingerprint: "e".repeat(64),
      approvals: [baseApproval],
    });
    const newCand = { ...baseCandidate, id: "cand-new" };
    const res = transition(
      state,
      { kind: "select_candidate", candidate: newCand, policyVersion: "v1.0" },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("EVALUATED");
      expect(res.next.selectedCandidate).toEqual(newCand);
      expect(res.next.approvals[0].invalidatedAt).toEqual(mockNow);
      expect(res.next.approvals[0].invalidationReason).toContain("candidate_changed");
      expect(res.events).toHaveLength(2);
      expect(res.events[0].type).toBe("approval_invalidated");
      expect(res.events[1].type).toBe("evaluated");
      expect((res.events[1].payload as Record<string, unknown>).candidateId).toBe("cand-new");
    }
  });

  it("T2f: ORDER_CREATED, BUYER_APPROVED, CAPTURE_ATTEMPTED + select_candidate -> change_blocked_by_open_payment", () => {
    for (const st of ["ORDER_CREATED", "BUYER_APPROVED", "CAPTURE_ATTEMPTED"] as const) {
      const state: PurchaseState = deepFreeze({
        ...baseState,
        status: st,
        selectedCandidate: baseCandidate,
        approvals: [baseApproval],
        paymentAttempts: [baseLiveAttempt],
      });
      const res = transition(
        state,
        { kind: "select_candidate", candidate: baseCandidate, policyVersion: "v1.0" },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("change_blocked_by_open_payment");
      }
    }
  });

  it("T3: EVALUATED + evaluate -> EVALUATED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "EVALUATED",
      selectedCandidate: baseCandidate,
    });
    const res = transition(state, { kind: "evaluate" }, defaultContext);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("EVALUATED");
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("evaluated");
      expect((res.events[0].payload as Record<string, unknown>).reason).toBe("evaluation_recorded");
    }
  });

  it("T4: EVALUATED + apply_policy_summary (allRequiredPassed) -> POLICY_PASSED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "EVALUATED",
      selectedCandidate: baseCandidate,
      currentEvidenceFingerprint: "e".repeat(64),
    });
    const res = transition(
      state,
      {
        kind: "apply_policy_summary",
        policyVersion: "v1.0",
        summary: { allRequiredPassed: true, blockingRuleKeys: [], unknownRuleKeys: [] },
      },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("POLICY_PASSED");
      expect(res.next.policyVersion).toBe("v1.0");
      expect(res.next.policyEvidenceFingerprint).toBe("e".repeat(64));
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("policy_passed");
    }
  });

  it("T5: EVALUATED + apply_policy_summary (block) -> POLICY_BLOCKED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "EVALUATED",
      selectedCandidate: baseCandidate,
      currentEvidenceFingerprint: "e".repeat(64),
    });
    const res = transition(
      state,
      {
        kind: "apply_policy_summary",
        policyVersion: "v1.0",
        summary: { allRequiredPassed: false, blockingRuleKeys: ["rule-1"], unknownRuleKeys: [] },
      },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("POLICY_BLOCKED");
      expect(res.next.policyEvidenceFingerprint).toBe("e".repeat(64));
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("policy_blocked");
    }
  });

  it("T6: POLICY_BLOCKED + reevaluate -> EVALUATED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "POLICY_BLOCKED",
      selectedCandidate: baseCandidate,
      currentEvidenceFingerprint: "e".repeat(64),
      policyEvidenceFingerprint: "e".repeat(64),
    });
    const res = transition(state, { kind: "reevaluate" }, defaultContext);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("EVALUATED");
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("evaluated");
      expect((res.events[0].payload as Record<string, unknown>).reason).toBe("reevaluation_requested");
    }
  });

  it("T7: POLICY_PASSED + reevaluate (different fingerprint) -> EVALUATED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "POLICY_PASSED",
      selectedCandidate: baseCandidate,
      currentEvidenceFingerprint: "f".repeat(64), // changed
      policyEvidenceFingerprint: "e".repeat(64),
    });
    const res = transition(state, { kind: "reevaluate" }, defaultContext);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("EVALUATED");
      expect(res.next.policyEvidenceFingerprint).toBeNull();
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("evaluated");
      expect((res.events[0].payload as Record<string, unknown>).reason).toBe("reassessment_required");
    }
  });

  it("T8: POLICY_PASSED + approve -> APPROVED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "POLICY_PASSED",
      selectedCandidate: baseCandidate,
      policyVersion: "v1.0",
      currentEvidenceFingerprint: "e".repeat(64),
      policyEvidenceFingerprint: "e".repeat(64),
    });
    const res = transition(state, { kind: "approve" }, defaultContext);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("APPROVED");
      expect(res.next.approvals).toHaveLength(1);
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("approved");
    }
  });

  it("T9: APPROVED + reevaluate (changed policy version) -> EVALUATED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "APPROVED",
      selectedCandidate: baseCandidate,
      policyVersion: "v2.0", // changed in state
      currentEvidenceFingerprint: "e".repeat(64),
      approvals: [baseApproval],
    });
    const res = transition(state, { kind: "reevaluate" }, defaultContext);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("EVALUATED");
      expect(res.next.approvals[0].invalidatedAt).toEqual(mockNow);
      expect(res.events).toHaveLength(2);
      expect(res.events[0].type).toBe("approval_invalidated");
      expect(res.events[1].type).toBe("evaluated");
    }
  });

  it("T10: APPROVED + create_order -> ORDER_CREATED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "APPROVED",
      selectedCandidate: baseCandidate,
      policyVersion: "v1.0",
      currentEvidenceFingerprint: "e".repeat(64),
      approvals: [baseApproval],
    });
    const res = transition(
      state,
      { kind: "create_order", idempotencyKey: "idem-1", paypalOrderId: "order-1" },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("ORDER_CREATED");
      expect(res.next.paymentAttempts).toHaveLength(1);
      expect(res.next.paymentAttempts[0].status).toBe("OPEN");
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("order_created");
    }
  });

  it("T11: ORDER_CREATED + observe_paypal_order (APPROVED) -> BUYER_APPROVED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "ORDER_CREATED",
      selectedCandidate: baseCandidate,
      approvals: [baseApproval],
      paymentAttempts: [baseLiveAttempt],
    });
    const res = transition(
      state,
      {
        kind: "observe_paypal_order",
        observation: {
          orderId: "order-1",
          status: "APPROVED",
          source: "paypal_order_get",
          observedAt: mockNow,
        },
      },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("BUYER_APPROVED");
      expect(res.next.paymentAttempts[0].verifiedStatus).toBe("APPROVED");
      expect(res.next.paymentAttempts[0].status).toBe("OPEN");
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("buyer_approved");
    }
  });

  it("T12: BUYER_APPROVED + record_capture_attempt -> CAPTURE_ATTEMPTED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "BUYER_APPROVED",
      selectedCandidate: baseCandidate,
      approvals: [baseApproval],
      paymentAttempts: [{ ...baseLiveAttempt, verifiedStatus: "APPROVED", verifiedAt: mockNow }],
    });
    const res = transition(state, { kind: "record_capture_attempt" }, defaultContext);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("CAPTURE_ATTEMPTED");
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("capture_attempted");
    }
  });

  it("T13: CAPTURE_ATTEMPTED + observe_paypal_order (COMPLETED) -> COMPLETED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "CAPTURE_ATTEMPTED",
      selectedCandidate: baseCandidate,
      approvals: [baseApproval],
      paymentAttempts: [baseLiveAttempt],
    });
    const res = transition(
      state,
      {
        kind: "observe_paypal_order",
        observation: {
          orderId: "order-1",
          status: "COMPLETED",
          source: "paypal_order_get",
          observedAt: mockNow,
        },
      },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("COMPLETED");
      expect(res.next.paymentAttempts[0].status).toBe("COMPLETED");
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("completed");
    }
  });

  it("T14: CAPTURE_ATTEMPTED + observe_paypal_order (non-COMPLETED) -> FAILED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "CAPTURE_ATTEMPTED",
      selectedCandidate: baseCandidate,
      approvals: [baseApproval],
      paymentAttempts: [baseLiveAttempt],
    });
    const res = transition(
      state,
      {
        kind: "observe_paypal_order",
        observation: {
          orderId: "order-1",
          status: "VOIDED",
          source: "paypal_order_get",
          observedAt: mockNow,
        },
      },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("FAILED");
      expect(res.next.paymentAttempts[0].status).toBe("FAILED");
      expect(res.next.paymentAttempts[0].verifiedStatus).toBe("VOIDED");
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("failed");
    }
  });

  it("T15: CAPTURE_ATTEMPTED + record_capture_rejected -> FAILED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "CAPTURE_ATTEMPTED",
      selectedCandidate: baseCandidate,
      approvals: [baseApproval],
      paymentAttempts: [baseLiveAttempt],
    });
    const res = transition(
      state,
      { kind: "record_capture_rejected", reason: "Bank rejected" },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("FAILED");
      expect(res.next.paymentAttempts[0].status).toBe("FAILED");
      expect(res.next.paymentAttempts[0].failureReason).toBe("Bank rejected");
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("failed");
    }
  });

  it("T16: cancel from ORDER_CREATED with LIVE attempt -> CANCELLED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "ORDER_CREATED",
      selectedCandidate: baseCandidate,
      approvals: [baseApproval],
      paymentAttempts: [baseLiveAttempt],
    });
    const res = transition(state, { kind: "cancel", reason: "User cancelled" }, defaultContext);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("CANCELLED");
      expect(res.next.paymentAttempts[0].status).toBe("CANCELLED");
      expect(res.next.paymentAttempts[0].failureReason).toBe("User cancelled");
      expect(res.next.paymentAttempts[0].paypalOrderId).toBe("order-1");
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("cancelled");
      expect((res.events[0].payload as Record<string, unknown>).paymentAttemptId).toBe("pay-1");
    }
  });

  it("T17: cancel from DRAFT -> CANCELLED", () => {
    const state: PurchaseState = deepFreeze({ ...baseState, status: "DRAFT" });
    const res = transition(state, { kind: "cancel", reason: "User gave up" }, defaultContext);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("CANCELLED");
      expect(res.events).toHaveLength(1);
      expect(res.events[0].type).toBe("cancelled");
      expect((res.events[0].payload as Record<string, unknown>).paymentAttemptId).toBeNull();
    }
  });
});

describe("Status and Command Pair Exhaustive Enumeration (132 pairs)", () => {
  const allStatuses: PurchaseStatus[] = [
    "DRAFT",
    "REQUIREMENTS_CONFIRMED",
    "EVALUATED",
    "POLICY_BLOCKED",
    "POLICY_PASSED",
    "APPROVED",
    "ORDER_CREATED",
    "BUYER_APPROVED",
    "CAPTURE_ATTEMPTED",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ];

  const allCommands: Command[] = [
    { kind: "confirm_requirements" },
    { kind: "select_candidate", candidate: baseCandidate, policyVersion: "v1.0" },
    { kind: "evaluate" },
    {
      kind: "apply_policy_summary",
      policyVersion: "v1.0",
      summary: { allRequiredPassed: true, blockingRuleKeys: [], unknownRuleKeys: [] },
    },
    { kind: "reevaluate" },
    { kind: "approve" },
    { kind: "create_order", idempotencyKey: "idem-1", paypalOrderId: "order-1" },
    {
      kind: "observe_paypal_order",
      observation: {
        orderId: "order-1",
        status: "APPROVED",
        source: "paypal_order_get",
        observedAt: mockNow,
      },
    },
    { kind: "record_capture_attempt" },
    { kind: "record_capture_rejected", reason: "failed" },
    { kind: "cancel", reason: "user cancel" },
  ];

  const permittedPairs: Set<string> = new Set([
    "DRAFT:confirm_requirements",
    "DRAFT:cancel",
    "REQUIREMENTS_CONFIRMED:select_candidate",
    "REQUIREMENTS_CONFIRMED:cancel",
    "EVALUATED:select_candidate",
    "EVALUATED:evaluate",
    "EVALUATED:apply_policy_summary",
    "EVALUATED:cancel",
    "POLICY_BLOCKED:select_candidate",
    "POLICY_BLOCKED:reevaluate",
    "POLICY_BLOCKED:cancel",
    "POLICY_PASSED:select_candidate",
    "POLICY_PASSED:reevaluate",
    "POLICY_PASSED:approve",
    "POLICY_PASSED:cancel",
    "APPROVED:select_candidate",
    "APPROVED:reevaluate",
    "APPROVED:create_order",
    "APPROVED:cancel",
    "ORDER_CREATED:select_candidate", // T2f (error: change_blocked_by_open_payment, but permitted to be evaluated per table)
    "ORDER_CREATED:observe_paypal_order",
    "ORDER_CREATED:cancel",
    "BUYER_APPROVED:select_candidate", // T2f
    "BUYER_APPROVED:record_capture_attempt",
    "BUYER_APPROVED:cancel",
    "CAPTURE_ATTEMPTED:select_candidate", // T2f
    "CAPTURE_ATTEMPTED:observe_paypal_order",
    "CAPTURE_ATTEMPTED:record_capture_rejected",
  ]);

  it("checks all 132 pairs for illegal_transition vs permitted transition", () => {
    let permittedCount = 0;
    let illegalCount = 0;

    for (const status of allStatuses) {
      for (const cmd of allCommands) {
        const pairKey = `${status}:${cmd.kind}`;
        const isPermitted = permittedPairs.has(pairKey);

        const dummyState: PurchaseState = deepFreeze({
          ...baseState,
          status,
          selectedCandidate: status !== "DRAFT" && status !== "REQUIREMENTS_CONFIRMED" ? baseCandidate : null,
          currentEvidenceFingerprint: "e".repeat(64),
          policyEvidenceFingerprint: "e".repeat(64),
          policyVersion: "v1.0",
          approvals: status === "APPROVED" || status === "ORDER_CREATED" || status === "BUYER_APPROVED" || status === "CAPTURE_ATTEMPTED" ? [baseApproval] : [],
          paymentAttempts: status === "ORDER_CREATED" || status === "BUYER_APPROVED" || status === "CAPTURE_ATTEMPTED" ? [baseLiveAttempt] : [],
        });

        const res = transition(dummyState, cmd, defaultContext);

        if (!isPermitted) {
          expect(res.ok).toBe(false);
          if (!res.ok) {
            expect(res.error.code).toBe("illegal_transition");
          }
          illegalCount++;
        } else {
          // Permitted means it is not rejected with illegal_transition
          if (!res.ok) {
            expect(res.error.code).not.toBe("illegal_transition");
          }
          permittedCount++;
        }
      }
    }

    expect(permittedCount).toBe(28);
    expect(illegalCount).toBe(104);
    expect(permittedCount + illegalCount).toBe(132);
  });
});

describe("T4 and T5 Precedence Tests (Section 6.2 Order)", () => {
  const baseEvalState: PurchaseState = deepFreeze({
    ...baseState,
    status: "EVALUATED",
    selectedCandidate: null,
    currentEvidenceFingerprint: null,
    policyEvidenceFingerprint: null,
    paymentAttempts: [], // passes P8 (no live attempt in EVALUATED)
  });

  describe("T4 precedence sequence", () => {
    const validPassSummary = {
      allRequiredPassed: true,
      blockingRuleKeys: [],
      unknownRuleKeys: [],
    };
    const invalidSummary = {
      allRequiredPassed: false,
      blockingRuleKeys: [],
      unknownRuleKeys: [],
    };

    it("Step 1: Invalid summary -> invalid_input", () => {
      const res = transition(
        baseEvalState,
        { kind: "apply_policy_summary", policyVersion: "", summary: invalidSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("invalid_input");
    });

    it("Step 2: Empty policy version -> guard_failed 'policy_version_missing'", () => {
      const res = transition(
        baseEvalState,
        { kind: "apply_policy_summary", policyVersion: "", summary: validPassSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toBe("policy_version_missing");
      }
    });

    it("Step 3: Missing selected candidate -> guard_failed 'no_selected_candidate'", () => {
      const res = transition(
        baseEvalState,
        { kind: "apply_policy_summary", policyVersion: "v1.0", summary: validPassSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toBe("no_selected_candidate");
      }
    });

    it("Step 4: Missing evidence fingerprint -> guard_failed 'evidence_fingerprint_missing'", () => {
      const stateWithCand: PurchaseState = deepFreeze({
        ...baseEvalState,
        selectedCandidate: baseCandidate,
      });
      const res = transition(
        stateWithCand,
        { kind: "apply_policy_summary", policyVersion: "v1.0", summary: validPassSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toBe("evidence_fingerprint_missing");
      }
    });

    it("Precedence P8 over T4: An OPEN attempt in EVALUATED returns inconsistent_state before T4 guards", () => {
      const stateWithOpenAttempt: PurchaseState = deepFreeze({
        ...baseEvalState,
        selectedCandidate: baseCandidate,
        currentEvidenceFingerprint: "e".repeat(64),
        paymentAttempts: [baseLiveAttempt], // violates P8
      });
      // Even with empty policy version, P8 catches the inconsistent state first
      const res = transition(
        stateWithOpenAttempt,
        { kind: "apply_policy_summary", policyVersion: "", summary: validPassSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("inconsistent_state");
      }
    });
  });

  describe("T5 precedence sequence", () => {
    const validBlockSummary = {
      allRequiredPassed: false,
      blockingRuleKeys: ["rule-1"],
      unknownRuleKeys: [],
    };
    const invalidBlockSummary = {
      allRequiredPassed: false,
      blockingRuleKeys: [],
      unknownRuleKeys: [],
    };

    it("Step 1: Invalid summary -> invalid_input", () => {
      const res = transition(
        baseEvalState,
        { kind: "apply_policy_summary", policyVersion: "", summary: invalidBlockSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("invalid_input");
    });

    it("Step 2: Empty policy version -> guard_failed 'policy_version_missing'", () => {
      const res = transition(
        baseEvalState,
        { kind: "apply_policy_summary", policyVersion: "", summary: validBlockSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toBe("policy_version_missing");
      }
    });

    it("Step 3: Missing selected candidate -> guard_failed 'no_selected_candidate'", () => {
      const res = transition(
        baseEvalState,
        { kind: "apply_policy_summary", policyVersion: "v1.0", summary: validBlockSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toBe("no_selected_candidate");
      }
    });

    it("Step 4: Missing evidence fingerprint -> guard_failed 'evidence_fingerprint_missing'", () => {
      const stateWithCand: PurchaseState = deepFreeze({
        ...baseEvalState,
        selectedCandidate: baseCandidate,
      });
      const res = transition(
        stateWithCand,
        { kind: "apply_policy_summary", policyVersion: "v1.0", summary: validBlockSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toBe("evidence_fingerprint_missing");
      }
    });

    it("Precedence P8 over T5: An OPEN attempt in EVALUATED returns inconsistent_state before T5 guards", () => {
      const stateWithOpenAttempt: PurchaseState = deepFreeze({
        ...baseEvalState,
        selectedCandidate: baseCandidate,
        currentEvidenceFingerprint: "e".repeat(64),
        paymentAttempts: [baseLiveAttempt], // violates P8
      });
      // Even with empty policy version, P8 catches the inconsistent state first
      const res = transition(
        stateWithOpenAttempt,
        { kind: "apply_policy_summary", policyVersion: "", summary: validBlockSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("inconsistent_state");
      }
    });
  });
});

describe("T2e Scenarios from APPROVED (Section 8.3A)", () => {
  const baseApproved: PurchaseState = deepFreeze({
    ...baseState,
    status: "APPROVED",
    selectedCandidate: baseCandidate,
    policyVersion: "v1.0",
    currentEvidenceFingerprint: "e".repeat(64),
    approvals: [baseApproval],
  });

  it("identical candidate and policy version returns guard_failed 'candidate_unchanged'", () => {
    const res = transition(
      baseApproved,
      { kind: "select_candidate", candidate: baseCandidate, policyVersion: "v1.0" },
      defaultContext
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("guard_failed");
      expect(res.error.message).toBe("candidate_unchanged");
    }
  });

  it("same candidate and snapshot, different policyVersion preserves evidence fingerprint", () => {
    const res = transition(
      baseApproved,
      { kind: "select_candidate", candidate: baseCandidate, policyVersion: "v2.0" },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.status).toBe("EVALUATED");
      expect(res.next.policyVersion).toBe("v2.0");
      expect(res.next.currentEvidenceFingerprint).toBeNull(); // reset after T2e
      expect(res.events[0].type).toBe("approval_invalidated");
      expect((res.events[0].payload as Record<string, unknown>).reasons).toEqual(["policy_version_changed"]);
    }
  });

  it("different candidate id produces candidate_changed and evidence_fingerprint_changed", () => {
    const newCand = { ...baseCandidate, id: "cand-2" };
    const res = transition(
      baseApproved,
      { kind: "select_candidate", candidate: newCand, policyVersion: "v1.0" },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.events[0].payload as Record<string, unknown>).reasons).toEqual([
        "candidate_changed",
        "evidence_fingerprint_changed",
      ]);
    }
  });

  it("same candidate id, different snapshotHash produces snapshot_hash_changed and evidence_fingerprint_changed", () => {
    const newCand = { ...baseCandidate, snapshotHash: "b".repeat(64) };
    const res = transition(
      baseApproved,
      { kind: "select_candidate", candidate: newCand, policyVersion: "v1.0" },
      defaultContext
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.events[0].payload as Record<string, unknown>).reasons).toEqual([
        "snapshot_hash_changed",
        "evidence_fingerprint_changed",
      ]);
    }
  });

  it("proposed candidate with different purchaseId returns cross_purchase_reference", () => {
    const newCand = { ...baseCandidate, purchaseId: "pur-other" };
    const res = transition(
      baseApproved,
      { kind: "select_candidate", candidate: newCand, policyVersion: "v1.0" },
      defaultContext
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("cross_purchase_reference");
    }
  });

  it("proposed candidate with invalid money returns invalid_input", () => {
    const newCand = { ...baseCandidate, unitPriceCents: -50 };
    const res = transition(
      baseApproved,
      { kind: "select_candidate", candidate: newCand, policyVersion: "v1.0" },
      defaultContext
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("invalid_input");
    }
  });
});

describe("T9 and T10 Stale Approval Handling (Sections 8.8 and 6.1)", () => {
  const baseApproved: PurchaseState = deepFreeze({
    ...baseState,
    status: "APPROVED",
    selectedCandidate: baseCandidate,
    policyVersion: "v1.0",
    currentEvidenceFingerprint: "e".repeat(64),
    approvals: [baseApproval],
  });

  it("T10 on stale approval (policy version changed in state) returns approval_invalidated without state change", () => {
    const staleState: PurchaseState = deepFreeze({
      ...baseApproved,
      policyVersion: "v2.0",
    });
    const res = transition(
      staleState,
      { kind: "create_order", idempotencyKey: "idem-1", paypalOrderId: "order-1" },
      defaultContext
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("approval_invalidated");
      expect(res.error.message).toContain("policy_version_changed");
    }
  });

  it("T9 persists invalidation after stale T10 rejection", () => {
    const staleState: PurchaseState = deepFreeze({
      ...baseApproved,
      policyVersion: "v2.0",
    });
    const res9 = transition(staleState, { kind: "reevaluate" }, defaultContext);
    expect(res9.ok).toBe(true);
    if (res9.ok) {
      expect(res9.next.status).toBe("EVALUATED");
      expect(res9.next.approvals[0].invalidatedAt).toEqual(mockNow);

      // Subsequent T10 is illegal_transition because status is now EVALUATED
      const res10 = transition(
        res9.next,
        { kind: "create_order", idempotencyKey: "idem-1", paypalOrderId: "order-1" },
        defaultContext
      );
      expect(res10.ok).toBe(false);
      if (!res10.ok) {
        expect(res10.error.code).toBe("illegal_transition");
      }
    }
  });

  it("Precedence: APPROVED input whose effective approval candidateId differs is rejected by P2 before T9/T10", () => {
    const invalidP2State: PurchaseState = deepFreeze({
      ...baseApproved,
      selectedCandidate: { ...baseCandidate, id: "cand-mismatch" },
    });
    const res9 = transition(invalidP2State, { kind: "reevaluate" }, defaultContext);
    expect(res9.ok).toBe(false);
    if (!res9.ok) expect(res9.error.code).toBe("inconsistent_state");

    const res10 = transition(
      invalidP2State,
      { kind: "create_order", idempotencyKey: "idem-1", paypalOrderId: "order-1" },
      defaultContext
    );
    expect(res10.ok).toBe(false);
    if (!res10.ok) expect(res10.error.code).toBe("inconsistent_state");
  });

  it("T10 with totalCents mismatch in an inconsistent fixture where INV(EFF) is empty returns amount_mismatch", () => {
    // candidate derived total is unitPrice (1000) * qty (2) + ship (500) = 2500.
    // To make INV(EFF) empty, cand.totalCents == approval.totalCents (2200).
    // To trigger amount_mismatch, eff.totalCents must not equal deriveTotalCents!
    const candInconsistentFixture: CandidateFacts = {
      ...baseCandidate,
      shippingCents: 500,
      totalCents: 2200, // matches approval! So INV(EFF) sees totalCents match!
    };
    // derivedTotal will be 1000*2 + 500 = 2500, while eff.totalCents is 2200.
    const inconsistentState: PurchaseState = deepFreeze({
      ...baseApproved,
      selectedCandidate: candInconsistentFixture,
    });
    const res = transition(
      inconsistentState,
      { kind: "create_order", idempotencyKey: "idem-1", paypalOrderId: "order-1" },
      defaultContext
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("amount_mismatch");
    }
  });

  it("T10 with empty idempotencyKey or paypalOrderId returns invalid_input", () => {
    const resEmptyIdem = transition(
      baseApproved,
      { kind: "create_order", idempotencyKey: "", paypalOrderId: "order-1" },
      defaultContext
    );
    expect(resEmptyIdem.ok).toBe(false);
    if (!resEmptyIdem.ok) expect(resEmptyIdem.error.code).toBe("invalid_input");

    const resEmptyOrder = transition(
      baseApproved,
      { kind: "create_order", idempotencyKey: "idem-1", paypalOrderId: "" },
      defaultContext
    );
    expect(resEmptyOrder.ok).toBe(false);
    if (!resEmptyOrder.ok) expect(resEmptyOrder.error.code).toBe("invalid_input");
  });
});

describe("Other Transition and Error Cases", () => {
  it("observe_paypal_order at ORDER_CREATED returns expected errors", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "ORDER_CREATED",
      selectedCandidate: baseCandidate,
      approvals: [baseApproval],
      paymentAttempts: [baseLiveAttempt],
    });

    // CREATED -> payment_not_yet_approved
    const resCreated = transition(
      state,
      {
        kind: "observe_paypal_order",
        observation: { orderId: "order-1", status: "CREATED", source: "paypal_order_get", observedAt: mockNow },
      },
      defaultContext
    );
    expect(resCreated.ok).toBe(false);
    if (!resCreated.ok) expect(resCreated.error.code).toBe("payment_not_yet_approved");

    // PAYER_ACTION_REQUIRED -> payment_not_yet_approved
    const resPayerAction = transition(
      state,
      {
        kind: "observe_paypal_order",
        observation: { orderId: "order-1", status: "PAYER_ACTION_REQUIRED", source: "paypal_order_get", observedAt: mockNow },
      },
      defaultContext
    );
    expect(resPayerAction.ok).toBe(false);
    if (!resPayerAction.ok) expect(resPayerAction.error.code).toBe("payment_not_yet_approved");

    // VOIDED -> unexpected_paypal_status
    const resVoided = transition(
      state,
      {
        kind: "observe_paypal_order",
        observation: { orderId: "order-1", status: "VOIDED", source: "paypal_order_get", observedAt: mockNow },
      },
      defaultContext
    );
    expect(resVoided.ok).toBe(false);
    if (!resVoided.ok) expect(resVoided.error.code).toBe("unexpected_paypal_status");

    // COMPLETED in ORDER_CREATED -> unexpected_paypal_status
    const resCompleted = transition(
      state,
      {
        kind: "observe_paypal_order",
        observation: { orderId: "order-1", status: "COMPLETED", source: "paypal_order_get", observedAt: mockNow },
      },
      defaultContext
    );
    expect(resCompleted.ok).toBe(false);
    if (!resCompleted.ok) expect(resCompleted.error.code).toBe("unexpected_paypal_status");

    // Unknown status -> unexpected_paypal_status
    const resUnknown = transition(
      state,
      {
        kind: "observe_paypal_order",
        observation: { orderId: "order-1", status: "PENDING" as unknown as "CREATED", source: "paypal_order_get", observedAt: mockNow },
      },
      defaultContext
    );
    expect(resUnknown.ok).toBe(false);
    if (!resUnknown.ok) expect(resUnknown.error.code).toBe("unexpected_paypal_status");

    // Order ID mismatch -> order_id_mismatch
    const resMismatch = transition(
      state,
      {
        kind: "observe_paypal_order",
        observation: { orderId: "order-other", status: "APPROVED", source: "paypal_order_get", observedAt: mockNow },
      },
      defaultContext
    );
    expect(resMismatch.ok).toBe(false);
    if (!resMismatch.ok) expect(resMismatch.error.code).toBe("order_id_mismatch");
  });

  it("T14 with each non-COMPLETED status at CAPTURE_ATTEMPTED moves to FAILED", () => {
    const state: PurchaseState = deepFreeze({
      ...baseState,
      status: "CAPTURE_ATTEMPTED",
      selectedCandidate: baseCandidate,
      approvals: [baseApproval],
      paymentAttempts: [baseLiveAttempt],
    });

    for (const st of ["CREATED", "PAYER_ACTION_REQUIRED", "APPROVED", "VOIDED"] as const) {
      const res = transition(
        state,
        {
          kind: "observe_paypal_order",
          observation: { orderId: "order-1", status: st, source: "paypal_order_get", observedAt: mockNow },
        },
        defaultContext
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.next.status).toBe("FAILED");
        expect(res.next.paymentAttempts[0].status).toBe("FAILED");
        expect(res.next.paymentAttempts[0].verifiedStatus).toBe(st);
        expect(res.next.paymentAttempts[0].failureReason).toBe("verified_status_not_completed");
      }
    }
  });

  it("T7 guard failures when fingerprints are missing or equal", () => {
    const basePassed: PurchaseState = {
      ...baseState,
      status: "POLICY_PASSED",
      selectedCandidate: baseCandidate,
      currentEvidenceFingerprint: "e".repeat(64),
      policyEvidenceFingerprint: "e".repeat(64),
    };

    // Equal -> guard_failed "no_change_to_reassess"
    const resEqual = transition(deepFreeze(basePassed), { kind: "reevaluate" }, defaultContext);
    expect(resEqual.ok).toBe(false);
    if (!resEqual.ok) {
      expect(resEqual.error.code).toBe("guard_failed");
      expect(resEqual.error.message).toBe("no_change_to_reassess");
    }

    // currentEvidenceFingerprint null -> guard_failed "evidence_fingerprint_missing"
    const resNullCurrent = transition(
      deepFreeze({ ...basePassed, currentEvidenceFingerprint: null }),
      { kind: "reevaluate" },
      defaultContext
    );
    expect(resNullCurrent.ok).toBe(false);
    if (!resNullCurrent.ok) {
      expect(resNullCurrent.error.code).toBe("guard_failed");
      expect(resNullCurrent.error.message).toBe("evidence_fingerprint_missing");
    }

    // policyEvidenceFingerprint null -> guard_failed "evidence_fingerprint_missing"
    const resNullPolicy = transition(
      deepFreeze({ ...basePassed, policyEvidenceFingerprint: null }),
      { kind: "reevaluate" },
      defaultContext
    );
    expect(resNullPolicy.ok).toBe(false);
    if (!resNullPolicy.ok) {
      expect(resNullPolicy.error.code).toBe("guard_failed");
      expect(resNullPolicy.error.message).toBe("evidence_fingerprint_missing");
    }
  });

  it("cancel from CAPTURE_ATTEMPTED, COMPLETED, FAILED, CANCELLED returns illegal_transition", () => {
    for (const st of ["CAPTURE_ATTEMPTED", "COMPLETED", "FAILED", "CANCELLED"] as const) {
      const state: PurchaseState = deepFreeze({
        ...baseState,
        status: st,
        paymentAttempts: st === "CAPTURE_ATTEMPTED" ? [baseLiveAttempt] : [],
      });
      const res = transition(state, { kind: "cancel", reason: "abort" }, defaultContext);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("illegal_transition");
      }
    }
  });

  it("after every successful cancel, no attempt has status OPEN", () => {
    const cancellableStatuses: PurchaseStatus[] = [
      "REQUIREMENTS_CONFIRMED",
      "EVALUATED",
      "POLICY_BLOCKED",
      "POLICY_PASSED",
      "APPROVED",
      "ORDER_CREATED",
      "BUYER_APPROVED",
    ];

    for (const status of cancellableStatuses) {
      const hasLive = status === "ORDER_CREATED" || status === "BUYER_APPROVED";
      const state: PurchaseState = deepFreeze({
        ...baseState,
        status,
        selectedCandidate: baseCandidate,
        approvals: [baseApproval],
        paymentAttempts: hasLive ? [baseLiveAttempt] : [],
      });

      const res = transition(state, { kind: "cancel", reason: "abort" }, defaultContext);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.next.status).toBe("CANCELLED");
        const openAttempts = res.next.paymentAttempts.filter((a) => a.status === "OPEN");
        expect(openAttempts).toHaveLength(0);
      }
    }
  });
});
