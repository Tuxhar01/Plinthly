import { MAX_CENTS } from "../../state/money";
import { BudgetRuleInput, PolicyRule, RuleResult } from "../types";

export const RULE_KEY_BUDGET = "P-BUDGET";
export const RULE_VERSION_BUDGET = "1.0.0";

function isValidCents(val: unknown): val is number {
  return typeof val === "number" && Number.isInteger(val) && val >= 0 && val <= MAX_CENTS;
}

export const budgetRule: PolicyRule<BudgetRuleInput> = {
  key: RULE_KEY_BUDGET,
  version: RULE_VERSION_BUDGET,
  evaluate(input: BudgetRuleInput): RuleResult {
    const { candidateTotalCents, budgetCents } = input ?? {};

    if (!isValidCents(budgetCents)) {
      return {
        ruleKey: RULE_KEY_BUDGET,
        ruleVersion: RULE_VERSION_BUDGET,
        outcome: "unknown",
        explanation: {
          observed: budgetCents,
          expected: `Integer cents between 0 and ${MAX_CENTS}`,
          reason: "Purchase budget is missing, non-integer, negative, or exceeds maximum limit.",
        },
      };
    }

    if (!isValidCents(candidateTotalCents)) {
      return {
        ruleKey: RULE_KEY_BUDGET,
        ruleVersion: RULE_VERSION_BUDGET,
        outcome: "unknown",
        explanation: {
          observed: candidateTotalCents,
          expected: `Integer cents between 0 and ${MAX_CENTS}`,
          reason: "Candidate stored total is missing, non-integer, negative, or exceeds maximum limit.",
        },
      };
    }

    if (candidateTotalCents <= budgetCents) {
      return {
        ruleKey: RULE_KEY_BUDGET,
        ruleVersion: RULE_VERSION_BUDGET,
        outcome: "pass",
        explanation: {
          observed: candidateTotalCents,
          expected: `<= ${budgetCents}`,
          reason: "Candidate stored total is within the confirmed budget.",
        },
      };
    }

    return {
      ruleKey: RULE_KEY_BUDGET,
      ruleVersion: RULE_VERSION_BUDGET,
      outcome: "block",
      explanation: {
        observed: candidateTotalCents,
        expected: `<= ${budgetCents}`,
        reason: "Candidate stored total exceeds the confirmed budget.",
      },
    };
  },
};
