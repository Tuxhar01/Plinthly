import { EvidenceItemInput, FreshnessRuleInput, PolicyRule, PolicyRuleContext, RuleResult } from "../types";
import { parseRequirementSpec } from "./evidence";

export const RULE_KEY_FRESHNESS = "P-FRESHNESS";
export const RULE_VERSION_FRESHNESS = "1.0.0";

interface ParsedTimestamp {
  valid: boolean;
  date?: Date;
  error?: string;
}

function parseCapturedAt(val: unknown): ParsedTimestamp {
  if (val instanceof Date) {
    if (isNaN(val.getTime())) {
      return { valid: false, error: "Invalid Date instance" };
    }
    if (val.getTime() === 0) {
      return { valid: false, error: "Timestamp is missing or invalid sentinel (epoch 0)" };
    }
    return { valid: true, date: val };
  }

  if (typeof val === "string" && val.trim().length > 0) {
    const trimmed = val.trim();
    if (trimmed === "1970-01-01T00:00:00.000Z") {
      return { valid: false, error: "Timestamp is missing or invalid sentinel (epoch 0)" };
    }
    const parsed = Date.parse(trimmed);
    if (isNaN(parsed)) {
      return { valid: false, error: `Unparseable date string "${val}"` };
    }
    if (parsed === 0) {
      return { valid: false, error: "Timestamp is missing or invalid sentinel (epoch 0)" };
    }
    return { valid: true, date: new Date(parsed) };
  }

  return { valid: false, error: "Timestamp is missing or not a Date/string" };
}

