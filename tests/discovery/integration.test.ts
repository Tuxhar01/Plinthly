import { describe, it, expect } from "vitest";
import { FixtureSourceAdapter } from "../../lib/discovery/fixture-adapter";
import { ingestCandidateEvidence } from "../../lib/discovery/evidence";
import { evaluatePolicy } from "../../lib/policy/evaluator";
import { transition } from "../../lib/state/transitions";
import { PurchaseState, CandidateFacts } from "../../lib/state/types";

describe("Phase 3 End-to-End Pipeline Integration", () => {
  const now = new Date("2026-10-20T12:10:00.000Z");
  const actor = { kind: "user" as const, userId: "user_buyer_1" };
  const adapter = new FixtureSourceAdapter();

  const initialDraftState: PurchaseState = {
    purchaseId: "purch_integration_001",
    status: "DRAFT",
    budgetCents: 40000, // $400.00 budget
    currency: "USD",
    policyVersion: "1.0.0",
    requiredRuleKeys: ["P-BUDGET", "P-CURRENCY", "P-QUANTITY", "P-AVAILABILITY", "P-EVIDENCE", "P-FRESHNESS"],
    selectedCandidate: null,
    currentEvidenceFingerprint: null,
    policyEvidenceFingerprint: null,
    approvals: [],
    paymentAttempts: [],
  };

  it("completes full flow: discovery -> evidence ingestion -> policy evaluation -> state machine approval", async () => {
    // 1. Discover product via adapter
    const searchResult = await adapter.search(
      {
        query: "keyboard",
        purchaseId: initialDraftState.purchaseId,
        constraints: {
          maxBudgetCents: initialDraftState.budgetCents,
          currency: "USD",
        },
      },
      { now }
    );

    expect(searchResult.status).toBe("success");
    if (searchResult.status !== "success") return;

    // Pick first complete candidate (Mechanical Keyboard: $89.00 + $0 = $89.00)
    const candidate = searchResult.candidates.find((c) => c.isComplete);
    expect(candidate).toBeDefined();
    if (!candidate) return;

    // 2. Ingest Evidence for candidate matching purchase requirements
    const requiredSpecs = [
      { key: "layout", expectedValue: "ANSI" },
      { key: "switch_type", expectedValue: "Tactile Brown" },
    ];

    const evidenceResult = ingestCandidateEvidence({
      candidate,
      requiredAttributes: requiredSpecs,
      rawObservations: candidate.rawSourceData.rawAttributes as Record<string, unknown>,
      now,
    });

    expect(evidenceResult.isComplete).toBe(true);
    expect(evidenceResult.evidenceFingerprint).toHaveLength(64);

    // 3. Evaluate Policy via Phase 2 evaluatePolicy
    const evaluation = evaluatePolicy({
      candidate: {
        id: candidate.id,
        purchaseId: candidate.purchaseId,
        source: candidate.source,
        externalId: candidate.externalId,
        title: candidate.title,
        merchantName: candidate.merchantName,
        merchantUrl: candidate.merchantUrl,
        unitPriceCents: candidate.unitPriceCents,
        quantity: candidate.quantity,
        shippingCents: candidate.shippingCents,
        totalCents: candidate.totalCents,
        currency: candidate.currency,
        availability: candidate.availability,
        snapshotHash: candidate.snapshotHash,
      },
      purchase: {
        id: initialDraftState.purchaseId,
        budgetCents: initialDraftState.budgetCents,
        currency: initialDraftState.currency,
        requestedQuantity: candidate.quantity,
        requiredAttributes: requiredSpecs,
      },
      evidence: evidenceResult.evidenceRecords,
      config: {
        requiredRuleKeys: initialDraftState.requiredRuleKeys,
        maxEvidenceAgeMs: 3600_000, // 1 hour
      },
      now,
      policyVersion: "1.0.0",
    });

    expect(evaluation.summary.allRequiredPassed).toBe(true);
    expect(evaluation.summary.blockingRuleKeys).toEqual([]);
    expect(evaluation.summary.unknownRuleKeys).toEqual([]);

    // 4. Drive Phase 1 State Machine transitions
    // T1: DRAFT -> REQUIREMENTS_CONFIRMED
    const t1Res = transition(
      initialDraftState,
      { kind: "confirm_requirements" },
      { actor, now }
    );
    expect(t1Res.ok).toBe(true);
    if (!t1Res.ok) return;

    // T2: REQUIREMENTS_CONFIRMED -> EVALUATED (select candidate)
    const candidateFacts: CandidateFacts = {
      id: candidate.id,
      purchaseId: candidate.purchaseId,
      source: candidate.source,
      unitPriceCents: candidate.unitPriceCents,
      quantity: candidate.quantity,
      shippingCents: candidate.shippingCents,
      totalCents: candidate.totalCents,
      currency: candidate.currency,
      snapshotHash: candidate.snapshotHash,
    };

    const t2Res = transition(
      t1Res.next,
      { kind: "select_candidate", candidate: candidateFacts, policyVersion: "1.0.0" },
      { actor, now }
    );
    expect(t2Res.ok).toBe(true);
    if (!t2Res.ok) return;

    // Set evidence fingerprint on state matching ingested evidence
    const stateWithFingerprint: PurchaseState = {
      ...t2Res.next,
      currentEvidenceFingerprint: evidenceResult.evidenceFingerprint,
    };

    // T4: EVALUATED -> POLICY_PASSED (apply summary)
    const t4Res = transition(
      stateWithFingerprint,
      {
        kind: "apply_policy_summary",
        summary: evaluation.summary,
        policyVersion: "1.0.0",
      },
      { actor, now }
    );
    expect(t4Res.ok).toBe(true);
    if (!t4Res.ok) return;
    expect(t4Res.next.status).toBe("POLICY_PASSED");

    // T6: POLICY_PASSED -> APPROVED
    const t6Res = transition(
      t4Res.next,
      { kind: "approve" },
      { actor, now, newApprovalId: "appr_phase3_001" }
    );
    expect(t6Res.ok).toBe(true);
    if (!t6Res.ok) return;
    expect(t6Res.next.status).toBe("APPROVED");
    expect(t6Res.next.approvals).toHaveLength(1);
    expect(t6Res.next.approvals[0].snapshotHash).toBe(candidate.snapshotHash);
    expect(t6Res.next.approvals[0].evidenceFingerprint).toBe(evidenceResult.evidenceFingerprint);
  });

  it("blocks policy and state machine when discovered candidate has contradictory evidence", async () => {
    // Search 4K monitor ($364.99 total, budget $400)
    const searchResult = await adapter.search(
      {
        query: "monitor",
        purchaseId: initialDraftState.purchaseId,
      },
      { now }
    );

    if (searchResult.status !== "success") return;
    const candidate = searchResult.candidates.find((c) => c.isComplete);
    expect(candidate).toBeDefined();
    if (!candidate) return;

    // Ingest evidence with a requirement contradictory to observation
    const evidenceResult = ingestCandidateEvidence({
      candidate,
      requiredAttributes: [
        { key: "color", expectedValue: "white" }, // Raw fixture observation has color: "black"
      ],
      rawObservations: candidate.rawSourceData.rawAttributes as Record<string, unknown>,
      now,
    });

    expect(evidenceResult.isComplete).toBe(false);
    expect(evidenceResult.contradictedAttributeKeys).toContain("color");

    const evaluation = evaluatePolicy({
      candidate: {
        id: candidate.id,
        purchaseId: candidate.purchaseId,
        source: candidate.source,
        externalId: candidate.externalId,
        title: candidate.title,
        merchantName: candidate.merchantName,
        merchantUrl: candidate.merchantUrl,
        unitPriceCents: candidate.unitPriceCents,
        quantity: candidate.quantity,
        shippingCents: candidate.shippingCents,
        totalCents: candidate.totalCents,
        currency: candidate.currency,
        availability: candidate.availability,
        snapshotHash: candidate.snapshotHash,
      },
      purchase: {
        id: initialDraftState.purchaseId,
        budgetCents: initialDraftState.budgetCents,
        currency: initialDraftState.currency,
        requestedQuantity: candidate.quantity,
        requiredAttributes: [{ key: "color", expectedValue: "white" }],
      },
      evidence: evidenceResult.evidenceRecords,
      config: {
        requiredRuleKeys: ["P-EVIDENCE"],
      },
      now,
      policyVersion: "1.0.0",
    });

    // P-EVIDENCE blocks
    expect(evaluation.summary.allRequiredPassed).toBe(false);
    expect(evaluation.summary.blockingRuleKeys).toContain("P-EVIDENCE");

    // State machine T5 transition: EVALUATED -> POLICY_BLOCKED
    const evaluatedState: PurchaseState = {
      ...initialDraftState,
      status: "EVALUATED",
      selectedCandidate: {
        id: candidate.id,
        purchaseId: candidate.purchaseId,
        source: candidate.source,
        unitPriceCents: candidate.unitPriceCents,
        quantity: candidate.quantity,
        shippingCents: candidate.shippingCents,
        totalCents: candidate.totalCents,
        currency: candidate.currency,
        snapshotHash: candidate.snapshotHash,
      },
      currentEvidenceFingerprint: evidenceResult.evidenceFingerprint,
    };

    const t5Res = transition(
      evaluatedState,
      {
        kind: "apply_policy_summary",
        summary: evaluation.summary,
        policyVersion: "1.0.0",
      },
      { actor, now }
    );

    expect(t5Res.ok).toBe(true);
    if (t5Res.ok) {
      expect(t5Res.next.status).toBe("POLICY_BLOCKED");
    }
  });
});
