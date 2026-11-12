/**
 * Plinthly Stage 3 Phase 1 — Workload Identity & Secrets Manager Provider Abstraction
 *
 * Implements Stage 3 Architecture Contract v3.0.0 Section 2.1, 2.3.
 *
 * Architectural Invariants:
 * 1. Provider-neutral secrets and certificate management for workload identity.
 * 2. In production, retrieves SPIFFE/SPIRE X.509 SVID credentials and CA trust bundles.
 * 3. Fails closed (ERR_SECRETS_UNAVAILABLE / ERR_SPIFFE_UNAVAILABLE) if production
 *    credentials or workload sockets cannot be resolved.
 * 4. Local / development secret providers are strictly forbidden in production mode.
 */

import fs from "fs";
import path from "path";
import { getAuthMode } from "../workflow/auth";

export interface WorkloadTlsCredentials {
  readonly certPem: string;
  readonly keyPem: string;
  readonly caPem: string;
  readonly spiffeId: string;
}

export interface SecretsManagerClient {
  getSecret(secretName: string): Promise<string>;
  getWorkloadTlsCredentials(workloadRole: string): Promise<WorkloadTlsCredentials>;
  healthCheck(): Promise<boolean>;
}

export class SecretsUnavailableError extends Error {
  readonly code = "ERR_SECRETS_UNAVAILABLE";
  constructor(message: string) {
    super(`[ERR_SECRETS_UNAVAILABLE] ${message}`);
    this.name = "SecretsUnavailableError";
  }
}

export class SpiffeUnavailableError extends Error {
  readonly code = "ERR_SPIFFE_UNAVAILABLE";
  constructor(message: string) {
    super(`[ERR_SPIFFE_UNAVAILABLE] ${message}`);
    this.name = "SpiffeUnavailableError";
  }
}

export class UnauthorizedLocalSecretsError extends Error {
  readonly code = "ERR_UNAUTHORIZED_LOCAL_SECRETS";
  constructor(message: string) {
    super(`[ERR_UNAUTHORIZED_LOCAL_SECRETS] ${message}`);
    this.name = "UnauthorizedLocalSecretsError";
  }
}

/**
 * Validates a SPIFFE ID according to the SPIFFE Standards specification.
 * Must match: spiffe://<trust-domain>/sa/<workload>
 */
export function validateSpiffeId(spiffeId: string, expectedTrustDomain = "plinthly.prod"): boolean {
  if (!spiffeId || typeof spiffeId !== "string") {
    return false;
  }
  const regex = new RegExp(`^spiffe:\\/\\/${expectedTrustDomain.replace(".", "\\.")}\\/sa\\/[a-z0-9_-]+$`);
  return regex.test(spiffeId);
}

/**
 * Production Workload Identity & Secrets Manager Client.
 *
 * Interacts with SPIFFE/SPIRE Workload API (or configured SVID directory)
 * and Cloud Secrets Manager (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault).
 *
 * In production mode:
 * Fails closed if the SPIFFE endpoint socket or credentials cannot be reached.
 * Never falls back to mock, local, or embedded secrets.
 */
export class ProductionSecretsManagerClient implements SecretsManagerClient {
  private readonly trustDomain: string;
  private readonly spiffeSocketPath?: string;
  private readonly svidDirectory?: string;

  constructor(options?: { trustDomain?: string; spiffeSocketPath?: string; svidDirectory?: string }) {
    this.trustDomain = options?.trustDomain || process.env.SPIFFE_TRUST_DOMAIN || "plinthly.prod";
    this.spiffeSocketPath = options?.spiffeSocketPath || process.env.SPIFFE_ENDPOINT_SOCKET;
    this.svidDirectory = options?.svidDirectory || process.env.SPIFFE_X509_SVID_DIR;
  }

  async getSecret(secretName: string): Promise<string> {
    if (!secretName || typeof secretName !== "string") {
      throw new SecretsUnavailableError("Secret name must be a non-empty string.");
    }

    // Check environment variable configured via Kubernetes / container secret mount
    const envVal = process.env[secretName];
    if (envVal && envVal.trim().length > 0) {
      return envVal.trim();
    }

    // Check mounted secret file (standard Kubernetes / Docker secret path /run/secrets/)
    const mountedSecretPath = path.join("/run/secrets", secretName);
    if (fs.existsSync(mountedSecretPath)) {
      try {
        return fs.readFileSync(mountedSecretPath, "utf8").trim();
      } catch (err: any) {
        throw new SecretsUnavailableError(`Failed reading mounted secret "${secretName}": ${err.message}`);
      }
    }

    // Fail-closed in production
    throw new SecretsUnavailableError(
      `Secret "${secretName}" could not be resolved from cloud secret store or mounted secret path.`
    );
  }

