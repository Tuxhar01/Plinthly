import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import { setActorResolver, ServerActorResolver } from "../../lib/workflow/auth";
import { POST as quoteTaxRoute } from "../../app/api/cart/quote-tax/route";
import { POST as checkoutRoute } from "../../app/api/cart/checkout/route";
import { POST as captureRoute } from "../../app/api/cart/capture/route";
import { POST as webhookRoute } from "../../app/api/webhooks/paypal/route";
import { POST as revokeRoute } from "../../app/api/admin/keys/revoke/route";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestTaxCert,
  createTestKeys,
} from "../database/helpers/routine-test-helper";
import {
  TEST_ROOT_CA_PEM,
  TEST_LEAF_CERT_PEM,
  TEST_LEAF_PRIVATE_KEY_PEM,
  TEST_PAYPAL_ROOT_CA_PEM,
  TEST_PAYPAL_LEAF_CERT_PEM,
  TEST_PAYPAL_LEAF_PRIVATE_KEY_PEM,
} from "../fixtures/test-certificates";
import { computePayPalCrc32, formatPayPalSignatureMessage } from "../../lib/crypto/paypal-crc32";

describe("Phase 5: Next.js REST Route Handlers Acceptance Suite", () => {
  let masterClient: Client;
  const authorityId = "AUTH-API-TEST";
  const certNumber = "CERT-API-TEST-2026";
  const attestKeyId = "vak_tax_worker_p3_01";
  const hmacKeyId = "audit_hmac_key_p3";

  beforeAll(async () => {
    masterClient = await createStage2Client();
    await ensureRolesExist(masterClient);
    await createTestTaxCert(masterClient, authorityId, certNumber);
    await createTestKeys(masterClient, attestKeyId, hmacKeyId, "tax_worker_01");
  });

  beforeEach(async () => {
    process.env.AUTH_MODE = "local_demo";
    process.env.ENABLE_LOCAL_DEMO_AUTH = "true";
    setActorResolver(new ServerActorResolver("local_demo"));
    try {
      await masterClient.query(
        `DELETE FROM public."WebhookEventQueue" WHERE transmission_id LIKE 'tx_wh_route_%';`
      );
    } catch {}
  });

  afterAll(async () => {
    try {
      await masterClient.query(
        `DELETE FROM public."WebhookEventQueue" WHERE transmission_id LIKE 'tx_wh_route_%';`
      );
    } catch {}
    await masterClient.end();
  });

  function signWireBytes(bytes: Buffer): Buffer {
    const sign = crypto.createSign("sha256");
    sign.update(bytes);
    return sign.sign(TEST_LEAF_PRIVATE_KEY_PEM);
  }

  // ==========================================================================
  // 1. POST /api/cart/quote-tax
  // ==========================================================================
  describe("POST /api/cart/quote-tax", () => {
    it("returns 200 with verified tax evidence and updates cart total", async () => {
      const cart = await createTestCartFixture(masterClient, "BUYER_APPROVED", 2500, 500, 1000, 0);
      const quoteId = "quote_api_" + crypto.randomUUID();
      const ts = new Date();
      const validUntil = new Date(Date.now() + 3600000);
      const lineItemId = crypto.randomUUID();

      const wireObj = {
        id: quoteId,
        provider: "TAXJAR",
        version: "v2.2026.1",
        signature_algorithm: "RSA-SHA256",
        currency: "USD",
        timestamp: ts.toISOString(),
        expires_at: validUntil.toISOString(),
        jurisdiction: "US-CA",
        order_subtotal: "25.00",
        discount_amount: "5.00",
        shipping: "10.00",
        adjustment: "0.00",
        total_amount: "32.40",
        amount_to_collect: "2.40",
        breakdown: {
          line_items_total: "1.60",
          shipping_tax: "0.80",
          taxable_shipping: "10.00",
        },
        line_items: [
          {
            id: lineItemId,
            subtotal: "25.00",
            discount: "5.00",
            taxable_amount: "20.00",
            tax_collectable: "1.60",
            exemption_code: null,
            taxability_status: "TAXABLE",
          },
        ],
        jurisdictions: [
          {
            type: "STATE",
            code: "US-CA",
            name: "California",
            rate_bps: 800,
            amount: "2.40",
            applies_to_shipping: true,
          },
        ],
      };

      const rawBytes = Buffer.from(JSON.stringify(wireObj), "utf8");
      const sig = signWireBytes(rawBytes);

      const req = new Request("http://localhost:3000/api/cart/quote-tax", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "test_buyer_01",
        },
        body: JSON.stringify({
          cartId: cart.cartId,
          authorityId,
          certificateNumber: certNumber,
          providerLeafCertPem: TEST_LEAF_CERT_PEM,
          expectedHost: "taxjar.test",
          rawWirePayload: wireObj,
          statutorySignature: sig.toString("base64"),
          statutorySignatureAlgorithm: "RSA-SHA256",
        }),
      });

      const res = await quoteTaxRoute(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.cartId).toBe(cart.cartId);
      expect(data.status).toBe("VERIFIED");
      expect(data.totalTaxCents).toBe(240);
      expect(data.evidenceId).toBeDefined();
    });

    it("returns 400 when statutory signature is forged", async () => {
      const cart = await createTestCartFixture(masterClient, "BUYER_APPROVED", 2500, 500, 1000, 0);

      const req = new Request("http://localhost:3000/api/cart/quote-tax", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "test_buyer_01",
        },
        body: JSON.stringify({
          cartId: cart.cartId,
          authorityId,
          certificateNumber: certNumber,
          providerLeafCertPem: TEST_LEAF_CERT_PEM,
          rawWirePayload: { order_subtotal: "25.00" },
          statutorySignature: Buffer.alloc(128, 0xef).toString("base64"), // Forged signature
          statutorySignatureAlgorithm: "RSA-SHA256",
        }),
      });

      const res = await quoteTaxRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("ERR_TAX_VALIDATION_FAILED");
    });
  });

  // ==========================================================================
  // 2. POST /api/cart/checkout
  // ==========================================================================
  describe("POST /api/cart/checkout", () => {
    it("returns 200 with BUYER_APPROVED carts when landed cost is zero-variance", async () => {
      // 2500 - 500 + 1000 + 0 = 3000
      const fixture = await createTestCartFixture(masterClient, "READY", 2500, 500, 1000, 0);

      const req = new Request("http://localhost:3000/api/cart/checkout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "test_buyer_01",
        },
        body: JSON.stringify({
          approvalAggregateId: fixture.aggregateId,
        }),
      });

      const res = await checkoutRoute(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("BUYER_APPROVED");
      expect(data.carts.length).toBeGreaterThan(0);
      expect(data.carts[0].checkoutStatus).toBe("BUYER_APPROVED");
    });

    it("returns 400 when cart total violates landed cost equation", async () => {
      const planId = crypto.randomUUID();
      const aggregateId = crypto.randomUUID();
      const cartId = crypto.randomUUID();

      await masterClient.query(`
        INSERT INTO public."ProcurementPlan" (id, "userId", strategy, "lifecycleStatus", "createdAt", "updatedAt")
        VALUES ($1, $2, 'BALANCED', 'ACTIVE', clock_timestamp(), clock_timestamp());
      `, [planId, crypto.randomUUID()]);

      await masterClient.query(`
        INSERT INTO public."ApprovalAggregate" (id, "planId", "aggregateStatus", "snapshotDigest", "snapshotPayload", "approvedAt", "createdAt")
        VALUES ($1, $2, 'APPROVED', $3, '{}'::jsonb, clock_timestamp(), clock_timestamp());
      `, [aggregateId, planId, Buffer.from("bad-cart-snapshot")]);

      // Intentionally insert corrupt totalCartCents = 9999 (should be 3000)
      await masterClient.query(`
        INSERT INTO public."ApprovedMerchantCart" (
          id, "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
          "paypalOrderId", "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
          "taxAmountCents", "totalCartCents", "cumulativeRefundedCents", "createdAt", "updatedAt"
        ) VALUES ($1, $2, 'm_bad', 'bad@example.com', 'READY', 'ORD-BAD', 2500, 500, 1000, 0, 9999, 0, clock_timestamp(), clock_timestamp());
      `, [cartId, aggregateId]);

      const req = new Request("http://localhost:3000/api/cart/checkout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "test_buyer_01",
        },
        body: JSON.stringify({
          approvalAggregateId: aggregateId,
        }),
      });

      const res = await checkoutRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("ERR_LANDED_COST_MISMATCH");
    });
  });

  // ==========================================================================
  // 3. POST /api/cart/capture
  // ==========================================================================
  describe("POST /api/cart/capture", () => {
    it("returns 200 with PREPARED_AWAITING_WEBHOOK or CAPTURED outcome", async () => {
      const fixture = await createTestCartFixture(masterClient, "BUYER_APPROVED", 2500, 500, 1000, 0, "merchant@example.com", "ORD-CAP-ROUTE-1");

      const req = new Request("http://localhost:3000/api/cart/capture", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "test_buyer_01",
        },
        body: JSON.stringify({
          cartId: fixture.cartId,
          approvalAggregateId: fixture.aggregateId,
        }),
      });

      const res = await captureRoute(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.cartId).toBe(fixture.cartId);
      expect(["PREPARED_AWAITING_WEBHOOK", "COMPLETED", "CAPTURING", "CAPTURED"]).toContain(data.outcome || data.status);
    });

    it("returns 404 when cartId does not exist", async () => {
      const req = new Request("http://localhost:3000/api/cart/capture", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "test_buyer_01",
        },
        body: JSON.stringify({
          cartId: crypto.randomUUID(),
          approvalAggregateId: crypto.randomUUID(),
        }),
      });

      const res = await captureRoute(req);
      expect(res.status).toBe(404);
    });
  });

  // ==========================================================================
  // 4. POST /api/webhooks/paypal
  // ==========================================================================
  describe("POST /api/webhooks/paypal", () => {
    it("returns 200 with verified ingress and payment reconciliation", async () => {
      const orderId = "ORD-WH-ROUTE-" + crypto.randomUUID();
      const captureId = "CAP-WH-ROUTE-" + crypto.randomUUID();
      const txId = "tx_wh_route_" + crypto.randomUUID();
      const fixture = await createTestCartFixture(masterClient, "CAPTURING", 2000, 0, 0, 0, "merchant@example.com", orderId);

      const payloadObj = {
        id: "WH-EV-" + crypto.randomUUID(),
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
          id: captureId,
          amount: { value: "20.00", currency_code: "USD" },
          payee: { email_address: "merchant@example.com" },
          supplementary_data: { related_ids: { order_id: orderId, capture_id: captureId } },
        },
      };

      const rawPayload = Buffer.from(JSON.stringify(payloadObj), "utf8");
      const txTime = new Date().toISOString();

      // Sign canonical signature message
      const sigMsg = formatPayPalSignatureMessage({
        transmissionId: txId,
        transmissionTime: txTime,
        webhookId: "WH_STAGE2_DEFAULT",
        rawPayload,
      });

      const sign = crypto.createSign("sha256");
      sign.update(sigMsg);
      const sig = sign.sign(TEST_PAYPAL_LEAF_PRIVATE_KEY_PEM);

      const req = new Request("http://localhost:3000/api/webhooks/paypal", {
        method: "POST",
        headers: {
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-ROUTE",
          "paypal-transmission-id": txId,
          "paypal-transmission-sig": sig.toString("base64"),
          "paypal-transmission-time": txTime,
          "x-paypal-cert-pem": encodeURIComponent(TEST_PAYPAL_LEAF_CERT_PEM),
        },
        body: rawPayload,
      });

      const res = await webhookRoute(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.received).toBe(true);
      expect(data.transmissionId).toBe(txId);
      expect(data.eventType).toBe("PAYMENT.CAPTURE.COMPLETED");
      expect(data.reconciliation.reconciled).toBe(true);
      expect(data.reconciliation.cartId).toBe(fixture.cartId);
    });

    it("returns 400 when required PayPal headers are missing", async () => {
      const req = new Request("http://localhost:3000/api/webhooks/paypal", {
        method: "POST",
        headers: {},
        body: Buffer.from("{}"),
      });

      const res = await webhookRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("ERR_MISSING_WEBHOOK_HEADERS");
    });
  });

  // ==========================================================================
  // 5. POST /api/admin/keys/revoke
  // ==========================================================================
  describe("POST /api/admin/keys/revoke", () => {
    it("returns 200 and revokes key under authorized admin identity", async () => {
      const keyToRevoke = "vak_rev_test_" + crypto.randomUUID();
      await createTestKeys(masterClient, keyToRevoke, "hmac_unused_" + crypto.randomUUID(), "tax_worker_01");

      const req = new Request("http://localhost:3000/api/admin/keys/revoke", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "security_admin_user",
        },
        body: JSON.stringify({
          targetType: "AUDIT_SIGNING_KEY",
          keyId: keyToRevoke,
          reason: "Routine key rotation",
        }),
      });

      const res = await revokeRoute(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.revoked).toBe(true);
      expect(data.keyId).toBe(keyToRevoke);
      expect(data.status).toBe("REVOKED");

      // Verify row directly in database
      const dbCheck = await masterClient.query(
        `SELECT status, revoked_at FROM public."AuditSigningKey" WHERE key_id = $1`,
        [keyToRevoke]
      );
      expect(dbCheck.rows[0].status).toBe("REVOKED");
      expect(dbCheck.rows[0].revoked_at).toBeDefined();
    });

    it("returns 403 when unauthenticated or non-admin caller attempts revocation", async () => {
      const req = new Request("http://localhost:3000/api/admin/keys/revoke", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-id": "unprivileged_user_123",
        },
        body: JSON.stringify({
          targetType: "AUDIT_SIGNING_KEY",
          keyId: "some_key",
          reason: "unauthorized test",
        }),
      });

      const res = await revokeRoute(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.code).toBe("ERR_FORBIDDEN");
    });
  });
});
