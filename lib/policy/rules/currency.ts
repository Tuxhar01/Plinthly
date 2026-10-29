import { CurrencyRuleInput, PolicyRule, RuleResult } from "../types";

export const RULE_KEY_CURRENCY = "P-CURRENCY";
export const RULE_VERSION_CURRENCY = "1.0.0";

const ISO_4217_REGEX = /^[A-Z]{3}$/;

export const currencyRule: PolicyRule<CurrencyRuleInput> = {
  key: RULE_KEY_CURRENCY,
  version: RULE_VERSION_CURRENCY,
  evaluate(input: CurrencyRuleInput): RuleResult {
    const { candidateCurrency, purchaseCurrency } = input ?? {};

    const isCandidateValid =
      typeof candidateCurrency === "string" && ISO_4217_REGEX.test(candidateCurrency.trim().toUpperCase());
    const isPurchaseValid =
      typeof purchaseCurrency === "string" && ISO_4217_REGEX.test(purchaseCurrency.trim().toUpperCase());

    if (!isCandidateValid || !isPurchaseValid) {
      return {
        ruleKey: RULE_KEY_CURRENCY,
        ruleVersion: RULE_VERSION_CURRENCY,
        outcome: "unknown",
        explanation: {
          observed: { candidateCurrency, purchaseCurrency },
          expected: { candidateCurrency: "USD", purchaseCurrency: "USD" },
          reason: "Currency is missing, empty, or not a valid 3-letter ISO currency code.",
        },
      };
    }

    const normCandidate = (candidateCurrency as string).trim().toUpperCase();
    const normPurchase = (purchaseCurrency as string).trim().toUpperCase();

    if (normCandidate === "USD" && normPurchase === "USD") {
      return {
        ruleKey: RULE_KEY_CURRENCY,
        ruleVersion: RULE_VERSION_CURRENCY,
        outcome: "pass",
        explanation: {
          observed: { candidateCurrency: normCandidate, purchaseCurrency: normPurchase },
          expected: { candidateCurrency: "USD", purchaseCurrency: "USD" },
          reason: "Both candidate and purchase use supported currency USD.",
        },
      };
    }

    return {
      ruleKey: RULE_KEY_CURRENCY,
      ruleVersion: RULE_VERSION_CURRENCY,
      outcome: "block",
      explanation: {
        observed: { candidateCurrency: normCandidate, purchaseCurrency: normPurchase },
        expected: { candidateCurrency: "USD", purchaseCurrency: "USD" },
        reason: `Unsupported currency detected (only USD is supported). Candidate: ${normCandidate}, Purchase: ${normPurchase}.`,
      },
    };
  },
};
