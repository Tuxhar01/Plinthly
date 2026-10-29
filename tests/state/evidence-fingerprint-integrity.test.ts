import { describe, it, expect } from "vitest";
import { transition } from "../../lib/state/transitions";
import {
  isValidEvidenceFingerprint,
  normalizePolicyEvidenceFingerprint,
} from "../../lib/state/snapshot";
import {
  CandidateFacts,
  Context,
  PurchaseState,
  PolicySummary,
} from "../../lib/state/types";
import {
  PurchaseWorkflowService,
  ApprovalIntegrityError,
  ConcurrencyConflictError,
} from "../../lib/workflow/service";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { evaluatePolicy } from "../../lib/policy/evaluator";
import { RULE_KEY_FRESHNESS } from "../../lib/policy/rules/freshness";
import { ingestCandidateEvidence } from "../../lib/discovery/evidence";

const defaultContext: Context = {
  actor: { kind: "user", userId: "buyer_test" },
  now: new Date("2026-10-22T08:00:00Z"),
  newApprovalId: "appr_test_123",
};

const validCandidate: CandidateFacts = {
  id: "cand_test_1",
  purchaseId: "pur_test_1",
  source: "seeded",
  unitPriceCents: 10000,
  quantity: 1,
  shippingCents: 500,
  totalCents: 10500,
  currency: "USD",
  snapshotHash: "b".repeat(64),
};

const baseEvalState: PurchaseState = {
  purchaseId: "pur_test_1",
  status: "EVALUATED",
  budgetCents: 15000,
  currency: "USD",
  policyVersion: null,
  requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
  selectedCandidate: validCandidate,
  currentEvidenceFingerprint: null,
  policyEvidenceFingerprint: null,
  approvals: [],
  paymentAttempts: [],
};

const passSummary: PolicySummary = {
  allRequiredPassed: true,
  blockingRuleKeys: [],
  unknownRuleKeys: [],
};

