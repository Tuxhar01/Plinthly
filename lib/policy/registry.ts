import { budgetRule, RULE_KEY_BUDGET } from "./rules/budget";
import { currencyRule, RULE_KEY_CURRENCY } from "./rules/currency";
import { quantityRule, RULE_KEY_QUANTITY } from "./rules/quantity";
import { evidenceRule, RULE_KEY_EVIDENCE } from "./rules/evidence";
import { availabilityRule, RULE_KEY_AVAILABILITY } from "./rules/availability";
import { vendorRule, RULE_KEY_VENDOR } from "./rules/vendor";
import { freshnessRule, RULE_KEY_FRESHNESS } from "./rules/freshness";
import { duplicateRule, RULE_KEY_DUPLICATE } from "./rules/duplicate";
import { AnyPolicyRule } from "./types";

export const ALL_RULE_KEYS = [
  RULE_KEY_BUDGET,
  RULE_KEY_CURRENCY,
  RULE_KEY_QUANTITY,
  RULE_KEY_EVIDENCE,
  RULE_KEY_AVAILABILITY,
  RULE_KEY_VENDOR,
  RULE_KEY_FRESHNESS,
  RULE_KEY_DUPLICATE,
] as const;

export type StandardRuleKey = (typeof ALL_RULE_KEYS)[number];

const registeredRules: readonly AnyPolicyRule[] = [
  budgetRule as AnyPolicyRule,
  currencyRule as AnyPolicyRule,
  quantityRule as AnyPolicyRule,
  evidenceRule as AnyPolicyRule,
  availabilityRule as AnyPolicyRule,
  vendorRule as AnyPolicyRule,
  freshnessRule as AnyPolicyRule,
  duplicateRule as AnyPolicyRule,
];

// Validate registry integrity on module initialization:
// Asserts all 8 required rules are registered exactly once, no duplicates, no missing rules.
const ruleMap = new Map<string, AnyPolicyRule>();
for (const rule of registeredRules) {
  if (ruleMap.has(rule.key)) {
    throw new Error(`Duplicate rule registration detected for key: "${rule.key}"`);
  }
  ruleMap.set(rule.key, rule);
}

for (const expectedKey of ALL_RULE_KEYS) {
  if (!ruleMap.has(expectedKey)) {
    throw new Error(`Required standard rule "${expectedKey}" is missing from registry`);
  }
}

if (registeredRules.length !== 8) {
  throw new Error(`Registry must contain exactly 8 standard rules, found ${registeredRules.length}`);
}

export function getRule(ruleKey: string): AnyPolicyRule | undefined {
  return ruleMap.get(ruleKey);
}

export function getAllRules(): readonly AnyPolicyRule[] {
  return registeredRules;
}

export function getRegisteredRuleKeys(): readonly string[] {
  return ALL_RULE_KEYS;
}
