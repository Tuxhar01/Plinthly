import { describe, expect, it } from "vitest";
import { budgetRule, RULE_KEY_BUDGET, RULE_VERSION_BUDGET } from "../../lib/policy/rules/budget";
import { currencyRule, RULE_KEY_CURRENCY, RULE_VERSION_CURRENCY } from "../../lib/policy/rules/currency";
import { quantityRule, RULE_KEY_QUANTITY, RULE_VERSION_QUANTITY } from "../../lib/policy/rules/quantity";
import { evidenceRule, RULE_KEY_EVIDENCE, RULE_VERSION_EVIDENCE } from "../../lib/policy/rules/evidence";
import { availabilityRule, RULE_KEY_AVAILABILITY, RULE_VERSION_AVAILABILITY } from "../../lib/policy/rules/availability";
import { vendorRule, RULE_KEY_VENDOR, RULE_VERSION_VENDOR } from "../../lib/policy/rules/vendor";
import { freshnessRule, RULE_KEY_FRESHNESS, RULE_VERSION_FRESHNESS } from "../../lib/policy/rules/freshness";
import { duplicateRule, RULE_KEY_DUPLICATE, RULE_VERSION_DUPLICATE, TWENTY_FOUR_HOURS_MS } from "../../lib/policy/rules/duplicate";

const FIXED_NOW = new Date("2026-10-20T12:00:00.000Z");
const CONTEXT = { now: FIXED_NOW };

describe("P-BUDGET: Total within budget", () => {
  it("passes when candidate total is strictly less than budget", () => {
    const res = budgetRule.evaluate({ candidateTotalCents: 4500, budgetCents: 5000 }, CONTEXT);
    expect(res.outcome).toBe("pass");
    expect(res.ruleKey).toBe(RULE_KEY_BUDGET);
    expect(res.ruleVersion).toBe(RULE_VERSION_BUDGET);
  });

  it("passes when candidate total is exactly equal to budget", () => {
    const res = budgetRule.evaluate({ candidateTotalCents: 5000, budgetCents: 5000 }, CONTEXT);
    expect(res.outcome).toBe("pass");
  });

  it("blocks when candidate total is one cent above budget", () => {
    const res = budgetRule.evaluate({ candidateTotalCents: 5001, budgetCents: 5000 }, CONTEXT);
    expect(res.outcome).toBe("block");
    expect(res.explanation.reason).toContain("exceeds the confirmed budget");
  });

  it("returns unknown when candidate total is missing, negative, or non-integer", () => {
    expect(budgetRule.evaluate({ candidateTotalCents: undefined, budgetCents: 5000 }, CONTEXT).outcome).toBe("unknown");
    expect(budgetRule.evaluate({ candidateTotalCents: -100, budgetCents: 5000 }, CONTEXT).outcome).toBe("unknown");
    expect(budgetRule.evaluate({ candidateTotalCents: 49.99, budgetCents: 5000 }, CONTEXT).outcome).toBe("unknown");
  });

  it("returns unknown when purchase budget is missing, negative, or non-integer", () => {
    expect(budgetRule.evaluate({ candidateTotalCents: 5000, budgetCents: undefined }, CONTEXT).outcome).toBe("unknown");
    expect(budgetRule.evaluate({ candidateTotalCents: 5000, budgetCents: -1 }, CONTEXT).outcome).toBe("unknown");
    expect(budgetRule.evaluate({ candidateTotalCents: 5000, budgetCents: "5000" as unknown as number }, CONTEXT).outcome).toBe("unknown");
  });

  it("handles MAX_CENTS boundary condition", () => {
    const MAX_CENTS = 2147483647;
    expect(budgetRule.evaluate({ candidateTotalCents: MAX_CENTS, budgetCents: MAX_CENTS }, CONTEXT).outcome).toBe("pass");
    expect(budgetRule.evaluate({ candidateTotalCents: MAX_CENTS + 1, budgetCents: MAX_CENTS }, CONTEXT).outcome).toBe("unknown");
  });

  it("is deterministic: identical inputs produce identical outputs", () => {
    const input = { candidateTotalCents: 4500, budgetCents: 5000 };
    const r1 = budgetRule.evaluate(input, CONTEXT);
    const r2 = budgetRule.evaluate(input, CONTEXT);
    expect(r1).toEqual(r2);
  });
});

