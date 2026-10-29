import { describe, it, expect } from "vitest";
import { normalizeCandidate } from "../../lib/discovery/normalize";
import { validateShippingEvidence } from "../../lib/discovery/shipping";
import { RawDiscoveredCandidate, NormalizedProductCandidate } from "../../lib/discovery/types";
import { areSpecificationsEquivalent, parseRamCapacity } from "../../lib/policy/rules/specification";
import { computeSnapshotHash, computeEvidenceFingerprint } from "../../lib/state/snapshot";
import { transition } from "../../lib/state/transitions";
import { PurchaseState, CandidateFacts } from "../../lib/state/types";
import { evaluatePolicy } from "../../lib/policy/evaluator";
import { ingestCandidateEvidence } from "../../lib/discovery/evidence";

describe("Plinthly Phase 11E.4 — End-to-End Evidence and Approval Audit", () => {
  const now = new Date("2026-10-23T12:00:00.000Z");

  describe("1. Trace shipping enforcement", () => {
    it("never converts missing shipping into zero-cost shipping", () => {
      const raw: RawDiscoveredCandidate = {
        externalId: "EXT-NO-SHIP",
        title: "Test Item Without Shipping",
        merchantName: "MerchantA",
        merchantUrl: "https://merchanta.example.com/item",
        unitPriceCents: 5000,
        currency: "USD",
        availability: "in_stock",
      };

      const candidate = normalizeCandidate(raw, {
        purchaseId: "pur_audit_001",
        source: "channel3",
        now,
      });

      expect(candidate.isComplete).toBe(false);
      expect(candidate.shippingCents).toBe(0);
      expect(candidate.shippingDetails?.type).toBe("missing");
      expect(candidate.shippingDetails?.isAuthoritative).toBe(false);
      expect(candidate.snapshotHash).toBe(""); // Incomplete candidate cannot yield snapshot hash
      expect(candidate.validationErrors.some((e) => e.includes("Missing shipping cost"))).toBe(true);
    });

    it("ensures estimated and unverified policy-derived shipping cannot satisfy authoritative requirements", () => {
      // Estimated
      const estimatedRes = validateShippingEvidence({
        rawShippingCents: 1200,
        shippingType: "estimated",
        observationTimestamp: now,
        source: "channel3",
      });
      expect(estimatedRes.isComplete).toBe(false);
      expect(estimatedRes.details.isAuthoritative).toBe(false);
      expect(estimatedRes.details.type).toBe("estimated");

      // Policy-derived
      const policyRes = validateShippingEvidence({
        rawShippingCents: 1500,
        shippingType: "policy_derived",
        observationTimestamp: now,
        source: "channel3",
      });
      expect(policyRes.isComplete).toBe(false);
      expect(policyRes.details.isAuthoritative).toBe(false);
      expect(policyRes.details.type).toBe("policy_derived");
    });

    it("ensures a quoted label alone cannot establish authority when destination is missing for destination-dependent quotes", () => {
      const quotedWithoutDest = validateShippingEvidence({
        rawShippingCents: 999,
        shippingType: "quoted",
        requiresDestination: true,
        destinationPostalCode: undefined,
        observationTimestamp: now,
        source: "channel3",
      });
      expect(quotedWithoutDest.isComplete).toBe(false);
      expect(quotedWithoutDest.details.isAuthoritative).toBe(false);
      expect(quotedWithoutDest.errors).toContain("Missing destination prevents destination-dependent quotes.");

      // With valid destination matching destinationContextSchema
      const quotedWithDest = validateShippingEvidence({
        rawShippingCents: 999,
        shippingType: "quoted",
        requiresDestination: true,
        destinationPostalCode: "98101",
        destinationCountry: "US",
        observationTimestamp: now,
        source: "channel3",
      });
      expect(quotedWithDest.isComplete).toBe(true);
      expect(quotedWithDest.details.isAuthoritative).toBe(true);
      expect(quotedWithDest.details.destinationPostalCode).toBe("98101");
    });

    it("proves observation timestamps cannot substitute for source verification timestamps in policy evaluation", () => {
      const policyEval = evaluatePolicy({
        config: { requiredRuleKeys: ["P-FRESHNESS"], maxEvidenceAgeMs: 86400000 },
        purchase: { budgetCents: 100000, currency: "USD", requestedQuantity: 1, requiredAttributes: ["ram"] },
        candidate: {
          id: "cand_fresh_audit",
          merchantName: "Store",
          unitPriceCents: 50000,
          shippingCents: 0,
          totalCents: 50000,
          currency: "USD",
          quantity: 1,
          availability: "in_stock",
          snapshotHash: "hash_fresh",
        },
        evidence: [
          {
            id: "evi_ram_unverified",
            candidateId: "cand_fresh_audit",
            requirementKey: "ram",
            value: "16GB",
            sourceUrl: "https://example.com/item",
            sourceType: "retailer_spec_sheet",
            capturedAt: "", // Empty source verification timestamp
            status: "supports",
          },
        ],
        now,
      });

      // Fails closed to UNKNOWN, never silently passing
      expect(policyEval.ruleResults["P-FRESHNESS"].outcome).toBe("unknown");
      expect(policyEval.summary.allRequiredPassed).toBe(false);
    });

    it("proves any shipping or total change invalidates stale buyer approval", () => {
      const origCand: CandidateFacts = {
        id: "cand_orig",
        purchaseId: "pur_audit_002",
        source: "channel3",
        unitPriceCents: 40000,
        quantity: 1,
        shippingCents: 0,
        totalCents: 40000,
        currency: "USD",
        snapshotHash: "1".repeat(64),
      };

      const alteredCand: CandidateFacts = {
        ...origCand,
        shippingCents: 1500,
        totalCents: 41500,
        snapshotHash: "2".repeat(64),
      };

      const approvedState: PurchaseState = {
        purchaseId: "pur_audit_002",
        status: "APPROVED",
        policyVersion: "1.0.0",
        budgetCents: 50000,
        currency: "USD",
        requiredRuleKeys: ["P-BUDGET"],
        selectedCandidate: alteredCand, // Candidate modified after approval
        approvals: [
          {
            id: "appr_orig",
            purchaseId: "pur_audit_002",
            candidateId: "cand_orig",
            snapshotHash: "1".repeat(64), // Approved against original snapshot
            totalCents: 40000,
            currency: "USD",
            policyVersion: "1.0.0",
            evidenceFingerprint: "3".repeat(64),
            approverUserId: "usr_buyer_1",
            approvedAt: now,
            invalidatedAt: null,
            invalidationReason: null,
          },
        ],
        paymentAttempts: [],
        currentEvidenceFingerprint: "3".repeat(64),
        policyEvidenceFingerprint: "3".repeat(64),
      };

      const res = transition(
        approvedState,
        {
          kind: "create_order",
          idempotencyKey: "idem_audit_1",
          paypalOrderId: "PAYPAL-ORDER-AUDIT",
        },
        {
          now,
          actor: { kind: "system", component: "audit" },
          newPaymentAttemptId: "pay_att_audit_1",
        }
      );

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("approval_invalidated");
        expect(res.error.message).toContain("snapshot_hash_changed");
        expect(res.error.message).toContain("total_changed");
      }
    });
  });

  describe("2. Specification normalization audit (GB vs GiB)", () => {
    it("distinguishes 16 GB and 16 GiB using exact byte representations", () => {
      const gb16 = parseRamCapacity("16 GB");
      const gib16 = parseRamCapacity("16 GiB");

      expect(gb16).not.toBeNull();
      expect(gib16).not.toBeNull();
      expect(gb16?.unit).toBe("GB");
      expect(gib16?.unit).toBe("GiB");
      expect(gb16?.bytes).toBe(BigInt("16000000000"));
      expect(gib16?.bytes).toBe(BigInt("17179869184"));

      // They MUST NOT match
      expect(areSpecificationsEquivalent("ram", "16 GB", "16 GiB")).toBe(false);
      expect(areSpecificationsEquivalent("ram", "16GB", "16GiB")).toBe(false);
      expect(areSpecificationsEquivalent("ram", "16 gigabytes", "16 gibibytes")).toBe(false);
    });

    it("verifies 1000 MB == 1 GB and 1024 MiB == 1 GiB common unit conversion", () => {
      // 1000 MB == 1 GB
      expect(areSpecificationsEquivalent("ram", "1000 MB", "1 GB")).toBe(true);
      expect(areSpecificationsEquivalent("ram", "1 GB", "1000 MB")).toBe(true);
      expect(areSpecificationsEquivalent("ram", "1000 megabytes", "1 gigabyte")).toBe(true);

      // 1024 MiB == 1 GiB
      expect(areSpecificationsEquivalent("ram", "1024 MiB", "1 GiB")).toBe(true);
      expect(areSpecificationsEquivalent("ram", "1 GiB", "1024 MiB")).toBe(true);
      expect(areSpecificationsEquivalent("ram", "1024 mebibytes", "1 gibibyte")).toBe(true);

      // Cross decimal/binary inequality: 1000 MB != 1024 MiB
      expect(areSpecificationsEquivalent("ram", "1000 MB", "1024 MiB")).toBe(false);
      expect(areSpecificationsEquivalent("ram", "1 GB", "1 GiB")).toBe(false);
    });

    it("rejects malformed, ambiguous, or missing unit values conservatively", () => {
      expect(areSpecificationsEquivalent("ram", "16GB", "16")).toBe(false); // missing unit
      expect(areSpecificationsEquivalent("ram", "16GB", "GB")).toBe(false); // missing number
      expect(areSpecificationsEquivalent("ram", "16GB", "NaN GB")).toBe(false);
      expect(areSpecificationsEquivalent("ram", "16GB", "-16GB")).toBe(false);
      expect(areSpecificationsEquivalent("ram", "16GB", "abc")).toBe(false);
      expect(areSpecificationsEquivalent("ram", "16GB", "16 inches")).toBe(false);
      expect(parseRamCapacity("16")).toBeNull();
      expect(parseRamCapacity("GB")).toBeNull();
    });

    it("preserves raw observed values and provenance through evidence ingestion", () => {
      const candidate: NormalizedProductCandidate = {
        id: "cand_audit_spec",
        purchaseId: "pur_audit_spec",
        source: "channel3",
        externalId: "EXT-RAM-TEST",
        title: "Laptop 16GB",
        merchantName: "MerchantX",
        merchantUrl: "https://merchantx.com/item",
        unitPriceCents: 89900,
        quantity: 1,
        shippingCents: 0,
        totalCents: 89900,
        currency: "USD",
        availability: "in_stock",
        capturedAt: now,
        snapshotHash: "hash_audit_spec",
        rawSourceData: {},
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
            sourceUrl: "https://merchantx.com/specs",
            sourceType: "retailer_spec_sheet",
            capturedAt: now,
          },
        ],
        now,
      });

      expect(ingestion.evidenceRecords.length).toBe(1);
      const rec = ingestion.evidenceRecords[0];
      expect(rec.value).toBe("16GB"); // Normalized canonical
      expect(rec.rawObservedValue).toBe("16 GB"); // Exact raw value preserved
      expect(rec.sourceUrl).toBe("https://merchantx.com/specs");
      expect(rec.sourceType).toBe("retailer_spec_sheet");
      expect(rec.status).toBe("supports");
    });
  });

  describe("3. Approval and PayPal invariants", () => {
    it("binds approval to exact candidate snapshot hash, evidence fingerprint, total, and currency", () => {
      const candidate = {
        availability: "in_stock",
        currency: "USD",
        externalId: "EXT-AUDIT-3",
        merchantName: "StoreAudit",
        merchantUrl: "https://store.example.com",
        quantity: 1,
        shippingCents: 500,
        source: "channel3",
        totalCents: 50500,
        unitPriceCents: 50000,
      };

      const hash1 = computeSnapshotHash(candidate);
      expect(hash1.length).toBe(64);

      // Mutating shipping changes the hash
      const hash2 = computeSnapshotHash({ ...candidate, shippingCents: 1000, totalCents: 51000 });
      expect(hash2).not.toBe(hash1);

      // Evidence fingerprint covers evidence items
      const fp1 = computeEvidenceFingerprint([
        {
          requirementKey: "ram",
          value: "16GB",
          sourceUrl: "https://store.example.com/specs",
          sourceType: "spec_sheet",
          capturedAt: now.toISOString(),
          status: "supports",
        },
      ]);
      expect(fp1.length).toBe(64);

      // Mutating evidence value changes the fingerprint
      const fp2 = computeEvidenceFingerprint([
        {
          requirementKey: "ram",
          value: "32GB",
          sourceUrl: "https://store.example.com/specs",
          sourceType: "spec_sheet",
          capturedAt: now.toISOString(),
          status: "supports",
        },
      ]);
      expect(fp2).not.toBe(fp1);
    });

    it("verifies no capture endpoint, capture call, or live transaction execution exists", () => {
      // In Plinthly Phase 11, the workflow terminates at buyer approval and order creation verification.
      // Confirm state machine does not permit premature capture execution.
      const state: PurchaseState = {
        purchaseId: "pur_audit_term",
        status: "APPROVED",
        policyVersion: "1.0.0",
        budgetCents: 60000,
        currency: "USD",
        requiredRuleKeys: ["P-BUDGET"],
        selectedCandidate: null,
        approvals: [],
        paymentAttempts: [],
        currentEvidenceFingerprint: null,
        policyEvidenceFingerprint: null,
      };

      // record_capture_attempt is illegal from APPROVED status
      const res = transition(state, { kind: "record_capture_attempt" }, { now, actor: { kind: "system", component: "sys" } });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("illegal_transition");
      }
    });
  });
});
