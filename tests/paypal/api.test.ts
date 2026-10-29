import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as createOrderRoute } from "../../app/api/purchases/[id]/paypal/create-order/route";
import { POST as confirmApprovalRoute } from "../../app/api/purchases/[id]/paypal/confirm-approval/route";
import { POST as verifyRoute } from "../../app/api/purchases/[id]/paypal/verify/route";
import { GET as returnRoute } from "../../app/api/purchases/[id]/paypal/return/route";
import { GET as cancelRoute } from "../../app/api/purchases/[id]/paypal/cancel/route";
import {
  InMemoryPurchaseRepository,
  setPurchaseRepository,
} from "../../lib/workflow/repository";
import {
  PurchaseWorkflowService,
  setPurchaseWorkflowService,
} from "../../lib/workflow/service";
import { setActorResolver, ServerActorResolver, Actor } from "../../lib/workflow/auth";
import { PayPalSandboxClient } from "../../lib/paypal/client";

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("PayPal Workflow API Routes (Mocked HTTP)", () => {
  let repo: InMemoryPurchaseRepository;
  let service: PurchaseWorkflowService;
  let mockPayPalClient: Partial<PayPalSandboxClient>;
  const userActor: Actor = { kind: "user", userId: "buyer_route_user" };

  beforeEach(() => {
    process.env.AUTH_MODE = "local_demo";
    setActorResolver(new ServerActorResolver("local_demo"));

    repo = new InMemoryPurchaseRepository();

    mockPayPalClient = {
      createOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL_ROUTE_ORDER_123",
        status: "CREATED",
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL_ROUTE_ORDER_123",
            rel: "approve",
            method: "GET",
          },
        ],
      }),
      getOrder: vi.fn().mockResolvedValue({
        id: "PAYPAL_ROUTE_ORDER_123",
        status: "APPROVED",
        intent: "AUTHORIZE",
        create_time: new Date().toISOString(),
        purchase_units: [
          {
            reference_id: "placeholder",
            amount: { currency_code: "USD", value: "30.00" },
          },
        ],
      }),
    };

    service = new PurchaseWorkflowService(repo, mockPayPalClient as PayPalSandboxClient);
    setPurchaseRepository(repo);
    setPurchaseWorkflowService(service);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setupApprovedPurchase(totalCents: number = 3000) {
    const created = await service.createPurchase(
      {
        budgetCents: 5000,
        currency: "USD",
        requirements: ["spec"],
      },
      userActor
    );

    const now = new Date();
    const evalRes = await service.evaluatePurchaseCandidate(
      created.id,
      {
        rawCandidate: {
          externalId: "ext_item_route",
          title: "Item Route Test",
          merchantName: "Trusted Merchant",
          merchantUrl: "https://merchant.com/item",
          unitPriceCents: totalCents,
          quantity: 1,
          shippingCents: 0,
          currency: "USD",
          availability: "IN_STOCK",
        },
        rawObservations: [
          {
            requirementKey: "spec",
            value: "pass",
            status: "supports",
            sourceUrl: "https://merchant.com/item",
            sourceType: "feed",
            capturedAt: now.toISOString(),
          },
        ],
        requiredRuleKeys: ["P-BUDGET", "P-CURRENCY"],
      },
      userActor,
      now
    );

    await service.approvePurchase(
      created.id,
      {
        expectedSnapshotHash: evalRes.snapshotHash,
      },
      userActor,
      now
    );

    return { purchaseId: created.id };
  }

  describe("POST /api/purchases/[id]/paypal/create-order", () => {
    it("returns 401 when actor resolution fails in production mode", async () => {
      setActorResolver(new ServerActorResolver("production"));
      const req = new Request("http://localhost:3000/api/purchases/pur_1/paypal/create-order", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "idemp_1" }),
      });

      const res = await createOrderRoute(req, makeParams("pur_1"));
      expect(res.status).toBe(401);
    });

    it("returns 403 when actor does not own purchase", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);

      const req = new Request(`http://localhost:3000/api/purchases/${purchaseId}/paypal/create-order`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "intruder_user",
        },
        body: JSON.stringify({ idempotencyKey: "idemp_1" }),
      });

      const res = await createOrderRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(403);
    });

    it("creates PayPal Sandbox order and returns 201 with order metadata", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);

      const req = new Request(`http://localhost:3000/api/purchases/${purchaseId}/paypal/create-order`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_route_user",
        },
        body: JSON.stringify({ idempotencyKey: "idemp_route_1" }),
      });

      const res = await createOrderRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.paypalOrderId).toBe("PAYPAL_ROUTE_ORDER_123");
      expect(data.status).toBe("ORDER_CREATED");
      expect(data.amountCents).toBe(3000);
      expect(data.currency).toBe("USD");
      expect(data.approvalUrl).toContain("checkoutnow");
    });
  });

  describe("POST /api/purchases/[id]/paypal/confirm-approval (Authoritative Confirmation)", () => {
    it("returns 401 when actor resolution fails in production mode", async () => {
      setActorResolver(new ServerActorResolver("production"));
      const req = new Request("http://localhost:3000/api/purchases/pur_1/paypal/confirm-approval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paypalOrderId: "PAYPAL_ROUTE_ORDER_123" }),
      });

      const res = await confirmApprovalRoute(req, makeParams("pur_1"));
      expect(res.status).toBe(401);
    });

    it("returns 403 when called by unauthorized actor (intruder)", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_order_auth_fail",
      });

      const req = new Request(`http://localhost:3000/api/purchases/${purchaseId}/paypal/confirm-approval`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "intruder_user",
        },
        body: JSON.stringify({ paypalOrderId: "PAYPAL_ROUTE_ORDER_123" }),
      });

      const res = await confirmApprovalRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(403);
    });

    it("confirms buyer approval and returns 200 with BUYER_APPROVED status when called by owner", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);

      // Create order first
      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_order_1",
      });

      vi.mocked(mockPayPalClient.getOrder!).mockResolvedValue({
        id: "PAYPAL_ROUTE_ORDER_123",
        status: "APPROVED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "30.00" },
          },
        ],
      });

      const req = new Request(`http://localhost:3000/api/purchases/${purchaseId}/paypal/confirm-approval`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_route_user",
        },
        body: JSON.stringify({ paypalOrderId: "PAYPAL_ROUTE_ORDER_123" }),
      });

      const res = await confirmApprovalRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("BUYER_APPROVED");
      expect(data.id).toBe(purchaseId);

      // Verify state in repository
      const updated = await repo.getPurchaseById(purchaseId);
      expect(updated?.purchase.status).toBe("BUYER_APPROVED");
      expect(updated?.purchase.version).toBe(5);
    });

    it("returns 400 when supplied paypalOrderId token does not match active payment attempt", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_order_token_mismatch",
      });

      const req = new Request(`http://localhost:3000/api/purchases/${purchaseId}/paypal/confirm-approval`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_route_user",
        },
        body: JSON.stringify({ paypalOrderId: "FOREIGN_TOKEN_999" }),
      });

      const res = await confirmApprovalRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("order_id_mismatch");
    });

    it("returns 400 when PayPal remote reference_id does not match purchase ID", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);

      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_order_2",
      });

      vi.mocked(mockPayPalClient.getOrder!).mockResolvedValue({
        id: "PAYPAL_ROUTE_ORDER_123",
        status: "APPROVED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: "mismatched_foreign_purchase_id",
            amount: { currency_code: "USD", value: "30.00" },
          },
        ],
      });

      const req = new Request(`http://localhost:3000/api/purchases/${purchaseId}/paypal/confirm-approval`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_route_user",
        },
        body: JSON.stringify({ paypalOrderId: "PAYPAL_ROUTE_ORDER_123" }),
      });

      const res = await confirmApprovalRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("reference_id_mismatch");
    });

    it("returns 400 when PayPal remote amount does not match approved terms", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_order_amt_mismatch",
      });

      vi.mocked(mockPayPalClient.getOrder!).mockResolvedValue({
        id: "PAYPAL_ROUTE_ORDER_123",
        status: "APPROVED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "99.99" }, // Mismatched!
          },
        ],
      });

      const req = new Request(`http://localhost:3000/api/purchases/${purchaseId}/paypal/confirm-approval`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_route_user",
        },
        body: JSON.stringify({ paypalOrderId: "PAYPAL_ROUTE_ORDER_123" }),
      });

      const res = await confirmApprovalRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("amount_mismatch");
    });

    it("returns 400 when PayPal remote currency does not match approved terms", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_order_curr_mismatch",
      });

      vi.mocked(mockPayPalClient.getOrder!).mockResolvedValue({
        id: "PAYPAL_ROUTE_ORDER_123",
        status: "APPROVED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "EUR", value: "30.00" }, // Mismatched!
          },
        ],
      });

      const req = new Request(`http://localhost:3000/api/purchases/${purchaseId}/paypal/confirm-approval`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_route_user",
        },
        body: JSON.stringify({ paypalOrderId: "PAYPAL_ROUTE_ORDER_123" }),
      });

      const res = await confirmApprovalRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("currency_mismatch");
    });

    it("returns 400 when PayPal remote status is not yet APPROVED", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_order_not_app",
      });

      vi.mocked(mockPayPalClient.getOrder!).mockResolvedValue({
        id: "PAYPAL_ROUTE_ORDER_123",
        status: "CREATED", // Not approved yet
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "30.00" },
          },
        ],
      });

      const req = new Request(`http://localhost:3000/api/purchases/${purchaseId}/paypal/confirm-approval`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_route_user",
        },
        body: JSON.stringify({ paypalOrderId: "PAYPAL_ROUTE_ORDER_123" }),
      });

      const res = await confirmApprovalRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("payment_not_yet_approved");
    });

    it("idempotently returns existing status without duplicate transition when already BUYER_APPROVED", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_order_idem",
      });

      vi.mocked(mockPayPalClient.getOrder!).mockResolvedValue({
        id: "PAYPAL_ROUTE_ORDER_123",
        status: "APPROVED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "30.00" },
          },
        ],
      });

      // First confirmation
      await service.confirmBuyerApproval(purchaseId, userActor, {
        paypalOrderId: "PAYPAL_ROUTE_ORDER_123",
      });

      // Second confirmation request
      const req = new Request(`http://localhost:3000/api/purchases/${purchaseId}/paypal/confirm-approval`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_route_user",
        },
        body: JSON.stringify({ paypalOrderId: "PAYPAL_ROUTE_ORDER_123" }),
      });

      const res = await confirmApprovalRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("BUYER_APPROVED");
    });
  });

  describe("POST /api/purchases/[id]/paypal/verify", () => {
    it("returns 200 with verification outcome when called by authorized owner", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);

      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_order_v",
      });

      vi.mocked(mockPayPalClient.getOrder!).mockResolvedValue({
        id: "PAYPAL_ROUTE_ORDER_123",
        status: "APPROVED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: purchaseId,
            amount: { currency_code: "USD", value: "30.00" },
          },
        ],
      });

      const req = new Request(`http://localhost:3000/api/purchases/${purchaseId}/paypal/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "buyer_route_user",
        },
      });

      const res = await verifyRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.outcome).toBe("BUYER_APPROVED");
      expect(data.verified).toBe(true);
      expect(data.purchaseId).toBe(purchaseId);
    });

    it("returns 403 when verify route is called by an unauthorized user", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);

      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_order_v2",
      });

      const req = new Request(`http://localhost:3000/api/purchases/${purchaseId}/paypal/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "intruder_route_user",
        },
      });

      const res = await verifyRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/purchases/[id]/paypal/return (PayPal Return Callback Bridge)", () => {
    it("returns 400 when purchase ID is invalid or missing", async () => {
      const req = new Request("http://127.0.0.1:3001/api/purchases/   /paypal/return?token=ORDER_123", {
        method: "GET",
      });

      const res = await returnRoute(req, makeParams("   "));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("invalid_input");
    });

    it("returns 400 JSON when token query param is missing for JSON clients", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      const req = new Request(`http://127.0.0.1:3001/api/purchases/${purchaseId}/paypal/return`, {
        method: "GET",
        headers: { accept: "application/json" },
      });

      const res = await returnRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("missing_token");
    });

    it("redirects browser with paypal_error when token query param is missing", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      const req = new Request(`http://127.0.0.1:3001/api/purchases/${purchaseId}/paypal/return`, {
        method: "GET",
        headers: { accept: "text/html" },
      });

      const res = await returnRoute(req, makeParams(purchaseId));
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      const location = res.headers.get("location");
      expect(location).toContain(`purchaseId=${purchaseId}`);
      expect(location).toContain("paypal_error=missing_token");
    });

    it("functions as a redirect bridge without requiring custom actor headers and without mutating state", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_bridge_test",
      });

      // Browser request from PayPal: NO custom headers (no x-actor-id)
      const req = new Request(
        `http://127.0.0.1:3001/api/purchases/${purchaseId}/paypal/return?token=PAYPAL_ROUTE_ORDER_123&PayerID=PAYER_ABC`,
        {
          method: "GET",
          headers: {
            accept: "text/html,application/xhtml+xml",
          },
        }
      );

      const res = await returnRoute(req, makeParams(purchaseId));

      // Must be a 3xx redirect
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      const location = res.headers.get("location");
      expect(location).toContain(`purchaseId=${purchaseId}`);
      expect(location).toContain("paypal_token=PAYPAL_ROUTE_ORDER_123");
      expect(location).toContain("paypal_status=approved");

      // CRITICAL INVARIANT: Return bridge MUST NOT directly mutate purchase state
      const purchaseAfterBridge = await repo.getPurchaseById(purchaseId);
      expect(purchaseAfterBridge?.purchase.status).toBe("ORDER_CREATED"); // NOT BUYER_APPROVED yet!
      expect(purchaseAfterBridge?.purchase.version).toBe(4);
    });

    it("returns 200 JSON for API clients without mutating purchase state", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_bridge_json_test",
      });

      const req = new Request(
        `http://127.0.0.1:3001/api/purchases/${purchaseId}/paypal/return?token=PAYPAL_ROUTE_ORDER_123`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
          },
        }
      );

      const res = await returnRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.bridged).toBe(true);
      expect(data.purchaseId).toBe(purchaseId);
      expect(data.paypalOrderId).toBe("PAYPAL_ROUTE_ORDER_123");

      // State remains ORDER_CREATED
      const purchaseAfter = await repo.getPurchaseById(purchaseId);
      expect(purchaseAfter?.purchase.status).toBe("ORDER_CREATED");
    });

    it("safely routes unexpected internal exceptions through handleApiError without leaking details", async () => {
      const badContext = {
        get params() {
          throw new Error("SensitiveDatabaseConnectionString_Password123!");
        },
      };

      const req = new Request("http://127.0.0.1:3001/api/purchases/pur_test/paypal/return?token=ORDER_123");
      const res = await returnRoute(req, badContext as unknown as { params: { id: string } });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error.code).toBe("internal_error");
      expect(data.error.message).toBe("An internal server error occurred.");
      expect(JSON.stringify(data)).not.toContain("SensitiveDatabaseConnectionString_Password123!");
    });
  });

  describe("GET /api/purchases/[id]/paypal/cancel (PayPal Cancel Callback)", () => {
    it("returns 401 when actor resolution fails in production mode", async () => {
      setActorResolver(new ServerActorResolver("production"));
      const req = new Request("http://127.0.0.1:3001/api/purchases/pur_1/paypal/cancel", {
        method: "GET",
      });

      const res = await cancelRoute(req, makeParams("pur_1"));
      expect(res.status).toBe(401);
    });

    it("returns 404 when purchase does not exist", async () => {
      const req = new Request("http://127.0.0.1:3001/api/purchases/pur_nonexistent/paypal/cancel", {
        method: "GET",
        headers: { "x-actor-id": "buyer_route_user" },
      });

      const res = await cancelRoute(req, makeParams("pur_nonexistent"));
      expect(res.status).toBe(404);
    });

    it("handles cancellation without approving, capturing, or altering approved terms", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_cancel_test",
      });

      const before = await repo.getPurchaseById(purchaseId);
      expect(before?.purchase.status).toBe("ORDER_CREATED");
      const initialVersion = before?.purchase.version;
      const initialApproval = before?.approvals[0];

      const req = new Request(
        `http://127.0.0.1:3001/api/purchases/${purchaseId}/paypal/cancel?token=PAYPAL_ROUTE_ORDER_123`,
        {
          method: "GET",
          headers: {
            "x-actor-id": "buyer_route_user",
            accept: "application/json",
          },
        }
      );

      const res = await cancelRoute(req, makeParams(purchaseId));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.cancelled).toBe(true);
      expect(data.status).toBe("ORDER_CREATED");

      // Verify invariants in repository:
      const after = await repo.getPurchaseById(purchaseId);
      expect(after?.purchase.status).toBe("ORDER_CREATED"); // Must NOT be BUYER_APPROVED, COMPLETED, or CANCELLED
      expect(after?.purchase.version).toBe(initialVersion); // Version unchanged
      expect(after?.approvals[0].totalCents).toBe(initialApproval?.totalCents); // Amount unchanged
      expect(after?.approvals[0].snapshotHash).toBe(initialApproval?.snapshotHash); // Snapshot unchanged
      expect(after?.approvals[0].invalidatedAt).toBeNull(); // Approval remains effective
    });

    it("redirects browser to application dashboard upon cancellation", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_cancel_redirect",
      });

      const req = new Request(
        `http://127.0.0.1:3001/api/purchases/${purchaseId}/paypal/cancel?token=PAYPAL_ROUTE_ORDER_123`,
        {
          method: "GET",
          headers: {
            "x-actor-id": "buyer_route_user",
            accept: "text/html,application/xhtml+xml",
          },
        }
      );

      const res = await cancelRoute(req, makeParams(purchaseId));
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      const location = res.headers.get("location");
      expect(location).toContain(`purchaseId=${purchaseId}`);
      expect(location).toContain("paypal_status=cancelled");
    });
  });

  describe("Safety Invariants: No Capture Endpoint or Transition", () => {
    it("guarantees no PayPal capture endpoint is ever called in return or cancel flows", async () => {
      const { purchaseId } = await setupApprovedPurchase(3000);
      await service.createPayPalOrder(purchaseId, userActor, {
        idempotencyKey: "idemp_no_cap",
      });

      // Call return route
      const returnReq = new Request(
        `http://127.0.0.1:3001/api/purchases/${purchaseId}/paypal/return?token=PAYPAL_ROUTE_ORDER_123`,
        {
          method: "GET",
          headers: { "x-actor-id": "buyer_route_user", accept: "application/json" },
        }
      );
      await returnRoute(returnReq, makeParams(purchaseId));

      // Call cancel route
      const cancelReq = new Request(
        `http://127.0.0.1:3001/api/purchases/${purchaseId}/paypal/cancel?token=PAYPAL_ROUTE_ORDER_123`,
        {
          method: "GET",
          headers: { "x-actor-id": "buyer_route_user", accept: "application/json" },
        }
      );
      await cancelRoute(cancelReq, makeParams(purchaseId));

      // Check repository: neither purchase status nor attempt status is COMPLETED or CAPTURE_ATTEMPTED
      const current = await repo.getPurchaseById(purchaseId);
      expect(current?.purchase.status).not.toBe("CAPTURE_ATTEMPTED");
      expect(current?.purchase.status).not.toBe("COMPLETED");

      const attempts = current?.paymentAttempts || [];
      for (const att of attempts) {
        expect(att.status).not.toBe("COMPLETED");
      }
    });
  });
});
