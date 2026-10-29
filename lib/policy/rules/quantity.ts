import { MAX_CENTS } from "../../state/money";
import { PolicyRule, QuantityRuleInput, RuleResult } from "../types";

export const RULE_KEY_QUANTITY = "P-QUANTITY";
export const RULE_VERSION_QUANTITY = "1.0.0";

function isValidQuantity(val: unknown): val is number {
  return typeof val === "number" && Number.isInteger(val) && val >= 1 && val <= MAX_CENTS;
}

export const quantityRule: PolicyRule<QuantityRuleInput> = {
  key: RULE_KEY_QUANTITY,
  version: RULE_VERSION_QUANTITY,
  evaluate(input: QuantityRuleInput): RuleResult {
    const { candidateQuantity, requestedQuantity } = input ?? {};

    if (!isValidQuantity(requestedQuantity)) {
      return {
        ruleKey: RULE_KEY_QUANTITY,
        ruleVersion: RULE_VERSION_QUANTITY,
        outcome: "unknown",
        explanation: {
          observed: requestedQuantity,
          expected: `Positive integer between 1 and ${MAX_CENTS}`,
          reason: "Requested purchase quantity is missing, non-integer, or out of range.",
        },
      };
    }

    if (!isValidQuantity(candidateQuantity)) {
      return {
        ruleKey: RULE_KEY_QUANTITY,
        ruleVersion: RULE_VERSION_QUANTITY,
        outcome: "unknown",
        explanation: {
          observed: candidateQuantity,
          expected: `Positive integer between 1 and ${MAX_CENTS}`,
          reason: "Candidate quantity is missing, non-integer, or out of range.",
        },
      };
    }

    if (candidateQuantity === requestedQuantity) {
      return {
        ruleKey: RULE_KEY_QUANTITY,
        ruleVersion: RULE_VERSION_QUANTITY,
        outcome: "pass",
        explanation: {
          observed: candidateQuantity,
          expected: requestedQuantity,
          reason: "Authoritative candidate quantity exactly matches requested quantity.",
        },
      };
    }

    return {
      ruleKey: RULE_KEY_QUANTITY,
      ruleVersion: RULE_VERSION_QUANTITY,
      outcome: "block",
      explanation: {
        observed: candidateQuantity,
        expected: requestedQuantity,
        reason: "Authoritative candidate quantity does not match requested quantity.",
      },
    };
  },
};
