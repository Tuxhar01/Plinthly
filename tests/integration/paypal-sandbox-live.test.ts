/**
 * Plinthly — Genuine PayPal Developer Sandbox Integration Suite
 *
 * Exercises the genuine PayPal Sandbox endpoints (https://api-m.sandbox.paypal.com):
 * 1. OAuth2 Client Credentials token grant (/v1/oauth2/token)
 * 2. Order creation with explicit intent: "AUTHORIZE" (/v2/checkout/orders)
 * 3. Authoritative order retrieval (/v2/checkout/orders/{id})
 * 4. Fail-closed capture intent rejection (/v2/checkout/orders/{id}/capture)
 * 5. Fail-closed unapproved order authorization rejection (/v2/checkout/orders/{id}/authorize)
 * 6. Dynamic adapter resolution (PayPalSandboxGatewayAdapter vs MockPaymentGatewayClient)
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import dotenv from "dotenv";
import { PayPalSandboxClient } from "../../lib/paypal/client";
import { PayPalRestV2Client } from "../../lib/paypal/paypal-rest-v2-client";
import {
  getPaymentGatewayClient,
  PayPalSandboxGatewayAdapter,
  MockPaymentGatewayClient,
} from "../../lib/workflow/payment-gateway-adapter";

describe("Genuine PayPal Sandbox Integration Suite (api-m.sandbox.paypal.com)", { timeout: 30000 }, () => {
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let hasValidCredentials = false;

  beforeAll(() => {
    if (fs.existsSync(".env.local")) {
      const env = dotenv.parse(fs.readFileSync(".env.local"));
      clientId = env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID;
      clientSecret = env.PAYPAL_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET;
    } else {
      clientId = process.env.PAYPAL_CLIENT_ID;
      clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    }

    hasValidCredentials = Boolean(
      clientId &&
      clientSecret &&
      clientId.length > 20 &&
      clientSecret.length > 20 &&
      !clientId.includes("placeholder")
    );
  });

  it("authenticates via OAuth2 and acquires a genuine Sandbox Bearer token", async () => {
    if (!hasValidCredentials) {
      console.warn("Skipping live OAuth2 test: No valid PAYPAL_CLIENT_ID configured.");
      return;
    }

    const restClient = new PayPalRestV2Client({
      clientId: clientId!,
      clientSecret: clientSecret!,
      baseUrl: "https://api-m.sandbox.paypal.com",
    });

    const token = await restClient.getAccessToken();
    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(30);

    // Verify token reuse within expiration window
    const cachedToken = await restClient.getAccessToken();
    expect(cachedToken).toBe(token);
  });

  it("creates a genuine Sandbox Order with explicit intent: 'AUTHORIZE'", async () => {
    if (!hasValidCredentials) {
      console.warn("Skipping live order creation: No valid PAYPAL_CLIENT_ID configured.");
      return;
    }

    const client = new PayPalSandboxClient({
      clientId: clientId!,
      clientSecret: clientSecret!,
      baseUrl: "https://api-m.sandbox.paypal.com",
      appBaseUrl: "http://127.0.0.1:3000",
    });

    const refId = "test_ref_" + Date.now();
    const order = await client.createOrder({
      referenceId: refId,
      amountCents: 2500, // $25.00 USD
      currency: "USD",
      idempotencyKey: "req_live_test_" + Date.now(),
      description: "Plinthly Live Sandbox Test Order",
      intent: "AUTHORIZE",
    });

    expect(order.id).toBeDefined();
    expect(order.id.length).toBeGreaterThan(10);
    expect(order.status).toBe("PAYER_ACTION_REQUIRED");

    // Verify HATEOAS approval link is returned
    const approveLink = order.links.find(
      (l) => l.rel === "approve" || l.rel === "payer-action"
    );
    expect(approveLink).toBeDefined();
    expect(approveLink?.href).toContain("sandbox.paypal.com");

    // Independently query the remote order to verify server-side state
    const retrieved = await client.getOrder(order.id);
    expect(retrieved.id).toBe(order.id);
    expect(retrieved.intent).toBe("AUTHORIZE");
    expect(retrieved.status).toBe("PAYER_ACTION_REQUIRED");
    expect(retrieved.purchase_units[0]?.amount?.value).toBe("25.00");
    expect(retrieved.purchase_units[0]?.amount?.currency_code).toBe("USD");
  });

  it("enforces fail-closed intent validation: rejects immediate capture on AUTHORIZE order", async () => {
    if (!hasValidCredentials) return;

    const restClient = new PayPalRestV2Client({
      clientId: clientId!,
      clientSecret: clientSecret!,
      baseUrl: "https://api-m.sandbox.paypal.com",
    });

    // Create an authorize order first
    const client = new PayPalSandboxClient({
      clientId: clientId!,
      clientSecret: clientSecret!,
      baseUrl: "https://api-m.sandbox.paypal.com",
      appBaseUrl: "http://127.0.0.1:3000",
    });

    const order = await client.createOrder({
      referenceId: "intent_test_" + Date.now(),
      amountCents: 1500,
      currency: "USD",
      idempotencyKey: "req_intent_" + Date.now(),
      intent: "AUTHORIZE",
    });

    // Attempting direct capture on an AUTHORIZE order must fail
    const captureResult = await restClient.captureOrder(order.id, "req_cap_fail_" + Date.now());
    expect(captureResult.success).toBe(false);
    expect(captureResult.isAmbiguous).toBe(false);
    if (!captureResult.success) {
      expect(captureResult.errorCode).toBe("UNPROCESSABLE_ENTITY");
    }
  });

  it("enforces fail-closed payer approval validation: rejects authorization before buyer approval", async () => {
    if (!hasValidCredentials) return;

    const token = await new PayPalRestV2Client({
      clientId: clientId!,
      clientSecret: clientSecret!,
      baseUrl: "https://api-m.sandbox.paypal.com",
    }).getAccessToken();

    const client = new PayPalSandboxClient({
      clientId: clientId!,
      clientSecret: clientSecret!,
      baseUrl: "https://api-m.sandbox.paypal.com",
      appBaseUrl: "http://127.0.0.1:3000",
    });

    const order = await client.createOrder({
      referenceId: "auth_fail_test_" + Date.now(),
      amountCents: 1000,
      currency: "USD",
      idempotencyKey: "req_auth_fail_" + Date.now(),
      intent: "AUTHORIZE",
    });

    // Attempt authorization directly via REST v2
    const authRes = await fetch(
      `https://api-m.sandbox.paypal.com/v2/checkout/orders/${encodeURIComponent(order.id)}/authorize`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": "req_auth_att_" + Date.now(),
        },
      }
    );

    expect(authRes.status).toBe(422);
    const authData = await authRes.json();
    expect(authData.name).toBe("UNPROCESSABLE_ENTITY");
    expect(authData.details?.[0]?.issue).toBe("ORDER_NOT_APPROVED");
  });

  it("resolves PayPalSandboxGatewayAdapter dynamically when PAYPAL_MODE=sandbox", () => {
    const prevMode = process.env.PAYPAL_MODE;
    try {
      process.env.PAYPAL_MODE = "sandbox";
      const adapter = getPaymentGatewayClient({
        clientId: "sb_test_client",
        clientSecret: "sb_test_secret",
      });

      expect(adapter).toBeInstanceOf(PayPalSandboxGatewayAdapter);
      expect((adapter as PayPalSandboxGatewayAdapter).isProduction).toBe(false);
      expect((adapter as PayPalSandboxGatewayAdapter).restClient.getBaseUrl()).toBe(
        "https://api-m.sandbox.paypal.com"
      );
    } finally {
      if (prevMode) {
        process.env.PAYPAL_MODE = prevMode;
      } else {
        delete process.env.PAYPAL_MODE;
      }
    }
  });

  it("resolves MockPaymentGatewayClient by default for zero-risk local dev and testing", () => {
    delete process.env.PAYPAL_MODE;
    const adapter = getPaymentGatewayClient();
    expect(adapter).toBeInstanceOf(MockPaymentGatewayClient);
  });
});
