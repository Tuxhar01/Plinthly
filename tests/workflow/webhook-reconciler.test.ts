import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestKeys,
} from "../database/helpers/routine-test-helper";
import { WebhookPaymentReconciler } from "../../lib/workflow/webhook-reconciler";
import { CartCaptureService } from "../../lib/workflow/cart-capture-service";
import { RefundService } from "../../lib/workflow/refund-service";
import { MockPaymentGatewayClient } from "../../lib/workflow/payment-gateway-adapter";
import { WebhookIngressResult } from "../../lib/workers/webhook-ingress-worker";

describe("Phase 4: WebhookPaymentReconciler & Asynchronous State Synchronization", () => {
  let client: Client;
  const hmacKeyId = "audit_hmac_reconcile_test";
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
    payeeEmail: string,
    eventType: string = "PAYMENT.CAPTURE.COMPLETED",
    refundId: string | null = null
  ) {
    const rawPayload = Buffer.from(JSON.stringify({
      id: "WH-" + crypto.randomUUID(),
      event_type: eventType,
      resource: {
        id: refundId || captureId,
        amount: { value: (amountCents / 100).toFixed(2), currency_code: "USD" },
        supplementary_data: { related_ids: { order_id: orderId, capture_id: captureId } },
      },
    }));

    await client.query(`
      INSERT INTO public."WebhookTransmission" (
        transmission_id, authenticated_event_type, authenticated_order_id,
        authenticated_capture_id, authenticated_refund_id, authenticated_amount_cents,
        authenticated_currency, authenticated_payee_email, raw_payload, payload_hash,
        status, response_code, created_at
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        'USD', $7, $8::bytea, extensions.digest($8::bytea, 'sha256'),
        'PROCESSED', 200, clock_timestamp()
      ) ON CONFLICT (transmission_id) DO NOTHING;
    `, [transmissionId, eventType, orderId, captureId, refundId, amountCents, payeeEmail, rawPayload]);
  }

  it("1. reconciles PAYMENT.CAPTURE.COMPLETED webhook and transitions cart to CAPTURED", async () => {
    const orderId = "ORD-RECON-1-" + crypto.randomUUID();
    const captureId = "CAP-RECON-1-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURING", 3500, 500, 1000, 0, "merchant@example.com", orderId);
    const txId = "tx_recon_1_" + crypto.randomUUID();
    await createVerifiedTransmission(txId, orderId, captureId, 4000, "merchant@example.com");

    const mockGateway = new MockPaymentGatewayClient();
    const captureService = new CartCaptureService(client, mockGateway, hmacKeyId);
    const refundService = new RefundService(client, mockGateway, hmacKeyId);
    const reconciler = new WebhookPaymentReconciler(client, captureService, refundService);

    const mockWebhookResult: WebhookIngressResult = {
      transmissionId: txId,
      status: "RECORDED",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      orderId,
      captureId,
      refundId: null,
      amountCents: 4000,
      currency: "USD",
      payeeEmail: "merchant@example.com",
      rawPayloadHash: "abc",
      crc32: 12345,
      loggedAt: new Date(),
      finalized: true,
    };

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    const result = await reconciler.reconcileWebhook(mockWebhookResult);

    expect(result.reconciled).toBe(true);
    expect(result.cartId).toBe(fixture.cartId);
    expect(result.status).toBe("CAPTURED");
    expect(result.idempotentRetry).toBe(false);

    await client.query("RESET SESSION AUTHORIZATION;");
    const cartCheck = await client.query('SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1', [fixture.cartId]);
    expect(cartCheck.rows[0].checkoutStatus).toBe("CAPTURED");
  });

  it("2. duplicate webhook delivery reconciles idempotently without duplicate records", async () => {
    const orderId = "ORD-RECON-DUP-" + crypto.randomUUID();
    const captureId = "CAP-DUP-1-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURING", 2000, 0, 0, 0, "merchant@example.com", orderId);
    const txId = "tx_dup_" + crypto.randomUUID();
    await createVerifiedTransmission(txId, orderId, captureId, 2000, "merchant@example.com");

    const mockGateway = new MockPaymentGatewayClient();
    const captureService = new CartCaptureService(client, mockGateway, hmacKeyId);
    const refundService = new RefundService(client, mockGateway, hmacKeyId);
    const reconciler = new WebhookPaymentReconciler(client, captureService, refundService);

    const mockWebhookResult: WebhookIngressResult = {
      transmissionId: txId,
      status: "RECORDED",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      orderId,
      captureId,
      refundId: null,
      amountCents: 2000,
      currency: "USD",
      payeeEmail: "merchant@example.com",
      rawPayloadHash: "abc",
      crc32: 12345,
      loggedAt: new Date(),
      finalized: true,
    };

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    // First delivery
    const res1 = await reconciler.reconcileWebhook(mockWebhookResult);
    expect(res1.reconciled).toBe(true);
    expect(res1.idempotentRetry).toBe(false);

    // Duplicate delivery
    const res2 = await reconciler.reconcileWebhook(mockWebhookResult);
    expect(res2.reconciled).toBe(true);
    expect(res2.idempotentRetry).toBe(true);

    await client.query("RESET SESSION AUTHORIZATION;");
    const peCount = await client.query('SELECT count(*) FROM public."PaymentEvidenceRecord" WHERE cart_id = $1', [fixture.cartId]);
    expect(Number(peCount.rows[0].count)).toBe(1);
  });

  it("3. reconciles PAYMENT.CAPTURE.REFUNDED webhook and updates status to PARTIALLY_REFUNDED", async () => {
    const orderId = "ORD-RECON-REF-" + crypto.randomUUID();
    const captureId = "CAP-RECON-REF-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURED", 4000, 0, 0, 0, "merchant@example.com", orderId);
    const capTxId = "tx_cap_ref_" + crypto.randomUUID();
    await createVerifiedTransmission(capTxId, orderId, captureId, 4000, "merchant@example.com");

    // Insert PaymentEvidenceRecord
    await client.query(`
      INSERT INTO public."PaymentEvidenceRecord" (
        id, cart_id, transmission_id, capture_id, paypal_order_id,
        amount_cents, currency, payee_email, internal_audit_signature, recorded_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4,
        4000, 'USD', 'merchant@example.com', '\\x01020304'::bytea, clock_timestamp()
      );
    `, [fixture.cartId, capTxId, captureId, orderId]);

    const refTxId = "tx_ref_wh_" + crypto.randomUUID();
    const refundId = "REF-WH-1-" + crypto.randomUUID();
    await createVerifiedTransmission(refTxId, orderId, captureId, 1500, "merchant@example.com", "PAYMENT.CAPTURE.REFUNDED", refundId);

    const mockGateway = new MockPaymentGatewayClient();
    const captureService = new CartCaptureService(client, mockGateway, hmacKeyId);
    const refundService = new RefundService(client, mockGateway, hmacKeyId);
    const reconciler = new WebhookPaymentReconciler(client, captureService, refundService);

    const mockRefundWebhook: WebhookIngressResult = {
      transmissionId: refTxId,
      status: "RECORDED",
      eventType: "PAYMENT.CAPTURE.REFUNDED",
      orderId,
      captureId,
      refundId,
      amountCents: 1500,
      currency: "USD",
      payeeEmail: "merchant@example.com",
      rawPayloadHash: "abc",
      crc32: 12345,
      loggedAt: new Date(),
      finalized: true,
    };

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    const result = await reconciler.reconcileWebhook(mockRefundWebhook);

    expect(result.reconciled).toBe(true);
    expect(result.status).toBe("PARTIALLY_REFUNDED");

    await client.query("RESET SESSION AUTHORIZATION;");
    const cartCheck = await client.query('SELECT "checkoutStatus", "cumulativeRefundedCents" FROM public."ApprovedMerchantCart" WHERE id = $1', [fixture.cartId]);
    expect(cartCheck.rows[0].checkoutStatus).toBe("PARTIALLY_REFUNDED");
    expect(Number(cartCheck.rows[0].cumulativeRefundedCents)).toBe(1500);
  });
});
