import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestKeys,
} from "../helpers/routine-test-helper";

describe("Routine R2-06: record_cart_refund_attempt", () => {
  let client: Client;
  const hmacKeyId = "hmac_key_refund_test";

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

  async function setupCapturedCartWithEvidence(totalAmount: number = 5000) {
    const cart = await createTestCartFixture(client, "CAPTURED", totalAmount, 0, 0, 0);
    const captureId = "CAP_REF_" + crypto.randomUUID();
    const transmissionId = "TX_CAP_" + crypto.randomUUID();

    // Insert WebhookTransmission for original capture
    await client.query(`
      INSERT INTO public."WebhookTransmission" (
        transmission_id, authenticated_event_type, authenticated_order_id,
        authenticated_capture_id, authenticated_refund_id, authenticated_amount_cents,
        authenticated_currency, authenticated_payee_email, raw_payload, payload_hash,
        status, response_code, created_at
      ) VALUES (
        $1, 'PAYMENT.CAPTURE.COMPLETED', 'ORD_REF',
        $2, NULL, $3,
        'USD', 'merchant@example.com', 'raw_cap'::bytea, extensions.digest('raw_cap'::bytea, 'sha256'),
        'PROCESSED', 200, clock_timestamp()
      );
    `, [transmissionId, captureId, totalAmount]);

    // Insert PaymentEvidenceRecord
    await client.query(`
      INSERT INTO public."PaymentEvidenceRecord" (
        cart_id, transmission_id, capture_id, paypal_order_id,
        amount_cents, currency, payee_email, internal_audit_signature, recorded_at
      ) VALUES (
        $1, $2, $3, 'ORD_REF',
        $4, 'USD', 'merchant@example.com', $5, clock_timestamp()
      );
    `, [cart.cartId, transmissionId, captureId, totalAmount, Buffer.alloc(32)]);

    return { cart, captureId, transmissionId };
  }

  async function createRefundTransmission(
    transmissionId: string,
    captureId: string,
    refundId: string,
    refundAmountCents: number,
    status: string = "PROCESSED",
    eventType: string = "PAYMENT.CAPTURE.REFUNDED"
  ) {
    const rawPayload = Buffer.from(JSON.stringify({ id: transmissionId, refund_id: refundId }));
    await client.query(`
      INSERT INTO public."WebhookTransmission" (
        transmission_id, authenticated_event_type, authenticated_order_id,
        authenticated_capture_id, authenticated_refund_id, authenticated_amount_cents,
        authenticated_currency, authenticated_payee_email, raw_payload, payload_hash,
        status, response_code, created_at
      ) VALUES (
        $1, $2, 'ORD_REF',
        $3, $4, $5,
        'USD', 'merchant@example.com', $6::bytea, extensions.digest($6::bytea, 'sha256'),
        $7, 200, clock_timestamp()
      );
    `, [transmissionId, eventType, captureId, refundId, refundAmountCents, rawPayload, status]);
  }

  it("records partial refund and transitions cart to PARTIALLY_REFUNDED", async () => {
    const { cart, captureId } = await setupCapturedCartWithEvidence(5000);
    const refundTxId = "tx_ref_part_" + crypto.randomUUID();
    const refundId = "REF_01_" + crypto.randomUUID();
    await createRefundTransmission(refundTxId, captureId, refundId, 2000, "PROCESSED");

    const nonce = "nonce_ref_" + crypto.randomUUID();

    let res: any;
    try {
      await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
      res = await client.query(`
        SELECT * FROM public.record_cart_refund_attempt($1, $2, $3, $4, $5, $6);
      `, [cart.cartId, captureId, refundTxId, hmacKeyId, nonce, "Customer requested item return"]);
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    const row = res.rows[0];
    expect(row.cart_id).toBe(cart.cartId);
    expect(row.cumulative_refunded_cents).toBe("2000");
    expect(row.status).toBe("PARTIALLY_REFUNDED");
    expect(row.refund_evidence_id).toBeDefined();

    // Verify RefundEvidenceRecord
    const refCheck = await client.query('SELECT * FROM public."RefundEvidenceRecord" WHERE id = $1', [row.refund_evidence_id]);
    expect(refCheck.rows.length).toBe(1);
    expect(refCheck.rows[0].refund_amount_cents).toBe("2000");
    expect(refCheck.rows[0].authenticated_refund_id).toBe(refundId);

    // Verify cart updated
    const cartCheck = await client.query('SELECT "checkoutStatus", "cumulativeRefundedCents" FROM public."ApprovedMerchantCart" WHERE id = $1', [cart.cartId]);
    expect(cartCheck.rows[0].checkoutStatus).toBe("PARTIALLY_REFUNDED");
    expect(cartCheck.rows[0].cumulativeRefundedCents).toBe("2000");
  });

  it("transitions cart to REFUNDED when cumulative refunds reach total cart amount", async () => {
    const { cart, captureId } = await setupCapturedCartWithEvidence(5000);

    // First refund: 2000
    const refTx1 = "tx_ref_seq1_" + crypto.randomUUID();
    const refId1 = "REF_S1_" + crypto.randomUUID();
    await createRefundTransmission(refTx1, captureId, refId1, 2000);

    // Second refund: 3000 (reaching 5000)
    const refTx2 = "tx_ref_seq2_" + crypto.randomUUID();
    const refId2 = "REF_S2_" + crypto.randomUUID();
    await createRefundTransmission(refTx2, captureId, refId2, 3000);

    try {
      await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
      await client.query(`
        SELECT * FROM public.record_cart_refund_attempt($1, $2, $3, $4, $5, $6);
      `, [cart.cartId, captureId, refTx1, hmacKeyId, "nonce_" + crypto.randomUUID(), "First partial"]);

      const res2 = await client.query(`
        SELECT * FROM public.record_cart_refund_attempt($1, $2, $3, $4, $5, $6);
      `, [cart.cartId, captureId, refTx2, hmacKeyId, "nonce_" + crypto.randomUUID(), "Final remainder"]);

      expect(res2.rows[0].status).toBe("REFUNDED");
      expect(res2.rows[0].cumulative_refunded_cents).toBe("5000");
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    const cartCheck = await client.query('SELECT "checkoutStatus", "cumulativeRefundedCents" FROM public."ApprovedMerchantCart" WHERE id = $1', [cart.cartId]);
    expect(cartCheck.rows[0].checkoutStatus).toBe("REFUNDED");
    expect(cartCheck.rows[0].cumulativeRefundedCents).toBe("5000");
  });

  it("rejects refund when cumulative refund exceeds total cart amount with SQLSTATE 23514", async () => {
    const { cart, captureId } = await setupCapturedCartWithEvidence(5000);
    const refTxId = "tx_ref_over_" + crypto.randomUUID();
    const refIdOver = "REF_OVER_" + crypto.randomUUID();
    await createRefundTransmission(refTxId, captureId, refIdOver, 6000);

    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
      await client.query(`
        SELECT * FROM public.record_cart_refund_attempt($1, $2, $3, $4, $5, $6);
      `, [cart.cartId, captureId, refTxId, hmacKeyId, "nonce_" + crypto.randomUUID(), "Excessive refund"]);
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("23514");
    expect(err.message).toContain("ERR_EXCEEDS_CUMULATIVE_LIMIT");
  });

  it("rejects refund attempt on uncaptured cart with SQLSTATE 55000", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 5000, 0, 0, 0);

    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
      await client.query(`
        SELECT * FROM public.record_cart_refund_attempt($1, $2, $3, $4, $5, $6);
      `, [cart.cartId, "CAP_FAKE", "TX_FAKE", hmacKeyId, "nonce_" + crypto.randomUUID(), "Reason"]);
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("55000");
    expect(err.message).toContain("ERR_INVALID_TRANSITION");
  });

  it("rejects duplicate nonce on refund with SQLSTATE 23505", async () => {
    const { cart, captureId } = await setupCapturedCartWithEvidence(5000);
    const refTx1 = "tx_ref_n1_" + crypto.randomUUID();
    const refTx2 = "tx_ref_n2_" + crypto.randomUUID();
    const refIdN1 = "REF_N1_" + crypto.randomUUID();
    const refIdN2 = "REF_N2_" + crypto.randomUUID();
    await createRefundTransmission(refTx1, captureId, refIdN1, 1000);
    await createRefundTransmission(refTx2, captureId, refIdN2, 1000);

    const sharedNonce = "nonce_ref_shared_" + crypto.randomUUID();

    try {
      await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
      await client.query(`
        SELECT * FROM public.record_cart_refund_attempt($1, $2, $3, $4, $5, $6);
      `, [cart.cartId, captureId, refTx1, hmacKeyId, sharedNonce, "First"]);
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
      await client.query(`
        SELECT * FROM public.record_cart_refund_attempt($1, $2, $3, $4, $5, $6);
      `, [cart.cartId, captureId, refTx2, hmacKeyId, sharedNonce, "Second"]);
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("23505");
    expect(err.message).toContain("ERR_REPLAY_ATTACK_DETECTED");
  });

  it("rejects unauthorized caller role with SQLSTATE 42501", async () => {
    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION webhook_ingress_role;");
      await client.query(`
        SELECT * FROM public.record_cart_refund_attempt($1, $2, $3, $4, $5, $6);
      `, [crypto.randomUUID(), "CAP_1", "TX_1", hmacKeyId, "nonce_unauth", "Reason"]);
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("42501");
  });
});
