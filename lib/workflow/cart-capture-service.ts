/**
 * Plinthly Stage 2 Phase 4 — Cart Capture Orchestration Service
 *
 * Implements:
 * 1. Sequential multi-retailer merchant cart capture preparation and confirmation.
 * 2. Integration with canonical Phase 2 routines:
 *    - R2-02 (prepare_merchant_cart_capture) under Level 0 advisory mutex and Level 1 row lock.
 *    - R2-05 (execute_capture_confirmation) with idempotent replay safety.
 * 3. Model A Landed Cost zero-variance enforcement before capture preparation.
 * 4. Multi-merchant isolation: terminal failure of one merchant cart does not abort or corrupt sibling carts.
 * 5. Ambiguous timeout safety: timeouts never mark payment as failed; cart remains in CAPTURING.
 */

import { Client } from "pg";
import crypto from "crypto";
import { reconcileLandedCostZeroVariance } from "./landed-cost-reconciler";
import { PaymentGatewayClient, GatewayCaptureOutput } from "./payment-gateway-adapter";
import { MerchantCartStatus, assertCartTransition } from "./cart-state-machine";

export interface PrepareCaptureInput {
  cartId: string;
  approvalAggregateId: string;
  expectedAmountCents: number | bigint;
  expectedCurrency?: string;
  idempotencyKey?: string;
}

export interface PrepareCaptureResult {
  cartId: string;
  status: MerchantCartStatus;
  lockedAt: Date;
}

export interface ConfirmCaptureInput {
  cartId: string;
  transmissionId: string;
  captureId: string;
  nonce?: string;
}

export interface ConfirmCaptureResult {
  paymentEvidenceId: string;
  cartId: string;
  status: MerchantCartStatus;
  recordedAt: Date;
  idempotentRetry: boolean;
}

export interface SingleCartCaptureOptions {
  transmissionId?: string;
  nonce?: string;
  idempotencyKey?: string;
}

export interface SingleCartCaptureResult {
  cartId: string;
  status: MerchantCartStatus;
  outcome: "COMPLETED" | "FAILED" | "AMBIGUOUS_TIMEOUT" | "PREPARED_AWAITING_WEBHOOK";
  captureId?: string;
  paymentEvidenceId?: string;
  idempotentRetry?: boolean;
  message?: string;
  error?: string;
}

export interface MultiCartCaptureResult {
  approvalAggregateId: string;
  totalCarts: number;
  completedCount: number;
  failedCount: number;
  pendingCount: number;
  cartResults: SingleCartCaptureResult[];
}

export class CartCaptureService {
  private client: Client;
  private gatewayClient: PaymentGatewayClient;
  private signingKeyId: string;

  constructor(
    client: Client,
    gatewayClient: PaymentGatewayClient,
    signingKeyId: string = "audit_hmac_key_2026"
  ) {
    this.client = client;
    this.gatewayClient = gatewayClient;
    this.signingKeyId = signingKeyId;
  }

  /**
   * Prepares a merchant cart for capture by asserting landed cost zero-variance and
   * atomically transitioning checkoutStatus from BUYER_APPROVED to CAPTURING via R2-02.
   */
  async prepareCartCapture(input: PrepareCaptureInput): Promise<PrepareCaptureResult> {
    const { cartId, approvalAggregateId, expectedAmountCents, expectedCurrency = "USD" } = input;
    const idempotencyKey = input.idempotencyKey || `idemp_prep_${cartId}_${Date.now()}`;

    // 1. Query cart financial breakdown to enforce Model A Landed Cost
    const cartRes = await this.client.query(
      `SELECT "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
              "taxAmountCents", "totalCartCents", "checkoutStatus", "paypalOrderId",
              "merchantPayeeEmail"
         FROM public."ApprovedMerchantCart"
        WHERE id = $1`,
      [cartId]
    );

    if (cartRes.rows.length === 0) {
      throw new Error(`ERR_CART_NOT_FOUND: Merchant cart "${cartId}" does not exist.`);
    }

    const row = cartRes.rows[0];

    // 2. Landed Cost Zero-Variance Assertion
    reconcileLandedCostZeroVariance({
      merchandiseSubtotalCents: row.merchandiseSubtotalCents,
      discountCents: row.discountCents,
      shippingTotalCents: row.shippingTotalCents,
      taxAmountCents: row.taxAmountCents,
      totalCartCents: row.totalCartCents,
    });

    // 3. Invoke R2-02: prepare_merchant_cart_capture
    const res = await this.client.query(
      `SELECT cart_id, status, locked_at
         FROM public.prepare_merchant_cart_capture(
           $1, $2, $3, $4, $5
         );`,
      [
        cartId,
        approvalAggregateId,
        expectedAmountCents,
        expectedCurrency,
        idempotencyKey,
      ]
    );

    const r2Row = res.rows[0];
    return {
      cartId: r2Row.cart_id,
      status: r2Row.status as MerchantCartStatus,
      lockedAt: new Date(r2Row.locked_at),
    };
  }

