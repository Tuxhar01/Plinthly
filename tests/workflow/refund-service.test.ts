import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestKeys,
} from "../database/helpers/routine-test-helper";
import { RefundService } from "../../lib/workflow/refund-service";

describe("Phase 4: RefundService & Cumulative Invariant (TEST-REFUND-01)", () => {
  let client: Client;
  const hmacKeyId = "audit_hmac_refund_test";
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

  async function createCaptureEvidenceFixture(
    cartId: string,
    orderId: string,
    captureId: string,
    amountCents: number,
    payeeEmail: string
  ) {
    const txId = "tx_cap_" + crypto.randomUUID();
    const rawPayload = Buffer.from(JSON.stringify({ id: txId, event_type: "PAYMENT.CAPTURE.COMPLETED" }));

    // Insert WebhookTransmission
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
      );
    `, [txId, orderId, captureId, amountCents, payeeEmail, rawPayload]);

    // Insert PaymentEvidenceRecord
    await client.query(`
      INSERT INTO public."PaymentEvidenceRecord" (
        id, cart_id, transmission_id, capture_id, paypal_order_id,
        amount_cents, currency, payee_email, internal_audit_signature, recorded_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4,
        $5, 'USD', $6, '\\x01020304'::bytea, clock_timestamp()
      );
    `, [cartId, txId, captureId, orderId, amountCents, payeeEmail]);

    // Update cart to CAPTURED
    await client.query(`
      UPDATE public."ApprovedMerchantCart"
         SET "checkoutStatus" = 'CAPTURED', "paypalOrderId" = $2
       WHERE id = $1
    `, [cartId, orderId]);
  }

  async function createRefundTransmissionFixture(
    transmissionId: string,
    orderId: string,
    captureId: string,
    refundId: string,
    refundAmountCents: number,
    payeeEmail: string
  ) {
    const rawPayload = Buffer.from(JSON.stringify({ id: transmissionId, event_type: "PAYMENT.CAPTURE.REFUNDED" }));

    await client.query(`
      INSERT INTO public."WebhookTransmission" (
        transmission_id, authenticated_event_type, authenticated_order_id,
        authenticated_capture_id, authenticated_refund_id, authenticated_amount_cents,
        authenticated_currency, authenticated_payee_email, raw_payload, payload_hash,
        status, response_code, created_at
      ) VALUES (
        $1, 'PAYMENT.CAPTURE.REFUNDED', $2,
        $3, $4, $5,
        'USD', $6, $7::bytea, extensions.digest($7::bytea, 'sha256'),
        'PROCESSED', 200, clock_timestamp()
      );
    `, [transmissionId, orderId, captureId, refundId, refundAmountCents, payeeEmail, rawPayload]);
  }

  it("1. records partial refund and transitions CAPTURED to PARTIALLY_REFUNDED via R2-06", async () => {
    // Cart total: 5000 cents
    const orderId = "ORD-REF-1-" + crypto.randomUUID();
    const captureId = "CAP-REF-1-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURED", 5000, 0, 0, 0, "merchant@example.com", orderId);
    await createCaptureEvidenceFixture(fixture.cartId, orderId, captureId, 5000, "merchant@example.com");

    const refundTxId = "tx_ref_part_" + crypto.randomUUID();
    const refundId = "REF-PART-1-" + crypto.randomUUID();
    await createRefundTransmissionFixture(refundTxId, orderId, captureId, refundId, 2000, "merchant@example.com");

    const service = new RefundService(client, undefined, hmacKeyId);

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    const result = await service.executeCartRefund({
      cartId: fixture.cartId,
      amountCents: 2000,
      reason: "Buyer returned 1 of 2 items",
      transmissionId: refundTxId,
    });

    expect(result.cartId).toBe(fixture.cartId);
    expect(result.status).toBe("PARTIALLY_REFUNDED");
    expect(result.cumulativeRefundedCents).toBe(BigInt(2000));

    await client.query("RESET SESSION AUTHORIZATION;");
    const cartCheck = await client.query('SELECT "checkoutStatus", "cumulativeRefundedCents" FROM public."ApprovedMerchantCart" WHERE id = $1', [fixture.cartId]);
    expect(cartCheck.rows[0].checkoutStatus).toBe("PARTIALLY_REFUNDED");
    expect(Number(cartCheck.rows[0].cumulativeRefundedCents)).toBe(2000);
  });

  it("2. records second partial refund completing full total and transitions to REFUNDED", async () => {
    // Starting with the cart from test 1 (currently PARTIALLY_REFUNDED with 2000 cents out of 5000 cents)
    const orderId = "ORD-REF-FULL-" + crypto.randomUUID();
    const captureId = "CAP-REF-FULL-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURED", 5000, 0, 0, 0, "merchant@example.com", orderId);
    await createCaptureEvidenceFixture(fixture.cartId, orderId, captureId, 5000, "merchant@example.com");

    // First refund: 3000
    const tx1 = "tx_r1_" + crypto.randomUUID();
    const ref1 = "REF-1-" + crypto.randomUUID();
    await createRefundTransmissionFixture(tx1, orderId, captureId, ref1, 3000, "merchant@example.com");
    // Second refund: remaining 2000 (total 5000)
    const tx2 = "tx_r2_" + crypto.randomUUID();
    const ref2 = "REF-2-" + crypto.randomUUID();
    await createRefundTransmissionFixture(tx2, orderId, captureId, ref2, 2000, "merchant@example.com");

    const service = new RefundService(client, undefined, hmacKeyId);

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    await service.executeCartRefund({
      cartId: fixture.cartId,
      amountCents: 3000,
      reason: "Partial return item 1",
      transmissionId: tx1,
    });

    const finalResult = await service.executeCartRefund({
      cartId: fixture.cartId,
      amountCents: 2000,
      reason: "Partial return item 2",
      transmissionId: tx2,
    });

    expect(finalResult.status).toBe("REFUNDED");
    expect(finalResult.cumulativeRefundedCents).toBe(BigInt(5000));

    await client.query("RESET SESSION AUTHORIZATION;");
    const cartCheck = await client.query('SELECT "checkoutStatus", "cumulativeRefundedCents" FROM public."ApprovedMerchantCart" WHERE id = $1', [fixture.cartId]);
    expect(cartCheck.rows[0].checkoutStatus).toBe("REFUNDED");
    expect(Number(cartCheck.rows[0].cumulativeRefundedCents)).toBe(5000);
  });

  it("3. rejects refund attempt that exceeds cumulative cart total with SQLSTATE 22023", async () => {
    const orderId = "ORD-REF-OVER-" + crypto.randomUUID();
    const captureId = "CAP-REF-OVER-" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURED", 4000, 0, 0, 0, "merchant@example.com", orderId);
    await createCaptureEvidenceFixture(fixture.cartId, orderId, captureId, 4000, "merchant@example.com");

    // Attempting to refund 5000 on a 4000 cart!
    const overTx = "tx_over_" + crypto.randomUUID();
    const refOver = "REF-OVER-" + crypto.randomUUID();
    await createRefundTransmissionFixture(overTx, orderId, captureId, refOver, 5000, "merchant@example.com");

    const service = new RefundService(client, undefined, hmacKeyId);

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    let err: any;
    try {
      await service.executeCartRefund({
        cartId: fixture.cartId,
        amountCents: 5000,
        reason: "Excessive refund attempt",
        transmissionId: overTx,
      });
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(["22023", "23514"]).toContain(err.code);
  });
});
