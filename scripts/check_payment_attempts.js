const { Client } = require('pg');

async function check() {
  const c1 = new Client({ connectionString: 'postgresql://postgres:Tushar@2028@localhost:5432/plinthly_dev' });
  await c1.connect();
  const res1 = await c1.query('SELECT id, "purchaseId", "paypalOrderId", status FROM "PaymentAttempt"');
  console.log('plinthly_dev PaymentAttempts count:', res1.rows.length);
  console.log('plinthly_dev PaymentAttempts rows:', res1.rows);
  await c1.end();

  const c2 = new Client({ connectionString: 'postgresql://postgres:Tushar@2028@localhost:5432/plinthly_stage2_dev' });
  await c2.connect();
  const res2 = await c2.query('SELECT id, "purchaseId", "paypalOrderId", status FROM "PaymentAttempt"');
  console.log('plinthly_stage2_dev PaymentAttempts count:', res2.rows.length);
  console.log('plinthly_stage2_dev PaymentAttempts rows:', res2.rows);
  await c2.end();
}

check().catch(console.error);
