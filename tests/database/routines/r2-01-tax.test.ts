import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestTaxCert,
  createTestKeys,
} from "../helpers/routine-test-helper";

describe("Routine R2-01: record_tax_calculation_quote", () => {
  let client: Client;
  const authorityId = "AUTH-US-CA";
  const certNumber = "CERT-2026-R01";
  const attestKeyId = "vak_tax_worker_01_r01";
  const hmacKeyId = "hmac_key_r01";
  let pubKeyBytes: Buffer;
  let hmacKeyBytes: Buffer;

  beforeAll(async () => {
    client = await createStage2Client();
    await ensureRolesExist(client);
    await createTestTaxCert(client, authorityId, certNumber);
    const keys = await createTestKeys(client, attestKeyId, hmacKeyId, "tax_worker_01");
    pubKeyBytes = keys.pubKeyBytes;
    hmacKeyBytes = keys.hmacKeyBytes;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("RESET SESSION AUTHORIZATION;");
  });

  function buildValidPayload(quoteId: string, timestamp: Date, validUntil: Date) {
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
        taxable_shipping: "10.00"
      },
      line_items: [
        {
          id: "li_01",
          subtotal: "25.00",
          discount: "5.00",
          taxable_amount: "20.00",
          tax_collectable: "1.60",
          exemption_code: null,
          taxability_status: "TAXABLE"
        }
      ],
      jurisdictions: [
        {
          type: "STATE",
          code: "US-CA",
          name: "California",
          rate_bps: 800,
          amount: "2.40",
          applies_to_shipping: true
        }
      ]
    };
  }

  function signAttestation(
    cartId: string,
    quoteId: string,
    rawPayloadBytes: Buffer,
    statutorySigBytes: Buffer,
    attestTimestamp: Date,
    nonce: string
  ): Buffer {
    const payloadHashHex = crypto.createHash("sha256").update(rawPayloadBytes).digest("hex");
    const statSigHashHex = crypto.createHash("sha256").update(statutorySigBytes).digest("hex");

    const pad = (n: number) => String(n).padStart(2, "0");
    const d = attestTimestamp;
    const isoUtc = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;

    const canonicalAttestStr = `PLINTHLY-ATTESTATION-V1|${cartId}|${quoteId}|TAXJAR|v2.2026.1|${payloadHashHex}|${statSigHashHex}|2500|500|1000|0|3240|240|160|80|1000|USD|${authorityId}|${certNumber}|RSA-SHA256|${isoUtc}|${attestKeyId}|${nonce}`;
    const attestBytes = Buffer.from(canonicalAttestStr, "utf8");
    return crypto.createHmac("sha256", pubKeyBytes).update(attestBytes).digest();
  }

  it("succeeds for valid 30-parameter quote and records immutable evidence", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_valid_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);
    const nonce = "nonce_r01_valid_" + crypto.randomUUID();
    const rawJson = buildValidPayload(quoteId, ts, validUntil);
    const rawBytes = Buffer.from(JSON.stringify(rawJson), "utf8");
    const statutorySig = Buffer.alloc(64, 5);
    const attestSig = signAttestation(cart.cartId, quoteId, rawBytes, statutorySig, ts, nonce);

    const lineItemsBreakdown = [
      {
        itemIndex: 0,
        lineItemId: "li_01",
        itemSubtotalCents: 2500,
        allocatedDiscountCents: 500,
        taxableAmountCents: 2000,
        lineTaxCents: 160,
        exemptionCode: null,
        taxabilityStatus: "TAXABLE"
      }
    ];

    const jurisdictionBreakdown = [
      {
        componentType: "STATE",
        jurisdictionCode: "US-CA",
        jurisdictionName: "California",
        rateBps: 800,
        taxAmountCents: 240,
        appliesToShipping: true
      }
    ];

    let res: any;
    try {
      await client.query("SET SESSION AUTHORIZATION tax_worker_01;");
      res = await client.query(`
        SELECT * FROM public.record_tax_calculation_quote(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
        );
      `, [
        cart.cartId, quoteId, "TAXJAR", "v2.2026.1", "RSA-SHA256",
        ts.toISOString(), validUntil.toISOString(),
        2500, 500, 1000, 0, 3240,
        240, 160, 80, 1000,
        "USD", "US-CA", JSON.stringify(lineItemsBreakdown), JSON.stringify(jurisdictionBreakdown),
        rawBytes, statutorySig, authorityId, certNumber,
        "tax_worker_01", attestKeyId, ts.toISOString(), attestSig,
        hmacKeyId, nonce
      ]);
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    const row = res.rows[0];
    expect(row.cart_id).toBe(cart.cartId);
    expect(row.tax_quote_id).toBe(quoteId);
    expect(row.total_tax_cents).toBe("240");
    expect(row.status).toBe("VERIFIED");
    expect(row.internal_audit_signature).toBeDefined();

    // Verify 33 columns persisted in TaxEvidenceRecord
    const evCheck = await client.query('SELECT * FROM public."TaxEvidenceRecord" WHERE id = $1', [row.evidence_id]);
    expect(evCheck.rows.length).toBe(1);
    const ev = evCheck.rows[0];
    expect(ev.cart_id).toBe(cart.cartId);
    expect(ev.provider_name).toBe("TAXJAR");
    expect(ev.total_tax_cents).toBe("240");
    expect(ev.merchandise_tax_cents).toBe("160");
    expect(ev.shipping_tax_cents).toBe("80");
    expect(ev.currency).toBe("USD");
    expect(ev.verifier_identity).toBe("tax_worker_01");

    // Verify Cart updated
    const cartCheck = await client.query('SELECT "taxAmountCents", "totalCartCents" FROM public."ApprovedMerchantCart" WHERE id = $1', [cart.cartId]);
    expect(cartCheck.rows[0].taxAmountCents).toBe("240");
    expect(cartCheck.rows[0].totalCartCents).toBe("3240");
  });

  it("rejects nonce replay attempt with SQLSTATE 23505", async () => {
    const cart1 = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const cart2 = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId1 = "quote_replay_01_" + crypto.randomUUID();
    const quoteId2 = "quote_replay_02_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);
    const nonce = "nonce_r01_replay_target_" + crypto.randomUUID();

    const rawJson1 = buildValidPayload(quoteId1, ts, validUntil);
    const rawBytes1 = Buffer.from(JSON.stringify(rawJson1), "utf8");
    const statutorySig = Buffer.alloc(64, 5);
    const attestSig1 = signAttestation(cart1.cartId, quoteId1, rawBytes1, statutorySig, ts, nonce);

    const rawJson2 = buildValidPayload(quoteId2, ts, validUntil);
    const rawBytes2 = Buffer.from(JSON.stringify(rawJson2), "utf8");
    const attestSig2 = signAttestation(cart2.cartId, quoteId2, rawBytes2, statutorySig, ts, nonce);

    const lineItemsBreakdown = [{
      itemIndex: 0, lineItemId: "li_01", itemSubtotalCents: 2500, allocatedDiscountCents: 500,
      taxableAmountCents: 2000, lineTaxCents: 160, exemptionCode: null, taxabilityStatus: "TAXABLE"
    }];
    const jurisdictionBreakdown = [{
      componentType: "STATE", jurisdictionCode: "US-CA", jurisdictionName: "California",
      rateBps: 800, taxAmountCents: 240, appliesToShipping: true
    }];

    try {
      await client.query("SET SESSION AUTHORIZATION tax_worker_01;");
      // First invocation on cart1 succeeds
      await client.query(`
        SELECT * FROM public.record_tax_calculation_quote(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
        );
      `, [
        cart1.cartId, quoteId1, "TAXJAR", "v2.2026.1", "RSA-SHA256",
        ts.toISOString(), validUntil.toISOString(),
        2500, 500, 1000, 0, 3240,
        240, 160, 80, 1000,
        "USD", "US-CA", JSON.stringify(lineItemsBreakdown), JSON.stringify(jurisdictionBreakdown),
        rawBytes1, statutorySig, authorityId, certNumber,
        "tax_worker_01", attestKeyId, ts.toISOString(), attestSig1,
        hmacKeyId, nonce
      ]);
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    // Second invocation with identical nonce on cart2 must fail on NonceRegistry unique violation
    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION tax_worker_01;");
      await client.query(`
        SELECT * FROM public.record_tax_calculation_quote(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
        );
      `, [
        cart2.cartId, quoteId2, "TAXJAR", "v2.2026.1", "RSA-SHA256",
        ts.toISOString(), validUntil.toISOString(),
        2500, 500, 1000, 0, 3240,
        240, 160, 80, 1000,
        "USD", "US-CA", JSON.stringify(lineItemsBreakdown), JSON.stringify(jurisdictionBreakdown),
        rawBytes2, statutorySig, authorityId, certNumber,
        "tax_worker_01", attestKeyId, ts.toISOString(), attestSig2,
        hmacKeyId, nonce
      ]);
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("23505");
    expect(err.message).toContain("ERR_REPLAY_ATTACK_DETECTED");
  });

  it("rejects unauthorized caller role with SQLSTATE 42501", async () => {
    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");
      await client.query("SELECT * FROM public.record_tax_calculation_quote($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30);", Array(30).fill(null));
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("42501");
  });

  it("rejects asserted verifier identity mismatch with SQLSTATE 42501", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_mismatch_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);
    const nonce = "nonce_mismatch_" + crypto.randomUUID();
    const rawJson = buildValidPayload(quoteId, ts, validUntil);
    const rawBytes = Buffer.from(JSON.stringify(rawJson), "utf8");
    const statutorySig = Buffer.alloc(64, 5);
    const attestSig = Buffer.alloc(64, 7);

    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION tax_worker_01;");
      await client.query(`
        SELECT * FROM public.record_tax_calculation_quote(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
        );
      `, [
        cart.cartId, quoteId, "TAXJAR", "v2.2026.1", "RSA-SHA256",
        ts.toISOString(), validUntil.toISOString(),
        2500, 500, 1000, 0, 3240,
        240, 160, 80, 1000,
        "USD", "US-CA", "[]", "[]",
        rawBytes, statutorySig, authorityId, certNumber,
        "tax_worker_spoofed_pod", attestKeyId, ts.toISOString(), attestSig,
        hmacKeyId, nonce
      ]);
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("42501");
    expect(err.message).toContain("ERR_VERIFIER_IDENTITY_MISMATCH");
  });

  it("rejects non-zero provider adjustment with SQLSTATE 23514", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_adj_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);
    const nonce = "nonce_adj_" + crypto.randomUUID();
    const rawJson = buildValidPayload(quoteId, ts, validUntil);
    const rawBytes = Buffer.from(JSON.stringify(rawJson), "utf8");

    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION tax_worker_01;");
      await client.query(`
        SELECT * FROM public.record_tax_calculation_quote(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
        );
      `, [
        cart.cartId, quoteId, "TAXJAR", "v2.2026.1", "RSA-SHA256",
        ts.toISOString(), validUntil.toISOString(),
        2500, 500, 1000, 50, 3290,
        240, 160, 80, 1000,
        "USD", "US-CA", "[]", "[]",
        rawBytes, Buffer.alloc(64), authorityId, certNumber,
        "tax_worker_01", attestKeyId, ts.toISOString(), Buffer.alloc(64),
        hmacKeyId, nonce
      ]);
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("23514");
    expect(err.message).toContain("ERR_UNSUPPORTED_ADJUSTMENT");
  });

  it("rejects missing payload fields in raw line item with SQLSTATE 22023 (C-48)", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_c48_missing_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);
    const nonce = "nonce_c48_missing_" + crypto.randomUUID();
    const rawJson = buildValidPayload(quoteId, ts, validUntil);
    delete (rawJson.line_items[0] as any).taxability_status;
    const rawBytes = Buffer.from(JSON.stringify(rawJson), "utf8");

    const lineItemsBreakdown = [{
      itemIndex: 0, lineItemId: "li_01", itemSubtotalCents: 2500, allocatedDiscountCents: 500,
      taxableAmountCents: 2000, lineTaxCents: 160, exemptionCode: null, taxabilityStatus: "TAXABLE"
    }];
    const jurisdictionBreakdown = [{
      componentType: "STATE", jurisdictionCode: "US-CA", jurisdictionName: "California",
      rateBps: 800, taxAmountCents: 240, appliesToShipping: true
    }];

    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION tax_worker_01;");
      await client.query(`
        SELECT * FROM public.record_tax_calculation_quote(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
        );
      `, [
        cart.cartId, quoteId, "TAXJAR", "v2.2026.1", "RSA-SHA256",
        ts.toISOString(), validUntil.toISOString(),
        2500, 500, 1000, 0, 3240,
        240, 160, 80, 1000,
        "USD", "US-CA", JSON.stringify(lineItemsBreakdown), JSON.stringify(jurisdictionBreakdown),
        rawBytes, Buffer.alloc(64), authorityId, certNumber,
        "tax_worker_01", attestKeyId, ts.toISOString(), Buffer.alloc(64),
        hmacKeyId, nonce
      ]);
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("22023");
    expect(err.message).toContain("ERR_MISSING_PAYLOAD_FIELD");
  });

  it("rejects unexpected properties in normalized line item with SQLSTATE 22023 (C-48)", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_c48_unexpected_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);
    const nonce = "nonce_c48_unexpected_" + crypto.randomUUID();
    const rawJson = buildValidPayload(quoteId, ts, validUntil);
    const rawBytes = Buffer.from(JSON.stringify(rawJson), "utf8");

    const lineItemsBreakdown = [{
      itemIndex: 0, lineItemId: "li_01", itemSubtotalCents: 2500, allocatedDiscountCents: 500,
      taxableAmountCents: 2000, lineTaxCents: 160, exemptionCode: null, taxabilityStatus: "TAXABLE",
      rogueProperty: "injected"
    }];
    const jurisdictionBreakdown = [{
      componentType: "STATE", jurisdictionCode: "US-CA", jurisdictionName: "California",
      rateBps: 800, taxAmountCents: 240, appliesToShipping: true
    }];

    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION tax_worker_01;");
      await client.query(`
        SELECT * FROM public.record_tax_calculation_quote(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
        );
      `, [
        cart.cartId, quoteId, "TAXJAR", "v2.2026.1", "RSA-SHA256",
        ts.toISOString(), validUntil.toISOString(),
        2500, 500, 1000, 0, 3240,
        240, 160, 80, 1000,
        "USD", "US-CA", JSON.stringify(lineItemsBreakdown), JSON.stringify(jurisdictionBreakdown),
        rawBytes, Buffer.alloc(64), authorityId, certNumber,
        "tax_worker_01", attestKeyId, ts.toISOString(), Buffer.alloc(64),
        hmacKeyId, nonce
      ]);
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("22023");
    expect(err.message).toContain("ERR_UNEXPECTED_PAYLOAD_FIELD");
  });

  it("rejects invalid verifier cryptographic attestation signature with SQLSTATE 42501", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_bad_sig_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);
    const nonce = "nonce_bad_sig_" + crypto.randomUUID();
    const rawJson = buildValidPayload(quoteId, ts, validUntil);
    const rawBytes = Buffer.from(JSON.stringify(rawJson), "utf8");
    const badAttestSig = Buffer.from("deadbeef00000000000000000000000000000000000000000000000000000000", "hex");

    const lineItemsBreakdown = [{
      itemIndex: 0, lineItemId: "li_01", itemSubtotalCents: 2500, allocatedDiscountCents: 500,
      taxableAmountCents: 2000, lineTaxCents: 160, exemptionCode: null, taxabilityStatus: "TAXABLE"
    }];
    const jurisdictionBreakdown = [{
      componentType: "STATE", jurisdictionCode: "US-CA", jurisdictionName: "California",
      rateBps: 800, taxAmountCents: 240, appliesToShipping: true
    }];

    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION tax_worker_01;");
      await client.query(`
        SELECT * FROM public.record_tax_calculation_quote(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
        );
      `, [
        cart.cartId, quoteId, "TAXJAR", "v2.2026.1", "RSA-SHA256",
        ts.toISOString(), validUntil.toISOString(),
        2500, 500, 1000, 0, 3240,
        240, 160, 80, 1000,
        "USD", "US-CA", JSON.stringify(lineItemsBreakdown), JSON.stringify(jurisdictionBreakdown),
        rawBytes, Buffer.alloc(64), authorityId, certNumber,
        "tax_worker_01", attestKeyId, ts.toISOString(), badAttestSig,
        hmacKeyId, nonce
      ]);
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("42501");
    expect(err.message).toContain("ERR_INVALID_VERIFIER_ATTESTATION");
  });

  it("strictly rejects arbitrary 64-byte mock payload that bypassed previous implementation with SQLSTATE 42501", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_mock_bypass_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);
    const nonce = "nonce_mock_bypass_" + crypto.randomUUID();
    const rawJson = buildValidPayload(quoteId, ts, validUntil);
    const rawBytes = Buffer.from(JSON.stringify(rawJson), "utf8");
    // This 64-byte payload was previously accepted by octet_length(p_sig) >= 64 mock check
    const mockBypassSig = Buffer.alloc(64, 0x42);

    const lineItemsBreakdown = [{
      itemIndex: 0, lineItemId: "li_01", itemSubtotalCents: 2500, allocatedDiscountCents: 500,
      taxableAmountCents: 2000, lineTaxCents: 160, exemptionCode: null, taxabilityStatus: "TAXABLE"
    }];
    const jurisdictionBreakdown = [{
      componentType: "STATE", jurisdictionCode: "US-CA", jurisdictionName: "California",
      rateBps: 800, taxAmountCents: 240, appliesToShipping: true
    }];

    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION tax_worker_01;");
      await client.query(`
        SELECT * FROM public.record_tax_calculation_quote(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
        );
      `, [
        cart.cartId, quoteId, "TAXJAR", "v2.2026.1", "RSA-SHA256",
        ts.toISOString(), validUntil.toISOString(),
        2500, 500, 1000, 0, 3240,
        240, 160, 80, 1000,
        "USD", "US-CA", JSON.stringify(lineItemsBreakdown), JSON.stringify(jurisdictionBreakdown),
        rawBytes, Buffer.alloc(64), authorityId, certNumber,
        "tax_worker_01", attestKeyId, ts.toISOString(), mockBypassSig,
        hmacKeyId, nonce
      ]);
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    // Must be strictly rejected with SQLSTATE 42501 (DEF-CRYPT-01 remediation verified)
    expect(err).toBeDefined();
    expect(err.code).toBe("42501");
    expect(err.message).toContain("ERR_INVALID_VERIFIER_ATTESTATION");
  });

  it("fails closed when attestation signature was generated over a different quote ID with SQLSTATE 42501", async () => {
    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_real_" + crypto.randomUUID();
    const otherQuoteId = "quote_forged_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);
    const nonce = "nonce_mismatch_" + crypto.randomUUID();
    const rawJson = buildValidPayload(quoteId, ts, validUntil);
    const rawBytes = Buffer.from(JSON.stringify(rawJson), "utf8");
    const statutorySig = Buffer.alloc(64, 5);

    // Attestation signed over otherQuoteId instead of quoteId
    const mismatchedAttestSig = signAttestation(cart.cartId, otherQuoteId, rawBytes, statutorySig, ts, nonce);

    const lineItemsBreakdown = [{
      itemIndex: 0, lineItemId: "li_01", itemSubtotalCents: 2500, allocatedDiscountCents: 500,
      taxableAmountCents: 2000, lineTaxCents: 160, exemptionCode: null, taxabilityStatus: "TAXABLE"
    }];
    const jurisdictionBreakdown = [{
      componentType: "STATE", jurisdictionCode: "US-CA", jurisdictionName: "California",
      rateBps: 800, taxAmountCents: 240, appliesToShipping: true
    }];

    let err: any;
    try {
      await client.query("SET SESSION AUTHORIZATION tax_worker_01;");
      await client.query(`
        SELECT * FROM public.record_tax_calculation_quote(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
        );
      `, [
        cart.cartId, quoteId, "TAXJAR", "v2.2026.1", "RSA-SHA256",
        ts.toISOString(), validUntil.toISOString(),
        2500, 500, 1000, 0, 3240,
        240, 160, 80, 1000,
        "USD", "US-CA", JSON.stringify(lineItemsBreakdown), JSON.stringify(jurisdictionBreakdown),
        rawBytes, statutorySig, authorityId, certNumber,
        "tax_worker_01", attestKeyId, ts.toISOString(), mismatchedAttestSig,
        hmacKeyId, nonce
      ]);
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("42501");
    expect(err.message).toContain("ERR_INVALID_VERIFIER_ATTESTATION");
  });
});
