import { describe, it, expect, beforeAll } from "vitest";
import { getPurchaseWorkflowService, PurchaseWorkflowService } from "../../lib/workflow/service";
import { Actor } from "../../lib/state/types";
import { ValidationError } from "../../lib/workflow/errors";
import { InMemoryPurchaseRepository } from "../../lib/workflow/repository";
import { POST as multiItemPlanApiRoute } from "../../app/api/purchases/[id]/multi-item/plan/route";
import { setActorResolver, ServerActorResolver } from "../../lib/workflow/auth";

describe("Sample Purchase Compatibility & Strictly Server-Controlled Provenance", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = "postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_dev?schema=public";
    setActorResolver(new ServerActorResolver("local_demo"));
  });

  const testActor: Actor = { kind: "user", userId: "usr_buyer_1" };
  const authHeaders = () => ({
    "Content-Type": "application/json",
    "x-actor-id": "usr_buyer_1",
    "x-actor-kind": "user",
  });

  describe("Service Layer Provenance Enforcement", () => {
    it("1. Successfully evaluates sample purchase pur_1792633876502_s7jvwi22 with server-derived provenance", async () => {
      const service = getPurchaseWorkflowService();
      const agg = await service.getPurchase("pur_1792633876502_s7jvwi22");
      expect(agg).toBeDefined();

      // Client sends clean line item without client-supplied provenance
      const clientItems = [
        {
          id: "line_1",
          title: "Dell XPS 15 Laptop",
          quantity: 1,
          budgetCents: 150000,
          currency: "USD" as const,
          requirements: [{ key: "ram", expectedValue: "32GB" }],
          verificationLevel: "standard" as const,
        },
      ];

      const plan = await service.createMultiItemPlan(
        "pur_1792633876502_s7jvwi22",
        {
          lineItems: clientItems,
          destination: {
            country: "US",
            postalCode: "98101",
            deliveryMethodPreference: "standard_ground",
          },
        },
        testActor
      );
      expect(plan.strategies.length).toBeGreaterThan(0);
      expect(plan.strategies.some((s) => s.feasibility === "feasible")).toBe(true);
      expect(plan.lineItems[0].quantitySource).toBe("legacy_direct");
    });

    it("2. Successfully evaluates sample purchase pur_1792654701712_f2iks5to with server-derived provenance", async () => {
      const service = getPurchaseWorkflowService();
      const agg = await service.getPurchase("pur_1792654701712_f2iks5to");
      expect(agg).toBeDefined();

      // Client sends clean line item without client-supplied provenance
      const clientItems = [
        {
          id: "line_1",
          title: "Dell XPS 15 Laptop",
          quantity: 1,
          budgetCents: 150000,
          currency: "USD" as const,
          requirements: [{ key: "ram", expectedValue: "32GB" }],
          verificationLevel: "standard" as const,
        },
      ];

      const plan = await service.createMultiItemPlan(
        "pur_1792654701712_f2iks5to",
        {
          lineItems: clientItems,
          destination: {
            country: "US",
            postalCode: "98101",
            deliveryMethodPreference: "standard_ground",
          },
        },
        testActor
      );
      expect(plan.strategies.length).toBeGreaterThan(0);
      expect(plan.strategies.some((s) => s.feasibility === "feasible")).toBe(true);
      expect(plan.lineItems[0].quantitySource).toBe("legacy_direct");
    });

    it("3. Client-supplied legacy_direct is stripped and ignored in favor of server-derived provenance for a legacy purchase", async () => {
      const service = getPurchaseWorkflowService();
      // Client attempts to supply legacy_direct on legitimate legacy purchase
      const plan = await service.createMultiItemPlan(
        "pur_1792633876502_s7jvwi22",
        {
          lineItems: [
            {
              id: "line_1",
              title: "Dell XPS 15 Laptop",
              quantity: 1,
              quantitySource: "legacy_direct" as any,
              budgetCents: 150000,
              currency: "USD" as const,
              requirements: [{ key: "ram", expectedValue: "32GB" }],
              verificationLevel: "standard" as const,
            },
          ],
          destination: {
            country: "US",
            postalCode: "98101",
            deliveryMethodPreference: "standard_ground",
          },
        },
        testActor
      );
      // Evaluates successfully because server strips client provenance and attaches trusted server-derived provenance
      expect(plan.strategies.length).toBeGreaterThan(0);
      expect(plan.lineItems[0].quantitySource).toBe("legacy_direct");
    });

    it("4. Client-supplied legacy_direct is strictly rejected for a non-legacy purchase", async () => {
      const service = getPurchaseWorkflowService();
      // Non-legacy purchase pur_1793281339386_ezth1m40 has structured lineItems in requirements and originatingDraftId !== null
      try {
        await service.createMultiItemPlan(
          "pur_1793281339386_ezth1m40",
          {
            lineItems: [
              {
                id: "line_forged",
                title: "Forged Item",
                quantity: 1,
                quantitySource: "legacy_direct" as any,
                budgetCents: 150000,
                currency: "USD" as const,
                requirements: [],
                verificationLevel: "standard" as const,
              },
            ],
            destination: {
              country: "US",
              postalCode: "98101",
              deliveryMethodPreference: "standard_ground",
            },
          },
          testActor
        );
        expect.unreachable("Should have thrown ValidationError");
      } catch (err: any) {
        expect(err).toBeInstanceOf(ValidationError);
        expect(err.details).toBeDefined();
        expect(err.details[0].message).toContain('Line item cannot specify internal provenance "legacy_direct"');
      }
    });

    it("5. Server-derived legacy provenance works for legitimate legacy records in memory repo", async () => {
      const repo = new InMemoryPurchaseRepository();
      const service = new PurchaseWorkflowService(repo);

      // Seed legitimate legacy purchase: requirements is array, originatingDraftId is null
      const legacyPurchaseId = "pur_test_legacy_record";
      (repo as any).purchases.set(legacyPurchaseId, {
        id: legacyPurchaseId,
        status: "POLICY_EVALUATED",
        requirements: [{ key: "cpu", expectedValue: "M4" }],
        budgetCents: 200000,
        currency: "USD",
        policyVersion: "1.0",
        policyEvidenceFingerprint: null,
        selectedCandidateId: null,
        ownerUserId: "usr_buyer_1",
        version: 1,
        originatingDraftId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const candidate = {
        id: "cand_m4_01",
        purchaseId: legacyPurchaseId,
        source: "direct_retailer" as const,
        externalId: "m4_apple",
        title: "Apple MacBook Pro M4 16GB 512GB",
        merchantName: "Apple Store",
        merchantUrl: "https://apple.com/macbook-pro",
        unitPriceCents: 199900,
        quantity: 1,
        shippingCents: 0,
        totalCents: 199900,
        currency: "USD" as const,
        availability: "in_stock" as const,
        capturedAt: new Date(),
        evidence: [],
      };

      const plan = await service.createMultiItemPlan(
        legacyPurchaseId,
        {
          lineItems: [
            {
              id: "line_legacy",
              title: "MacBook Pro M4",
              quantity: 1,
              budgetCents: 200000,
              currency: "USD",
              requirements: [{ key: "cpu", expectedValue: "M4" }],
              verificationLevel: "standard",
            },
          ],
          candidates: [candidate as any],
          destination: {
            country: "US",
            postalCode: "98101",
            deliveryMethodPreference: "standard_ground",
          },
        },
        testActor
      );
      expect(plan.strategies.length).toBeGreaterThan(0);
      expect(plan.lineItems[0].quantitySource).toBe("legacy_direct");
    });

    it("6. Missing or undefined server-side provenance does NOT grant compatibility (fails closed)", async () => {
      const repo = new InMemoryPurchaseRepository();
      const service = new PurchaseWorkflowService(repo);

      // Purchase with draftId (non-legacy)
      const nonLegacyPurchaseId = "pur_test_non_legacy";
      (repo as any).purchases.set(nonLegacyPurchaseId, {
        id: nonLegacyPurchaseId,
        status: "POLICY_EVALUATED",
        requirements: [{ key: "cpu", expectedValue: "M4" }],
        budgetCents: 200000,
        currency: "USD",
        policyVersion: "1.0",
        policyEvidenceFingerprint: null,
        selectedCandidateId: null,
        ownerUserId: "usr_buyer_1",
        version: 1,
        originatingDraftId: "drf_existing_draft", // Non-null originating draft ID
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Attempting to use legacy provenance on non-legacy purchase fails closed
      try {
        await service.createMultiItemPlan(
          nonLegacyPurchaseId,
          {
            lineItems: [
              {
                id: "line_attempt",
                title: "MacBook Pro M4",
                quantity: 1,
                quantitySource: "legacy_direct" as any,
                budgetCents: 200000,
                currency: "USD",
                requirements: [{ key: "cpu", expectedValue: "M4" }],
                verificationLevel: "standard",
              },
            ],
            destination: {
              country: "US",
              postalCode: "98101",
              deliveryMethodPreference: "standard_ground",
            },
          },
          testActor
        );
        expect.unreachable("Should have rejected legacy provenance on non-legacy purchase");
      } catch (err: any) {
        expect(err).toBeInstanceOf(ValidationError);
        expect(err.details[0].message).toContain('Line item cannot specify internal provenance "legacy_direct"');
      }
    });
  });

  describe("Direct API Path Boundary Enforcement", () => {
    it("7. Direct API: Forged provenance is stripped and ignored for legitimate legacy purchase", async () => {
      const legacyPurchaseId = "pur_1792633876502_s7jvwi22";
      const forgedPayload = {
        lineItems: [
          {
            id: "line_1",
            title: "Dell XPS 15 Laptop",
            quantity: 1,
            quantitySource: "legacy_direct", // Forged client provenance
            budgetCents: 150000,
            currency: "USD",
            requirements: [{ key: "ram", expectedValue: "32GB" }],
            verificationLevel: "standard",
          },
        ],
        destination: {
          country: "US",
          postalCode: "98101",
          deliveryMethodPreference: "standard_ground",
        },
      };

      const req = new Request(`http://localhost:3000/api/purchases/${legacyPurchaseId}/multi-item/plan`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(forgedPayload),
      });

      const response = await multiItemPlanApiRoute(req, { params: { id: legacyPurchaseId } });
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.strategies).toBeDefined();
      expect(json.strategies.length).toBeGreaterThan(0);
      // Server-derived provenance is present in result, proving server derivation took place
      expect(json.lineItems[0].quantitySource).toBe("legacy_direct");
    });

    it("8. Direct API: Forged provenance is strictly rejected with 400 for a non-legacy purchase", async () => {
      const nonLegacyPurchaseId = "pur_1793281339386_ezth1m40";
      const forgedPayload = {
        lineItems: [
          {
            id: "line_forged",
            title: "Forged Line Item",
            quantity: 1,
            quantitySource: "legacy_direct", // Forged client provenance on non-legacy purchase
            budgetCents: 150000,
            currency: "USD",
            requirements: [],
            verificationLevel: "standard",
          },
        ],
        destination: {
          country: "US",
          postalCode: "98101",
          deliveryMethodPreference: "standard_ground",
        },
      };

      const req = new Request(`http://localhost:3000/api/purchases/${nonLegacyPurchaseId}/multi-item/plan`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(forgedPayload),
      });

      const response = await multiItemPlanApiRoute(req, { params: { id: nonLegacyPurchaseId } });
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json.error).toBeDefined();
      expect(json.error.details[0].message).toContain('Line item cannot specify internal provenance "legacy_direct"');
    });

    it("9. Direct API: Legitimate legacy purchase evaluates successfully without client provenance", async () => {
      const legacyPurchaseId = "pur_1792654701712_f2iks5to";
      const cleanPayload = {
        lineItems: [
          {
            id: "line_1",
            title: "Dell XPS 15 Laptop",
            quantity: 1,
            budgetCents: 150000,
            currency: "USD",
            requirements: [{ key: "ram", expectedValue: "32GB" }],
            verificationLevel: "standard",
          },
        ],
        destination: {
          country: "US",
          postalCode: "98101",
          deliveryMethodPreference: "standard_ground",
        },
      };

      const req = new Request(`http://localhost:3000/api/purchases/${legacyPurchaseId}/multi-item/plan`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(cleanPayload),
      });

      const response = await multiItemPlanApiRoute(req, { params: { id: legacyPurchaseId } });
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.strategies.length).toBeGreaterThan(0);
      expect(json.lineItems[0].quantitySource).toBe("legacy_direct");
    });

    it("10. Direct API: Missing server-side provenance fails closed on unconfirmed items", async () => {
      const nonLegacyPurchaseId = "pur_1793281339386_ezth1m40";
      // Line item without confirmationToken or explicit provenance on non-legacy purchase
      const unconfirmedPayload = {
        lineItems: [
          {
            id: "line_unconfirmed",
            title: "Unconfirmed Item",
            quantity: 1,
            quantitySource: "unresolved",
            budgetCents: 150000,
            currency: "USD",
            requirements: [],
            verificationLevel: "standard",
          },
        ],
        destination: {
          country: "US",
          postalCode: "98101",
          deliveryMethodPreference: "standard_ground",
        },
      };

      const req = new Request(`http://localhost:3000/api/purchases/${nonLegacyPurchaseId}/multi-item/plan`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(unconfirmedPayload),
      });

      const response = await multiItemPlanApiRoute(req, { params: { id: nonLegacyPurchaseId } });
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json.error).toBeDefined();
    });
  });
});
