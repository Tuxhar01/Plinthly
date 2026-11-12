/**
 * Plinthly Stage 2 Phase 4 — Webhook-Driven Payment State Reconciler
 *
 * Reconciles incoming verified PayPal webhooks with ApprovedMerchantCart entities:
 * 1. PAYMENT.CAPTURE.COMPLETED -> transitions CAPTURING -> CAPTURED via R2-05.
 * 2. Duplicate webhooks -> returns existing PaymentEvidenceRecord idempotently (R2-05).
 * 3. PAYMENT.CAPTURE.REFUNDED -> updates status to PARTIALLY_REFUNDED / REFUNDED via R2-06.
 */

import { Client } from "pg";
import { WebhookIngressResult } from "../workers/webhook-ingress-worker";
import { CartCaptureService } from "./cart-capture-service";
import { RefundService } from "./refund-service";
import { MerchantCartStatus } from "./cart-state-machine";

export interface ReconciliationResult {
  reconciled: boolean;
  cartId?: string;
  eventType: string;
  status?: MerchantCartStatus;
  paymentEvidenceId?: string;
  refundEvidenceId?: string;
  idempotentRetry?: boolean;
  message?: string;
}

export class WebhookPaymentReconciler {
  private client: Client;
  private captureService: CartCaptureService;
  private refundService: RefundService;

  constructor(
    client: Client,
    captureService: CartCaptureService,
    refundService: RefundService
  ) {
    this.client = client;
    this.captureService = captureService;
    this.refundService = refundService;
  }

  /**
   * Reconciles a cryptographically verified webhook transmission against the target merchant cart.
   */
  async reconcileWebhook(webhook: WebhookIngressResult): Promise<ReconciliationResult> {
    const { transmissionId, eventType, orderId, captureId } = webhook;

    if (!orderId && !captureId) {
      return {
        reconciled: false,
        eventType,
        message: "Webhook lacks both orderId and captureId; cannot match merchant cart.",
      };
    }

    // Find target cart by orderId
    let cart: any = null;
    if (orderId) {
      const res = await this.client.query(
        `SELECT id, "checkoutStatus", "paypalOrderId", "merchantPayeeEmail", "totalCartCents"
           FROM public."ApprovedMerchantCart"
          WHERE "paypalOrderId" = $1
          LIMIT 1`,
        [orderId]
      );
      if (res.rows.length > 0) {
        cart = res.rows[0];
      }
    }

    // If not found by orderId, attempt lookup via PaymentEvidenceRecord by captureId
    if (!cart && captureId) {
      const peRes = await this.client.query(
        `SELECT c.id, c."checkoutStatus", c."paypalOrderId", c."merchantPayeeEmail", c."totalCartCents"
           FROM public."PaymentEvidenceRecord" pe
           JOIN public."ApprovedMerchantCart" c ON c.id = pe.cart_id
          WHERE pe.capture_id = $1
          LIMIT 1`,
        [captureId]
      );
      if (peRes.rows.length > 0) {
        cart = peRes.rows[0];
      }
    }

    if (!cart) {
      return {
        reconciled: false,
        eventType,
        message: `No ApprovedMerchantCart found matching order "${orderId}" or capture "${captureId}".`,
      };
    }

    // Handle PAYMENT.CAPTURE.COMPLETED
    if (eventType.startsWith("PAYMENT.CAPTURE.COMPLETED")) {
      if (!captureId) {
        return {
          reconciled: false,
          cartId: cart.id,
          eventType,
          message: "Webhook event is capture completed but lacks captureId.",
        };
      }

      // If cart is CAPTURING or already CAPTURED, invoke R2-05
      const confirmRes = await this.captureService.confirmCartCapture({
        cartId: cart.id,
        transmissionId,
        captureId,
      });

      return {
        reconciled: true,
        cartId: cart.id,
        eventType,
        status: confirmRes.status,
        paymentEvidenceId: confirmRes.paymentEvidenceId,
        idempotentRetry: confirmRes.idempotentRetry,
        message: confirmRes.idempotentRetry
          ? "Duplicate webhook reconciled idempotently."
          : "Cart capture confirmed from webhook.",
      };
    }

    // Handle PAYMENT.CAPTURE.REFUNDED
    if (eventType.startsWith("PAYMENT.CAPTURE.REFUNDED")) {
      if (!captureId) {
        return {
          reconciled: false,
          cartId: cart.id,
          eventType,
          message: "Webhook event is capture refunded but lacks captureId.",
        };
      }

      const refundRes = await this.refundService.recordRefund({
        cartId: cart.id,
        captureId,
        transmissionId,
        reason: "PayPal webhook refund event reconciliation",
      });

      return {
        reconciled: true,
        cartId: cart.id,
        eventType,
        status: refundRes.status,
        refundEvidenceId: refundRes.refundEvidenceId,
        message: `Refund recorded from webhook. Cart status updated to ${refundRes.status}.`,
      };
    }

    return {
      reconciled: false,
      cartId: cart.id,
      eventType,
      message: `Unhandled event type "${eventType}".`,
    };
  }
}