  /**
   * Confirms payment capture evidence and completes cart via R2-05.
   * If already CAPTURED, idempotently returns the existing evidence record.
   */
  async confirmCartCapture(input: ConfirmCaptureInput): Promise<ConfirmCaptureResult> {
    const { cartId, transmissionId, captureId } = input;
    const nonce = input.nonce || `nonce_cap_${crypto.randomUUID()}`;

    const res = await this.client.query(
      `SELECT payment_evidence_id, cart_id, status, recorded_at, idempotent_retry
         FROM public.execute_capture_confirmation(
           $1, $2, $3, $4, $5
         );`,
      [
        cartId,
        transmissionId,
        captureId,
        this.signingKeyId,
        nonce,
      ]
    );

    const row = res.rows[0];
    return {
      paymentEvidenceId: row.payment_evidence_id,
      cartId: row.cart_id,
      status: row.status as MerchantCartStatus,
      recordedAt: new Date(row.recorded_at),
      idempotentRetry: Boolean(row.idempotent_retry),
    };
  }

  /**
   * Executes the full capture lifecycle for a single merchant cart:
   * 1. Prepares capture via R2-02 (BUYER_APPROVED -> CAPTURING).
   * 2. Calls Payment Gateway capture.
   * 3. Handles outcomes:
   *    - AMBIGUOUS_TIMEOUT: leaves cart in CAPTURING (never marks as FAILED).
   *    - FAILED: isolates failure to this cart; marks checkoutStatus = FAILED.
   *    - COMPLETED: confirms capture via R2-05 if transmissionId is available.
   */
  async executeSingleCartCapture(
    cartId: string,
    approvalAggregateId: string,
    options: SingleCartCaptureOptions = {}
  ): Promise<SingleCartCaptureResult> {
    // Read cart
    const cartRes = await this.client.query(
      `SELECT "merchandiseSubtotalCents", "discountCents", "shippingTotalCents",
              "taxAmountCents", "totalCartCents", "checkoutStatus", "paypalOrderId",
              "merchantPayeeEmail"
         FROM public."ApprovedMerchantCart"
        WHERE id = $1`,
      [cartId]
    );

    if (cartRes.rows.length === 0) {
      throw new Error(`ERR_CART_NOT_FOUND: Cart "${cartId}" not found.`);
    }

    const cart = cartRes.rows[0];

    // If cart is already CAPTURED, return idempotent recovery
    if (cart.checkoutStatus === "CAPTURED") {
      const peRes = await this.client.query(
        `SELECT id, capture_id, recorded_at FROM public."PaymentEvidenceRecord" WHERE cart_id = $1`,
        [cartId]
      );
      if (peRes.rows.length > 0) {
        return {
          cartId,
          status: "CAPTURED",
          outcome: "COMPLETED",
          captureId: peRes.rows[0].capture_id,
          paymentEvidenceId: peRes.rows[0].id,
          idempotentRetry: true,
          message: "Cart was already captured; retrieved existing payment evidence idempotently.",
        };
      }
    }

    // Step 1: Prepare cart if in BUYER_APPROVED
    if (cart.checkoutStatus === "BUYER_APPROVED") {
      try {
        await this.prepareCartCapture({
          cartId,
          approvalAggregateId,
          expectedAmountCents: cart.totalCartCents,
          idempotencyKey: options.idempotencyKey,
        });
      } catch (prepErr: any) {
        // If concurrently prepared or captured by another thread, re-verify status
        const recheck = await this.client.query(
          `SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1`,
          [cartId]
        );
        if (recheck.rows.length > 0 && recheck.rows[0].checkoutStatus === "CAPTURED") {
          const peRes = await this.client.query(
            `SELECT id, capture_id FROM public."PaymentEvidenceRecord" WHERE cart_id = $1`,
            [cartId]
          );
          if (peRes.rows.length > 0) {
            return {
              cartId,
              status: "CAPTURED",
              outcome: "COMPLETED",
              captureId: peRes.rows[0].capture_id,
              paymentEvidenceId: peRes.rows[0].id,
              idempotentRetry: true,
              message: "Cart was already captured concurrently; retrieved payment evidence idempotently.",
            };
          }
        }
        if (recheck.rows.length === 0 || recheck.rows[0].checkoutStatus !== "CAPTURING") {
          throw prepErr;
        }
      }
    } else if (cart.checkoutStatus !== "CAPTURING") {
      throw new Error(
        `ERR_INVALID_TRANSITION: Cannot capture cart in status "${cart.checkoutStatus}".`
      );
    }

    // Step 2: Gateway capture
    const orderId = cart.paypalOrderId;
    if (!orderId) {
      throw new Error(`ERR_NO_ORDER_ID: Cart "${cartId}" lacks a paypalOrderId.`);
    }

    const gatewayResult = await this.gatewayClient.capturePayment({
      orderId,
      cartId,
      amountCents: cart.totalCartCents,
      currency: "USD",
      payeeEmail: cart.merchantPayeeEmail,
      idempotencyKey: options.idempotencyKey || `cap_${cartId}`,
      quotedSubtotalCents: cart.merchandiseSubtotalCents,
      quotedDiscountCents: cart.discountCents || 0,
      quotedShippingCents: cart.shippingTotalCents,
      quotedTaxCents: cart.taxAmountCents,
    });

    // Step 3: Handle Gateway Outcome
    if (gatewayResult.outcome === "AMBIGUOUS_TIMEOUT") {
      // NEVER mark payment as failed on timeout! Keep in CAPTURING.
      return {
        cartId,
        status: "CAPTURING",
        outcome: "AMBIGUOUS_TIMEOUT",
        message: "Payment gateway request timed out. Cart retained in CAPTURING awaiting webhook reconciliation.",
        error: gatewayResult.errorMessage,
      };
    }

    if (gatewayResult.outcome === "FAILED") {
      // Definitive failure: Invoke SECURITY DEFINER routine to transition this cart to FAILED
      await this.client.query(
        `SELECT cart_id, status, updated_at
           FROM public.record_cart_capture_failure(
             $1, $2, $3
           );`,
        [
          cartId,
          gatewayResult.errorCode || "PAYMENT_CAPTURE_FAILED",
          gatewayResult.errorMessage || "Payment capture declined by gateway.",
        ]
      );

      return {
        cartId,
        status: "FAILED",
        outcome: "FAILED",
        error: gatewayResult.errorMessage || "Payment capture declined by gateway.",
      };
    }

    // Gateway returned COMPLETED:
    const captureId = gatewayResult.captureId!;

    // Resolve WebhookTransmission ID:
    let txId = options.transmissionId;
    if (!txId) {
      // Check if matching transmission already arrived
      const txCheck = await this.client.query(
        `SELECT transmission_id
           FROM public."WebhookTransmission"
          WHERE authenticated_order_id = $1
            AND authenticated_capture_id = $2
            AND status = 'PROCESSED'
          LIMIT 1`,
        [orderId, captureId]
      );
      if (txCheck.rows.length > 0) {
        txId = txCheck.rows[0].transmission_id;
      }
    }

    if (!txId) {
      // Gateway succeeded remotely but transmission not yet ingested; remains in CAPTURING awaiting webhook
      return {
        cartId,
        status: "CAPTURING",
        outcome: "PREPARED_AWAITING_WEBHOOK",
        captureId,
        message: "Payment captured at gateway; awaiting verified webhook transmission for R2-05 confirmation.",
      };
    }

    // Step 4: Confirm capture via R2-05
    try {
      const confirmResult = await this.confirmCartCapture({
        cartId,
        transmissionId: txId,
        captureId,
        nonce: options.nonce,
      });

      return {
        cartId,
        status: "CAPTURED",
        outcome: "COMPLETED",
        captureId,
        paymentEvidenceId: confirmResult.paymentEvidenceId,
        idempotentRetry: confirmResult.idempotentRetry,
      };
    } catch (confErr: any) {
      // If another worker concurrently confirmed this cart, retrieve the evidence
      const peRes = await this.client.query(
        `SELECT id, capture_id FROM public."PaymentEvidenceRecord" WHERE cart_id = $1`,
        [cartId]
      );
      if (peRes.rows.length > 0) {
        return {
          cartId,
          status: "CAPTURED",
          outcome: "COMPLETED",
          captureId: peRes.rows[0].capture_id,
          paymentEvidenceId: peRes.rows[0].id,
          idempotentRetry: true,
          message: "Cart was confirmed concurrently; retrieved existing payment evidence idempotently.",
        };
      }
      throw confErr;
    }
  }

