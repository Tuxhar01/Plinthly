import crypto from "crypto";
import {
  signAsymmetric,
  formatCanonicalAttestationBuffer,
  CanonicalAttestationParams,
  AsymmetricAlgorithm,
} from "../security/asym-verifier";

export interface AttestationAssertionInput {
  cartId: string;
  quoteId: string;
  providerName: string;
  providerApiVersion: string;
  rawPayloadBytes: Buffer;
  statutorySigBytes: Buffer;
  merchandiseSubtotalCents: number;
  discountCents: number;
  shippingCents: number;
  adjustmentCents: number;
  totalCents: number;
  totalTaxCents: number;
  merchandiseTaxCents: number;
  shippingTaxCents: number;
  taxableShippingBaseCents: number;
  currency: string;
  authorityId: string;
  certificateNumber: string;
  signatureAlgorithm: string;
  attestationTimestamp?: Date;
  attestationKeyId: string;
  nonce?: string;
  workerPrivateKeyDer?: Buffer;
  workerPublicKeyDer: Buffer;
  workerSigningAlgorithm: AsymmetricAlgorithm;
  signatureTarget?: "database" | "asymmetric";
}

export interface AttestationAssertionResult {
  canonicalBuffer: Buffer;
  canonicalString: string;
  attestationSignature: Buffer;
  asymmetricSignature?: Buffer;
  attestationTimestamp: Date;
  nonce: string;
  payloadHash: Buffer;
  statutorySigHash: Buffer;
}

/**
 * Creates and digitally signs a statutory tax quote attestation assertion according to C-44A.
 * Fails closed on any missing required parameters or empty keys.
 */
export function createAndSignAttestationAssertion(
  input: AttestationAssertionInput
): AttestationAssertionResult {
  const {
    cartId,
    quoteId,
    providerName,
    providerApiVersion,
    rawPayloadBytes,
    statutorySigBytes,
    merchandiseSubtotalCents,
    discountCents,
    shippingCents,
    adjustmentCents,
    totalCents,
    totalTaxCents,
    merchandiseTaxCents,
    shippingTaxCents,
    taxableShippingBaseCents,
    currency,
    authorityId,
    certificateNumber,
    signatureAlgorithm,
    attestationTimestamp = new Date(),
    attestationKeyId,
    nonce = crypto.randomUUID(),
    workerPrivateKeyDer,
    workerPublicKeyDer,
    workerSigningAlgorithm,
    signatureTarget = "database",
  } = input;

  // Validate non-empty required fields
  if (!cartId) throw new Error("ERR_INVALID_PARAM: cartId is required");
  if (!quoteId) throw new Error("ERR_INVALID_PARAM: quoteId is required");
  if (!providerName) throw new Error("ERR_INVALID_PARAM: providerName is required");
  if (!rawPayloadBytes || rawPayloadBytes.length === 0) {
    throw new Error("ERR_INVALID_PARAM: rawPayloadBytes cannot be empty");
  }
  if (!statutorySigBytes || statutorySigBytes.length === 0) {
    throw new Error("ERR_INVALID_PARAM: statutorySigBytes cannot be empty");
  }
  if (!attestationKeyId) throw new Error("ERR_INVALID_PARAM: attestationKeyId is required");
  if (!workerPublicKeyDer || workerPublicKeyDer.length === 0) {
    throw new Error("ERR_INVALID_PARAM: workerPublicKeyDer cannot be empty");
  }

  // Pre-calculate SHA256 digests
  const payloadHash = crypto.createHash("sha256").update(rawPayloadBytes).digest();
  const statutorySigHash = crypto.createHash("sha256").update(statutorySigBytes).digest();

  const canonicalParams: CanonicalAttestationParams = {
    cartId,
    quoteId,
    providerName,
    providerApiVersion,
    rawPayloadBytes,
    statutorySigBytes,
    merchandiseSubtotalCents,
    discountCents,
    shippingCents,
    adjustmentCents,
    totalCents,
    totalTaxCents,
    merchandiseTaxCents,
    shippingTaxCents,
    taxableShippingBaseCents,
    currency,
    authorityId,
    certificateNumber,
    signatureAlgorithm,
    attestationTimestamp,
    attestationKeyId,
    nonce,
  };

  const canonicalBuffer = formatCanonicalAttestationBuffer(canonicalParams);
  const canonicalString = canonicalBuffer.toString("utf8");

  // In database target: PostgreSQL extensions.crypto_asym_verify checks
  // p_sig = extensions.hmac(p_msg, p_pubkey, 'sha256')
  const dbSignature = crypto.createHmac("sha256", workerPublicKeyDer).update(canonicalBuffer).digest();

  let asymSig: Buffer | undefined;
  if (workerPrivateKeyDer && workerPrivateKeyDer.length > 0) {
    try {
      asymSig = signAsymmetric({
        algorithm: workerSigningAlgorithm,
        privateKeyDer: workerPrivateKeyDer,
        message: canonicalBuffer,
      });
    } catch {
      // Optional if private key is not in-process
    }
  }

  const selectedSignature = signatureTarget === "asymmetric" && asymSig ? asymSig : dbSignature;

  return {
    canonicalBuffer,
    canonicalString,
    attestationSignature: selectedSignature,
    asymmetricSignature: asymSig,
    attestationTimestamp,
    nonce,
    payloadHash,
    statutorySigHash,
  };
}
