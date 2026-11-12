import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import { WebhookPaymentReconciler } from "../../lib/workflow/webhook-reconciler";
import { RefundService } from "../../lib/workflow/refund-service";
import { WebhookIngressResult } from "../../lib/workers/webhook-ingress-worker";

describe("Phase 5 Acceptance: Adversarial Concurrency & Stress Verification", () => {
  let masterClient: Client;
  const hmacKeyId = "audit_hmac_stress_test";

  beforeAll(async () => {
    masterClient = await createStage2Client();
    await ensureRolesExist(masterClient);
    await createTestKeys(masterClient, "vak_unused", hmacKeyId, "unused");
  });

  afterAll(async () => {
    await masterClient.end();
  });

  async function createVerifiedTransmission(
    client: Client,
    txId: string,
    orderId: string,
    captureId: string,
    amountCents: number,
    payeeEmail: string
  ) {
    const rawPayload = Buffer.from(JSON.stringify({ id: txId, event_type: "PAYMENT.CAPTURE.COMPLETED" }));
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
    `, [txId, orderId, captureId, amountCents, payeeEmail, rawPayload]);
  }

  it("Scenario 1: 20 simultaneous capture requests on the same cart produce exactly 1 capture confirmation without deadlocks", async () => {
    const orderId = "ORD-CONC-DUP-" + crypto.randomUUID();
    const captureId = "CAP-CONC-DUP-" + crypto.randomUUID();
    const txId = "tx_conc_dup_" + crypto.randomUUID();

    const fixture = await createTestCartFixture(masterClient, "BUYER_APPROVED", 3000, 0, 0, 0, "merchant@example.com", orderId);
    await createVerifiedTransmission(masterClient, txId, orderId, captureId, 3000, "merchant@example.com");

    const concurrency = 20;
    const clients: Client[] = [];
    for (let i = 0; i < concurrency; i++) {
      const c = await createStage2Client();
      await c.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
      clients.push(c);
    }

    const mockGateway = new MockPaymentGatewayClient({
      mode: "SUCCESS",
      fixedCaptureId: captureId,
    });

    const promises = clients.map((c, idx) => {
      const service = new CartCaptureService(c, mockGateway, hmacKeyId);
      return service.executeSingleCartCapture(fixture.cartId, fixture.aggregateId, {
        transmissionId: txId,
        idempotencyKey: "idemp_dup_stress",
      });
    });

    const results = await Promise.allSettled(promises);

    for (const c of clients) {
      await c.query("RESET SESSION AUTHORIZATION;");
      await c.end().catch(() => {});
    }

    // Inspect results
    let successCount = 0;
    let idempotentCount = 0;

    for (const res of results) {
      if (res.status === "fulfilled") {
        successCount++;
        if (res.value.idempotentRetry) idempotentCount++;
      }
    }

    // Every completed request must be valid; exactly 1 was the primary capture, rest idempotent
    expect(successCount).toBe(concurrency);
    expect(idempotentCount).toBe(concurrency - 1);

    // Verify database state: exactly 1 PaymentEvidenceRecord
    const peCount = await masterClient.query(
      'SELECT count(*) FROM public."PaymentEvidenceRecord" WHERE cart_id = $1',
      [fixture.cartId]
    );
    expect(Number(peCount.rows[0].count)).toBe(1);

    const cartCheck = await masterClient.query(
      'SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1',
      [fixture.cartId]
    );
    expect(cartCheck.rows[0].checkoutStatus).toBe("CAPTURED");
  }, 30000);

  it("Scenario 2: Gateway timeout followed by delayed webhook arrival safely reconciles cart into CAPTURED", async () => {
    const orderId = "ORD-TIMEOUT-DELAYED-" + crypto.randomUUID();
    const captureId = "CAP-TIMEOUT-DELAYED-" + crypto.randomUUID();
    const txId = "tx_delayed_wh_" + crypto.randomUUID();

    const fixture = await createTestCartFixture(masterClient, "BUYER_APPROVED", 4500, 0, 0, 0, "merchant@example.com", orderId);

    const client = await createStage2Client();
    await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");

    // Phase 1: Gateway capture times out
    const timeoutGateway = new MockPaymentGatewayClient({ mode: "TIMEOUT" });
    const captureService = new CartCaptureService(client, timeoutGateway, hmacKeyId);

    const timeoutResult = await captureService.executeSingleCartCapture(fixture.cartId, fixture.aggregateId);
    expect(timeoutResult.outcome).toBe("AMBIGUOUS_TIMEOUT");
    expect(timeoutResult.status).toBe("CAPTURING");

    // Cart in DB must be CAPTURING (not FAILED)
    const midCheck = await masterClient.query(
      'SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1',
      [fixture.cartId]
    );
    expect(midCheck.rows[0].checkoutStatus).toBe("CAPTURING");

    // Phase 2: PayPal webhook arrives later with PAYMENT.CAPTURE.COMPLETED
    await createVerifiedTransmission(masterClient, txId, orderId, captureId, 4500, "merchant@example.com");

    const refundService = new RefundService(client, timeoutGateway, hmacKeyId);
    const reconciler = new WebhookPaymentReconciler(client, captureService, refundService);

    const webhookResult: WebhookIngressResult = {
      transmissionId: txId,
      status: "RECORDED",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      orderId,
      captureId,
      refundId: null,
      amountCents: 4500,
      currency: "USD",
      payeeEmail: "merchant@example.com",
      rawPayloadHash: "xyz",
      crc32: 99999,
      loggedAt: new Date(),
      finalized: true,
    };

    const reconResult = await reconciler.reconcileWebhook(webhookResult);

    expect(reconResult.reconciled).toBe(true);
    expect(reconResult.status).toBe("CAPTURED");

    await client.query("RESET SESSION AUTHORIZATION;");
    await client.end().catch(() => {});

    // Final verification: cart is now CAPTURED with exactly 1 payment evidence record
    const finalCart = await masterClient.query(
      'SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1',
      [fixture.cartId]
    );
    expect(finalCart.rows[0].checkoutStatus).toBe("CAPTURED");

    const peCount = await masterClient.query(
      'SELECT count(*) FROM public."PaymentEvidenceRecord" WHERE cart_id = $1',
      [fixture.cartId]
    );
    expect(Number(peCount.rows[0].count)).toBe(1);
  });
});

