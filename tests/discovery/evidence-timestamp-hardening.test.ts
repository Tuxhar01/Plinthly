import { describe, it, expect } from "vitest";
import {
  ingestCandidateEvidence,
  formatUtcIso8601,
  UNKNOWN_TIMESTAMP_SENTINEL,
  UNKNOWN_TIMESTAMP_SENTINEL_ISO,
} from "../../lib/discovery/evidence";
import { normalizeCandidate } from "../../lib/discovery/normalize";
import { freshnessRule } from "../../lib/policy/rules/freshness";
import { evidenceRule } from "../../lib/policy/rules/evidence";
import { evaluatePolicy } from "../../lib/policy/evaluator";
import { parseEvidenceCapturedAt } from "../../lib/workflow/service";

describe("Phase 8B.1 Evidence Timestamp Hardening Unit & Policy Tests", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");
  const maxAgeMs = 3600_000; // 1 hour

  const baseRawCandidate = {
    externalId: "KB-EXT-88",
    title: "Mechanical Keyboard",
    merchantName: "Peripheral Hub",
    merchantUrl: "https://hub.example.com/item/kb-88",
    unitPrice: "99.00",
    shipping: "5.00",
    quantity: 1,
    currency: "USD",
    availability: "in_stock",
    capturedAt: "2026-10-21T11:45:00.000Z", // 15 mins before now
  };

  const normalizedWithCapturedAt = normalizeCandidate(baseRawCandidate, {
    purchaseId: "pur_hardening_1",
    source: "channel3",
    now,
  });

  // Candidate whose raw payload omitted capturedAt (simulating crawlers without timestamp)
  const rawWithoutCapturedAt = { ...baseRawCandidate };
  delete (rawWithoutCapturedAt as Record<string, unknown>).capturedAt;
  const normalizedWithoutCapturedAt = normalizeCandidate(rawWithoutCapturedAt, {
    purchaseId: "pur_hardening_2",
    source: "channel3",
    now,
  });

  // 1. Valid timestamp
  it("scenario 1: observation with a valid timestamp ingests and passes freshness", () => {
    const validTime = "2026-10-21T11:50:00.000Z";
    const ingestion = ingestCandidateEvidence({
      candidate: normalizedWithCapturedAt,
      requiredAttributes: [{ key: "layout", expectedValue: "ANSI" }],
      rawObservations: [
        {
          requirementKey: "layout",
          value: "ANSI",
          capturedAt: validTime,
        },
      ],
      now,
    });

    expect(ingestion.isComplete).toBe(true);
    expect(ingestion.invalidTimestampAttributeKeys).toEqual([]);
    expect(ingestion.missingAttributeKeys).toEqual([]);
    expect(ingestion.evidenceRecords).toHaveLength(1);

    const rec = ingestion.evidenceRecords[0];
    expect(rec.capturedAt).toBe(validTime);
    expect(rec.status).toBe("supports");
    expect(ingestion.evidenceFingerprint).toHaveLength(64);

    // Persistence parser generates a valid Date
    const persistedDate = parseEvidenceCapturedAt(rec.capturedAt);
    expect(persistedDate.toISOString()).toBe(validTime);
    expect(isNaN(persistedDate.getTime())).toBe(false);

    // Policy freshness passes
    const evalResult = freshnessRule.evaluate(
      {
        candidateId: normalizedWithCapturedAt.id,
        requiredAttributes: ["layout"],
        evidence: ingestion.evidenceRecords,
        maxAgeMs,
      },
      { now }
    );
    expect(evalResult.outcome).toBe("pass");
  });

  // 2. Omitted timestamp
  it("scenario 2: observation with omitted timestamp fails closed (unknown) and does not leak ingestion time", () => {
    // Both observation and candidate omitted source capturedAt
    const ingestion = ingestCandidateEvidence({
      candidate: normalizedWithoutCapturedAt,
      requiredAttributes: [{ key: "layout", expectedValue: "ANSI" }],
      rawObservations: [
        {
          requirementKey: "layout",
          value: "ANSI",
          // capturedAt omitted completely
        },
      ],
      now,
    });

    expect(ingestion.isComplete).toBe(false);
    expect(ingestion.invalidTimestampAttributeKeys).toContain("layout");
    expect(ingestion.evidenceFingerprint).toBe("");

    const rec = ingestion.evidenceRecords[0];
    expect(rec.capturedAt).toBe("");

    // Persistence parser safely returns sentinel (epoch 0), NEVER an invalid Date or current clock
    const persistedDate = parseEvidenceCapturedAt(rec.capturedAt);
    expect(persistedDate).toEqual(UNKNOWN_TIMESTAMP_SENTINEL);
    expect(persistedDate.getTime()).toBe(0);
    expect(isNaN(persistedDate.getTime())).toBe(false);

    // Freshness rule fails closed with unknown, NEVER pass
    const freshnessRes = freshnessRule.evaluate(
      {
        candidateId: normalizedWithoutCapturedAt.id,
        requiredAttributes: ["layout"],
        evidence: ingestion.evidenceRecords,
        maxAgeMs,
      },
      { now }
    );
    expect(freshnessRes.outcome).toBe("unknown");
    expect(freshnessRes.explanation.reason).toContain("missing or invalid capturedAt timestamp");
  });

  // 3. Empty timestamp string
  it("scenario 3: observation with empty timestamp string produces sentinel and fails closed", () => {
    const ingestion = ingestCandidateEvidence({
      candidate: normalizedWithCapturedAt,
      requiredAttributes: [{ key: "layout", expectedValue: "ANSI" }],
      rawObservations: [
        {
          requirementKey: "layout",
          value: "ANSI",
          capturedAt: "",
        },
      ],
      now,
    });

    expect(ingestion.isComplete).toBe(false);
    expect(ingestion.invalidTimestampAttributeKeys).toContain("layout");
    expect(ingestion.evidenceFingerprint).toBe("");

    const rec = ingestion.evidenceRecords[0];
    expect(rec.capturedAt).toBe("");

    const persistedDate = parseEvidenceCapturedAt(rec.capturedAt);
    expect(persistedDate).toEqual(UNKNOWN_TIMESTAMP_SENTINEL);
    expect(persistedDate.getTime()).toBe(0);

    const freshnessRes = freshnessRule.evaluate(
      {
        candidateId: normalizedWithCapturedAt.id,
        requiredAttributes: ["layout"],
        evidence: ingestion.evidenceRecords,
        maxAgeMs,
      },
      { now }
    );
    expect(freshnessRes.outcome).toBe("unknown");
  });

  // 4. Malformed timestamp
  it("scenario 4: observation with malformed timestamp preserves diagnostic string and fails closed", () => {
    const malformed = "invalid-2026-bad-timestamp";
    const ingestion = ingestCandidateEvidence({
      candidate: normalizedWithCapturedAt,
      requiredAttributes: [{ key: "layout", expectedValue: "ANSI" }],
      rawObservations: [
        {
          requirementKey: "layout",
          value: "ANSI",
          capturedAt: malformed,
        },
      ],
      now,
    });

    expect(ingestion.isComplete).toBe(false);
    expect(ingestion.invalidTimestampAttributeKeys).toContain("layout");
    expect(ingestion.evidenceFingerprint).toBe("");

    const rec = ingestion.evidenceRecords[0];
    expect(rec.capturedAt).toBe(malformed);

    // Persistence parser maps malformed string to sentinel (epoch 0)
    const persistedDate = parseEvidenceCapturedAt(rec.capturedAt);
    expect(persistedDate).toEqual(UNKNOWN_TIMESTAMP_SENTINEL);
    expect(persistedDate.getTime()).toBe(0);

    // Freshness fails closed with unparseable date error
    const freshnessRes = freshnessRule.evaluate(
      {
        candidateId: normalizedWithCapturedAt.id,
        requiredAttributes: ["layout"],
        evidence: ingestion.evidenceRecords,
        maxAgeMs,
      },
      { now }
    );
    expect(freshnessRes.outcome).toBe("unknown");
    expect(freshnessRes.explanation.reason).toContain("Unparseable date string");
  });

  // 5. Non-matching requirement
  it("scenario 5: observation that does not match a required requirement creates missing evidence item", () => {
    const ingestion = ingestCandidateEvidence({
      candidate: normalizedWithCapturedAt,
      requiredAttributes: [
        { key: "layout", expectedValue: "ANSI" },
        { key: "connectivity", expectedValue: "Bluetooth" },
      ],
      rawObservations: [
        {
          requirementKey: "layout",
          value: "ANSI",
          capturedAt: "2026-10-21T11:50:00.000Z",
        },
        // connectivity observation is NOT provided
      ],
      now,
    });

    expect(ingestion.isComplete).toBe(false);
    expect(ingestion.missingAttributeKeys).toEqual(["connectivity"]);
    expect(ingestion.evidenceFingerprint).toBe("");

    const missingItem = ingestion.evidenceRecords.find((r) => r.requirementKey === "connectivity");
    expect(missingItem).toBeDefined();
    expect(missingItem?.status).toBe("missing");
    expect(missingItem?.capturedAt).toBe("");

    const persistedDate = parseEvidenceCapturedAt(missingItem?.capturedAt);
    expect(persistedDate).toEqual(UNKNOWN_TIMESTAMP_SENTINEL);
    expect(persistedDate.getTime()).toBe(0);

    // Evidence rule evaluates missing item as unknown
    const evidenceRes = evidenceRule.evaluate({
      candidateId: normalizedWithCapturedAt.id,
      requiredAttributes: ["layout", "connectivity"],
      evidence: ingestion.evidenceRecords,
    });
    expect(evidenceRes.outcome).toBe("unknown");

    // Freshness rule evaluates missing item as unknown
    const freshnessRes = freshnessRule.evaluate(
      {
        candidateId: normalizedWithCapturedAt.id,
        requiredAttributes: ["layout", "connectivity"],
        evidence: ingestion.evidenceRecords,
        maxAgeMs,
      },
      { now }
    );
    expect(freshnessRes.outcome).toBe("unknown");
  });

  // 6. parseEvidenceCapturedAt and formatUtcIso8601 invariants
  it("scenario 6: parseEvidenceCapturedAt and formatUtcIso8601 never produce an Invalid Date", () => {
    // formatUtcIso8601 test vectors
    expect(formatUtcIso8601(undefined)).toBe("");
    expect(formatUtcIso8601(null)).toBe("");
    expect(formatUtcIso8601("")).toBe("");
    expect(formatUtcIso8601("   ")).toBe("");
    expect(formatUtcIso8601(new Date(NaN))).toBe("");
    expect(formatUtcIso8601(new Date(0))).toBe(UNKNOWN_TIMESTAMP_SENTINEL_ISO);
    expect(formatUtcIso8601("1970-01-01T00:00:00.000Z")).toBe(UNKNOWN_TIMESTAMP_SENTINEL_ISO);
    expect(formatUtcIso8601("not-a-date")).toBe("not-a-date");
    expect(formatUtcIso8601("2026-10-21T12:00:00.000Z")).toBe("2026-10-21T12:00:00.000Z");

    const inputs = [
      undefined,
      null,
      "",
      "   ",
      "not-a-date",
      "2026-99-99T99:99:99Z",
      new Date(NaN),
      new Date(0),
      UNKNOWN_TIMESTAMP_SENTINEL_ISO,
      {},
      [],
      12345,
      false,
    ];

    for (const input of inputs) {
      const parsed = parseEvidenceCapturedAt(input);
      expect(parsed instanceof Date).toBe(true);
      expect(isNaN(parsed.getTime())).toBe(false);
      expect(parsed.getTime()).toBe(0); // All map safely to sentinel epoch 0
    }

    // Valid inputs produce the exact parsed Date
    const valid = parseEvidenceCapturedAt("2026-10-21T12:00:00.000Z");
    expect(valid.toISOString()).toBe("2026-10-21T12:00:00.000Z");
    expect(valid.getTime()).toBeGreaterThan(0);
  });

  // 7. Policy evaluation integration does not pass when timestamp is missing or sentinel
  it("scenario 7: aggregate policy evaluation fails closed (allRequiredPassed: false) for incomplete evidence", () => {
    const incompleteEvidence = [
      {
        id: "ev-1",
        candidateId: "cand_test",
        requirementKey: "layout",
        value: "ANSI",
        sourceUrl: "https://example.com",
        sourceType: "catalog",
        capturedAt: "", // missing timestamp
        status: "supports" as const,
      },
    ];

    const evalResult = evaluatePolicy({
      candidate: {
        id: "cand_test",
        purchaseId: "pur_test",
        source: "channel3",
        externalId: "ext_1",
        title: "Test",
        merchantName: "Merchant",
        merchantUrl: "https://example.com",
        unitPriceCents: 1000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 1000,
        currency: "USD",
        availability: "in_stock",
        snapshotHash: "a".repeat(64),
      },
      purchase: {
        id: "pur_test",
        budgetCents: 5000,
        currency: "USD",
        requestedQuantity: 1,
        requiredAttributes: ["layout"],
      },
      evidence: incompleteEvidence,
      config: {
        maxEvidenceAgeMs: 3600_000,
      },
      now,
    });

    expect(evalResult.summary.allRequiredPassed).toBe(false);
    expect(evalResult.summary.unknownRuleKeys).toContain("P-FRESHNESS");
    expect(evalResult.ruleResults["P-FRESHNESS"].outcome).toBe("unknown");
  });

  it("scenario 7b: aggregate policy evaluation fails closed when timestamp is sentinel ISO string", () => {
    const sentinelEvidence = [
      {
        id: "ev-sentinel",
        candidateId: "cand_test",
        requirementKey: "layout",
        value: "ANSI",
        sourceUrl: "https://example.com",
        sourceType: "catalog",
        capturedAt: UNKNOWN_TIMESTAMP_SENTINEL_ISO,
        status: "supports" as const,
      },
    ];

    const evalResult = evaluatePolicy({
      candidate: {
        id: "cand_test",
        purchaseId: "pur_test",
        source: "channel3",
        externalId: "ext_1",
        title: "Test",
        merchantName: "Merchant",
        merchantUrl: "https://example.com",
        unitPriceCents: 1000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 1000,
        currency: "USD",
        availability: "in_stock",
        snapshotHash: "a".repeat(64),
      },
      purchase: {
        id: "pur_test",
        budgetCents: 5000,
        currency: "USD",
        requestedQuantity: 1,
        requiredAttributes: ["layout"],
      },
      evidence: sentinelEvidence,
      config: {
        maxEvidenceAgeMs: 3600_000,
      },
      now,
    });

    expect(evalResult.summary.allRequiredPassed).toBe(false);
    expect(evalResult.summary.unknownRuleKeys).toContain("P-FRESHNESS");
    expect(evalResult.ruleResults["P-FRESHNESS"].outcome).toBe("unknown");
  });
});
