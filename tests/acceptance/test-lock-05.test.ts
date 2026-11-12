import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import {
  createStage2Client,
  ensureRolesExist,
  createTestKeys,
} from "../database/helpers/routine-test-helper";

describe("Section 10 Acceptance Test: TEST-LOCK-05 (Non-blocking Shared Key Locks at Level 3)", () => {
  let client1: Client;
  let client2: Client;
  const attestKeyId = "vak_lock05";
  const hmacKeyId = "audit_hmac_lock05";

  beforeAll(async () => {
    client1 = await createStage2Client();
    client2 = await createStage2Client();
    await ensureRolesExist(client1);
    await createTestKeys(client1, attestKeyId, hmacKeyId, "tax_worker_01");
  });

  afterAll(async () => {
    await client1.end();
    await client2.end();
  });

  it("proves concurrent shared locks (FOR SHARE) on AuditSigningKey at Level 3 complete concurrently without blocking", async () => {
    // Client 1 begins transaction and acquires Level 3 key lock FOR SHARE
    await client1.query("BEGIN;");
    await client1.query(
      `SELECT key_id, status FROM public."AuditSigningKey" WHERE key_id = $1 FOR SHARE;`,
      [attestKeyId]
    );

    // Client 2 begins transaction and ALSO acquires Level 3 key lock FOR SHARE on SAME key
    await client2.query("BEGIN;");
    const client2Start = Date.now();
    const res2 = await client2.query(
      `SELECT key_id, status FROM public."AuditSigningKey" WHERE key_id = $1 FOR SHARE;`,
      [attestKeyId]
    );
    const client2Duration = Date.now() - client2Start;

    // Must return immediately (< 100ms) without blocking
    expect(res2.rows.length).toBe(1);
    expect(client2Duration).toBeLessThan(100);

    // Both commit cleanly
    await client1.query("COMMIT;");
    await client2.query("COMMIT;");
  });
});

