import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestKeys,
} from "../helpers/routine-test-helper";

describe("Routines R2-02 & R2-05: Cart Capture Lifecycle & Confirmation", () => {
  let client: Client;
  const hmacKeyId = "hmac_key_capture_test";

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

  async function createTransmissionFixture(
    transmissionId: string,
    orderId: string,
    captureId: string,
    amountCents: number,
    payeeEmail: string,
    status: string = "PROCESSED",
    eventType: string = "PAYMENT.CAPTURE.COMPLETED"
  ) {
    const rawPayload = Buffer.from(JSON.stringify({ id: transmissionId, event_type: eventType }));
    await client.query(`
      INSERT INTO public."WebhookTransmission" (
        transmission_id, authenticated_event_type, authenticated_order_id,
        authenticated_capture_id, authenticated_refund_id, authenticated_amount_cents,
        authenticated_currency, authenticated_payee_email, raw_payload, payload_hash,
        status, response_code, created_at
      ) VALUES (
        $1, $2, $3,
        $4, NULL, $5,
        'USD', $6, $7::bytea, extensions.digest($7::bytea, 'sha256'),
        $8, 200, clock_timestamp()
      ) ON CONFLICT (transmission_id) DO UPDATE
        SET status = $8, authenticated_amount_cents = $5, authenticated_capture_id = $4;
    `, [transmissionId, eventType, orderId, captureId, amountCents, payeeEmail, rawPayload, status]);
  }

  describe("R2-02: prepare_merchant_cart_capture", () => {
    it("atomically transitions BUYER_APPROVED cart to CAPTURING under row lock", async () => {
      const cart = await createTestCartFixture(client, "BUYER_APPROVED", 3000, 0, 0, 0);

      let res: any;
      try {
        await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
        res = await client.query(`
          SELECT * FROM public.prepare_merchant_cart_capture($1, $2, $3, $4, $5);
        `, [cart.cartId, cart.aggregateId, 3000, "USD", "idemp_" + crypto.randomUUID()]);
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(res.rows[0].cart_id).toBe(cart.cartId);
      expect(res.rows[0].status).toBe("CAPTURING");
      expect(res.rows[0].locked_at).toBeDefined();

      const dbCheck = await client.query('SELECT "checkoutStatus", "lockedAt" FROM public."ApprovedMerchantCart" WHERE id = $1', [cart.cartId]);
      expect(dbCheck.rows[0].checkoutStatus).toBe("CAPTURING");
      expect(dbCheck.rows[0].lockedAt).not.toBeNull();
    });

    it("rejects transition if cart is already CAPTURING with SQLSTATE 55000", async () => {
      const cart = await createTestCartFixture(client, "CAPTURING", 3000, 0, 0, 0);

      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
        await client.query(`
          SELECT * FROM public.prepare_merchant_cart_capture($1, $2, $3, $4, $5);
        `, [cart.cartId, cart.aggregateId, 3000, "USD", "idemp_" + crypto.randomUUID()]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("55000");
      expect(err.message).toContain("ERR_INVALID_TRANSITION");
    });

    it("rejects amount mismatch with SQLSTATE 22023", async () => {
      const cart = await createTestCartFixture(client, "BUYER_APPROVED", 3000, 0, 0, 0);

      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
        await client.query(`
          SELECT * FROM public.prepare_merchant_cart_capture($1, $2, $3, $4, $5);
        `, [cart.cartId, cart.aggregateId, 4500, "USD", "idemp_" + crypto.randomUUID()]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("22023");
      expect(err.message).toContain("ERR_AMOUNT_MISMATCH");
    });

    it("rejects unauthorized role with SQLSTATE 42501", async () => {
      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION webhook_ingress_role;");
        await client.query(`
          SELECT * FROM public.prepare_merchant_cart_capture($1, $2, $3, $4, $5);
        `, [crypto.randomUUID(), crypto.randomUUID(), 3000, "USD", "idemp_unauth"]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("42501");
    });
  });

  describe("R2-05: execute_capture_confirmation", () => {
    it("confirms capture, transitions cart to CAPTURED, and records PaymentEvidenceRecord", async () => {
      const orderId = "ORD_CONF_" + crypto.randomUUID();
      const captureId = "CAP_CONF_" + crypto.randomUUID();
      const txId = "TX_CONF_" + crypto.randomUUID();
      const payee = "merchant_cap@example.com";
      const totalAmount = 3000;

      const cart = await createTestCartFixture(client, "CAPTURING", totalAmount, 0, 0, 0, payee, orderId);
      await createTransmissionFixture(txId, orderId, captureId, totalAmount, payee, "PROCESSED");

      const nonce = "nonce_cap_" + crypto.randomUUID();

      let res: any;
      try {
        await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
        res = await client.query(`
          SELECT * FROM public.execute_capture_confirmation($1, $2, $3, $4, $5);
        `, [cart.cartId, txId, captureId, hmacKeyId, nonce]);
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      const row = res.rows[0];
      expect(row.cart_id).toBe(cart.cartId);
      expect(row.status).toBe("CAPTURED");
      expect(row.idempotent_retry).toBe(false);
      expect(row.payment_evidence_id).toBeDefined();

      // Verify PaymentEvidenceRecord exists
      const peCheck = await client.query('SELECT * FROM public."PaymentEvidenceRecord" WHERE id = $1', [row.payment_evidence_id]);
      expect(peCheck.rows.length).toBe(1);
      expect(peCheck.rows[0].capture_id).toBe(captureId);
      expect(peCheck.rows[0].amount_cents).toBe("3000");
      expect(peCheck.rows[0].internal_audit_signature).toBeDefined();

      // Verify cart status is CAPTURED
      const cartCheck = await client.query('SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1', [cart.cartId]);
      expect(cartCheck.rows[0].checkoutStatus).toBe("CAPTURED");
    });

    it("returns idempotent retry on identical re-confirmation", async () => {
      const orderId = "ORD_RETRY_" + crypto.randomUUID();
      const captureId = "CAP_RETRY_" + crypto.randomUUID();
      const txId = "TX_RETRY_" + crypto.randomUUID();
      const payee = "merchant_retry@example.com";
      const totalAmount = 2500;

      const cart = await createTestCartFixture(client, "CAPTURING", totalAmount, 0, 0, 0, payee, orderId);
      await createTransmissionFixture(txId, orderId, captureId, totalAmount, payee, "PROCESSED");

      const nonce1 = "nonce_cap_1_" + crypto.randomUUID();
      const nonce2 = "nonce_cap_2_" + crypto.randomUUID();

      let res1: any;
      let res2: any;
      try {
        await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
        res1 = await client.query(`
          SELECT * FROM public.execute_capture_confirmation($1, $2, $3, $4, $5);
        `, [cart.cartId, txId, captureId, hmacKeyId, nonce1]);

        res2 = await client.query(`
          SELECT * FROM public.execute_capture_confirmation($1, $2, $3, $4, $5);
        `, [cart.cartId, txId, captureId, hmacKeyId, nonce2]);
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(res1.rows[0].idempotent_retry).toBe(false);
      expect(res2.rows[0].idempotent_retry).toBe(true);
      expect(res2.rows[0].payment_evidence_id).toBe(res1.rows[0].payment_evidence_id);
    });

    it("rejects conflicting capture on already-captured cart with SQLSTATE 23505", async () => {
      const orderId = "ORD_DUP_" + crypto.randomUUID();
      const captureId1 = "CAP_DUP_1_" + crypto.randomUUID();
      const captureId2 = "CAP_DUP_2_" + crypto.randomUUID();
      const txId1 = "TX_DUP_1_" + crypto.randomUUID();
      const txId2 = "TX_DUP_2_" + crypto.randomUUID();
      const payee = "merchant_dup@example.com";
      const totalAmount = 2500;

      const cart = await createTestCartFixture(client, "CAPTURING", totalAmount, 0, 0, 0, payee, orderId);
      await createTransmissionFixture(txId1, orderId, captureId1, totalAmount, payee, "PROCESSED");
      await createTransmissionFixture(txId2, orderId, captureId2, totalAmount, payee, "PROCESSED");

      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
        // First capture succeeds
        await client.query(`
          SELECT * FROM public.execute_capture_confirmation($1, $2, $3, $4, $5);
        `, [cart.cartId, txId1, captureId1, hmacKeyId, "nonce_" + crypto.randomUUID()]);

        // Second capture with different capture ID fails
        await client.query(`
          SELECT * FROM public.execute_capture_confirmation($1, $2, $3, $4, $5);
        `, [cart.cartId, txId2, captureId2, hmacKeyId, "nonce_" + crypto.randomUUID()]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("23505");
      expect(err.message).toContain("ERR_CART_ALREADY_CAPTURED");
    });

    it("rejects confirmation if transmission is not in PROCESSED status with SQLSTATE 55000", async () => {
      const orderId = "ORD_RAW_" + crypto.randomUUID();
      const captureId = "CAP_RAW_" + crypto.randomUUID();
      const txId = "TX_RAW_" + crypto.randomUUID();
      const payee = "merchant_raw@example.com";
      const totalAmount = 3000;

      const cart = await createTestCartFixture(client, "CAPTURING", totalAmount, 0, 0, 0, payee, orderId);
      // Transmission is RECORDED, not PROCESSED
      await createTransmissionFixture(txId, orderId, captureId, totalAmount, payee, "RECORDED");

      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
        await client.query(`
          SELECT * FROM public.execute_capture_confirmation($1, $2, $3, $4, $5);
        `, [cart.cartId, txId, captureId, hmacKeyId, "nonce_" + crypto.randomUUID()]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("55000");
      expect(err.message).toContain("ERR_TRANSMISSION_NOT_PROCESSED");
    });

    it("rejects order ID mismatch with SQLSTATE 22023", async () => {
      const orderId = "ORD_CART_" + crypto.randomUUID();
      const mismatchedOrderId = "ORD_DIFF_" + crypto.randomUUID();
      const captureId = "CAP_MIS_" + crypto.randomUUID();
      const txId = "TX_MIS_" + crypto.randomUUID();
      const payee = "merchant_mis@example.com";
      const totalAmount = 3000;

      const cart = await createTestCartFixture(client, "CAPTURING", totalAmount, 0, 0, 0, payee, orderId);
      await createTransmissionFixture(txId, mismatchedOrderId, captureId, totalAmount, payee, "PROCESSED");

      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
        await client.query(`
          SELECT * FROM public.execute_capture_confirmation($1, $2, $3, $4, $5);
        `, [cart.cartId, txId, captureId, hmacKeyId, "nonce_" + crypto.randomUUID()]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("22023");
      expect(err.message).toContain("ERR_ORDER_ID_MISMATCH");
    });
  });
});
