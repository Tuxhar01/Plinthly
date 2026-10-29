import { describe, expect, it } from "vitest";
import { summarizePolicyResults } from "../../lib/state/policy-summary";

describe("summarizePolicyResults", () => {
  it("returns allRequiredPassed: true when all required keys pass", () => {
    const summary = summarizePolicyResults(
      [
        { ruleKey: "rule-1", outcome: "pass" },
        { ruleKey: "rule-2", outcome: "pass" },
      ],
      ["rule-1", "rule-2"]
    );

    expect(summary.allRequiredPassed).toBe(true);
    expect(summary.blockingRuleKeys).toEqual([]);
    expect(summary.unknownRuleKeys).toEqual([]);
  });

  it("identifies missing required keys as unknown", () => {
    const summary = summarizePolicyResults(
      [{ ruleKey: "rule-1", outcome: "pass" }],
      ["rule-1", "rule-missing"]
    );

    expect(summary.allRequiredPassed).toBe(false);
    expect(summary.unknownRuleKeys).toEqual(["rule-missing"]);
    expect(summary.blockingRuleKeys).toEqual([]);
  });

  it("identifies block outcomes as blockingRuleKeys", () => {
    const summary = summarizePolicyResults(
      [
        { ruleKey: "rule-1", outcome: "pass" },
        { ruleKey: "rule-2", outcome: "block" },
      ],
      ["rule-1", "rule-2"]
    );

    expect(summary.allRequiredPassed).toBe(false);
    expect(summary.blockingRuleKeys).toEqual(["rule-2"]);
    expect(summary.unknownRuleKeys).toEqual([]);
  });

  it("identifies unknown outcomes as unknownRuleKeys", () => {
    const summary = summarizePolicyResults(
      [
        { ruleKey: "rule-1", outcome: "pass" },
        { ruleKey: "rule-2", outcome: "unknown" },
      ],
      ["rule-1", "rule-2"]
    );

    expect(summary.allRequiredPassed).toBe(false);
    expect(summary.unknownRuleKeys).toEqual(["rule-2"]);
    expect(summary.blockingRuleKeys).toEqual([]);
  });

  it("throws on duplicate ruleKey in results", () => {
    expect(() =>
      summarizePolicyResults(
        [
          { ruleKey: "rule-dup", outcome: "pass" },
          { ruleKey: "rule-dup", outcome: "block" },
        ],
        ["rule-dup"]
      )
    ).toThrow(/Duplicate ruleKey in policy results/);
  });

  it("returns allRequiredPassed: false when requiredRuleKeys is empty (default)", () => {
    const summary = summarizePolicyResults([{ ruleKey: "rule-1", outcome: "pass" }], []);
    expect(summary.allRequiredPassed).toBe(false);
    expect(summary.blockingRuleKeys).toEqual([]);
    expect(summary.unknownRuleKeys).toEqual([]);
  });

  it("ignores extra result keys that are not required", () => {
    const summary = summarizePolicyResults(
      [
        { ruleKey: "req-1", outcome: "pass" },
        { ruleKey: "extra-ignored", outcome: "block" },
      ],
      ["req-1"]
    );

    expect(summary.allRequiredPassed).toBe(true);
    expect(summary.blockingRuleKeys).toEqual([]);
    expect(summary.unknownRuleKeys).toEqual([]);
  });
});
