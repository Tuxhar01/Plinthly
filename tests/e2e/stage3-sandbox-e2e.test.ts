import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import { setActorResolver, ServerActorResolver } from "../../lib/workflow/auth";
import { POST as allocateRoute } from "../../app/api/cart/allocate/route";
import { POST as checkoutRoute } from "../../app/api/cart/checkout/route";
import { POST as captureRoute } from "../../app/api/cart/capture/route";
import { POST as refundRoute } from "../../app/api/cart/refund/route";
import { GET as statusRoute } from "../../app/api/cart/status/[cartId]/route";
import { GET as metricsRoute } from "../../app/api/metrics/route";
import { triageGatewayOrder } from "../../scripts/ops/reconcile-gateway-order";
import {
  createStage2Client,
  ensureRolesExist,
  createTestTaxCert,
  createTestKeys,
} from "../database/helpers/routine-test-helper";

describe("Stage 3 Phase 5: End-to-End Sandbox Procurement Journey (OPS-06)", () => {
  let masterClient: Client;
  const authorityId = "AUTH-E2E-TEST";
  const certNumber = "CERT-E2E-2026";
  const attestKeyId = "vak_tax_worker_p3_01";
  const hmacKeyId = "audit_hmac_key_2026";

  beforeAll(async () => {
    masterClient = await createStage2Client();
    await ensureRolesExist(masterClient);
    await createTestTaxCert(masterClient, authorityId, certNumber);
    await createTestKeys(masterClient, attestKeyId, hmacKeyId, "tax_worker_01");

    process.env.AUTH_MODE = "local_demo";
    process.env.ENABLE_LOCAL_DEMO_AUTH = "true";
    setActorResolver(new ServerActorResolver("local_demo"));
  });

  afterAll(async () => {
    await masterClient.end();
  });

  it("executes complete lifecycle: allocation -> checkout -> sequential capture -> evidence -> refund -> metrics", async () => {
    // -------------------------------------------------------------------------
    // Step 1: Relational Cart Allocation (POST /api/cart/allocate)
    // -------------------------------------------------------------------------
    const allocateReq = new Request("http://localhost:3000/api/cart/allocate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-plinthly-actor-id": "usr_buyer_1",
      },
      body: JSON.stringify({
        strategy: "e2e_multi_retailer_split",
        planLifecycleStatus: "ACTIVE",
        lineItems: [
          {
            itemDescription: "Developer Laptop 16GB",
            targetQuantity: 1,
            maxUnitCents: 120000,
          },
          {
            itemDescription: "Ergonomic Mechanical Keyboard",
            targetQuantity: 1,
            maxUnitCents: 15000,
          },
        ],
        carts: [
          {
            merchantId: "bestbuy_us",
            merchantPayeeEmail: "payee-bb@plinthly.test",
            merchandiseSubtotalCents: 120000,
            discountCents: 0,
            shippingTotalCents: 0,
            taxAmountCents: 0,
            totalCartCents: 120000,
            currency: "USD",
            paypalOrderId: "ord_bb_e2e",
            allocations: [
              {
                lineItemIndex: 0,
                allocatedQuantity: 1,
                allocatedUnitCents: 120000,
              },
            ],
          },
          {
            merchantId: "keychron_us",
            merchantPayeeEmail: "payee-kc@plinthly.test",
            merchandiseSubtotalCents: 15000,
            discountCents: 0,
            shippingTotalCents: 1000,
            taxAmountCents: 0,
            totalCartCents: 16000,
            currency: "USD",
            allocations: [
              {
                lineItemIndex: 1,
                allocatedQuantity: 1,
                allocatedUnitCents: 15000,
              },
            ],
          },
        ],
        snapshotPayload: { e2e: true, stage: "Phase 5 Gate 3 E2E" },
      }),
    });

    const allocRes = await allocateRoute(allocateReq);
    expect(allocRes.status).toBe(201);
    const allocData = await allocRes.json();

    expect(allocData.success).toBe(true);
    expect(allocData.approvalAggregateId).toBeDefined();
    expect(allocData.cartIds).toHaveLength(2);
    const aggregateId = allocData.approvalAggregateId;
    const [cart1Id, cart2Id] = allocData.cartIds;

    // -------------------------------------------------------------------------
    // Step 2: Multi-Cart Checkout Initiation (POST /api/cart/checkout)
    // -------------------------------------------------------------------------
    const checkoutReq = new Request("http://localhost:3000/api/cart/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-plinthly-actor-id": "usr_buyer_1",
      },
      body: JSON.stringify({
        approvalAggregateId: aggregateId,
      }),
    });

    const checkoutRes = await checkoutRoute(checkoutReq);
    expect(checkoutRes.status).toBe(200);
    const checkoutData = await checkoutRes.json();
    expect(checkoutData.status).toBe("BUYER_APPROVED");
    expect(checkoutData.totalCarts).toBe(2);

    // -------------------------------------------------------------------------
    // Step 3: Sequential Cart Capture & Webhook Reconciliation (POST /api/cart/capture)
    // -------------------------------------------------------------------------
    // 3a. Initial Capture dispatch to Gateway
    const captureReq1 = new Request("http://localhost:3000/api/cart/capture", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-plinthly-actor-id": "usr_buyer_1",
      },
      body: JSON.stringify({
        approvalAggregateId: aggregateId,
        cartId: cart1Id,
      }),
    });

    const capRes1 = await captureRoute(captureReq1);
    expect(capRes1.status).toBe(200);
    const capData1 = await capRes1.json();
    expect(capData1.status).toBe("CAPTURING");
    expect(capData1.outcome).toBe("PREPARED_AWAITING_WEBHOOK");
    expect(capData1.captureId).toBeDefined();

    // 3b. Asynchronous Webhook Reconciler / OPS Triage Tool confirmation via R2-05
    const triageRes = await triageGatewayOrder({
      cartId: cart1Id,
      action: "confirm",
      captureId: capData1.captureId,
    });
    expect(triageRes.currentStatus).toBe("CAPTURED");
    expect(triageRes.reconciliationOutcome).toContain("CONFIRMED via R2-05");

    // -------------------------------------------------------------------------
    // Step 4: Verify Cart Status & Payment Evidence (GET /api/cart/status/[cartId])
    // -------------------------------------------------------------------------
    const statusReq = new Request(`http://localhost:3000/api/cart/status/${cart1Id}`, {
      method: "GET",
      headers: {
        "x-plinthly-actor-id": "usr_buyer_1",
      },
    });

    const statusRes = await statusRoute(statusReq, {
      params: Promise.resolve({ cartId: cart1Id }),
    });
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData.cart.checkoutStatus).toBe("CAPTURED");
    expect(statusData.paymentEvidence).not.toBeNull();
    expect(Number(statusData.paymentEvidence.amount_cents)).toBe(120000);

    // -------------------------------------------------------------------------
    // Step 5: Execute Durable Pre-Persisted Partial Refund (POST /api/cart/refund)
    // -------------------------------------------------------------------------
    const refundKey = `e2e_refund_key_${crypto.randomUUID()}`;
    const refundReq = new Request("http://localhost:3000/api/cart/refund", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-plinthly-actor-id": "usr_buyer_1",
        "Idempotency-Key": refundKey,
      },
      body: JSON.stringify({
        cartId: cart1Id,
        amountCents: 2000,
        reason: "Customer promotion adjustment",
      }),
    });

    const refundRes = await refundRoute(refundReq);
    expect(refundRes.status).toBe(200);
    const refundData = await refundRes.json();
    expect(refundData.success).toBe(true);
    expect(refundData.outcome).toBe("COMPLETED");

    // Verify refund intent persisted in PostgreSQL
    const refCheck = await masterClient.query(
      `SELECT id, status, amount_cents FROM public."CartRefundRecord" WHERE cart_id = $1 AND idempotency_key = $2`,
      [cart1Id, refundKey]
    );
    expect(refCheck.rows).toHaveLength(1);
    expect(refCheck.rows[0].status).toBe("COMPLETED");
    expect(Number(refCheck.rows[0].amount_cents)).toBe(2000);

    // -------------------------------------------------------------------------
    // Step 6: Query Telemetry Metrics (GET /api/metrics)
    // -------------------------------------------------------------------------
    const metricsRes = await metricsRoute();
    expect(metricsRes.status).toBe(200);
    const metricsBody = await metricsRes.text();
    expect(metricsBody).toContain("plinthly_landed_cost_variance_cents");
    expect(metricsBody).toContain("plinthly_cart_capture_total");
  });
});