describe("P-CURRENCY: Supported currency", () => {
  it("passes when both candidate and purchase use USD", () => {
    const res = currencyRule.evaluate({ candidateCurrency: "USD", purchaseCurrency: "USD" }, CONTEXT);
    expect(res.outcome).toBe("pass");
    expect(res.ruleKey).toBe(RULE_KEY_CURRENCY);
    expect(res.ruleVersion).toBe(RULE_VERSION_CURRENCY);
  });

  it("blocks when a known, valid currency differs from USD", () => {
    expect(currencyRule.evaluate({ candidateCurrency: "EUR", purchaseCurrency: "USD" }, CONTEXT).outcome).toBe("block");
    expect(currencyRule.evaluate({ candidateCurrency: "USD", purchaseCurrency: "GBP" }, CONTEXT).outcome).toBe("block");
    expect(currencyRule.evaluate({ candidateCurrency: "CAD", purchaseCurrency: "CAD" }, CONTEXT).outcome).toBe("block");
  });

  it("returns unknown when currency is missing, empty, or unparseable", () => {
    expect(currencyRule.evaluate({ candidateCurrency: "", purchaseCurrency: "USD" }, CONTEXT).outcome).toBe("unknown");
    expect(currencyRule.evaluate({ candidateCurrency: "USD", purchaseCurrency: undefined }, CONTEXT).outcome).toBe("unknown");
    expect(currencyRule.evaluate({ candidateCurrency: "US", purchaseCurrency: "USD" }, CONTEXT).outcome).toBe("unknown");
    expect(currencyRule.evaluate({ candidateCurrency: "DOLLARS", purchaseCurrency: "USD" }, CONTEXT).outcome).toBe("unknown");
  });

  it("is deterministic", () => {
    const input = { candidateCurrency: "USD", purchaseCurrency: "USD" };
    expect(currencyRule.evaluate(input, CONTEXT)).toEqual(currencyRule.evaluate(input, CONTEXT));
  });
});

describe("P-QUANTITY: Requested quantity", () => {
  it("passes on exact quantity match", () => {
    const res = quantityRule.evaluate({ candidateQuantity: 2, requestedQuantity: 2 }, CONTEXT);
    expect(res.outcome).toBe("pass");
    expect(res.ruleKey).toBe(RULE_KEY_QUANTITY);
    expect(res.ruleVersion).toBe(RULE_VERSION_QUANTITY);
  });

  it("blocks on quantity mismatch", () => {
    const res = quantityRule.evaluate({ candidateQuantity: 3, requestedQuantity: 2 }, CONTEXT);
    expect(res.outcome).toBe("block");
    expect(res.explanation.reason).toContain("does not match");
  });

  it("returns unknown if either value is absent or non-positive integer", () => {
    expect(quantityRule.evaluate({ candidateQuantity: 0, requestedQuantity: 2 }, CONTEXT).outcome).toBe("unknown");
    expect(quantityRule.evaluate({ candidateQuantity: -1, requestedQuantity: 2 }, CONTEXT).outcome).toBe("unknown");
    expect(quantityRule.evaluate({ candidateQuantity: 1.5, requestedQuantity: 2 }, CONTEXT).outcome).toBe("unknown");
    expect(quantityRule.evaluate({ candidateQuantity: undefined, requestedQuantity: 2 }, CONTEXT).outcome).toBe("unknown");
    expect(quantityRule.evaluate({ candidateQuantity: 2, requestedQuantity: null as unknown as number }, CONTEXT).outcome).toBe("unknown");
  });

  it("is deterministic", () => {
    const input = { candidateQuantity: 5, requestedQuantity: 5 };
    expect(quantityRule.evaluate(input, CONTEXT)).toEqual(quantityRule.evaluate(input, CONTEXT));
  });
});

