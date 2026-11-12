import { Client } from "pg";
import crypto from "crypto";
import { computePayPalCrc32, formatPayPalSignatureMessage } from "../crypto/paypal-crc32";
import { parseDecimalStringToCents } from "../state/money";
import { verifyCertificateChain, PinnedTrustAnchor } from "../crypto/x509-verifier";

export interface PayPalWebhookHeaders {
  transmissionId: string;
  transmissionTime: string;
  certUrl: string;
  authAlgo: string;
  transmissionSig: string;
}

export interface WebhookIngressInput {
  headers: PayPalWebhookHeaders;
  rawPayload: Buffer;
  webhookId: string;
  client: Client;
  signingCertPem?: string; // Direct PEM override for tests / offline verification
  intermediateCerts?: (string | Buffer)[];
  pinnedTrustAnchors?: (string | Buffer | PinnedTrustAnchor)[];
  nonceOverride?: string;
  referenceTime?: Date;
  requireDigitalSignatureUsage?: boolean;
}

export interface WebhookIngressResult {
  transmissionId: string;
  status: string;
  eventType: string;
  orderId: string | null;
  captureId: string | null;
  refundId: string | null;
  amountCents: number;
  currency: string;
  payeeEmail: string | null;
  rawPayloadHash: string;
  crc32: number;
  loggedAt: Date;
  finalized: boolean;
}

const TRUSTED_PAYPAL_CERT_URL_REGEX = /^https:\/\/api(\.sandbox)?\.paypal\.com\/.+/;

export class PayPalWebhookIngressWorker {
  private internalHmacKeyId: string;
  private pinnedTrustAnchors: (string | Buffer | PinnedTrustAnchor)[];

  constructor(
    internalHmacKeyId: string = "audit_hmac_key_2026",
    pinnedTrustAnchors: (string | Buffer | PinnedTrustAnchor)[] = []
  ) {
    this.internalHmacKeyId = internalHmacKeyId;
    this.pinnedTrustAnchors = pinnedTrustAnchors;
  }

  /**
   * Verifies the PayPal certificate URL matches authorized PayPal infrastructure.
   */
  validateCertUrl(certUrl: string): boolean {
    if (!certUrl || typeof certUrl !== "string") return false;
    return TRUSTED_PAYPAL_CERT_URL_REGEX.test(certUrl);
  }

