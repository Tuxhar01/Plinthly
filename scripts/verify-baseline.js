const { Client } = require("pg");
const crypto = require("crypto");
const fs = require("fs");
const dotenv = require("dotenv");

async function verifyBaseline() {
  const gate1Bytes = fs.readFileSync("C:\\paypal-gate1\\gate1.mjs");
  const gate1Hash = crypto.createHash("sha256").update(gate1Bytes).digest("hex").toUpperCase();
  const dumpBytes = fs.readFileSync(".backups/plinthly_dev_stage1_baseline.dump");
  const dumpHash = crypto.createHash("sha256").update(dumpBytes).digest("hex").toUpperCase();

  console.log("Gate 1 Hash: ", gate1Hash);
  console.log("Dump Hash:   ", dumpHash);

  const envConfig = dotenv.parse(fs.readFileSync(".env.local"));
  const client = new Client({ connectionString: envConfig.DATABASE_URL });
  await client.connect();

  const pCols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'Purchase';");
  console.log("Purchase columns:", pCols.rows.map((r) => r.column_name));

  const paCols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'PaymentAttempt';");
  console.log("PaymentAttempt columns:", paCols.rows.map((r) => r.column_name));

  const pRes = await client.query('SELECT count(*) FROM "Purchase";');
  const paRes = await client.query('SELECT count(*) FROM "PaymentAttempt";');
  const s2Res = await client.query(
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('MerchantCartCapture', 'ApprovalAggregate', 'ApprovedMerchantCart', 'WebhookTransmissionRecord', 'TaxCalculationEvidence', 'AuditSigningKey');"
  );
  const ordRes = await client.query('SELECT id, status FROM "Purchase" WHERE id LIKE \'%01rg028x%\';');

  console.log("Purchase count: ", pRes.rows[0].count);
  console.log("PaymentAttempt count: ", paRes.rows[0].count);
  console.log("Stage 2 tables in plinthly_dev: ", s2Res.rows[0].count);
  console.log("Quarantined order: ", ordRes.rows[0]);

  await client.end();
}

verifyBaseline().catch((err) => {
  console.error("Baseline verification error:", err);
  process.exit(1);
});
