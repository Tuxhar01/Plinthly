import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../lib/policy/evaluator";
import { ALL_RULE_KEYS } from "../../lib/policy/registry";
import { PolicyEvaluationInput } from "../../lib/policy/types";
import { transition } from "../../lib/state/transitions";
import { PurchaseState } from "../../lib/state/types";

const FIXED_NOW = new Date("2026-10-20T12:00:00.000Z");

function createPassingInput(): PolicyEvaluationInput {
  const candidateId = "cand-101";
  const capturedAt = new Date(FIXED_NOW.getTime() - 600 * 1000); // 10 mins ago

  return {
    candidate: {
      id: candidateId,
      externalId: "EXT-PROD-1",
      title: "Enterprise Ergonomic Keyboard",
      merchantName: "Acme Supplies",
      merchantUrl: "https://acme.example.com",
      unitPriceCents: 4500,
      quantity: 2,
      shippingCents: 1000,
      totalCents: 10000,
      currency: "USD",
      availability: "in_stock",
      snapshotHash: "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff",
    },
    purchase: {
      id: "purch-101",
      budgetCents: 15000,
      currency: "USD",
      requestedQuantity: 2,
      requiredAttributes: ["layout", "switchType"],
    },
    evidence: [
      {
        id: "ev-1",
        candidateId,
        requirementKey: "layout",
        status: "supports",
        value: "ANSI",
        capturedAt,
      },
      {
        id: "ev-2",
        candidateId,
        requirementKey: "switchType",
        status: "supports",
        value: "Tactile",
        capturedAt,
      },
    ],
    config: {
      requiredRuleKeys: ALL_RULE_KEYS,
      vendorAllowList: ["Acme Supplies", "Tech Depot"],
      maxEvidenceAgeMs: 3600 * 1000, // 1 hour
      purchaseHistory: [],
      isHistoryComplete: true,
    },
    now: FIXED_NOW,
    policyVersion: "1.0.0",
  };
}

