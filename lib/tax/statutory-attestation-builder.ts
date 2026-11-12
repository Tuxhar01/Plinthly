/**
 * Plinthly Stage 3 Phase 2 — Statutory Tax Attestation Builder (C-44A / KMS Integration)
 *
 * Implements Stage 3 Architecture Contract v3.0.0 Section 1.2 (INV-304), 2.3, 3.3.
 *
 * Enforces:
 * 1. Assembly of canonical pipe-delimited C-44A buffer (PLINTHLY-ATTESTATION-V1).
 * 2. Asymmetric digital signing strictly delegated to KmsSignerClient (Cloud KMS / HSM).
 * 3. Zero private key exposure to application heap memory in production.
 * 4. Exact mathematical and cryptographic parity with PostgreSQL routine R2-01.
 */

import crypto from "crypto";
import {
  formatCanonicalAttestationBuffer,
  CanonicalAttestationParams,
  AsymmetricAlgorithm,
} from "../security/asym-verifier";
import { KmsSignerClient, KmsAlgorithm } from "../security/kms-signer";
import { TaxCalculationResult } from "./tax-provider-adapter";

export interface BuildStatutoryAttestationInput {
  readonly result: TaxCalculationResult;
  readonly authorityId: string;
  readonly certificateNumber: string;
  readonly attestationKeyId: string;
  readonly kmsSignerClient: KmsSignerClient;
  readonly signingAlgorithm?: KmsAlgorithm;
  readonly merchandiseSubtotalCents: number;
  readonly discountCents?: number;
  readonly shippingCents: number;
  readonly adjustmentCents?: number;
  readonly totalCents: number;
  readonly currency?: string;
  readonly nonce?: string;
  readonly attestationTimestamp?: Date;
}

export interface StatutoryAttestationPackage {
  readonly canonicalBuffer: Buffer;
  readonly canonicalString: string;
  readonly attestationSignature: Buffer;
  readonly attestationTimestamp: Date;
  readonly nonce: string;
  readonly payloadHash: Buffer;
  readonly statSigHash: Buffer;
  readonly authorityId: string;
  readonly certificateNumber: string;
  readonly attestationKeyId: string;
  readonly signingAlgorithm: KmsAlgorithm;
}

export class StatutoryAttestationBuilder {
  /**
   * Assembles the C-44A canonical attestation buffer from tax quote results
   * and delegates digital signature production to the Cloud KMS / HSM client.
   */
  static async buildAndSignAttestation(
    input: BuildStatutoryAttestationInput
  ): Promise<StatutoryAttestationPackage> {
    const {
      result,
      authorityId,
      certificateNumber,
      attestationKeyId,
      kmsSignerClient,
      signingAlgorithm = "ECDSA-P256-SHA256",
      merchandiseSubtotalCents,
      discountCents = 0,
      shippingCents,
      adjustmentCents = 0,
      totalCents,
      currency = "USD",
      nonce = `nonce_${crypto.randomUUID()}`,
      attestationTimestamp = new Date(),
    } = input;

    if (!result) throw new Error("ERR_INVALID_PARAM: result is required");
    if (!authorityId) throw new Error("ERR_INVALID_PARAM: authorityId is required");
    if (!certificateNumber) throw new Error("ERR_INVALID_PARAM: certificateNumber is required");
    if (!attestationKeyId) throw new Error("ERR_INVALID_PARAM: attestationKeyId is required");
    if (!kmsSignerClient) throw new Error("ERR_INVALID_PARAM: kmsSignerClient is required");

    // 1. Calculate SHA-256 hashes of raw wire payload and provider signature
    const payloadHash = crypto.createHash("sha256").update(result.rawWirePayload).digest();
    const statSigHash = crypto.createHash("sha256").update(result.statutorySignature).digest();

    // 2. Assemble canonical C-44A parameter structure
    const canonicalParams: CanonicalAttestationParams = {
      cartId: result.cartId,
      quoteId: result.quoteId,
      providerName: result.provider,
      providerApiVersion: result.version,
      rawPayloadBytes: result.rawWirePayload,
      statutorySigBytes: result.statutorySignature,
      merchandiseSubtotalCents,
      discountCents,
      shippingCents,
      adjustmentCents,
      totalCents,
      totalTaxCents: result.totalTaxCents,
      merchandiseTaxCents: result.merchandiseTaxCents,
      shippingTaxCents: result.shippingTaxCents,
      taxableShippingBaseCents: result.shippingTaxCents > 0 ? shippingCents : 0,
      currency,
      authorityId,
      certificateNumber,
      signatureAlgorithm: result.statutorySignatureAlgorithm,
      attestationTimestamp,
      attestationKeyId,
      nonce,
    };

    // 3. Reconstruct exact canonical pipe-delimited buffer
    const canonicalBuffer = formatCanonicalAttestationBuffer(canonicalParams);
    const canonicalString = canonicalBuffer.toString("utf8");

    // 4. Delegate signing to Cloud KMS / HSM (Zero local private key fallback in production)
    const attestationSignature = await kmsSignerClient.sign({
      keyId: attestationKeyId,
      message: canonicalBuffer,
      algorithm: signingAlgorithm,
    });

    return {
      canonicalBuffer,
      canonicalString,
      attestationSignature,
      attestationTimestamp,
      nonce,
      payloadHash,
      statSigHash,
      authorityId,
      certificateNumber,
      attestationKeyId,
      signingAlgorithm,
    };
  }
}

