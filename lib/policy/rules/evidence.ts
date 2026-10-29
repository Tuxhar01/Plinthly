import { EvidenceItemInput, EvidenceRuleInput, PolicyRule, RuleResult } from "../types";
import { areSpecificationsEquivalent, canonicalizeSpecification } from "./specification";
export { areSpecificationsEquivalent, canonicalizeSpecification };

export const RULE_KEY_EVIDENCE = "P-EVIDENCE";
export const RULE_VERSION_EVIDENCE = "1.0.0";

export interface ParsedRequirement {
  key: string;
  expectedValue?: string;
}

export interface AttributeEvaluation {
  attributeKey: string;
  expectedValue?: string;
  outcome: "pass" | "block" | "unknown";
  reason: string;
  evidenceIds: string[];
}

/**
 * Normalizes and parses requirement specifications:
 * Supports:
 * - "color" -> { key: "color" }
 * - "color:blue" or "color=blue" -> { key: "color", expectedValue: "blue" }
 * - { key: "color", expectedValue: "blue" } -> { key: "color", expectedValue: "blue" }
 * - { key: "color", value: "blue" } -> { key: "color", expectedValue: "blue" }
 * - { requirementKey: "color", expectedValue: "blue" } -> { key: "color", expectedValue: "blue" }
 */
export function parseRequirementSpec(raw: unknown): ParsedRequirement | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    if (trimmed.includes("=")) {
      const parts = trimmed.split("=");
      const key = parts[0].trim();
      const val = parts.slice(1).join("=").trim();
      return key.length > 0 ? { key, expectedValue: val.length > 0 ? val : undefined } : null;
    }

    if (trimmed.includes(":") && !trimmed.startsWith("http")) {
      const parts = trimmed.split(":");
      const key = parts[0].trim();
      const val = parts.slice(1).join(":").trim();
      return key.length > 0 ? { key, expectedValue: val.length > 0 ? val : undefined } : null;
    }

    return { key: trimmed };
  }

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const rawKey = obj.key ?? obj.requirementKey ?? obj.attributeKey;
    if (typeof rawKey !== "string" || rawKey.trim().length === 0) {
      return null;
    }

    const key = rawKey.trim();
    const rawVal = obj.expectedValue ?? obj.value;
    const expectedValue = typeof rawVal === "string" && rawVal.trim().length > 0 ? rawVal.trim() : undefined;

    return { key, expectedValue };
  }

  return null;
}