  /**
   * Executes sequential multi-cart capture loop over an approval aggregate.
   * Enforces independent cart outcomes: failure in cart K does NOT abort cart K+1.
   */
  async executeMultiCartCapture(
    approvalAggregateId: string,
    cartOptionsMap: Map<string, SingleCartCaptureOptions> = new Map()
  ): Promise<MultiCartCaptureResult> {
    const cartsRes = await this.client.query(
      `SELECT id, "checkoutStatus"
         FROM public."ApprovedMerchantCart"
        WHERE "approvalAggregateId" = $1
        ORDER BY "createdAt" ASC, id ASC`,
      [approvalAggregateId]
    );

    const carts = cartsRes.rows;
    const cartResults: SingleCartCaptureResult[] = [];
    let completedCount = 0;
    let failedCount = 0;
    let pendingCount = 0;

    for (const cart of carts) {
      const opts = cartOptionsMap.get(cart.id) || {};
      try {
        const result = await this.executeSingleCartCapture(cart.id, approvalAggregateId, opts);
        cartResults.push(result);

        if (result.status === "CAPTURED") completedCount++;
        else if (result.status === "FAILED") failedCount++;
        else pendingCount++;
      } catch (err: any) {
        // Isolate unexpected cart-level errors
        cartResults.push({
          cartId: cart.id,
          status: "FAILED",
          outcome: "FAILED",
          error: err.message,
        });
        failedCount++;
      }
    }

    return {
      approvalAggregateId,
      totalCarts: carts.length,
      completedCount,
      failedCount,
      pendingCount,
      cartResults,
    };
  }
}
