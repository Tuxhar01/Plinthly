import { AvailabilityRuleInput, PolicyRule, RuleResult } from "../types";

export const RULE_KEY_AVAILABILITY = "P-AVAILABILITY";
export const RULE_VERSION_AVAILABILITY = "1.0.0";

export const availabilityRule: PolicyRule<AvailabilityRuleInput> = {
  key: RULE_KEY_AVAILABILITY,
  version: RULE_VERSION_AVAILABILITY,
  evaluate(input: AvailabilityRuleInput): RuleResult {
    const { availability } = input ?? {};

    if (typeof availability !== "string") {
      return {
        ruleKey: RULE_KEY_AVAILABILITY,
        ruleVersion: RULE_VERSION_AVAILABILITY,
        outcome: "unknown",
        explanation: {
          observed: availability,
          expected: '"in_stock" or "out_of_stock"',
          reason: "Availability status is missing or not a string.",
        },
      };
    }

    const normalized = availability.trim().toLowerCase();

    if (normalized === "in_stock") {
      return {
        ruleKey: RULE_KEY_AVAILABILITY,
        ruleVersion: RULE_VERSION_AVAILABILITY,
        outcome: "pass",
        explanation: {
          observed: availability,
          expected: '"in_stock"',
          reason: "Authoritative candidate data explicitly confirms candidate is in stock.",
        },
      };
    }

    if (normalized === "out_of_stock") {
      return {
        ruleKey: RULE_KEY_AVAILABILITY,
        ruleVersion: RULE_VERSION_AVAILABILITY,
        outcome: "block",
        explanation: {
          observed: availability,
          expected: '"in_stock"',
          reason: "Authoritative candidate data explicitly confirms candidate is out of stock.",
        },
      };
    }

    return {
      ruleKey: RULE_KEY_AVAILABILITY,
      ruleVersion: RULE_VERSION_AVAILABILITY,
      outcome: "unknown",
      explanation: {
        observed: availability,
        expected: '"in_stock" or "out_of_stock"',
        reason: `Availability information is ambiguous or unconfirmed: "${availability}".`,
      },
    };
  },
};
