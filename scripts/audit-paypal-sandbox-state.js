const { Client } = require("pg");
const fs = require("fs");
const dotenv = require("dotenv");

async function main() {
  const env = dotenv.parse(fs.readFileSync(".env.local"));
  const lastResult = JSON.parse(fs.readFileSync("scripts/last-live-sandbox-result.json", "utf8"));

  console.log("================================================================================");
  console.log("PLINTHLY POST-LIFECYCLE INDEPENDENT AUDIT SCRIPT");
  console.log("================================================================================\n");

  // 1. OAuth2 Bearer Token
  const basicAuth = Buffer.from(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET).toString("base64");
  const tokenRes = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!tokenRes.ok) {
    console.error("FATAL: Failed to get OAuth2 token:", tokenRes.status);
    process.exit(1);
  }
  const token = (await tokenRes.json()).access_token;

  // 2. Query PayPal Order
  console.log("--- 1. Querying PayPal Order: 4MT765021L9327907 ---");
  const orderRes = await fetch(`https://api-m.sandbox.paypal.com/v2/checkout/orders/${lastResult.orderId}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const orderData = await orderRes.json();
  console.log(`Order Status: ${orderData.status}`);
  console.log(`Intent:       ${orderData.intent}`);

  // Inspect authorizations and captures inside order payments
  const payments = orderData.purchase_units?.[0]?.payments || {};
  const orderAuthorizations = payments.authorizations || [];
  const orderCaptures = payments.captures || [];
  console.log(`Order Authorizations Count: ${orderAuthorizations.length}`);
  console.log(`Order Captures Count:       ${orderCaptures.length}`);

  // 3. Query PayPal Authorization
  console.log(`\n--- 2. Querying PayPal Authorization: ${lastResult.authorizationId} ---`);
  const authRes = await fetch(`https://api-m.sandbox.paypal.com/v2/payments/authorizations/${lastResult.authorizationId}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const authData = await authRes.json();
  console.log(`Authorization Status: ${authData.status}`);
  console.log(`Authorized Amount:    ${authData.amount?.value} ${authData.amount?.currency_code}`);

  // 4. Query PayPal Capture
  console.log(`\n--- 3. Querying PayPal Capture: ${lastResult.captureId} ---`);
  const capRes = await fetch(`https://api-m.sandbox.paypal.com/v2/payments/captures/${lastResult.captureId}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const capData = await capRes.json();
  console.log(`Capture Status:    ${capData.status}`);
  console.log(`Gross Amount:      ${capData.amount?.value} ${capData.amount?.currency_code}`);
  console.log(`PayPal Fee:        ${capData.seller_receivable_breakdown?.paypal_fee?.value} USD`);
  console.log(`Net Amount:        ${capData.seller_receivable_breakdown?.net_amount?.value} USD`);

  // 5. Query PayPal Refund
  console.log(`\n--- 4. Querying PayPal Refund: ${lastResult.refundId} ---`);
  const refRes = await fetch(`https://api-m.sandbox.paypal.com/v2/payments/refunds/${lastResult.refundId}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const refData = await refRes.json();
  console.log(`Refund Status:     ${refData.status}`);
  console.log(`Refund Amount:     ${refData.amount?.value} ${refData.amount?.currency_code}`);
  console.log(`Note to Payer:     ${refData.note_to_payer}`);

  // 6. Database Verification in plinthly_stage2_dev
  console.log("\n--- 5. PostgreSQL Database Verification (plinthly_stage2_dev) ---");
  const dbUrl = env.STAGE2_DATABASE_URL || env.DATABASE_URL.replace("/plinthly_dev", "/plinthly_stage2_dev");
  const dbClient = new Client({ connectionString: dbUrl });
  await dbClient.connect();

  try {
    const cartRes = await dbClient.query(`
      SELECT id, "checkoutStatus", "merchandiseSubtotalCents", "totalCartCents", "cumulativeRefundedCents", "paypalOrderId"
        FROM public."ApprovedMerchantCart"
       WHERE id = $1
    `, [lastResult.records.cartId]);
    console.log("ApprovedMerchantCart:", cartRes.rows[0]);

    const payRes = await dbClient.query(`
      SELECT id, cart_id, capture_id, paypal_order_id, amount_cents, currency
        FROM public."PaymentEvidenceRecord"
       WHERE cart_id = $1
    `, [lastResult.records.cartId]);
    console.log("PaymentEvidenceRecord:", payRes.rows[0]);

    const refResDb = await dbClient.query(`
      SELECT id, cart_id, capture_id, amount_cents, currency, status, gateway_refund_id, refund_evidence_id
        FROM public."CartRefundRecord"
       WHERE id = $1
    `, [lastResult.records.refundRecordId]);
    console.log("CartRefundRecord:", refResDb.rows[0]);

    const refEvDb = await dbClient.query(`
      SELECT id, cart_id, capture_id, authenticated_refund_id, refund_amount_cents, currency
        FROM public."RefundEvidenceRecord"
       WHERE id = $1
    `, [lastResult.records.refundEvidenceId]);
    console.log("RefundEvidenceRecord:", refEvDb.rows[0]);

    const totalCapturesForCart = await dbClient.query(`
      SELECT COUNT(*)::int as count FROM public."PaymentEvidenceRecord" WHERE cart_id = $1
    `, [lastResult.records.cartId]);
    console.log(`Total PaymentEvidenceRecords for Cart: ${totalCapturesForCart.rows[0].count}`);

    const totalRefundsForCart = await dbClient.query(`
      SELECT COUNT(*)::int as count FROM public."CartRefundRecord" WHERE cart_id = $1
    `, [lastResult.records.cartId]);
    console.log(`Total CartRefundRecords for Cart: ${totalRefundsForCart.rows[0].count}`);

  } finally {
    await dbClient.end();
  }

  console.log("\n================================================================================");
  console.log("AUDIT SCRIPT VERIFICATION COMPLETED SUCCESSFULLY.");
  console.log("================================================================================");
}

main().catch(console.error);

