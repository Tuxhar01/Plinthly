import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Load configuration strictly from .env.stage2
const envConfig = dotenv.parse(fs.readFileSync(path.resolve(".env.stage2")));

describe("Phase 1: Database Schema & Infrastructure Verification", () => {
  let client: Client;

  beforeAll(async () => {
    expect(envConfig.DATABASE_URL).toBeDefined();
    expect(envConfig.DATABASE_URL).toContain("plinthly_stage2_dev");

    client = new Client({ connectionString: envConfig.DATABASE_URL });
    await client.connect();

    // Mandatory Safety Preflight Check
    const res = await client.query("SELECT current_database(), inet_server_addr(), inet_server_port();");
    const row = res.rows[0];
    expect(row.current_database).toBe("plinthly_stage2_dev");
    const serverAddr = row.inet_server_addr ? row.inet_server_addr.toString() : "127.0.0.1";
    expect(["127.0.0.1", "::1"]).toContain(serverAddr);
  });

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  describe("Safety Preflight & Database Identity", () => {
    it("connects strictly to plinthly_stage2_dev and never plinthly_dev", async () => {
      const res = await client.query("SELECT current_database() AS db;");
      expect(res.rows[0].db).toBe("plinthly_stage2_dev");
      expect(res.rows[0].db).not.toBe("plinthly_dev");
    });

    it("verifies pgcrypto extension is installed in extensions schema", async () => {
      const res = await client.query(`
        SELECT e.extname, n.nspname 
        FROM pg_extension e 
        JOIN pg_namespace n ON e.extnamespace = n.oid 
        WHERE e.extname = 'pgcrypto';
      `);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].extname).toBe("pgcrypto");
      expect(res.rows[0].nspname).toBe("extensions");
    });
  });

  describe("13 Stage 2 Relational Entities Catalog", () => {
    const requiredTables = [
      "ProcurementPlan",
      "ProcurementLineItem",
      "ApprovalAggregate",
      "ApprovedMerchantCart",
      "CartAllocation",
      "PlannedShipmentRecord",
      "AuditSigningKey",
      "TaxAuthorityCertificate",
      "NonceRegistry",
      "WebhookTransmission",
      "PaymentEvidenceRecord",
      "TaxEvidenceRecord",
      "RefundEvidenceRecord",
    ];

    it.each(requiredTables)("confirms table %s exists in public schema", async (tableName) => {
      const res = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1;",
        [tableName]
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].table_name).toBe(tableName);
    });

    it("confirms TaxEvidenceRecord contains all 33 canonical columns", async () => {
      const res = await client.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'TaxEvidenceRecord'
        ORDER BY ordinal_position;
      `);
      expect(res.rows.length).toBe(33);

      const columnNames = res.rows.map((r) => r.column_name);
      const expectedColumns = [
        "id",
        "cart_id",
        "tax_quote_id",
        "provider_name",
        "provider_api_version",
        "signature_algorithm",
        "provider_timestamp",
        "valid_until",
        "provider_merchandise_subtotal_cents",
        "provider_discount_cents",
        "provider_shipping_cents",
        "provider_adjustment_cents",
        "provider_total_cents",
        "total_tax_cents",
        "merchandise_tax_cents",
        "shipping_tax_cents",
        "taxable_shipping_base_cents",
        "currency",
        "jurisdiction_code",
        "line_items_breakdown",
        "jurisdiction_breakdown",
        "raw_payload",
        "statutory_payload_hash",
        "statutory_signature",
        "authority_id",
        "certificate_number",
        "verifier_identity",
        "attestation_key_id",
        "attestation_timestamp",
        "verifier_attestation_signature",
        "verification_status",
        "internal_audit_signature",
        "recorded_at",
      ];

      for (const col of expectedColumns) {
        expect(columnNames).toContain(col);
      }
    });

    it("confirms AuditSigningKey contains all 13 canonical columns", async () => {
      const res = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'AuditSigningKey';
      `);
      expect(res.rows.length).toBe(13);
      const columnNames = res.rows.map((r) => r.column_name);
      expect(columnNames).toContain("key_id");
      expect(columnNames).toContain("key_type");
      expect(columnNames).toContain("worker_principal");
      expect(columnNames).toContain("algorithm");
      expect(columnNames).toContain("public_key_der");
      expect(columnNames).toContain("key_bytes");
      expect(columnNames).toContain("status");
      expect(columnNames).toContain("valid_from");
      expect(columnNames).toContain("valid_until");
      expect(columnNames).toContain("revoked_at");
      expect(columnNames).toContain("revocation_reason");
      expect(columnNames).toContain("revoked_by");
      expect(columnNames).toContain("created_at");
    });
  });

  describe("PostgreSQL Constraints & Check Invariants", () => {
    it("enforces TaxEvidenceRecord provider_adjustment_cents = 0 check constraint", async () => {
      // Begin transaction so test changes are completely rolled back
      await client.query("BEGIN;");
      try {
        // Create prerequisite entities
        const planRes = await client.query(`
          INSERT INTO "ProcurementPlan" ("userId", "strategy", "lifecycleStatus")
          VALUES (gen_random_uuid(), 'CHEAPEST', 'ACTIVE') RETURNING id;
        `);
        const planId = planRes.rows[0].id;

        const aggRes = await client.query(`
          INSERT INTO "ApprovalAggregate" ("planId", "aggregateStatus", "snapshotDigest", "snapshotPayload", "approvedAt")
          VALUES ($1, 'APPROVED', '\\x01', '{}', clock_timestamp()) RETURNING id;
        `, [planId]);
        const aggId = aggRes.rows[0].id;

        const cartRes = await client.query(`
          INSERT INTO "ApprovedMerchantCart" (
            "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
            "merchandiseSubtotalCents", "discountCents", "shippingTotalCents", "taxAmountCents", "totalCartCents"
          ) VALUES (
            $1, 'merch_1', 'merch@example.com', 'READY', 1000, 0, 0, 0, 1000
          ) RETURNING id;
        `, [aggId]);
        const cartId = cartRes.rows[0].id;

        const keyRes = await client.query(`
          INSERT INTO "AuditSigningKey" (
            "key_id", "key_type", "algorithm", "key_bytes", "status", "valid_until"
          ) VALUES (
            'test_key_1', 'AUDIT_HMAC_SYMMETRIC', 'HMAC-SHA256', '\\x01', 'ACTIVE', clock_timestamp() + interval '1 day'
          ) RETURNING key_id;
        `);
        const keyId = keyRes.rows[0].key_id;

        const certRes = await client.query(`
          INSERT INTO "TaxAuthorityCertificate" (
            "authority_id", "certificate_number", "certificate_pem", "subject_dn", "issuer_dn",
            "valid_from", "valid_until", "status"
          ) VALUES (
            'AUTH_1', 'CERT_1', 'PEM_DATA', 'CN=test', 'CN=root',
            clock_timestamp(), clock_timestamp() + interval '1 year', 'ACTIVE'
          );
        `);

        // Attempt invalid insert with provider_adjustment_cents = 50 (must fail)
        await expect(
          client.query(`
            INSERT INTO "TaxEvidenceRecord" (
              cart_id, tax_quote_id, provider_name, provider_api_version,
              signature_algorithm, provider_timestamp, valid_until,
              provider_merchandise_subtotal_cents, provider_discount_cents, provider_shipping_cents,
              provider_adjustment_cents, provider_total_cents, total_tax_cents, merchandise_tax_cents,
              shipping_tax_cents, taxable_shipping_base_cents, currency, jurisdiction_code,
              line_items_breakdown, jurisdiction_breakdown, raw_payload, statutory_payload_hash,
              statutory_signature, authority_id, certificate_number, verifier_identity,
              attestation_key_id, attestation_timestamp, verifier_attestation_signature,
              verification_status, internal_audit_signature
            ) VALUES (
              $1, 'quote_1', 'TAXJAR', 'v2', 'RSA-SHA256', clock_timestamp(), clock_timestamp() + interval '1 hour',
              1000, 0, 0, 50, 1050, 0, 0, 0, 0, 'USD', 'US-CA',
              '[]', '[]', '\\x01', '\\x01', '\\x01', 'AUTH_1', 'CERT_1', 'tax_worker_1',
              $2, clock_timestamp(), '\\x01', 'VERIFIED', '\\x01'
            );
          `, [cartId, keyId])
        ).rejects.toThrow();

      } finally {
        await client.query("ROLLBACK;");
      }
    });

    it("enforces currency = 'USD' check constraint on TaxEvidenceRecord", async () => {
      await client.query("BEGIN;");
      try {
        const planRes = await client.query(`
          INSERT INTO "ProcurementPlan" ("userId", "strategy", "lifecycleStatus")
          VALUES (gen_random_uuid(), 'CHEAPEST', 'ACTIVE') RETURNING id;
        `);
        const aggRes = await client.query(`
          INSERT INTO "ApprovalAggregate" ("planId", "aggregateStatus", "snapshotDigest", "snapshotPayload", "approvedAt")
          VALUES ($1, 'APPROVED', '\\x01', '{}', clock_timestamp()) RETURNING id;
        `, [planRes.rows[0].id]);
        const cartRes = await client.query(`
          INSERT INTO "ApprovedMerchantCart" (
            "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
            "merchandiseSubtotalCents", "discountCents", "shippingTotalCents", "taxAmountCents", "totalCartCents"
          ) VALUES (
            $1, 'merch_1', 'merch@example.com', 'READY', 1000, 0, 0, 0, 1000
          ) RETURNING id;
        `, [aggRes.rows[0].id]);
        await client.query(`
          INSERT INTO "AuditSigningKey" ("key_id", "key_type", "algorithm", "key_bytes", "status", "valid_until")
          VALUES ('test_key_cur', 'AUDIT_HMAC_SYMMETRIC', 'HMAC-SHA256', '\\x01', 'ACTIVE', clock_timestamp() + interval '1 day');
        `);
        await client.query(`
          INSERT INTO "TaxAuthorityCertificate" (
            "authority_id", "certificate_number", "certificate_pem", "subject_dn", "issuer_dn", "valid_from", "valid_until", "status"
          ) VALUES ('AUTH_CUR', 'CERT_CUR', 'PEM', 'CN=test', 'CN=root', clock_timestamp(), clock_timestamp() + interval '1 year', 'ACTIVE');
        `);

        // EUR currency must fail check constraint
        await expect(
          client.query(`
            INSERT INTO "TaxEvidenceRecord" (
              cart_id, tax_quote_id, provider_name, provider_api_version,
              signature_algorithm, provider_timestamp, valid_until,
              provider_merchandise_subtotal_cents, provider_discount_cents, provider_shipping_cents,
              provider_adjustment_cents, provider_total_cents, total_tax_cents, merchandise_tax_cents,
              shipping_tax_cents, taxable_shipping_base_cents, currency, jurisdiction_code,
              line_items_breakdown, jurisdiction_breakdown, raw_payload, statutory_payload_hash,
              statutory_signature, authority_id, certificate_number, verifier_identity,
              attestation_key_id, attestation_timestamp, verifier_attestation_signature,
              verification_status, internal_audit_signature
            ) VALUES (
              $1, 'quote_cur', 'TAXJAR', 'v2', 'RSA-SHA256', clock_timestamp(), clock_timestamp() + interval '1 hour',
              1000, 0, 0, 0, 1000, 0, 0, 0, 0, 'EUR', 'US-CA',
              '[]', '[]', '\\x01', '\\x01', '\\x01', 'AUTH_CUR', 'CERT_CUR', 'tax_worker_1',
              'test_key_cur', clock_timestamp(), '\\x01', 'VERIFIED', '\\x01'
            );
          `, [cartRes.rows[0].id])
        ).rejects.toThrow();
      } finally {
        await client.query("ROLLBACK;");
      }
    });

    it("enforces unique constraint on NonceRegistry (nonce, scope)", async () => {
      await client.query("BEGIN;");
      try {
        const targetId = "00000000-0000-0000-0000-000000000001";
        await client.query(`
          INSERT INTO "NonceRegistry" (nonce, scope, target_id, request_digest)
          VALUES ('unique_nonce_1', 'tax_quote', $1, '\\x01');
        `, [targetId]);

        // Second insert with identical (nonce, scope) must fail
        await expect(
          client.query(`
            INSERT INTO "NonceRegistry" (nonce, scope, target_id, request_digest)
            VALUES ('unique_nonce_1', 'tax_quote', $1, '\\x02');
          `, [targetId])
        ).rejects.toThrow();
      } finally {
        await client.query("ROLLBACK;");
      }
    });
  });

  describe("WebhookTransmission Immutability Trigger (trg_webhook_transmission_immutability)", () => {
    it("confirms trigger function has fixed search_path = pg_catalog for hardening", async () => {
      const res = await client.query(`
        SELECT proname, proconfig
        FROM pg_proc
        WHERE proname = 'fn_webhook_transmission_immutability';
      `);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].proconfig).toEqual(["search_path=pg_catalog"]);
    });

    it("strictly blocks direct DELETE on WebhookTransmission with SQLSTATE 42501", async () => {
      await client.query("BEGIN;");
      try {
        await client.query(`
          INSERT INTO "WebhookTransmission" (
            transmission_id, authenticated_event_type, authenticated_amount_cents,
            authenticated_currency, raw_payload, payload_hash, status
          ) VALUES (
            'tx_del_test_1', 'PAYMENT.CAPTURE.COMPLETED', 2500, 'USD', '\\x01', '\\x02', 'RECORDED'
          );
        `);

        // Attempt DELETE
        let errorCode = "";
        try {
          await client.query("DELETE FROM \"WebhookTransmission\" WHERE transmission_id = 'tx_del_test_1';");
        } catch (err: any) {
          errorCode = err.code;
        }
        expect(errorCode).toBe("42501");
      } finally {
        await client.query("ROLLBACK;");
      }
    });

    it("strictly blocks direct UPDATE modifying wire payload or claims with SQLSTATE 42501", async () => {
      await client.query("BEGIN;");
      try {
        await client.query(`
          INSERT INTO "WebhookTransmission" (
            transmission_id, authenticated_event_type, authenticated_amount_cents,
            authenticated_currency, raw_payload, payload_hash, status
          ) VALUES (
            'tx_upd_test_1', 'PAYMENT.CAPTURE.COMPLETED', 2500, 'USD', '\\x01', '\\x02', 'RECORDED'
          );
        `);

        // Attempt tampering with amount
        let errorCode = "";
        try {
          await client.query(`
            UPDATE "WebhookTransmission"
            SET authenticated_amount_cents = 5000
            WHERE transmission_id = 'tx_upd_test_1';
          `);
        } catch (err: any) {
          errorCode = err.code;
        }
        expect(errorCode).toBe("42501");
      } finally {
        await client.query("ROLLBACK;");
      }
    });

    it("allows valid status transition from RECORDED to PROCESSED with response_code", async () => {
      await client.query("BEGIN;");
      try {
        await client.query(`
          INSERT INTO "WebhookTransmission" (
            transmission_id, authenticated_event_type, authenticated_amount_cents,
            authenticated_currency, raw_payload, payload_hash, status
          ) VALUES (
            'tx_valid_trans', 'PAYMENT.CAPTURE.COMPLETED', 2500, 'USD', '\\x01', '\\x02', 'RECORDED'
          );
        `);

        // Valid transition
        const res = await client.query(`
          UPDATE "WebhookTransmission"
          SET status = 'PROCESSED', response_code = 200
          WHERE transmission_id = 'tx_valid_trans'
          RETURNING status, response_code;
        `);
        expect(res.rows[0].status).toBe("PROCESSED");
        expect(res.rows[0].response_code).toBe(200);

        // Attempt subsequent update from PROCESSED (must fail)
        let errorCode = "";
        try {
          await client.query(`
            UPDATE "WebhookTransmission"
            SET response_code = 500
            WHERE transmission_id = 'tx_valid_trans';
          `);
        } catch (err: any) {
          errorCode = err.code;
        }
        expect(errorCode).toBe("42501");
      } finally {
        await client.query("ROLLBACK;");
      }
    });
  });

  describe("Database Roles & Least Privilege Setup", () => {
    const roles = [
      "plinthly_security_admin",
      "tax_verifier_role",
      "webhook_ingress_role",
      "app_orchestrator_role",
      "admin_security_role",
    ];

    it.each(roles)("confirms role %s exists", async (roleName) => {
      const res = await client.query("SELECT rolname FROM pg_roles WHERE rolname = $1;", [roleName]);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].rolname).toBe(roleName);
    });
  });

  describe("Stage 1 Baseline Data Preservation in plinthly_stage2_dev", () => {
    it("confirms protected purchase pur_1792633876502_s7jvwi22 exists at version 6 with status BUYER_APPROVED", async () => {
      const res = await client.query(`
        SELECT id, status, version, currency, "budgetCents"
        FROM "Purchase"
        WHERE id = 'pur_1792633876502_s7jvwi22';
      `);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].status).toBe("BUYER_APPROVED");
      expect(res.rows[0].version).toBe(6);
    });

    it("confirms protected purchase pur_1792654701712_f2iks5to exists at version 5 with status BUYER_APPROVED", async () => {
      const res = await client.query(`
        SELECT id, status, version, currency, "budgetCents"
        FROM "Purchase"
        WHERE id = 'pur_1792654701712_f2iks5to';
      `);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].status).toBe("BUYER_APPROVED");
      expect(res.rows[0].version).toBe(5);
    });

    it("confirms total purchase records is 40 and payment attempts completed is 0", async () => {
      const pCount = await client.query('SELECT count(*)::int AS count FROM "Purchase";');
      expect(pCount.rows[0].count).toBe(40);

      const paCount = await client.query('SELECT count(*)::int AS count FROM "PaymentAttempt" WHERE status = \'COMPLETED\';');
      expect(paCount.rows[0].count).toBe(0);
    });
  });
});
