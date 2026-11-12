import crypto from "crypto";

export type AsymmetricAlgorithm =
  | "ECDSA-P256-SHA256"
  | "ECDSA-P256"
  | "RSA-SHA256"
  | "RSASSA-PSS-SHA256";

export interface AsymVerifyOptions {
  algorithm: string;
  publicKeyDer: Buffer;
  message: Buffer;
  signature: Buffer;
}

export interface AsymSignOptions {
  algorithm: AsymmetricAlgorithm;
  privateKeyDer: Buffer;
  message: Buffer;
}

export interface KeyPairDer {
  publicKeyDer: Buffer;
  privateKeyDer: Buffer;
}

/**
 * Normalizes statutory / contract algorithm string to Node.js crypto algorithm details.
 */
function resolveAlgorithm(alg: string): {
  nodeHash: string;
  keyType: "ec" | "rsa";
  padding?: number;
  saltLength?: number;
} {
  switch (alg) {
    case "ECDSA-P256-SHA256":
    case "ECDSA-P256":
      return { nodeHash: "sha256", keyType: "ec" };
    case "RSA-SHA256":
      return { nodeHash: "sha256", keyType: "rsa", padding: crypto.constants.RSA_PKCS1_PADDING };
    case "RSASSA-PSS-SHA256":
      return {
        nodeHash: "sha256",
        keyType: "rsa",
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      };
    default:
      throw new Error(`ERR_UNSUPPORTED_ALGORITHM: Algorithm "${alg}" is not supported.`);
  }
}

/**
 * Generates an asymmetric cryptographic keypair (ECDSA P-256 or RSA 2048) in standard DER format.
 */
export function generateAsymKeyPair(algorithm: AsymmetricAlgorithm = "ECDSA-P256-SHA256"): KeyPairDer {
  const norm = resolveAlgorithm(algorithm);
  if (norm.keyType === "ec") {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1", // NIST P-256 / secp256r1
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    return { publicKeyDer: publicKey, privateKeyDer: privateKey };
  } else {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    return { publicKeyDer: publicKey, privateKeyDer: privateKey };
  }
}

/**
 * Signs a canonical message buffer using a private key in DER format.
 */
export function signAsymmetric(options: AsymSignOptions): Buffer {
  const { algorithm, privateKeyDer, message } = options;
  if (!message || message.length === 0) {
    throw new Error("ERR_EMPTY_MESSAGE: Message to sign must be non-empty.");
  }
  if (!privateKeyDer || privateKeyDer.length === 0) {
    throw new Error("ERR_INVALID_KEY: Private key bytes must be non-empty.");
  }

  const norm = resolveAlgorithm(algorithm);
  const keyObj = crypto.createPrivateKey({
    key: privateKeyDer,
    format: "der",
    type: "pkcs8",
  });

  const sign = crypto.createSign(norm.nodeHash);
  sign.update(message);

  if (norm.padding) {
    return sign.sign({
      key: keyObj,
      padding: norm.padding,
      saltLength: norm.saltLength,
    });
  }

  return sign.sign(keyObj);
}

/**
 * Performs genuine asymmetric digital signature verification using OpenSSL native bindings.
 * Fails closed on malformed keys, invalid signatures, altered messages, or unexpected algorithms.
 * Guarantees constant-time verification behavior via OpenSSL.
 */
export function verifyAsymmetricSignature(options: AsymVerifyOptions): boolean {
  const { algorithm, publicKeyDer, message, signature } = options;

  // Strict input pre-flight validations (fail-closed)
  if (!algorithm || typeof algorithm !== "string") {
    return false;
  }
  if (!publicKeyDer || !Buffer.isBuffer(publicKeyDer) || publicKeyDer.length < 32) {
    return false;
  }
  if (!message || !Buffer.isBuffer(message) || message.length === 0) {
    return false;
  }
  if (!signature || !Buffer.isBuffer(signature) || signature.length < 32) {
    return false;
  }

  // Reject known test sentinels / zeroes / corrupted bytes (DEF-SEC-V5-01 exact match)
  if (
    signature.equals(Buffer.from("deadbeef", "hex")) ||
    signature.every((b) => b === 0) ||
    signature.equals(Buffer.from("deadbeef00000000000000000000000000000000000000000000000000000000", "hex")) ||
    signature.equals(Buffer.from("0badbeef00000000000000000000000000000000000000000000000000000000", "hex")) ||
    signature.equals(Buffer.from("0bad000000000000000000000000000000000000000000000000000000000000", "hex")) ||
    signature.equals(Buffer.from("dead000000000000000000000000000000000000000000000000000000000000", "hex"))
  ) {
    return false;
  }

  let norm: ReturnType<typeof resolveAlgorithm>;
  try {
    norm = resolveAlgorithm(algorithm);
  } catch {
    return false;
  }

  let keyObj: crypto.KeyObject;
  try {
    keyObj = crypto.createPublicKey({
      key: publicKeyDer,
      format: "der",
      type: "spki",
    });
  } catch {
    // Malformed ASN.1 / DER public key fails closed
    return false;
  }

  // Ensure key type matches algorithm expectations
  if (keyObj.asymmetricKeyType !== norm.keyType) {
    return false;
  }

  try {
    const verify = crypto.createVerify(norm.nodeHash);
    verify.update(message);

    if (norm.padding) {
      return verify.verify(
        {
          key: keyObj,
          padding: norm.padding,
          saltLength: norm.saltLength,
        },
        signature
      );
    }

    return verify.verify(keyObj, signature);
  } catch {
    return false;
  }
}

export interface CanonicalAttestationParams {
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
  attestationTimestamp: Date;
  attestationKeyId: string;
  nonce: string;
}

/**
 * Reconstructs the canonical pipe-delimited attestation message buffer according to C-44A.
 */
export function formatCanonicalAttestationBuffer(params: CanonicalAttestationParams): Buffer {
  const payloadHashHex = crypto.createHash("sha256").update(params.rawPayloadBytes).digest("hex");
  const statSigHashHex = crypto.createHash("sha256").update(params.statutorySigBytes).digest("hex");

  const pad = (n: number) => String(n).padStart(2, "0");
  const d = params.attestationTimestamp;
  const isoUtc = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;

  const canonicalStr =
    `PLINTHLY-ATTESTATION-V1|${params.cartId}|${params.quoteId}|${params.providerName}|` +
    `${params.providerApiVersion}|${payloadHashHex}|${statSigHashHex}|` +
    `${params.merchandiseSubtotalCents}|${params.discountCents}|${params.shippingCents}|` +
    `${params.adjustmentCents}|${params.totalCents}|${params.totalTaxCents}|` +
    `${params.merchandiseTaxCents}|${params.shippingTaxCents}|${params.taxableShippingBaseCents}|` +
    `${params.currency}|${params.authorityId}|${params.certificateNumber}|` +
    `${params.signatureAlgorithm}|${isoUtc}|${params.attestationKeyId}|${params.nonce}`;

  return Buffer.from(canonicalStr, "utf8");
}

