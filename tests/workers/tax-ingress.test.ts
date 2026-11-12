import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import { TaxProviderIngressWorker } from "../../lib/workers/tax-ingress-worker";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestTaxCert,
  createTestKeys,
} from "../database/helpers/routine-test-helper";
import {
  TEST_ROOT_CA_PEM,
  TEST_LEAF_CERT_PEM,
  TEST_LEAF_PRIVATE_KEY_PEM,
  TEST_UNRELATED_ROOT_CA_PEM,
} from "../fixtures/test-certificates";

describe("Phase 3: TaxProviderIngressWorker & Cryptographic Attestation Boundary", () => {
  let client: Client;
  const authorityId = "AUTH-US-TAXJAR";
  const certNumber = "CERT-TAXJAR-2026";
  const attestKeyId = "vak_tax_worker_p3_01";
  const hmacKeyId = "audit_hmac_key_p3";
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

  function createWorkerInstance(keyId = attestKeyId, principal = workerPrincipal) {
    return new TaxProviderIngressWorker({
      workerInstanceId: "worker_p3_inst01",
      workerPrincipal: principal,
      attestationKeyId: keyId,
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
  }

  function buildValidProviderWirePayload(quoteId: string, timestamp: Date, validUntil: Date, lineItemId = crypto.randomUUID()) {
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

  function signWirePayloadWithProviderPrivateKey(rawBytes: Buffer): Buffer {
    const sign = crypto.createSign("sha256");
    sign.update(rawBytes);
    return sign.sign(TEST_LEAF_PRIVATE_KEY_PEM);
  }

  it("1. Successfully executes full end-to-end statutory quote ingress to PostgreSQL", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_p3_valid_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);

    const wireObj = buildValidProviderWirePayload(quoteId, ts, validUntil);
    const rawWirePayload = Buffer.from(JSON.stringify(wireObj), "utf8");
    const statutorySignature = signWirePayloadWithProviderPrivateKey(rawWirePayload);

    const worker = createWorkerInstance();

    // Authenticate session as tax_worker_01 (tax_verifier_role)
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
    expect(result.recordedAt).toBeInstanceOf(Date);
    expect(Buffer.isBuffer(result.internalAuditSignature)).toBe(true);
    expect(Buffer.isBuffer(result.attestationSignature)).toBe(true);

    // Verify row directly in PostgreSQL TaxEvidenceRecord
    await client.query("RESET SESSION AUTHORIZATION;");
    const dbCheck = await client.query(
      `SELECT total_tax_cents, merchandise_tax_cents, shipping_tax_cents, attestation_key_id
       FROM public."TaxEvidenceRecord"
       WHERE id = $1`,
      [result.evidenceId]
    );

    expect(dbCheck.rows.length).toBe(1);
    expect(Number(dbCheck.rows[0].total_tax_cents)).toBe(240);
    expect(Number(dbCheck.rows[0].merchandise_tax_cents)).toBe(160);
    expect(Number(dbCheck.rows[0].shipping_tax_cents)).toBe(80);
    expect(dbCheck.rows[0].attestation_key_id).toBe(attestKeyId);
  });

  it("2. Fails closed when statutory provider signature is forged or altered", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_p3_bad_sig_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);

    const wireObj = buildValidProviderWirePayload(quoteId, ts, validUntil);
    const rawWirePayload = Buffer.from(JSON.stringify(wireObj), "utf8");
    // Invalid signature bytes
    const forgedSignature = Buffer.alloc(256, 0xef);

    const worker = createWorkerInstance();

    await expect(
      worker.processStatutoryQuote({
        cartId: cart.cartId,
        authorityId,
        certificateNumber: certNumber,
        providerLeafCertPem: TEST_LEAF_CERT_PEM,
        rawWirePayload,
        statutorySignature: forgedSignature,
        statutorySignatureAlgorithm: "RSA-SHA256",
        client,
      })
    ).rejects.toThrow("ERR_INVALID_PROVIDER_SIGNATURE");
  });

  it("3. Fails closed when provider certificate does not anchor to pinned root CA", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_p3_bad_ca_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);

    const wireObj = buildValidProviderWirePayload(quoteId, ts, validUntil);
    const rawWirePayload = Buffer.from(JSON.stringify(wireObj), "utf8");
    const statutorySignature = signWirePayloadWithProviderPrivateKey(rawWirePayload);

    // Worker configured with unrelated root CA
    const workerWithWrongCa = new TaxProviderIngressWorker({
      workerInstanceId: "worker_p3_inst01",
      workerPrincipal,
      attestationKeyId: attestKeyId,
      workerPublicKeyDer: workerPubKeyBytes,
      workerSigningAlgorithm: "ECDSA-P256-SHA256",
      pinnedTrustAnchors: [
        {
          authorityId,
          rootCertPem: TEST_UNRELATED_ROOT_CA_PEM, // Wrong CA
        },
      ],
      internalHmacKeyId: hmacKeyId,
    });

    await expect(
      workerWithWrongCa.processStatutoryQuote({
        cartId: cart.cartId,
        authorityId,
        certificateNumber: certNumber,
        providerLeafCertPem: TEST_LEAF_CERT_PEM,
        rawWirePayload,
        statutorySignature,
        statutorySignatureAlgorithm: "RSA-SHA256",
        client,
      })
    ).rejects.toThrow("ERR_UNTRUSTED_ROOT_CA");
  });

  it("4. Rejects stale attestation timestamp (> 300s in past) with SQLSTATE 22023", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_p3_stale_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);

    const wireObj = buildValidProviderWirePayload(quoteId, ts, validUntil);
    const rawWirePayload = Buffer.from(JSON.stringify(wireObj), "utf8");
    const statutorySignature = signWirePayloadWithProviderPrivateKey(rawWirePayload);

    const worker = createWorkerInstance();

    // 400 seconds in the past
    const staleTimestamp = new Date(Date.now() - 400000);

    await client.query(`SET SESSION AUTHORIZATION ${workerPrincipal};`);

    let err: any;
    try {
      await worker.processStatutoryQuote({
        cartId: cart.cartId,
        authorityId,
        certificateNumber: certNumber,
        providerLeafCertPem: TEST_LEAF_CERT_PEM,
        rawWirePayload,
        statutorySignature,
        statutorySignatureAlgorithm: "RSA-SHA256",
        client,
        timestampOverride: staleTimestamp,
      });
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("22023");
    expect(err.message).toContain("ERR_ATTESTATION_TIMESTAMP_SKEW");
  });

  it("5. Rejects future-dated attestation timestamp (> 300s in future) with SQLSTATE 22023", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_p3_future_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);

    const wireObj = buildValidProviderWirePayload(quoteId, ts, validUntil);
    const rawWirePayload = Buffer.from(JSON.stringify(wireObj), "utf8");
    const statutorySignature = signWirePayloadWithProviderPrivateKey(rawWirePayload);

    const worker = createWorkerInstance();

    // 400 seconds in the future
    const futureTimestamp = new Date(Date.now() + 400000);

    await client.query(`SET SESSION AUTHORIZATION ${workerPrincipal};`);

    let err: any;
    try {
      await worker.processStatutoryQuote({
        cartId: cart.cartId,
        authorityId,
        certificateNumber: certNumber,
        providerLeafCertPem: TEST_LEAF_CERT_PEM,
        rawWirePayload,
        statutorySignature,
        statutorySignatureAlgorithm: "RSA-SHA256",
        client,
        timestampOverride: futureTimestamp,
      });
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("22023");
    expect(err.message).toContain("ERR_ATTESTATION_TIMESTAMP_SKEW");
  });

  it("6. Rejects replayed nonce on subsequent quote with SQLSTATE 23505", async () => {
    const cart1 = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const cart2 = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const fixedNonce = "fixed_nonce_replay_" + crypto.randomUUID();

    const quoteId1 = "quote_p3_rep1_" + crypto.randomUUID();
    const quoteId2 = "quote_p3_rep2_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);

    const rawWire1 = Buffer.from(JSON.stringify(buildValidProviderWirePayload(quoteId1, ts, validUntil)), "utf8");
    const sig1 = signWirePayloadWithProviderPrivateKey(rawWire1);

    const rawWire2 = Buffer.from(JSON.stringify(buildValidProviderWirePayload(quoteId2, ts, validUntil)), "utf8");
    const sig2 = signWirePayloadWithProviderPrivateKey(rawWire2);

    const worker = createWorkerInstance();

    await client.query(`SET SESSION AUTHORIZATION ${workerPrincipal};`);

    // First quote succeeds
    await worker.processStatutoryQuote({
      cartId: cart1.cartId,
      authorityId,
      certificateNumber: certNumber,
      providerLeafCertPem: TEST_LEAF_CERT_PEM,
      rawWirePayload: rawWire1,
      statutorySignature: sig1,
      statutorySignatureAlgorithm: "RSA-SHA256",
      client,
      nonceOverride: fixedNonce,
    });

    // Second quote with identical nonce must be rejected
    let err: any;
    try {
      await worker.processStatutoryQuote({
        cartId: cart2.cartId,
        authorityId,
        certificateNumber: certNumber,
        providerLeafCertPem: TEST_LEAF_CERT_PEM,
        rawWirePayload: rawWire2,
        statutorySignature: sig2,
        statutorySignatureAlgorithm: "RSA-SHA256",
        client,
        nonceOverride: fixedNonce,
      });
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("23505");
    expect(err.message).toContain("ERR_REPLAY_ATTACK_DETECTED");
  });

  it("7. Rejects asserted verifier identity mismatch with SQLSTATE 42501", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_p3_mismatch_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);

    const rawWire = Buffer.from(JSON.stringify(buildValidProviderWirePayload(quoteId, ts, validUntil)), "utf8");
    const sig = signWirePayloadWithProviderPrivateKey(rawWire);

    // Worker asserts identity 'tax_worker_spoofed' while session is 'tax_worker_01'
    const workerWithSpoofedIdentity = createWorkerInstance(attestKeyId, "tax_worker_spoofed");

    await client.query(`SET SESSION AUTHORIZATION ${workerPrincipal};`);

    let err: any;
    try {
      await workerWithSpoofedIdentity.processStatutoryQuote({
        cartId: cart.cartId,
        authorityId,
        certificateNumber: certNumber,
        providerLeafCertPem: TEST_LEAF_CERT_PEM,
        rawWirePayload: rawWire,
        statutorySignature: sig,
        statutorySignatureAlgorithm: "RSA-SHA256",
        client,
      });
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("42501");
    expect(err.message).toContain("ERR_VERIFIER_IDENTITY_MISMATCH");
  });

  it("8. Rejects non-zero provider adjustment with ERR_UNSUPPORTED_ADJUSTMENT", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_p3_adj_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);

    const wireObj = buildValidProviderWirePayload(quoteId, ts, validUntil);
    (wireObj as any).adjustment = "5.00"; // Non-zero adjustment prohibited
    const rawWirePayload = Buffer.from(JSON.stringify(wireObj), "utf8");
    const statutorySignature = signWirePayloadWithProviderPrivateKey(rawWirePayload);

    const worker = createWorkerInstance();

    await expect(
      worker.processStatutoryQuote({
        cartId: cart.cartId,
        authorityId,
        certificateNumber: certNumber,
        providerLeafCertPem: TEST_LEAF_CERT_PEM,
        rawWirePayload,
        statutorySignature,
        statutorySignatureAlgorithm: "RSA-SHA256",
        client,
      })
    ).rejects.toThrow("ERR_UNSUPPORTED_ADJUSTMENT");
  });

  it("9. Rejects unauthorized caller role (orchestrator_worker_user) with SQLSTATE 42501", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_p3_unauth_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);

    const rawWire = Buffer.from(JSON.stringify(buildValidProviderWirePayload(quoteId, ts, validUntil)), "utf8");
    const sig = signWirePayloadWithProviderPrivateKey(rawWire);

    const worker = createWorkerInstance();

    // Session authenticated as application orchestrator rather than tax_verifier_role
    await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");

    let err: any;
    try {
      await worker.processStatutoryQuote({
        cartId: cart.cartId,
        authorityId,
        certificateNumber: certNumber,
        providerLeafCertPem: TEST_LEAF_CERT_PEM,
        rawWirePayload: rawWire,
        statutorySignature: sig,
        statutorySignatureAlgorithm: "RSA-SHA256",
        client,
      });
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("42501");
  });
});
