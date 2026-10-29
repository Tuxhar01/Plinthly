import { describe, it, expect } from "vitest";
import {
  createPurchaseSchema,
  evaluatePurchaseSchema,
  approvePurchaseSchema,
  extractActor,
} from "../../lib/workflow/validation";
import { MAX_CENTS } from "../../lib/state/money";
import { Currency } from "../../lib/state/types";

describe("Workflow Input Validation", () => {
  describe("createPurchaseSchema", () => {
    it("accepts valid creation payload", () => {
      const parsed = createPurchaseSchema.parse({
        budgetCents: 10000,
        currency: "USD",
        requirements: ["organic", { key: "voltage", expectedValue: "110V" }],
        requestedQuantity: 2,
        confirmImmediately: true,
      });

      expect(parsed.budgetCents).toBe(10000);
      expect(parsed.currency).toBe("USD");
      expect(parsed.requirements.length).toBe(2);
      expect(parsed.requestedQuantity).toBe(2);
      expect(parsed.confirmImmediately).toBe(true);
    });

    it("rejects non-integer budgetCents", () => {
      expect(() =>
        createPurchaseSchema.parse({
          budgetCents: 99.99,
          currency: "USD",
          requirements: ["item"],
        })
      ).toThrow();
    });

    it("rejects negative or zero budgetCents", () => {
      expect(() =>
        createPurchaseSchema.parse({
          budgetCents: 0,
          currency: "USD",
          requirements: ["item"],
        })
      ).toThrow();

      expect(() =>
        createPurchaseSchema.parse({
          budgetCents: -500,
          currency: "USD",
          requirements: ["item"],
        })
      ).toThrow();
    });

    it("rejects budget exceeding MAX_CENTS", () => {
      expect(() =>
        createPurchaseSchema.parse({
          budgetCents: MAX_CENTS + 1,
          currency: "USD",
          requirements: ["item"],
        })
      ).toThrow();
    });

    it("rejects non-USD currency", () => {
      expect(() =>
        createPurchaseSchema.parse({
          budgetCents: 5000,
          currency: "EUR" as unknown as Currency,
          requirements: ["item"],
        })
      ).toThrow();
    });

    it("rejects empty requirements array", () => {
      expect(() =>
        createPurchaseSchema.parse({
          budgetCents: 5000,
          currency: "USD",
          requirements: [],
        })
      ).toThrow();
    });

    it("rejects empty string requirement keys", () => {
      expect(() =>
        createPurchaseSchema.parse({
          budgetCents: 5000,
          currency: "USD",
          requirements: [""],
        })
      ).toThrow();

      expect(() =>
        createPurchaseSchema.parse({
          budgetCents: 5000,
          currency: "USD",
          requirements: [{ key: "" }],
        })
      ).toThrow();
    });

    it("defaults requestedQuantity to 1 and confirmImmediately to true", () => {
      const parsed = createPurchaseSchema.parse({
        budgetCents: 5000,
        currency: "USD",
        requirements: ["spec1"],
      });

      expect(parsed.requestedQuantity).toBe(1);
      expect(parsed.confirmImmediately).toBe(true);
    });
  });

  describe("evaluatePurchaseSchema", () => {
    it("accepts valid candidateId payload", () => {
      const parsed = evaluatePurchaseSchema.parse({
        candidateId: "cand_123",
        requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
      });

      expect(parsed.candidateId).toBe("cand_123");
      expect(parsed.requiredRuleKeys).toEqual(["P-BUDGET", "P-CURRENCY"]);
    });

    it("accepts rawCandidate payload", () => {
      const parsed = evaluatePurchaseSchema.parse({
        rawCandidate: {
          externalId: "ext_1",
          title: "Widget",
          unitPriceCents: 500,
        },
      });

      expect(parsed.rawCandidate).toBeDefined();
    });
  });

  describe("approvePurchaseSchema", () => {
    it("accepts valid approval payload with 64-char hex hashes", () => {
      const hex64 = "a".repeat(64);
      const parsed = approvePurchaseSchema.parse({
        expectedSnapshotHash: hex64,
        expectedEvidenceFingerprint: hex64,
        expectedTotalCents: 1500,
        expectedCurrency: "USD",
        policyVersion: "1.0.0",
      });

      expect(parsed.expectedSnapshotHash).toBe(hex64);
      expect(parsed.expectedTotalCents).toBe(1500);
    });

    it("rejects invalid snapshotHash regex", () => {
      expect(() =>
        approvePurchaseSchema.parse({
          expectedSnapshotHash: "not-a-64-hex",
        })
      ).toThrow();
    });
  });

  describe("extractActor", () => {
    it("extracts user actor by default", () => {
      const headers = new Headers();
      const actor = extractActor(headers);
      expect(actor.kind).toBe("user");
      if (actor.kind === "user") {
        expect(actor.userId).toBe("local_dev_user");
      }
    });

    it("extracts specified user actor", () => {
      const headers = new Headers();
      headers.set("x-actor-id", "usr_buyer_42");
      headers.set("x-actor-kind", "user");
      const actor = extractActor(headers);
      expect(actor).toEqual({ kind: "user", userId: "usr_buyer_42" });
    });

    it("extracts system actor when kind is system", () => {
      const headers = new Headers();
      headers.set("x-actor-kind", "system");
      headers.set("x-actor-component", "batch_scheduler");
      const actor = extractActor(headers);
      expect(actor).toEqual({ kind: "system", component: "batch_scheduler" });
    });
  });
});
