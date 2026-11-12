/**
 * Plinthly Stage 3 Phase 3 — Ambiguous Capture Background Recovery Test Suite
 *
 * Verifies Acceptance Matrix criterion WHK-04:
 * 1. Background worker AmbiguousCaptureReconciliationWorker scans for carts in CAPTURING
 *    older than the threshold (default 5 min).
 * 2. Authoritatively polls PayPal Orders API.
 * 3. Reconciles COMPLETED orders to CAPTURED via R2-05 (execute_capture_confirmation).
 * 4. Reconciles VOIDED / EXPIRED orders to FAILED via R2-07 (record_cart_capture_failure).
 * 5. Safely ignores fresh in-flight carts (< threshold).
 * 6. Idempotently recovers carts already marked CAPTURED.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import crypto from "crypto";
import {
  AmbiguousCaptureReconciliationWorker,
  IPayPalOrderGetter,
} from "../../lib/workers/ambiguous-capture-worker";
import { CartCaptureService } from "../../lib/workflow/cart-capture-service";
import { MockPaymentGatewayClient } from "../../lib/workflow/payment-gateway-adapter";
import {
  createStage2Client,
  ensureRolesExist,
  createTestCartFixture,
  createTestKeys,
} from "../database/helpers/routine-test-helper";

describe("Stage 3 Phase 3 Acceptance Suite: Ambiguous Capture Recovery (WHK-04)", () => {
  let masterClient: Client;
  const hmacKeyId = "audit_hmac_key_2026";

  beforeAll(async () => {
    masterClient = await createStage2Client();
    await ensureRolesExist(masterClient);
    await createTestKeys(masterClient, "vak_unused", hmacKeyId, "orchestrator_worker_user");
  });

  afterAll(async () => {
    await masterClient.end();
  });

  beforeEach(async () => {
    process.env.AUTH_MODE = "local_demo";
    process.env.ENABLE_LOCAL_DEMO_AUTH = "true";
  });

  // ==========================================================================
  // WHK-04: Ambiguous Capture Background Recovery
  // ==========================================================================
  describe("WHK-04: Authoritative PayPal Polling & Resolution", () => {
    it("authoritatively resolves timed-out ambiguous cart to COMPLETED via R2-05 when PayPal reports COMPLETED", async () => {
      const orderId = "ORD-AMBIG-COMPLETED-" + crypto.randomUUID();
      const captureId = "CAP-AMBIG-COMPLETED-" + crypto.randomUUID();

      // Create cart in CAPTURING
      const fixture = await createTestCartFixture(
        masterClient,
        "CAPTURING",
        4500,
        0,
        500,
        0,
        "merchant@example.com",
        orderId
      );

      // Artificially age the cart updatedAt by 10 minutes (older than 5 min threshold)
      await masterClient.query(
        `UPDATE public."ApprovedMerchantCart"
            SET "updatedAt" = clock_timestamp() - interval '10 minutes'
          WHERE id = $1;`,
        [fixture.cartId]
      );

      // Mock PayPal Orders API returning COMPLETED with capture details for target order
      const mockPayPal: IPayPalOrderGetter = {
        async getOrder(id: string) {
          if (id === orderId) {
            return {
              id,
              status: "COMPLETED",
              intent: "CAPTURE",
              purchaseUnits: [
                {
                  amount: { currencyCode: "USD", value: "50.00" },
                  payee: { emailAddress: "merchant@example.com" },
                },
              ],
              rawResponse: {
                id,
                status: "COMPLETED",
                purchase_units: [
                  {
                    payments: {
                      captures: [
                        {
                          id: captureId,
                          status: "COMPLETED",
                          amount: { value: "50.00", currency_code: "USD" },
                        },
                      ],
                    },
                  },
                ],
              },
            };
          }
          // Default unhandled order status
          return { id, status: "SAVED", intent: "CAPTURE", purchaseUnits: [], rawResponse: { id, status: "SAVED" } };
        },
      };

      const mockGateway = new MockPaymentGatewayClient();
      const captureService = new CartCaptureService(masterClient, mockGateway, hmacKeyId);
      const worker = new AmbiguousCaptureReconciliationWorker(
        masterClient,
        mockPayPal,
        captureService,
        {
          timeoutThresholdMs: 300000, // 5 min
          signingKeyId: hmacKeyId,
        }
      );

      // Execute worker reconciliation scan
      const batchResult = await worker.reconcileAllAmbiguousCarts();
      expect(batchResult.scannedCount).toBeGreaterThanOrEqual(1);

      const cartRes = batchResult.results.find((r) => r.cartId === fixture.cartId);
      expect(cartRes).toBeDefined();
      expect(cartRes?.outcome).toBe("RESOLVED_COMPLETED");
      expect(cartRes?.previousStatus).toBe("CAPTURING");
      expect(cartRes?.currentStatus).toBe("CAPTURED");
      expect(cartRes?.captureId).toBe(captureId);
      expect(cartRes?.paymentEvidenceId).toBeDefined();

      // Verify database state: cart is CAPTURED
      const dbCart = await masterClient.query(
        `SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1`,
        [fixture.cartId]
      );
      expect(dbCart.rows[0].checkoutStatus).toBe("CAPTURED");

      // Verify PaymentEvidenceRecord exists (R2-05)
      const peCheck = await masterClient.query(
        `SELECT id, capture_id FROM public."PaymentEvidenceRecord" WHERE cart_id = $1`,
        [fixture.cartId]
      );
      expect(peCheck.rows.length).toBe(1);
      expect(peCheck.rows[0].capture_id).toBe(captureId);
    });

    it("authoritatively resolves timed-out ambiguous cart to FAILED via R2-07 when PayPal reports VOIDED", async () => {
      const orderId = "ORD-AMBIG-VOIDED-" + crypto.randomUUID();

      // Create cart in CAPTURING
      const fixture = await createTestCartFixture(
        masterClient,
        "CAPTURING",
        2000,
        0,
        0,
        0,
        "merchant@example.com",
        orderId
      );

      // Age cart by 15 minutes
      await masterClient.query(
        `UPDATE public."ApprovedMerchantCart"
            SET "updatedAt" = clock_timestamp() - interval '15 minutes'
          WHERE id = $1;`,
        [fixture.cartId]
      );

      // Mock PayPal Orders API returning VOIDED
      const mockPayPal: IPayPalOrderGetter = {
        async getOrder(id: string) {
          if (id === orderId) {
            return {
              id,
              status: "VOIDED",
              intent: "CAPTURE",
              purchaseUnits: [],
              rawResponse: { id, status: "VOIDED" },
            };
          }
          return { id, status: "SAVED", intent: "CAPTURE", purchaseUnits: [], rawResponse: { id, status: "SAVED" } };
        },
      };

      const mockGateway = new MockPaymentGatewayClient();
      const captureService = new CartCaptureService(masterClient, mockGateway, hmacKeyId);
      const worker = new AmbiguousCaptureReconciliationWorker(
        masterClient,
        mockPayPal,
        captureService,
        {
          timeoutThresholdMs: 300000,
          signingKeyId: hmacKeyId,
        }
      );

      const batchResult = await worker.reconcileAllAmbiguousCarts();
      const cartRes = batchResult.results.find((r) => r.cartId === fixture.cartId);
      expect(cartRes).toBeDefined();
      expect(cartRes?.outcome).toBe("RESOLVED_FAILED");
      expect(cartRes?.previousStatus).toBe("CAPTURING");
      expect(cartRes?.currentStatus).toBe("FAILED");

      // Verify database state: cart is FAILED via R2-07
      const dbCart = await masterClient.query(
        `SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1`,
        [fixture.cartId]
      );
      expect(dbCart.rows[0].checkoutStatus).toBe("FAILED");
    });

    it("safely skips fresh in-flight carts younger than timeout threshold", async () => {
      const orderId = "ORD-FRESH-" + crypto.randomUUID();

      // Create cart in CAPTURING updated just now (< 5 min)
      const fixture = await createTestCartFixture(
        masterClient,
        "CAPTURING",
        1500,
        0,
        0,
        0,
        "merchant@example.com",
        orderId
      );

      const mockPayPal: IPayPalOrderGetter = {
        async getOrder(id: string) {
          if (id === orderId) {
            return { id, status: "COMPLETED", intent: "CAPTURE", purchaseUnits: [], rawResponse: {} };
          }
          return { id, status: "SAVED", intent: "CAPTURE", purchaseUnits: [], rawResponse: { id, status: "SAVED" } };
        },
      };

      const mockGateway = new MockPaymentGatewayClient();
      const captureService = new CartCaptureService(masterClient, mockGateway, hmacKeyId);
      const worker = new AmbiguousCaptureReconciliationWorker(
        masterClient,
        mockPayPal,
        captureService,
        {
          timeoutThresholdMs: 300000, // 5 min
          signingKeyId: hmacKeyId,
        }
      );

      // Run scan with 5 min threshold
      const batchResult = await worker.reconcileAllAmbiguousCarts(300000);
      const freshCart = batchResult.results.find((r) => r.cartId === fixture.cartId);

      // Fresh cart should not be in the scanned results
      expect(freshCart).toBeUndefined();

      // Cart status must remain untouched in CAPTURING
      const dbCart = await masterClient.query(
        `SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1`,
        [fixture.cartId]
      );
      expect(dbCart.rows[0].checkoutStatus).toBe("CAPTURING");
    });

    it("idempotently handles carts already in CAPTURED status", async () => {
      const orderId = "ORD-ALREADY-CAPTURED-" + crypto.randomUUID();
      const captureId = "CAP-ALREADY-CAPTURED-" + crypto.randomUUID();
      const txId = "tx_already_" + crypto.randomUUID();

      const fixture = await createTestCartFixture(
        masterClient,
        "CAPTURED",
        2000,
        0,
        0,
        0,
        "merchant@example.com",
        orderId
      );

      // Insert matching WebhookTransmission
      await masterClient.query(
        `INSERT INTO public."WebhookTransmission" (
           transmission_id, authenticated_event_type, authenticated_order_id,
           authenticated_capture_id, authenticated_amount_cents, authenticated_currency,
           authenticated_payee_email, raw_payload, payload_hash, status, response_code, created_at
         ) VALUES (
           $1, 'PAYMENT.CAPTURE.COMPLETED', $2, $3, 2000, 'USD', 'merchant@example.com',
           '{}'::bytea, 'hash', 'PROCESSED', 200, clock_timestamp()
         );`,
        [txId, orderId, captureId]
      );

      // Insert existing payment evidence
      await masterClient.query(
        `INSERT INTO public."PaymentEvidenceRecord" (
           id, cart_id, transmission_id, capture_id, paypal_order_id,
           amount_cents, currency, payee_email, internal_audit_signature, recorded_at
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, $4, 2000, 'USD', 'merchant@example.com',
           'sig_bytes'::bytea, clock_timestamp()
         );`,
        [fixture.cartId, txId, captureId, orderId]
      );

      const mockPayPal: IPayPalOrderGetter = {
        async getOrder(id: string) {
          if (id === orderId) {
            return { id, status: "COMPLETED", intent: "CAPTURE", purchaseUnits: [], rawResponse: {} };
          }
          return { id, status: "SAVED", intent: "CAPTURE", purchaseUnits: [], rawResponse: { id, status: "SAVED" } };
        },
      };

      const mockGateway = new MockPaymentGatewayClient();
      const captureService = new CartCaptureService(masterClient, mockGateway, hmacKeyId);
      const worker = new AmbiguousCaptureReconciliationWorker(
        masterClient,
        mockPayPal,
        captureService
      );

      // Directly reconcile single cart
      const res = await worker.reconcileSingleCart(fixture.cartId);
      expect(res.outcome).toBe("ALREADY_CAPTURED");
      expect(res.currentStatus).toBe("CAPTURED");
      expect(res.captureId).toBe(captureId);
    });

    it("retains cart in CAPTURING when gateway order status is still pending/unresolved", async () => {
      const orderId = "ORD-PENDING-" + crypto.randomUUID();

      const fixture = await createTestCartFixture(
        masterClient,
        "CAPTURING",
        3000,
        0,
        0,
        0,
        "merchant@example.com",
        orderId
      );

      // Age cart by 10 minutes
      await masterClient.query(
        `UPDATE public."ApprovedMerchantCart"
            SET "updatedAt" = clock_timestamp() - interval '10 minutes'
          WHERE id = $1;`,
        [fixture.cartId]
      );

      const mockPayPal: IPayPalOrderGetter = {
        async getOrder(id: string) {
          if (id === orderId) {
            return {
              id,
              status: "PAYER_ACTION_REQUIRED",
              intent: "CAPTURE",
              purchaseUnits: [],
              rawResponse: { id, status: "PAYER_ACTION_REQUIRED" },
            };
          }
          return { id, status: "SAVED", intent: "CAPTURE", purchaseUnits: [], rawResponse: { id, status: "SAVED" } };
        },
      };

      const mockGateway = new MockPaymentGatewayClient();
      const captureService = new CartCaptureService(masterClient, mockGateway, hmacKeyId);
      const worker = new AmbiguousCaptureReconciliationWorker(
        masterClient,
        mockPayPal,
        captureService,
        { timeoutThresholdMs: 300000 }
      );

      const batchResult = await worker.reconcileAllAmbiguousCarts();
      const cartRes = batchResult.results.find((r) => r.cartId === fixture.cartId);
      expect(cartRes).toBeDefined();
      expect(cartRes?.outcome).toBe("PENDING_GATEWAY");
      expect(cartRes?.currentStatus).toBe("CAPTURING");

      // Verify cart still in CAPTURING
      const dbCart = await masterClient.query(
        `SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1`,
        [fixture.cartId]
      );
      expect(dbCart.rows[0].checkoutStatus).toBe("CAPTURING");
    });
  });
});
