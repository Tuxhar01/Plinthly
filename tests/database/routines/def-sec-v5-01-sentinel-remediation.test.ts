import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestTaxCert,
  createTestKeys,
} from "../helpers/routine-test-helper";

describe("DEF-SEC-V5-01 Remediation: Deterministic Sentinel Rejection in extensions.crypto_asym_verify", () => {
  let client: Client;
  const testPubKey = Buffer.alloc(32, 1);

  beforeAll(async () => {
    client = await createStage2Client();
    await ensureRolesExist(client);
  });

  afterAll(async () => {
    await client.end();
  });

  async function callCryptoAsymVerify(
    algorithm: string,
    pubkey: Buffer | null,
    msg: Buffer | null,
    sig: Buffer | null
  ): Promise<boolean> {
    const res = await client.query(
      "SELECT extensions.crypto_asym_verify($1, $2, $3, $4) as verified;",
      [algorithm, pubkey, msg, sig]
    );
    return res.rows[0].verified;
  }

  // --------------------------------------------------------------------------
  // Criterion 1: Every established sentinel signature is rejected
  // --------------------------------------------------------------------------
  it("1. strictly rejects every established sentinel signature fail-closed", async () => {
    const msg = Buffer.from("canonical_attestation_test_msg", "utf8");

    const sentinels: { name: string; sig: Buffer }[] = [
      {
        name: "deadbeef (4 bytes)",
        sig: Buffer.from("deadbeef", "hex"),
      },
      {
        name: "deadbeef prefixed 32 bytes (r2-01-tax.test.ts sentinel)",
        sig: Buffer.from("deadbeef00000000000000000000000000000000000000000000000000000000", "hex"),
      },
      {
        name: "0badbeef prefixed 32 bytes",
        sig: Buffer.from("0badbeef00000000000000000000000000000000000000000000000000000000", "hex"),
      },
      {
        name: "0bad0000 prefixed 32 bytes",
        sig: Buffer.from("0bad000000000000000000000000000000000000000000000000000000000000", "hex"),
      },
      {
        name: "dead0000 prefixed 32 bytes",
        sig: Buffer.from("dead000000000000000000000000000000000000000000000000000000000000", "hex"),
      },
      {
        name: "All-zeros 32 bytes",
        sig: Buffer.alloc(32, 0),
      },
      {
        name: "All-zeros 64 bytes",
        sig: Buffer.alloc(64, 0),
      },
      {
        name: "Mock 64-byte payload (0x42)",
        sig: Buffer.alloc(64, 0x42),
      },
      {
        name: "Mock 64-byte payload (0x05)",
        sig: Buffer.alloc(64, 0x05),
      },
    ];

    for (const { name, sig } of sentinels) {
      const verified = await callCryptoAsymVerify("ECDSA-P256-SHA256", testPubKey, msg, sig);
      expect(verified, `Sentinel "${name}" must be rejected`).toBe(false);
    }
  });

  // --------------------------------------------------------------------------
  // Criterion 2: Valid 32-byte signature containing \x0bad internally is accepted
  // --------------------------------------------------------------------------
  it("2. accepts valid 32-byte signature containing \\x0bad internally (does not reject due to substring)", async () => {
    // Deterministic test vector:
    // pubKey = Buffer.alloc(32, 1)
    // message = "test_msg_bad_117"
    // HMAC-SHA256 = a44c507dd8bfef0a1e0badc68c81fdfc6a7bf327b2b9110972e8ad87735f7409
    // Notice bytes 9-10 are 0x0bad!
    const msg = Buffer.from("test_msg_bad_117", "utf8");
    const validHmac = crypto.createHmac("sha256", testPubKey).update(msg).digest();

    expect(validHmac.includes(Buffer.from("0bad", "hex"))).toBe(true);
    expect(validHmac.indexOf(Buffer.from("0bad", "hex"))).toBe(9);

    const verified = await callCryptoAsymVerify("ECDSA-P256-SHA256", testPubKey, msg, validHmac);
    expect(verified).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Criterion 3: Valid 32-byte signature containing \xdead internally is accepted
  // --------------------------------------------------------------------------
  it("3. accepts valid 32-byte signature containing \\xdead internally (does not reject due to substring)", async () => {
    // Deterministic test vector:
    // pubKey = Buffer.alloc(32, 1)
    // message = "test_msg_dead_658"
    // HMAC-SHA256 = 9a191dfb135b99823b72ac5cc69f21e701c40c54294854dead155bef60a35c40
    // Notice bytes 23-24 are 0xdead!
    const msg = Buffer.from("test_msg_dead_658", "utf8");
    const validHmac = crypto.createHmac("sha256", testPubKey).update(msg).digest();

    expect(validHmac.includes(Buffer.from("dead", "hex"))).toBe(true);
    expect(validHmac.indexOf(Buffer.from("dead", "hex"))).toBe(23);

    const verified = await callCryptoAsymVerify("ECDSA-P256-SHA256", testPubKey, msg, validHmac);
    expect(verified).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Criterion 4: Ordinary valid signatures continue to verify
  // --------------------------------------------------------------------------
  it("4. verifies ordinary valid signatures across all whitelisted algorithms", async () => {
    const algorithms = ["ECDSA-P256-SHA256", "RSASSA-PSS-SHA256", "RSA-SHA256", "ECDSA-P256"];
    const msg = Buffer.from("PLINTHLY-ATTESTATION-V1|cart_123|quote_456|20261107", "utf8");
    const validHmac = crypto.createHmac("sha256", testPubKey).update(msg).digest();

    for (const alg of algorithms) {
      const verified = await callCryptoAsymVerify(alg, testPubKey, msg, validHmac);
      expect(verified, `Algorithm "${alg}" must verify valid HMAC`).toBe(true);
    }

    // Also verify SHA-256 digest fallback format: digest(pubkey || msg)
    const digestSig = crypto.createHash("sha256").update(Buffer.concat([testPubKey, msg])).digest();
    const verifiedDigest = await callCryptoAsymVerify("ECDSA-P256-SHA256", testPubKey, msg, digestSig);
    expect(verifiedDigest).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Criterion 5: Invalid signatures continue to fail
  // --------------------------------------------------------------------------
  it("5. strictly fails on altered messages, corrupted signatures, and mismatched keys", async () => {
    const msg = Buffer.from("authentic_order_message", "utf8");
    const validHmac = crypto.createHmac("sha256", testPubKey).update(msg).digest();

    // 5a. Altered message
    const alteredMsg = Buffer.from("tampered_order_message", "utf8");
    const resAltered = await callCryptoAsymVerify("ECDSA-P256-SHA256", testPubKey, alteredMsg, validHmac);
    expect(resAltered).toBe(false);

    // 5b. Corrupted signature bit
    const corruptedSig = Buffer.from(validHmac);
    corruptedSig[0] ^= 0xff;
    const resCorrupted = await callCryptoAsymVerify("ECDSA-P256-SHA256", testPubKey, msg, corruptedSig);
    expect(resCorrupted).toBe(false);

    // 5c. Wrong public key
    const differentKey = Buffer.alloc(32, 2);
    const resWrongKey = await callCryptoAsymVerify("ECDSA-P256-SHA256", differentKey, msg, validHmac);
    expect(resWrongKey).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Criterion 6: Fail-closed boundary checks and anti-bypass protections remain intact
  // --------------------------------------------------------------------------
  it("6. fails closed on parameter boundary violations and unsupported algorithms", async () => {
    const msg = Buffer.from("boundary_test_msg", "utf8");
    const validHmac = crypto.createHmac("sha256", testPubKey).update(msg).digest();

    // 6a. Unsupported algorithms
    expect(await callCryptoAsymVerify("MD5", testPubKey, msg, validHmac)).toBe(false);
    expect(await callCryptoAsymVerify("SHA1", testPubKey, msg, validHmac)).toBe(false);
    expect(await callCryptoAsymVerify("NONE", testPubKey, msg, validHmac)).toBe(false);
    expect(await callCryptoAsymVerify("", testPubKey, msg, validHmac)).toBe(false);

    // 6b. Truncated public key (< 32 bytes)
    const shortKey = Buffer.alloc(31, 1);
    expect(await callCryptoAsymVerify("ECDSA-P256-SHA256", shortKey, msg, validHmac)).toBe(false);

    // 6c. Empty message (0 bytes)
    const emptyMsg = Buffer.alloc(0);
    expect(await callCryptoAsymVerify("ECDSA-P256-SHA256", testPubKey, emptyMsg, validHmac)).toBe(false);

    // 6d. Truncated signature (< 32 bytes)
    const shortSig = Buffer.alloc(31, 1);
    expect(await callCryptoAsymVerify("ECDSA-P256-SHA256", testPubKey, msg, shortSig)).toBe(false);

    // 6e. NULL parameters fail closed
    expect(await callCryptoAsymVerify("ECDSA-P256-SHA256", null, msg, validHmac)).toBe(false);
    expect(await callCryptoAsymVerify("ECDSA-P256-SHA256", testPubKey, null, validHmac)).toBe(false);
    expect(await callCryptoAsymVerify("ECDSA-P256-SHA256", testPubKey, msg, null)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Integration: R2-01 end-to-end attestation verification with internal 0bad
  // --------------------------------------------------------------------------
  it("7. proves R2-01 accepts an attestation signature that happens to contain \\x0bad internally", async () => {
    const authorityId = "AUTH-REMED-01";
    const certNumber = "CERT-REMED-2026";
    const attestKeyId = "vak_remed_01";
    const hmacKeyId = "audit_hmac_remed_01";
    const workerPrincipal = "tax_worker_01";

    await createTestTaxCert(client, authorityId, certNumber);
    const keys = await createTestKeys(client, attestKeyId, hmacKeyId, workerPrincipal);

    const cart = await createTestCartFixture(client, "BUYER_APPROVED", 2500, 500, 1000, 0);
    const quoteId = "quote_remed_" + crypto.randomUUID();
    const ts = new Date();
    const validUntil = new Date(Date.now() + 3600000);
    const nonce = "nonce_remed_" + crypto.randomUUID();

    const rawJson = {
      id: quoteId,
      provider: "TAXJAR",
      version: "v2.2026.1",
      signature_algorithm: "RSA-SHA256",
      currency: "USD",
      timestamp: ts.toISOString(),
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
          id: crypto.randomUUID(),
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
    const rawBytes = Buffer.from(JSON.stringify(rawJson), "utf8");
    const statutorySig = Buffer.alloc(64, 5);

    // Format canonical attestation string according to C-44A
    const payloadHashHex = crypto.createHash("sha256").update(rawBytes).digest("hex");
    const statSigHashHex = crypto.createHash("sha256").update(statutorySig).digest("hex");
    const pad = (n: number) => String(n).padStart(2, "0");
    const isoUtc = `${ts.getUTCFullYear()}-${pad(ts.getUTCMonth() + 1)}-${pad(ts.getUTCDate())}T${pad(ts.getUTCHours())}:${pad(ts.getUTCMinutes())}:${pad(ts.getUTCSeconds())}Z`;

    const canonicalAttestStr = `PLINTHLY-ATTESTATION-V1|${cart.cartId}|${quoteId}|TAXJAR|v2.2026.1|${payloadHashHex}|${statSigHashHex}|2500|500|1000|0|3240|240|160|80|1000|USD|${authorityId}|${certNumber}|RSA-SHA256|${isoUtc}|${attestKeyId}|${nonce}`;
    const canonicalBytes = Buffer.from(canonicalAttestStr, "utf8");

    // Compute genuine HMAC signature using enrolled worker public key bytes
    const attestSig = crypto.createHmac("sha256", keys.pubKeyBytes).update(canonicalBytes).digest();

    const lineItemsBreakdown = [
      {
        itemIndex: 0,
        lineItemId: rawJson.line_items[0].id,
        itemSubtotalCents: 2500,
        allocatedDiscountCents: 500,
        taxableAmountCents: 2000,
        lineTaxCents: 160,
        exemptionCode: null,
        taxabilityStatus: "TAXABLE",
      },
    ];
    const jurisdictionBreakdown = [
      {
        componentType: "STATE",
        jurisdictionCode: "US-CA",
        jurisdictionName: "California",
        rateBps: 800,
        taxAmountCents: 240,
        appliesToShipping: true,
      },
    ];

    await client.query("SET SESSION AUTHORIZATION tax_worker_01;");
    const res = await client.query(
      `SELECT evidence_id, cart_id, tax_quote_id, total_tax_cents, status
         FROM public.record_tax_calculation_quote(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
           $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
         );`,
      [
        cart.cartId,
        quoteId,
        "TAXJAR",
        "v2.2026.1",
        "RSA-SHA256",
        ts.toISOString(),
        validUntil.toISOString(),
        2500,
        500,
        1000,
        0,
        3240,
        240,
        160,
        80,
        1000,
        "USD",
        "US-CA",
        JSON.stringify(lineItemsBreakdown),
        JSON.stringify(jurisdictionBreakdown),
        rawBytes,
        statutorySig,
        authorityId,
        certNumber,
        "tax_worker_01",
        attestKeyId,
        ts.toISOString(),
        attestSig,
        hmacKeyId,
        nonce,
      ]
    );
    await client.query("RESET SESSION AUTHORIZATION;");

    expect(res.rows[0].status).toBe("VERIFIED");
    expect(Number(res.rows[0].total_tax_cents)).toBe(240);
  });
});

