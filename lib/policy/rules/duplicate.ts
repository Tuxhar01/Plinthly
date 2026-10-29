import { DuplicateRuleInput, HistoricalPurchaseItem, PolicyRule, PolicyRuleContext, RuleResult } from "../types";

export const RULE_KEY_DUPLICATE = "P-DUPLICATE";
export const RULE_VERSION_DUPLICATE = "1.0.0";

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000; // 86,400,000 ms

export interface CandidateIdentity {
  id?: string;
  externalId?: string;
  merchantName?: string;
  snapshotHash?: string;
}

export type CandidateComparisonResult = "match" | "distinct" | "incomparable";

/**
 * Deterministic candidate identity comparison algorithm:
 *
 * 1. "match" (Definitive duplicate):
 *    - Both target and historical have non-empty snapshotHash, and snapshotHashes match (exact commercial match).
 *    - OR both target and historical have non-empty externalId and non-empty merchantName,
 *      and normalized (merchantName, externalId) match (same product SKU at same merchant,
 *      even if commercial terms/price changed and snapshotHash differs).
 *
 * 2. "distinct" (Definitively different product):
 *    - Both target and historical have valid non-empty (merchantName, externalId),
 *      and either merchantName differs or externalId differs.
 *
 * 3. "incomparable" (Cannot establish identity):
 *    - Historical record lacks externalId/merchantName, or target lacks externalId/merchantName,
 *      and snapshotHashes do not match. Since snapshotHash changes whenever price/terms change,
 *      a differing snapshotHash alone does NOT prove it is a different product when SKU is missing.
 *
 * Note: Database surrogate UUID (`id` / `candidateId`) is explicitly excluded from cross-purchase
 * product identity, as UUIDs are scoped to a single purchase and cannot prove identity across purchases.
 */
export function compareCandidateIdentity(
  target: CandidateIdentity,
  historical: HistoricalPurchaseItem
): CandidateComparisonResult {
  // Check exact snapshot hash match
  const hasSnapshotMatch = Boolean(
    target.snapshotHash &&
    historical.snapshotHash &&
    target.snapshotHash.toLowerCase() === historical.snapshotHash.toLowerCase()
  );

  if (hasSnapshotMatch) {
    return "match";
  }

  // Check merchant-scoped externalId (SKU) match
  const targetHasMerchantSku = Boolean(
    target.externalId && target.merchantName &&
    target.externalId.trim().length > 0 && target.merchantName.trim().length > 0
  );

  const histHasMerchantSku = Boolean(
    historical.externalId && historical.merchantName &&
    historical.externalId.trim().length > 0 && historical.merchantName.trim().length > 0
  );

  if (targetHasMerchantSku && histHasMerchantSku) {
    const targetExt = target.externalId!.trim();
    const targetMerc = target.merchantName!.trim().toLowerCase();
    const histExt = historical.externalId!.trim();
    const histMerc = historical.merchantName!.trim().toLowerCase();

    if (targetMerc === histMerc && targetExt === histExt) {
      return "match";
    }

    // Both have valid merchant SKUs and they differ
    return "distinct";
  }

  // If one or both lack merchant SKU, and snapshotHash did not match:
  // Cannot establish whether they are the same product with changed terms or different products.
  return "incomparable";
}

/**
 * Backward-compatible boolean helper: returns true if definitively matching.
 */
export function isSameCandidate(target: CandidateIdentity, historical: HistoricalPurchaseItem): boolean {
  return compareCandidateIdentity(target, historical) === "match";
}

function parsePurchaseDate(val: unknown): { valid: boolean; date?: Date } {
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? { valid: false } : { valid: true, date: val };
  }
  if (typeof val === "string" && val.trim().length > 0) {
    const t = Date.parse(val);
    return isNaN(t) ? { valid: false } : { valid: true, date: new Date(t) };
  }
  return { valid: false };
}

