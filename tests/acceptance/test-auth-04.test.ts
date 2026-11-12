import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestTaxCert,
  createTestKeys,
} from "../database/helpers/routine-test-helper";

describe("Section 10 Acceptance Test: TEST-AUTH-04 (Database Role Separation & Routine Permissions)", () => {
  let client: Client;
  const authorityId = "AUTH-US-TAXJAR-ROLE";
  const certNumber = "CERT-TAXJAR-ROLE-2026";
  const attestKeyId = "vak_tax_worker_auth04";
  const hmacKeyId = "audit_hmac_key_auth04";
  const workerPrincipal = "tax_worker_01";

  beforeAll(async () => {
    client = await createStage2Client();
    await ensureRolesExist(client);
    await createTestTaxCert(client, authorityId, certNumber);
    await createTestKeys(client, attestKeyId, hmacKeyId, workerPrincipal);
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("RESET SESSION AUTHORIZATION;");
  });

  it("strictly rejects unauthorized caller role (app_orchestrator_role / orchestrator_worker_user) calling R2-01 with SQLSTATE 42501", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);

    // Switch session to orchestrator_worker_user (app_orchestrator_role)
    await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");

    let err: any;
    try {
      await client.query(
        `SELECT * FROM public.record_tax_calculation_quote(
           $1::uuid,
           'quote_test'::varchar,
           'TAXJAR'::varchar,
           'v2'::varchar,
           'RSA-SHA256'::varchar,
           clock_timestamp(),
           clock_timestamp() + interval '1 hour',
           2500::bigint,
           500::bigint,
           1000::bigint,
           0::bigint,
           3240::bigint,
           240::bigint,
           160::bigint,
           80::bigint,
           1000::bigint,
           'USD'::varchar(3),
           'US-CA'::varchar,
           '[]'::jsonb,
           '[]'::jsonb,
           '\\x01'::bytea,
           '\\x02'::bytea,
           $2::varchar,
           $3::varchar,
           'tax_worker_01'::varchar,
           $4::varchar,
           clock_timestamp(),
           '\\x03'::bytea,
           'audit_hmac_key_auth04'::varchar,
           'nonce_unauth'::varchar
         );`,
        [cart.cartId, authorityId, certNumber, attestKeyId]
      );
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("42501"); // Insufficient privilege
  });

  it("strictly rejects unauthorized caller role (webhook_ingress_role / ingress_worker_user) calling R2-01 with SQLSTATE 42501", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);

    // Switch session to ingress_worker_user (webhook_ingress_role)
    await client.query("SET SESSION AUTHORIZATION ingress_worker_user;");

    let err: any;
    try {
      await client.query(
        `SELECT * FROM public.record_tax_calculation_quote(
           $1::uuid,
           'quote_test'::varchar,
           'TAXJAR'::varchar,
           'v2'::varchar,
           'RSA-SHA256'::varchar,
           clock_timestamp(),
           clock_timestamp() + interval '1 hour',
           2500::bigint,
           500::bigint,
           1000::bigint,
           0::bigint,
           3240::bigint,
           240::bigint,
           160::bigint,
           80::bigint,
           1000::bigint,
           'USD'::varchar(3),
           'US-CA'::varchar,
           '[]'::jsonb,
           '[]'::jsonb,
           '\\x01'::bytea,
           '\\x02'::bytea,
           $2::varchar,
           $3::varchar,
           'tax_worker_01'::varchar,
           $4::varchar,
           clock_timestamp(),
           '\\x03'::bytea,
           'audit_hmac_key_auth04'::varchar,
           'nonce_unauth_ing'::varchar
         );`,
        [cart.cartId, authorityId, certNumber, attestKeyId]
      );
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("42501"); // Insufficient privilege
  });

  it("strictly rejects tax_worker_01 calling R2-02 (prepare_merchant_cart_capture) with SQLSTATE 42501", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);

    // Switch session to tax_worker_01 (tax_verifier_role)
    await client.query(`SET SESSION AUTHORIZATION ${workerPrincipal};`);

    let err: any;
    try {
      await client.query(
        `SELECT * FROM public.prepare_merchant_cart_capture(
           $1, $2, 3000, 'USD', 'idemp_key_unauth'
         );`,
        [cart.cartId, cart.aggregateId]
      );
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("42501"); // Insufficient privilege
  });
});
