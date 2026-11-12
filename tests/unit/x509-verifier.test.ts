import { describe, it, expect } from "vitest";
import { verifyCertificateChain, isHostAllowed, parseX509Certificate } from "../../lib/crypto/x509-verifier";
import { TEST_ROOT_CA_PEM, TEST_LEAF_CERT_PEM, TEST_UNRELATED_ROOT_CA_PEM } from "../fixtures/test-certificates";

describe("X.509 Certificate Verifier & Root CA Pinning", () => {
  it("verifies genuine leaf certificate against pinned root CA", () => {
    const result = verifyCertificateChain({
      leafCert: TEST_LEAF_CERT_PEM,
      pinnedRootCerts: [
        {
          authorityId: "AUTH-US-TAXJAR",
          rootCertPem: TEST_ROOT_CA_PEM,
        },
      ],
      expectedHost: "taxjar.test",
      requireDigitalSignatureUsage: false, // basic test cert
      referenceTime: new Date("2026-11-07T12:00:00Z"),
    });

    expect(result.valid).toBe(true);
    expect(result.matchedTrustAnchor).toBe("AUTH-US-TAXJAR");
    expect(result.subject).toContain("taxjar.test");
    expect(result.issuer).toContain("TestRootCA");
    expect(Buffer.isBuffer(result.publicKeyDer)).toBe(true);
    expect(result.publicKeyDer.length).toBeGreaterThan(64);
  });

  it("fails closed when certificate is expired", () => {
    expect(() =>
      verifyCertificateChain({
        leafCert: TEST_LEAF_CERT_PEM,
        pinnedRootCerts: [TEST_ROOT_CA_PEM],
        referenceTime: new Date("2028-01-01T00:00:00Z"), // well past 2027 expiration
        requireDigitalSignatureUsage: false,
      })
    ).toThrow("ERR_CERTIFICATE_EXPIRED");
  });

  it("fails closed when certificate is not yet valid", () => {
    expect(() =>
      verifyCertificateChain({
        leafCert: TEST_LEAF_CERT_PEM,
        pinnedRootCerts: [TEST_ROOT_CA_PEM],
        referenceTime: new Date("2020-01-01T00:00:00Z"), // prior to 2026 creation
        requireDigitalSignatureUsage: false,
      })
    ).toThrow("ERR_CERTIFICATE_EXPIRED");
  });

  it("fails closed when certificate does not chain to any pinned trust anchor", () => {
    expect(() =>
      verifyCertificateChain({
        leafCert: TEST_LEAF_CERT_PEM,
        pinnedRootCerts: [TEST_UNRELATED_ROOT_CA_PEM],
        referenceTime: new Date("2026-11-07T12:00:00Z"),
        requireDigitalSignatureUsage: false,
      })
    ).toThrow("ERR_UNTRUSTED_ROOT_CA");
  });

  it("fails closed when expected host domain does not match", () => {
    expect(() =>
      verifyCertificateChain({
        leafCert: TEST_LEAF_CERT_PEM,
        pinnedRootCerts: [TEST_ROOT_CA_PEM],
        expectedHost: "unauthorized.attacker.com",
        referenceTime: new Date("2026-11-07T12:00:00Z"),
        requireDigitalSignatureUsage: false,
      })
    ).toThrow("ERR_CERTIFICATE_DOMAIN_MISMATCH");
  });

  it("fails closed on malformed certificate data", () => {
    expect(() =>
      verifyCertificateChain({
        leafCert: "NOT_A_CERTIFICATE",
        pinnedRootCerts: [TEST_ROOT_CA_PEM],
      })
    ).toThrow("ERR_MALFORMED_CERTIFICATE");
  });

  it("fails closed when no pinned roots are provided", () => {
    expect(() =>
      verifyCertificateChain({
        leafCert: TEST_LEAF_CERT_PEM,
        pinnedRootCerts: [],
      })
    ).toThrow("ERR_NO_TRUST_ANCHORS");
  });
});

