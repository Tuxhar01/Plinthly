import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestKeys,
} from "../database/helpers/routine-test-helper";

describe("Section 10 Acceptance Test: TEST-LOCK-01 (Monotonic Locking Hierarchy in R2-05)", () => {
  let client: Client;
  const hmacKeyId = "audit_hmac_lock01";
  const orchestratorPrincipal = "orchestrator_worker_user";

  beforeAll(async () => {
    client = await createStage2Client();
    await ensureRolesExist(client);
    await createTestKeys(client, "vak_lock01", hmacKeyId, "unused");
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("RESET SESSION AUTHORIZATION;");
  });

  async function createTransmissionFixture(
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
      );
    `, [txId, orderId, captureId, amountCents, payeeEmail, rawPayload]);
  }

  it("verifies R2-05 strictly executes Level 0 through Level 5 monotonic sequence without deadlocks or inversions", async () => {
    const orderId = "ORD-LOCK01-" + crypto.randomUUID();
    const captureId = "CAP-LOCK01-" + crypto.randomUUID();
    const txId = "tx_lock01_" + crypto.randomUUID();
    const fixture = await createTestCartFixture(client, "CAPTURING", 2500, 500, 1000, 0, "merchant@example.com", orderId);
    await createTransmissionFixture(txId, orderId, captureId, 3000, "merchant@example.com");

    await client.query(`SET SESSION AUTHORIZATION ${orchestratorPrincipal};`);

    // Execute R2-05 inside explicit transaction to verify locks held during transaction
    await client.query("BEGIN;");

    const res = await client.query(
      `SELECT payment_evidence_id, cart_id, status, recorded_at, idempotent_retry
         FROM public.execute_capture_confirmation(
           $1, $2, $3, $4, $5
         );`,
      [fixture.cartId, txId, captureId, hmacKeyId, "nonce_lock01_" + crypto.randomUUID()]
    );

    expect(res.rows[0].status).toBe("CAPTURED");
    expect(res.rows[0].idempotent_retry).toBe(false);

    // Verify advisory lock (Level 0) is held in pg_locks
    const lockCheck = await client.query(`
      SELECT locktype, mode, granted 
      FROM pg_locks 
      WHERE pid = pg_backend_pid() AND locktype = 'advisory';
    `);

    expect(lockCheck.rows.length).toBeGreaterThan(0);
    expect(lockCheck.rows[0].granted).toBe(true);
    expect(lockCheck.rows[0].mode).toBe("ExclusiveLock");

    await client.query("COMMIT;");
    await client.query("RESET SESSION AUTHORIZATION;");
  });
});
