import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestTaxCert,
  createTestKeys,
} from "../database/helpers/routine-test-helper";

describe("Section 10 Acceptance Test: TEST-LOCK-04 (R2-01 Level 1 Cart Lock Before Level 3 Key Locks)", () => {
  let client1: Client;
  let client2: Client;
  const authorityId = "AUTH-LOCK04";
  const certNumber = "CERT-LOCK04-2026";
  const attestKeyId = "vak_lock04";
  const hmacKeyId = "audit_hmac_lock04";

  beforeAll(async () => {
    client1 = await createStage2Client();
    client2 = await createStage2Client();
    await ensureRolesExist(client1);
    await createTestTaxCert(client1, authorityId, certNumber);
    await createTestKeys(client1, attestKeyId, hmacKeyId, "tax_worker_01");
  });

  afterAll(async () => {
    await client1.end();
    await client2.end();
  });

  it("proves Level 1 cart lock (FOR SHARE) serializes concurrent R2-02 execution without deadlock", async () => {
    const fixture = await createTestCartFixture(client1, "BUYER_APPROVED", 2500, 500, 1000, 0);

    // Client 1 acquires Level 1 cart lock FOR SHARE inside transaction
    await client1.query("BEGIN;");
    await client1.query(
      `SELECT id FROM public."ApprovedMerchantCart" WHERE id = $1 FOR SHARE;`,
      [fixture.cartId]
    );

    // Client 2 attempts R2-02 (prepare_merchant_cart_capture requires FOR UPDATE)
    let client2Finished = false;
    const client2Promise = (async () => {
      await client2.query("BEGIN;");
      await client2.query(
        `SELECT * FROM public.prepare_merchant_cart_capture($1, $2, 3000, 'USD', 'idemp_lock04');`,
        [fixture.cartId, fixture.aggregateId]
      );
      await client2.query("COMMIT;");
      client2Finished = true;
    })();

    // Wait 150ms to allow Client 2 to block waiting for Client 1's share lock
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(client2Finished).toBe(false);

    // Client 1 commits transaction, releasing lock
    await client1.query("COMMIT;");

    // Client 2 unblocks and completes cleanly
    await client2Promise;
    expect(client2Finished).toBe(true);

    const check = await client1.query(
      'SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1',
      [fixture.cartId]
    );
    expect(check.rows[0].checkoutStatus).toBe("CAPTURING");
  });
});

