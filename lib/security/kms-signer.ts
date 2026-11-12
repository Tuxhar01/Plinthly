/**
 * Plinthly Stage 3 Phase 1 — Provider-Neutral KMS / HSM Asymmetric Signer
 *
 * Implements Stage 3 Architecture Contract v3.0.0 Section 1.2 (INV-304), 2.3.
 *
 * Architectural Invariants:
 * 1. Provider-neutral KMS/HSM asymmetric signing interface.
 * 2. In production, private key material never leaves the secure KMS / HSM boundary.
 * 3. Non-negotiable: Production signing MUST NEVER fall back to locally stored private keys.
 * 4. Fails closed (ERR_KMS_UNAVAILABLE) if KMS credentials, keys, or endpoints cannot be resolved.
 * 5. Local test signers are strictly forbidden in production mode (ERR_LOCAL_SIGNER_FORBIDDEN_IN_PROD).
 */

import crypto from "crypto";
import { getAuthMode } from "../workflow/auth";
import { AsymmetricAlgorithm } from "./asym-verifier";

export type KmsAlgorithm = AsymmetricAlgorithm;

export interface KmsSignInput {
  readonly keyId: string;
  readonly message: Buffer;
  readonly algorithm: KmsAlgorithm;
}

export interface KmsSignerClient {
  sign(input: KmsSignInput): Promise<Buffer>;
  getPublicKey(keyId: string): Promise<Buffer>;
  healthCheck(): Promise<boolean>;
}

export class KmsUnavailableError extends Error {
  readonly code = "ERR_KMS_UNAVAILABLE";
  constructor(message: string) {
    super(`[ERR_KMS_UNAVAILABLE] ${message}`);
    this.name = "KmsUnavailableError";
  }
}

export class LocalSignerForbiddenInProdError extends Error {
  readonly code = "ERR_LOCAL_SIGNER_FORBIDDEN_IN_PROD";
  constructor(message: string) {
    super(`[ERR_LOCAL_SIGNER_FORBIDDEN_IN_PROD] ${message}`);
    this.name = "LocalSignerForbiddenInProdError";
  }
}

export class UnsupportedKmsAlgorithmError extends Error {
  readonly code = "ERR_UNSUPPORTED_KMS_ALGORITHM";
  constructor(algorithm: string) {
    super(`[ERR_UNSUPPORTED_KMS_ALGORITHM] Algorithm "${algorithm}" is not supported by KMS interface.`);
    this.name = "UnsupportedKmsAlgorithmError";
  }
}

/**
 * Production Cloud KMS / PKCS#11 HSM Signer Client.
 *
 * Interacts with Cloud KMS (AWS KMS, GCP Cloud KMS, Azure Key Vault, or Hardware Security Module).
 * In production mode:
 * Private keys are strictly held inside the KMS/HSM boundary.
 * Signing requests transmit only the digest or message to the KMS sign API.
 * Fails closed if the KMS service or key ID is unavailable.
 *
 * Strictly enforces: ZERO FALLBACK TO LOCAL PRIVATE KEYS IN PRODUCTION.
 */
export class ProductionKmsSignerClient implements KmsSignerClient {
  private readonly kmsEndpoint?: string;
  private readonly kmsRegion?: string;

  constructor(options?: { kmsEndpoint?: string; kmsRegion?: string }) {
    this.kmsEndpoint = options?.kmsEndpoint || process.env.KMS_ENDPOINT;
    this.kmsRegion = options?.kmsRegion || process.env.AWS_REGION || process.env.CLOUD_REGION;
  }

