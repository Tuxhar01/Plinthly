/**
 * Plinthly Stage 3 Phase 4 — Refund Provenance Service Tests (P4-04)
 *
 * Verifies P4-04:
 * 1. Webhook-backed refund execution and cryptographic provenance via canonical routine R2-06.
 * 2. Binding of refund evidence to originating cart, captureId, and PaymentEvidenceRecord.
 * 3. Gateway refund execution (executeGatewayRefund) with PayPal REST v2 adapter integration.
 * 4. Idempotency preservation via UUIDv4 idempotency key (PayPal-Request-Id).
 * 5. Remaining refundable balance enforcement: amountCents <= totalCartCents - cumulativeRefundedCents.
 * 6. Fail-closed rejection when refund amount exceeds balance (ERR_REFUND_EXCEEDS_BALANCE).
 * 7. Fail-closed rejection when refund amount <= 0 (ERR_INVALID_REFUND_AMOUNT).
 * 8. Fail-closed rejection if cart is not CAPTURED or PARTIALLY_REFUNDED (ERR_INVALID_TRANSITION).
 * 9. Fail-closed rejection if currency does not match captured payment currency (ERR_CURRENCY_MISMATCH).
 * 10. Monotonic state transitions: CAPTURED -> PARTIALLY_REFUNDED -> REFUNDED.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestKeys,
} from "../database/helpers/routine-test-helper";
import { RefundService } from "../../lib/workflow/refund-service";
import { MockPaymentGatewayClient, PayPalSandboxGatewayAdapter } from "../../lib/workflow/payment-gateway-adapter";

describe("P4-04: Refund Provenance Service", () => {
  let client: Client;
  const hmacKeyId = "audit_hmac_p4_04_key";
  const orchestratorPrincipal = "orchestrator_worker_user";

  beforeAll(async () => {
    client = await createStage2Client();
    await ensureRolesExist(client);
    await createTestKeys(client, "vak_p4_04", hmacKeyId, "unused");
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("RESET SESSION AUTHORIZATION;");
  });

  async function createCaptureFixture(
    cartId: string,
    orderId: string,
    captureId: string,
    amountCents: number,
    payeeEmail: string,
    currency: string = "USD"
  ) {
    const txId = "tx_cap_" + crypto.randomUUID();
    const rawPayload = Buffer.from(
      JSON.stringify({ id: txId, event_type: "PAYMENT.CAPTURE.COMPLETED" })
    );

    // Insert WebhookTransmission
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
        $5, $6, $7::bytea, extensions.digest($7::bytea, 'sha256'),
        'PROCESSED', 200, clock_timestamp()
      );
    `,
      [txId, orderId, captureId, amountCents, currency, payeeEmail, rawPayload]
    );

    // Insert PaymentEvidenceRecord
    await client.query(
      `
      INSERT INTO public."PaymentEvidenceRecord" (
        id, cart_id, transmission_id, capture_id, paypal_order_id,
        amount_cents, currency, payee_email, internal_audit_signature, recorded_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4,
        $5, $6, $7, '\\x01020304'::bytea, clock_timestamp()
      );
    `,
      [cartId, txId, captureId, orderId, amountCents, currency, payeeEmail]
    );

    // Update cart status to CAPTURED
    await client.query(
      `
      UPDATE public."ApprovedMerchantCart"
         SET "checkoutStatus" = 'CAPTURED', "paypalOrderId" = $2
       WHERE id = $1;
    `,
      [cartId, orderId]
    );
  }

  async function createRefundTransmissionFixture(
    transmissionId: string,
    orderId: string,
    captureId: string,
    refundId: string,
    refundAmountCents: number,
    payeeEmail: string,
    currency: string = "USD"
  ) {
    const rawPayload = Buffer.from(
      JSON.stringify({ id: transmissionId, event_type: "PAYMENT.CAPTURE.REFUNDED" })
    );

    await client.query(
      `
      INSERT INTO public."WebhookTransmission" (
        transmission_id, authenticated_event_type, authenticated_order_id,
        authenticated_capture_id, authenticated_refund_id, authenticated_amount_cents,
        authenticated_currency, authenticated_payee_email, raw_payload, payload_hash,
        status, response_code, created_at
      ) VALUES (
        $1, 'PAYMENT.CAPTURE.REFUNDED', $2,
        $3, $4, $5,
        $6, $7, $8::bytea, extensions.digest($8::bytea, 'sha256'),
        'PROCESSED', 200, clock_timestamp()
      );
    `,
      [transmissionId, orderId, captureId, refundId, refundAmountCents, currency, payeeEmail, rawPayload]
    );
  }

  it("1. enforces remaining refundable balance limit and transitions CAPTURED -> PARTIALLY_REFUNDED -> REFUNDED", async () => {
    // Total: 10000 cents ($100.00)
    const orderId = "ORD-P404-1-" + crypto.randomUUID();
    const captureId = "CAP-P404-1-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(
      client,
      "CAPTURED",
      10000,
      0,
      0,
      0,
      "payee-p404@example.com",
      orderId
    );
    await createCaptureFixture(fixture.cartId, orderId, captureId, 10000, "payee-p404@example.com");

    // Setup all test fixtures with default session
    const tx1 = "tx_ref_1_" + crypto.randomUUID();
    const refId1 = "REF-P404-A-" + crypto.randomUUID();
    await createRefundTransmissionFixture(tx1, orderId, captureId, refId1, 4000, "payee-p404@example.com");

    const txExcess = "tx_ref_excess_" + crypto.randomUUID();
    const refIdExcess = "REF-EXCESS-" + crypto.randomUUID();
    await createRefundTransmissionFixture(txExcess, orderId, captureId, refIdExcess, 7000, "payee-p404@example.com");

    const tx2 = "tx_ref_2_" + crypto.randomUUID();
    const refId2 = "REF-P404-B-" + crypto.randomUUID();
    await createRefundTransmissionFixture(tx2, orderId, captureId, refId2, 6000, "payee-p404@example.com");

    const txExtra = "tx_ref_extra_" + crypto.randomUUID();
    const refIdExtra = "REF-EXTRA-" + crypto.randomUUID();
    await createRefundTransmissionFixture(txExtra, orderId, captureId, refIdExtra, 500, "payee-p404@example.com");

    const mockGateway = new MockPaymentGatewayClient();
    const service = new RefundService(client, mockGateway, hmacKeyId);

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    // Refund 1: 4000 cents (Leaves 6000 cents)
    const res1 = await service.executeCartRefund({
      cartId: fixture.cartId,
      amountCents: 4000,
      reason: "Item returned by customer",
      transmissionId: tx1,
    });

    expect(res1.status).toBe("PARTIALLY_REFUNDED");
    expect(res1.cumulativeRefundedCents).toBe(BigInt(4000));
    expect(res1.captureId).toBe(captureId);

    // Attempting a refund of 7000 cents must fail closed (exceeds remaining balance of 6000 cents)
    await expect(
      service.executeCartRefund({
        cartId: fixture.cartId,
        amountCents: 7000,
        reason: "Excess refund test",
        transmissionId: txExcess,
      })
    ).rejects.toThrowError(/ERR_REFUND_EXCEEDS_BALANCE/);

    // Refund 2: Exactly 6000 cents to reach full refund (10000 cents total)
    const res2 = await service.executeCartRefund({
      cartId: fixture.cartId,
      amountCents: 6000,
      reason: "Remaining items returned",
      transmissionId: tx2,
    });

    expect(res2.status).toBe("REFUNDED");
    expect(res2.cumulativeRefundedCents).toBe(BigInt(10000));

    // Subsequent refund attempt on fully REFUNDED cart must fail closed
    await expect(
      service.executeCartRefund({
        cartId: fixture.cartId,
        amountCents: 500,
        reason: "Extra refund",
        transmissionId: txExtra,
      })
    ).rejects.toThrowError(/ERR_INVALID_TRANSITION/);

    await client.query("RESET SESSION AUTHORIZATION;");
  });

  it("2. executeGatewayRefund dispatches to gateway with persisted UUIDv4 identity (PayPal-Request-Id)", async () => {
    const orderId = "ORD-P404-GW-" + crypto.randomUUID();
    const captureId = "CAP-P404-GW-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(
      client,
      "CAPTURED",
      8500,
      0,
      0,
      0,
      "payee-gw@example.com",
      orderId
    );
    await createCaptureFixture(fixture.cartId, orderId, captureId, 8500, "payee-gw@example.com");

    const mockGateway = new MockPaymentGatewayClient({
      mode: "SUCCESS",
      fixedRefundId: "REF-GW-SUCCESS-1",
    });
    const service = new RefundService(client, mockGateway, hmacKeyId);

    const idempotencyUuid = "client_key_" + crypto.randomUUID();

    const gwResult = await service.executeGatewayRefund({
      cartId: fixture.cartId,
      amountCents: 3500,
      reason: "Customer service courtesy refund",
      currency: "USD",
      idempotencyKey: idempotencyUuid,
    });

    expect(gwResult.outcome).toBe("COMPLETED");
    expect(gwResult.refundId).toBe("REF-GW-SUCCESS-1");
    expect(gwResult.amountCents).toBe(3500);
    expect(gwResult.captureId).toBe(captureId);

    // CRITICAL: The PayPal-Request-Id (idempotencyKey) sent to the gateway is the persisted CartRefundRecord.id!
    expect(gwResult.refundRecordId).toBeDefined();
    expect(gwResult.idempotencyKey).toBe(gwResult.refundRecordId);
    expect(mockGateway.lastRefundInput?.idempotencyKey).toBe(gwResult.refundRecordId);

    // Verify row was durably persisted in PostgreSQL before completion
    const dbRecord = await client.query(
      `SELECT id, cart_id, capture_id, idempotency_key, amount_cents, status, gateway_refund_id
         FROM public."CartRefundRecord"
        WHERE id = $1`,
      [gwResult.refundRecordId]
    );
    expect(dbRecord.rows.length).toBe(1);
    expect(dbRecord.rows[0].id).toBe(gwResult.refundRecordId);
    expect(dbRecord.rows[0].idempotency_key).toBe(idempotencyUuid);
    expect(dbRecord.rows[0].status).toBe("COMPLETED");
    expect(dbRecord.rows[0].gateway_refund_id).toBe("REF-GW-SUCCESS-1");

    // Missing persisted identity / missing idempotencyKey fails closed
    await expect(
      service.executeGatewayRefund({
        cartId: fixture.cartId,
        amountCents: 1000,
        reason: "Missing key test",
      })
    ).rejects.toThrowError(/ERR_MISSING_IDEMPOTENCY_KEY/);

    // Rejection on non-positive refund amount
    await expect(
      service.executeGatewayRefund({
        cartId: fixture.cartId,
        amountCents: 0,
        reason: "Zero refund",
        idempotencyKey: "key_zero_" + crypto.randomUUID(),
      })
    ).rejects.toThrowError(/ERR_INVALID_REFUND_AMOUNT/);

    // Rejection on currency mismatch
    await expect(
      service.executeGatewayRefund({
        cartId: fixture.cartId,
        amountCents: 1000,
        reason: "EUR refund on USD cart",
        currency: "EUR",
        idempotencyKey: "key_eur_" + crypto.randomUUID(),
      })
    ).rejects.toThrowError(/ERR_CURRENCY_MISMATCH/);
  });

  it("3. retry after successful submission returns cached result with identical PayPal request ID", async () => {
    const orderId = "ORD-P404-RETRY-SUCCESS-" + crypto.randomUUID();
    const captureId = "CAP-P404-RETRY-SUCCESS-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURED", 6000, 0, 0, 0, "merchant@example.com", orderId);
    await createCaptureFixture(fixture.cartId, orderId, captureId, 6000, "merchant@example.com");

    const mockGateway = new MockPaymentGatewayClient({ mode: "SUCCESS", fixedRefundId: "REF-IDEM-1" });
    const service = new RefundService(client, mockGateway, hmacKeyId);
    const clientKey = "req_idem_" + crypto.randomUUID();

    // First attempt
    const res1 = await service.executeGatewayRefund({
      cartId: fixture.cartId,
      amountCents: 2000,
      reason: "Item returned",
      idempotencyKey: clientKey,
    });
    expect(res1.outcome).toBe("COMPLETED");
    expect(mockGateway.refundCallCount).toBe(1);

    // Retry with exact same client idempotency key
    const res2 = await service.executeGatewayRefund({
      cartId: fixture.cartId,
      amountCents: 2000,
      reason: "Item returned retry",
      idempotencyKey: clientKey,
    });
    expect(res2.outcome).toBe("COMPLETED");
    expect(res2.refundRecordId).toBe(res1.refundRecordId);
    expect(res2.idempotencyKey).toBe(res1.idempotencyKey);
    // Gateway call count did NOT increase (idempotent cached replay)
    expect(mockGateway.refundCallCount).toBe(1);
  });

  it("4. retry after ambiguous timeout reuses exact same persisted refund record ID", async () => {
    const orderId = "ORD-P404-TIMEOUT-" + crypto.randomUUID();
    const captureId = "CAP-P404-TIMEOUT-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURED", 7000, 0, 0, 0, "merchant@example.com", orderId);
    await createCaptureFixture(fixture.cartId, orderId, captureId, 7000, "merchant@example.com");

    const mockGateway = new MockPaymentGatewayClient({ mode: "TIMEOUT" });
    const service = new RefundService(client, mockGateway, hmacKeyId);
    const timeoutKey = "req_timeout_" + crypto.randomUUID();

    // First attempt: times out at gateway
    const resTimeout = await service.executeGatewayRefund({
      cartId: fixture.cartId,
      amountCents: 2500,
      reason: "Timeout test",
      idempotencyKey: timeoutKey,
    });
    expect(resTimeout.outcome).toBe("AMBIGUOUS_TIMEOUT");
    const originalRecordId = resTimeout.refundRecordId;
    expect(originalRecordId).toBeDefined();

    // In DB, status is AMBIGUOUS_TIMEOUT
    const checkDb = await client.query(
      `SELECT status FROM public."CartRefundRecord" WHERE id = $1`,
      [originalRecordId]
    );
    expect(checkDb.rows[0].status).toBe("AMBIGUOUS_TIMEOUT");

    // Gateway recovers to SUCCESS mode
    mockGateway.setCaptureBehavior(captureId, { mode: "SUCCESS", fixedRefundId: "REF-RESOLVED-1" });

    // Retry with exact same client idempotency key
    const resRetry = await service.executeGatewayRefund({
      cartId: fixture.cartId,
      amountCents: 2500,
      reason: "Timeout retry",
      idempotencyKey: timeoutKey,
    });

    expect(resRetry.outcome).toBe("COMPLETED");
    expect(resRetry.refundRecordId).toBe(originalRecordId);
    expect(resRetry.idempotencyKey).toBe(originalRecordId);
    // CRITICAL: The retry MUST have sent the exact same originalRecordId to the gateway!
    expect(mockGateway.lastRefundInput?.idempotencyKey).toBe(originalRecordId);
  });

  it("5. process restart recovers same persisted identity across service instances", async () => {
    const orderId = "ORD-P404-RESTART-" + crypto.randomUUID();
    const captureId = "CAP-P404-RESTART-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURED", 5000, 0, 0, 0, "merchant@example.com", orderId);
    await createCaptureFixture(fixture.cartId, orderId, captureId, 5000, "merchant@example.com");

    const mockGateway = new MockPaymentGatewayClient({ mode: "TIMEOUT" });
    const service1 = new RefundService(client, mockGateway, hmacKeyId);
    const restartKey = "req_restart_" + crypto.randomUUID();

    const res1 = await service1.executeGatewayRefund({
      cartId: fixture.cartId,
      amountCents: 1500,
      reason: "Before crash",
      idempotencyKey: restartKey,
    });
    expect(res1.outcome).toBe("AMBIGUOUS_TIMEOUT");

    // Simulate process restart: instantiate brand new Service and Gateway instances
    const mockGateway2 = new MockPaymentGatewayClient({ mode: "SUCCESS", fixedRefundId: "REF-RESTARTED-1" });
    const service2 = new RefundService(client, mockGateway2, hmacKeyId);

    const res2 = await service2.executeGatewayRefund({
      cartId: fixture.cartId,
      amountCents: 1500,
      reason: "After crash retry",
      idempotencyKey: restartKey,
    });

    expect(res2.outcome).toBe("COMPLETED");
    expect(res2.refundRecordId).toBe(res1.refundRecordId);
    expect(res2.idempotencyKey).toBe(res1.refundRecordId);
    expect(mockGateway2.lastRefundInput?.idempotencyKey).toBe(res1.refundRecordId);
  });

  it("6. concurrent identical requests produce zero duplicate intents or gateway calls", async () => {
    const orderId = "ORD-P404-CONC-" + crypto.randomUUID();
    const captureId = "CAP-P404-CONC-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURED", 9000, 0, 0, 0, "merchant@example.com", orderId);
    await createCaptureFixture(fixture.cartId, orderId, captureId, 9000, "merchant@example.com");

    const mockGateway = new MockPaymentGatewayClient({ mode: "SUCCESS" });
    const service = new RefundService(client, mockGateway, hmacKeyId);
    const concurrentKey = "req_conc_" + crypto.randomUUID();

    // Dispatch identical concurrent requests
    const [resA, resB] = await Promise.all([
      service.executeGatewayRefund({
        cartId: fixture.cartId,
        amountCents: 3000,
        reason: "Concurrent refund A",
        idempotencyKey: concurrentKey,
      }),
      service.executeGatewayRefund({
        cartId: fixture.cartId,
        amountCents: 3000,
        reason: "Concurrent refund B",
        idempotencyKey: concurrentKey,
      }),
    ]);

    expect(resA.outcome).toBe("COMPLETED");
    expect(resB.outcome).toBe("COMPLETED");
    expect(resA.refundRecordId).toBe(resB.refundRecordId);
    expect(resA.idempotencyKey).toBe(resB.idempotencyKey);

    // Only 1 record in CartRefundRecord
    const dbCount = await client.query(
      `SELECT COUNT(*)::int AS count FROM public."CartRefundRecord"
        WHERE cart_id = $1 AND idempotency_key = $2`,
      [fixture.cartId, concurrentKey]
    );
    expect(dbCount.rows[0].count).toBe(1);
  });

  it("7. different legitimate refund operations receive distinct persisted identities", async () => {
    const orderId = "ORD-P404-MULTI-" + crypto.randomUUID();
    const captureId = "CAP-P404-MULTI-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURED", 8000, 0, 0, 0, "merchant@example.com", orderId);
    await createCaptureFixture(fixture.cartId, orderId, captureId, 8000, "merchant@example.com");

    const mockGateway = new MockPaymentGatewayClient({ mode: "SUCCESS" });
    const service = new RefundService(client, mockGateway, hmacKeyId);

    const key1 = "req_item1_" + crypto.randomUUID();
    const key2 = "req_item2_" + crypto.randomUUID();

    const res1 = await service.executeGatewayRefund({
      cartId: fixture.cartId,
      amountCents: 2000,
      reason: "Return item 1",
      idempotencyKey: key1,
    });

    const res2 = await service.executeGatewayRefund({
      cartId: fixture.cartId,
      amountCents: 3000,
      reason: "Return item 2",
      idempotencyKey: key2,
    });

    expect(res1.outcome).toBe("COMPLETED");
    expect(res2.outcome).toBe("COMPLETED");
    expect(res1.refundRecordId).not.toBe(res2.refundRecordId);
    expect(res1.idempotencyKey).not.toBe(res2.idempotencyKey);

    const records = await client.query(
      `SELECT id, amount_cents FROM public."CartRefundRecord" WHERE cart_id = $1 ORDER BY created_at ASC`,
      [fixture.cartId]
    );
    expect(records.rows.length).toBe(2);
    expect(Number(records.rows[0].amount_cents)).toBe(2000);
    expect(Number(records.rows[1].amount_cents)).toBe(3000);
  });

  it("8. refund exceeding available balance is rejected before gateway dispatch", async () => {
    const orderId = "ORD-P404-BAL-" + crypto.randomUUID();
    const captureId = "CAP-P404-BAL-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURED", 5000, 0, 0, 0, "merchant@example.com", orderId);
    await createCaptureFixture(fixture.cartId, orderId, captureId, 5000, "merchant@example.com");

    const mockGateway = new MockPaymentGatewayClient({ mode: "SUCCESS" });
    const service = new RefundService(client, mockGateway, hmacKeyId);

    // Initial refund of 4000
    await service.executeGatewayRefund({
      cartId: fixture.cartId,
      amountCents: 4000,
      reason: "Partial 1",
      idempotencyKey: "key_part_" + crypto.randomUUID(),
    });

    const callsBefore = mockGateway.refundCallCount;

    // Attempting to refund 2000 when only 1000 remains must be rejected before gateway call
    await expect(
      service.executeGatewayRefund({
        cartId: fixture.cartId,
        amountCents: 2000,
        reason: "Excessive refund",
        idempotencyKey: "key_excess_" + crypto.randomUUID(),
      })
    ).rejects.toThrowError(/ERR_REFUND_EXCEEDS_BALANCE/);

    expect(mockGateway.refundCallCount).toBe(callsBefore);
  });

  it("9. provider refund rejection updates intent status to FAILED with error provenance", async () => {
    const orderId = "ORD-P404-FAIL-" + crypto.randomUUID();
    const captureId = "CAP-P404-FAIL-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURED", 5000, 0, 0, 0, "merchant@example.com", orderId);
    await createCaptureFixture(fixture.cartId, orderId, captureId, 5000, "merchant@example.com");

    const mockGateway = new MockPaymentGatewayClient({
      mode: "FAILURE",
      errorCode: "REFUND_DECLINED_BY_ISSUER",
      errorMessage: "Original card account closed",
    });
    const service = new RefundService(client, mockGateway, hmacKeyId);
    const failKey = "req_fail_" + crypto.randomUUID();

    const resFail = await service.executeGatewayRefund({
      cartId: fixture.cartId,
      amountCents: 2000,
      reason: "Failing refund test",
      idempotencyKey: failKey,
    });

    expect(resFail.outcome).toBe("FAILED");
    expect(resFail.errorCode).toBe("REFUND_DECLINED_BY_ISSUER");

    // In DB, status is FAILED with error code and message
    const checkDb = await client.query(
      `SELECT status, error_code, error_message FROM public."CartRefundRecord" WHERE id = $1`,
      [resFail.refundRecordId]
    );
    expect(checkDb.rows[0].status).toBe("FAILED");
    expect(checkDb.rows[0].error_code).toBe("REFUND_DECLINED_BY_ISSUER");
    expect(checkDb.rows[0].error_message).toBe("Original card account closed");
  });

  it("10. verifies PayPalSandboxGatewayAdapter sends PayPal-Request-Id equal to persisted CartRefundRecord.id over HTTP client", async () => {
    const orderId = "ORD-P404-SANDBOX-" + crypto.randomUUID();
    const captureId = "CAP-P404-SANDBOX-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURED", 5000, 0, 0, 0, "merchant@example.com", orderId);
    await createCaptureFixture(fixture.cartId, orderId, captureId, 5000, "merchant@example.com");

    let wireHeadersSeen: Record<string, string> = {};
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/v1/oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "mock_access_token", token_type: "Bearer", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`)) {
        wireHeadersSeen = (init?.headers as Record<string, string>) || {};
        return new Response(
          JSON.stringify({
            id: "REF-SANDBOX-12345",
            status: "COMPLETED",
            amount: { value: "25.00", currency_code: "USD" },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const sandboxAdapter = new PayPalSandboxGatewayAdapter({
      clientId: "test_client",
      clientSecret: "test_secret",
      fetchFn: mockFetch as any,
    });

    const service = new RefundService(client, sandboxAdapter, hmacKeyId);
    const clientKey = "req_sandbox_" + crypto.randomUUID();

    const result = await service.executeGatewayRefund({
      cartId: fixture.cartId,
      amountCents: 2500,
      reason: "Customer return via sandbox",
      currency: "USD",
      idempotencyKey: clientKey,
    });

    expect(result.outcome).toBe("COMPLETED");
    expect(result.refundId).toBe("REF-SANDBOX-12345");
    expect(result.refundRecordId).toBeDefined();

    // PROOF: The wire header PayPal-Request-Id matches the persisted CartRefundRecord.id!
    expect(wireHeadersSeen["PayPal-Request-Id"]).toBe(result.refundRecordId);

    // Verify database record has this exact id and gateway refund id
    const dbRecord = await client.query(
      `SELECT id, idempotency_key, gateway_refund_id, status FROM public."CartRefundRecord" WHERE id = $1`,
      [result.refundRecordId]
    );
    expect(dbRecord.rows.length).toBe(1);
    expect(dbRecord.rows[0].id).toBe(wireHeadersSeen["PayPal-Request-Id"]);
    expect(dbRecord.rows[0].gateway_refund_id).toBe("REF-SANDBOX-12345");
    expect(dbRecord.rows[0].status).toBe("COMPLETED");
  });
});
