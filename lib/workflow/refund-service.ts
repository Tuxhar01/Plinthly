/**
 * Plinthly Stage 2 Phase 4 — Authenticated Refund Service
 *
 * Implements:
 * 1. Webhook-backed refund processing via canonical routine R2-06 (record_cart_refund_attempt).
 * 2. Strict provenance validation between refund transmission, original capture, and merchant cart.
 * 3. Enforces cumulative refund limit: sum(refunds) <= totalCartCents.
 * 4. Automatic status transition:
 *    - PARTIALLY_REFUNDED when cumulative < totalCartCents.
 *    - REFUNDED when cumulative == totalCartCents.
 */

import { Client } from "pg";
import crypto from "crypto";
import { PaymentGatewayClient } from "./payment-gateway-adapter";
import { MerchantCartStatus } from "./cart-state-machine";

export interface RecordRefundInput {
  cartId: string;
  captureId: string;
  transmissionId: string;
  reason: string;
  nonce?: string;
}

export interface RecordRefundResult {
  refundEvidenceId: string;
  cartId: string;
  cumulativeRefundedCents: bigint;
  status: MerchantCartStatus;
  recordedAt: Date;
}

export interface ExecuteCartRefundInput {
  cartId: string;
  amountCents: number | bigint;
  reason: string;
  transmissionId: string;
  nonce?: string;
}

export interface ExecuteCartRefundResult {
  refundEvidenceId: string;
  cartId: string;
  captureId: string;
  status: MerchantCartStatus;
  cumulativeRefundedCents: bigint;
  recordedAt: Date;
}

export interface ExecuteGatewayRefundInput {
  cartId: string;
  amountCents: number | bigint;
  reason: string;
  currency?: string;
  idempotencyKey?: string; // Client idempotency token to bind durable intent
  refundRecordId?: string; // Direct reference to pre-persisted CartRefundRecord
}

export interface ExecuteGatewayRefundResult {
  cartId: string;
  captureId: string;
  outcome: "COMPLETED" | "FAILED" | "AMBIGUOUS_TIMEOUT";
  refundId?: string;
  refundRecordId?: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string; // The durable persisted UUIDv4 passed to gateway as PayPal-Request-Id
  errorCode?: string;
  errorMessage?: string;
  refundedAt?: Date;
}

export class RefundService {
  private client: Client;
  private gatewayClient?: PaymentGatewayClient;
  private signingKeyId: string;

  constructor(
    client: Client,
    gatewayClient?: PaymentGatewayClient,
    signingKeyId: string = "audit_hmac_key_2026"
  ) {
    this.client = client;
    this.gatewayClient = gatewayClient;
    this.signingKeyId = signingKeyId;
  }

  /**
   * Records a gateway refund attempt backed by a verified WebhookTransmission via R2-06.
   */
  async recordRefund(input: RecordRefundInput): Promise<RecordRefundResult> {
    const { cartId, captureId, transmissionId, reason } = input;
    const nonce = input.nonce || `nonce_ref_${crypto.randomUUID()}`;

    const res = await this.client.query(
      `SELECT refund_evidence_id, cart_id, cumulative_refunded_cents, status, recorded_at
         FROM public.record_cart_refund_attempt(
           $1, $2, $3, $4, $5, $6
         );`,
      [
        cartId,
        captureId,
        transmissionId,
        this.signingKeyId,
        nonce,
        reason,
      ]
    );

    const row = res.rows[0];
    return {
      refundEvidenceId: row.refund_evidence_id,
      cartId: row.cart_id,
      cumulativeRefundedCents: BigInt(row.cumulative_refunded_cents),
      status: row.status as MerchantCartStatus,
      recordedAt: new Date(row.recorded_at),
    };
  }

  /**
   * Executes and records a refund for a captured merchant cart:
   * 1. Validates that the cart is in CAPTURED or PARTIALLY_REFUNDED.
   * 2. Enforces remaining refundable balance: amountCents <= totalCartCents - cumulativeRefundedCents.
   * 3. Resolves the authoritative captureId from PaymentEvidenceRecord.
   * 4. Invokes R2-06 with the authoritative WebhookTransmission.
   */
  async executeCartRefund(input: ExecuteCartRefundInput): Promise<ExecuteCartRefundResult> {
    const { cartId, transmissionId, reason, nonce } = input;

    // 1. Verify cart status and obtain payment evidence
    const cartRes = await this.client.query(
      `SELECT "checkoutStatus", "totalCartCents", "cumulativeRefundedCents"
         FROM public."ApprovedMerchantCart"
        WHERE id = $1`,
      [cartId]
    );

    if (cartRes.rows.length === 0) {
      throw new Error(`ERR_CART_NOT_FOUND: Cart "${cartId}" does not exist.`);
    }

    const cart = cartRes.rows[0];
    if (cart.checkoutStatus !== "CAPTURED" && cart.checkoutStatus !== "PARTIALLY_REFUNDED") {
      throw new Error(
        `ERR_INVALID_TRANSITION: Cannot refund cart in status "${cart.checkoutStatus}". Must be CAPTURED or PARTIALLY_REFUNDED.`
      );
    }

    const totalCartCents = BigInt(cart.totalCartCents);
    const cumulativeRefundedCents = BigInt(cart.cumulativeRefundedCents || 0);
    const remainingBalance = totalCartCents - cumulativeRefundedCents;
    const reqAmountCents = BigInt(input.amountCents);

    if (reqAmountCents <= BigInt(0)) {
      throw new Error("ERR_INVALID_REFUND_AMOUNT: Refund amount must be greater than zero.");
    }
    if (reqAmountCents > remainingBalance) {
      const err = new Error(
        `ERR_REFUND_EXCEEDS_BALANCE: Requested refund amount (${reqAmountCents.toString()} cents) exceeds remaining refundable balance (${remainingBalance.toString()} cents).`
      );
      (err as any).code = "22023";
      throw err;
    }

    const peRes = await this.client.query(
      `SELECT id, capture_id FROM public."PaymentEvidenceRecord" WHERE cart_id = $1`,
      [cartId]
    );

    if (peRes.rows.length === 0) {
      throw new Error(`ERR_NO_PAYMENT_EVIDENCE: Cart "${cartId}" has no payment evidence record.`);
    }

    const captureId = peRes.rows[0].capture_id;

    // 2. Record refund via R2-06
    const refundResult = await this.recordRefund({
      cartId,
      captureId,
      transmissionId,
      reason,
      nonce,
    });

    return {
      refundEvidenceId: refundResult.refundEvidenceId,
      cartId,
      captureId,
      status: refundResult.status,
      cumulativeRefundedCents: refundResult.cumulativeRefundedCents,
      recordedAt: refundResult.recordedAt,
    };
  }

