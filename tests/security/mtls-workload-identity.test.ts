/**
 * Plinthly Stage 3 Phase 1 — Production Security & Workload Identity Acceptance Suite
 *
 * Implements verification for SEC-01 through SEC-06 in STAGE_3_ACCEPTANCE_MATRIX.md:
 * 1. SEC-01: PostgreSQL mTLS Workload Identity & SPIFFE SVID Validation
 * 2. SEC-02: Certificate-to-Role Mapping & Pool Separation
 * 3. SEC-03: Strict Elimination of SET SESSION AUTHORIZATION in Production
 * 4. SEC-04: Dedicated Connection Pool Isolation per Database Role
 * 5. SEC-05: KMS / HSM Private Key Protection (Zero Fallback to Local Private Keys)
 * 6. SEC-06: Production OIDC Authentication Middleware & Header Spoofing Protection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import {
  validateSpiffeId,
  ProductionSecretsManagerClient,
  LocalDevelopmentSecretsManagerClient,
  SpiffeUnavailableError,
  SecretsUnavailableError,
  UnauthorizedLocalSecretsError,
} from "../../lib/security/secrets-manager";
import {
  ProductionKmsSignerClient,
  LocalTestKmsSignerClient,
  KmsUnavailableError,
  LocalSignerForbiddenInProdError,
  UnsupportedKmsAlgorithmError,
} from "../../lib/security/kms-signer";
import {
  Stage3DatabasePoolManager,
  STAGE3_ROLE_CONFIGS,
  WorkloadIdentityMismatchError,
  ProductionIdentityViolationError,
  MtlsConfigurationError,
} from "../../lib/database/stage3-pool-manager";
import {
  createStage2ApiClient,
  mapPrincipalToRole,
} from "../../lib/database/stage2-connection";
import {
  ProductionAuthMiddleware,
  OidcTokenClaims,
} from "../../lib/workflow/auth-middleware";

describe("Stage 3 Phase 1: Production Security & Workload Identity", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Stage3DatabasePoolManager.resetInstance();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    Stage3DatabasePoolManager.resetInstance();
    process.env = { ...originalEnv };
  });

  // ==========================================================================
  // 1. SPIFFE/SPIRE Workload Identity & SVID Validation
  // ==========================================================================
  describe("1. SPIFFE/SPIRE Workload Identity & SVID Validation (SEC-01)", () => {
    it("validates well-formed SPIFFE IDs matching standard trust domain", () => {
      expect(validateSpiffeId("spiffe://plinthly.prod/sa/webhook-ingress")).toBe(true);
      expect(validateSpiffeId("spiffe://plinthly.prod/sa/tax-verifier")).toBe(true);
      expect(validateSpiffeId("spiffe://plinthly.prod/sa/app-orchestrator")).toBe(true);
      expect(validateSpiffeId("spiffe://plinthly.prod/sa/security-admin")).toBe(true);
    });

    it("rejects malformed SPIFFE IDs, invalid schemes, and foreign trust domains", () => {
      expect(validateSpiffeId("")).toBe(false);
      expect(validateSpiffeId("https://plinthly.prod/sa/webhook-ingress")).toBe(false);
      expect(validateSpiffeId("spiffe://malicious.attacker.io/sa/webhook-ingress")).toBe(false);
      expect(validateSpiffeId("spiffe://plinthly.prod/invalid-path")).toBe(false);
      expect(validateSpiffeId("spiffe://plinthly.prod/sa/")).toBe(false);
      expect(validateSpiffeId(null as any)).toBe(false);
    });

    it("fails closed when SPIFFE Workload API socket or SVID files are unavailable in production", async () => {
      const client = new ProductionSecretsManagerClient({
        trustDomain: "plinthly.prod",
        spiffeSocketPath: "/nonexistent/spire-agent/workload.sock",
      });

      await expect(client.getWorkloadTlsCredentials("webhook_ingress_role")).rejects.toThrow(
        SpiffeUnavailableError
      );
    });

    it("strictly forbids LocalDevelopmentSecretsManagerClient in production mode", () => {
      (process.env as any).NODE_ENV = "production";
      process.env.AUTH_MODE = "production";

      expect(() => new LocalDevelopmentSecretsManagerClient()).toThrow(
        UnauthorizedLocalSecretsError
      );
    });
  });

  // ==========================================================================
  // 2. KMS / HSM Asymmetric Signer & Zero Local Fallback (SEC-05)
  // ==========================================================================
  describe("2. Provider-Neutral KMS / HSM Signer (SEC-05)", () => {
    it("fails closed when KMS credentials or endpoint are missing in production mode", async () => {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      delete process.env.KMS_ENDPOINT;
      delete process.env.HSM_SLOT_ID;

      const client = new ProductionKmsSignerClient();
      const input = {
        keyId: "arn:aws:kms:us-east-1:123456789012:key/test-key-id",
        message: Buffer.from("test_statutory_attestation_bytes", "utf8"),
        algorithm: "ECDSA-P256-SHA256" as const,
      };

      // NON-NEGOTIABLE SECURITY INVARIANT: Must NEVER fall back to local private key
      await expect(client.sign(input)).rejects.toThrow(KmsUnavailableError);
      await expect(client.sign(input)).rejects.toThrow(/Refusing to fall back to local private key/);
    });

    it("rejects unsupported KMS signing algorithms fail-closed", async () => {
      process.env.KMS_ENDPOINT = "https://kms.us-east-1.amazonaws.com";
      const client = new ProductionKmsSignerClient();

      const input = {
        keyId: "test_key",
        message: Buffer.from("test", "utf8"),
        algorithm: "UNSUPPORTED-ALGO" as any,
      };

      await expect(client.sign(input)).rejects.toThrow(UnsupportedKmsAlgorithmError);
    });

    it("strictly forbids LocalTestKmsSignerClient in production mode", () => {
      (process.env as any).NODE_ENV = "production";
      process.env.AUTH_MODE = "production";

      expect(() => new LocalTestKmsSignerClient()).toThrow(
        LocalSignerForbiddenInProdError
      );
    });

    it("allows LocalTestKmsSignerClient in test mode with genuine cryptographic signatures", async () => {
      (process.env as any).NODE_ENV = "test";
      process.env.AUTH_MODE = "local_demo";

      const testSigner = new LocalTestKmsSignerClient();
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
        publicKeyEncoding: { type: "spki", format: "der" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      testSigner.registerKey("test_tax_key_01", privateKey, publicKey, "ECDSA-P256-SHA256");

      const message = Buffer.from("PLINTHLY-ATTESTATION-V1|cart_1|quote_1|20261107", "utf8");
      const sig = await testSigner.sign({
        keyId: "test_tax_key_01",
        message,
        algorithm: "ECDSA-P256-SHA256",
      });

      expect(Buffer.isBuffer(sig)).toBe(true);
      expect(sig.length).toBeGreaterThan(32);

      // Verify signature using OpenSSL
      const verifier = crypto.createVerify("sha256");
      verifier.update(message);
      const isValid = verifier.verify(
        crypto.createPublicKey({ key: publicKey, format: "der", type: "spki" }),
        sig
      );
      expect(isValid).toBe(true);
    });
  });

  // ==========================================================================
  // 3. Dedicated Connection Pool Isolation & Role Configuration (SEC-02, SEC-04)
  // ==========================================================================
  describe("3. Dedicated Connection Pool Isolation & Role Mapping (SEC-02, SEC-04)", () => {
    it("defines distinct SPIFFE IDs and connection bounds for all four database roles", () => {
      expect(STAGE3_ROLE_CONFIGS.webhook_ingress_role.spiffeId).toBe(
        "spiffe://plinthly.prod/sa/webhook-ingress"
      );
      expect(STAGE3_ROLE_CONFIGS.tax_verifier_role.spiffeId).toBe(
        "spiffe://plinthly.prod/sa/tax-verifier"
      );
      expect(STAGE3_ROLE_CONFIGS.app_orchestrator_role.spiffeId).toBe(
        "spiffe://plinthly.prod/sa/app-orchestrator"
      );
      expect(STAGE3_ROLE_CONFIGS.admin_security_role.spiffeId).toBe(
        "spiffe://plinthly.prod/sa/security-admin"
      );

      // Verify principal to role mapping parity
      expect(mapPrincipalToRole("ingress_worker_user")).toBe("webhook_ingress_role");
      expect(mapPrincipalToRole("tax_worker_01")).toBe("tax_verifier_role");
      expect(mapPrincipalToRole("orchestrator_worker_user")).toBe("app_orchestrator_role");
      expect(mapPrincipalToRole("security_admin_user")).toBe("admin_security_role");
    });

    it("instantiates distinct connection pools per role without cross-pool leakage", () => {
      const manager = Stage3DatabasePoolManager.getInstance({
        baseConnectionString: "postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_stage2_dev",
        isProduction: false,
      });

      const ingressPool = manager.getIngressPool();
      const taxPool = manager.getTaxVerifierPool();
      const orchestratorPool = manager.getOrchestratorPool();
      const adminPool = manager.getAdminSecurityPool();

      expect(ingressPool).not.toBe(taxPool);
      expect(taxPool).not.toBe(orchestratorPool);
      expect(orchestratorPool).not.toBe(adminPool);

      // Calling again returns the exact same cached pool instance per role
      expect(manager.getIngressPool()).toBe(ingressPool);
      expect(manager.getTaxVerifierPool()).toBe(taxPool);
    });

    it("fails closed when configuring production mTLS pool without SPIFFE SVID or socket", () => {
      delete process.env.SPIFFE_X509_SVID_DIR;
      delete process.env.SPIFFE_ENDPOINT_SOCKET;

      const manager = Stage3DatabasePoolManager.getInstance({
        baseConnectionString: "postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_stage2_dev",
        isProduction: true,
      });

      expect(() => manager.getIngressPool()).toThrow(MtlsConfigurationError);
      expect(() => manager.getIngressPool()).toThrow(/SPIFFE Workload identity is required/);
    });
  });

  // ==========================================================================
  // 4. Strict Elimination of SET SESSION AUTHORIZATION in Production (SEC-03)
  // ==========================================================================
  describe("4. Elimination of SET SESSION AUTHORIZATION in Production (SEC-03)", () => {
    it("throws ProductionIdentityViolationError if session simulation is attempted in production", async () => {
      (process.env as any).NODE_ENV = "production";
      process.env.AUTH_MODE = "production";
      process.env.SIMULATE_SESSION_AUTH = "true";

      await expect(createStage2ApiClient("orchestrator_worker_user")).rejects.toThrow(
        ProductionIdentityViolationError
      );
      await expect(createStage2ApiClient("orchestrator_worker_user")).rejects.toThrow(
        /SET SESSION AUTHORIZATION is strictly forbidden in production mode/
      );
    });

    it("verifies zero occurrences of SET SESSION AUTHORIZATION in Stage 3 production modules", () => {
      const fs = require("fs");
      const path = require("path");

      const prodModules = [
        "lib/database/stage3-pool-manager.ts",
        "lib/security/kms-signer.ts",
        "lib/security/secrets-manager.ts",
        "lib/workflow/auth-middleware.ts",
      ];

      for (const modPath of prodModules) {
        const fullPath = path.resolve(modPath);
        const content = fs.readFileSync(fullPath, "utf8");
        expect(
          content.includes("SET SESSION AUTHORIZATION"),
          `Module "${modPath}" must not contain "SET SESSION AUTHORIZATION"`
        ).toBe(false);
      }
    });
  });

  // ==========================================================================
  // 5. Production OIDC / JWT Authentication Middleware (SEC-06)
  // ==========================================================================
  describe("5. Production OIDC Authentication Middleware & Header Spoofing (SEC-06)", () => {
    const keyPair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const middleware = new ProductionAuthMiddleware({
      expectedIssuer: "https://auth.plinthly.prod",
      expectedAudience: "plinthly-api",
      jwksPublicKeyPem: keyPair.publicKey,
    });

    function generateTestJwt(claims: Partial<OidcTokenClaims>, keyPem = keyPair.privateKey, alg = "RS256"): string {
      const now = Math.floor(Date.now() / 1000);
      const header = { alg, typ: "JWT" };
      const fullClaims: OidcTokenClaims = {
        sub: "usr_alice_123",
        iss: "https://auth.plinthly.prod",
        aud: "plinthly-api",
        iat: now,
        exp: now + 3600,
        ...claims,
      };

      const hB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
      const pB64 = Buffer.from(JSON.stringify(fullClaims), "utf8").toString("base64url");
      const sign = crypto.createSign("RSA-SHA256");
      sign.update(`${hB64}.${pB64}`);
      const sigB64 = sign.sign(keyPem).toString("base64url");

      return `${hB64}.${pB64}.${sigB64}`;
    }

    it("rejects unauthenticated requests in production mode (HTTP 401)", async () => {
      (process.env as any).NODE_ENV = "production";
      process.env.AUTH_MODE = "production";

      const req = new Request("http://localhost:3000/api/cart/checkout", {
        method: "POST",
      });

      const result = await middleware.authenticateRequest(req);
      expect(result.ok).toBe(false);
      expect(result.error?.statusCode).toBe(401);
      expect(result.error?.code).toBe("ERR_UNAUTHORIZED");
    });

    it("strictly rejects spoofed x-actor-id headers in production mode", async () => {
      (process.env as any).NODE_ENV = "production";
      process.env.AUTH_MODE = "production";

      const req = new Request("http://localhost:3000/api/cart/checkout", {
        method: "POST",
        headers: {
          "x-actor-id": "usr_hacker_impersonator",
          "x-actor-kind": "system",
        },
      });

      const result = await middleware.authenticateRequest(req);
      expect(result.ok).toBe(false);
      expect(result.error?.statusCode).toBe(401);
      expect(result.actor).toBeUndefined();
    });

    it("rejects expired JWT bearer tokens fail-closed", async () => {
      (process.env as any).NODE_ENV = "production";
      process.env.AUTH_MODE = "production";

      const past = Math.floor(Date.now() / 1000) - 100;
      const expiredToken = generateTestJwt({ exp: past });

      const req = new Request("http://localhost:3000/api/cart/checkout", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${expiredToken}`,
        },
      });

      const result = await middleware.authenticateRequest(req);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("ERR_EXPIRED_JWT");
    });

    it("rejects tokens with mismatched audience or issuer", async () => {
      (process.env as any).NODE_ENV = "production";
      process.env.AUTH_MODE = "production";

      const wrongAudToken = generateTestJwt({ aud: "rogue-api" });
      const reqAud = new Request("http://localhost:3000/api/cart/checkout", {
        method: "POST",
        headers: { Authorization: `Bearer ${wrongAudToken}` },
      });
      const resAud = await middleware.authenticateRequest(reqAud);
      expect(resAud.ok).toBe(false);
      expect(resAud.error?.code).toBe("ERR_INVALID_AUDIENCE");

      const wrongIssToken = generateTestJwt({ iss: "https://evil.auth.com" });
      const reqIss = new Request("http://localhost:3000/api/cart/checkout", {
        method: "POST",
        headers: { Authorization: `Bearer ${wrongIssToken}` },
      });
      const resIss = await middleware.authenticateRequest(reqIss);
      expect(resIss.ok).toBe(false);
      expect(resIss.error?.code).toBe("ERR_INVALID_ISSUER");
    });

    it("rejects tokens with forged signatures fail-closed", async () => {
      (process.env as any).NODE_ENV = "production";
      process.env.AUTH_MODE = "production";

      const foreignKeyPair = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      const forgedToken = generateTestJwt({}, foreignKeyPair.privateKey);
      const req = new Request("http://localhost:3000/api/cart/checkout", {
        method: "POST",
        headers: { Authorization: `Bearer ${forgedToken}` },
      });

      const result = await middleware.authenticateRequest(req);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("ERR_INVALID_SIGNATURE");
    });

    it("successfully authenticates valid signed JWT and populates verified Actor", async () => {
      (process.env as any).NODE_ENV = "production";
      process.env.AUTH_MODE = "production";

      const validToken = generateTestJwt({
        sub: "usr_verified_buyer_99",
        roles: ["buyer"],
      });

      const req = new Request("http://localhost:3000/api/cart/checkout", {
        method: "POST",
        headers: { Authorization: `Bearer ${validToken}` },
      });

      const result = await middleware.authenticateRequest(req);
      expect(result.ok).toBe(true);
      expect(result.actor).toBeDefined();
      expect((result.actor as any)?.userId).toBe("usr_verified_buyer_99");
      expect(result.actor?.kind).toBe("user");
    });
  });
});