describe("Policy Engine - Aggregate Evaluation", () => {
  it("passes aggregate evaluation when all eight required rules pass", () => {
    const input = createPassingInput();
    const result = evaluatePolicy(input);

    expect(result.summary.allRequiredPassed).toBe(true);
    expect(result.summary.blockingRuleKeys).toEqual([]);
    expect(result.summary.unknownRuleKeys).toEqual([]);
    expect(Object.keys(result.ruleResults)).toHaveLength(8);

    for (const key of ALL_RULE_KEYS) {
      expect(result.ruleResults[key].outcome).toBe("pass");
    }
  });

  it("fails aggregate approval when any required rule blocks", () => {
    const input = createPassingInput();
    // Over budget by 1 cent
    input.candidate.totalCents = 15001;
    input.purchase.budgetCents = 15000;

    const result = evaluatePolicy(input);

    expect(result.summary.allRequiredPassed).toBe(false);
    expect(result.summary.blockingRuleKeys).toContain("P-BUDGET");
    expect(result.ruleResults["P-BUDGET"].outcome).toBe("block");
  });

  it("fails aggregate approval when any required rule is unknown", () => {
    const input = createPassingInput();
    // Missing required evidence for "switchType"
    input.evidence = input.evidence?.filter((e) => e.requirementKey !== "switchType");

    const result = evaluatePolicy(input);

    expect(result.summary.allRequiredPassed).toBe(false);
    expect(result.summary.unknownRuleKeys).toContain("P-EVIDENCE");
    expect(result.ruleResults["P-EVIDENCE"].outcome).toBe("unknown");
  });

  it("fails aggregate approval when both block and unknown rules occur", () => {
    const input = createPassingInput();
    // Budget blocks
    input.candidate.totalCents = 20000;
    input.purchase.budgetCents = 10000;
    // Quantity mismatch: blocks
    input.candidate.quantity = 5;
    input.purchase.requestedQuantity = 2;
    // Incomplete history: unknown
    input.config.isHistoryComplete = false;

    const result = evaluatePolicy(input);

    expect(result.summary.allRequiredPassed).toBe(false);
    expect(result.summary.blockingRuleKeys).toContain("P-BUDGET");
    expect(result.summary.blockingRuleKeys).toContain("P-QUANTITY");
    expect(result.summary.unknownRuleKeys).toContain("P-DUPLICATE");
  });

  it("currency mismatch blocks aggregate evaluation", () => {
    const input = createPassingInput();
    input.candidate.currency = "EUR";

    const result = evaluatePolicy(input);

    expect(result.summary.allRequiredPassed).toBe(false);
    expect(result.summary.blockingRuleKeys).toContain("P-CURRENCY");
  });

  it("availability out_of_stock blocks aggregate evaluation", () => {
    const input = createPassingInput();
    input.candidate.availability = "out_of_stock";

    const result = evaluatePolicy(input);

    expect(result.summary.allRequiredPassed).toBe(false);
    expect(result.summary.blockingRuleKeys).toContain("P-AVAILABILITY");
  });

  it("missing vendor allow-list never silently becomes a pass", () => {
    const input = createPassingInput();
    input.config.vendorAllowList = undefined; // missing required config

    const result = evaluatePolicy(input);

    expect(result.summary.allRequiredPassed).toBe(false);
    expect(result.summary.unknownRuleKeys).toContain("P-VENDOR");
  });

  it("missing freshness threshold never silently becomes a pass", () => {
    const input = createPassingInput();
    input.config.maxEvidenceAgeMs = undefined; // missing required threshold

    const result = evaluatePolicy(input);

    expect(result.summary.allRequiredPassed).toBe(false);
    expect(result.summary.unknownRuleKeys).toContain("P-FRESHNESS");
  });

  it("an AI recommendation cannot override a budget block (zero AI influence)", () => {
    const input = createPassingInput();
    input.candidate.totalCents = 20000;
    input.purchase.budgetCents = 15000;

    // Inject arbitrary AI claims/flags into the candidate or input
    const candidateWithAi = input.candidate as unknown as Record<string, unknown>;
    candidateWithAi.aiRecommended = true;
    candidateWithAi.aiScore = 0.99;
    candidateWithAi.aiOverride = "APPROVED_BY_ASSISTANT";

    const result = evaluatePolicy(input);

    // AI claims are completely ignored; rule strictly blocks on integer cents
    expect(result.summary.allRequiredPassed).toBe(false);
    expect(result.summary.blockingRuleKeys).toContain("P-BUDGET");
  });

  it("does not mutate input objects during evaluation", () => {
    const input = createPassingInput();
    const candidateSnapshot = JSON.stringify(input.candidate);
    const purchaseSnapshot = JSON.stringify(input.purchase);
    const configSnapshot = JSON.stringify(input.config);
    const evidenceSnapshot = JSON.stringify(input.evidence);

    evaluatePolicy(input);

    expect(JSON.stringify(input.candidate)).toBe(candidateSnapshot);
    expect(JSON.stringify(input.purchase)).toBe(purchaseSnapshot);
    expect(JSON.stringify(input.config)).toBe(configSnapshot);
    expect(JSON.stringify(input.evidence)).toBe(evidenceSnapshot);
  });

  it("integrates seamlessly with Phase 1 state machine: passing summary triggers POLICY_PASSED", () => {
    const input = createPassingInput();
    const policyResult = evaluatePolicy(input);
    expect(policyResult.summary.allRequiredPassed).toBe(true);

    const baseState: PurchaseState = {
      purchaseId: "purch-101",
      status: "EVALUATED",
      budgetCents: 15000,
      currency: "USD",
      policyVersion: null,
      requiredRuleKeys: ALL_RULE_KEYS,
      selectedCandidate: {
        id: input.candidate.id,
        purchaseId: "purch-101",
        source: "channel3",
        unitPriceCents: 4500,
        quantity: 2,
        shippingCents: 1000,
        totalCents: 10000,
        currency: "USD",
        snapshotHash: input.candidate.snapshotHash!,
      },
      currentEvidenceFingerprint: "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
      policyEvidenceFingerprint: null,
      approvals: [],
      paymentAttempts: [],
    };

    const transitionResult = transition(
      baseState,
      {
        kind: "apply_policy_summary",
        summary: policyResult.summary,
        policyVersion: policyResult.policyVersion,
      },
      {
        actor: { kind: "system", component: "policy_evaluator" },
        now: FIXED_NOW,
      }
    );

    expect(transitionResult.ok).toBe(true);
    if (transitionResult.ok) {
      expect(transitionResult.next.status).toBe("POLICY_PASSED");
      expect(transitionResult.next.policyVersion).toBe("1.0.0");
      expect(transitionResult.events[0].type).toBe("policy_passed");
    }
  });

  it("integrates seamlessly with Phase 1 state machine: blocking summary triggers POLICY_BLOCKED", () => {
    const input = createPassingInput();
    input.candidate.totalCents = 99999; // trigger block
    const policyResult = evaluatePolicy(input);
    expect(policyResult.summary.allRequiredPassed).toBe(false);

    const baseState: PurchaseState = {
      purchaseId: "purch-101",
      status: "EVALUATED",
      budgetCents: 15000,
      currency: "USD",
      policyVersion: null,
      requiredRuleKeys: ALL_RULE_KEYS,
      selectedCandidate: {
        id: input.candidate.id,
        purchaseId: "purch-101",
        source: "channel3",
        unitPriceCents: 4500,
        quantity: 2,
        shippingCents: 1000,
        totalCents: 99999,
        currency: "USD",
        snapshotHash: input.candidate.snapshotHash!,
      },
      currentEvidenceFingerprint: "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
      policyEvidenceFingerprint: null,
      approvals: [],
      paymentAttempts: [],
    };

    const transitionResult = transition(
      baseState,
      {
        kind: "apply_policy_summary",
        summary: policyResult.summary,
        policyVersion: policyResult.policyVersion,
      },
      {
        actor: { kind: "system", component: "policy_evaluator" },
        now: FIXED_NOW,
      }
    );

    expect(transitionResult.ok).toBe(true);
    if (transitionResult.ok) {
      expect(transitionResult.next.status).toBe("POLICY_BLOCKED");
      expect(transitionResult.events[0].type).toBe("policy_blocked");
    }
  });

  it("rejects duplicate rule keys in requiredRuleKeys configuration (fails closed to unknown)", () => {
    const input = createPassingInput();
    input.config.requiredRuleKeys = ["P-BUDGET", "P-BUDGET", "P-CURRENCY"];

    const result = evaluatePolicy(input);

    expect(result.summary.allRequiredPassed).toBe(false);
    expect(result.summary.unknownRuleKeys).toContain("P-BUDGET");
    expect(result.ruleResults["P-BUDGET"].outcome).toBe("unknown");
    expect(result.ruleResults["P-BUDGET"].explanation.reason).toContain("Duplicate rule key");
  });

  it("fails closed when requiredRuleKeys contains an unregistered rule key", () => {
    const input = createPassingInput();
    input.config.requiredRuleKeys = ["P-BUDGET", "NON_EXISTENT_RULE"];

    const result = evaluatePolicy(input);

    expect(result.summary.allRequiredPassed).toBe(false);
    expect(result.summary.unknownRuleKeys).toContain("NON_EXISTENT_RULE");
    expect(result.ruleResults["NON_EXISTENT_RULE"].outcome).toBe("unknown");
    expect(result.ruleResults["NON_EXISTENT_RULE"].explanation.reason).toContain("not registered");
  });
});
