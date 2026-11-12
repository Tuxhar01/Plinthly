/**
 * Plinthly Stage 3 Phase 3 — Ambiguous Capture Background Reconciliation Worker
 *
 * Implements Stage 3 Architecture Contract v3.0.0 Section 3.4 & Acceptance Matrix WHK-04:
 * 1. Scans for merchant carts in ambiguous capture states (e.g. CAPTURING / CHECKOUT_INITIATED)
 *    older than the timeout threshold (default 5 minutes in production; configurable for tests).
 * 2. Authoritatively polls PayPal REST v2 API (GET /v2/checkout/orders/{id} or GET /v2/payments/captures/{id}).
 * 3. If PayPal confirms COMPLETED capture:
 *    - Reconciles capture and resolves cart state to CAPTURED via R2-05 (execute_capture_confirmation).
 * 4. If PayPal confirms order is EXPIRED, VOIDED, or CANCELLED:
 *    - Records deterministic terminal failure and resolves cart to FAILED via R2-07 (record_cart_capture_failure).
 * 5. If gateway status remains pending:
 *    - Retains cart in CAPTURING awaiting webhook or next reconciliation poll.
 */

import { Client, PoolClient } from "pg";
import crypto from "crypto";
import { PayPalRestV2Client, PayPalOrderDetails } from "../paypal/paypal-rest-v2-client";
import { CartCaptureService } from "../workflow/cart-capture-service";
import { MerchantCartStatus } from "../workflow/cart-state-machine";

export interface AmbiguousWorkerOptions {
  timeoutThresholdMs?: number; // Default 5 minutes (300,000ms)
  signingKeyId?: string; // Default "audit_hmac_key_2026"
  workerId?: string;
}

export interface AmbiguousReconciliationResult {
  cartId: string;
  paypalOrderId: string | null;
  previousStatus: MerchantCartStatus;
  currentStatus: MerchantCartStatus;
  outcome: "RESOLVED_COMPLETED" | "RESOLVED_FAILED" | "PENDING_GATEWAY" | "ALREADY_CAPTURED" | "SKIPPED";
  captureId?: string;
  paymentEvidenceId?: string;
  message?: string;
}

export interface AmbiguousReconciliationBatchResult {
  scannedCount: number;
  resolvedCompletedCount: number;
  resolvedFailedCount: number;
  pendingCount: number;
  results: AmbiguousReconciliationResult[];
}

export interface IPayPalOrderGetter {
  getOrder(orderId: string): Promise<PayPalOrderDetails>;
  getCapture?(captureId: string): Promise<any>;
}

export class AmbiguousCaptureReconciliationWorker {
  private client: Client | PoolClient;
  private paypalClient: IPayPalOrderGetter;
  private captureService: CartCaptureService;
  private timeoutThresholdMs: number;
  private signingKeyId: string;
  private workerId: string;

  constructor(
    client: Client | PoolClient,
    paypalClient: IPayPalOrderGetter,
    captureService: CartCaptureService,
    options: AmbiguousWorkerOptions = {}
  ) {
    this.client = client;
    this.paypalClient = paypalClient;
    this.captureService = captureService;
    this.timeoutThresholdMs = options.timeoutThresholdMs ?? 300000; // 5 min default
    this.signingKeyId = options.signingKeyId || "audit_hmac_key_2026";
    this.workerId = options.workerId || `ambiguous_worker_${process.pid}`;
  }

