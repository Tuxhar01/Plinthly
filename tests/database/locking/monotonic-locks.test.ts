import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestKeys,
  createTestTaxCert,
} from "../helpers/routine-test-helper";

describe("Monotonic Locking Protocol & Concurrency Verification", () => {
  let mainClient: Client;

  beforeAll(async () => {
    mainClient = await createStage2Client();
    await ensureRolesExist(mainClient);
    await createTestTaxCert(mainClient);
    await createTestKeys(mainClient);
  });

  afterAll(async () => {
    await mainClient.end();
  });

  beforeEach(async () => {
    await mainClient.query("RESET SESSION AUTHORIZATION;");
  });

  describe("Level 0 Advisory Mutex Enforcement", () => {
    it("enforces mutual exclusion between R2-02 and R2-05 on cart_checkout advisory mutex", async () => {
      const c1 = await createStage2Client();
      const c2 = await createStage2Client();

      try {
        const fixture = await createTestCartFixture(mainClient, "BUYER_APPROVED", 5000, 0, 0, 0, "merchant@example.com", "ORD-MUTEX-01");
        const cartId = fixture.cartId;

        // Tx 1 acquires advisory lock on cart_checkout:<cartId>
        await c1.query("BEGIN;");
        await c1.query("SELECT pg_advisory_xact_lock(hashtext('cart_checkout:' || $1::text));", [cartId]);

        // Tx 2 attempts R2-02 in orchestrator_worker_user context with a 200ms statement_timeout
        await c2.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
        await c2.query("SET statement_timeout = 200;");

        let timedOut = false;
        try {
          await c2.query(`
            SELECT * FROM public.prepare_merchant_cart_capture(
              $1, $2, 5000, 'USD', 'nonce_lock_01'
            );
          `, [cartId, fixture.aggregateId]);
        } catch (err: any) {
          // Statement timeout (57014) indicates lock acquisition was blocked by Tx 1's advisory lock
          if (err.code === "57014") {
            timedOut = true;
          } else {
            throw err;
          }
        } finally {
          await c2.query("RESET statement_timeout;");
          await c2.query("RESET SESSION AUTHORIZATION;");
        }

        expect(timedOut).toBe(true);

        // Commit Tx 1 to release the advisory lock
        await c1.query("COMMIT;");
      } finally {
        await c1.end();
        await c2.end();
      }
    });

    it("enforces mutual exclusion between R2-03 and R2-04 on transmission advisory mutex", async () => {
      const c1 = await createStage2Client();
      const c2 = await createStage2Client();

      try {
        const txId = "tx_mutex_test_" + crypto.randomUUID();

        // Tx 1 holds advisory lock on transmission:<txId>
        await c1.query("BEGIN;");
        await c1.query("SELECT pg_advisory_xact_lock(hashtext('transmission:' || $1::text));", [txId]);

        // Tx 2 attempts R2-03 on the same transmission ID with a 200ms statement_timeout
        await c2.query("SET SESSION AUTHORIZATION ingress_worker_user;");
        await c2.query("SET statement_timeout = 200;");

        let timedOut = false;
        try {
          const rawPayload = Buffer.from(JSON.stringify({ event: "PAYMENT.CAPTURE.COMPLETED", id: txId }));
          await c2.query(`
            SELECT * FROM public.record_webhook_transmission_ingress(
              $1, 'PAYMENT.CAPTURE.COMPLETED', 'ORD_MUTEX', 'CAP_MUTEX', NULL,
              5000, 'USD', 'merchant@example.com', $2, 'audit_hmac_key_2026', 'nonce_ingress_mutex_01'
            );
          `, [txId, rawPayload]);
        } catch (err: any) {
          if (err.code === "57014") {
            timedOut = true;
          } else {
            throw err;
          }
        } finally {
          await c2.query("RESET statement_timeout;");
          await c2.query("RESET SESSION AUTHORIZATION;");
        }

        expect(timedOut).toBe(true);

        await c1.query("COMMIT;");
      } finally {
        await c1.end();
        await c2.end();
      }
    });
  });

  describe("Level 1 & Level 3 Concurrency Semantics", () => {
    it("serializes concurrent R2-01 and R2-02 executions on the same cart without deadlock", async () => {
      const fixture = await createTestCartFixture(mainClient, "BUYER_APPROVED", 2500, 500, 1000, 0, "merchant@example.com", "ORD-SER-01");
      const cartId = fixture.cartId;

      const c1 = await createStage2Client();
      const c2 = await createStage2Client();

      try {
        await c1.query("SET SESSION AUTHORIZATION tax_worker_01;");
        await c2.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");

        const sampleRawPayload = {
          currency: "USD",
          discounts: [{ amount: "5.00" }],
          shippingCost: "10.00",
          sourceAddress: {
            country: "US",
            line1: "123 Main St",
            postalCode: "94105",
            stateOrProvince: "CA"
          },
          destinationAddress: {
            country: "US",
            line1: "456 Market St",
            postalCode: "94105",
            stateOrProvince: "CA"
          },
          lineItems: [{
            quantity: 1,
            unitPrice: "25.00",
            totalAmount: "25.00",
            commodityCode: "01001",
            discountAmount: "5.00",
            productIdentifier: "PROD-1"
          }]
        };

        const sampleNormPayload = {
          currency: "USD",
          taxTotal: "2.00",
          effectiveRate: "0.1000",
          lineItems: [{
            quantity: 1,
            unitPrice: "25.00",
            totalAmount: "25.00",
            taxAmount: "2.00",
            discountAmount: "5.00",
            effectiveRate: "0.1000",
            taxableAmount: "20.00",
            productIdentifier: "PROD-1",
            jurisdictionBreakdown: [{
              taxAmount: "2.00",
              taxRate: "0.1000",
              taxableAmount: "20.00",
              jurisdictionName: "California",
              jurisdictionType: "STATE"
            }]
          }],
          jurisdictionSummary: [{
            taxAmount: "2.00",
            taxRate: "0.1000",
            taxableAmount: "20.00",
            jurisdictionName: "California",
            jurisdictionType: "STATE"
          }]
        };

        const p1 = c1.query(`
          SELECT * FROM public.record_tax_calculation_quote(
            $1, 'tax_quote_concur_' || $2, 'AUTH-US-CA', 'CERT-2026-001',
            'vak_worker_01_20261107', 'audit_hmac_key_2026',
            '25.00', '5.00', '10.00', '20.00', '2.00', '0.00', '32.00', 'USD',
            '0.1000', 'CALIFORNIA_SALES_TAX_COMBINED_v1', 'STANDARD',
            $3::jsonb, $4::jsonb,
            clock_timestamp() - interval '1 min', clock_timestamp() + interval '30 min',
            'nonce_tax_c1_' || $2, 'SIG', 'SIG', 'TAX_WORKER_SIG', 'tax_worker_01',
            'AUDIT_SIG', 'ENGINE_1', 'PROVIDER_CALC', 'TAX'
          );
        `, [cartId, crypto.randomUUID(), JSON.stringify(sampleRawPayload), JSON.stringify(sampleNormPayload)]);

        const p2 = c2.query(`
          SELECT * FROM public.prepare_merchant_cart_capture(
            $1, $2, 3000, 'USD', 'nonce_cap_c2_' || $3
          );
        `, [cartId, fixture.aggregateId, crypto.randomUUID()]);

        const results = await Promise.allSettled([p1, p2]);
        // Both operations must finish without deadlock (40P01)
        for (const res of results) {
          if (res.status === "rejected") {
            expect(res.reason.code).not.toBe("40P01"); // No deadlock!
          }
        }
      } finally {
        await c1.query("RESET SESSION AUTHORIZATION;");
        await c2.query("RESET SESSION AUTHORIZATION;");
        await c1.end();
        await c2.end();
      }
    });

    it("allows non-blocking concurrent shared locks on AuditSigningKey at Level 3", async () => {
      const c1 = await createStage2Client();
      const c2 = await createStage2Client();

      try {
        await c1.query("BEGIN;");
        await c2.query("BEGIN;");

        // Both sessions acquire FOR SHARE on the same AuditSigningKey concurrently
        const r1 = await c1.query(`
          SELECT key_id, status FROM public."AuditSigningKey"
          WHERE key_id = 'audit_hmac_key_2026' FOR SHARE;
        `);
        const r2 = await c2.query(`
          SELECT key_id, status FROM public."AuditSigningKey"
          WHERE key_id = 'audit_hmac_key_2026' FOR SHARE;
        `);

        expect(r1.rows[0].key_id).toBe("audit_hmac_key_2026");
        expect(r2.rows[0].key_id).toBe("audit_hmac_key_2026");

        await c1.query("COMMIT;");
        await c2.query("COMMIT;");
      } finally {
        await c1.end();
        await c2.end();
      }
    });
  });

  describe("Deadlock-Free Interleaved Multi-Client Stress Test", () => {
    it("executes 12 concurrent transactions across distinct and overlapping entities with 0 deadlocks (40P01)", async () => {
      const fixtureA = await createTestCartFixture(mainClient, "BUYER_APPROVED", 1000, 0, 0, 0, "m1@example.com", "ORD-DEADLOCK-A");
      const fixtureB = await createTestCartFixture(mainClient, "BUYER_APPROVED", 2000, 0, 0, 0, "m2@example.com", "ORD-DEADLOCK-B");

      const deadlocksEncountered: string[] = [];

      // Run 12 transactions each on its own client connection to test concurrency and lock acquisition
      const workers = Array.from({ length: 12 }).map(async (_, idx) => {
        const client = await createStage2Client();
        const isCartA = idx % 2 === 0;
        const targetCart = isCartA ? fixtureA.cartId : fixtureB.cartId;
        const targetAggregate = isCartA ? fixtureA.aggregateId : fixtureB.aggregateId;
        const targetOrder = isCartA ? "ORD-DEADLOCK-A" : "ORD-DEADLOCK-B";
        const amountCents = isCartA ? 1000 : 2000;
        const nonce = "nonce_stress_" + crypto.randomUUID();

        try {
          await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
          await client.query(`
            SELECT * FROM public.prepare_merchant_cart_capture(
              $1, $2, $3, 'USD', $4
            );
          `, [targetCart, targetAggregate, amountCents, nonce]);
        } catch (err: any) {
          if (err.code === "40P01") {
            deadlocksEncountered.push(err.message);
          }
          // State machine errors (55000 already capturing, etc.) are normal concurrency outcomes
        } finally {
          try {
            await client.query("RESET SESSION AUTHORIZATION;");
          } catch (_) {}
          await client.end();
        }
      });

      await Promise.all(workers);

      // Assert zero deadlocks across all concurrent transactions
      expect(deadlocksEncountered).toEqual([]);
    });
  });
});