export const duplicateRule: PolicyRule<DuplicateRuleInput> = {
  key: RULE_KEY_DUPLICATE,
  version: RULE_VERSION_DUPLICATE,
  evaluate(input: DuplicateRuleInput, context: PolicyRuleContext): RuleResult {
    const { candidate, history, isHistoryComplete } = input ?? {};
    const now = context?.now;

    if (!(now instanceof Date) || isNaN(now.getTime())) {
      return {
        ruleKey: RULE_KEY_DUPLICATE,
        ruleVersion: RULE_VERSION_DUPLICATE,
        outcome: "unknown",
        explanation: {
          observed: now,
          expected: "Valid Date instance for evaluation timestamp",
          reason: "Evaluation timestamp context.now is missing or invalid.",
        },
      };
    }

    if (!candidate || typeof candidate !== "object") {
      return {
        ruleKey: RULE_KEY_DUPLICATE,
        ruleVersion: RULE_VERSION_DUPLICATE,
        outcome: "unknown",
        explanation: {
          observed: candidate,
          expected: "Candidate object with identity fields",
          reason: "Candidate object is missing or invalid.",
        },
      };
    }

    const cand = candidate as CandidateIdentity;
    const hasStableIdentity = Boolean(
      (cand.externalId && cand.merchantName && cand.externalId.trim().length > 0 && cand.merchantName.trim().length > 0) ||
      (cand.snapshotHash && cand.snapshotHash.trim().length > 0)
    );

    if (!hasStableIdentity) {
      return {
        ruleKey: RULE_KEY_DUPLICATE,
        ruleVersion: RULE_VERSION_DUPLICATE,
        outcome: "unknown",
        explanation: {
          observed: cand,
          expected: "Candidate with (externalId + merchantName) or snapshotHash",
          reason: "Candidate lacks stable identity fields. Product title or surrogate row ID alone does not establish product identity.",
        },
      };
    }

    if (!Array.isArray(history)) {
      return {
        ruleKey: RULE_KEY_DUPLICATE,
        ruleVersion: RULE_VERSION_DUPLICATE,
        outcome: "unknown",
        explanation: {
          observed: history,
          expected: "Array of historical purchases",
          reason: "Purchase history is missing or not an array.",
        },
      };
    }

    const nowMs = now.getTime();
    const windowStartMs = nowMs - TWENTY_FOUR_HOURS_MS;
    const historyItems = history as HistoricalPurchaseItem[];

    let incomparableItem: { purchaseId: string; reason: string } | null = null;

    // Check each purchase within the 24-hour interval [now - 24h, now]
    for (const item of historyItems) {
      const parsedDate = parsePurchaseDate(item.purchasedAt);
      if (!parsedDate.valid || !parsedDate.date) {
        continue;
      }

      const itemMs = parsedDate.date.getTime();

      // Check if within preceding 24h: [now - 24h, now]
      if (itemMs >= windowStartMs && itemMs <= nowMs) {
        const comparison = compareCandidateIdentity(cand, item);

        if (comparison === "match") {
          return {
            ruleKey: RULE_KEY_DUPLICATE,
            ruleVersion: RULE_VERSION_DUPLICATE,
            outcome: "block",
            explanation: {
              observed: {
                duplicatePurchaseId: item.purchaseId,
                purchasedAt: parsedDate.date.toISOString(),
                evaluatedAt: now.toISOString(),
                windowStart: new Date(windowStartMs).toISOString(),
              },
              expected: "No matching purchase within preceding 24 hours",
              reason: `Identical candidate was purchased within preceding 24 hours (purchaseId: ${item.purchaseId}, at ${parsedDate.date.toISOString()}).`,
            },
          };
        }

        if (comparison === "incomparable" && !incomparableItem) {
          incomparableItem = {
            purchaseId: item.purchaseId,
            reason: "Historical item lacks comparable identity fields (missing externalId/merchantName while snapshotHash differs).",
          };
        }
      }
    }

    // If an item in the 24-hour window was incomparable, we cannot verify absence of duplicate
    if (incomparableItem) {
      return {
        ruleKey: RULE_KEY_DUPLICATE,
        ruleVersion: RULE_VERSION_DUPLICATE,
        outcome: "unknown",
        explanation: {
          observed: incomparableItem,
          expected: "All purchases in 24h window have comparable identity",
          reason: `Historical purchase ${incomparableItem.purchaseId} within preceding 24 hours has incompatible or incomplete candidate identity; cannot verify absence of duplicate purchase.`,
        },
      };
    }

    // All purchases in 24h window are verified distinct.
    // Check history completeness requirement
    if (isHistoryComplete !== true) {
      return {
        ruleKey: RULE_KEY_DUPLICATE,
        ruleVersion: RULE_VERSION_DUPLICATE,
        outcome: "unknown",
        explanation: {
          observed: { isHistoryComplete },
          expected: { isHistoryComplete: true },
          reason: "Purchase history completeness is not verified; cannot guarantee absence of duplicate purchases.",
        },
      };
    }

    return {
      ruleKey: RULE_KEY_DUPLICATE,
      ruleVersion: RULE_VERSION_DUPLICATE,
      outcome: "pass",
      explanation: {
        observed: {
          historyCount: historyItems.length,
          isHistoryComplete: true,
          window: { start: new Date(windowStartMs).toISOString(), end: now.toISOString() },
        },
        expected: "No matching purchase within preceding 24 hours",
        reason: "Authoritative and complete purchase history confirms no duplicate purchase within the preceding 24 hours.",
      },
    };
  },
};
