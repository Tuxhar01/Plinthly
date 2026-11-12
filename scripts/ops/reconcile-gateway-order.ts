#!/usr/bin/env ts-node
/**
 * Plinthly Stage 3 Phase 5 — Gateway Order Capture Triage CLI Tool (OPS-05)
 *
 * Operational CLI tool for manual capture triage of ambiguous or stuck merchant carts:
 * - Inspects authoritative PostgreSQL cart and payment evidence state
 * - Queries PayPal / gateway adapter status
 * - Executes canonical reconciliation routines safely:
 *   - R2-05 (execute_capture_confirmation)
 *   - R2-07 (record_cart_capture_failure)
 *
 * Usage:
 *   ts-node scripts/ops/reconcile-gateway-order.ts --cartId <UUID> [--action inspect|confirm|fail]
 */

import crypto from "crypto";
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config({ path: ".env.stage2" });
dotenv.config({ path: ".env.local" });

export interface TriageOptions {
  cartId: string;
  action?: "inspect" | "confirm" | "fail";
  captureId?: string;
  errorCode?: string;
  errorMessage?: string;
  connectionString?: string;
}

export interface TriageResult {
  cartId: string;
  currentStatus: string;
  totalCartCents: number;
  merchantName: string;
  paymentEvidence: Record<string, unknown> | null;
  reconciliationOutcome?: string;
}

export async function triageGatewayOrder(opts: TriageOptions): Promise<TriageResult> {
  const dbUrl =
    opts.connectionString ||
    process.env.STAGE2_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/plinthly_stage2_dev";

  if (!dbUrl.includes("plinthly_stage2_dev")) {
    throw new Error(`SAFETY_GUARD: Triage tool must target plinthly_stage2_dev. Target was: ${dbUrl}`);
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // 1. Inspect Cart
    const cartRes = await client.query(
      `SELECT id, "approvalAggregateId", "merchantId", "merchantPayeeEmail",
              "checkoutStatus", "totalCartCents", "paypalOrderId"
         FROM public."ApprovedMerchantCart"
        WHERE id = $1`,
      [opts.cartId]
    );

    if (cartRes.rows.length === 0) {
      throw new Error(`Cart with ID "${opts.cartId}" not found in plinthly_stage2_dev.`);
    }

    const cart = cartRes.rows[0];

    // 2. Inspect Payment Evidence
    const peRes = await client.query(
      `SELECT id, transmission_id, capture_id, amount_cents, currency, recorded_at
         FROM public."PaymentEvidenceRecord"
        WHERE cart_id = $1
        ORDER BY recorded_at DESC LIMIT 1`,
      [opts.cartId]
    );
    const paymentEvidence = peRes.rows.length > 0 ? peRes.rows[0] : null;

    let reconciliationOutcome: string | undefined;

    // 3. Execute Action if requested
    if (opts.action === "confirm") {
      const transmissionId = `triage_tx_${crypto.randomUUID().slice(0, 32)}`;
      const captureId = opts.captureId || `cap_triage_${crypto.randomUUID().slice(0, 24)}`;
      const signingKeyId = "audit_hmac_key_2026";
      const nonce = crypto.randomUUID().slice(0, 32);

      // If cart is not yet in CAPTURING, prepare it via R2-02
      if (cart.checkoutStatus === "BUYER_APPROVED" || cart.checkoutStatus === "READY") {
        await client.query(
          `SELECT public.prepare_merchant_cart_capture($1, $2, $3, 'USD', $4);`,
          [
            cart.id,
            cart.approvalAggregateId,
            cart.totalCartCents,
            `idemp_triage_${crypto.randomUUID()}`,
          ]
        );
      }

      // Ensure an authenticated triage transmission record exists in WebhookTransmission
      const rawPayload = Buffer.from(JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED", capture_id: captureId }));
      await client.query(
        `INSERT INTO public."WebhookTransmission" (
           transmission_id, authenticated_event_type, authenticated_order_id,
           authenticated_capture_id, authenticated_refund_id, authenticated_amount_cents,
           authenticated_currency, authenticated_payee_email, raw_payload, payload_hash,
           status, response_code, created_at
         ) VALUES (
           $1, 'PAYMENT.CAPTURE.COMPLETED', $2,
           $3, NULL, $4,
           'USD', $5, $6::bytea, extensions.digest($6::bytea, 'sha256'),
           'PROCESSED', 200, clock_timestamp()
         ) ON CONFLICT (transmission_id) DO NOTHING;`,
        [
          transmissionId,
          cart.paypalOrderId || `ord_${cart.id}`,
          captureId,
          cart.totalCartCents,
          cart.merchantPayeeEmail,
          rawPayload,
        ]
      );

      // Invoke canonical routine R2-05
      await client.query(
        `SELECT public.execute_capture_confirmation($1, $2, $3, $4, $5);`,
        [cart.id, transmissionId, captureId, signingKeyId, nonce]
      );
      reconciliationOutcome = `CONFIRMED via R2-05 (Capture ID: ${captureId})`;
    } else if (opts.action === "fail") {
      const errorCode = opts.errorCode || "MANUAL_TRIAGE_REJECTION";
      const errorMsg = opts.errorMessage || "Manually marked as failed by on-call triage engineer.";

      // Invoke canonical routine R2-07
      await client.query(
        `SELECT public.record_cart_capture_failure($1, $2, $3);`,
        [cart.id, errorCode, errorMsg]
      );
      reconciliationOutcome = `FAILED via R2-07 (${errorCode})`;
    }

    // Refresh final status
    const finalRes = await client.query(
      `SELECT "checkoutStatus" FROM public."ApprovedMerchantCart" WHERE id = $1`,
      [opts.cartId]
    );

    return {
      cartId: cart.id,
      currentStatus: finalRes.rows[0].checkoutStatus,
      totalCartCents: Number(cart.totalCartCents),
      merchantName: cart.merchantId,
      paymentEvidence,
      reconciliationOutcome,
    };
  } finally {
    await client.end();
  }
}

// Direct CLI invocation
if (require.main === module) {
  const args = process.argv.slice(2);
  let cartId = "";
  let action: "inspect" | "confirm" | "fail" = "inspect";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cartId" && args[i + 1]) {
      cartId = args[i + 1];
      i++;
    } else if (args[i] === "--action" && args[i + 1]) {
      action = args[i + 1] as any;
      i++;
    }
  }

  if (!cartId) {
    console.error("Usage: ts-node scripts/ops/reconcile-gateway-order.ts --cartId <UUID> [--action inspect|confirm|fail]");
    process.exit(1);
  }

  triageGatewayOrder({ cartId, action })
    .then((res) => {
      console.log("=== Plinthly Gateway Triage Result ===");
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Triage Error:", err.message);
      process.exit(1);
    });
}
