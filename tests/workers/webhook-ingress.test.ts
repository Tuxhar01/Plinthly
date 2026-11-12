import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import { PayPalWebhookIngressWorker } from "../../lib/workers/webhook-ingress-worker";
import { formatPayPalSignatureMessage, computePayPalCrc32 } from "../../lib/crypto/paypal-crc32";
import {
  createStage2Client,
  ensureRolesExist,
  createTestKeys,
} from "../database/helpers/routine-test-helper";
import {
  TEST_ROOT_CA_PEM,
  TEST_LEAF_CERT_PEM,
  TEST_PAYPAL_ROOT_CA_PEM,
  TEST_PAYPAL_LEAF_CERT_PEM,
  TEST_PAYPAL_LEAF_PRIVATE_KEY_PEM,
  TEST_PAYPAL_NO_DIGITAL_SIG_CERT_PEM,
  TEST_PAYPAL_UNRELATED_LEAF_CERT_PEM,
} from "../fixtures/test-certificates";

describe("Phase 3: PayPalWebhookIngressWorker & Remediated Trust Boundary (DEF-WH-01, DEF-WH-02)", () => {
  let client: Client;
  const hmacKeyId = "audit_hmac_wh_p3";
  const workerPrincipal = "ingress_worker_user";
  const webhookId = "WH-2RU25474D0430030W";

  beforeAll(async () => {
    client = await createStage2Client();
    await ensureRolesExist(client);
    await createTestKeys(client, "vak_unused", hmacKeyId, workerPrincipal);
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("RESET SESSION AUTHORIZATION;");
  });

  function signPayPalWebhook(
    transmissionId: string,
    transmissionTime: string,
    rawPayload: Buffer,
    privateKeyPem: string = TEST_PAYPAL_LEAF_PRIVATE_KEY_PEM
  ): string {
    const msg = formatPayPalSignatureMessage({
      transmissionId,
      transmissionTime,
      webhookId,
      rawPayload,
    });
    const signer = crypto.createSign("sha256");
    signer.update(msg);
    return signer.sign(privateKeyPem, "base64");
  }

  function createValidPayload(orderId: string, captureId: string) {
    return {
      id: "WH-EVT-" + crypto.randomUUID(),
      event_version: "1.0",
      create_time: "2026-11-07T12:00:00Z",
      resource_type: "capture",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      summary: "Payment capture completed",
      resource: {
        id: captureId,
        amount: {
          value: "32.40",
          currency_code: "USD",
        },
        supplementary_data: {
          related_ids: {
            order_id: orderId,
          },
        },
        payee: {
          email_address: "merchant@example.com",
        },
      },
    };
  }

  // Track rejected transmission IDs to verify zero database rows created
  const rejectedTxIds: string[] = [];

  it("1. Missing certificate fails closed with ERR_NO_SIGNING_CERTIFICATE (DEF-WH-01, DEF-SEC-PK-01)", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_missing_cert_" + crypto.randomUUID();
    rejectedTxIds.push(txId);
    const txTime = "2026-11-07T12:00:00Z";
    const rawPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_1", "CAP_1")), "utf8");

    await expect(
      worker.processIncomingWebhook({
        headers: {
          transmissionId: txId,
          transmissionTime: txTime,
          certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          authAlgo: "SHA256withRSA",
          transmissionSig: "someSig",
        },
        rawPayload,
        webhookId,
        client,
        // No signingCertPem!
      })
    ).rejects.toThrow("ERR_NO_SIGNING_CERTIFICATE");
  });

  it("2. Invalid or malformed certificate fails closed with ERR_MALFORMED_CERTIFICATE (DEF-WH-02)", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_malformed_cert_" + crypto.randomUUID();
    rejectedTxIds.push(txId);
    const txTime = "2026-11-07T12:00:00Z";
    const rawPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_1", "CAP_1")), "utf8");

    await expect(
      worker.processIncomingWebhook({
        headers: {
          transmissionId: txId,
          transmissionTime: txTime,
          certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          authAlgo: "SHA256withRSA",
          transmissionSig: "someSig",
        },
        rawPayload,
        webhookId,
        client,
        signingCertPem: "-----BEGIN CERTIFICATE-----\nNOT_A_VALID_CERT_DATA\n-----END CERTIFICATE-----",
      })
    ).rejects.toThrow("ERR_MALFORMED_CERTIFICATE");
  });

  it("3. Expired certificate fails closed with ERR_CERTIFICATE_EXPIRED (DEF-WH-02)", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_expired_cert_" + crypto.randomUUID();
    rejectedTxIds.push(txId);
    const txTime = "2026-11-07T12:00:00Z";
    const rawPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_1", "CAP_1")), "utf8");
    const sigBase64 = signPayPalWebhook(txId, txTime, rawPayload);

    await expect(
      worker.processIncomingWebhook({
        headers: {
          transmissionId: txId,
          transmissionTime: txTime,
          certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          authAlgo: "SHA256withRSA",
          transmissionSig: sigBase64,
        },
        rawPayload,
        webhookId,
        client,
        signingCertPem: TEST_PAYPAL_LEAF_CERT_PEM,
        referenceTime: new Date("2035-01-01T00:00:00Z"), // Long past expiration
      })
    ).rejects.toThrow("ERR_CERTIFICATE_EXPIRED");
  });

  it("4. Untrusted root CA fails closed with ERR_UNTRUSTED_ROOT_CA (DEF-WH-02)", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_untrusted_ca_" + crypto.randomUUID();
    rejectedTxIds.push(txId);
    const txTime = "2026-11-07T12:00:00Z";
    const rawPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_1", "CAP_1")), "utf8");
    const sigBase64 = signPayPalWebhook(txId, txTime, rawPayload);

    await expect(
      worker.processIncomingWebhook({
        headers: {
          transmissionId: txId,
          transmissionTime: txTime,
          certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          authAlgo: "SHA256withRSA",
          transmissionSig: sigBase64,
        },
        rawPayload,
        webhookId,
        client,
        signingCertPem: TEST_PAYPAL_UNRELATED_LEAF_CERT_PEM, // Chained to UnrelatedRootCA
      })
    ).rejects.toThrow("ERR_UNTRUSTED_ROOT_CA");
  });

  it("5. Hostname/SAN mismatch fails closed with ERR_CERTIFICATE_DOMAIN_MISMATCH (DEF-WH-02)", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_ROOT_CA_PEM]);
    const txId = "tx_wh_san_mismatch_" + crypto.randomUUID();
    rejectedTxIds.push(txId);
    const txTime = "2026-11-07T12:00:00Z";
    const rawPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_1", "CAP_1")), "utf8");
    const sigBase64 = signPayPalWebhook(txId, txTime, rawPayload);

    await expect(
      worker.processIncomingWebhook({
        headers: {
          transmissionId: txId,
          transmissionTime: txTime,
          certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          authAlgo: "SHA256withRSA",
          transmissionSig: sigBase64,
        },
        rawPayload,
        webhookId,
        client,
        signingCertPem: TEST_LEAF_CERT_PEM, // CN=taxjar.test does not match api.sandbox.paypal.com
        requireDigitalSignatureUsage: false,
      })
    ).rejects.toThrow("ERR_CERTIFICATE_DOMAIN_MISMATCH");
  });

  it("6. Invalid key usage fails closed with ERR_INVALID_KEY_USAGE (DEF-WH-02)", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_bad_key_usage_" + crypto.randomUUID();
    rejectedTxIds.push(txId);
    const txTime = "2026-11-07T12:00:00Z";
    const rawPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_1", "CAP_1")), "utf8");
    const sigBase64 = signPayPalWebhook(txId, txTime, rawPayload);

    await expect(
      worker.processIncomingWebhook({
        headers: {
          transmissionId: txId,
          transmissionTime: txTime,
          certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          authAlgo: "SHA256withRSA",
          transmissionSig: sigBase64,
        },
        rawPayload,
        webhookId,
        client,
        signingCertPem: TEST_PAYPAL_NO_DIGITAL_SIG_CERT_PEM, // Missing digitalSignature
        requireDigitalSignatureUsage: true,
      })
    ).rejects.toThrow("ERR_INVALID_KEY_USAGE");
  });

  it("7. Forged signature fails closed with ERR_INVALID_WEBHOOK_SIGNATURE (DEF-WH-01)", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_forged_sig_" + crypto.randomUUID();
    rejectedTxIds.push(txId);
    const txTime = "2026-11-07T12:00:00Z";
    const rawPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_1", "CAP_1")), "utf8");
    const forgedSig = Buffer.alloc(256, 0x55).toString("base64");

    await expect(
      worker.processIncomingWebhook({
        headers: {
          transmissionId: txId,
          transmissionTime: txTime,
          certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          authAlgo: "SHA256withRSA",
          transmissionSig: forgedSig,
        },
        rawPayload,
        webhookId,
        client,
        signingCertPem: TEST_PAYPAL_LEAF_CERT_PEM,
      })
    ).rejects.toThrow("ERR_INVALID_WEBHOOK_SIGNATURE");
  });

  it("8. Altered webhook payload fails closed with ERR_INVALID_WEBHOOK_SIGNATURE (DEF-WH-01)", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_altered_payload_" + crypto.randomUUID();
    rejectedTxIds.push(txId);
    const txTime = "2026-11-07T12:00:00Z";

    const originalPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_ORIG", "CAP_ORIG")), "utf8");
    const sigBase64 = signPayPalWebhook(txId, txTime, originalPayload);
    const tamperedPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_TAMPERED", "CAP_TAMPERED")), "utf8");

    await expect(
      worker.processIncomingWebhook({
        headers: {
          transmissionId: txId,
          transmissionTime: txTime,
          certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          authAlgo: "SHA256withRSA",
          transmissionSig: sigBase64,
        },
        rawPayload: tamperedPayload,
        webhookId,
        client,
        signingCertPem: TEST_PAYPAL_LEAF_CERT_PEM,
      })
    ).rejects.toThrow("ERR_INVALID_WEBHOOK_SIGNATURE");
  });

  it("9. Valid PayPal certificate and signature succeeds, records and finalizes transmission", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_valid_" + crypto.randomUUID();
    const txTime = "2026-11-07T12:00:00Z";
    const orderId = "ORD_VALID_" + crypto.randomUUID();
    const captureId = "CAP_VALID_" + crypto.randomUUID();

    const payloadObj = createValidPayload(orderId, captureId);
    const rawPayload = Buffer.from(JSON.stringify(payloadObj), "utf8");
    const sigBase64 = signPayPalWebhook(txId, txTime, rawPayload);

    await client.query(`SET SESSION AUTHORIZATION ${workerPrincipal};`);

    const result = await worker.processIncomingWebhook({
      headers: {
        transmissionId: txId,
        transmissionTime: txTime,
        certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
        authAlgo: "SHA256withRSA",
        transmissionSig: sigBase64,
      },
      rawPayload,
      webhookId,
      client,
      signingCertPem: TEST_PAYPAL_LEAF_CERT_PEM,
    });

    expect(result.transmissionId).toBe(txId);
    expect(result.status).toBe("RECORDED");
    expect(result.eventType).toBe("PAYMENT.CAPTURE.COMPLETED");
    expect(result.orderId).toBe(orderId);
    expect(result.captureId).toBe(captureId);
    expect(result.amountCents).toBe(3240);
    expect(result.currency).toBe("USD");
    expect(result.payeeEmail).toBe("merchant@example.com");
    expect(result.crc32).toBe(computePayPalCrc32(rawPayload));
    expect(result.finalized).toBe(true);

    // Verify row directly in PostgreSQL WebhookTransmission
    await client.query("RESET SESSION AUTHORIZATION;");
    const dbCheck = await client.query(
      `SELECT status, response_code, authenticated_order_id, authenticated_capture_id
       FROM public."WebhookTransmission"
       WHERE transmission_id = $1`,
      [txId]
    );

    expect(dbCheck.rows.length).toBe(1);
    expect(dbCheck.rows[0].status).toBe("PROCESSED");
    expect(dbCheck.rows[0].response_code).toBe(200);
    expect(dbCheck.rows[0].authenticated_order_id).toBe(orderId);
    expect(dbCheck.rows[0].authenticated_capture_id).toBe(captureId);
  });

  it("10. Confirms rejected webhooks create no database records or state transitions", async () => {
    expect(rejectedTxIds.length).toBe(8);

    await client.query("RESET SESSION AUTHORIZATION;");
    const dbCheck = await client.query(
      `SELECT transmission_id FROM public."WebhookTransmission" WHERE transmission_id = ANY($1::varchar[])`,
      [rejectedTxIds]
    );

    expect(dbCheck.rows.length).toBe(0);
  });

  it("11. Verifies WebhookTransmission immutability trigger blocks UPDATE and DELETE with SQLSTATE 42501", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_immut_" + crypto.randomUUID();
    const txTime = "2026-11-07T12:00:00Z";

    const payloadObj = createValidPayload("ORD_IMMUT_1", "CAP_IMMUT_1");
    const rawPayload = Buffer.from(JSON.stringify(payloadObj), "utf8");
    const sigBase64 = signPayPalWebhook(txId, txTime, rawPayload);

    await client.query(`SET SESSION AUTHORIZATION ${workerPrincipal};`);

    await worker.processIncomingWebhook({
      headers: {
        transmissionId: txId,
        transmissionTime: txTime,
        certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
        authAlgo: "SHA256withRSA",
        transmissionSig: sigBase64,
      },
      rawPayload,
      webhookId,
      client,
      signingCertPem: TEST_PAYPAL_LEAF_CERT_PEM,
    });

    await client.query("RESET SESSION AUTHORIZATION;");

    // Attempt direct UPDATE on logged transmission
    let updateErr: any;
    try {
      await client.query(
        `UPDATE public."WebhookTransmission" SET authenticated_currency = 'EUR' WHERE transmission_id = $1`,
        [txId]
      );
    } catch (e) {
      updateErr = e;
    }

    expect(updateErr).toBeDefined();
    expect(updateErr.code).toBe("42501");
    expect(updateErr.message).toContain("ERR_IMMUTABLE_RECORD");

    // Attempt direct DELETE on logged transmission
    let deleteErr: any;
    try {
      await client.query(
        `DELETE FROM public."WebhookTransmission" WHERE transmission_id = $1`,
        [txId]
      );
    } catch (e) {
      deleteErr = e;
    }

    expect(deleteErr).toBeDefined();
    expect(deleteErr.code).toBe("42501");
    expect(deleteErr.message).toContain("ERR_IMMUTABLE_RECORD");
  });

  it("12. Fails closed when PayPal certUrl does not match authorized PayPal domains", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_bad_url_" + crypto.randomUUID();
    const txTime = "2026-11-07T12:00:00Z";
    const rawPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_1", "CAP_1")), "utf8");

    await expect(
      worker.processIncomingWebhook({
        headers: {
          transmissionId: txId,
          transmissionTime: txTime,
          certUrl: "https://evil-attacker.com/fake-cert.pem", // Malicious domain
          authAlgo: "SHA256withRSA",
          transmissionSig: "fakeSig",
        },
        rawPayload,
        webhookId,
        client,
        signingCertPem: TEST_PAYPAL_LEAF_CERT_PEM,
      })
    ).rejects.toThrow("ERR_UNTRUSTED_CERT_URL");
  });

  it("13. Rejects unauthorized caller role (orchestrator_worker_user) executing R2-03 with SQLSTATE 42501", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_unauth_" + crypto.randomUUID();
    const txTime = "2026-11-07T12:00:00Z";
    const rawPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_1", "CAP_1")), "utf8");
    const sigBase64 = signPayPalWebhook(txId, txTime, rawPayload);

    await client.query("SET SESSION AUTHORIZATION orchestrator_worker_user;");

    let err: any;
    try {
      await worker.processIncomingWebhook({
        headers: {
          transmissionId: txId,
          transmissionTime: txTime,
          certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          authAlgo: "SHA256withRSA",
          transmissionSig: sigBase64,
        },
        rawPayload,
        webhookId,
        client,
        signingCertPem: TEST_PAYPAL_LEAF_CERT_PEM,
      });
    } catch (e) {
      err = e;
    } finally {
      await client.query("RESET SESSION AUTHORIZATION;");
    }

    expect(err).toBeDefined();
    expect(err.code).toBe("42501");
  });

  it("14. Adversarial: Attacker supplying raw SPKI public key without X.509 certificate fails closed with ERR_NO_SIGNING_CERTIFICATE (DEF-SEC-PK-01)", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_raw_pk_" + crypto.randomUUID();
    const txTime = "2026-11-07T12:00:00Z";
    const rawPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_PK_ATTACK", "CAP_PK_ATTACK")), "utf8");

    // Attacker generates own RSA keypair and signs webhook payload
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const attackerPubKeyDer = publicKey.export({ type: "spki", format: "der" });
    const attackerSig = signPayPalWebhook(txId, txTime, rawPayload, privateKey.export({ type: "pkcs8", format: "pem" }).toString());

    // Attacker attempts to pass raw public key override
    await expect(
      worker.processIncomingWebhook({
        headers: {
          transmissionId: txId,
          transmissionTime: txTime,
          certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          authAlgo: "SHA256withRSA",
          transmissionSig: attackerSig,
        },
        rawPayload,
        webhookId,
        client,
        // Attacker attempts to inject unauthenticated raw public key
        ...({ signingPublicKeyDer: attackerPubKeyDer } as any),
      })
    ).rejects.toThrow("ERR_NO_SIGNING_CERTIFICATE");

    // Assert zero database rows created
    await client.query("RESET SESSION AUTHORIZATION;");
    const dbCheck = await client.query(
      `SELECT transmission_id FROM public."WebhookTransmission" WHERE transmission_id = $1`,
      [txId]
    );
    expect(dbCheck.rows.length).toBe(0);
  });

  it("15. Adversarial: Attacker supplying raw public key PEM in signingCertPem fails closed with ERR_MALFORMED_CERTIFICATE (DEF-SEC-PK-01)", async () => {
    const worker = new PayPalWebhookIngressWorker(hmacKeyId, [TEST_PAYPAL_ROOT_CA_PEM]);
    const txId = "tx_wh_pk_pem_" + crypto.randomUUID();
    const txTime = "2026-11-07T12:00:00Z";
    const rawPayload = Buffer.from(JSON.stringify(createValidPayload("ORD_PK_PEM", "CAP_PK_PEM")), "utf8");

    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const attackerPubKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const attackerSig = signPayPalWebhook(txId, txTime, rawPayload, privateKey.export({ type: "pkcs8", format: "pem" }).toString());

    // Attacker attempts to pass raw public key PEM instead of valid X.509 certificate
    await expect(
      worker.processIncomingWebhook({
        headers: {
          transmissionId: txId,
          transmissionTime: txTime,
          certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          authAlgo: "SHA256withRSA",
          transmissionSig: attackerSig,
        },
        rawPayload,
        webhookId,
        client,
        signingCertPem: attackerPubKeyPem, // Raw public key PEM is not an X.509 certificate
      })
    ).rejects.toThrow("ERR_MALFORMED_CERTIFICATE");

    // Assert zero database rows created
    await client.query("RESET SESSION AUTHORIZATION;");
    const dbCheck = await client.query(
      `SELECT transmission_id FROM public."WebhookTransmission" WHERE transmission_id = $1`,
      [txId]
    );
    expect(dbCheck.rows.length).toBe(0);
  });
});
