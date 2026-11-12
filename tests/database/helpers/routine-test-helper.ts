import { Client } from "pg";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const envConfig = dotenv.parse(fs.readFileSync(path.resolve(".env.stage2")));

export function getStage2DbUrl(): string {
  const url = envConfig.DATABASE_URL;
  if (!url || !url.includes("plinthly_stage2_dev")) {
    throw new Error("FATAL: DATABASE_URL is not targeting plinthly_stage2_dev!");
  }
  return url;
}

export async function createStage2Client(): Promise<Client> {
  const client = new Client({ connectionString: getStage2DbUrl() });
  await client.connect();

  const res = await client.query("SELECT current_database(), current_user;");
  if (res.rows[0].current_database !== "plinthly_stage2_dev") {
    await client.end();
    throw new Error(`Safety Preflight: Not connected to plinthly_stage2_dev (connected to ${res.rows[0].current_database})`);
  }
  return client;
}

export async function ensureRolesExist(client: Client) {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tax_worker_01') THEN
        CREATE ROLE tax_worker_01 WITH LOGIN IN ROLE tax_verifier_role;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orchestrator_worker_user') THEN
        CREATE ROLE orchestrator_worker_user WITH LOGIN IN ROLE app_orchestrator_role;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingress_worker_user') THEN
        CREATE ROLE ingress_worker_user WITH LOGIN IN ROLE webhook_ingress_role;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'security_admin_user') THEN
        CREATE ROLE security_admin_user WITH LOGIN IN ROLE admin_security_role;
      END IF;
    END;
    $$;
  `);
}

export interface TestCartFixture {
  planId: string;
  aggregateId: string;
  cartId: string;
  userId: string;
}

export async function createTestCartFixture(
  client: Client,
  status: string = "BUYER_APPROVED",
  merchCents: number = 2500,
  discCents: number = 500,
  shipCents: number = 1000,
  taxCents: number = 0,
  payeeEmail: string = "merchant@example.com",
  orderId: string | null = "ORDER-TEST-001"
): Promise<TestCartFixture> {
  const planId = crypto.randomUUID();
  const aggregateId = crypto.randomUUID();
  const cartId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  const totalCents = merchCents - discCents + shipCents + taxCents;

  await client.query(`
    INSERT INTO public."ProcurementPlan" (id, "userId", strategy, "lifecycleStatus", "createdAt", "updatedAt")
    VALUES ($1, $2, 'BALANCED', 'ACTIVE', clock_timestamp(), clock_timestamp());
  `, [planId, userId]);

  await client.query(`
    INSERT INTO public."ApprovalAggregate" (id, "planId", "aggregateStatus", "snapshotDigest", "snapshotPayload", "approvedAt", "createdAt")
    VALUES ($1, $2, 'APPROVED', $3, '{}'::jsonb, clock_timestamp(), clock_timestamp());
  `, [aggregateId, planId, Buffer.from("fixture-snapshot")]);

  await client.query(`
    INSERT INTO public."ApprovedMerchantCart" (
      id, "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
      "paypalOrderId", "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
      "taxAmountCents", "totalCartCents", "cumulativeRefundedCents", "createdAt", "updatedAt"
    ) VALUES (
      $1, $2, 'merchant_test_1', $3, $4,
      $5, $6, $7, $8,
      $9, $10, 0, clock_timestamp(), clock_timestamp()
    );
  `, [cartId, aggregateId, payeeEmail, status, orderId, merchCents, discCents, shipCents, taxCents, totalCents]);

  return { planId, aggregateId, cartId, userId };
}

export async function createTestTaxCert(
  client: Client,
  authorityId: string = "AUTH-US-CA",
  certNumber: string = "CERT-2026-001",
  status: string = "ACTIVE"
) {
  await client.query(`
    INSERT INTO public."TaxAuthorityCertificate" (
      authority_id, certificate_number, certificate_pem, subject_dn, issuer_dn,
      valid_from, valid_until, status, created_at
    ) VALUES (
      $1, $2, '---PEM---', 'CN=CA Tax', 'CN=Root CA',
      clock_timestamp() - interval '1 day', clock_timestamp() + interval '30 days', $3, clock_timestamp()
    ) ON CONFLICT (authority_id, certificate_number) DO UPDATE
      SET status = $3, valid_until = clock_timestamp() + interval '30 days', revoked_at = NULL;
  `, [authorityId, certNumber, status]);
}

export async function createTestKeys(
  client: Client,
  attestKeyId: string = "vak_worker_01_20261107",
  hmacKeyId: string = "audit_hmac_key_2026",
  workerPrincipal: string = "tax_worker_01"
) {
  const pubKeyBytes = Buffer.alloc(64, 1);
  const hmacKeyBytes = Buffer.alloc(32, 2);

  await client.query(`
    INSERT INTO public."AuditSigningKey" (
      key_id, key_type, worker_principal, algorithm, public_key_der,
      status, valid_from, valid_until, created_at
    ) VALUES (
      $1, 'VERIFIER_ATTESTATION_PUBLIC_KEY', $2, 'ECDSA-P256-SHA256', $3,
      'ACTIVE', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days', clock_timestamp()
    ) ON CONFLICT (key_id) DO UPDATE
      SET status = 'ACTIVE', valid_until = clock_timestamp() + interval '30 days', revoked_at = NULL, worker_principal = $2;
  `, [attestKeyId, workerPrincipal, pubKeyBytes]);

  await client.query(`
    INSERT INTO public."AuditSigningKey" (
      key_id, key_type, algorithm, key_bytes,
      status, valid_from, valid_until, created_at
    ) VALUES (
      $1, 'AUDIT_HMAC_SYMMETRIC', 'HMAC-SHA256', $2,
      'ACTIVE', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days', clock_timestamp()
    ) ON CONFLICT (key_id) DO UPDATE
      SET status = 'ACTIVE', valid_until = clock_timestamp() + interval '30 days', revoked_at = NULL;
  `, [hmacKeyId, hmacKeyBytes]);

  return { pubKeyBytes, hmacKeyBytes };
}

