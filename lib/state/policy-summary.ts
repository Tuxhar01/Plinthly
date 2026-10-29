import { PolicyOutcome, PolicySummary } from "./types";

export interface PolicyResultInput {
  ruleKey: string;
  outcome: PolicyOutcome;
}

export function summarizePolicyResults(
  results: readonly PolicyResultInput[],
  requiredRuleKeys: readonly string[]
): PolicySummary {
  // Check for duplicate ruleKey in results
  const seenKeys = new Set<string>();
  for (const r of results) {
    if (seenKeys.has(r.ruleKey)) {
      throw new Error(`Duplicate ruleKey in policy results: ${r.ruleKey}`);
    }
    seenKeys.add(r.ruleKey);
  }

  // If requiredRuleKeys is empty, allRequiredPassed is false by default
  if (!requiredRuleKeys || requiredRuleKeys.length === 0) {
    return {
      allRequiredPassed: false,
      blockingRuleKeys: [],
      unknownRuleKeys: [],
    };
  }

  const resultMap = new Map<string, PolicyOutcome>();
  for (const r of results) {
    resultMap.set(r.ruleKey, r.outcome);
  }

  const blockingRuleKeys: string[] = [];
  const unknownRuleKeys: string[] = [];
  let allPass = true;

  for (const reqKey of requiredRuleKeys) {
    const outcome = resultMap.get(reqKey);
    if (!outcome || outcome === "unknown") {
      unknownRuleKeys.push(reqKey);
      allPass = false;
    } else if (outcome === "block") {
      blockingRuleKeys.push(reqKey);
      allPass = false;
    } else if (outcome === "pass") {
      // passed
    } else {
      unknownRuleKeys.push(reqKey);
      allPass = false;
    }
  }

  return {
    allRequiredPassed: allPass,
    blockingRuleKeys,
    unknownRuleKeys,
  };
}
