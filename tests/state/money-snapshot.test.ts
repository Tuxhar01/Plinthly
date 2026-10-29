import { describe, expect, it } from "vitest";
import { deriveTotalCents, MAX_CENTS, validateCandidateMoney } from "../../lib/state/money";
import { computeEvidenceFingerprint, computeSnapshotHash, EvidenceFingerprintItem, SnapshotCandidateInput } from "../../lib/state/snapshot";

describe("Money and snapshot logic", () => {
  describe("deriveTotalCents", () => {
    it("computes correct total for valid integers", () => {
      const total = deriveTotalCents(1999, 3, 500);
      expect(total).toBe(1999 * 3 + 500);
    });

    it("throws on overflow past MAX_CENTS", () => {
      expect(() => deriveTotalCents(MAX_CENTS, 2, 0)).toThrow(/exceeds maximum allowed cents/);
      expect(() => deriveTotalCents(1000, 1, MAX_CENTS)).toThrow(/exceeds maximum allowed cents/);
    });

    it("throws on non-integer inputs", () => {
      expect(() => deriveTotalCents(19.99, 1, 0)).toThrow(/must be an integer/);
      expect(() => deriveTotalCents(100, 1.5, 0)).toThrow(/must be an integer/);
      expect(() => deriveTotalCents(100, 1, 5.5)).toThrow(/must be an integer/);
    });

    it("throws on negative unitPrice or shipping", () => {
      expect(() => deriveTotalCents(-1, 1, 0)).toThrow(/cannot be negative/);
      expect(() => deriveTotalCents(100, 1, -1)).toThrow(/cannot be negative/);
    });

    it("throws on quantity less than 1", () => {
      expect(() => deriveTotalCents(100, 0, 0)).toThrow(/quantity must be an integer between 1/);
      expect(() => deriveTotalCents(100, -2, 0)).toThrow(/quantity must be an integer between 1/);
    });
  });

  describe("validateCandidateMoney", () => {
    const validCandidate = {
      unitPriceCents: 1500,
      quantity: 2,
      shippingCents: 300,
      totalCents: 3300,
      currency: "USD" as const,
    };

    it("returns true for valid candidate money", () => {
      expect(validateCandidateMoney(validCandidate)).toBe(true);
    });

    it("rejects mismatched total", () => {
      expect(validateCandidateMoney({ ...validCandidate, totalCents: 3301 })).toBe(false);
    });

    it("rejects non-integer cents or quantity", () => {
      expect(validateCandidateMoney({ ...validCandidate, unitPriceCents: 15.5, totalCents: 3300 })).toBe(false);
      expect(validateCandidateMoney({ ...validCandidate, quantity: 2.2, totalCents: 3300 })).toBe(false);
    });

    it("rejects negative numbers or 0 unitPrice", () => {
      expect(validateCandidateMoney({ ...validCandidate, unitPriceCents: 0, totalCents: 300 })).toBe(false);
      expect(validateCandidateMoney({ ...validCandidate, shippingCents: -100 })).toBe(false);
    });

    it("rejects values above MAX_CENTS", () => {
      expect(validateCandidateMoney({ ...validCandidate, unitPriceCents: MAX_CENTS + 1 })).toBe(false);
    });

    it("rejects quantity 0", () => {
      expect(validateCandidateMoney({ ...validCandidate, quantity: 0 })).toBe(false);
    });

    it("rejects non-USD currency", () => {
      expect(validateCandidateMoney({ ...validCandidate, currency: "EUR" as unknown as "USD" })).toBe(false);
    });
  });

  describe("computeSnapshotHash", () => {
    const baseCandidate: SnapshotCandidateInput = {
      availability: "in_stock",
      currency: "USD",
      externalId: "ext-123",
      merchantName: "Acme Store",
      merchantUrl: "https://acme.com",
      quantity: 2,
      shippingCents: 500,
      source: "seeded",
      totalCents: 2500,
      unitPriceCents: 1000,
      title: "Some Title",
      capturedAt: new Date("2026-01-01T00:00:00Z"),
      id: "cand-1",
      purchaseId: "pur-1",
    };

    it("returns 64 lowercase hex characters", () => {
      const hash = computeSnapshotHash(baseCandidate);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is unchanged under input object key reordering", () => {
      const reordered: SnapshotCandidateInput = {
        unitPriceCents: 1000,
        totalCents: 2500,
        source: "seeded",
        shippingCents: 500,
        quantity: 2,
        merchantUrl: "https://acme.com",
        merchantName: "Acme Store",
        externalId: "ext-123",
        currency: "USD",
        availability: "in_stock",
      };
      expect(computeSnapshotHash(reordered)).toBe(computeSnapshotHash(baseCandidate));
    });

    it("changes when any hashed field changes", () => {
      const h1 = computeSnapshotHash(baseCandidate);
      expect(computeSnapshotHash({ ...baseCandidate, unitPriceCents: 1001 })).not.toBe(h1);
      expect(computeSnapshotHash({ ...baseCandidate, availability: "out_of_stock" })).not.toBe(h1);
      expect(computeSnapshotHash({ ...baseCandidate, shippingCents: 501 })).not.toBe(h1);
      expect(computeSnapshotHash({ ...baseCandidate, externalId: "ext-456" })).not.toBe(h1);
      expect(computeSnapshotHash({ ...baseCandidate, merchantName: "Other" })).not.toBe(h1);
      expect(computeSnapshotHash({ ...baseCandidate, merchantUrl: "https://other.com" })).not.toBe(h1);
      expect(computeSnapshotHash({ ...baseCandidate, quantity: 3 })).not.toBe(h1);
      expect(computeSnapshotHash({ ...baseCandidate, source: "channel3" })).not.toBe(h1);
      expect(computeSnapshotHash({ ...baseCandidate, totalCents: 3000 })).not.toBe(h1);
    });

    it("is unchanged when title or capturedAt changes", () => {
      const h1 = computeSnapshotHash(baseCandidate);
      const h2 = computeSnapshotHash({
        ...baseCandidate,
        title: "Completely Different Title",
        capturedAt: new Date("2026-10-10T12:00:00Z"),
      });
      expect(h2).toBe(h1);
    });
  });

  describe("computeEvidenceFingerprint", () => {
    const item1: EvidenceFingerprintItem = {
      requirementKey: "req-1",
      value: "value-A",
      sourceUrl: "https://src.com/1",
      sourceType: "spec",
      capturedAt: "2026-01-01T12:00:00Z",
      status: "supports",
    };

    const item2: EvidenceFingerprintItem = {
      requirementKey: "req-2",
      value: "value-B",
      sourceUrl: "https://src.com/2",
      sourceType: "listing",
      capturedAt: "2026-01-02T12:00:00Z",
      status: "supports",
    };

    const item3: EvidenceFingerprintItem = {
      requirementKey: "req-3",
      value: "value-C",
      sourceUrl: "https://src.com/3",
      sourceType: "manual",
      capturedAt: "2026-01-03T12:00:00Z",
      status: "missing",
    };

    it("returns 64 lowercase hex characters", () => {
      const fp = computeEvidenceFingerprint([item1, item2, item3]);
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is identical for all 6 permutations of a three-item set", () => {
      const p1 = [item1, item2, item3];
      const p2 = [item1, item3, item2];
      const p3 = [item2, item1, item3];
      const p4 = [item2, item3, item1];
      const p5 = [item3, item1, item2];
      const p6 = [item3, item2, item1];

      const expected = computeEvidenceFingerprint(p1);
      expect(computeEvidenceFingerprint(p2)).toBe(expected);
      expect(computeEvidenceFingerprint(p3)).toBe(expected);
      expect(computeEvidenceFingerprint(p4)).toBe(expected);
      expect(computeEvidenceFingerprint(p5)).toBe(expected);
      expect(computeEvidenceFingerprint(p6)).toBe(expected);
    });

    it("is identical for two items tying on requirementKey, sourceUrl, and capturedAt but differing in value, in either order", () => {
      const tie1: EvidenceFingerprintItem = {
        requirementKey: "req-tie",
        value: "Alpha",
        sourceUrl: "https://src.com/tie",
        sourceType: "spec",
        capturedAt: "2026-01-01T00:00:00Z",
        status: "supports",
      };
      const tie2: EvidenceFingerprintItem = {
        requirementKey: "req-tie",
        value: "Beta",
        sourceUrl: "https://src.com/tie",
        sourceType: "spec",
        capturedAt: "2026-01-01T00:00:00Z",
        status: "supports",
      };

      const fp1 = computeEvidenceFingerprint([tie1, tie2]);
      const fp2 = computeEvidenceFingerprint([tie2, tie1]);
      expect(fp1).toBe(fp2);
    });

    it("two identical duplicate items differ from one copy", () => {
      const fpOne = computeEvidenceFingerprint([item1]);
      const fpTwo = computeEvidenceFingerprint([item1, { ...item1 }]);
      expect(fpTwo).not.toBe(fpOne);
    });

    it("changes when any field of any item changes", () => {
      const baseFp = computeEvidenceFingerprint([item1]);
      expect(computeEvidenceFingerprint([{ ...item1, value: "changed" }])).not.toBe(baseFp);
      expect(computeEvidenceFingerprint([{ ...item1, status: "contradicts" }])).not.toBe(baseFp);
      expect(computeEvidenceFingerprint([{ ...item1, sourceUrl: "https://other.com" }])).not.toBe(baseFp);
      expect(computeEvidenceFingerprint([{ ...item1, sourceType: "other" }])).not.toBe(baseFp);
      expect(computeEvidenceFingerprint([{ ...item1, requirementKey: "req-changed" }])).not.toBe(baseFp);
      expect(computeEvidenceFingerprint([{ ...item1, capturedAt: "2026-01-01T12:00:01Z" }])).not.toBe(baseFp);
    });

    it("empty set equals SHA-256 of '[]'", () => {
      const emptyFp = computeEvidenceFingerprint([]);
      // SHA-256 of "[]": 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945
      expect(emptyFp).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
    });

    it("throws on non-ISO capturedAt", () => {
      expect(() =>
        computeEvidenceFingerprint([
          {
            ...item1,
            capturedAt: "not-a-date",
          },
        ])
      ).toThrow(/Invalid capturedAt/);

      expect(() =>
        computeEvidenceFingerprint([
          {
            ...item1,
            capturedAt: "2026-01-01", // Missing time and Z
          },
        ])
      ).toThrow(/Invalid capturedAt/);
    });
  });
});
