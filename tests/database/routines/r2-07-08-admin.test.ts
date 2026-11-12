import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
} from "../helpers/routine-test-helper";

describe("Routines R2-07 & R2-08: Cryptographic Key & Certificate Revocation", () => {
  let client: Client;

  beforeAll(async () => {
    client = await createStage2Client();
    await ensureRolesExist(client);
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("RESET SESSION AUTHORIZATION;");
  });

  describe("R2-07: revoke_audit_signing_key", () => {
    it("atomically revokes active key and records revocation provenance", async () => {
      const keyId = "key_rev_target_" + crypto.randomUUID();
      await client.query(`
        INSERT INTO public."AuditSigningKey" (
          key_id, key_type, algorithm, key_bytes, status, valid_from, valid_until, created_at
        ) VALUES (
          $1, 'AUDIT_HMAC_SYMMETRIC', 'HMAC-SHA256', decode(repeat('00', 32), 'hex'), 'ACTIVE',
          clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days', clock_timestamp()
        );
      `, [keyId]);

      const nonce = "nonce_rev_key_" + crypto.randomUUID();
      const reason = "Scheduled key decommissioning";

      let res: any;
      try {
        await client.query("SET SESSION AUTHORIZATION security_admin_user;");
        res = await client.query(`
          SELECT * FROM public.revoke_audit_signing_key($1, $2, $3, $4);
        `, [keyId, reason, "sec_admin_01", nonce]);
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      const row = res.rows[0];
      expect(row.key_id).toBe(keyId);
      expect(row.status).toBe("REVOKED");
      expect(row.idempotent_retry).toBe(false);
      expect(row.revoked_at).toBeDefined();

      const keyCheck = await client.query('SELECT status, revocation_reason, revoked_by FROM public."AuditSigningKey" WHERE key_id = $1', [keyId]);
      expect(keyCheck.rows[0].status).toBe("REVOKED");
      expect(keyCheck.rows[0].revocation_reason).toBe(reason);
      expect(keyCheck.rows[0].revoked_by).toBe("sec_admin_01");
    });

    it("returns idempotent retry on identical re-revocation", async () => {
      const keyId = "key_rev_idemp_" + crypto.randomUUID();
      await client.query(`
        INSERT INTO public."AuditSigningKey" (
          key_id, key_type, algorithm, key_bytes, status, valid_from, valid_until, created_at
        ) VALUES (
          $1, 'AUDIT_HMAC_SYMMETRIC', 'HMAC-SHA256', decode(repeat('00', 32), 'hex'), 'ACTIVE',
          clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days', clock_timestamp()
        );
      `, [keyId]);

      const nonce = "nonce_rev_idemp_" + crypto.randomUUID();
      const reason = "Key compromised in incident INC-2026";

      let res1: any;
      let res2: any;
      try {
        await client.query("SET SESSION AUTHORIZATION security_admin_user;");
        res1 = await client.query(`
          SELECT * FROM public.revoke_audit_signing_key($1, $2, $3, $4);
        `, [keyId, reason, "sec_admin_01", nonce]);

        res2 = await client.query(`
          SELECT * FROM public.revoke_audit_signing_key($1, $2, $3, $4);
        `, [keyId, reason, "sec_admin_01", nonce]);
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(res1.rows[0].idempotent_retry).toBe(false);
      expect(res2.rows[0].idempotent_retry).toBe(true);
      expect(res2.rows[0].key_id).toBe(keyId);
      expect(res2.rows[0].status).toBe("REVOKED");
    });

    it("rejects re-revocation with new nonce on already revoked key with SQLSTATE 55000", async () => {
      const keyId = "key_rev_conflict_" + crypto.randomUUID();
      await client.query(`
        INSERT INTO public."AuditSigningKey" (
          key_id, key_type, algorithm, key_bytes, status, valid_from, valid_until, created_at
        ) VALUES (
          $1, 'AUDIT_HMAC_SYMMETRIC', 'HMAC-SHA256', decode(repeat('00', 32), 'hex'), 'ACTIVE',
          clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days', clock_timestamp()
        );
      `, [keyId]);

      try {
        await client.query("SET SESSION AUTHORIZATION security_admin_user;");
        await client.query(`
          SELECT * FROM public.revoke_audit_signing_key($1, $2, $3, $4);
        `, [keyId, "Initial revocation", "sec_admin_01", "nonce_1_" + crypto.randomUUID()]);
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION security_admin_user;");
        await client.query(`
          SELECT * FROM public.revoke_audit_signing_key($1, $2, $3, $4);
        `, [keyId, "Second conflicting revocation", "sec_admin_02", "nonce_2_" + crypto.randomUUID()]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("55000");
      expect(err.message).toContain("ERR_RESOURCE_ALREADY_REVOKED");
    });

    it("rejects non-existent key with SQLSTATE P0002", async () => {
      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION security_admin_user;");
        await client.query(`
          SELECT * FROM public.revoke_audit_signing_key($1, $2, $3, $4);
        `, ["non_existent_key_" + crypto.randomUUID(), "Reason", "admin", "nonce_" + crypto.randomUUID()]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("P0002");
      expect(err.message).toContain("ERR_KEY_NOT_FOUND");
    });

    it("rejects unauthorized caller role with SQLSTATE 42501", async () => {
      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION app_orchestrator_role;");
        await client.query(`
          SELECT * FROM public.revoke_audit_signing_key($1, $2, $3, $4);
        `, ["key_unauth", "Reason", "admin", "nonce_unauth"]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("42501");
    });
  });

  describe("R2-08: revoke_tax_authority_certificate", () => {
    it("atomically revokes active tax authority certificate", async () => {
      const authId = "AUTH_REV_" + crypto.randomUUID().substring(0, 8);
      const certNo = "CERT_REV_001";
      await client.query(`
        INSERT INTO public."TaxAuthorityCertificate" (
          authority_id, certificate_number, certificate_pem, subject_dn, issuer_dn,
          valid_from, valid_until, status, created_at
        ) VALUES (
          $1, $2, '---PEM---', 'CN=Test Auth', 'CN=Root CA',
          clock_timestamp() - interval '1 day', clock_timestamp() + interval '30 days', 'ACTIVE', clock_timestamp()
        );
      `, [authId, certNo]);

      const nonce = "nonce_rev_cert_" + crypto.randomUUID();
      const reason = "Authority CA key superseded";

      let res: any;
      try {
        await client.query("SET SESSION AUTHORIZATION security_admin_user;");
        res = await client.query(`
          SELECT * FROM public.revoke_tax_authority_certificate($1, $2, $3, $4, $5);
        `, [authId, certNo, reason, "sec_admin_01", nonce]);
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      const row = res.rows[0];
      expect(row.authority_id).toBe(authId);
      expect(row.certificate_number).toBe(certNo);
      expect(row.status).toBe("REVOKED");
      expect(row.idempotent_retry).toBe(false);

      const certCheck = await client.query('SELECT status, revocation_reason, revoked_by FROM public."TaxAuthorityCertificate" WHERE authority_id = $1 AND certificate_number = $2', [authId, certNo]);
      expect(certCheck.rows[0].status).toBe("REVOKED");
      expect(certCheck.rows[0].revocation_reason).toBe(reason);
    });

    it("returns idempotent retry on identical certificate re-revocation", async () => {
      const authId = "AUTH_IDEMP_" + crypto.randomUUID().substring(0, 8);
      const certNo = "CERT_IDEMP_001";
      await client.query(`
        INSERT INTO public."TaxAuthorityCertificate" (
          authority_id, certificate_number, certificate_pem, subject_dn, issuer_dn,
          valid_from, valid_until, status, created_at
        ) VALUES (
          $1, $2, '---PEM---', 'CN=Test Auth', 'CN=Root CA',
          clock_timestamp() - interval '1 day', clock_timestamp() + interval '30 days', 'ACTIVE', clock_timestamp()
        );
      `, [authId, certNo]);

      const nonce = "nonce_cert_idemp_" + crypto.randomUUID();
      const reason = "Certificate compromised";

      let res1: any;
      let res2: any;
      try {
        await client.query("SET SESSION AUTHORIZATION security_admin_user;");
        res1 = await client.query(`
          SELECT * FROM public.revoke_tax_authority_certificate($1, $2, $3, $4, $5);
        `, [authId, certNo, reason, "sec_admin_01", nonce]);

        res2 = await client.query(`
          SELECT * FROM public.revoke_tax_authority_certificate($1, $2, $3, $4, $5);
        `, [authId, certNo, reason, "sec_admin_01", nonce]);
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(res1.rows[0].idempotent_retry).toBe(false);
      expect(res2.rows[0].idempotent_retry).toBe(true);
      expect(res2.rows[0].authority_id).toBe(authId);
      expect(res2.rows[0].status).toBe("REVOKED");
    });

    it("rejects non-existent certificate with SQLSTATE P0002", async () => {
      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION security_admin_user;");
        await client.query(`
          SELECT * FROM public.revoke_tax_authority_certificate($1, $2, $3, $4, $5);
        `, ["AUTH_NONE", "CERT_NONE", "Reason", "admin", "nonce_" + crypto.randomUUID()]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("P0002");
      expect(err.message).toContain("ERR_CERTIFICATE_NOT_FOUND");
    });

    it("rejects unauthorized caller role with SQLSTATE 42501", async () => {
      let err: any;
      try {
        await client.query("SET SESSION AUTHORIZATION tax_verifier_role;");
        await client.query(`
          SELECT * FROM public.revoke_tax_authority_certificate($1, $2, $3, $4, $5);
        `, ["AUTH_UNAUTH", "CERT_UNAUTH", "Reason", "admin", "nonce_unauth"]);
      } catch (e) {
        err = e;
      } finally {
        await client.query("RESET SESSION AUTHORIZATION;");
      }

      expect(err).toBeDefined();
      expect(err.code).toBe("42501");
    });
  });
});