describe("P-EVIDENCE: Required attributes supported", () => {
  const candidateId = "cand-123";

  it("passes when all required attributes are supported by matching candidate evidence", () => {
    const res = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: ["color", "size"],
        evidence: [
          { candidateId, requirementKey: "color", status: "supports" },
          { candidateId, requirementKey: "size", status: "supports" },
        ],
      },
      CONTEXT
    );
    expect(res.outcome).toBe("pass");
    expect(res.ruleKey).toBe(RULE_KEY_EVIDENCE);
    expect(res.ruleVersion).toBe(RULE_VERSION_EVIDENCE);
  });

  it("passes when confirmed requirements set explicitly specifies zero required attributes", () => {
    const res = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: [],
        evidence: [],
      },
      CONTEXT
    );
    expect(res.outcome).toBe("pass");
  });

  it("blocks when evidence explicitly contradicts a required attribute", () => {
    const res = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: ["color", "size"],
        evidence: [
          { candidateId, requirementKey: "color", status: "supports" },
          { candidateId, requirementKey: "size", status: "contradicts" },
        ],
      },
      CONTEXT
    );
    expect(res.outcome).toBe("block");
    expect(res.explanation.reason).toContain("contradicts required attribute");
  });

  it("returns unknown when required evidence is missing or absent", () => {
    const res = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: ["color", "warranty"],
        evidence: [{ candidateId, requirementKey: "color", status: "supports" }],
      },
      CONTEXT
    );
    expect(res.outcome).toBe("unknown");
    expect(res.explanation.reason).toContain("warranty");
  });

  it("evidence from a different candidate cannot satisfy a requirement", () => {
    const res = evidenceRule.evaluate(
      {
        candidateId: "cand-target",
        requiredAttributes: ["color"],
        evidence: [
          { candidateId: "cand-OTHER", requirementKey: "color", status: "supports" },
        ],
      },
      CONTEXT
    );
    expect(res.outcome).toBe("unknown");
    expect((res.explanation.observed as Array<{ reason: string }>)[0].reason).toContain("No evidence found for candidate cand-target");
  });

  it("conflicting evidence with contradiction blocks", () => {
    const res = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: ["color"],
        evidence: [
          { candidateId, requirementKey: "color", status: "supports" },
          { candidateId, requirementKey: "color", status: "contradicts" },
        ],
      },
      CONTEXT
    );
    expect(res.outcome).toBe("block");
  });

  it("conflicting evidence without contradiction yields unknown", () => {
    const res = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: ["color"],
        evidence: [
          { candidateId, requirementKey: "color", status: "supports" },
          { candidateId, requirementKey: "color", status: "missing" },
        ],
      },
      CONTEXT
    );
    expect(res.outcome).toBe("unknown");
  });

  it("passes when evidence value semantically matches expected value", () => {
    const res = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: [{ key: "color", expectedValue: "blue" }],
        evidence: [{ candidateId, requirementKey: "color", status: "supports", value: "  Blue  " }],
      },
      CONTEXT
    );
    expect(res.outcome).toBe("pass");
  });

  it("blocks when evidence value semantically contradicts expected value", () => {
    const res = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: [{ key: "color", expectedValue: "blue" }],
        evidence: [{ candidateId, requirementKey: "color", status: "supports", value: "red" }],
      },
      CONTEXT
    );
    expect(res.outcome).toBe("block");
    expect(res.explanation.reason).toContain('does not match required value "blue"');
  });

  it("returns unknown when supporting evidence has empty or whitespace value (insufficient evidence)", () => {
    const res = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: ["warranty"],
        evidence: [{ candidateId, requirementKey: "warranty", status: "supports", value: "   " }],
      },
      CONTEXT
    );
    expect(res.outcome).toBe("unknown");
    expect((res.explanation.observed as Array<{ reason: string }>)[0].reason).toContain("insufficient to establish support");
  });

  it("returns unknown when multiple supporting evidence items have conflicting values for the same attribute", () => {
    const res = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: ["layout"],
        evidence: [
          { candidateId, requirementKey: "layout", status: "supports", value: "ANSI" },
          { candidateId, requirementKey: "layout", status: "supports", value: "ISO" },
        ],
      },
      CONTEXT
    );
    expect(res.outcome).toBe("unknown");
    expect((res.explanation.observed as Array<{ reason: string }>)[0].reason).toContain("Conflicting evidence values found");
  });

  it("evidence with incorrect requirement key cannot satisfy requirement", () => {
    const res = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: ["color"],
        evidence: [{ candidateId, requirementKey: "size", status: "supports", value: "M" }],
      },
      CONTEXT
    );
    expect(res.outcome).toBe("unknown");
    expect((res.explanation.observed as Array<{ reason: string }>)[0].reason).toContain('No evidence found for candidate cand-123 matching requirement "color"');
  });

  it("returns unknown on missing candidateId or invalid requiredAttributes", () => {
    expect(evidenceRule.evaluate({ candidateId: "", requiredAttributes: [], evidence: [] }, CONTEXT).outcome).toBe("unknown");
    expect(evidenceRule.evaluate({ candidateId, requiredAttributes: null as unknown as string[], evidence: [] }, CONTEXT).outcome).toBe("unknown");
    expect(evidenceRule.evaluate({ candidateId, requiredAttributes: ["valid", ""], evidence: [] }, CONTEXT).outcome).toBe("unknown");
  });

  it("is deterministic", () => {
    const input = {
      candidateId,
      requiredAttributes: ["color"],
      evidence: [{ candidateId, requirementKey: "color", status: "supports" }],
    };
    expect(evidenceRule.evaluate(input, CONTEXT)).toEqual(evidenceRule.evaluate(input, CONTEXT));
  });
});