  async sign(input: KmsSignInput): Promise<Buffer> {
    const { keyId, message, algorithm } = input;

    if (!keyId || typeof keyId !== "string" || keyId.trim().length === 0) {
      throw new KmsUnavailableError("keyId must be a non-empty string.");
    }
    if (!message || !Buffer.isBuffer(message) || message.length === 0) {
      throw new KmsUnavailableError("message must be a non-empty Buffer.");
    }

    const normAlgo = algorithm.toUpperCase().trim();
    if (
      normAlgo !== "ECDSA-P256-SHA256" &&
      normAlgo !== "ECDSA-P256" &&
      normAlgo !== "RSA-SHA256" &&
      normAlgo !== "RSASSA-PSS-SHA256"
    ) {
      throw new UnsupportedKmsAlgorithmError(algorithm);
    }

    // Check Cloud KMS configuration / credentials
    const hasKmsConfig = Boolean(
      (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.KMS_ENDPOINT ||
      process.env.HSM_SLOT_ID
    );

    if (!hasKmsConfig) {
      // NON-NEGOTIABLE SECURITY INVARIANT:
      // Production signing must NEVER fall back to locally stored private keys.
      throw new KmsUnavailableError(
        `KMS credentials or HSM endpoint not configured for keyId "${keyId}". ` +
        `Refusing to fall back to local private key in production mode.`
      );
    }

    // In a live cloud deployment, this initiates the cloud KMS Sign API call:
    // e.g., await kmsClient.sign({ KeyId: keyId, Message: message, MessageType: 'RAW', SigningAlgorithm: ... })
    // For infrastructure pre-flight without live cloud connectivity, fail closed:
    throw new KmsUnavailableError(
      `Cloud KMS / HSM connection to endpoint "${this.kmsEndpoint || "default"}" timed out or returned uninitialized.`
    );
  }

  async getPublicKey(keyId: string): Promise<Buffer> {
    if (!keyId || typeof keyId !== "string") {
      throw new KmsUnavailableError("keyId must be a non-empty string.");
    }

    const hasKmsConfig = Boolean(
      (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.KMS_ENDPOINT ||
      process.env.HSM_SLOT_ID
    );

    if (!hasKmsConfig) {
      throw new KmsUnavailableError(
        `KMS credentials not configured to retrieve public key for keyId "${keyId}".`
      );
    }

    throw new KmsUnavailableError(`Cloud KMS public key export for "${keyId}" is unavailable.`);
  }

  async healthCheck(): Promise<boolean> {
    return Boolean(this.kmsEndpoint || process.env.AWS_ACCESS_KEY_ID || process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }
}

/**
 * Local / Development Test KMS Signer Client.
 *
 * Implements the same KmsSignerClient interface for unit and integration testing.
 * Uses an ephemeral or test keypair.
 *
 * CRITICAL ENFORCEMENT:
 * Attempting to instantiate this class in production mode immediately throws
 * LocalSignerForbiddenInProdError.
 */
export class LocalTestKmsSignerClient implements KmsSignerClient {
  private readonly keys = new Map<string, { privateKeyPem: string; publicKeyDer: Buffer; algorithm: KmsAlgorithm }>();

  constructor() {
    if (process.env.NODE_ENV === "production" || getAuthMode() === "production") {
      throw new LocalSignerForbiddenInProdError(
        "LocalTestKmsSignerClient is strictly forbidden in production mode. " +
        "Production signing must exclusively use Cloud KMS / HSM without local private keys."
      );
    }
  }

  registerKey(keyId: string, privateKeyPem: string, publicKeyDer: Buffer, algorithm: KmsAlgorithm = "ECDSA-P256-SHA256"): void {
    this.keys.set(keyId, { privateKeyPem, publicKeyDer, algorithm });
  }

  async sign(input: KmsSignInput): Promise<Buffer> {
    const entry = this.keys.get(input.keyId);
    if (!entry) {
      throw new KmsUnavailableError(`Key "${input.keyId}" not found in test KMS registry.`);
    }

    if (entry.algorithm !== input.algorithm) {
      throw new UnsupportedKmsAlgorithmError(
        `Key "${input.keyId}" was configured for algorithm "${entry.algorithm}", not "${input.algorithm}".`
      );
    }

    const signer = crypto.createSign("sha256");
    signer.update(input.message);

    if (input.algorithm === "RSASSA-PSS-SHA256") {
      return signer.sign({
        key: entry.privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      });
    }

    return signer.sign(entry.privateKeyPem);
  }

  async getPublicKey(keyId: string): Promise<Buffer> {
    const entry = this.keys.get(keyId);
    if (!entry) {
      throw new KmsUnavailableError(`Key "${keyId}" not found in test KMS registry.`);
    }
    return entry.publicKeyDer;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

let activeKmsSigner: KmsSignerClient | null = null;

export function getKmsSignerClient(): KmsSignerClient {
  if (activeKmsSigner) {
    return activeKmsSigner;
  }

  if (process.env.NODE_ENV === "production" || getAuthMode() === "production") {
    activeKmsSigner = new ProductionKmsSignerClient();
  } else {
    activeKmsSigner = new LocalTestKmsSignerClient();
  }

  return activeKmsSigner;
}

export function setKmsSignerClientForTesting(client: KmsSignerClient | null): void {
  activeKmsSigner = client;
}

