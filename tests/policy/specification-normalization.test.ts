import { describe, it, expect } from "vitest";
import {
  parseRamCapacity,
  isRamRequirementKey,
  canonicalizeSpecification,
  areSpecificationsEquivalent,
} from "../../lib/policy/rules/specification";
import { evidenceRule } from "../../lib/policy/rules/evidence";
import { ingestCandidateEvidence } from "../../lib/discovery/evidence";
import { evaluatePolicy } from "../../lib/policy/evaluator";
import { computeEvidenceFingerprint } from "../../lib/state/snapshot";
import { transition } from "../../lib/state/transitions";
import { PurchaseState } from "../../lib/state/types";
import { NormalizedProductCandidate } from "../../lib/discovery/types";

describe("Phase 11E.1 — Deterministic Specification Normalization", () => {
  const now = new Date("2026-10-22T12:00:00.000Z");

  // 1. 16 GB matches 16GB
  it("1. 16 GB matches 16GB (whitespace and format variants)", () => {
    expect(isRamRequirementKey("ram")).toBe(true);
    expect(isRamRequirementKey("system_memory")).toBe(true);
    expect(isRamRequirementKey("color")).toBe(false);

    expect(areSpecificationsEquivalent("ram", "16GB", "16 GB")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16 GB", "16GB")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16GB", "16   GB")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16GB", "16-GB")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16GB", "16 Gb")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16GB", "16.0 GB")).toBe(true);
  });

  // 2. 16 gigabytes matches 16GB
  it("2. 16 gigabytes matches 16GB (word unit variants)", () => {
    expect(areSpecificationsEquivalent("ram", "16GB", "16 gigabytes")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16GB", "16 Gigabytes")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16GB", "16 gigabyte")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16 gigabytes", "16GB")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16 gigabytes", "16 GB")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16GB", "16 gigs")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16GB", "16 gig")).toBe(true);
  });

  // 3. Decimal vs Binary capacity units (GB != GiB, 1000MB == 1GB, 1024MiB == 1GiB)
  it("3. distinguishes decimal and binary units and converts to exact common byte counts", () => {
    // 16 GB (16,000,000,000 bytes) does NOT equal 16 GiB (17,179,869,184 bytes)
    expect(areSpecificationsEquivalent("ram", "16GB", "16 GiB")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16 GB", "16 GiB")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16 GiB", "16GB")).toBe(false);

    // Exact binary equivalents
    expect(areSpecificationsEquivalent("ram", "16 GiB", "16GiB")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16 GiB", "16 gibibytes")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16 GiB", "16-GiB")).toBe(true);

    // Common unit conversion to exact bytes: 1000 MB == 1 GB (both 1,000,000,000 bytes)
    expect(areSpecificationsEquivalent("ram", "1000 MB", "1 GB")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "1 GB", "1000 MB")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16000 MB", "16 GB")).toBe(true);

    // Common unit conversion to exact bytes: 1024 MiB == 1 GiB (both 1,073,741,824 bytes)
    expect(areSpecificationsEquivalent("ram", "1024 MiB", "1 GiB")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "1 GiB", "1024 MiB")).toBe(true);
    expect(areSpecificationsEquivalent("ram", "16384 MiB", "16 GiB")).toBe(true);

    // Cross decimal-binary inequality: 1000 MB != 1024 MiB
    expect(areSpecificationsEquivalent("ram", "1000 MB", "1024 MiB")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "1 GB", "1 GiB")).toBe(false);
  });

  // 4. Differing capacities do not match
  it("4. 32 GB does not match 16GB (differing capacities)", () => {
    expect(areSpecificationsEquivalent("ram", "16GB", "32 GB")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", "32GB")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", "8 GB")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", "64 GB")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", "16 MB")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", "16 TB")).toBe(false);
  });

  // 4. Missing values do not match
  it("4. Missing values do not match", () => {
    expect(areSpecificationsEquivalent("ram", "16GB", "")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", "   ")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", null as unknown as string)).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", undefined as unknown as string)).toBe(false);
  });

  // 5. Malformed values do not match
  it("5. Malformed values do not match", () => {
    expect(areSpecificationsEquivalent("ram", "16GB", "abc")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", "16")).toBe(false); // missing unit
    expect(areSpecificationsEquivalent("ram", "16GB", "GB")).toBe(false); // missing number
    expect(areSpecificationsEquivalent("ram", "16GB", "-16GB")).toBe(false); // negative
    expect(areSpecificationsEquivalent("ram", "16GB", "NaN GB")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", "about 16 GB")).toBe(false);
  });

  // 6. Unsupported units do not silently pass
  it("6. Unsupported units do not silently pass", () => {
    expect(areSpecificationsEquivalent("ram", "16GB", "16 inches")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", "16 mhz")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", "16 cores")).toBe(false);
    expect(areSpecificationsEquivalent("ram", "16GB", "16 bananas")).toBe(false);
    expect(parseRamCapacity("16 inches")).toBeNull();
  });

  // 7. Raw evidence and provenance remain preserved
  it("7. Raw evidence and provenance remain preserved during ingestion", () => {
    const candidate: NormalizedProductCandidate = {
      id: "cand_spec_001",
      purchaseId: "pur_spec_001",
      source: "channel3",
      externalId: "EXT-LAPTOP-16",
      title: "Test Laptop 16GB",
      merchantName: "BestBuy",
      merchantUrl: "https://bestbuy.com/laptop",
      unitPriceCents: 99900,
      quantity: 1,
      shippingCents: 0,
      totalCents: 99900,
      currency: "USD",
      availability: "in_stock",
      capturedAt: now,
      snapshotHash: "hash_001",
      rawSourceData: { capturedAt: now.toISOString() },
      isComplete: true,
      validationErrors: [],
    };

    const ingestion = ingestCandidateEvidence({
      candidate,
      requiredAttributes: [{ key: "ram", expectedValue: "16GB" }],
      rawObservations: [
        {
          requirementKey: "ram",
          value: "16 GB",
          sourceUrl: "https://bestbuy.com/laptop/specs",
          sourceType: "retailer_spec_sheet",
          capturedAt: now,
        },
      ],
      now,
    });

    expect(ingestion.evidenceRecords.length).toBe(1);
    const rec = ingestion.evidenceRecords[0];

    // Normalized canonical value
    expect(rec.value).toBe("16GB");
    // Raw observed value must be preserved exactly
    expect(rec.rawObservedValue).toBe("16 GB");
    // Provenance preserved
    expect(rec.sourceUrl).toBe("https://bestbuy.com/laptop/specs");
    expect(rec.sourceType).toBe("retailer_spec_sheet");
    expect(rec.capturedAt).toBe(now.toISOString());
    expect(rec.status).toBe("supports");
    expect(ingestion.contradictedAttributeKeys).toEqual([]);
    expect(ingestion.missingAttributeKeys).toEqual([]);
  });

  // 8. Equivalent values produce stable results across repeated runs
  it("8. Equivalent values produce stable results across repeated runs", () => {
    const variations = ["16GB", "16 GB", "16   GB", "16 gigabytes", "16 Gigabytes", "16.0 GB", "16 gigs"];
    for (let run = 0; run < 50; run++) {
      for (const val of variations) {
        const canonical = canonicalizeSpecification("ram", val);
        expect(canonical.canonicalValue).toBe("16GB");
        expect(areSpecificationsEquivalent("ram", "16GB", val)).toBe(true);
      }
    }

    const binaryVariations = ["16GiB", "16 GiB", "16-GiB", "16 gibibytes", "16 Gibibytes"];
    for (const val of binaryVariations) {
      const canonical = canonicalizeSpecification("ram", val);
      expect(canonical.canonicalValue).toBe("16GiB");
      expect(areSpecificationsEquivalent("ram", "16 GiB", val)).toBe(true);
      expect(areSpecificationsEquivalent("ram", "16 GB", val)).toBe(false);
    }
  });

  // 9. Material evidence changes still invalidate stale approval snapshots
  it("9. Material evidence changes still invalidate stale approval snapshots", () => {
    const evidence16GB = [
      {
        requirementKey: "ram",
        value: "16GB",
        sourceUrl: "https://example.com/item",
        sourceType: "merchant_feed",
        capturedAt: now.toISOString(),
        status: "supports" as const,
      },
    ];

    const evidence32GB = [
      {
        requirementKey: "ram",
        value: "32GB",
        sourceUrl: "https://example.com/item",
        sourceType: "merchant_feed",
        capturedAt: now.toISOString(),
        status: "supports" as const,
      },
    ];

    const fp16 = computeEvidenceFingerprint(evidence16GB);
    const fp32 = computeEvidenceFingerprint(evidence32GB);

    expect(fp16).not.toBe(fp32);

    // Verify state machine transition guards against stale evidence fingerprint
    const candidateFacts = {
      id: "cand_001",
      purchaseId: "pur_001",
      source: "seeded" as const,
      unitPriceCents: 50000,
      quantity: 1,
      shippingCents: 0,
      totalCents: 50000,
      currency: "USD" as const,
      snapshotHash: "b".repeat(64),
    };

    const state: PurchaseState = {
      purchaseId: "pur_001",
      status: "POLICY_PASSED",
      policyVersion: "1.0.0",
      budgetCents: 100000,
      currency: "USD",
      requiredRuleKeys: ["P-BUDGET"],
      selectedCandidate: candidateFacts,
      approvals: [],
      paymentAttempts: [],
      currentEvidenceFingerprint: fp32, // Evidence changed materially to 32GB
      policyEvidenceFingerprint: fp16,  // Approved with 16GB
    };

    const res = transition(
      state,
      { kind: "approve" },
      { now, actor: { kind: "user", userId: "buyer_1" }, newApprovalId: "appr_001" }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("guard_failed");
      expect(res.error.message).toBe("evidence_fingerprint_mismatch");
    }
  });

  // 10. Existing policy behavior for budget, currency, quantity, availability, and freshness remains unchanged
  it("10. Existing policy behavior for budget, currency, quantity, availability, and freshness remains unchanged", () => {
    const candidateFacts = {
      id: "cand_guard_001",
      merchantName: "MerchantCorp",
      unitPriceCents: 10000,
      shippingCents: 500,
      totalCents: 10500,
      currency: "USD" as const,
      quantity: 1,
      availability: "in_stock",
      snapshotHash: "hash_guard",
    };

    const validEvidence = [
      {
        id: "evi_guard_ram",
        candidateId: "cand_guard_001",
        requirementKey: "ram",
        value: "16GB",
        sourceUrl: "https://merchant.example.com",
        sourceType: "feed",
        capturedAt: now.toISOString(),
        status: "supports" as const,
      },
    ];

    // Standard pass case
    const passResult = evaluatePolicy({
      config: {
        requiredRuleKeys: [
          "P-BUDGET",
          "P-CURRENCY",
          "P-QUANTITY",
          "P-AVAILABILITY",
          "P-EVIDENCE",
          "P-FRESHNESS",
        ],
        maxEvidenceAgeMs: 86400000,
      },
      purchase: {
        budgetCents: 20000,
        currency: "USD",
        requestedQuantity: 1,
        requiredAttributes: [{ key: "ram", expectedValue: "16 GB" }], // 16 GB required
      },
      candidate: candidateFacts,
      evidence: validEvidence, // 16GB provided
      now,
    });

    expect(passResult.ruleResults["P-BUDGET"].outcome).toBe("pass");
    expect(passResult.ruleResults["P-CURRENCY"].outcome).toBe("pass");
    expect(passResult.ruleResults["P-QUANTITY"].outcome).toBe("pass");
    expect(passResult.ruleResults["P-AVAILABILITY"].outcome).toBe("pass");
    expect(passResult.ruleResults["P-EVIDENCE"].outcome).toBe("pass"); // 16 GB matched 16GB
    expect(passResult.ruleResults["P-FRESHNESS"].outcome).toBe("pass");
    expect(passResult.summary.allRequiredPassed).toBe(true);

    // Budget exceeded case fails closed
    const budgetFailResult = evaluatePolicy({
      config: { requiredRuleKeys: ["P-BUDGET"] },
      purchase: { budgetCents: 5000, currency: "USD", requestedQuantity: 1 },
      candidate: candidateFacts,
      now,
    });
    expect(budgetFailResult.ruleResults["P-BUDGET"].outcome).toBe("block");

    // Freshness stale fails closed
    const staleResult = evaluatePolicy({
      config: { requiredRuleKeys: ["P-FRESHNESS"], maxEvidenceAgeMs: 1000 },
      purchase: { budgetCents: 20000, currency: "USD", requestedQuantity: 1, requiredAttributes: ["ram"] },
      candidate: candidateFacts,
      evidence: [
        {
          ...validEvidence[0],
          capturedAt: new Date(now.getTime() - 1000000).toISOString(),
        },
      ],
      now,
    });
    expect(staleResult.ruleResults["P-FRESHNESS"].outcome).toBe("block");
  });

  // 11. P-EVIDENCE direct rule evaluation
  it("11. P-EVIDENCE direct rule evaluation matches equivalent and blocks non-equivalent", () => {
    const candidateId = "cand_direct_001";
    const context = { now };

    // Case A: 16 gigabytes vs 16GB -> pass
    const resA = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: [{ key: "ram", expectedValue: "16GB" }],
        evidence: [
          {
            candidateId,
            requirementKey: "ram",
            value: "16 gigabytes",
            status: "supports",
          },
        ],
      },
      context
    );
    expect(resA.outcome).toBe("pass");

    // Case B: 32 GB vs 16GB -> block
    const resB = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: [{ key: "ram", expectedValue: "16GB" }],
        evidence: [
          {
            candidateId,
            requirementKey: "ram",
            value: "32 GB",
            status: "supports",
          },
        ],
      },
      context
    );
    expect(resB.outcome).toBe("block");

    // Case C: unsupported unit 16 inches vs 16GB -> block
    const resC = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: [{ key: "ram", expectedValue: "16GB" }],
        evidence: [
          {
            candidateId,
            requirementKey: "ram",
            value: "16 inches",
            status: "supports",
          },
        ],
      },
      context
    );
    expect(resC.outcome).toBe("block");

    // Case D: non-RAM attribute uses conservative text match
    const resD = evidenceRule.evaluate(
      {
        candidateId,
        requiredAttributes: [{ key: "color", expectedValue: "Midnight Blue" }],
        evidence: [
          {
            candidateId,
            requirementKey: "color",
            value: "midnight blue",
            status: "supports",
          },
        ],
      },
      context
    );
    expect(resD.outcome).toBe("pass");
  });
});
