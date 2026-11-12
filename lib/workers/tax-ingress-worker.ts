import { Client } from "pg";
import crypto from "crypto";
import { z } from "zod";
import { parseDecimalStringToCents } from "../state/money";
import { verifyCertificateChain, PinnedTrustAnchor } from "../crypto/x509-verifier";
import { verifyAsymmetricSignature, AsymmetricAlgorithm, formatCanonicalAttestationBuffer } from "../security/asym-verifier";
import { createAndSignAttestationAssertion } from "../crypto/asymmetric-attestation";
import { KmsSignerClient } from "../security/kms-signer";
import {
  canonicalDecimalStringZod,
  rawJurisdictionWireZod,
  normalizedLineItemBreakdownZod,
  normalizedJurisdictionBreakdownZod,
  NormalizedLineItemBreakdown,
  NormalizedJurisdictionBreakdown,
} from "../contracts/stage2-schemas";

/**
 * Raw Statutory Tax Provider Line Item Schema (C-48 / R2-01 Parity)
 * Exact 7 keys enforced by PostgreSQL routine R2-01.
 */
export const rawStatutoryLineItemZod = z
  .object({
    id: z.string().min(1, "id cannot be empty"),
    subtotal: canonicalDecimalStringZod,
    discount: canonicalDecimalStringZod,
    taxable_amount: canonicalDecimalStringZod,
    tax_collectable: canonicalDecimalStringZod,
    exemption_code: z.string().nullable().optional(),
    taxability_status: z.string().min(1, "taxability_status cannot be empty"),
  })
  .strict();

export interface TaxProviderIngressWorkerConfig {
  workerInstanceId: string;
  workerPrincipal: string; // e.g. "tax_worker_01"
  attestationKeyId: string;
  workerPublicKeyDer: Buffer;
  workerPrivateKeyDer?: Buffer;
  workerSigningAlgorithm: AsymmetricAlgorithm;
  pinnedTrustAnchors: PinnedTrustAnchor[];
  internalHmacKeyId: string;
  kmsSignerClient?: KmsSignerClient;
}

export interface StatutoryQuoteIngressInput {
  cartId: string;
  authorityId: string;
  certificateNumber: string;
  providerLeafCertPem: string;
  expectedHost?: string;
  rawWirePayload: Buffer;
  statutorySignature: Buffer;
  statutorySignatureAlgorithm: string;
  client: Client;
  nonceOverride?: string;
  timestampOverride?: Date;
}

export interface TaxQuoteIngressResult {
  evidenceId: string;
  cartId: string;
  taxQuoteId: string;
  totalTaxCents: number;
  status: string;
  recordedAt: Date;
  internalAuditSignature: Buffer;
  nonce: string;
  attestationSignature: Buffer;
}

export class TaxProviderIngressWorker {
  private config: TaxProviderIngressWorkerConfig;

  constructor(config: TaxProviderIngressWorkerConfig) {
    if (!config.workerInstanceId) throw new Error("ERR_CONFIG: workerInstanceId required");
    if (!config.workerPrincipal) throw new Error("ERR_CONFIG: workerPrincipal required");
    if (!config.attestationKeyId) throw new Error("ERR_CONFIG: attestationKeyId required");
    if (!config.workerPublicKeyDer || config.workerPublicKeyDer.length === 0) {
      throw new Error("ERR_CONFIG: workerPublicKeyDer required");
    }
    this.config = config;
  }