  /**
   * Scans and reconciles all carts currently in ambiguous state older than threshold.
   */
  async reconcileAllAmbiguousCarts(
    thresholdOverrideMs?: number
  ): Promise<AmbiguousReconciliationBatchResult> {
    const thresholdMs = thresholdOverrideMs ?? this.timeoutThresholdMs;

    const queryRes = await this.client.query(
      `SELECT id, "approvalAggregateId", "checkoutStatus", "paypalOrderId",
              "merchantPayeeEmail", "totalCartCents", "updatedAt"
         FROM public."ApprovedMerchantCart"
        WHERE "checkoutStatus" IN ('CAPTURING', 'CHECKOUT_INITIATED')
          AND "updatedAt" <= clock_timestamp() - ($1 || ' milliseconds')::interval
        ORDER BY "updatedAt" ASC;`,
      [Math.max(0, Math.round(thresholdMs))]
    );

    const carts = queryRes.rows;
    const results: AmbiguousReconciliationResult[] = [];
    let resolvedCompletedCount = 0;
    let resolvedFailedCount = 0;
    let pendingCount = 0;

    for (const cart of carts) {
      try {
        const result = await this.reconcileSingleCartRow(cart);
        results.push(result);

        if (result.outcome === "RESOLVED_COMPLETED" || result.outcome === "ALREADY_CAPTURED") {
          resolvedCompletedCount++;
        } else if (result.outcome === "RESOLVED_FAILED") {
          resolvedFailedCount++;
        } else {
          pendingCount++;
        }
      } catch (err: any) {
        console.error(`[AMBIGUOUS_RECONCILIATION_ERROR] Cart ${cart.id}:`, err);
        results.push({
          cartId: cart.id,
          paypalOrderId: cart.paypalOrderId,
          previousStatus: cart.checkoutStatus,
          currentStatus: cart.checkoutStatus,
          outcome: "SKIPPED",
          message: err.message,
        });
      }
    }

    return {
      scannedCount: carts.length,
      resolvedCompletedCount,
      resolvedFailedCount,
      pendingCount,
      results,
    };
  }

  /**
   * Reconciles a single cart by its ID.
   */
  async reconcileSingleCart(cartId: string): Promise<AmbiguousReconciliationResult> {
    const res = await this.client.query(
      `SELECT id, "approvalAggregateId", "checkoutStatus", "paypalOrderId",
              "merchantPayeeEmail", "totalCartCents", "updatedAt"
         FROM public."ApprovedMerchantCart"
        WHERE id = $1;`,
      [cartId]
    );

    if (res.rows.length === 0) {
      throw new Error(`ERR_CART_NOT_FOUND: Cart "${cartId}" does not exist.`);
    }

    return this.reconcileSingleCartRow(res.rows[0]);
  }