export const freshnessRule: PolicyRule<FreshnessRuleInput> = {
  key: RULE_KEY_FRESHNESS,
  version: RULE_VERSION_FRESHNESS,
  evaluate(input: FreshnessRuleInput, context: PolicyRuleContext): RuleResult {
    const { evidence, maxAgeMs, candidateId, requiredAttributes } = input ?? {};
    const now = context?.now;

    // 1. Evaluation timestamp validation
    if (!(now instanceof Date) || isNaN(now.getTime())) {
      return {
        ruleKey: RULE_KEY_FRESHNESS,
        ruleVersion: RULE_VERSION_FRESHNESS,
        outcome: "unknown",
        explanation: {
          observed: now,
          expected: "Valid Date instance for evaluation timestamp",
          reason: "Evaluation timestamp context.now is missing or invalid.",
        },
      };
    }

    // 2. Freshness threshold validation (no silent defaulting)
    if (typeof maxAgeMs !== "number" || !Number.isInteger(maxAgeMs) || maxAgeMs <= 0) {
      return {
        ruleKey: RULE_KEY_FRESHNESS,
        ruleVersion: RULE_VERSION_FRESHNESS,
        outcome: "unknown",
        explanation: {
          observed: maxAgeMs,
          expected: "Positive integer maxAgeMs in milliseconds (explicit caller configuration)",
          reason: "Freshness threshold is missing, non-integer, or <= 0. Production threshold remains an unresolved owner decision and must not be defaulted.",
        },
      };
    }

    // 3. Evidence collection validation
    if (!Array.isArray(evidence)) {
      return {
        ruleKey: RULE_KEY_FRESHNESS,
        ruleVersion: RULE_VERSION_FRESHNESS,
        outcome: "unknown",
        explanation: {
          observed: evidence,
          expected: "Array of evidence items",
          reason: "Evidence collection is missing or not an array.",
        },
      };
    }

    let items = evidence as EvidenceItemInput[];

    // If candidateId is provided, filter strictly to evidence belonging to the selected candidate
    if (typeof candidateId === "string" && candidateId.trim().length > 0) {
      items = items.filter((item) => item && item.candidateId === candidateId);
    }

    // If requiredAttributes are specified, verify that all evidence required to support the purchase is present
    if (Array.isArray(requiredAttributes) && requiredAttributes.length > 0) {
      for (const rawReq of requiredAttributes) {
        const parsed = parseRequirementSpec(rawReq);
        if (parsed) {
          const hasEvidenceForReq = items.some((item) => item.requirementKey === parsed.key);
          if (!hasEvidenceForReq) {
            return {
              ruleKey: RULE_KEY_FRESHNESS,
              ruleVersion: RULE_VERSION_FRESHNESS,
              outcome: "unknown",
              explanation: {
                observed: { missingRequirementKey: parsed.key },
                expected: `Fresh evidence present for all required attributes`,
                reason: `Missing evidence for required attribute "${parsed.key}"; freshness of all required evidence cannot be verified.`,
              },
            };
          }
        }
      }
    }

    if (items.length === 0) {
      return {
        ruleKey: RULE_KEY_FRESHNESS,
        ruleVersion: RULE_VERSION_FRESHNESS,
        outcome: "pass",
        explanation: {
          observed: [],
          expected: `Evidence age <= ${maxAgeMs}ms`,
          reason: "No evidence items to evaluate freshness against.",
        },
      };
    }

    const nowTime = now.getTime();
    let hasStale = false;
    const staleItems: { id?: string; ageMs: number }[] = [];

    for (const item of items) {
      if (item.status === "missing") {
        return {
          ruleKey: RULE_KEY_FRESHNESS,
          ruleVersion: RULE_VERSION_FRESHNESS,
          outcome: "unknown",
          explanation: {
            observed: { id: item.id, status: item.status },
            expected: "Evidence asserting observation",
            reason: `Evidence item ${item.id ?? "unknown"} has status "missing"; freshness of missing evidence cannot be established.`,
          },
        };
      }

      const parsed = parseCapturedAt(item.capturedAt);
      if (!parsed.valid || !parsed.date) {
        return {
          ruleKey: RULE_KEY_FRESHNESS,
          ruleVersion: RULE_VERSION_FRESHNESS,
          outcome: "unknown",
          explanation: {
            observed: item.capturedAt,
            expected: "Valid ISO 8601 date string or Date instance",
            reason: `Evidence item ${item.id ?? "unknown"} has missing or invalid capturedAt timestamp: ${parsed.error}.`,
          },
        };
      }

      const capturedTime = parsed.date.getTime();

      // Check for future timestamps: future evidence timestamps cannot pass
      if (capturedTime > nowTime) {
        return {
          ruleKey: RULE_KEY_FRESHNESS,
          ruleVersion: RULE_VERSION_FRESHNESS,
          outcome: "unknown",
          explanation: {
            observed: { capturedAt: parsed.date.toISOString(), now: now.toISOString() },
            expected: `capturedAt <= now (${now.toISOString()})`,
            reason: `Evidence item ${item.id ?? "unknown"} has a future timestamp (${parsed.date.toISOString()} > ${now.toISOString()}). Freshness cannot be established.`,
          },
        };
      }

      const ageMs = nowTime - capturedTime;

      // Boundary condition: ageMs <= maxAgeMs passes; ageMs > maxAgeMs is definitively stale
      if (ageMs > maxAgeMs) {
        hasStale = true;
        staleItems.push({ id: item.id, ageMs });
      }
    }

    if (hasStale) {
      return {
        ruleKey: RULE_KEY_FRESHNESS,
        ruleVersion: RULE_VERSION_FRESHNESS,
        outcome: "block",
        explanation: {
          observed: staleItems,
          expected: `All evidence ageMs <= ${maxAgeMs}ms`,
          reason: `Evidence items exceed maximum allowed age threshold of ${maxAgeMs}ms: ${staleItems.map((s) => `${s.id ?? "item"}(${s.ageMs}ms)`).join(", ")}.`,
        },
      };
    }

    return {
      ruleKey: RULE_KEY_FRESHNESS,
      ruleVersion: RULE_VERSION_FRESHNESS,
      outcome: "pass",
      explanation: {
        observed: { totalEvaluated: items.length, maxAgeMs },
        expected: `All evidence ageMs <= ${maxAgeMs}ms`,
        reason: `All evaluated candidate evidence items are within the configured freshness threshold of ${maxAgeMs}ms.`,
      },
    };
  },
};