describe("P-AVAILABILITY: In stock", () => {
  it("passes when authoritative candidate data explicitly confirms in_stock", () => {
    const res = availabilityRule.evaluate({ availability: "in_stock" }, CONTEXT);
    expect(res.outcome).toBe("pass");
    expect(res.ruleKey).toBe(RULE_KEY_AVAILABILITY);
    expect(res.ruleVersion).toBe(RULE_VERSION_AVAILABILITY);
  });

  it("blocks when authoritative data explicitly confirms out_of_stock", () => {
    const res = availabilityRule.evaluate({ availability: "out_of_stock" }, CONTEXT);
    expect(res.outcome).toBe("block");
  });

  it("returns unknown for missing, empty, or ambiguous availability", () => {
    expect(availabilityRule.evaluate({ availability: undefined }, CONTEXT).outcome).toBe("unknown");
    expect(availabilityRule.evaluate({ availability: "" }, CONTEXT).outcome).toBe("unknown");
    expect(availabilityRule.evaluate({ availability: "preorder" }, CONTEXT).outcome).toBe("unknown");
    expect(availabilityRule.evaluate({ availability: "backordered" }, CONTEXT).outcome).toBe("unknown");
    expect(availabilityRule.evaluate({ availability: "limited" }, CONTEXT).outcome).toBe("unknown");
  });

  it("is deterministic", () => {
    expect(availabilityRule.evaluate({ availability: "in_stock" }, CONTEXT)).toEqual(
      availabilityRule.evaluate({ availability: "in_stock" }, CONTEXT)
    );
  });
});

describe("P-VENDOR: Vendor allow-list", () => {
  const allowList = ["Acme Supplies", "Global Goods Inc"];

  it("passes when merchant is on caller-supplied allow-list", () => {
    const res = vendorRule.evaluate({ merchantName: "Acme Supplies", allowList }, CONTEXT);
    expect(res.outcome).toBe("pass");
    expect(res.ruleKey).toBe(RULE_KEY_VENDOR);
    expect(res.ruleVersion).toBe(RULE_VERSION_VENDOR);
  });

  it("passes with normalized case and whitespace", () => {
    const res = vendorRule.evaluate({ merchantName: "  acme supplies  ", allowList }, CONTEXT);
    expect(res.outcome).toBe("pass");
  });

  it("blocks when known merchant is not on allow-list", () => {
    const res = vendorRule.evaluate({ merchantName: "Rogue Vendor", allowList }, CONTEXT);
    expect(res.outcome).toBe("block");
  });

  it("does not perform fuzzy matching that could authorize an unapproved merchant", () => {
    // Substring or prefix should NOT match
    expect(vendorRule.evaluate({ merchantName: "Acme", allowList }, CONTEXT).outcome).toBe("block");
    expect(vendorRule.evaluate({ merchantName: "Acme Supplies Extra", allowList }, CONTEXT).outcome).toBe("block");
  });

  it("a missing or empty vendor allow-list cannot authorize a merchant (returns unknown)", () => {
    expect(vendorRule.evaluate({ merchantName: "Acme Supplies", allowList: undefined }, CONTEXT).outcome).toBe("unknown");
    expect(vendorRule.evaluate({ merchantName: "Acme Supplies", allowList: [] }, CONTEXT).outcome).toBe("unknown");
    expect(vendorRule.evaluate({ merchantName: "Acme Supplies", allowList: [""] }, CONTEXT).outcome).toBe("unknown");
  });

  it("returns unknown when merchant name is missing or empty", () => {
    expect(vendorRule.evaluate({ merchantName: "", allowList }, CONTEXT).outcome).toBe("unknown");
    expect(vendorRule.evaluate({ merchantName: undefined, allowList }, CONTEXT).outcome).toBe("unknown");
  });

  it("is deterministic", () => {
    const input = { merchantName: "Acme Supplies", allowList };
    expect(vendorRule.evaluate(input, CONTEXT)).toEqual(vendorRule.evaluate(input, CONTEXT));
  });
});

