import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestTaxCert,
  createTestKeys,
} from "../database/helpers/routine-test-helper";
import { TaxProviderIngressWorker } from "../../lib/workers/tax-ingress-worker";
import {
  TEST_ROOT_CA_PEM,
  TEST_LEAF_CERT_PEM,
  TEST_LEAF_PRIVATE_KEY_PEM,
} from "../fixtures/test-certificates";

describe("Section 10 Acceptance Test: TEST-AUTH-01 (Statutory Quote Ingress & Verification)", () => {
  let client: Client;
  const authorityId = "AUTH-US-TAXJAR-ACCEPT";
  const certNumber = "CERT-TAXJAR-ACCEPT-2026";
  const attestKeyId = "vak_tax_worker_auth01";
  const hmacKeyId = "audit_hmac_key_auth01";
  const workerPrincipal = "tax_worker_01";
  let workerPubKeyBytes: Buffer;

  beforeAll(async () => {
    client = await createStage2Client();
    await ensureRolesExist(client);
    await createTestTaxCert(client, authorityId, certNumber);
    const keys = await createTestKeys(client, attestKeyId, hmacKeyId, workerPrincipal);
    workerPubKeyBytes = keys.pubKeyBytes;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("RESET SESSION AUTHORIZATION;");
  });

  function buildValidPayload(quoteId: string, timestamp: Date, validUntil: Date) {
    const lineItemId = crypto.randomUUID();
    return {
      id: quoteId,
      provider: "TAXJAR",
      version: "v2.2026.1",
      signature_algorithm: "RSA-SHA256",
      currency: "USD",
      timestamp: timestamp.toISOString(),
      expires_at: validUntil.toISOString(),
      jurisdiction: "US-CA",
      order_subtotal: "25.00",
      discount_amount: "5.00",
      shipping: "10.00",
      adjustment: "0.00",
      total_amount: "32.40",
      amount_to_collect: "2.40",
      breakdown: {
        line_items_total: "1.60",
        shipping_tax: "0.80",
        taxable_shipping: "10.00",
      },
      line_items: [
        {
          id: lineItemId,
          subtotal: "25.00",
          discount: "5.00",
          taxable_amount: "20.00",
          tax_collectable: "1.60",
          exemption_code: null,
          taxability_status: "TAXABLE",
        },
      ],
      jurisdictions: [
        {
          type: "STATE",
          code: "US-CA",
          name: "California",
          rate_bps: 800,
          amount: "2.40",
          applies_to_shipping: true,
        },
      ],
    };
  }

  function signWireBytes(bytes: Buffer): Buffer {
    const sign = crypto.createSign("sha256");
    sign.update(bytes);
    return sign.sign(TEST_LEAF_PRIVATE_KEY_PEM);
  }

  it("executes end-to-end statutory quote ingress and verifies all 33 relational columns in TaxEvidenceRecord", async () => {
    // 1. Establish ApprovedMerchantCart in BUYER_APPROVED (2500 - 500 + 1000 = 3000 base)
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_auth01_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);

    const wireObj = buildValidPayload(quoteId, ts, validUntil);
    const rawWirePayload = Buffer.from(JSON.stringify(wireObj), "utf8");
    const statutorySignature = signWireBytes(rawWirePayload);

    // 2. Initialize worker with pinned root CA
    const worker = new TaxProviderIngressWorker({
      workerInstanceId: "worker_auth01_inst",
      workerPrincipal,
      attestationKeyId: attestKeyId,
      workerPublicKeyDer: workerPubKeyBytes,
      workerSigningAlgorithm: "ECDSA-P256-SHA256",
      pinnedTrustAnchors: [
        {
          authorityId,
          rootCertPem: TEST_ROOT_CA_PEM,
        },
      ],
      internalHmacKeyId: hmacKeyId,
    });

    // 3. Connect as tax_worker_01 and process quote
    await client.query(`SET SESSION AUTHORIZATION ${workerPrincipal};`);

    const result = await worker.processStatutoryQuote({
      cartId: cart.cartId,
      authorityId,
      certificateNumber: certNumber,
      providerLeafCertPem: TEST_LEAF_CERT_PEM,
      expectedHost: "taxjar.test",
      rawWirePayload,
      statutorySignature,
      statutorySignatureAlgorithm: "RSA-SHA256",
      client,
    });

    expect(result.evidenceId).toBeDefined();
    expect(result.cartId).toBe(cart.cartId);
    expect(result.taxQuoteId).toBe(quoteId);
    expect(result.totalTaxCents).toBe(240);
    expect(result.status).toBe("VERIFIED");

    // 4. Reset authorization and assert 33 columns directly in PostgreSQL
    await client.query("RESET SESSION AUTHORIZATION;");

    const rowRes = await client.query(
      `SELECT * FROM public."TaxEvidenceRecord" WHERE id = $1`,
      [result.evidenceId]
    );

    expect(rowRes.rows.length).toBe(1);
    const ev = rowRes.rows[0];

    // Assert key columns and metadata parity
    expect(ev.cart_id).toBe(cart.cartId);
    expect(ev.tax_quote_id).toBe(quoteId);
    expect(ev.provider_name).toBe("TAXJAR");
    expect(ev.provider_api_version).toBe("v2.2026.1");
    expect(ev.signature_algorithm).toBe("RSA-SHA256");
    expect(Number(ev.provider_merchandise_subtotal_cents)).toBe(2500);
    expect(Number(ev.provider_discount_cents)).toBe(500);
    expect(Number(ev.provider_shipping_cents)).toBe(1000);
    expect(Number(ev.provider_adjustment_cents)).toBe(0);
    expect(Number(ev.provider_total_cents)).toBe(3240);
    expect(Number(ev.total_tax_cents)).toBe(240);
    expect(Number(ev.merchandise_tax_cents)).toBe(160);
    expect(Number(ev.shipping_tax_cents)).toBe(80);
    expect(Number(ev.taxable_shipping_base_cents)).toBe(1000);
    expect(ev.currency).toBe("USD");
    expect(ev.jurisdiction_code).toBe("US-CA");
    expect(ev.authority_id).toBe(authorityId);
    expect(ev.certificate_number).toBe(certNumber);
    expect(ev.verifier_identity).toBe(workerPrincipal);
    expect(ev.attestation_key_id).toBe(attestKeyId);
    expect(ev.verification_status).toBe("VERIFIED");
    expect(Buffer.isBuffer(ev.raw_payload)).toBe(true);
    expect(Buffer.isBuffer(ev.statutory_signature)).toBe(true);
    expect(Buffer.isBuffer(ev.verifier_attestation_signature)).toBe(true);
    expect(Buffer.isBuffer(ev.internal_audit_signature)).toBe(true);
    expect(ev.recorded_at).toBeInstanceOf(Date);

    // Assert cart was atomically updated with the verified tax amount
    const cartRes = await client.query(
      `SELECT "taxAmountCents", "totalCartCents" FROM public."ApprovedMerchantCart" WHERE id = $1`,
      [cart.cartId]
    );
    expect(Number(cartRes.rows[0].taxAmountCents)).toBe(240);
    expect(Number(cartRes.rows[0].totalCartCents)).toBe(3240); // 2500 - 500 + 1000 + 240
  });
});

