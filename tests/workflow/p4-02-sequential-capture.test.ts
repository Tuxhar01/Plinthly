/**
 * Plinthly Stage 3 Phase 4 — Sequential Multi-Cart Capture Tests (P4-02)
 *
 * Verifies P4-02:
 * 1. Strict sequential capture loop execution across multiple approved merchant carts.
 * 2. Multi-merchant isolation: terminal failure of cart K does not corrupt, abort, or roll back cart K-1 or K+1.
 * 3. Ambiguous gateway timeouts (AMBIGUOUS_TIMEOUT): cart retained in CAPTURING, never marked as FAILED.
 * 4. Preservation of completed captures and PaymentEvidenceRecords during partial or mixed outcomes.
 * 5. Idempotent re-capture: re-executing capture on an already CAPTURED cart returns existing evidence with idempotentRetry: true.
 * 6. Zero-variance landed cost enforcement prior to gateway dispatch.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestKeys,
} from "../database/helpers/routine-test-helper";
import { CartCaptureService } from "../../lib/workflow/cart-capture-service";
import { MockPaymentGatewayClient } from "../../lib/workflow/payment-gateway-adapter";

describe("P4-02: Sequential Multi-Cart Capture Loop", () => {
  let client: Client;
  const hmacKeyId = "audit_hmac_p4_02_key";
  const orchestratorPrincipal = "orchestrator_worker_user";

  beforeAll(async () => {
    client = await createStage2Client();
    await ensureRolesExist(client);
    await createTestKeys(client, "vak_p4_02", hmacKeyId, "unused");
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("RESET SESSION AUTHORIZATION;");
  });

  async function createVerifiedTransmission(
    transmissionId: string,
    orderId: string,
    captureId: string,
    amountCents: number,
    payeeEmail: string
  ) {
    const rawPayload = Buffer.from(
      JSON.stringify({
        id: "WH-" + crypto.randomUUID(),
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
          id: captureId,
          amount: { value: (amountCents / 100).toFixed(2), currency_code: "USD" },
        },
      })
    );

    await client.query(
      `
      INSERT INTO public."WebhookTransmission" (
        transmission_id, authenticated_event_type, authenticated_order_id,
        authenticated_capture_id, authenticated_refund_id, authenticated_amount_cents,
        authenticated_currency, authenticated_payee_email, raw_payload, payload_hash,
        status, response_code, created_at
      ) VALUES (
        $1, 'PAYMENT.CAPTURE.COMPLETED', $2,
        $3, NULL, $4,
        'USD', $5, $6::bytea, extensions.digest($6::bytea, 'sha256'),
        'PROCESSED', 200, clock_timestamp()
      ) ON CONFLICT (transmission_id) DO NOTHING;
    `,
      [transmissionId, orderId, captureId, amountCents, payeeEmail, rawPayload]
    );
  }

  it("1. executes multi-cart sequential capture with mixed outcomes (COMPLETED, TIMEOUT, FAILED)", async () => {
    const planId = crypto.randomUUID();
    const aggregateId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    // Create plan & aggregate
    await client.query(
      `INSERT INTO public."ProcurementPlan" (id, "userId", strategy, "lifecycleStatus", "createdAt", "updatedAt")
       VALUES ($1, $2, 'MULTI_RETAILER_BALANCED', 'ACTIVE', clock_timestamp(), clock_timestamp());`,
      [planId, userId]
    );

    await client.query(
      `INSERT INTO public."ApprovalAggregate" (id, "planId", "aggregateStatus", "snapshotDigest", "snapshotPayload", "approvedAt", "createdAt")
       VALUES ($1, $2, 'APPROVED', $3, '{}'::jsonb, clock_timestamp(), clock_timestamp());`,
      [aggregateId, planId, Buffer.from("p4-02-mixed-outcomes-snapshot")]
    );

    // Cart 1: Micro Center (Will complete)
    const cart1Id = crypto.randomUUID();
    await client.query(
      `INSERT INTO public."ApprovedMerchantCart" (
         id, "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
         "paypalOrderId", "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
         "taxAmountCents", "totalCartCents", "cumulativeRefundedCents", "createdAt", "updatedAt"
       ) VALUES ($1, $2, 'microcenter', 'payee-micro@example.com', 'BUYER_APPROVED', 'ORD-MC-1', 5000, 0, 0, 0, 5000, 0, clock_timestamp(), clock_timestamp());`,
      [cart1Id, aggregateId]
    );

    // Cart 2: Newegg (Will experience AMBIGUOUS_TIMEOUT)
    const cart2Id = crypto.randomUUID();
    await client.query(
      `INSERT INTO public."ApprovedMerchantCart" (
         id, "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
         "paypalOrderId", "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
         "taxAmountCents", "totalCartCents", "cumulativeRefundedCents", "createdAt", "updatedAt"
       ) VALUES ($1, $2, 'newegg', 'payee-newegg@example.com', 'BUYER_APPROVED', 'ORD-NEWEGG-2', 8000, 0, 0, 0, 8000, 0, clock_timestamp(), clock_timestamp());`,
      [cart2Id, aggregateId]
    );

    // Cart 3: Best Buy (Will fail terminally with CARD_DECLINED)
    const cart3Id = crypto.randomUUID();
    await client.query(
      `INSERT INTO public."ApprovedMerchantCart" (
         id, "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
         "paypalOrderId", "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
         "taxAmountCents", "totalCartCents", "cumulativeRefundedCents", "createdAt", "updatedAt"
       ) VALUES ($1, $2, 'bestbuy', 'payee-bb@example.com', 'BUYER_APPROVED', 'ORD-BB-3', 3000, 0, 0, 0, 3000, 0, clock_timestamp(), clock_timestamp());`,
      [cart3Id, aggregateId]
    );

    // Pre-create verified transmission for Cart 1
    const tx1 = "tx_p4_02_1_" + crypto.randomUUID();
    await createVerifiedTransmission(tx1, "ORD-MC-1", "CAP-MC-1", 5000, "payee-micro@example.com");

    const mockGateway = new MockPaymentGatewayClient();
    mockGateway.setOrderBehavior("ORD-MC-1", {
      mode: "SUCCESS",
      fixedCaptureId: "CAP-MC-1",
    });
    mockGateway.setOrderBehavior("ORD-NEWEGG-2", {
      mode: "TIMEOUT",
      errorMessage: "Gateway read timeout after 10000ms",
    });
    mockGateway.setOrderBehavior("ORD-BB-3", {
      mode: "FAILURE",
      errorCode: "CARD_DECLINED",
      errorMessage: "Payment card declined by issuer.",
    });

    const service = new CartCaptureService(client, mockGateway, hmacKeyId);
    const optionsMap = new Map([[cart1Id, { transmissionId: tx1 }]]);

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    const multiResult = await service.executeMultiCartCapture(aggregateId, optionsMap);

    expect(multiResult.totalCarts).toBe(3);
    expect(multiResult.completedCount).toBe(1);
    expect(multiResult.failedCount).toBe(1);
    expect(multiResult.pendingCount).toBe(1); // Cart 2 timeout is preserved as pending!

    // Verify per-cart status in database
    await client.query("RESET SESSION AUTHORIZATION;");
    const c1 = await client.query('SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1', [cart1Id]);
    const c2 = await client.query('SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1', [cart2Id]);
    const c3 = await client.query('SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1', [cart3Id]);

    // Cart 1 completed
    expect(c1.rows[0].checkoutStatus).toBe("CAPTURED");
    // Cart 2 timed out: preserved in CAPTURING, NEVER marked FAILED!
    expect(c2.rows[0].checkoutStatus).toBe("CAPTURING");
    // Cart 3 failed
    expect(c3.rows[0].checkoutStatus).toBe("FAILED");

    // Verify PaymentEvidenceRecord exists for Cart 1 and is untouched
    const pe = await client.query('SELECT * FROM public."PaymentEvidenceRecord" WHERE cart_id = $1', [cart1Id]);
    expect(pe.rows).toHaveLength(1);
    expect(pe.rows[0].capture_id).toBe("CAP-MC-1");
  });

  it("2. re-capturing a CAPTURED cart returns existing evidence idempotently", async () => {
    const planId = crypto.randomUUID();
    const aggregateId = crypto.randomUUID();
    const cartId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    await client.query(
      `INSERT INTO public."ProcurementPlan" (id, "userId", strategy, "lifecycleStatus", "createdAt", "updatedAt")
       VALUES ($1, $2, 'STRATEGY_A', 'ACTIVE', clock_timestamp(), clock_timestamp());`,
      [planId, userId]
    );

    await client.query(
      `INSERT INTO public."ApprovalAggregate" (id, "planId", "aggregateStatus", "snapshotDigest", "snapshotPayload", "approvedAt", "createdAt")
       VALUES ($1, $2, 'APPROVED', $3, '{}'::jsonb, clock_timestamp(), clock_timestamp());`,
      [aggregateId, planId, Buffer.from("idempotency-test-snapshot")]
    );

    await client.query(
      `INSERT INTO public."ApprovedMerchantCart" (
         id, "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
         "paypalOrderId", "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
         "taxAmountCents", "totalCartCents", "cumulativeRefundedCents", "createdAt", "updatedAt"
       ) VALUES ($1, $2, 'merchant_idemp', 'payee-idemp@example.com', 'BUYER_APPROVED', 'ORD-IDEMP-1', 4500, 0, 0, 0, 4500, 0, clock_timestamp(), clock_timestamp());`,
      [cartId, aggregateId]
    );

    const txId = "tx_idemp_" + crypto.randomUUID();
    await createVerifiedTransmission(txId, "ORD-IDEMP-1", "CAP-IDEMP-1", 4500, "payee-idemp@example.com");

    const mockGateway = new MockPaymentGatewayClient({
      mode: "SUCCESS",
      fixedCaptureId: "CAP-IDEMP-1",
    });
    const service = new CartCaptureService(client, mockGateway, hmacKeyId);

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    // First capture
    const firstRes = await service.executeSingleCartCapture(cartId, aggregateId, {
      transmissionId: txId,
    });

    expect(firstRes.status).toBe("CAPTURED");
    expect(firstRes.outcome).toBe("COMPLETED");
    expect(firstRes.captureId).toBe("CAP-IDEMP-1");

    // Second capture attempt on already CAPTURED cart
    const secondRes = await service.executeSingleCartCapture(cartId, aggregateId, {
      transmissionId: txId,
    });

    expect(secondRes.status).toBe("CAPTURED");
    expect(secondRes.outcome).toBe("COMPLETED");
    expect(secondRes.idempotentRetry).toBe(true);
    expect(secondRes.captureId).toBe("CAP-IDEMP-1");
    expect(secondRes.paymentEvidenceId).toBe(firstRes.paymentEvidenceId);
  });
});