describe("Evidence Fingerprint Integrity & Hardening", () => {
  describe("1. State-Machine Invariants on apply_policy_summary", () => {
    it("rejects empty string fingerprint with guard_failed evidence_fingerprint_missing", () => {
      const state: PurchaseState = {
        ...baseEvalState,
        currentEvidenceFingerprint: "",
      };
      const res = transition(
        state,
        { kind: "apply_policy_summary", policyVersion: "v1.0", summary: passSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toBe("evidence_fingerprint_missing");
      }
    });

    it("rejects whitespace-only fingerprint with guard_failed evidence_fingerprint_missing", () => {
      const state: PurchaseState = {
        ...baseEvalState,
        currentEvidenceFingerprint: "   ",
      };
      const res = transition(
        state,
        { kind: "apply_policy_summary", policyVersion: "v1.0", summary: passSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toBe("evidence_fingerprint_missing");
      }
    });

    it("rejects 64-space blank-padded fingerprint with guard_failed evidence_fingerprint_missing", () => {
      const state: PurchaseState = {
        ...baseEvalState,
        currentEvidenceFingerprint: " ".repeat(64),
      };
      const res = transition(
        state,
        { kind: "apply_policy_summary", policyVersion: "v1.0", summary: passSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toBe("evidence_fingerprint_missing");
      }
    });

    it("rejects space-padded hex fingerprint with guard_failed evidence_fingerprint_invalid", () => {
      const state: PurchaseState = {
        ...baseEvalState,
        currentEvidenceFingerprint: `  ${"a".repeat(64)}  `,
      };
      const res = transition(
        state,
        { kind: "apply_policy_summary", policyVersion: "v1.0", summary: passSummary },
        defaultContext
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toBe("evidence_fingerprint_invalid");
      }
    });

    it("rejects malformed non-hex or invalid-length fingerprints with guard_failed evidence_fingerprint_invalid", () => {
      const malformedExamples = [
        "not-a-sha256-fingerprint",
        "a".repeat(63), // 63 chars (too short)
        "a".repeat(65), // 65 chars (too long)
        "g".repeat(64), // 'g' is not valid hex
        "A".repeat(64), // uppercase hex must be rejected
      ];

      for (const badFp of malformedExamples) {
        const state: PurchaseState = {
          ...baseEvalState,
          currentEvidenceFingerprint: badFp,
        };
        const res = transition(
          state,
          { kind: "apply_policy_summary", policyVersion: "v1.0", summary: passSummary },
          defaultContext
        );
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("guard_failed");
          expect(res.error.message).toBe("evidence_fingerprint_invalid");
        }
      }
    });

    it("accepts a valid 64-char lowercase hex SHA-256 fingerprint and transitions to POLICY_PASSED", () => {
      const validFp = "a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0";
      const state: PurchaseState = {
        ...baseEvalState,
        currentEvidenceFingerprint: validFp,
      };
      const res = transition(
        state,
        { kind: "apply_policy_summary", policyVersion: "v1.0", summary: passSummary },
        defaultContext
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.next.status).toBe("POLICY_PASSED");
        expect(res.next.policyEvidenceFingerprint).toBe(validFp);
        expect(res.events[0].type).toBe("policy_passed");
      }
    });
  });

  describe("2. Evidence Ingestion & Missing Freshness Evidence", () => {
    it("does NOT manufacture a fallback hash when required evidence attributes are missing", () => {
      const ingestResult = ingestCandidateEvidence({
        candidate: {
          id: "cand_1",
          purchaseId: "pur_1",
          source: "seeded",
          merchantUrl: "https://merchant.example.com",
        } as unknown as Parameters<typeof ingestCandidateEvidence>[0]["candidate"],
        defaultSourceUrl: "https://merchant.example.com",
        defaultSourceType: "merchant_spec",
        requiredAttributes: ["merchant_spec", "reputation_check", "freshness"],
        rawObservations: [
          {
            requirementKey: "merchant_spec",
            value: "Verified",
            status: "supports",
            sourceUrl: "https://merchant.example.com",
            sourceType: "merchant_spec",
            capturedAt: new Date().toISOString(),
          },
        ],
        now: new Date("2026-10-22T08:00:00Z"),
      });

      expect(ingestResult.isComplete).toBe(false);
      expect(ingestResult.missingAttributeKeys).toContain("reputation_check");
      expect(ingestResult.missingAttributeKeys).toContain("freshness");
      // Must NOT manufacture a fallback hash
      expect(ingestResult.evidenceFingerprint).toBe("");
    });

    it("causes policy evaluation to fail closed when required freshness rule lacks required attribute evidence", () => {
      const evalResult = evaluatePolicy({
        candidate: {
          id: validCandidate.id,
          purchaseId: validCandidate.purchaseId,
          source: validCandidate.source,
          externalId: "ext-1",
          title: "Test Item",
          merchantName: "Test Merchant",
          merchantUrl: "https://merchant.example.com",
          unitPriceCents: validCandidate.unitPriceCents,
          quantity: validCandidate.quantity,
          shippingCents: validCandidate.shippingCents,
          totalCents: validCandidate.totalCents,
          currency: validCandidate.currency,
          availability: "IN_STOCK",
          snapshotHash: validCandidate.snapshotHash,
        },
        purchase: {
          id: validCandidate.purchaseId,
          budgetCents: 15000,
          currency: "USD",
          requestedQuantity: 1,
          requiredAttributes: ["merchant_spec", "freshness"],
        },
        evidence: [
          {
            id: "evi-1",
            candidateId: validCandidate.id,
            requirementKey: "merchant_spec",
            value: "Spec value",
            sourceUrl: "https://merchant.example.com",
            sourceType: "merchant_spec",
            capturedAt: new Date().toISOString(),
            status: "supports",
          },
        ],
        config: {
          requiredRuleKeys: ["P-BUDGET", "P-CURRENCY", RULE_KEY_FRESHNESS],
          maxEvidenceAgeMs: 86400000,
        },
        now: new Date("2026-10-22T08:00:00Z"),
        policyVersion: "v1.0",
      });

      expect(evalResult.ruleResults[RULE_KEY_FRESHNESS].outcome).toBe("unknown");
      expect(evalResult.summary.allRequiredPassed).toBe(false);
      expect(evalResult.summary.unknownRuleKeys).toContain(RULE_KEY_FRESHNESS);
    });
  });

  describe("3. State-Machine & Service Invariants on Approval", () => {
    it("state transition approve rejects malformed currentEvidenceFingerprint", () => {
      const state: PurchaseState = {
        ...baseEvalState,
        status: "POLICY_PASSED",
        policyVersion: "v1.0",
        currentEvidenceFingerprint: "bad_hex_fingerprint",
        policyEvidenceFingerprint: "a".repeat(64),
      };
      const res = transition(state, { kind: "approve" }, defaultContext);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toBe("evidence_fingerprint_invalid");
      }
    });

    it("state transition approve rejects mismatched fingerprints", () => {
      const state: PurchaseState = {
        ...baseEvalState,
        status: "POLICY_PASSED",
        policyVersion: "v1.0",
        currentEvidenceFingerprint: "a".repeat(64),
        policyEvidenceFingerprint: "b".repeat(64),
      };
      const res = transition(state, { kind: "approve" }, defaultContext);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("guard_failed");
        expect(res.error.message).toBe("evidence_fingerprint_mismatch");
      }
    });

    it("service.approvePurchase throws ApprovalIntegrityError if authoritative fingerprint is invalid or padded whitespace", async () => {
      const repo = new InMemoryPurchaseRepository();
      const service = new PurchaseWorkflowService(repo);
      const user = { kind: "user" as const, userId: "buyer_test" };

      const purchase = await service.createPurchase(
        { budgetCents: 15000, currency: "USD", requirements: ["spec"] },
        user
      );

      // Manually set purchase to POLICY_PASSED with malformed/spaces fingerprint in repository
      const createdRecord = (await repo.getPurchaseById(purchase.id))!.purchase;
      // Simulate raw DB state with 64 spaces
      (repo as unknown as { purchases: Map<string, unknown> })
        .purchases.set(purchase.id, {
          ...createdRecord,
          status: "POLICY_PASSED",
          policyVersion: "v1.0",
          selectedCandidateId: validCandidate.id,
          policyEvidenceFingerprint: " ".repeat(64), // raw blank padded
        });
      await repo.saveCandidateWithEvidence(
        {
          id: validCandidate.id,
          purchaseId: purchase.id,
          source: "seeded",
          externalId: "ext-1",
          title: "Title",
          merchantName: "Merchant",
          merchantUrl: "https://merchant.example.com",
          unitPriceCents: validCandidate.unitPriceCents,
          quantity: validCandidate.quantity,
          shippingCents: validCandidate.shippingCents,
          totalCents: validCandidate.totalCents,
          currency: validCandidate.currency,
          availability: "IN_STOCK",
          snapshotHash: validCandidate.snapshotHash,
          capturedAt: new Date(),
        },
        []
      );

      await expect(
        service.approvePurchase(purchase.id, { expectedVersion: 1 }, user)
      ).rejects.toThrow(ApprovalIntegrityError);

      await expect(
        service.approvePurchase(purchase.id, { expectedVersion: 1 }, user)
      ).rejects.toMatchObject({
        code: "evidence_fingerprint_invalid",
      });
    });

    it("service.approvePurchase strictly enforces snapshotHash, amount, currency, and version preconditions", async () => {
      const repo = new InMemoryPurchaseRepository();
      const service = new PurchaseWorkflowService(repo);
      const user = { kind: "user" as const, userId: "buyer_test" };
      const validFp = "c".repeat(64);

      const purchase = await service.createPurchase(
        { budgetCents: 15000, currency: "USD", requirements: ["spec"] },
        user
      );

      const createdRecord = (await repo.getPurchaseById(purchase.id))!.purchase;
      (repo as unknown as { purchases: Map<string, unknown> })
        .purchases.set(purchase.id, {
          ...createdRecord,
          status: "POLICY_PASSED",
          policyVersion: "v1.0",
          selectedCandidateId: validCandidate.id,
          policyEvidenceFingerprint: validFp,
        });
      await repo.saveCandidateWithEvidence(
        {
          id: validCandidate.id,
          purchaseId: purchase.id,
          source: "seeded",
          externalId: "ext-1",
          title: "Title",
          merchantName: "Merchant",
          merchantUrl: "https://merchant.example.com",
          unitPriceCents: validCandidate.unitPriceCents,
          quantity: validCandidate.quantity,
          shippingCents: validCandidate.shippingCents,
          totalCents: validCandidate.totalCents,
          currency: validCandidate.currency,
          availability: "IN_STOCK",
          snapshotHash: validCandidate.snapshotHash,
          capturedAt: new Date(),
        },
        []
      );

      // Snapshot hash mismatch
      await expect(
        service.approvePurchase(
          purchase.id,
          { expectedVersion: 1, expectedSnapshotHash: "wrong_snapshot_hash" },
          user
        )
      ).rejects.toMatchObject({ code: "snapshot_hash_mismatch" });

      // Amount mismatch
      await expect(
        service.approvePurchase(
          purchase.id,
          { expectedVersion: 1, expectedTotalCents: 99999 },
          user
        )
      ).rejects.toMatchObject({ code: "amount_mismatch" });

      // Currency mismatch
      await expect(
        service.approvePurchase(
          purchase.id,
          { expectedVersion: 1, expectedCurrency: "EUR" as unknown as "USD" },
          user
        )
      ).rejects.toMatchObject({ code: "currency_mismatch" });

      // Concurrency conflict (version mismatch)
      await expect(
        service.approvePurchase(purchase.id, { expectedVersion: 99 }, user)
      ).rejects.toThrow(ConcurrencyConflictError);

      // Successful approval when all match
      const approved = await service.approvePurchase(
        purchase.id,
        {
          expectedVersion: 1,
          expectedSnapshotHash: validCandidate.snapshotHash,
          expectedTotalCents: validCandidate.totalCents,
          expectedCurrency: validCandidate.currency,
          expectedEvidenceFingerprint: validFp,
        },
        user
      );

      expect(approved.status).toBe("APPROVED");
      expect(approved.version).toBe(2);
    });
  });

  describe("4. Database Readback & Fixed-Width CHAR(64) Normalization", () => {
    it("safely normalizes null, undefined, empty, and blank-padded CHAR(64) strings to null", () => {
      expect(normalizePolicyEvidenceFingerprint(null)).toBeNull();
      expect(normalizePolicyEvidenceFingerprint(undefined)).toBeNull();
      expect(normalizePolicyEvidenceFingerprint("")).toBeNull();
      expect(normalizePolicyEvidenceFingerprint("   ")).toBeNull();
      expect(normalizePolicyEvidenceFingerprint(" ".repeat(64))).toBeNull();
    });

    it("trims fixed-width padding from genuine 64-char hex strings", () => {
      const genuineFp = "d".repeat(64);
      expect(normalizePolicyEvidenceFingerprint(`  ${genuineFp}  `)).toBe(genuineFp);
      expect(isValidEvidenceFingerprint(normalizePolicyEvidenceFingerprint(`  ${genuineFp}  `))).toBe(true);
    });

    it("does NOT blindly accept malformed trimmed data as valid", () => {
      const malformedPadded = `abc${" ".repeat(61)}`;
      const normalized = normalizePolicyEvidenceFingerprint(malformedPadded);
      expect(normalized).toBe("abc");
      expect(isValidEvidenceFingerprint(normalized)).toBe(false);
    });

    it("InMemoryWorkflowRepository getPurchaseById applies normalizePolicyEvidenceFingerprint", async () => {
      const repo = new InMemoryPurchaseRepository();
      const user = { kind: "user" as const, userId: "buyer_test" };
      await repo.createPurchase(
        {
          id: "pur_blank_padded",
          status: "POLICY_PASSED",
          requirements: [],
          budgetCents: 10000,
          currency: "USD",
          policyVersion: "v1.0",
          policyEvidenceFingerprint: " ".repeat(64), // simulates CHAR(64) blank padding
          selectedCandidateId: null,
          ownerUserId: user.userId,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        []
      );

      const retrieved = await repo.getPurchaseById("pur_blank_padded");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.purchase.policyEvidenceFingerprint).toBeNull();
    });
  });
});
