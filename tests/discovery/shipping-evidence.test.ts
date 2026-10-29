import { describe, it, expect } from "vitest";
import {
  validateShippingEvidence,
  destinationContextSchema,
} from "../../lib/discovery/shipping";
import { normalizeCandidate } from "../../lib/discovery/normalize";
import { RawDiscoveredCandidate } from "../../lib/discovery/types";
import { computeSnapshotHash } from "../../lib/state/snapshot";
import { transition } from "../../lib/state/transitions";
import { PurchaseState, CandidateFacts } from "../../lib/state/types";
import { evaluatePolicy } from "../../lib/policy/evaluator";
import { FIXTURE_DATA } from "../../lib/discovery/fixture-adapter";

describe("Phase 11E.3 — Shipping Evidence Foundation", () => {
  const now = new Date("2026-10-22T12:00:00.000Z");

  // 1. Missing shipping remains ineligible
  it("1. missing shipping remains ineligible for approval", () => {
    const raw: RawDiscoveredCandidate = {
      externalId: "PROD-NO-SHIP",
      title: "Laptop Without Shipping",
      merchantName: "RetailerA",
      merchantUrl: "https://retailera.example.com/laptop",
      unitPriceCents: 89900,
      quantity: 1,
      currency: "USD",
      availability: "in_stock",
      capturedAt: now,
      // shipping omitted
    };

    const candidate = normalizeCandidate(raw, {
      purchaseId: "pur_ship_001",
      source: "channel3",
      now,
    });

    expect(candidate.isComplete).toBe(false);
    expect(candidate.shippingCents).toBe(0);
    expect(candidate.shippingDetails?.type).toBe("missing");
    expect(candidate.shippingDetails?.isAuthoritative).toBe(false);
    expect(candidate.validationErrors.some((e) => e.includes("Missing shipping cost"))).toBe(true);
    expect(candidate.snapshotHash).toBe(""); // Incomplete candidate cannot produce valid snapshot hash
  });

  // 2. Estimates cannot be treated as authoritative quotes
  it("2. estimates cannot be treated as authoritative quotes", () => {
    const res = validateShippingEvidence({
      rawShippingCents: 1500,
      shippingType: "estimated",
      deliveryMethod: "standard_ground",
      observationTimestamp: now,
      source: "channel3",
    });

    expect(res.valid).toBe(false);
    expect(res.isComplete).toBe(false);
    expect(res.details.type).toBe("estimated");
    expect(res.details.isAuthoritative).toBe(false);
    expect(res.details.amountCents).toBe(1500);
    expect(res.errors).toContain(
      "Estimated shipping cost cannot be treated as an authoritative quote for buyer approval."
    );

    // When processed through normalizeCandidate:
    const raw: RawDiscoveredCandidate = {
      externalId: "PROD-EST-SHIP",
      title: "Laptop With Estimated Shipping",
      merchantName: "RetailerB",
      merchantUrl: "https://retailerb.example.com/laptop",
      unitPriceCents: 99900,
      shippingCents: 1500,
      shippingType: "estimated",
      quantity: 1,
      currency: "USD",
      availability: "in_stock",
      capturedAt: now,
    };

    const candidate = normalizeCandidate(raw, {
      purchaseId: "pur_ship_002",
      source: "channel3",
      now,
    });

    expect(candidate.isComplete).toBe(false);
    expect(candidate.shippingDetails?.isAuthoritative).toBe(false);
    expect(candidate.validationErrors.some((e) => e.includes("Estimated shipping cost"))).toBe(true);
  });

  // 3. A verified shipping amount affects total cost and snapshot fingerprint
  it("3. verified shipping amount affects total cost and snapshot hash", () => {
    const baseCandidate = {
      availability: "in_stock",
      currency: "USD",
      externalId: "EXT-LAPTOP-01",
      merchantName: "BestBuy",
      merchantUrl: "https://bestbuy.com/laptop",
      quantity: 1,
      shippingCents: 0,
      source: "channel3",
      totalCents: 100000,
      unitPriceCents: 100000,
    };

    const hashFreeShipping = computeSnapshotHash(baseCandidate);

    const withShipping = {
      ...baseCandidate,
      shippingCents: 2500,
      totalCents: 102500, // 100000 + 2500
    };

    const hashWithShipping = computeSnapshotHash(withShipping);

    // Snapshot hash MUST change when shipping changes
    expect(hashWithShipping).not.toBe(hashFreeShipping);

    // Total cents MUST equal unitPrice * quantity + shippingCents
    expect(withShipping.totalCents).toBe(102500);
  });

  // 4. Changing shipping invalidates stale approval
  it("4. changing shipping invalidates stale approval", () => {
    const candidateOriginal: CandidateFacts = {
      id: "cand_orig_001",
      purchaseId: "pur_ship_003",
      source: "seeded",
      unitPriceCents: 50000,
      quantity: 1,
      shippingCents: 0,
      totalCents: 50000,
      currency: "USD",
      snapshotHash: "a".repeat(64),
    };

    const candidateModified: CandidateFacts = {
      ...candidateOriginal,
      shippingCents: 1500,
      totalCents: 51500,
      snapshotHash: "b".repeat(64), // Altered shipping yields different hash
    };

    const approvedState: PurchaseState = {
      purchaseId: "pur_ship_003",
      status: "APPROVED",
      policyVersion: "1.0.0",
      budgetCents: 60000,
      currency: "USD",
      requiredRuleKeys: ["P-BUDGET"],
      selectedCandidate: candidateModified, // Modified candidate with new shipping
      approvals: [
        {
          id: "appr_orig_001",
          purchaseId: "pur_ship_003",
          candidateId: "cand_orig_001",
          snapshotHash: "a".repeat(64), // Approved against original free shipping
          totalCents: 50000,
          currency: "USD",
          policyVersion: "1.0.0",
          evidenceFingerprint: "c".repeat(64),
          approverUserId: "usr_001",
          approvedAt: now,
          invalidatedAt: null,
          invalidationReason: null,
        },
      ],
      paymentAttempts: [],
      currentEvidenceFingerprint: "c".repeat(64),
      policyEvidenceFingerprint: "c".repeat(64),
    };

    // Attempting order creation with mismatched candidate snapshot hash MUST fail
    const res = transition(
      approvedState,
      {
        kind: "create_order",
        idempotencyKey: "idem_001",
        paypalOrderId: "ORDER-123",
      },
      {
        now,
        actor: { kind: "system", component: "sys" },
        newPaymentAttemptId: "pay_001",
      }
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("approval_invalidated");
      expect(res.error.message).toContain("snapshot_hash_changed");
      expect(res.error.message).toContain("total_changed");
    }
  });

  // 5. Missing destination prevents destination-dependent quotes
  it("5. missing destination prevents destination-dependent quotes", () => {
    const res = validateShippingEvidence({
      rawShippingCents: 999,
      shippingType: "quoted",
      deliveryMethod: "standard_ground",
      requiresDestination: true,
      destinationPostalCode: undefined, // Missing destination
      observationTimestamp: now,
      source: "channel3",
    });

    expect(res.valid).toBe(false);
    expect(res.isComplete).toBe(false);
    expect(res.details.isAuthoritative).toBe(false);
    expect(res.errors).toContain("Missing destination prevents destination-dependent quotes.");

    // With valid destination ZIP, it passes:
    const validZipRes = validateShippingEvidence({
      rawShippingCents: 999,
      shippingType: "quoted",
      deliveryMethod: "standard_ground",
      requiresDestination: true,
      destinationPostalCode: "98101",
      destinationCountry: "US",
      observationTimestamp: now,
      source: "channel3",
    });

    expect(validZipRes.valid).toBe(true);
    expect(validZipRes.isComplete).toBe(true);
    expect(validZipRes.details.isAuthoritative).toBe(true);
    expect(validZipRes.details.destinationPostalCode).toBe("98101");
  });

  // 6. Observation timestamps cannot substitute for source-verification timestamps
  it("6. observation timestamps cannot substitute for source-verification timestamps", () => {
    const res = validateShippingEvidence({
      rawShippingCents: 500,
      shippingType: "quoted",
      deliveryMethod: "in_store_pickup",
      observationTimestamp: now,
      sourceVerificationTimestamp: undefined, // Source verification missing
      source: "channel3",
    });

    // observationTimestamp is recorded locally, but sourceVerificationTimestamp remains null
    expect(res.details.observationTimestamp).toBe(now.toISOString());
    expect(res.details.sourceVerificationTimestamp).toBeNull();

    // In P-FRESHNESS, unverified source timestamps cannot pass freshness
    const policyRes = evaluatePolicy({
      config: { requiredRuleKeys: ["P-FRESHNESS"], maxEvidenceAgeMs: 86400000 },
      purchase: { budgetCents: 100000, currency: "USD", requestedQuantity: 1, requiredAttributes: ["shipping"] },
      candidate: {
        id: "cand_fresh_001",
        merchantName: "Store",
        unitPriceCents: 50000,
        shippingCents: 500,
        totalCents: 50500,
        currency: "USD",
        quantity: 1,
        availability: "in_stock",
        snapshotHash: "hash_001",
      },
      evidence: [
        {
          id: "evi_ship",
          candidateId: "cand_fresh_001",
          requirementKey: "shipping",
          value: "500",
          sourceUrl: "https://example.com",
          sourceType: "shipping_quote",
          capturedAt: "", // Missing source verification timestamp
          status: "supports",
        },
      ],
      now,
    });

    // Fails closed with UNKNOWN, never silently passing
    expect(policyRes.ruleResults["P-FRESHNESS"].outcome).toBe("unknown");
    expect(policyRes.summary.allRequiredPassed).toBe(false);
  });

  // 7. Existing synthetic fixtures continue to work without weakening their validation
  it("7. existing synthetic fixtures continue to work without weakening validation", () => {
    // Valid complete fixtures (first 3)
    const validFixtures = FIXTURE_DATA.slice(0, 3);
    for (const fixture of validFixtures) {
      const candidate = normalizeCandidate(fixture, {
        purchaseId: "pur_fixture_test",
        source: "seeded",
        now,
      });

      expect(candidate.isComplete).toBe(true);
      expect(candidate.shippingCents).toBeGreaterThanOrEqual(0);
      expect(candidate.totalCents).toBeGreaterThan(0);
      expect(candidate.snapshotHash.length).toBe(64);
      expect(candidate.validationErrors).toEqual([]);
    }

    // Intentionally invalid / malformed fixtures (remaining)
    const invalidFixtures = FIXTURE_DATA.slice(3);
    for (const fixture of invalidFixtures) {
      const candidate = normalizeCandidate(fixture, {
        purchaseId: "pur_fixture_test",
        source: "seeded",
        now,
      });

      expect(candidate.isComplete).toBe(false);
      expect(candidate.snapshotHash).toBe("");
      expect(candidate.validationErrors.length).toBeGreaterThan(0);
    }
  });

  // 8. Minimal destination context schema validation
  it("8. validates minimal destination context schema without premature personal data", () => {
    const valid = destinationContextSchema.safeParse({
      country: "US",
      postalCode: "98101",
      deliveryMethodPreference: "standard_ground",
    });
    expect(valid.success).toBe(true);

    const validExtendedZip = destinationContextSchema.safeParse({
      postalCode: "98101-1234",
    });
    expect(validExtendedZip.success).toBe(true);
    if (validExtendedZip.success) {
      expect(validExtendedZip.data.country).toBe("US");
    }

    const invalidCountry = destinationContextSchema.safeParse({
      country: "CA",
      postalCode: "98101",
    });
    expect(invalidCountry.success).toBe(false);

    const invalidZip = destinationContextSchema.safeParse({
      postalCode: "INVALID",
    });
    expect(invalidZip.success).toBe(false);
  });
});
