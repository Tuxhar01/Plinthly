import { describe, it, expect } from "vitest";
import { ingestCandidateEvidence, formatUtcIso8601 } from "../../lib/discovery/evidence";
import { normalizeCandidate } from "../../lib/discovery/normalize";
import { evidenceRule } from "../../lib/policy/rules/evidence";
import { freshnessRule } from "../../lib/policy/rules/freshness";
import { evaluatePolicy } from "../../lib/policy/evaluator";

describe("Phase 3 Evidence Ingestion and Policy Compatibility", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");

  const candidate = normalizeCandidate(
    {
      externalId: "KB-001",
      title: "Keychron K2 Mechanical Keyboard",
      merchantName: "Keycaps Direct",
      merchantUrl: "https://keycapsdirect.example.com/item/k2",
      unitPrice: "79.99",
      shipping: "0.00",
      quantity: 1,
      currency: "USD",
      availability: "in_stock",
      capturedAt: "2026-10-20T11:50:00.000Z",
    },
    {
      purchaseId: "purch_kb_123",
      source: "channel3",
      now,
      candidateId: "cand_isolated_123",
    }
  );

  it("ingests matching observations and enforces candidate isolation", () => {
    const result = ingestCandidateEvidence({
      candidate,
      requiredAttributes: [
        { key: "layout", expectedValue: "ANSI" },
        { key: "switches", expectedValue: "Gateron Brown" },
      ],
      rawObservations: {
        layout: "ANSI",
        switches: "Gateron Brown",
      },
      now,
    });

    expect(result.candidateId).toBe(candidate.id);
    expect(result.isComplete).toBe(true);
    expect(result.missingAttributeKeys).toEqual([]);
    expect(result.contradictedAttributeKeys).toEqual([]);
    expect(result.conflictingAttributeKeys).toEqual([]);
    expect(result.evidenceRecords).toHaveLength(2);

    for (const record of result.evidenceRecords) {
      expect(record.candidateId).toBe("cand_isolated_123");
      expect(record.status).toBe("supports");
      expect(record.sourceUrl).toBe(candidate.merchantUrl);
      expect(record.capturedAt).toBe("2026-10-20T11:50:00.000Z");
    }

    expect(result.evidenceFingerprint).toHaveLength(64);
  });

  it("marks missing attributes when source observation is absent", () => {
    const result = ingestCandidateEvidence({
      candidate,
      requiredAttributes: ["layout", "backlight_color", "connectivity"],
      rawObservations: {
        layout: "ANSI",
      },
      now,
    });

    expect(result.isComplete).toBe(false);
    expect(result.missingAttributeKeys).toEqual(["backlight_color", "connectivity"]);
    expect(result.supportedAttributeKeys).toEqual(["layout"]);

    const missingRecords = result.evidenceRecords.filter((r) => r.status === "missing");
    expect(missingRecords).toHaveLength(2);
    expect(missingRecords.map((r) => r.requirementKey).sort()).toEqual(["backlight_color", "connectivity"].sort());
  });

  it("detects semantic contradictions when observed value does not match expected value", () => {
    const result = ingestCandidateEvidence({
      candidate,
      requiredAttributes: [
        { key: "layout", expectedValue: "ANSI" },
        { key: "switches", expectedValue: "Cherry MX Blue" },
      ],
      rawObservations: [
        { requirementKey: "layout", value: "ANSI" },
        { requirementKey: "switches", value: "Gateron Red" }, // contradicts expected Cherry MX Blue
      ],
      now,
    });

    expect(result.isComplete).toBe(false);
    expect(result.contradictedAttributeKeys).toEqual(["switches"]);

    const switchRecord = result.evidenceRecords.find((r) => r.requirementKey === "switches");
    expect(switchRecord).toBeDefined();
    expect(switchRecord?.status).toBe("contradicts");
    expect(switchRecord?.value).toBe("Gateron Red");
  });

  it("flags conflicting evidence when source contains multiple differing values for the same key", () => {
    const result = ingestCandidateEvidence({
      candidate,
      requiredAttributes: ["layout"],
      rawObservations: [
        { requirementKey: "layout", value: "ANSI" },
        { requirementKey: "layout", value: "ISO" },
      ],
      now,
    });

    expect(result.conflictingAttributeKeys).toEqual(["layout"]);
  });

  it("treats empty or whitespace values as missing rather than supports", () => {
    const result = ingestCandidateEvidence({
      candidate,
      requiredAttributes: ["weight"],
      rawObservations: {
        weight: "   ",
      },
      now,
    });

    expect(result.missingAttributeKeys).toEqual(["weight"]);
    const record = result.evidenceRecords.find((r) => r.requirementKey === "weight");
    expect(record?.status).toBe("missing");
  });

  describe("Regression: Timestamp formatting and clock isolation", () => {
    it("converts valid ISO strings with timezones and valid Date objects to canonical UTC ISO-8601", () => {
      const fromTzString = formatUtcIso8601("2026-10-20T08:30:00-04:00");
      expect(fromTzString).toBe("2026-10-20T12:30:00.000Z");

      const fromDateObj = formatUtcIso8601(new Date("2026-10-20T12:30:00.000Z"));
      expect(fromDateObj).toBe("2026-10-20T12:30:00.000Z");
    });

    it("returns empty string for missing timestamp (undefined or null), never substituting clock time", () => {
      expect(formatUtcIso8601(undefined)).toBe("");
      expect(formatUtcIso8601(null)).toBe("");
    });

    it("returns empty string for empty or whitespace-only timestamp string", () => {
      expect(formatUtcIso8601("")).toBe("");
      expect(formatUtcIso8601("   ")).toBe("");
      expect(formatUtcIso8601("\t\n")).toBe("");
    });

    it("preserves malformed timestamp string without defaulting to now", () => {
      expect(formatUtcIso8601("invalid_date")).toBe("invalid_date");
      expect(formatUtcIso8601("2026-99-99T99:99:99Z")).toBe("2026-99-99T99:99:99Z");
    });

    it("returns empty string for invalid Date instances (NaN getTime)", () => {
      expect(formatUtcIso8601(new Date("invalid"))).toBe("");
      expect(formatUtcIso8601(new Date(NaN))).toBe("");
    });
  });

  describe("Compatibility with Phase 2 Policy Rules", () => {
    it("satisfies Phase 2 evidenceRule with ingested supporting evidence", () => {
      const ingestion = ingestCandidateEvidence({
        candidate,
        requiredAttributes: [
          { key: "resolution", expectedValue: "4K" },
          { key: "refresh_rate", expectedValue: "144Hz" },
        ],
        rawObservations: {
          resolution: "4K",
          refresh_rate: "144Hz",
        },
        now,
      });

      const ruleResult = evidenceRule.evaluate({
        candidateId: candidate.id,
        requiredAttributes: [
          { key: "resolution", expectedValue: "4K" },
          { key: "refresh_rate", expectedValue: "144Hz" },
        ],
        evidence: ingestion.evidenceRecords,
      });

      expect(ruleResult.outcome).toBe("pass");
    });

    it("fails closed in Phase 2 evidenceRule when evidence is missing or contradicted", () => {
      const ingestion = ingestCandidateEvidence({
        candidate,
        requiredAttributes: [
          { key: "resolution", expectedValue: "4K" },
          { key: "refresh_rate", expectedValue: "144Hz" },
        ],
        rawObservations: {
          resolution: "1080p", // Contradicts 4K
        },
        now,
      });

      const ruleResult = evidenceRule.evaluate({
        candidateId: candidate.id,
        requiredAttributes: [
          { key: "resolution", expectedValue: "4K" },
          { key: "refresh_rate", expectedValue: "144Hz" },
        ],
        evidence: ingestion.evidenceRecords,
      });

      // Contradiction causes a block
      expect(ruleResult.outcome).toBe("block");
    });

    it("satisfies Phase 2 freshnessRule with ingested fresh evidence", () => {
      const ingestion = ingestCandidateEvidence({
        candidate,
        requiredAttributes: ["layout"],
        rawObservations: { layout: "ANSI" },
        now,
      });

      const ruleResult = freshnessRule.evaluate(
        {
          candidateId: candidate.id,
          requiredAttributes: ["layout"],
          evidence: ingestion.evidenceRecords,
          maxAgeMs: 3600_000, // 1 hour
        },
        { now }
      );

      expect(ruleResult.outcome).toBe("pass");
    });

    it("blocks in Phase 2 freshnessRule when evidence is older than maxAgeMs", () => {
      const oldCaptureDate = new Date("2026-10-19T00:00:00.000Z"); // > 24 hours old
      const ingestion = ingestCandidateEvidence({
        candidate,
        requiredAttributes: ["layout"],
        rawObservations: [
          {
            requirementKey: "layout",
            value: "ANSI",
            capturedAt: oldCaptureDate,
          },
        ],
        now,
      });

      const ruleResult = freshnessRule.evaluate(
        {
          candidateId: candidate.id,
          requiredAttributes: ["layout"],
          evidence: ingestion.evidenceRecords,
          maxAgeMs: 3600_000, // 1 hour max
        },
        { now }
      );

      expect(ruleResult.outcome).toBe("block");
      expect(ruleResult.explanation.reason).toContain("exceed maximum allowed age");
    });

    it("fails closed (unknown) in freshnessRule when observation has a missing or undefined capturedAt", () => {
      // Candidate without listing capture time, observation with undefined capturedAt
      const unTimestampedCandidate = { ...candidate, capturedAt: undefined as unknown as Date };
      const ingestion = ingestCandidateEvidence({
        candidate: unTimestampedCandidate,
        requiredAttributes: ["layout"],
        rawObservations: [
          {
            requirementKey: "layout",
            value: "ANSI",
            capturedAt: undefined,
          },
        ],
        now,
      });

      const record = ingestion.evidenceRecords.find((r) => r.requirementKey === "layout");
      expect(record?.capturedAt).toBe("");

      const ruleResult = freshnessRule.evaluate(
        {
          candidateId: candidate.id,
          requiredAttributes: ["layout"],
          evidence: ingestion.evidenceRecords,
          maxAgeMs: 3600_000,
        },
        { now }
      );

      expect(ruleResult.outcome).toBe("unknown");
      expect(ruleResult.explanation.reason).toContain("missing or invalid capturedAt timestamp");
    });

    it("fails closed (unknown) in freshnessRule when observation has a malformed timestamp string", () => {
      const ingestion = ingestCandidateEvidence({
        candidate,
        requiredAttributes: ["layout"],
        rawObservations: [
          {
            requirementKey: "layout",
            value: "ANSI",
            capturedAt: "not_a_valid_date_time",
          },
        ],
        now,
      });

      const record = ingestion.evidenceRecords.find((r) => r.requirementKey === "layout");
      expect(record?.capturedAt).toBe("not_a_valid_date_time");

      const ruleResult = freshnessRule.evaluate(
        {
          candidateId: candidate.id,
          requiredAttributes: ["layout"],
          evidence: ingestion.evidenceRecords,
          maxAgeMs: 3600_000,
        },
        { now }
      );

      expect(ruleResult.outcome).toBe("unknown");
      expect(ruleResult.explanation.reason).toContain("Unparseable date string");
    });

    it("fails closed (unknown) in freshnessRule when observation has an invalid Date instance", () => {
      const ingestion = ingestCandidateEvidence({
        candidate,
        requiredAttributes: ["layout"],
        rawObservations: [
          {
            requirementKey: "layout",
            value: "ANSI",
            capturedAt: new Date(NaN),
          },
        ],
        now,
      });

      const record = ingestion.evidenceRecords.find((r) => r.requirementKey === "layout");
      expect(record?.capturedAt).toBe("");

      const ruleResult = freshnessRule.evaluate(
        {
          candidateId: candidate.id,
          requiredAttributes: ["layout"],
          evidence: ingestion.evidenceRecords,
          maxAgeMs: 3600_000,
        },
        { now }
      );

      expect(ruleResult.outcome).toBe("unknown");
    });

    it("proves end-to-end evaluatePolicy cannot approve candidate with un-timestamped or malformed evidence", () => {
      const ingestion = ingestCandidateEvidence({
        candidate,
        requiredAttributes: ["layout"],
        rawObservations: [
          {
            requirementKey: "layout",
            value: "ANSI",
            capturedAt: "malformed_ts_2026",
          },
        ],
        now,
      });

      const evaluation = evaluatePolicy({
        candidate: {
          id: candidate.id,
          purchaseId: candidate.purchaseId,
          source: candidate.source,
          unitPriceCents: candidate.unitPriceCents,
          quantity: candidate.quantity,
          shippingCents: candidate.shippingCents,
          totalCents: candidate.totalCents,
          currency: candidate.currency,
          availability: candidate.availability,
          snapshotHash: candidate.snapshotHash,
        },
        purchase: {
          id: candidate.purchaseId,
          budgetCents: 10000,
          currency: "USD",
          requestedQuantity: 1,
          requiredAttributes: ["layout"],
        },
        evidence: ingestion.evidenceRecords,
        config: {
          requiredRuleKeys: ["P-FRESHNESS"],
          maxEvidenceAgeMs: 3600_000,
        },
        now,
        policyVersion: "1.0.0",
      });

      expect(evaluation.summary.allRequiredPassed).toBe(false);
      expect(evaluation.summary.unknownRuleKeys).toContain("P-FRESHNESS");
      expect(evaluation.ruleResults["P-FRESHNESS"].outcome).toBe("unknown");
    });
  });
});
