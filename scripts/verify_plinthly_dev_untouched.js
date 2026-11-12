const { Client } = require('pg');
const dotenv = require('dotenv');
const fs = require('fs');

const envLocal = dotenv.parse(fs.readFileSync('.env.local'));
const client = new Client({ connectionString: envLocal.DATABASE_URL });

async function checkOriginalDev() {
  await client.connect();
  const dbInfo = await client.query('SELECT current_database();');
  console.log('Connected to original DB:', dbInfo.rows[0].current_database);
  if (dbInfo.rows[0].current_database !== 'plinthly_dev') {
    throw new Error('Not connected to plinthly_dev');
  }

  // 1. Check purchase count
  const pCount = await client.query('SELECT count(*)::int AS count FROM "Purchase";');
  console.log('plinthly_dev purchase count:', pCount.rows[0].count);

  // 2. Check completed captures
  const paCount = await client.query('SELECT count(*)::int AS count FROM "PaymentAttempt" WHERE status = \'COMPLETED\';');
  console.log('plinthly_dev completed payment attempts:', paCount.rows[0].count);

  // 3. Check protected purchases
  const p1 = await client.query('SELECT id, status, version FROM "Purchase" WHERE id = $1;', ['pur_1792633876502_s7jvwi22']);
  const p2 = await client.query('SELECT id, status, version FROM "Purchase" WHERE id = $1;', ['pur_1792654701712_f2iks5to']);
  console.log('Protected purchase 1:', p1.rows[0]);
  console.log('Protected purchase 2:', p2.rows[0]);

  // 4. Check that zero Stage 2 tables exist in plinthly_dev
  const stage2Tables = [
    'ProcurementPlan',
    'ProcurementLineItem',
    'ApprovalAggregate',
    'ApprovedMerchantCart',
    'CartAllocation',
    'PlannedShipmentRecord',
    'AuditSigningKey',
    'TaxAuthorityCertificate',
    'NonceRegistry',
    'WebhookTransmission',
    'PaymentEvidenceRecord',
    'TaxEvidenceRecord',
    'RefundEvidenceRecord'
  ];
  const foundS2 = await client.query(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = \'public\' AND table_name = ANY($1);',
    [stage2Tables]
  );
  console.log('Stage 2 tables in plinthly_dev (should be 0):', foundS2.rows.length);

  await client.end();
}

checkOriginalDev().catch(err => {
  console.error(err);
  process.exit(1);
});

