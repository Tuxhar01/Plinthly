import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  generateAsymKeyPair,
  signAsymmetric,
  verifyAsymmetricSignature,
  formatCanonicalAttestationBuffer,
} from "../../lib/security/asym-verifier";

describe("Asymmetric Signature Verifier (DEF-CRYPT-01 Genuine Implementation)", () => {
  describe("ECDSA-P256-SHA256", () => {
    it("accepts genuine ECDSA signatures signed by matching private key", () => {
      const { publicKeyDer, privateKeyDer } = generateAsymKeyPair("ECDSA-P256-SHA256");
      const message = Buffer.from("PLINTHLY-ATTESTATION-V1|cart_test_01|quote_test_01");
      const signature = signAsymmetric({
        algorithm: "ECDSA-P256-SHA256",
        privateKeyDer,
        message,
      });

      const isValid = verifyAsymmetricSignature({
        algorithm: "ECDSA-P256-SHA256",
        publicKeyDer,
        message,
        signature,
      });

      expect(isValid).toBe(true);
    });

    it("fails closed when message is altered by even one bit", () => {
      const { publicKeyDer, privateKeyDer } = generateAsymKeyPair("ECDSA-P256-SHA256");
      const message = Buffer.from("PLINTHLY-ATTESTATION-V1|cart_test_01|amount=5000");
      const signature = signAsymmetric({
        algorithm: "ECDSA-P256-SHA256",
        privateKeyDer,
        message,
      });

      const alteredMessage = Buffer.from("PLINTHLY-ATTESTATION-V1|cart_test_01|amount=5001");
      const isValid = verifyAsymmetricSignature({
        algorithm: "ECDSA-P256-SHA256",
        publicKeyDer,
        message: alteredMessage,
        signature,
      });

      expect(isValid).toBe(false);
    });

    it("fails closed when signature is forged or randomly generated", () => {
      const { publicKeyDer } = generateAsymKeyPair("ECDSA-P256-SHA256");
      const message = Buffer.from("PLINTHLY-ATTESTATION-V1|cart_test_01");
      const forgedSignature = crypto.randomBytes(64);

      const isValid = verifyAsymmetricSignature({
        algorithm: "ECDSA-P256-SHA256",
        publicKeyDer,
        message,
        signature: forgedSignature,
      });

      expect(isValid).toBe(false);
    });

    it("fails closed when signature is from a different keypair", () => {
      const keypairA = generateAsymKeyPair("ECDSA-P256-SHA256");
      const keypairB = generateAsymKeyPair("ECDSA-P256-SHA256");
      const message = Buffer.from("PLINTHLY-ATTESTATION-V1|cart_test_01");

      const signatureA = signAsymmetric({
        algorithm: "ECDSA-P256-SHA256",
        privateKeyDer: keypairA.privateKeyDer,
        message,
      });

      const isValid = verifyAsymmetricSignature({
        algorithm: "ECDSA-P256-SHA256",
        publicKeyDer: keypairB.publicKeyDer, // Key B verifying signature from Key A
        message,
        signature: signatureA,
      });

      expect(isValid).toBe(false);
    });
  });

  describe("RSA-SHA256 & RSASSA-PSS-SHA256", () => {
    it("accepts genuine RSA-SHA256 signatures signed by matching private key", () => {
      const { publicKeyDer, privateKeyDer } = generateAsymKeyPair("RSA-SHA256");
      const message = Buffer.from("PLINTHLY-ATTESTATION-V1|cart_test_rsa|quote_rsa");
      const signature = signAsymmetric({
        algorithm: "RSA-SHA256",
        privateKeyDer,
        message,
      });

      const isValid = verifyAsymmetricSignature({
        algorithm: "RSA-SHA256",
        publicKeyDer,
        message,
        signature,
      });

      expect(isValid).toBe(true);
    });

    it("accepts genuine RSASSA-PSS-SHA256 signatures", () => {
      const { publicKeyDer, privateKeyDer } = generateAsymKeyPair("RSASSA-PSS-SHA256");
      const message = Buffer.from("PLINTHLY-ATTESTATION-V1|cart_test_pss|quote_pss");
      const signature = signAsymmetric({
        algorithm: "RSASSA-PSS-SHA256",
        privateKeyDer,
        message,
      });

      const isValid = verifyAsymmetricSignature({
        algorithm: "RSASSA-PSS-SHA256",
        publicKeyDer,
        message,
        signature,
      });

      expect(isValid).toBe(true);
    });

    it("rejects altered message for RSA signatures", () => {
      const { publicKeyDer, privateKeyDer } = generateAsymKeyPair("RSA-SHA256");
      const message = Buffer.from("PLINTHLY-ATTESTATION-V1|original");
      const signature = signAsymmetric({
        algorithm: "RSA-SHA256",
        privateKeyDer,
        message,
      });

      const isValid = verifyAsymmetricSignature({
        algorithm: "RSA-SHA256",
        publicKeyDer,
        message: Buffer.from("PLINTHLY-ATTESTATION-V1|tampered"),
        signature,
      });

      expect(isValid).toBe(false);
    });
  });

  describe("C-44A Canonical Attestation Buffer Verification", () => {
    it("verifies genuine signature over complete canonical attestation buffer", () => {
      const { publicKeyDer, privateKeyDer } = generateAsymKeyPair("ECDSA-P256-SHA256");
      const cartId = crypto.randomUUID();
      const quoteId = "quote_attest_" + crypto.randomUUID();
      const rawPayload = Buffer.from(JSON.stringify({ test: "payload" }), "utf8");
      const statutorySig = crypto.randomBytes(64);
      const ts = new Date();
      const nonce = "nonce_" + crypto.randomUUID();

      const canonicalBuffer = formatCanonicalAttestationBuffer({
        cartId,
        quoteId,
        providerName: "TAXJAR",
        providerApiVersion: "v2.2026.1",
        rawPayloadBytes: rawPayload,
        statutorySigBytes: statutorySig,
        merchandiseSubtotalCents: 2500,
        discountCents: 500,
        shippingCents: 1000,
        adjustmentCents: 0,
        totalCents: 3240,
        totalTaxCents: 240,
        merchandiseTaxCents: 160,
        shippingTaxCents: 80,
        taxableShippingBaseCents: 1000,
        currency: "USD",
        authorityId: "AUTH-US-CA",
        certificateNumber: "CERT-2026-001",
        signatureAlgorithm: "ECDSA-P256-SHA256",
        attestationTimestamp: ts,
        attestationKeyId: "key_worker_01",
        nonce,
      });

      const signature = signAsymmetric({
        algorithm: "ECDSA-P256-SHA256",
        privateKeyDer,
        message: canonicalBuffer,
      });

      const isValid = verifyAsymmetricSignature({
        algorithm: "ECDSA-P256-SHA256",
        publicKeyDer,
        message: canonicalBuffer,
        signature,
      });

      expect(isValid).toBe(true);
    });
  });

  describe("Fail-Closed Boundary & Mock Exploitation Resistance", () => {
    it("strictly rejects the vulnerable 64-byte mock sentinel that bypassed the previous implementation", () => {
      const { publicKeyDer } = generateAsymKeyPair("ECDSA-P256-SHA256");
      const message = Buffer.from("PLINTHLY-ATTESTATION-V1|cart_01");
      // The previous implementation accepted ANY 64-byte buffer (octet_length >= 64)
      const mockBypassSignature = Buffer.alloc(64, 5);

      const isValid = verifyAsymmetricSignature({
        algorithm: "ECDSA-P256-SHA256",
        publicKeyDer,
        message,
        signature: mockBypassSignature,
      });

      expect(isValid).toBe(false);
    });

    it("fails closed on corrupted public key DER bytes", () => {
      const corruptedKey = Buffer.alloc(64, 0xef);
      const message = Buffer.from("PLINTHLY-ATTESTATION-V1|cart_01");
      const sig = crypto.randomBytes(64);

      const isValid = verifyAsymmetricSignature({
        algorithm: "ECDSA-P256-SHA256",
        publicKeyDer: corruptedKey,
        message,
        signature: sig,
      });

      expect(isValid).toBe(false);
    });

    it("fails closed on unsupported algorithm", () => {
      const { publicKeyDer, privateKeyDer } = generateAsymKeyPair("ECDSA-P256-SHA256");
      const message = Buffer.from("test");
      const signature = signAsymmetric({
        algorithm: "ECDSA-P256-SHA256",
        privateKeyDer,
        message,
      });

      const isValid = verifyAsymmetricSignature({
        algorithm: "INVALID-ALGO-2026",
        publicKeyDer,
        message,
        signature,
      });

      expect(isValid).toBe(false);
    });
  });
});