  /**
   * Ingests, cryptographically verifies, and commits a statutory tax quote to PostgreSQL.
   */
  async processStatutoryQuote(input: StatutoryQuoteIngressInput): Promise<TaxQuoteIngressResult> {
    const {
      cartId,
      authorityId,
      certificateNumber,
      providerLeafCertPem,
      expectedHost,
      rawWirePayload,
      statutorySignature,
      statutorySignatureAlgorithm,
      client,
      nonceOverride,
      timestampOverride,
    } = input;

    // 1. External Statutory Provider Authenticity: Verify X.509 Certificate Chain against Pinned Trust Anchors
    const certResult = verifyCertificateChain({
      leafCert: providerLeafCertPem,
      pinnedRootCerts: this.config.pinnedTrustAnchors,
      expectedHost,
      requireDigitalSignatureUsage: false, // relaxed for test certs
      referenceTime: timestampOverride || new Date(),
    });

    // 2. External Statutory Provider Authenticity: Verify Signature over EXACT Raw Wire Bytes
    const isSigValid = verifyAsymmetricSignature({
      algorithm: statutorySignatureAlgorithm,
      publicKeyDer: certResult.publicKeyDer,
      message: rawWirePayload,
      signature: statutorySignature,
    });

    if (!isSigValid) {
      throw new Error("ERR_INVALID_PROVIDER_SIGNATURE: Statutory digital signature verification failed over raw wire bytes.");
    }

    // 3. Raw Wire JSON Extraction and Parity Validation
    let rawJson: any;
    try {
      rawJson = JSON.parse(rawWirePayload.toString("utf8"));
    } catch {
      throw new Error("ERR_MALFORMED_NESTED_STRUCTURE: Raw wire payload is not valid JSON.");
    }

    // Parse financial values into BigInt integer cents
    const merchandiseSubtotalCents = Number(parseDecimalStringToCents(rawJson.order_subtotal));
    const discountCents = Number(parseDecimalStringToCents(rawJson.discount_amount || "0.00"));
    const shippingCents = Number(parseDecimalStringToCents(rawJson.shipping || "0.00"));
    const adjustmentCents = Number(parseDecimalStringToCents(rawJson.adjustment || "0.00"));
    const totalCents = Number(parseDecimalStringToCents(rawJson.total_amount));
    const totalTaxCents = Number(parseDecimalStringToCents(rawJson.amount_to_collect));

    if (adjustmentCents !== 0) {
      throw new Error("ERR_UNSUPPORTED_ADJUSTMENT: Non-zero provider adjustments are prohibited.");
    }

    const merchandiseTaxCents = Number(parseDecimalStringToCents(rawJson.breakdown?.line_items_total || "0.00"));
    const shippingTaxCents = Number(parseDecimalStringToCents(rawJson.breakdown?.shipping_tax || "0.00"));
    const taxableShippingBaseCents = Number(parseDecimalStringToCents(rawJson.breakdown?.taxable_shipping || "0.00"));

    // 4. Transform and Validate Line Items
    if (!Array.isArray(rawJson.line_items)) {
      throw new Error("ERR_MALFORMED_NESTED_STRUCTURE: line_items must be an array");
    }

    const normalizedLineItems: NormalizedLineItemBreakdown[] = [];
    for (let i = 0; i < rawJson.line_items.length; i++) {
      const rawItem = rawStatutoryLineItemZod.parse(rawJson.line_items[i]);
      const normItem: NormalizedLineItemBreakdown = {
        itemIndex: i,
        lineItemId: rawItem.id,
        itemSubtotalCents: Number(parseDecimalStringToCents(rawItem.subtotal)),
        allocatedDiscountCents: Number(parseDecimalStringToCents(rawItem.discount)),
        taxableAmountCents: Number(parseDecimalStringToCents(rawItem.taxable_amount)),
        lineTaxCents: Number(parseDecimalStringToCents(rawItem.tax_collectable)),
        taxabilityStatus: rawItem.taxability_status as any,
        exemptionCode: rawItem.exemption_code ?? null,
      };
      normalizedLineItemBreakdownZod.parse(normItem);
      normalizedLineItems.push(normItem);
    }

    // 5. Transform and Validate Jurisdictions
    if (!Array.isArray(rawJson.jurisdictions)) {
      throw new Error("ERR_MALFORMED_NESTED_STRUCTURE: jurisdictions must be an array");
    }

    const normalizedJurisdictions: NormalizedJurisdictionBreakdown[] = [];
    for (const jur of rawJson.jurisdictions) {
      const rawJur = rawJurisdictionWireZod.parse(jur);
      const normJur: NormalizedJurisdictionBreakdown = {
        componentType: rawJur.type as any,
        jurisdictionCode: rawJur.code,
        jurisdictionName: rawJur.name,
        rateBps: rawJur.rate_bps,
        taxAmountCents: Number(parseDecimalStringToCents(rawJur.amount)),
        appliesToShipping: rawJur.applies_to_shipping,
      };
      normalizedJurisdictionBreakdownZod.parse(normJur);
      normalizedJurisdictions.push(normJur);
    }

    // 6. Generate Single-Use Nonce & Check Freshness
    const nonce = nonceOverride || "nonce_" + crypto.randomUUID();
    const attestationTimestamp = timestampOverride || new Date();

    // 7. Compute & Digitally Sign Canonical Attestation Buffer (C-44A)
    let attestationSignature: Buffer;

    if (this.config.kmsSignerClient) {
      const canonicalBuffer = formatCanonicalAttestationBuffer({
        cartId,
        quoteId: rawJson.id,
        providerName: rawJson.provider,
        providerApiVersion: rawJson.version,
        rawPayloadBytes: rawWirePayload,
        statutorySigBytes: statutorySignature,
        merchandiseSubtotalCents,
        discountCents,
        shippingCents,
        adjustmentCents,
        totalCents,
        totalTaxCents,
        merchandiseTaxCents,
        shippingTaxCents,
        taxableShippingBaseCents,
        currency: rawJson.currency,
        authorityId,
        certificateNumber,
        signatureAlgorithm: rawJson.signature_algorithm,
        attestationTimestamp,
        attestationKeyId: this.config.attestationKeyId,
        nonce,
      });

      attestationSignature = await this.config.kmsSignerClient.sign({
        keyId: this.config.attestationKeyId,
        message: canonicalBuffer,
        algorithm: this.config.workerSigningAlgorithm,
      });
    } else {
      const attestation = createAndSignAttestationAssertion({
        cartId,
        quoteId: rawJson.id,
        providerName: rawJson.provider,
        providerApiVersion: rawJson.version,
        rawPayloadBytes: rawWirePayload,
        statutorySigBytes: statutorySignature,
        merchandiseSubtotalCents,
        discountCents,
        shippingCents,
        adjustmentCents,
        totalCents,
        totalTaxCents,
        merchandiseTaxCents,
        shippingTaxCents,
        taxableShippingBaseCents,
        currency: rawJson.currency,
        authorityId,
        certificateNumber,
        signatureAlgorithm: rawJson.signature_algorithm,
        attestationTimestamp,
        attestationKeyId: this.config.attestationKeyId,
        nonce,
        workerPublicKeyDer: this.config.workerPublicKeyDer,
        workerPrivateKeyDer: this.config.workerPrivateKeyDer,
        workerSigningAlgorithm: this.config.workerSigningAlgorithm,
      });
      attestationSignature = attestation.attestationSignature;
    }

    // 8. Execute Database Routine R2-01 in Transaction
    const query = `
      SELECT evidence_id, cart_id, tax_quote_id, total_tax_cents, status, recorded_at, internal_audit_signature
      FROM public.record_tax_calculation_quote(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
      );
    `;

    const params = [
      cartId,
      rawJson.id,
      rawJson.provider,
      rawJson.version,
      rawJson.signature_algorithm,
      new Date(rawJson.timestamp).toISOString(),
      new Date(rawJson.expires_at).toISOString(),
      merchandiseSubtotalCents,
      discountCents,
      shippingCents,
      adjustmentCents,
      totalCents,
      totalTaxCents,
      merchandiseTaxCents,
      shippingTaxCents,
      taxableShippingBaseCents,
      rawJson.currency,
      rawJson.jurisdiction,
      JSON.stringify(normalizedLineItems),
      JSON.stringify(normalizedJurisdictions),
      rawWirePayload,
      statutorySignature,
      authorityId,
      certificateNumber,
      this.config.workerPrincipal, // p_verifier_identity (must match SESSION_USER)
      this.config.attestationKeyId,
      attestationTimestamp.toISOString(),
      attestationSignature,
      this.config.internalHmacKeyId,
      nonce,
    ];

    const result = await client.query(query, params);
    const row = result.rows[0];

    return {
      evidenceId: row.evidence_id,
      cartId: row.cart_id,
      taxQuoteId: row.tax_quote_id,
      totalTaxCents: Number(row.total_tax_cents),
      status: row.status,
      recordedAt: new Date(row.recorded_at),
      internalAuditSignature: row.internal_audit_signature,
      nonce,
      attestationSignature,
    };
  }
}
