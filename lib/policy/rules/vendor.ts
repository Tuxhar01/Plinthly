import { PolicyRule, RuleResult, VendorRuleInput } from "../types";

export const RULE_KEY_VENDOR = "P-VENDOR";
export const RULE_VERSION_VENDOR = "1.0.0";

/**
 * Normalization policy for vendor comparison:
 * 1. Trim leading and trailing whitespace.
 * 2. Convert to lowercase.
 * 3. Exact string equality against each allow-list entry (no regex, substring, or fuzzy matching).
 */
export function normalizeMerchant(name: string): string {
  return name.trim().toLowerCase();
}

export const vendorRule: PolicyRule<VendorRuleInput> = {
  key: RULE_KEY_VENDOR,
  version: RULE_VERSION_VENDOR,
  evaluate(input: VendorRuleInput): RuleResult {
    const { merchantName, allowList } = input ?? {};

    if (typeof merchantName !== "string" || merchantName.trim().length === 0) {
      return {
        ruleKey: RULE_KEY_VENDOR,
        ruleVersion: RULE_VERSION_VENDOR,
        outcome: "unknown",
        explanation: {
          observed: merchantName,
          expected: "Non-empty merchantName string",
          reason: "Candidate merchant name is missing, empty, or not a string.",
        },
      };
    }

    if (!Array.isArray(allowList) || allowList.length === 0) {
      return {
        ruleKey: RULE_KEY_VENDOR,
        ruleVersion: RULE_VERSION_VENDOR,
        outcome: "unknown",
        explanation: {
          observed: allowList,
          expected: "Non-empty array of approved vendor names",
          reason: "Vendor allow-list is missing, not an array, or empty (cannot authorize any merchant).",
        },
      };
    }

    // Check each entry in allowList is a valid non-empty string
    for (const item of allowList) {
      if (typeof item !== "string" || item.trim().length === 0) {
        return {
          ruleKey: RULE_KEY_VENDOR,
          ruleVersion: RULE_VERSION_VENDOR,
          outcome: "unknown",
          explanation: {
            observed: allowList,
            expected: "Array of non-empty strings",
            reason: `Vendor allow-list contains invalid entry: "${item}".`,
          },
        };
      }
    }

    const normMerchant = normalizeMerchant(merchantName);
    const isAllowed = allowList.some((allowed) => normalizeMerchant(allowed) === normMerchant);

    if (isAllowed) {
      return {
        ruleKey: RULE_KEY_VENDOR,
        ruleVersion: RULE_VERSION_VENDOR,
        outcome: "pass",
        explanation: {
          observed: merchantName,
          expected: `One of: ${allowList.join(", ")}`,
          reason: "Candidate merchant is present on the caller-supplied vendor allow-list.",
        },
      };
    }

    return {
      ruleKey: RULE_KEY_VENDOR,
      ruleVersion: RULE_VERSION_VENDOR,
      outcome: "block",
      explanation: {
        observed: merchantName,
        expected: `One of: ${allowList.join(", ")}`,
        reason: "Candidate merchant is not present on the caller-supplied vendor allow-list.",
      },
    };
  },
};
