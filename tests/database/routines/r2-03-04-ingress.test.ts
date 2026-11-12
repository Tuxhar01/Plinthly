import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestKeys,
} from "../helpers/routine-test-helper";

describe("Routines R2-03 & R2-04: Webhook Transmission Ingress & Finalization", () => {
  let client: Client;
  const hmacKeyId = "hmac_key_ingress_test";

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

  describe("R2-03: record_webhook_transmission_ingress", () => {
    it("persists raw wire payload, payload hash, and consumes nonce", async () => {
      const txId = "tx_ing_" + crypto.randomUUID();
      const nonce = "nonce_ing_" + crypto.randomUUID();
      const rawPayload = Buffer.from(JSON.stringify({ event: "PAYMENT.CAPTURE.COMPLETED", id: txId }));

      let res: any;
      try {
        await client.query("SET SESSION AUTHORIZATION ingress_worker_user;");
        res = await client.query(`
          SELECT * FROM public.record_webhook_transmission_ingress(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          );
        `, [
          txId, "PAYMENT.CAPTURE.COMPLETED", "ORD_123", "CAP_123", null,
          5000, "USD", "merchant@example.com", rawPayload, hmacKeyId, nonce
        ]);
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(res.rows[0].transmission_id).toBe(txId);
      expect(res.rows[0].status).toBe("RECORDED");
      expect(res.rows[0].created_at).toBeDefined();

      // Verify row in WebhookTransmission
      const dbCheck = await client.query('SELECT * FROM public."WebhookTransmission" WHERE transmission_id = $1', [txId]);
      expect(dbCheck.rows.length).toBe(1);
      expect(dbCheck.rows[0].status).toBe("RECORDED");
      expect(dbCheck.rows[0].response_code).toBe(200);
      expect(dbCheck.rows[0].authenticated_amount_cents).toBe("5000");

      // Verify NonceRegistry
      const nonceCheck = await client.query('SELECT * FROM public."NonceRegistry" WHERE nonce = $1 AND scope = \'webhook_ingress\'', [nonce]);
      expect(nonceCheck.rows.length).toBe(1);
    });

    it("rejects duplicate nonce with SQLSTATE 23505", async () => {
      const txId1 = "tx_ing_dup1_" + crypto.randomUUID();
      const txId2 = "tx_ing_dup2_" + crypto.randomUUID();
      const sharedNonce = "nonce_ing_shared_" + crypto.randomUUID();
      const rawPayload = Buffer.from(JSON.stringify({ test: "data" }));

      try {
        await client.query("SET SESSION AUTHORIZATION ingress_worker_user;");
        // First succeeds
        await client.query(`
          SELECT * FROM public.record_webhook_transmission_ingress(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          );
        `, [
          txId1, "PAYMENT.CAPTURE.COMPLETED", "ORD_1", "CAP_1", null,
          5000, "USD", "merchant@example.com", rawPayload, hmacKeyId, sharedNonce
        ]);
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      // Second with same nonce fails
      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION ingress_worker_user;");
        await client.query(`
          SELECT * FROM public.record_webhook_transmission_ingress(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          );
        `, [
          txId2, "PAYMENT.CAPTURE.COMPLETED", "ORD_2", "CAP_2", null,
          5000, "USD", "merchant@example.com", rawPayload, hmacKeyId, sharedNonce
        ]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("23505");
      expect(err.message).toContain("ERR_REPLAY_ATTACK_DETECTED");
    });

    it("rejects unauthorized role with SQLSTATE 42501", async () => {
      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION app_orchestrator_role;");
        await client.query(`
          SELECT * FROM public.record_webhook_transmission_ingress(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          );
        `, ["tx_unauth", "EVENT", null, null, null, 100, "USD", null, Buffer.from("a"), hmacKeyId, "n_unauth"]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("42501");
    });
  });

  describe("R2-04: finalize_transmission_response", () => {
    it("transitions RECORDED transmission to PROCESSED", async () => {
      const txId = "tx_fin_proc_" + crypto.randomUUID();
      const rawPayload = Buffer.from(JSON.stringify({ id: txId }));
      const nonce = "nonce_fin_" + crypto.randomUUID();

      // Ingress
      try {
        await client.query("SET SESSION AUTHORIZATION ingress_worker_user;");
        await client.query(`
          SELECT * FROM public.record_webhook_transmission_ingress(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          );
        `, [
          txId, "PAYMENT.CAPTURE.COMPLETED", "ORD_1", "CAP_1", null,
          1000, "USD", "merchant@example.com", rawPayload, hmacKeyId, nonce
        ]);

        // Finalize
        const finRes = await client.query(`
          SELECT * FROM public.finalize_transmission_response($1, $2, $3);
        `, [txId, "PROCESSED", 200]);

        expect(finRes.rows[0].transmission_id).toBe(txId);
        expect(finRes.rows[0].status).toBe("PROCESSED");
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      const dbCheck = await client.query('SELECT status, response_code FROM public."WebhookTransmission" WHERE transmission_id = $1', [txId]);
      expect(dbCheck.rows[0].status).toBe("PROCESSED");
      expect(dbCheck.rows[0].response_code).toBe(200);
    });

    it("rejects re-finalization of already PROCESSED transmission with SQLSTATE 55000", async () => {
      const txId = "tx_fin_re_" + crypto.randomUUID();
      const rawPayload = Buffer.from(JSON.stringify({ id: txId }));
      const nonce = "nonce_fin_re_" + crypto.randomUUID();

      try {
        await client.query("SET SESSION AUTHORIZATION ingress_worker_user;");
        await client.query(`
          SELECT * FROM public.record_webhook_transmission_ingress(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          );
        `, [
          txId, "PAYMENT.CAPTURE.COMPLETED", "ORD_1", "CAP_1", null,
          1000, "USD", "merchant@example.com", rawPayload, hmacKeyId, nonce
        ]);

        await client.query(`
          SELECT * FROM public.finalize_transmission_response($1, $2, $3);
        `, [txId, "PROCESSED", 200]);
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION ingress_worker_user;");
        await client.query(`
          SELECT * FROM public.finalize_transmission_response($1, $2, $3);
        `, [txId, "PROCESSED", 200]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("55000");
      expect(err.message).toContain("ERR_INVALID_TRANSITION");
    });

    it("rejects non-existent transmission with SQLSTATE P0002", async () => {
      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION ingress_worker_user;");
        await client.query(`
          SELECT * FROM public.finalize_transmission_response($1, $2, $3);
        `, ["tx_nonexistent_" + crypto.randomUUID(), "PROCESSED", 200]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("P0002");
      expect(err.message).toContain("ERR_TRANSMISSION_NOT_FOUND");
    });
  });
});

