import crypto from "crypto";

export interface PinnedTrustAnchor {
  authorityId: string;
  rootCertPem: string;
  allowedDomainPattern?: RegExp;
}

export interface VerifyChainOptions {
  leafCert: string | Buffer;
  intermediateCerts?: (string | Buffer)[];
  pinnedRootCerts: (string | Buffer | PinnedTrustAnchor)[];
  expectedHost?: string;
  requireDigitalSignatureUsage?: boolean;
  referenceTime?: Date;
}

export interface VerifiedCertificateResult {
  valid: boolean;
  leafCertificate: crypto.X509Certificate;
  publicKeyDer: Buffer;
  publicKeyObject: crypto.KeyObject;
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  matchedTrustAnchor?: string;
}

/**
 * Parses a certificate input (PEM string or DER/PEM Buffer) into an X509Certificate object.
 * Returns null if malformed.
 */
export function parseX509Certificate(certInput: string | Buffer): crypto.X509Certificate | null {
  try {
    return new crypto.X509Certificate(certInput);
  } catch {
    return null;
  }
}

/**
 * Validates whether an X.509 certificate permits digital signature usage (RFC 5280).
 */
export function hasDigitalSignatureKeyUsage(cert: crypto.X509Certificate): boolean {
  if (cert.keyUsage && Array.isArray(cert.keyUsage) && cert.keyUsage.length > 0) {
    return cert.keyUsage.some(
      (usage) => usage.toLowerCase().includes("digital signature") || usage.toLowerCase().includes("digitalsignature")
    );
  }

  // Parse ASN.1 DER for OID 2.5.29.15 (Key Usage: 55 1d 0f)
  const raw = cert.raw;
  const kuOid = Buffer.from([0x55, 0x1d, 0x0f]);
  const idx = raw.indexOf(kuOid);
  if (idx !== -1) {
    let offset = idx + 3;
    if (raw[offset] === 0x01 && raw[offset + 1] === 0x01) {
      offset += 3;
    }
    if (raw[offset] === 0x04) {
      const bitStringTag = raw[offset + 2];
      if (bitStringTag === 0x03) {
        const bitStringByte = raw[offset + 5];
        return (bitStringByte & 0x80) !== 0;
      }
    }
  }

  return false;
}

/**
 * Validates whether a certificate matches an expected host/domain pattern (via SAN or CN).
 */
export function isHostAllowed(cert: crypto.X509Certificate, expectedHost: string): boolean {
  if (!expectedHost) return true;
  // Node.js native checkHost checks SAN and Subject CN against the host
  const match = cert.checkHost(expectedHost);
  return typeof match === "string" && match.length > 0;
}

/**
 * Verifies an X.509 leaf certificate against intermediate certificates and a pinned root CA trust store.
 * 
 * Enforces:
 * 1. Validity period: notBefore <= referenceTime <= notAfter.
 * 2. Key usage: includes digitalSignature if required.
 * 3. Host / domain validation if expectedHost is provided.
 * 4. Cryptographic chain validation from leaf to a trusted pinned root anchor.
 * 
 * Fails closed on any error or expired/untrusted certificate.
 */
export function verifyCertificateChain(options: VerifyChainOptions): VerifiedCertificateResult {
  const {
    leafCert,
    intermediateCerts = [],
    pinnedRootCerts,
    expectedHost,
    requireDigitalSignatureUsage = true,
    referenceTime = new Date(),
  } = options;

  const leaf = parseX509Certificate(leafCert);
  if (!leaf) {
    throw new Error("ERR_MALFORMED_CERTIFICATE: Leaf certificate could not be parsed.");
  }

  // 1. Root Trust Anchors Presence Check
  if (!pinnedRootCerts || pinnedRootCerts.length === 0) {
    throw new Error("ERR_NO_TRUST_ANCHORS: No valid pinned root CA certificates provided.");
  }

  // 2. Validity Period Check
  const validFrom = new Date(leaf.validFrom);
  const validTo = new Date(leaf.validTo);
  if (referenceTime < validFrom || referenceTime > validTo) {
    throw new Error(`ERR_CERTIFICATE_EXPIRED: Certificate is outside validity window (${leaf.validFrom} to ${leaf.validTo}).`);
  }

  // 2. Key Usage Check (digitalSignature)
  if (requireDigitalSignatureUsage) {
    if (!hasDigitalSignatureKeyUsage(leaf)) {
      throw new Error("ERR_INVALID_KEY_USAGE: Certificate does not permit digital signature usage.");
    }
  }

  // 3. Host / Domain Verification
  if (expectedHost && !isHostAllowed(leaf, expectedHost)) {
    throw new Error(`ERR_CERTIFICATE_DOMAIN_MISMATCH: Certificate does not match expected host "${expectedHost}".`);
  }

  // 4. Parse intermediates and pinned roots
  const intermediates = intermediateCerts
    .map((c) => parseX509Certificate(c))
    .filter((c): c is crypto.X509Certificate => c !== null);

  const roots: { cert: crypto.X509Certificate; anchorId?: string; allowedPattern?: RegExp }[] = [];
  for (const root of pinnedRootCerts) {
    if (typeof root === "object" && "rootCertPem" in root) {
      const parsed = parseX509Certificate(root.rootCertPem);
      if (parsed) {
        roots.push({ cert: parsed, anchorId: root.authorityId, allowedPattern: root.allowedDomainPattern });
      }
    } else {
      const parsed = parseX509Certificate(root);
      if (parsed) {
        roots.push({ cert: parsed });
      }
    }
  }

  if (roots.length === 0) {
    throw new Error("ERR_NO_TRUST_ANCHORS: No valid pinned root CA certificates provided.");
  }

  // 5. Build and verify signature chain
  // Check if leaf is directly signed by one of the roots
  let matchedRoot: { cert: crypto.X509Certificate; anchorId?: string } | null = null;

  for (const r of roots) {
    if (leaf.verify(r.cert.publicKey)) {
      matchedRoot = r;
      break;
    }
  }

  // If not directly signed by a root, try chain through intermediates
  if (!matchedRoot && intermediates.length > 0) {
    let currentCert = leaf;
    const chain: crypto.X509Certificate[] = [leaf];

    for (let depth = 0; depth < 5; depth++) {
      let issuerCert: crypto.X509Certificate | null = null;
      for (const inter of intermediates) {
        if (currentCert.verify(inter.publicKey)) {
          issuerCert = inter;
          break;
        }
      }

      if (issuerCert) {
        chain.push(issuerCert);
        currentCert = issuerCert;
        // Check if this issuer is signed by a root
        for (const r of roots) {
          if (currentCert.verify(r.cert.publicKey)) {
            matchedRoot = r;
            break;
          }
        }
        if (matchedRoot) break;
      } else {
        break;
      }
    }
  }

  if (!matchedRoot) {
    throw new Error("ERR_UNTRUSTED_ROOT_CA: Certificate chain does not anchor to any pinned root CA.");
  }

  // Extract public key in SPKI DER format
  const pubKey = leaf.publicKey;
  const publicKeyDer = pubKey.export({ type: "spki", format: "der" });

  return {
    valid: true,
    leafCertificate: leaf,
    publicKeyDer,
    publicKeyObject: pubKey,
    subject: leaf.subject,
    issuer: leaf.issuer,
    validFrom,
    validTo,
    matchedTrustAnchor: matchedRoot.anchorId,
  };
}