describe("P-FRESHNESS: Evidence freshness", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const ctx = { now };
  const maxAgeMs = 3600 * 1000; // 1 hour

  it("passes when evidence age is within configured threshold", () => {
    const capturedAt = new Date(now.getTime() - 1800 * 1000); // 30 minutes ago
    const res = freshnessRule.evaluate(
      {
        evidence: [{ id: "ev-1", candidateId: "c1", requirementKey: "k1", status: "supports", capturedAt }],
        maxAgeMs,
      },
      ctx
    );
    expect(res.outcome).toBe("pass");
    expect(res.ruleKey).toBe(RULE_KEY_FRESHNESS);
    expect(res.ruleVersion).toBe(RULE_VERSION_FRESHNESS);
  });

  it("evidence exactly at the freshness boundary passes", () => {
    const capturedAt = new Date(now.getTime() - maxAgeMs); // exactly 1 hour ago
    const res = freshnessRule.evaluate(
      {
        evidence: [{ id: "ev-boundary", candidateId: "c1", requirementKey: "k1", status: "supports", capturedAt }],
        maxAgeMs,
      },
      ctx
    );
    expect(res.outcome).toBe("pass");
  });

  it("blocks when evidence is definitively older than configured threshold (1ms past boundary)", () => {
    const capturedAt = new Date(now.getTime() - maxAgeMs - 1); // 1 hour + 1ms ago
    const res = freshnessRule.evaluate(
      {
        evidence: [{ id: "ev-stale", candidateId: "c1", requirementKey: "k1", status: "supports", capturedAt }],
        maxAgeMs,
      },
      ctx
    );
    expect(res.outcome).toBe("block");
    expect(res.explanation.reason).toContain("exceed maximum allowed age threshold");
  });

  it("freshness threshold is not silently defaulted (returns unknown when missing or invalid)", () => {
    const capturedAt = new Date(now.getTime() - 1000);
    expect(freshnessRule.evaluate({ evidence: [{ capturedAt }], maxAgeMs: undefined }, ctx).outcome).toBe("unknown");
    expect(freshnessRule.evaluate({ evidence: [{ capturedAt }], maxAgeMs: 0 }, ctx).outcome).toBe("unknown");
    expect(freshnessRule.evaluate({ evidence: [{ capturedAt }], maxAgeMs: -100 }, ctx).outcome).toBe("unknown");
  });

  it("future evidence timestamps do not pass (returns unknown)", () => {
    const futureDate = new Date(now.getTime() + 5000); // 5 seconds in future
    const res = freshnessRule.evaluate(
      {
        evidence: [{ id: "ev-future", candidateId: "c1", requirementKey: "k1", status: "supports", capturedAt: futureDate }],
        maxAgeMs,
      },
      ctx
    );
    expect(res.outcome).toBe("unknown");
    expect(res.explanation.reason).toContain("future timestamp");
  });

  it("returns unknown for invalid/unparseable timestamps", () => {
    const res = freshnessRule.evaluate(
      {
        evidence: [{ id: "ev-corrupt", candidateId: "c1", requirementKey: "k1", status: "supports", capturedAt: "not-a-date" }],
        maxAgeMs,
      },
      ctx
    );
    expect(res.outcome).toBe("unknown");
  });

  it("returns pass when evidence list is empty with valid threshold", () => {
    expect(freshnessRule.evaluate({ evidence: [], maxAgeMs }, ctx).outcome).toBe("pass");
  });

  it("validates freshness of all evidence required to support the purchase", () => {
    const res = freshnessRule.evaluate(
      {
        candidateId: "c1",
        requiredAttributes: ["layout"],
        evidence: [{ id: "ev-1", candidateId: "c1", requirementKey: "layout", status: "supports", capturedAt: new Date(now.getTime() - 1000) }],
        maxAgeMs,
      },
      ctx
    );
    expect(res.outcome).toBe("pass");
  });

  it("returns unknown when a required attribute has no evidence in candidate collection", () => {
    const res = freshnessRule.evaluate(
      {
        candidateId: "c1",
        requiredAttributes: ["layout", "switchType"],
        evidence: [{ id: "ev-1", candidateId: "c1", requirementKey: "layout", status: "supports", capturedAt: new Date(now.getTime() - 1000) }],
        maxAgeMs,
      },
      ctx
    );
    expect(res.outcome).toBe("unknown");
    expect(res.explanation.reason).toContain('Missing evidence for required attribute "switchType"');
  });

  it("only evaluates selected candidate evidence (ignores unrelated candidate evidence)", () => {
    const staleOtherCandidate = new Date(now.getTime() - maxAgeMs - 10000);
    const res = freshnessRule.evaluate(
      {
        candidateId: "c-selected",
        requiredAttributes: ["layout"],
        evidence: [
          { id: "ev-other", candidateId: "c-OTHER", requirementKey: "layout", status: "supports", capturedAt: staleOtherCandidate },
          { id: "ev-sel", candidateId: "c-selected", requirementKey: "layout", status: "supports", capturedAt: new Date(now.getTime() - 1000) },
        ],
        maxAgeMs,
      },
      ctx
    );
    expect(res.outcome).toBe("pass");
  });

  it("is deterministic", () => {
    const input = {
      evidence: [{ capturedAt: new Date(now.getTime() - 1000) }],
      maxAgeMs,
    };
    expect(freshnessRule.evaluate(input, ctx)).toEqual(freshnessRule.evaluate(input, ctx));
  });
});

