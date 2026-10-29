import { summarizePolicyResults } from "../state/policy-summary";
import { ALL_RULE_KEYS, getRule } from "./registry";
import {
  PolicyEvaluationInput,
  PolicyEvaluationResult,
  PolicyRuleContext,
  RuleResult,
} from "./types";

export const DEFAULT_POLICY_VERSION = "1.0.0";

/**
 * Pure, deterministic aggregate policy evaluation.
 * Evaluates configured required rules against candidate facts, purchase requirements, and evidence.
 *
 * Requirements enforced:
 * 1. Every required rule produces an explicit pass, block, or unknown result.
 * 2. Every required rule runs exactly once; duplicate rule keys in configuration are rejected.
 * 3. Any required block prevents approval (allRequiredPassed: false).
 * 4. Any required unknown prevents approval (allRequiredPassed: false).
 * 5. allRequiredPassed is true ONLY when every required rule produces pass.
 * 6. Returns a PolicySummary strictly compatible with Phase 1 state-machine transitions.
 * 7. Preserves each individual rule result and structured explanation.
 * 8. Zero LLM influence, zero network/db I/O, zero clock access (uses caller-supplied now).
 * 9. Missing or invalid required policy configuration never silently becomes a pass.
 * 10. Input objects are never mutated.
 */
export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluationResult {
  // Defensive clock check
  const now = input?.now;
  const isNowValid = now instanceof Date && !isNaN(now.getTime());
  const evaluationDate = isNowValid ? new Date(now.getTime()) : new Date(NaN);
  const context: PolicyRuleContext = { now: evaluationDate };

  const policyVersion = input?.policyVersion ?? DEFAULT_POLICY_VERSION;
  const config = input?.config;
  const candidate = input?.candidate;
  const purchase = input?.purchase;
  const evidence = input?.evidence;

  // Resolve required rule keys: default to all 8 standard rules if not specified
  const rawRuleKeys: readonly string[] = config?.requiredRuleKeys ?? ALL_RULE_KEYS;

  const ruleResults: Record<string, RuleResult> = {};

  // If now is invalid, fail closed immediately
  if (!isNowValid) {
    const invalidClockSummary = {
      allRequiredPassed: false,
      blockingRuleKeys: [],
      unknownRuleKeys: Array.from(rawRuleKeys),
    };

    for (const key of rawRuleKeys) {
      ruleResults[key] = {
        ruleKey: key,
        ruleVersion: policyVersion,
        outcome: "unknown",
        explanation: {
          observed: now,
          expected: "Valid Date instance for evaluation timestamp",
          reason: "Evaluation timestamp now is missing or invalid.",
        },
      };
    }

    return {
      summary: invalidClockSummary,
      ruleResults,
      evaluatedAt: evaluationDate,
      policyVersion,
    };
  }

  // If requiredRuleKeys is explicitly empty, fail closed (cannot approve with zero verified requirements)
  if (!rawRuleKeys || rawRuleKeys.length === 0) {
    return {
      summary: {
        allRequiredPassed: false,
        blockingRuleKeys: [],
        unknownRuleKeys: [],
      },
      ruleResults: {},
      evaluatedAt: evaluationDate,
      policyVersion,
    };
  }

  // Validate that required rule keys contain no duplicates
  const seenKeys = new Set<string>();
  let duplicateKeyFound: string | null = null;
  for (const key of rawRuleKeys) {
    if (seenKeys.has(key)) {
      duplicateKeyFound = key;
      break;
    }
    seenKeys.add(key);
  }

  if (duplicateKeyFound) {
    // Duplicate rule keys in required configuration: fail closed with unknown
    const uniqueKeys = Array.from(seenKeys);
    for (const key of uniqueKeys) {
      ruleResults[key] = {
        ruleKey: key,
        ruleVersion: policyVersion,
        outcome: "unknown",
        explanation: {
          observed: rawRuleKeys,
          expected: "Array of unique required rule keys without duplicates",
          reason: `Duplicate rule key "${duplicateKeyFound}" detected in required rule configuration.`,
        },
      };
    }

    return {
      summary: {
        allRequiredPassed: false,
        blockingRuleKeys: [],
        unknownRuleKeys: uniqueKeys,
      },
      ruleResults,
      evaluatedAt: evaluationDate,
      policyVersion,
    };
  }

  const requiredRuleKeys = Array.from(seenKeys);

  // Evaluate each required rule exactly once
  for (const ruleKey of requiredRuleKeys) {
    const rule = getRule(ruleKey);

    if (!rule) {
      // Unrecognized or unregistered rule key: fail closed with unknown
      ruleResults[ruleKey] = {
        ruleKey,
        ruleVersion: policyVersion,
        outcome: "unknown",
        explanation: {
          observed: ruleKey,
          expected: "Registered standard rule key",
          reason: `Policy rule "${ruleKey}" is not registered in the policy engine.`,
        },
      };
      continue;
    }

    let result: RuleResult;

    switch (ruleKey) {
      case "P-BUDGET":
        result = rule.evaluate(
          {
            candidateTotalCents: candidate?.totalCents,
            budgetCents: purchase?.budgetCents,
          },
          context
        );
        break;

      case "P-CURRENCY":
        result = rule.evaluate(
          {
            candidateCurrency: candidate?.currency,
            purchaseCurrency: purchase?.currency,
          },
          context
        );
        break;

      case "P-QUANTITY":
        result = rule.evaluate(
          {
            candidateQuantity: candidate?.quantity,
            requestedQuantity: purchase?.requestedQuantity,
          },
          context
        );
        break;

      case "P-EVIDENCE":
        result = rule.evaluate(
          {
            candidateId: candidate?.id,
            requiredAttributes: purchase?.requiredAttributes,
            evidence: evidence ?? [],
          },
          context
        );
        break;

      case "P-AVAILABILITY":
        result = rule.evaluate(
          {
            availability: candidate?.availability,
          },
          context
        );
        break;

      case "P-VENDOR":
        result = rule.evaluate(
          {
            merchantName: candidate?.merchantName,
            allowList: config?.vendorAllowList,
          },
          context
        );
        break;

      case "P-FRESHNESS":
        result = rule.evaluate(
          {
            evidence: evidence ?? [],
            maxAgeMs: config?.maxEvidenceAgeMs,
            candidateId: candidate?.id,
            requiredAttributes: purchase?.requiredAttributes,
          },
          context
        );
        break;

      case "P-DUPLICATE":
        result = rule.evaluate(
          {
            candidate: {
              id: candidate?.id,
              externalId: candidate?.externalId,
              merchantName: candidate?.merchantName,
              snapshotHash: candidate?.snapshotHash,
            },
            history: config?.purchaseHistory ?? [],
            isHistoryComplete: config?.isHistoryComplete,
          },
          context
        );
        break;

      default:
        result = {
          ruleKey,
          ruleVersion: rule.version,
          outcome: "unknown",
          explanation: {
            observed: ruleKey,
            expected: "Registered rule dispatch",
            reason: `No dispatch handler configured for rule key: "${ruleKey}".`,
          },
        };
        break;
    }

    ruleResults[ruleKey] = result;
  }

  // Summarize results using Phase 1 policy-summary logic
  const policyInputs = requiredRuleKeys.map((key) => ({
    ruleKey: key,
    outcome: ruleResults[key].outcome,
  }));

  const summary = summarizePolicyResults(policyInputs, requiredRuleKeys);

  return {
    summary,
    ruleResults,
    evaluatedAt: evaluationDate,
    policyVersion,
  };
}