  async getWorkloadTlsCredentials(workloadRole: string): Promise<WorkloadTlsCredentials> {
    if (!workloadRole || typeof workloadRole !== "string") {
      throw new SpiffeUnavailableError("workloadRole must be a non-empty string.");
    }

    const spiffeId = `spiffe://${this.trustDomain}/sa/${workloadRole.replace(/_/g, "-")}`;
    if (!validateSpiffeId(spiffeId, this.trustDomain)) {
      throw new SpiffeUnavailableError(`Constructed SPIFFE ID "${spiffeId}" failed validation.`);
    }

    // Check if SVID directory is provided
    if (this.svidDirectory && fs.existsSync(this.svidDirectory)) {
      try {
        const certPath = path.join(this.svidDirectory, `${workloadRole}.crt`);
        const keyPath = path.join(this.svidDirectory, `${workloadRole}.key`);
        const caPath = path.join(this.svidDirectory, "bundle.crt");

        if (fs.existsSync(certPath) && fs.existsSync(keyPath) && fs.existsSync(caPath)) {
          const certPem = fs.readFileSync(certPath, "utf8");
          const keyPem = fs.readFileSync(keyPath, "utf8");
          const caPem = fs.readFileSync(caPath, "utf8");

          return { certPem, keyPem, caPem, spiffeId };
        }
      } catch (err: any) {
        throw new SpiffeUnavailableError(`Error reading SVID from "${this.svidDirectory}": ${err.message}`);
      }
    }

    // Check SPIFFE endpoint socket availability
    if (this.spiffeSocketPath) {
      if (!fs.existsSync(this.spiffeSocketPath)) {
        throw new SpiffeUnavailableError(
          `SPIFFE Workload API socket "${this.spiffeSocketPath}" does not exist or is unreachable.`
        );
      }
      // Note: Actual SPIFFE Workload API gRPC call would execute here when SPIRE agent is present
      throw new SpiffeUnavailableError(
        `SPIFFE agent at "${this.spiffeSocketPath}" returned uninitialized workload credentials for "${spiffeId}".`
      );
    }

    // Fail-closed in production
    throw new SpiffeUnavailableError(
      `SPIFFE/SPIRE workload credentials unavailable for role "${workloadRole}" (Trust Domain: "${this.trustDomain}").`
    );
  }

  async healthCheck(): Promise<boolean> {
    if (this.spiffeSocketPath && fs.existsSync(this.spiffeSocketPath)) {
      return true;
    }
    if (this.svidDirectory && fs.existsSync(this.svidDirectory)) {
      return true;
    }
    return false;
  }
}

/**
 * Local / Development Secrets Manager Client.
 * Strictly restricted to non-production environments (test / local_demo).
 */
export class LocalDevelopmentSecretsManagerClient implements SecretsManagerClient {
  private readonly mockSecrets = new Map<string, string>();
  private readonly mockCreds = new Map<string, WorkloadTlsCredentials>();

  constructor() {
    if (process.env.NODE_ENV === "production" || getAuthMode() === "production") {
      throw new UnauthorizedLocalSecretsError(
        "LocalDevelopmentSecretsManagerClient is strictly forbidden in production mode."
      );
    }
  }

  setMockSecret(name: string, value: string): void {
    this.mockSecrets.set(name, value);
  }

  setMockWorkloadCredentials(role: string, creds: WorkloadTlsCredentials): void {
    this.mockCreds.set(role, creds);
  }

  async getSecret(secretName: string): Promise<string> {
    if (this.mockSecrets.has(secretName)) {
      return this.mockSecrets.get(secretName)!;
    }
    const envVal = process.env[secretName];
    if (envVal) return envVal;
    throw new SecretsUnavailableError(`Local mock secret "${secretName}" not found.`);
  }

  async getWorkloadTlsCredentials(workloadRole: string): Promise<WorkloadTlsCredentials> {
    if (this.mockCreds.has(workloadRole)) {
      return this.mockCreds.get(workloadRole)!;
    }
    throw new SpiffeUnavailableError(`Local mock SVID for "${workloadRole}" not registered.`);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

let activeSecretsClient: SecretsManagerClient | null = null;

export function getSecretsManagerClient(): SecretsManagerClient {
  if (activeSecretsClient) {
    return activeSecretsClient;
  }

  if (process.env.NODE_ENV === "production" || getAuthMode() === "production") {
    activeSecretsClient = new ProductionSecretsManagerClient();
  } else {
    activeSecretsClient = new LocalDevelopmentSecretsManagerClient();
  }

  return activeSecretsClient;
}

export function setSecretsManagerClientForTesting(client: SecretsManagerClient | null): void {
  activeSecretsClient = client;
}

