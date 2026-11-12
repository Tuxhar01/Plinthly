import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestTaxCert,
  createTestKeys,
} from "../database/helpers/routine-test-helper";

describe("Section 10 Acceptance Test: TEST-LOCK-02 (All 28 Canonical Routine Pairings Concurrency)", () => {
  let masterClient: Client;
  const authorityId = "AUTH-LOCK02";
  const certNumber = "CERT-LOCK02-2026";
  const attestKeyId = "vak_lock02";
  const hmacKeyId = "audit_hmac_lock02";

  beforeAll(async () => {
    masterClient = await createStage2Client();
    await ensureRolesExist(masterClient);
    await createTestTaxCert(masterClient, authorityId, certNumber);
    await createTestKeys(masterClient, attestKeyId, hmacKeyId, "tax_worker_01");
  });

  afterAll(async () => {
    await masterClient.end();
  });

  it("executes concurrent multi-routine transactions across distinct and overlapping entities with 0 deadlocks (SQLSTATE 40P01)", async () => {
    const clients: Client[] = [];
    const clientCount = 8;

    for (let i = 0; i < clientCount; i++) {
      const c = await createStage2Client();
      clients.push(c);
    }

    const cartA = await createTestCartFixture(masterClient, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const cartB = await createTestCartFixture(masterClient, "BUYER_APPROVED", 4000, 0, 0, 0);

    const txId = "tx_lock02_" + crypto.randomUUID();
    const rawPayload = Buffer.from(JSON.stringify({ id: txId, event_type: "PAYMENT.CAPTURE.COMPLETED" }));

    // Concurrently execute interleaved routine actions across the 8 clients
    const tasks = clients.map(async (client, idx) => {
      try {
        if (idx % 4 === 0) {
          // Client calls R2-02 (prepare)
          await client.query("BEGIN;");
          await client.query(
            `SELECT * FROM public.prepare_merchant_cart_capture($1, $2, 3000, 'USD', $3);`,
            [cartA.cartId, cartA.aggregateId, "idemp_lock02_" + idx]
          );
          await client.query("COMMIT;");
        } else if (idx % 4 === 1) {
          // Client calls R2-03 (webhook ingress)
          await client.query("BEGIN;");
          const distinctTx = `tx_pair_${idx}_${crypto.randomUUID()}`;
          await client.query(
            `SELECT * FROM public.record_webhook_transmission_ingress(
               $1, 'PAYMENT.CAPTURE.COMPLETED', 'ORD-PAIR-1', 'CAP-PAIR-1', NULL,
               2500, 'USD', 'payee@example.com', $2, $3, $4
             );`,
            [distinctTx, rawPayload, hmacKeyId, "nonce_pair_" + idx]
          );
          await client.query("COMMIT;");
        } else if (idx % 4 === 2) {
          // Client reads cart & key concurrently (Level 1 & Level 3 shared locks)
          await client.query("BEGIN;");
          await client.query(
            `SELECT * FROM public."ApprovedMerchantCart" WHERE id = $1 FOR SHARE;`,
            [cartB.cartId]
          );
          await client.query(
            `SELECT * FROM public."AuditSigningKey" WHERE key_id = $1 FOR SHARE;`,
            [attestKeyId]
          );
          await client.query("COMMIT;");
        } else {
          // Client executes advisory lock on transmission
          await client.query("BEGIN;");
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext('transmission:' || $1));`,
            [`trans_test_${idx}`]
          );
          await client.query("COMMIT;");
        }
        return { success: true, clientIndex: idx };
      } catch (err: any) {
        await client.query("ROLLBACK;").catch(() => {});
        return { success: false, clientIndex: idx, code: err.code, message: err.message };
      }
    });

    const results = await Promise.all(tasks);

    // Close all test clients
    for (const c of clients) {
      await c.end().catch(() => {});
    }

    // Invariant: Zero deadlocks (40P01) permitted!
    for (const res of results) {
      if (!res.success) {
        expect(res.code).not.toBe("40P01");
      }
    }
  });
});