  private async reconcileSingleCartRow(cart: any): Promise<AmbiguousReconciliationResult> {
    const previousStatus = cart.checkoutStatus as MerchantCartStatus;

    // Check if already captured
    if (previousStatus === "CAPTURED") {
      const peRes = await this.client.query(
        `SELECT id, capture_id FROM public."PaymentEvidenceRecord" WHERE cart_id = $1`,
        [cart.id]
      );
      return {
        cartId: cart.id,
        paypalOrderId: cart.paypalOrderId,
        previousStatus,
        currentStatus: "CAPTURED",
        outcome: "ALREADY_CAPTURED",
        paymentEvidenceId: peRes.rows[0]?.id,
        captureId: peRes.rows[0]?.capture_id,
        message: "Cart is already captured.",
      };
    }

    if (!cart.paypalOrderId) {
      return {
        cartId: cart.id,
        paypalOrderId: null,
        previousStatus,
        currentStatus: previousStatus,
        outcome: "SKIPPED",
        message: "Cart lacks paypalOrderId; cannot poll gateway.",
      };
    }

    // 1. Authoritatively query PayPal Orders API
    const orderDetails = await this.paypalClient.getOrder(cart.paypalOrderId);
    const rawData = orderDetails.rawResponse || {};
    const orderStatus = orderDetails.status || (rawData as any).status;

    // Inspect captures inside purchase units
    const purchaseUnits = (rawData as any).purchase_units || [];
    let captureId: string | null = null;
    let captureStatus: string | null = null;

    for (const pu of purchaseUnits) {
      const captures = pu.payments?.captures || [];
      if (captures.length > 0) {
        captureId = captures[0].id;
        captureStatus = captures[0].status;
        break;
      }
    }

    // 2. Gateway reports COMPLETED:
    if (orderStatus === "COMPLETED" || captureStatus === "COMPLETED") {
      const effectiveCaptureId = captureId || `CAP-${cart.paypalOrderId}`;

      // Find or synthesize WebhookTransmission record for R2-05
      let txId: string;
      const txRes = await this.client.query(
        `SELECT transmission_id
           FROM public."WebhookTransmission"
          WHERE (authenticated_order_id = $1 OR authenticated_capture_id = $2)
            AND status = 'PROCESSED'
          ORDER BY created_at DESC
          LIMIT 1`,
        [cart.paypalOrderId, effectiveCaptureId]
      );

      if (txRes.rows.length > 0) {
        txId = txRes.rows[0].transmission_id;
      } else {
        // Synthesize authoritative reconciliation transmission
        txId = `tx_recon_${cart.id.replace(/-/g, "").slice(0, 16)}_${Date.now()}`;
        const rawPayload = Buffer.from(
          JSON.stringify({
            id: `EV-${txId}`,
            event_type: "PAYMENT.CAPTURE.COMPLETED",
            resource: {
              id: effectiveCaptureId,
              status: "COMPLETED",
              supplementary_data: {
                related_ids: { order_id: cart.paypalOrderId, capture_id: effectiveCaptureId },
              },
            },
          }),
          "utf8"
        );
        const nonce = `nonce_recon_${crypto.randomUUID()}`;

        // Ingest transmission via R2-03
        await this.client.query(
          `SELECT transmission_id
             FROM public.record_webhook_transmission_ingress(
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
             );`,
          [
            txId,
            "PAYMENT.CAPTURE.COMPLETED",
            cart.paypalOrderId,
            effectiveCaptureId,
            null,
            Number(cart.totalCartCents),
            "USD",
            cart.merchantPayeeEmail,
            rawPayload,
            this.signingKeyId,
            nonce,
          ]
        );

        // Finalize transmission via R2-04
        await this.client.query(
          `SELECT transmission_id
             FROM public.finalize_transmission_response(
               $1, $2, $3
             );`,
          [txId, "PROCESSED", 200]
        );
      }

      // Execute R2-05 capture confirmation
      const confirmResult = await this.captureService.confirmCartCapture({
        cartId: cart.id,
        transmissionId: txId,
        captureId: effectiveCaptureId,
      });

      return {
        cartId: cart.id,
        paypalOrderId: cart.paypalOrderId,
        previousStatus,
        currentStatus: "CAPTURED",
        outcome: "RESOLVED_COMPLETED",
        captureId: effectiveCaptureId,
        paymentEvidenceId: confirmResult.paymentEvidenceId,
        message: "Ambiguous capture authoritatively resolved to COMPLETED via PayPal API.",
      };
    }

    // 3. Gateway reports VOIDED, EXPIRED, or CANCELLED:
    if (orderStatus === "VOIDED" || orderStatus === "EXPIRED" || orderStatus === "CANCELLED") {
      await this.client.query(
        `SELECT cart_id, status, updated_at
           FROM public.record_cart_capture_failure(
             $1, $2, $3
           );`,
        [
          cart.id,
          "PAYPAL_ORDER_EXPIRED",
          `PayPal gateway confirmed order status "${orderStatus}".`,
        ]
      );

      return {
        cartId: cart.id,
        paypalOrderId: cart.paypalOrderId,
        previousStatus,
        currentStatus: "FAILED",
        outcome: "RESOLVED_FAILED",
        message: `Ambiguous capture authoritatively resolved to FAILED (gateway status "${orderStatus}").`,
      };
    }

    // 4. Gateway still in pending / action-required state:
    return {
      cartId: cart.id,
      paypalOrderId: cart.paypalOrderId,
      previousStatus,
      currentStatus: previousStatus,
      outcome: "PENDING_GATEWAY",
      message: `Gateway order status is still "${orderStatus}". Retaining in ${previousStatus}.`,
    };
  }
}
