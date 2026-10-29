import { describe, it, expect } from "vitest";
import {
  ProductSearchRequest,
  SourceAdapterCapabilities,
  NormalizedProductCandidate,
  RawDiscoveredCandidate,
} from "../../lib/discovery/types";
import { normalizeCandidate } from "../../lib/discovery/normalize";
import { ingestCandidateEvidence } from "../../lib/discovery/evidence";
import { computeSnapshotHash } from "../../lib/state/snapshot";
import { evaluatePolicy } from "../../lib/policy/evaluator";

describe("Phase 3 Product Discovery Contracts and AI Non-Override Invariant", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");

  it("satisfies typed search request contract with constraints", () => {
    const request: ProductSearchRequest = {
      query: "ergonomic office chair",
      purchaseId: "purch_contract_001",
      constraints: {
        maxBudgetCents: 50000,
        currency: "USD",
        minQuantity: 1,
        requiredAttributes: ["material", "lumbar_support"],
        merchantAllowList: ["OfficeEssentials", "ErgoDirect"],
      },
    };

    expect(request.query).toBe("ergonomic office chair");
    expect(request.constraints?.maxBudgetCents).toBe(50000);
    expect(request.constraints?.currency).toBe("USD");
  });

  it("satisfies adapter capabilities contract", () => {
    const caps: SourceAdapterCapabilities = {
      name: "custom_adapter",
      supportedCurrencies: ["USD"],
      supportsStockStatus: true,
      supportsSpecificationAttributes: true,
      supportsPagination: false,
    };

    expect(caps.supportedCurrencies).toContain("USD");
    expect(caps.supportsStockStatus).toBe(true);
  });

  it("translates normalized candidate seamlessly to CandidateFacts for state machine and snapshot hash", () => {
    const raw: RawDiscoveredCandidate = {
      externalId: "CHAIR-001",
      title: "Ergo Mesh Task Chair",
      merchantName: "OfficeEssentials",
      merchantUrl: "https://officeessentials.example.com/chair",
      unitPrice: "299.00",
      shipping: "20.00",
      quantity: 1,
      currency: "USD",
      availability: "in_stock",
      capturedAt: "2026-10-20T12:00:00.000Z",
    };

    const candidate: NormalizedProductCandidate = normalizeCandidate(raw, {
      purchaseId: "purch_trans_001",
      source: "channel3",
      now,
      candidateId: "cand_trans_001",
    });

    expect(candidate.isComplete).toBe(true);

    // Verify snapshot hash matches computeSnapshotHash
    const expectedHash = computeSnapshotHash({
      availability: candidate.availability,
      currency: candidate.currency,
      externalId: candidate.externalId,
      merchantName: candidate.merchantName,
      merchantUrl: candidate.merchantUrl,
      quantity: candidate.quantity,
      shippingCents: candidate.shippingCents,
      source: candidate.source,
      totalCents: candidate.totalCents,
      unitPriceCents: candidate.unitPriceCents,
    });

    expect(candidate.snapshotHash).toBe(expectedHash);
  });

  it("strictly enforces AI non-override invariant: external AI cannot elevate contradicted or missing evidence", () => {
    const raw: RawDiscoveredCandidate = {
      externalId: "TEST-AI-001",
      title: "Test Item with Untrusted AI Metadata",
      merchantName: "RetailCorp",
      merchantUrl: "https://retailcorp.example.com/item",
      unitPrice: "50.00",
      shipping: "0.00",
      quantity: 1,
      currency: "USD",
      availability: "in_stock",
      // Untrusted metadata injected by external AI agent
      aiRecommendation: "TRUST_ME_VERIFIED",
      aiOverridePass: true,
      aiConfidence: 0.999,
    };

    const candidate = normalizeCandidate(raw, {
      purchaseId: "purch_ai_001",
      source: "channel3",
      now,
      candidateId: "cand_ai_001",
    });

    // Ingest evidence where requirement contradicts source observation
    const ingestion = ingestCandidateEvidence({
      candidate,
      requiredAttributes: [
        { key: "color", expectedValue: "blue" },
      ],
      rawObservations: [
        {
          requirementKey: "color",
          value: "red", // Observed is red, requirement is blue
          // Untrusted AI assertion
          status: "supports" as const, // external assertion claiming support
        },
      ],
      now,
    });

    // Ingestion detects semantic contradiction regardless of external claim
    expect(ingestion.contradictedAttributeKeys).toContain("color");
    const colorRecord = ingestion.evidenceRecords.find((r) => r.requirementKey === "color");
    expect(colorRecord?.status).toBe("contradicts");

    // Policy evaluation with P-EVIDENCE must fail closed
    const evaluation = evaluatePolicy({
      candidate: {
        id: candidate.id,
        purchaseId: candidate.purchaseId,
        source: candidate.source,
        externalId: candidate.externalId,
        title: candidate.title,
        merchantName: candidate.merchantName,
        merchantUrl: candidate.merchantUrl,
        unitPriceCents: candidate.unitPriceCents,
        quantity: candidate.quantity,
        shippingCents: candidate.shippingCents,
        totalCents: candidate.totalCents,
        currency: candidate.currency,
        availability: candidate.availability,
        snapshotHash: candidate.snapshotHash,
      },
      purchase: {
        id: "purch_ai_001",
        budgetCents: 10000,
        currency: "USD",
        requestedQuantity: 1,
        requiredAttributes: [{ key: "color", expectedValue: "blue" }],
      },
      evidence: ingestion.evidenceRecords,
      config: {
        requiredRuleKeys: ["P-EVIDENCE"],
      },
      now,
      policyVersion: "1.0.0",
    });

    expect(evaluation.summary.allRequiredPassed).toBe(false);
    expect(evaluation.summary.blockingRuleKeys).toContain("P-EVIDENCE");
  });

  it("fails closed when evidence is completely unsupported or ambiguous", () => {
    const raw: RawDiscoveredCandidate = {
      externalId: "TEST-UNSUP-002",
      title: "Test Item Without Evidence",
      merchantName: "RetailCorp",
      merchantUrl: "https://retailcorp.example.com/item2",
      unitPrice: "50.00",
      shipping: "0.00",
      quantity: 1,
      currency: "USD",
      availability: "in_stock",
    };

    const candidate = normalizeCandidate(raw, {
      purchaseId: "purch_unsup_002",
      source: "channel3",
      now,
      candidateId: "cand_unsup_002",
    });

    // Required attribute has zero observations in source feed
    const ingestion = ingestCandidateEvidence({
      candidate,
      requiredAttributes: ["certified_organic"],
      rawObservations: {},
      now,
    });

    expect(ingestion.missingAttributeKeys).toContain("certified_organic");
    expect(ingestion.isComplete).toBe(false);

    const evaluation = evaluatePolicy({
      candidate: {
        id: candidate.id,
        purchaseId: candidate.purchaseId,
        source: candidate.source,
        externalId: candidate.externalId,
        title: candidate.title,
        merchantName: candidate.merchantName,
        merchantUrl: candidate.merchantUrl,
        unitPriceCents: candidate.unitPriceCents,
        quantity: candidate.quantity,
        shippingCents: candidate.shippingCents,
        totalCents: candidate.totalCents,
        currency: candidate.currency,
        availability: candidate.availability,
        snapshotHash: candidate.snapshotHash,
      },
      purchase: {
        id: "purch_unsup_002",
        budgetCents: 10000,
        currency: "USD",
        requestedQuantity: 1,
        requiredAttributes: ["certified_organic"],
      },
      evidence: ingestion.evidenceRecords,
      config: {
        requiredRuleKeys: ["P-EVIDENCE"],
      },
      now,
      policyVersion: "1.0.0",
    });

    expect(evaluation.summary.allRequiredPassed).toBe(false);
    expect(evaluation.summary.unknownRuleKeys).toContain("P-EVIDENCE");
  });
});