  /**
   * Executes a refund against the payment gateway (PayPal REST v2 adapter).
   *
   * Guaranteed Invariants (DEF-P4-01 Remediation):
   * 1. A refund intent is durably persisted in PostgreSQL (prepare_cart_refund) before gateway dispatch.
   * 2. The persisted refund record has a stable UUIDv4 identity (CartRefundRecord.id).
   * 3. The PayPal PayPal-Request-Id header is strictly set to that persisted identity.
   * 4. Every retry, worker recovery, and process restart reuses the same identifier.
   * 5. No new random identifier is generated at dispatch time.
   * 6. A retry cannot create a second independent refund intent for the same logical refund operation.
   * 7. Concurrent requests cannot bypass existing refundable-balance protections.
   * 8. Ambiguous provider timeouts remain recoverable and do not trigger duplicate refunds.
   * 9. Missing persisted identity or missing idempotencyKey fails closed.
   */
  async executeGatewayRefund(input: ExecuteGatewayRefundInput): Promise<ExecuteGatewayRefundResult> {
    if (!this.gatewayClient) {
      throw new Error("ERR_NO_GATEWAY_CLIENT: Payment gateway client is required for executeGatewayRefund.");
    }

    const { cartId, reason, currency = "USD" } = input;
    const idempotencyKey = input.idempotencyKey;

    if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      throw new Error(
        "ERR_MISSING_IDEMPOTENCY_KEY: A durable idempotencyKey is required to pre-persist refund intent before gateway dispatch."
      );
    }

    const reqAmountCents = BigInt(input.amountCents);

    if (reqAmountCents <= BigInt(0)) {
      throw new Error("ERR_INVALID_REFUND_AMOUNT: Refund amount must be greater than zero.");
    }

    // 1. Durably prepare and persist refund intent in PostgreSQL BEFORE gateway dispatch via prepare_cart_refund
    const prepRes = await this.client.query(
      `SELECT refund_record_id, cart_id, capture_id, idempotency_key,
              amount_cents, currency, status, is_existing, created_at
         FROM public.prepare_cart_refund($1, $2, $3, $4, $5);`,
      [cartId, reqAmountCents.toString(), idempotencyKey, reason, currency]
    );

    const intent = prepRes.rows[0];
    const refundRecordId = intent.refund_record_id;
    const captureId = intent.capture_id;

    // 2. If existing intent was already COMPLETED, return cached completion without calling gateway
    if (intent.status === "COMPLETED") {
      const existingRes = await this.client.query(
        `SELECT gateway_refund_id, amount_cents, currency, updated_at
           FROM public."CartRefundRecord"
          WHERE id = $1;`,
        [refundRecordId]
      );
      const row = existingRes.rows[0];
      return {
        cartId,
        captureId,
        outcome: "COMPLETED",
        refundId: row.gateway_refund_id || undefined,
        refundRecordId,
        amountCents: Number(row.amount_cents),
        currency: row.currency,
        idempotencyKey: refundRecordId,
        refundedAt: row.updated_at ? new Date(row.updated_at) : undefined,
      };
    }

    // 3. Dispatch to payment gateway with idempotencyKey = refundRecordId (the durable persisted UUIDv4 identity)
    // NEVER a dispatch-only key or in-memory generated UUID!
    const gatewayRes = await this.gatewayClient.refundPayment({
      captureId,
      cartId,
      amountCents: Number(reqAmountCents),
      currency,
      reason,
      idempotencyKey: refundRecordId,
    });

    // 4. Update durable refund intent with authoritative gateway outcome
    await this.client.query(
      `SELECT public.update_cart_refund_status($1, $2, $3, $4, $5);`,
      [
        refundRecordId,
        gatewayRes.outcome,
        gatewayRes.refundId || null,
        gatewayRes.errorCode || null,
        gatewayRes.errorMessage || null,
      ]
    );

    return {
      cartId,
      captureId,
      outcome: gatewayRes.outcome,
      refundId: gatewayRes.refundId,
      refundRecordId,
      amountCents: gatewayRes.amountCents,
      currency: gatewayRes.currency,
      idempotencyKey: refundRecordId,
      errorCode: gatewayRes.errorCode,
      errorMessage: gatewayRes.errorMessage,
      refundedAt: gatewayRes.refundedAt,
    };
  }
}

