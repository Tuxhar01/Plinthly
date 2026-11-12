import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestKeys,
} from "../database/helpers/routine-test-helper";
import { CartCaptureService } from "../../lib/workflow/cart-capture-service";
import { MockPaymentGatewayClient } from "../../lib/workflow/payment-gateway-adapter";

describe("Phase 4: CartCaptureService & Multi-Merchant Isolation", () => {
  let client: Client;
  const hmacKeyId = "audit_hmac_cart_capture";
  const orchestratorPrincipal = "orchestrator_worker_user";

  beforeAll(async () => {
    client = await createStage2Client();
    await ensureRolesExist(client);
    await createTestKeys(client, "vak_unused", hmacKeyId, "unused");
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
    const rawPayload = Buffer.from(JSON.stringify({
      id: "WH-" + crypto.randomUUID(),
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: captureId,
        amount: { value: (amountCents / 100).toFixed(2), currency_code: "USD" },
      },
    }));

    await client.query(`
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
    `, [transmissionId, orderId, captureId, amountCents, payeeEmail, rawPayload]);
  }

  it("1. prepareCartCapture: enforces zero-variance and transitions BUYER_APPROVED to CAPTURING via R2-02", async () => {
    // 2500 - 500 + 1000 + 0 = 3000
    const fixture = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const mockGateway = new MockPaymentGatewayClient();
    const service = new CartCaptureService(client, mockGateway, hmacKeyId);

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    const result = await service.prepareCartCapture({
      cartId: fixture.cartId,
      approvalAggregateId: fixture.aggregateId,
      expectedAmountCents: 3000,
    });

    expect(result.cartId).toBe(fixture.cartId);
    expect(result.status).toBe("CAPTURING");
    expect(result.lockedAt).toBeDefined();

    await client.query("RESET SESSION AUTHORIZATION;");
    const dbCheck = await client.query('SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1', [fixture.cartId]);
    expect(dbCheck.rows[0].checkoutStatus).toBe("CAPTURING");
  });

  it("2. confirmCartCapture: confirms capture evidence via R2-05 and enforces idempotency", async () => {
    const fixture = await createTestCartFixture(client, "CAPTURING", 2500, 500, 1000, 0, "merchant@example.com", "ORD-CONFIRM-1");
    const txId = "tx_confirm_" + crypto.randomUUID();
    const captureId = "CAP-CONFIRM-1";
    await createVerifiedTransmission(txId, "ORD-CONFIRM-1", captureId, 3000, "merchant@example.com");

    const mockGateway = new MockPaymentGatewayClient();
    const service = new CartCaptureService(client, mockGateway, hmacKeyId);

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    // First confirmation
    const res1 = await service.confirmCartCapture({
      cartId: fixture.cartId,
      transmissionId: txId,
      captureId,
    });

    expect(res1.status).toBe("CAPTURED");
    expect(res1.idempotentRetry).toBe(false);
    expect(res1.paymentEvidenceId).toBeDefined();

    // Idempotent retry with same cart and evidence
    const res2 = await service.confirmCartCapture({
      cartId: fixture.cartId,
      transmissionId: txId,
      captureId,
    });

    expect(res2.status).toBe("CAPTURED");
    expect(res2.idempotentRetry).toBe(true);
    expect(res2.paymentEvidenceId).toBe(res1.paymentEvidenceId);

    await client.query("RESET SESSION AUTHORIZATION;");
    const countCheck = await client.query('SELECT count(*) FROM public."PaymentEvidenceRecord" WHERE cart_id = $1', [fixture.cartId]);
    expect(Number(countCheck.rows[0].count)).toBe(1);
  });

  it("3. executeSingleCartCapture: handles AMBIGUOUS_TIMEOUT safely without marking cart as FAILED", async () => {
    const fixture = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0, "merchant@example.com", "ORD-TIMEOUT-1");
    const mockGateway = new MockPaymentGatewayClient({ mode: "TIMEOUT" });
    const service = new CartCaptureService(client, mockGateway, hmacKeyId);

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    const result = await service.executeSingleCartCapture(fixture.cartId, fixture.aggregateId);

    expect(result.outcome).toBe("AMBIGUOUS_TIMEOUT");
    expect(result.status).toBe("CAPTURING"); // Invariant: Must NOT be FAILED!

    await client.query("RESET SESSION AUTHORIZATION;");
    const dbCheck = await client.query('SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1', [fixture.cartId]);
    expect(dbCheck.rows[0].checkoutStatus).toBe("CAPTURING");
  });

  it("4. executeSingleCartCapture: handles terminal gateway failure by marking cart as FAILED", async () => {
    const fixture = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0, "merchant@example.com", "ORD-FAIL-1");
    const mockGateway = new MockPaymentGatewayClient({ mode: "FAILURE", errorMessage: "Card declined by issuer." });
    const service = new CartCaptureService(client, mockGateway, hmacKeyId);

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    const result = await service.executeSingleCartCapture(fixture.cartId, fixture.aggregateId);

    expect(result.outcome).toBe("FAILED");
    expect(result.status).toBe("FAILED");

    await client.query("RESET SESSION AUTHORIZATION;");
    const dbCheck = await client.query('SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1', [fixture.cartId]);
    expect(dbCheck.rows[0].checkoutStatus).toBe("FAILED");
  });

  it("5. executeMultiCartCapture: enforces independent merchant-cart outcomes in multi-cart orders", async () => {
    // Create approval aggregate with 3 independent merchant carts
    const planId = crypto.randomUUID();
    const aggregateId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    await client.query(`
      INSERT INTO public."ProcurementPlan" (id, "userId", strategy, "lifecycleStatus", "createdAt", "updatedAt")
      VALUES ($1, $2, 'BALANCED', 'ACTIVE', clock_timestamp(), clock_timestamp());
    `, [planId, userId]);

    await client.query(`
      INSERT INTO public."ApprovalAggregate" (id, "planId", "aggregateStatus", "snapshotDigest", "snapshotPayload", "approvedAt", "createdAt")
      VALUES ($1, $2, 'APPROVED', $3, '{}'::jsonb, clock_timestamp(), clock_timestamp());
    `, [aggregateId, planId, Buffer.from("multi-cart-snapshot")]);

    // Cart 1: Walmart (Will succeed)
    const cart1Id = crypto.randomUUID();
    await client.query(`
      INSERT INTO public."ApprovedMerchantCart" (
        id, "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
        "paypalOrderId", "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
        "taxAmountCents", "totalCartCents", "cumulativeRefundedCents", "createdAt", "updatedAt"
      ) VALUES ($1, $2, 'walmart', 'payee-walmart@example.com', 'BUYER_APPROVED', 'ORD-WALMART-1', 4000, 0, 0, 0, 4000, 0, clock_timestamp(), clock_timestamp());
    `, [cart1Id, aggregateId]);

    // Cart 2: BestBuy (Will fail)
    const cart2Id = crypto.randomUUID();
    await client.query(`
      INSERT INTO public."ApprovedMerchantCart" (
        id, "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
        "paypalOrderId", "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
        "taxAmountCents", "totalCartCents", "cumulativeRefundedCents", "createdAt", "updatedAt"
      ) VALUES ($1, $2, 'bestbuy', 'payee-bestbuy@example.com', 'BUYER_APPROVED', 'ORD-BESTBUY-2', 6000, 0, 0, 0, 6000, 0, clock_timestamp(), clock_timestamp());
    `, [cart2Id, aggregateId]);

    // Cart 3: Target (Will succeed)
    const cart3Id = crypto.randomUUID();
    await client.query(`
      INSERT INTO public."ApprovedMerchantCart" (
        id, "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
        "paypalOrderId", "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
        "taxAmountCents", "totalCartCents", "cumulativeRefundedCents", "createdAt", "updatedAt"
      ) VALUES ($1, $2, 'target', 'payee-target@example.com', 'BUYER_APPROVED', 'ORD-TARGET-3', 2500, 0, 0, 0, 2500, 0, clock_timestamp(), clock_timestamp());
    `, [cart3Id, aggregateId]);

    // Pre-create verified transmissions for Cart 1 and Cart 3
    const tx1 = "tx_multi_1_" + crypto.randomUUID();
    const tx3 = "tx_multi_3_" + crypto.randomUUID();
    await createVerifiedTransmission(tx1, "ORD-WALMART-1", "CAP-WALMART-1", 4000, "payee-walmart@example.com");
    await createVerifiedTransmission(tx3, "ORD-TARGET-3", "CAP-TARGET-3", 2500, "payee-target@example.com");

    const mockGateway = new MockPaymentGatewayClient();
    // Configure Cart 2 to fail
    mockGateway.setOrderBehavior("ORD-BESTBUY-2", {
      mode: "FAILURE",
      errorCode: "INSUFFICIENT_FUNDS",
      errorMessage: "Payer insufficient funds at merchant BestBuy",
    });
    // Configure fixed capture IDs for Cart 1 & 3
    mockGateway.setOrderBehavior("ORD-WALMART-1", {
      mode: "SUCCESS",
      fixedCaptureId: "CAP-WALMART-1",
    });
    mockGateway.setOrderBehavior("ORD-TARGET-3", {
      mode: "SUCCESS",
      fixedCaptureId: "CAP-TARGET-3",
    });

    const service = new CartCaptureService(client, mockGateway, hmacKeyId);
    const optionsMap = new Map([
      [cart1Id, { transmissionId: tx1 }],
      [cart3Id, { transmissionId: tx3 }],
    ]);

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    const multiResult = await service.executeMultiCartCapture(aggregateId, optionsMap);

    expect(multiResult.totalCarts).toBe(3);
    expect(multiResult.completedCount).toBe(2);
    expect(multiResult.failedCount).toBe(1);
    expect(multiResult.pendingCount).toBe(0);

    // Verify per-cart status directly in database
    await client.query("RESET SESSION AUTHORIZATION;");
    const cart1Check = await client.query('SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1', [cart1Id]);
    const cart2Check = await client.query('SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1', [cart2Id]);
    const cart3Check = await client.query('SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1', [cart3Id]);

    // Invariant: Cart 1 is CAPTURED, Cart 2 is FAILED, Cart 3 is CAPTURED.
    expect(cart1Check.rows[0].checkoutStatus).toBe("CAPTURED");
    expect(cart2Check.rows[0].checkoutStatus).toBe("FAILED");
    expect(cart3Check.rows[0].checkoutStatus).toBe("CAPTURED");
  });
});