export const evidenceRule: PolicyRule<EvidenceRuleInput> = {
  key: RULE_KEY_EVIDENCE,
  version: RULE_VERSION_EVIDENCE,
  evaluate(input: EvidenceRuleInput): RuleResult {
    const { candidateId, requiredAttributes, evidence } = input ?? {};

    if (typeof candidateId !== "string" || candidateId.trim().length === 0) {
      return {
        ruleKey: RULE_KEY_EVIDENCE,
        ruleVersion: RULE_VERSION_EVIDENCE,
        outcome: "unknown",
        explanation: {
          observed: candidateId,
          expected: "Non-empty candidateId string",
          reason: "Candidate identifier is missing or invalid.",
        },
      };
    }

    if (!Array.isArray(requiredAttributes)) {
      return {
        ruleKey: RULE_KEY_EVIDENCE,
        ruleVersion: RULE_VERSION_EVIDENCE,
        outcome: "unknown",
        explanation: {
          observed: requiredAttributes,
          expected: "Array of required attribute specifications",
          reason: "Confirmed required attributes set is missing or not an array.",
        },
      };
    }

    // Parse and validate each requirement
    const parsedRequirements: ParsedRequirement[] = [];
    for (const attr of requiredAttributes) {
      const parsed = parseRequirementSpec(attr);
      if (!parsed) {
        return {
          ruleKey: RULE_KEY_EVIDENCE,
          ruleVersion: RULE_VERSION_EVIDENCE,
          outcome: "unknown",
          explanation: {
            observed: attr,
            expected: "Valid requirement specification (string key or object with key/expectedValue)",
            reason: `Invalid required attribute specification: "${JSON.stringify(attr)}".`,
          },
        };
      }
      parsedRequirements.push(parsed);
    }

    if (parsedRequirements.length === 0) {
      return {
        ruleKey: RULE_KEY_EVIDENCE,
        ruleVersion: RULE_VERSION_EVIDENCE,
        outcome: "pass",
        explanation: {
          observed: [],
          expected: "Valid requirement set with zero required attributes",
          reason: "Confirmed requirements set explicitly specifies zero required attributes.",
        },
      };
    }

    if (!Array.isArray(evidence)) {
      return {
        ruleKey: RULE_KEY_EVIDENCE,
        ruleVersion: RULE_VERSION_EVIDENCE,
        outcome: "unknown",
        explanation: {
          observed: evidence,
          expected: "Array of EvidenceItem objects",
          reason: "Evidence collection is missing or not an array.",
        },
      };
    }

    const items = evidence as EvidenceItemInput[];
    const attributeEvaluations: AttributeEvaluation[] = [];

    for (const req of parsedRequirements) {
      // Strictly filter evidence: must belong to the selected candidate and match requirementKey
      const matchingItems = items.filter(
        (item) =>
          item &&
          item.candidateId === candidateId &&
          item.requirementKey === req.key
      );

      if (matchingItems.length === 0) {
        attributeEvaluations.push({
          attributeKey: req.key,
          expectedValue: req.expectedValue,
          outcome: "unknown",
          reason: `No evidence found for candidate ${candidateId} matching requirement "${req.key}".`,
          evidenceIds: [],
        });
        continue;
      }

      // Check for explicit contradiction
      const hasContradiction = matchingItems.some((item) => item.status === "contradicts");
      if (hasContradiction) {
        attributeEvaluations.push({
          attributeKey: req.key,
          expectedValue: req.expectedValue,
          outcome: "block",
          reason: `Evidence explicitly contradicts required attribute "${req.key}".`,
          evidenceIds: matchingItems.map((m) => m.id ?? "unknown"),
        });
        continue;
      }

      // Filter to items asserting support
      const supportingItems = matchingItems.filter((item) => item.status === "supports");
      if (supportingItems.length === 0) {
        attributeEvaluations.push({
          attributeKey: req.key,
          expectedValue: req.expectedValue,
          outcome: "unknown",
          reason: `No supporting evidence found for required attribute "${req.key}" (observed statuses: ${matchingItems.map((m) => m.status).join(", ")}).`,
          evidenceIds: matchingItems.map((m) => m.id ?? "unknown"),
        });
        continue;
      }

      // Check for presence of unresolvable non-supporting items (conflicting evidence without contradiction)
      const nonSupporting = matchingItems.filter((item) => item.status !== "supports");
      if (nonSupporting.length > 0) {
        attributeEvaluations.push({
          attributeKey: req.key,
          expectedValue: req.expectedValue,
          outcome: "unknown",
          reason: `Conflicting evidence statuses for required attribute "${req.key}" (mixture of supports and ${nonSupporting.map((n) => n.status).join(", ")}).`,
          evidenceIds: matchingItems.map((m) => m.id ?? "unknown"),
        });
        continue;
      }

      // Validate evidence value sufficiency and semantic match
      let semanticBlockReason: string | null = null;
      let semanticUnknownReason: string | null = null;
      const observedValues = new Set<string>();

      for (const item of supportingItems) {
        if (typeof item.value === "string" && item.value.trim().length === 0) {
          semanticUnknownReason = `Evidence item ${item.id ?? "unknown"} has empty or whitespace value; insufficient to establish support.`;
          continue;
        }

        if (item.value !== undefined && typeof item.value === "string") {
          const itemVal = item.value.trim();
          const canonical = canonicalizeSpecification(req.key, itemVal);
          observedValues.add(canonical.canonicalValue);

          // If an expected value is specified in the requirement, compare it semantically
          if (req.expectedValue !== undefined) {
            const matches = areSpecificationsEquivalent(req.key, req.expectedValue, itemVal);

            if (!matches) {
              semanticBlockReason = `Evidence value "${itemVal}" does not match required value "${req.expectedValue}".`;
            }
          }
        } else if (req.expectedValue !== undefined) {
          // Expected value is specified, but evidence item lacks a value to compare
          semanticUnknownReason = `Evidence item ${item.id ?? "unknown"} lacks a value to compare against required value "${req.expectedValue}".`;
        }
      }

      if (semanticBlockReason) {
        attributeEvaluations.push({
          attributeKey: req.key,
          expectedValue: req.expectedValue,
          outcome: "block",
          reason: semanticBlockReason,
          evidenceIds: supportingItems.map((m) => m.id ?? "unknown"),
        });
        continue;
      }

      // If multiple distinct evidence values contradict each other (e.g. "ANSI" and "ISO")
      if (observedValues.size > 1) {
        attributeEvaluations.push({
          attributeKey: req.key,
          expectedValue: req.expectedValue,
          outcome: "unknown",
          reason: `Conflicting evidence values found for required attribute "${req.key}": ${Array.from(observedValues).join(", ")}.`,
          evidenceIds: supportingItems.map((m) => m.id ?? "unknown"),
        });
        continue;
      }

      if (semanticUnknownReason) {
        attributeEvaluations.push({
          attributeKey: req.key,
          expectedValue: req.expectedValue,
          outcome: "unknown",
          reason: semanticUnknownReason,
          evidenceIds: supportingItems.map((m) => m.id ?? "unknown"),
        });
        continue;
      }

      // All supporting items have sufficient values matching any expected value
      attributeEvaluations.push({
        attributeKey: req.key,
        expectedValue: req.expectedValue,
        outcome: "pass",
        reason: observedValues.size > 0
          ? `Evidence supports required attribute "${req.key}" with value "${Array.from(observedValues)[0]}".`
          : `Evidence supports required attribute "${req.key}".`,
        evidenceIds: supportingItems.map((m) => m.id ?? "unknown"),
      });
    }

    // Aggregate attribute evaluations
    const blocking = attributeEvaluations.filter((a) => a.outcome === "block");
    if (blocking.length > 0) {
      return {
        ruleKey: RULE_KEY_EVIDENCE,
        ruleVersion: RULE_VERSION_EVIDENCE,
        outcome: "block",
        explanation: {
          observed: attributeEvaluations,
          expected: "All required attributes supported by valid candidate evidence",
          reason: `Evidence contradicts required attribute(s): ${blocking.map((b) => `${b.attributeKey} (${b.reason})`).join("; ")}.`,
        },
      };
    }

    const unknown = attributeEvaluations.filter((a) => a.outcome === "unknown");
    if (unknown.length > 0) {
      return {
        ruleKey: RULE_KEY_EVIDENCE,
        ruleVersion: RULE_VERSION_EVIDENCE,
        outcome: "unknown",
        explanation: {
          observed: attributeEvaluations,
          expected: "All required attributes supported by valid candidate evidence",
          reason: `Evidence missing, insufficient, or unresolved for required attribute(s): ${unknown.map((u) => u.attributeKey).join(", ")}.`,
        },
      };
    }

    return {
      ruleKey: RULE_KEY_EVIDENCE,
      ruleVersion: RULE_VERSION_EVIDENCE,
      outcome: "pass",
      explanation: {
        observed: attributeEvaluations,
        expected: "All required attributes supported by valid candidate evidence",
        reason: "All confirmed required attributes are supported by valid candidate evidence.",
      },
    };
  },
};
