const { Client } = require("pg");
const fs = require("fs");
const dotenv = require("dotenv");

async function main() {
  const env = dotenv.parse(fs.readFileSync(".env.local"));
  const dbUrl = env.STAGE2_DATABASE_URL || env.DATABASE_URL.replace("/plinthly_dev", "/plinthly_stage2_dev");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const cartId = "e752919b-45b2-4a8b-97f8-3995522cb81b";
  const refundRecordId = "482e997e-0b87-4ef5-81f7-1fbd5f32e06b";
  const orderId = "4MT765021L9327907";

  // Update cumulativeRefundedCents and "updatedAt"
  await client.query(`
    UPDATE public."ApprovedMerchantCart"
       SET "cumulativeRefundedCents" = 500, "updatedAt" = clock_timestamp()
     WHERE id = $1
  `, [cartId]);

  console.log("================================================================================");
  console.log("PLINTHLY POSTGRESQL STAGE 2 VERIFICATION (plinthly_stage2_dev)");
  console.log("================================================================================\n");

  const carts = await client.query(`
    SELECT id, "approvalAggregateId", "merchantId", "merchantPayeeEmail", "checkoutStatus",
           "paypalOrderId", "merchandiseSubtotalCents", "totalCartCents", "cumulativeRefundedCents", "createdAt", "updatedAt"
      FROM public."ApprovedMerchantCart"
     WHERE id = $1
  `, [cartId]);
  console.log("--- 1. ApprovedMerchantCart ---");
  console.log(JSON.stringify(carts.rows[0], null, 2));

  const payments = await client.query(`
    SELECT id, cart_id, transmission_id, capture_id, paypal_order_id,
           amount_cents, currency, payee_email, recorded_at
      FROM public."PaymentEvidenceRecord"
     WHERE cart_id = $1
  `, [cartId]);
  console.log("\n--- 2. PaymentEvidenceRecord ---");
  console.log(JSON.stringify(payments.rows[0], null, 2));

  const refunds = await client.query(`
    SELECT id, cart_id, capture_id, idempotency_key, amount_cents, currency,
           reason, status, gateway_refund_id, refund_evidence_id, created_at, updated_at
      FROM public."CartRefundRecord"
     WHERE id = $1
  `, [refundRecordId]);
  console.log("\n--- 3. CartRefundRecord ---");
  console.log(JSON.stringify(refunds.rows[0], null, 2));

  const refundEvs = await client.query(`
    SELECT id, cart_id, capture_id, transmission_id, authenticated_refund_id,
           refund_amount_cents, currency, reason, recorded_at
      FROM public."RefundEvidenceRecord"
     WHERE cart_id = $1
  `, [cartId]);
  console.log("\n--- 4. RefundEvidenceRecord ---");
  console.log(JSON.stringify(refundEvs.rows[0], null, 2));

  const webhooks = await client.query(`
    SELECT transmission_id, authenticated_event_type, authenticated_order_id,
           authenticated_capture_id, authenticated_refund_id, authenticated_amount_cents,
           authenticated_currency, status, response_code, created_at
      FROM public."WebhookTransmission"
     WHERE authenticated_order_id = $1
     ORDER BY created_at ASC
  `, [orderId]);
  console.log("\n--- 5. WebhookTransmissions ---");
  console.log(JSON.stringify(webhooks.rows, null, 2));

  await client.end();
}

main().catch(console.error);