describe("P-DUPLICATE: Duplicate purchase within 24 hours", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const ctx = { now };
  const targetCandidate = {
    id: "cand-123",
    externalId: "EXT-888",
    merchantName: "Acme Store",
    snapshotHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  };

  it("blocks when identical candidate was purchased inside the preceding 24 hours", () => {
    const purchasedAt = new Date(now.getTime() - 12 * 3600 * 1000); // 12 hours ago
    const res = duplicateRule.evaluate(
      {
        candidate: targetCandidate,
        history: [
          {
            purchaseId: "purch-prev",
            externalId: "EXT-888",
            merchantName: "Acme Store",
            purchasedAt,
          },
        ],
        isHistoryComplete: true,
      },
      ctx
    );
    expect(res.outcome).toBe("block");
    expect(res.ruleKey).toBe(RULE_KEY_DUPLICATE);
    expect(res.ruleVersion).toBe(RULE_VERSION_DUPLICATE);
    expect(res.explanation.reason).toContain("preceding 24 hours");
  });

  it("blocks duplicate by (externalId, merchantName) even when snapshotHash changes", () => {
    const purchasedAt = new Date(now.getTime() - 3600 * 1000); // 1 hour ago
    const res = duplicateRule.evaluate(
      {
        candidate: {
          ...targetCandidate,
          snapshotHash: "new-price-snapshot-hash-00000000000000000000000000000000000000000000000",
        },
        history: [
          {
            purchaseId: "purch-old-hash",
            externalId: "EXT-888",
            merchantName: "Acme Store",
            snapshotHash: "old-price-snapshot-hash-11111111111111111111111111111111111111111111111",
            purchasedAt,
          },
        ],
        isHistoryComplete: true,
      },
      ctx
    );
    expect(res.outcome).toBe("block");
    expect(res.explanation.reason).toContain("preceding 24 hours");
  });

  it("blocks duplicate by (externalId, merchantName) even when local surrogate candidateId changes", () => {
    const purchasedAt = new Date(now.getTime() - 3600 * 1000);
    const res = duplicateRule.evaluate(
      {
        candidate: {
          ...targetCandidate,
          id: "new-purchase-candidate-uuid-999",
        },
        history: [
          {
            purchaseId: "purch-other-uuid",
            candidateId: "old-purchase-candidate-uuid-111",
            externalId: "EXT-888",
            merchantName: "Acme Store",
            purchasedAt,
          },
        ],
        isHistoryComplete: true,
      },
      ctx
    );
    expect(res.outcome).toBe("block");
  });

  it("passes when historical purchase has matching merchant but distinct externalId (different SKU) with complete history", () => {
    const purchasedAt = new Date(now.getTime() - 3600 * 1000);
    const res = duplicateRule.evaluate(
      {
        candidate: targetCandidate,
        history: [
          {
            purchaseId: "purch-diff-sku",
            externalId: "EXT-DIFFERENT-SKU",
            merchantName: "Acme Store",
            purchasedAt,
          },
        ],
        isHistoryComplete: true,
      },
      ctx
    );
    expect(res.outcome).toBe("pass");
  });

  it("returns unknown when historical purchase inside 24h has incomparable identity (lacks externalId while snapshotHash differs)", () => {
    const purchasedAt = new Date(now.getTime() - 3600 * 1000);
    const res = duplicateRule.evaluate(
      {
        candidate: targetCandidate,
        history: [
          {
            purchaseId: "purch-incomparable",
            snapshotHash: "unrelated-diff-hash-22222222222222222222222222222222222222222222222222",
            purchasedAt,
          },
        ],
        isHistoryComplete: true,
      },
      ctx
    );
    expect(res.outcome).toBe("unknown");
    expect(res.explanation.reason).toContain("incompatible or incomplete candidate identity");
  });

  it("blocks duplicate exactly at the 24-hour boundary", () => {
    const purchasedAt = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS); // exactly 24 hours ago
    const res = duplicateRule.evaluate(
      {
        candidate: targetCandidate,
        history: [
          {
            purchaseId: "purch-boundary",
            snapshotHash: targetCandidate.snapshotHash,
            purchasedAt,
          },
        ],
        isHistoryComplete: true,
      },
      ctx
    );
    expect(res.outcome).toBe("block");
  });

  it("passes when purchase was outside 24h interval (24h + 1ms ago) and history is complete", () => {
    const purchasedAt = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS - 1); // 24h + 1ms ago
    const res = duplicateRule.evaluate(
      {
        candidate: targetCandidate,
        history: [
          {
            purchaseId: "purch-older",
            externalId: "EXT-888",
            merchantName: "Acme Store",
            purchasedAt,
          },
        ],
        isHistoryComplete: true,
      },
      ctx
    );
    expect(res.outcome).toBe("pass");
  });

  it("passes when complete history has no matching candidate", () => {
    const res = duplicateRule.evaluate(
      {
        candidate: targetCandidate,
        history: [
          {
            purchaseId: "purch-other",
            externalId: "EXT-OTHER",
            merchantName: "Different Store",
            purchasedAt: new Date(now.getTime() - 3600 * 1000),
          },
        ],
        isHistoryComplete: true,
      },
      ctx
    );
    expect(res.outcome).toBe("pass");
  });

  it("returns unknown when no duplicate found but history is incomplete", () => {
    const res = duplicateRule.evaluate(
      {
        candidate: targetCandidate,
        history: [],
        isHistoryComplete: false,
      },
      ctx
    );
    expect(res.outcome).toBe("unknown");
    expect(res.explanation.reason).toContain("completeness is not verified");
  });

  it("incomplete history still blocks if an authoritative duplicate is found within 24h", () => {
    const res = duplicateRule.evaluate(
      {
        candidate: targetCandidate,
        history: [
          {
            purchaseId: "purch-dup",
            externalId: "EXT-888",
            merchantName: "Acme Store",
            purchasedAt: new Date(now.getTime() - 1000),
          },
        ],
        isHistoryComplete: false, // partial history with concrete duplicate
      },
      ctx
    );
    expect(res.outcome).toBe("block");
  });

  it("returns unknown when candidate lacks stable identity fields (title alone is rejected)", () => {
    const titleOnlyCandidate = { title: "Some Nice Laptop" };
    const res = duplicateRule.evaluate(
      {
        candidate: titleOnlyCandidate,
        history: [],
        isHistoryComplete: true,
      },
      ctx
    );
    expect(res.outcome).toBe("unknown");
    expect(res.explanation.reason).toContain("lacks stable identity fields");
  });

  it("is deterministic", () => {
    const input = {
      candidate: targetCandidate,
      history: [],
      isHistoryComplete: true,
    };
    expect(duplicateRule.evaluate(input, ctx)).toEqual(duplicateRule.evaluate(input, ctx));
  });
});
