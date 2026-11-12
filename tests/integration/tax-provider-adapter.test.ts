import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import crypto from "crypto";
import { Client } from "pg";
import {
  MockTaxProviderAdapter,
  TaxCalculationRequest,
} from "../../lib/tax/tax-provider-adapter";
import { TaxJarAdapter } from "../../lib/tax/taxjar-adapter";
import { AvalaraAdapter } from "../../lib/tax/avalara-adapter";
import { StatutoryAttestationBuilder } from "../../lib/tax/statutory-attestation-builder";
import { LocalTestKmsSignerClient } from "../../lib/security/kms-signer";
import { verifyAsymmetricSignature } from "../../lib/security/asym-verifier";
import { TaxProviderIngressWorker } from "../../lib/workers/tax-ingress-worker";
import {
  createStage2Client,
  ensureRolesExist,
  createTestTaxCert,
  createTestKeys,
  createTestCartFixture,
} from "../database/helpers/routine-test-helper";
import {
  TEST_ROOT_CA_PEM,
  TEST_LEAF_CERT_PEM,
  TEST_LEAF_PRIVATE_KEY_PEM,
} from "../fixtures/test-certificates";

describe("Stage 3 Phase 2 — Certified Tax Provider Adapters & C-44A Attestation", () => {
  let client: Client;
  const authorityId = "AUTH-US-TAXJAR";
  const certNumber = "CERT-TAXJAR-2026";
  const attestKeyId = "vak_tax_worker_stage3_p2";
  const hmacKeyId = "audit_hmac_key_stage3_p2";
  const workerPrincipal = "tax_worker_01";
  let workerPubKeyBytes: Buffer;
  const originalAuthMode = process.env.AUTH_MODE;

  beforeAll(async () => {
    process.env.AUTH_MODE = "local_demo";
    client = await createStage2Client();
    await ensureRolesExist(client);
    await createTestTaxCert(client, authorityId, certNumber);
    const keys = await createTestKeys(client, attestKeyId, hmacKeyId, workerPrincipal);
    workerPubKeyBytes = keys.pubKeyBytes;
  });

  afterAll(async () => {
    if (originalAuthMode !== undefined) {
      process.env.AUTH_MODE = originalAuthMode;
    } else {
      delete process.env.AUTH_MODE;
    }
    await client.end();
  });

  beforeEach(async () => {
    await client.query("RESET SESSION AUTHORIZATION;");
  });

  // PRV-06: Multi-State Tax Quote Precision
  describe("PRV-06: Multi-State Tax Quote Precision (5 Benchmark Jurisdictions)", () => {
    const adapter = new MockTaxProviderAdapter();

    const jurisdictionsToTest = [
      {
        state: "CA",
        postalCode: "94103",
        expectedRateBps: 825, // 8.25%
        taxesShipping: false,
        name: "California",
      },
      {
        state: "NY",
        postalCode: "10001",
        expectedRateBps: 888, // 8.875%
        taxesShipping: true,
        name: "New York",
      },
      {
        state: "TX",
        postalCode: "75001",
        expectedRateBps: 825, // 8.25%
        taxesShipping: true,
        name: "Texas",
      },
      {
        state: "PA",
        postalCode: "15201",
        expectedRateBps: 700, // 7.00%
        taxesShipping: true,
        name: "Pennsylvania",
      },
      {
        state: "FL",
        postalCode: "33101",
        expectedRateBps: 700, // 7.00%
        taxesShipping: true,
        name: "Florida",
      },
    ];

    for (const jur of jurisdictionsToTest) {
      it(`calculates exact minor-unit tax for ${jur.name} (${jur.state}) with zero rounding drift`, async () => {
        const cartId = `cart_test_${jur.state}_${Date.now()}`;
        const shippingCents = 1500; // $15.00 shipping

        const request: TaxCalculationRequest = {
          cartId,
          toAddress: {
            state: jur.state,
            postalCode: jur.postalCode,
            country: "US",
          },
          shippingCents,
          lineItems: [
            {
              id: "item_001",
              description: "Widget A",
              unitPriceCents: 4999, // $49.99
              quantity: 2,
              taxableCents: 9998,   // $99.98
            },
            {
              id: "item_002",
              description: "Widget B",
              unitPriceCents: 1250, // $12.50
              quantity: 1,
              taxableCents: 1250,   // $12.50
            },
          ],
        };

        const result = await adapter.calculateTaxQuote(request);

        // 1. Invariant: Effective rate matches benchmark
        expect(result.effectiveRateBps).toBe(jur.expectedRateBps);

        // 2. Invariant: merchandiseTaxCents + shippingTaxCents === totalTaxCents
        expect(result.merchandiseTaxCents + result.shippingTaxCents).toBe(result.totalTaxCents);

        // 3. Invariant: Sum of individual line item taxes equals merchandiseTaxCents
        const lineItemTaxSum = result.lineItems.reduce((acc, i) => acc + i.taxCollectedCents, 0);
        expect(lineItemTaxSum).toBe(result.merchandiseTaxCents);

        // 4. Invariant: Shipping tax obeys state rules
        if (jur.taxesShipping) {
          const expectedShipTax = Math.round((shippingCents * jur.expectedRateBps) / 10000);
          expect(result.shippingTaxCents).toBe(expectedShipTax);
        } else {
          expect(result.shippingTaxCents).toBe(0);
        }

        // 5. Invariant: Zero floating-point drift (all values are exact integer cents)
        expect(Number.isInteger(result.totalTaxCents)).toBe(true);
        expect(Number.isInteger(result.merchandiseTaxCents)).toBe(true);
        expect(Number.isInteger(result.shippingTaxCents)).toBe(true);
      });
    }
  });

  // PRV-05: Certified Tax Provider Attestation & KMS Signing
  describe("PRV-05: Certified Tax Provider Attestation (C-44A / KMS Signing)", () => {
    it("assembles canonical C-44A buffer and signs via KMS client", async () => {
      const adapter = new MockTaxProviderAdapter();
      const kmsClient = new LocalTestKmsSignerClient();

      // Register test keypair with test KMS
      const keypair = crypto.generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
        publicKeyEncoding: { type: "spki", format: "der" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      kmsClient.registerKey(attestKeyId, keypair.privateKey, keypair.publicKey, "ECDSA-P256-SHA256");

      const cartId = `cart_attest_${Date.now()}`;
      const quote = await adapter.calculateTaxQuote({
        cartId,
        toAddress: { state: "CA", postalCode: "94103", country: "US" },
        shippingCents: 1000,
        lineItems: [
          {
            id: "line_01",
            unitPriceCents: 10000,
            quantity: 1,
            taxableCents: 10000,
          },
        ],
      });

      const merchandiseSubtotalCents = 10000;
      const shippingCents = 1000;
      const totalCents = merchandiseSubtotalCents + shippingCents + quote.totalTaxCents;

      const attestationPkg = await StatutoryAttestationBuilder.buildAndSignAttestation({
        result: quote,
        authorityId,
        certificateNumber: certNumber,
        attestationKeyId: attestKeyId,
        kmsSignerClient: kmsClient,
        merchandiseSubtotalCents,
        shippingCents,
        totalCents,
      });

      // 1. Verify buffer starts with canonical C-44A header
      expect(attestationPkg.canonicalString.startsWith("PLINTHLY-ATTESTATION-V1|")).toBe(true);

      // 2. Verify pipe-delimited structure has 23 fields
      const parts = attestationPkg.canonicalString.split("|");
      expect(parts.length).toBe(23);
      expect(parts[1]).toBe(cartId);
      expect(parts[2]).toBe(quote.quoteId);
      expect(parts[3]).toBe("mock");
      expect(parts[4]).toBe("2026-03-01");

      // 3. Verify digital signature validates using OpenSSL asymmetric verifier
      const isValid = verifyAsymmetricSignature({
        algorithm: "ECDSA-P256-SHA256",
        publicKeyDer: keypair.publicKey,
        message: attestationPkg.canonicalBuffer,
        signature: attestationPkg.attestationSignature,
      });
      expect(isValid).toBe(true);
    });

    it("executes TaxProviderIngressWorker and records quote into PostgreSQL via R2-01", async () => {
      const adapter = new MockTaxProviderAdapter();
      const cart = await createTestCartFixture(client, "BUYER_APPROVED", 10000, 0, 1200, 0);
      const cartId = cart.cartId;

      const quote = await adapter.calculateTaxQuote({
        cartId,
        toAddress: { state: "CA", postalCode: "94103", country: "US" },
        shippingCents: 1200,
        lineItems: [
          {
            id: crypto.randomUUID(),
            unitPriceCents: 5000,
            quantity: 2,
            taxableCents: 10000,
          },
        ],
      });

      // Prepare leaf certificate with matching private key for external provider signature
      const leafCertPem = TEST_LEAF_CERT_PEM;
      const leafPrivKeyPem = TEST_LEAF_PRIVATE_KEY_PEM;

      // Update quote JSON signature_algorithm to match RSA leaf cert
      const payloadObj = JSON.parse(quote.rawWirePayload.toString("utf8"));
      payloadObj.signature_algorithm = "RSA-SHA256";
      const rsaWirePayload = Buffer.from(JSON.stringify(payloadObj), "utf8");

      // Sign rsaWirePayload using test leaf private key so it matches pinned trust anchor
      const signer = crypto.createSign("sha256");
      signer.update(rsaWirePayload);
      const statutorySig = signer.sign(leafPrivKeyPem);

      const worker = new TaxProviderIngressWorker({
        workerInstanceId: "tax_worker_stage3_01",
        workerPrincipal,
        attestationKeyId: attestKeyId,
        workerPublicKeyDer: workerPubKeyBytes,
        workerSigningAlgorithm: "ECDSA-P256-SHA256",
        pinnedTrustAnchors: [
          {
            authorityId,
            rootCertPem: TEST_ROOT_CA_PEM,
          },
        ],
        internalHmacKeyId: hmacKeyId,
      });

      // Authenticate session as workerPrincipal (tax_worker_01) with tax_verifier_role
      await client.query(`SET SESSION AUTHORIZATION ${workerPrincipal};`);

      const ingressResult = await worker.processStatutoryQuote({
        cartId,
        authorityId,
        certificateNumber: certNumber,
        providerLeafCertPem: leafCertPem,
        expectedHost: "taxjar.test",
        rawWirePayload: rsaWirePayload,
        statutorySignature: statutorySig,
        statutorySignatureAlgorithm: "RSA-SHA256",
        client,
      });

      expect(ingressResult.cartId).toBe(cartId);
      expect(ingressResult.totalTaxCents).toBe(quote.totalTaxCents);
      expect(ingressResult.status).toBe("VERIFIED");
      expect(ingressResult.evidenceId).toBeDefined();

      // Reset session authorization
      await client.query("RESET SESSION AUTHORIZATION;");
    });
  });

  // TaxJar & Avalara Adapters Normalization
  describe("TaxJar & Avalara Adapters Normalization", () => {
    it("normalizes TaxJar JSON breakdown with zero rounding drift", async () => {
      const mockTaxJarResponse = {
        tax: {
          order_total_amount: 110.0,
          shipping: 10.0,
          taxable_amount: 100.0,
          amount_to_collect: 8.25,
          rate: 0.0825,
          has_nexus: true,
          freight_taxable: false,
          tax_source: "destination",
          breakdown: {
            taxable_amount: 100.0,
            tax_collectable: 8.25,
            combined_tax_rate: 0.0825,
            state_taxable_amount: 100.0,
            state_tax_rate: 0.06,
            state_tax_collectable: 6.0,
            county_taxable_amount: 100.0,
            county_tax_rate: 0.0125,
            county_tax_collectable: 1.25,
            city_taxable_amount: 0.0,
            city_tax_rate: 0.0,
            city_tax_collectable: 0.0,
            special_district_taxable_amount: 100.0,
            special_district_tax_rate: 0.01,
            special_district_tax_collectable: 1.0,
            shipping: {
              taxable_amount: 0.0,
              tax_collectable: 0.0,
              combined_tax_rate: 0.0,
            },
            line_items: [
              {
                id: "item_tj_01",
                taxable_amount: 100.0,
                tax_collectable: 8.25,
                combined_tax_rate: 0.0825,
              },
            ],
          },
        },
      };

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockTaxJarResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const adapter = new TaxJarAdapter({
        apiKey: "test_key",
        fetchFn: mockFetch as any,
      });

      const quote = await adapter.calculateTaxQuote({
        cartId: "cart_tj_001",
        toAddress: { state: "CA", postalCode: "94103", country: "US" },
        shippingCents: 1000,
        lineItems: [
          {
            id: "item_tj_01",
            unitPriceCents: 10000,
            quantity: 1,
            taxableCents: 10000,
          },
        ],
      });

      expect(quote.totalTaxCents).toBe(825);
      expect(quote.merchandiseTaxCents).toBe(825);
      expect(quote.shippingTaxCents).toBe(0);
      expect(quote.lineItems[0].taxCollectedCents).toBe(825);
      expect(quote.jurisdictions.length).toBe(3); // State, County, Special
    });

    it("normalizes Avalara AvaTax JSON breakdown with zero rounding drift", async () => {
      const mockAvaTaxResponse = {
        id: 1234567,
        code: "DOC-cart_av_001",
        companyId: 1,
        date: "2026-11-07",
        status: "Saved",
        type: "SalesOrder",
        totalAmount: 110.0,
        totalTax: 8.88,
        totalTaxable: 110.0,
        lines: [
          {
            id: 1,
            itemCode: "item_av_01",
            taxableAmount: 100.0,
            tax: 8.07,
            rate: 0.0807,
          },
          {
            id: 2,
            itemCode: "SHIPPING",
            taxableAmount: 10.0,
            tax: 0.81,
            rate: 0.0807,
          },
        ],
        summary: [
          {
            jurisType: "State",
            jurisCode: "36",
            jurisName: "NEW YORK",
            taxable: 110.0,
            rate: 0.04,
            tax: 4.4,
          },
          {
            jurisType: "City",
            jurisCode: "8000",
            jurisName: "NEW YORK CITY",
            taxable: 110.0,
            rate: 0.045,
            tax: 4.95,
          },
        ],
      };

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockAvaTaxResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const adapter = new AvalaraAdapter({
        accountId: "test_account",
        licenseKey: "test_key",
        fetchFn: mockFetch as any,
      });

      const quote = await adapter.calculateTaxQuote({
        cartId: "cart_av_001",
        toAddress: { state: "NY", postalCode: "10001", country: "US" },
        shippingCents: 1000,
        lineItems: [
          {
            id: "item_av_01",
            unitPriceCents: 10000,
            quantity: 1,
            taxableCents: 10000,
          },
        ],
      });

      expect(quote.totalTaxCents).toBe(888);
      expect(quote.merchandiseTaxCents).toBe(807);
      expect(quote.shippingTaxCents).toBe(81);
      expect(quote.lineItems[0].taxCollectedCents).toBe(807);
      expect(quote.jurisdictions.length).toBe(2);
    });
  });
});