  /**
   * Processes, cryptographically verifies, and immutably logs an incoming PayPal webhook.
   */
  async processIncomingWebhook(input: WebhookIngressInput): Promise<WebhookIngressResult> {
    const { headers, rawPayload, webhookId, client, signingCertPem, nonceOverride } = input;
    const { transmissionId, transmissionTime, certUrl, authAlgo, transmissionSig } = headers;

    // 1. Validate required headers
    if (!transmissionId) throw new Error("ERR_INVALID_HEADER: PAYPAL-TRANSMISSION-ID is required");
    if (!transmissionTime) throw new Error("ERR_INVALID_HEADER: PAYPAL-TRANSMISSION-TIME is required");
    if (!certUrl) throw new Error("ERR_INVALID_HEADER: PAYPAL-CERT-URL is required");
    if (!authAlgo) throw new Error("ERR_INVALID_HEADER: PAYPAL-AUTH-ALGO is required");
    if (!transmissionSig) throw new Error("ERR_INVALID_HEADER: PAYPAL-TRANSMISSION-SIG is required");
    if (!rawPayload || rawPayload.length === 0) throw new Error("ERR_INVALID_PAYLOAD: Raw payload cannot be empty");

    // 2. Validate PayPal Cert URL domain
    if (!this.validateCertUrl(certUrl)) {
      throw new Error(`ERR_UNTRUSTED_CERT_URL: Certificate URL "${certUrl}" does not match trusted PayPal domains.`);
    }

    // 3. Compute IEEE 802.3 CRC32 over exact wire payload
    const crc32Val = computePayPalCrc32(rawPayload);

    // 4. Assemble canonical PayPal signature message
    const signatureMessage = formatPayPalSignatureMessage({
      transmissionId,
      transmissionTime,
      webhookId,
      rawPayload,
    });

    // 5. Enforce Certificate Presence and Validate Certificate Chain (DEF-WH-01, DEF-WH-02, DEF-SEC-PK-01)
    if (!signingCertPem) {
      throw new Error("ERR_NO_SIGNING_CERTIFICATE: Webhook request lacks a signing certificate.");
    }

    let expectedHost: string | undefined;
    try {
      const parsedUrl = new URL(certUrl);
      expectedHost = parsedUrl.hostname;
    } catch {
      throw new Error(`ERR_INVALID_HEADER: Invalid certUrl "${certUrl}"`);
    }

    const activeRoots = (input.pinnedTrustAnchors && input.pinnedTrustAnchors.length > 0)
      ? input.pinnedTrustAnchors
      : this.pinnedTrustAnchors;

    if (activeRoots.length === 0) {
      throw new Error("ERR_NO_TRUST_ANCHORS: No pinned PayPal root trust anchors configured.");
    }

    const certResult = verifyCertificateChain({
      leafCert: signingCertPem,
      intermediateCerts: input.intermediateCerts || [],
      pinnedRootCerts: activeRoots,
      expectedHost,
      requireDigitalSignatureUsage: input.requireDigitalSignatureUsage ?? true,
      referenceTime: input.referenceTime || new Date(),
    });

    const keyForVerify = certResult.publicKeyObject;

    // Mandatory Asymmetric Signature Verification (SHA256withRSA)
    const verifier = crypto.createVerify("sha256");
    verifier.update(signatureMessage);
    const isSigValid = verifier.verify(keyForVerify, Buffer.from(transmissionSig, "base64"));
    if (!isSigValid) {
      throw new Error("ERR_INVALID_WEBHOOK_SIGNATURE: PayPal asymmetric signature verification failed.");
    }

    // 6. Parse Wire Payload JSON and extract authenticated claims
    let parsedJson: any;
    try {
      parsedJson = JSON.parse(rawPayload.toString("utf8"));
    } catch {
      throw new Error("ERR_MALFORMED_NESTED_STRUCTURE: Webhook payload is not valid JSON.");
    }

    const eventType = parsedJson.event_type;
    if (!eventType) {
      throw new Error("ERR_MISSING_PAYLOAD_FIELD: event_type is required in PayPal webhook payload.");
    }

    const resource = parsedJson.resource || {};
    let orderId: string | null = null;
    let captureId: string | null = null;
    let refundId: string | null = null;

    if (eventType.startsWith("PAYMENT.CAPTURE")) {
      captureId = resource.id || null;
      orderId = resource.supplementary_data?.related_ids?.order_id || null;
    } else if (eventType.startsWith("PAYMENT.REFUND")) {
      refundId = resource.id || null;
      captureId = resource.supplementary_data?.related_ids?.capture_id || null;
    } else if (eventType.startsWith("CHECKOUT.ORDER")) {
      orderId = resource.id || null;
    }

    const rawAmount = resource.amount?.value || "0.00";
    const amountCents = Number(parseDecimalStringToCents(rawAmount));
    const currency = resource.amount?.currency_code || "USD";
    const payeeEmail = resource.payee?.email_address || null;

    const nonce = nonceOverride || "nonce_wh_" + crypto.randomUUID();

    // 7. Invoke R2-03: record_webhook_transmission_ingress
    const ingressRes = await client.query(`
      SELECT transmission_id, status, created_at
      FROM public.record_webhook_transmission_ingress(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      );
    `, [
      transmissionId,
      eventType,
      orderId,
      captureId,
      refundId,
      amountCents,
      currency,
      payeeEmail,
      rawPayload,
      this.internalHmacKeyId,
      nonce,
    ]);

    const row = ingressRes.rows[0];

    // 8. Invoke R2-04: finalize_transmission_response
    const finalizeRes = await client.query(`
      SELECT transmission_id, status
      FROM public.finalize_transmission_response(
        $1, $2, $3
      );
    `, [
      transmissionId,
      "PROCESSED",
      200,
    ]);

    const isFinalized = finalizeRes.rows.length > 0 && finalizeRes.rows[0].status === "PROCESSED";

    return {
      transmissionId: row.transmission_id,
      status: row.status,
      eventType,
      orderId,
      captureId,
      refundId,
      amountCents,
      currency,
      payeeEmail,
      rawPayloadHash: crypto.createHash("sha256").update(rawPayload).digest("hex"),
      crc32: crc32Val,
      loggedAt: new Date(row.created_at),
      finalized: isFinalized,
    };
  }
}
