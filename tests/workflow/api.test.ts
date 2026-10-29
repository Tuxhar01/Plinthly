import { describe, it, expect, beforeEach } from "vitest";
import { POST as createPurchaseRoute } from "../../app/api/purchases/route";
import { GET as getPurchaseRoute } from "../../app/api/purchases/[id]/route";
import { POST as evaluateRoute } from "../../app/api/purchases/[id]/evaluate/route";
import { POST as approveRoute } from "../../app/api/purchases/[id]/approve/route";
import { GET as getAuditRoute } from "../../app/api/purchases/[id]/audit/route";
import { InMemoryPurchaseRepository, setPurchaseRepository } from "../../lib/workflow/repository";
import { PurchaseWorkflowService, setPurchaseWorkflowService } from "../../lib/workflow/service";
import { setActorResolver, ServerActorResolver } from "../../lib/workflow/auth";

describe("Workflow API Routes", () => {
  let repo: InMemoryPurchaseRepository;
  let service: PurchaseWorkflowService;

  beforeEach(() => {
    process.env.AUTH_MODE = "local_demo";
    setActorResolver(new ServerActorResolver("local_demo"));
    repo = new InMemoryPurchaseRepository();
    service = new PurchaseWorkflowService(repo);
    setPurchaseRepository(repo);
    setPurchaseWorkflowService(service);
  });

  describe("POST /api/purchases", () => {
    it("returns 201 with created purchase data on valid input", async () => {
      const req = new Request("http://localhost:3000/api/purchases", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_api_user",
        },
        body: JSON.stringify({
          budgetCents: 12000,
          currency: "USD",
          requirements: ["organic", { key: "weight", expectedValue: "1kg" }],
        }),
      });

      const res = await createPurchaseRoute(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toMatch(/^pur_/);
      expect(data.status).toBe("REQUIREMENTS_CONFIRMED");
      expect(data.budgetCents).toBe(12000);
      expect(data.ownerUserId).toBe("buyer_api_user");
      expect(data.version).toBe(1);
    });

    it("supports idempotent creation with idempotency key", async () => {
      const payload = {
        budgetCents: 10000,
        currency: "USD",
        requirements: ["spec_item"],
      };

      const req1 = new Request("http://localhost:3000/api/purchases", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_idem_user",
          "idempotency-key": "idem_purchase_001",
        },
        body: JSON.stringify(payload),
      });

      const res1 = await createPurchaseRoute(req1);
      expect(res1.status).toBe(201);
      const data1 = await res1.json();

      // Retry with identical key and payload returns cached 201 response with same purchase ID
      const req2 = new Request("http://localhost:3000/api/purchases", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_idem_user",
          "idempotency-key": "idem_purchase_001",
        },
        body: JSON.stringify(payload),
      });

      const res2 = await createPurchaseRoute(req2);
      expect(res2.status).toBe(201);
      const data2 = await res2.json();
      expect(data2.id).toBe(data1.id);

      // Reusing the same key with different payload returns 409 idempotency_conflict
      const req3 = new Request("http://localhost:3000/api/purchases", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_idem_user",
          "idempotency-key": "idem_purchase_001",
        },
        body: JSON.stringify({ ...payload, budgetCents: 99999 }),
      });

      const res3 = await createPurchaseRoute(req3);
      expect(res3.status).toBe(409);
      const data3 = await res3.json();
      expect(data3.error.code).toBe("idempotency_conflict");
    });

    it("returns 400 when body is malformed JSON", async () => {
      const req = new Request("http://localhost:3000/api/purchases", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_user",
        },
        body: "{ bad-json",
      });

      const res = await createPurchaseRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("invalid_json");
    });

    it("returns 400 when validation fails", async () => {
      const req = new Request("http://localhost:3000/api/purchases", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_user",
        },
        body: JSON.stringify({
          budgetCents: -50,
          currency: "EUR",
          requirements: [],
        }),
      });

      const res = await createPurchaseRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("validation_error");
    });
  });

  describe("GET /api/purchases/[id]", () => {
    it("returns 200 with purchase details for authorized owner", async () => {
      const created = await service.createPurchase(
        {
          budgetCents: 5000,
          currency: "USD",
          requirements: ["item"],
        },
        { kind: "user", userId: "usr_owner_1" }
      );

      const req = new Request(`http://localhost:3000/api/purchases/${created.id}`, {
        headers: { "x-actor-id": "usr_owner_1" },
      });
      const res = await getPurchaseRoute(req, { params: Promise.resolve({ id: created.id }) });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(created.id);
      expect(data.budgetCents).toBe(5000);
      expect(data.ownerUserId).toBe("usr_owner_1");
    });

    it("returns 403 when accessed by unauthorized user", async () => {
      const created = await service.createPurchase(
        {
          budgetCents: 5000,
          currency: "USD",
          requirements: ["item"],
        },
        { kind: "user", userId: "usr_owner_1" }
      );

      const req = new Request(`http://localhost:3000/api/purchases/${created.id}`, {
        headers: { "x-actor-id": "usr_attacker_2" },
      });
      const res = await getPurchaseRoute(req, { params: Promise.resolve({ id: created.id }) });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.code).toBe("forbidden");
    });

    it("returns 404 for unknown purchase id", async () => {
      const req = new Request("http://localhost:3000/api/purchases/unknown_id", {
        headers: { "x-actor-id": "usr_1" },
      });
      const res = await getPurchaseRoute(req, { params: Promise.resolve({ id: "unknown_id" }) });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe("not_found");
    });
  });

  describe("POST /api/purchases/[id]/evaluate", () => {
    it("returns 200 and evaluation outcome", async () => {
      const created = await service.createPurchase(
        {
          budgetCents: 6000,
          currency: "USD",
          requirements: ["spec"],
        },
        { kind: "user", userId: "usr_1" }
      );

      const req = new Request(`http://localhost:3000/api/purchases/${created.id}/evaluate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "usr_1",
        },
        body: JSON.stringify({
          rawCandidate: {
            externalId: "ext_item_2",
            title: "Test Item",
            merchantName: "Merchant Inc",
            merchantUrl: "https://merchant.com/item",
            unitPriceCents: 4000,
            quantity: 1,
            shippingCents: 0,
            currency: "USD",
            availability: "IN_STOCK",
          },
          rawObservations: [
            {
              requirementKey: "spec",
              value: "valid",
              status: "supports",
              sourceUrl: "https://merchant.com/item",
              sourceType: "merchant_spec",
              capturedAt: new Date().toISOString(),
            },
          ],
          requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
        }),
      });

      const res = await evaluateRoute(req, { params: Promise.resolve({ id: created.id }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("POLICY_PASSED");
      expect(data.summary.allRequiredPassed).toBe(true);
      expect(data.version).toBe(2);
    });
  });

  describe("POST /api/purchases/[id]/approve", () => {
    it("returns 200 on valid buyer approval", async () => {
      const created = await service.createPurchase(
        {
          budgetCents: 5000,
          currency: "USD",
          requirements: ["spec"],
        },
        { kind: "user", userId: "buyer_42" }
      );

      const now = new Date();
      const evalRes = await service.evaluatePurchaseCandidate(
        created.id,
        {
          rawCandidate: {
            externalId: "ext_approved",
            title: "Item",
            merchantName: "Store",
            merchantUrl: "https://store.com/1",
            unitPriceCents: 3000,
            quantity: 1,
            shippingCents: 0,
            currency: "USD",
            availability: "IN_STOCK",
          },
          rawObservations: [
            {
              requirementKey: "spec",
              value: "ok",
              status: "supports",
              sourceUrl: "https://store.com/1",
              sourceType: "spec",
              capturedAt: now.toISOString(),
            },
          ],
          requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
        },
        { kind: "user", userId: "buyer_42" },
        now
      );

      const req = new Request(`http://localhost:3000/api/purchases/${created.id}/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_42",
          "x-actor-kind": "user",
        },
        body: JSON.stringify({
          expectedSnapshotHash: evalRes.snapshotHash,
          expectedEvidenceFingerprint: evalRes.evidenceFingerprint,
          expectedTotalCents: 3000,
          expectedCurrency: "USD",
        }),
      });

      const res = await approveRoute(req, { params: Promise.resolve({ id: created.id }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("APPROVED");
      expect(data.approvalId).toMatch(/^appr_/);
    });

    it("returns 422 when approval integrity check fails (tampered total amount)", async () => {
      const created = await service.createPurchase(
        {
          budgetCents: 5000,
          currency: "USD",
          requirements: ["spec"],
        },
        { kind: "user", userId: "buyer_42" }
      );

      const evalRes = await service.evaluatePurchaseCandidate(
        created.id,
        {
          rawCandidate: {
            externalId: "ext_item",
            title: "Item",
            merchantName: "Store",
            merchantUrl: "https://store.com/1",
            unitPriceCents: 3000,
            quantity: 1,
            shippingCents: 0,
            currency: "USD",
            availability: "IN_STOCK",
          },
          rawObservations: [
            {
              requirementKey: "spec",
              value: "verified",
              status: "supports",
              sourceUrl: "https://store.com/1",
              sourceType: "merchant_spec",
              capturedAt: new Date().toISOString(),
            },
          ],
          requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
        },
        { kind: "user", userId: "buyer_42" }
      );

      const req = new Request(`http://localhost:3000/api/purchases/${created.id}/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_42",
        },
        body: JSON.stringify({
          expectedSnapshotHash: evalRes.snapshotHash,
          expectedTotalCents: 1000,
        }),
      });

      const res = await approveRoute(req, { params: Promise.resolve({ id: created.id }) });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error.code).toBe("amount_mismatch");
    });
  });

  describe("GET /api/purchases/[id]/audit", () => {
    it("returns 200 with list of audit events for owner", async () => {
      const created = await service.createPurchase(
        {
          budgetCents: 5000,
          currency: "USD",
          requirements: ["item"],
        },
        { kind: "user", userId: "usr_1" }
      );

      const req = new Request(`http://localhost:3000/api/purchases/${created.id}/audit`, {
        headers: { "x-actor-id": "usr_1" },
      });
      const res = await getAuditRoute(req, { params: Promise.resolve({ id: created.id }) });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.purchaseId).toBe(created.id);
      expect(Array.isArray(data.events)).toBe(true);
      expect(data.events.length).toBeGreaterThanOrEqual(1);
    });

    it("returns 403 when audit history accessed by unauthorized user", async () => {
      const created = await service.createPurchase(
        {
          budgetCents: 5000,
          currency: "USD",
          requirements: ["item"],
        },
        { kind: "user", userId: "usr_1" }
      );

      const req = new Request(`http://localhost:3000/api/purchases/${created.id}/audit`, {
        headers: { "x-actor-id": "unauthorized_snooper" },
      });
      const res = await getAuditRoute(req, { params: Promise.resolve({ id: created.id }) });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.code).toBe("forbidden");
    });
  });
});
