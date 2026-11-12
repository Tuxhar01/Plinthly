const { Client } = require('pg');

async function run() {
  const client = new Client({ connectionString: 'postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_dev?schema=public' });
  await client.connect();
  const p = await client.query('SELECT * FROM "Purchase" WHERE id = $1', ['pur_1794149129429_osas38ir']);
  const audits = await client.query('SELECT * FROM "AuditEvent" WHERE "purchaseId" = $1 ORDER BY "createdAt" ASC', ['pur_1794149129429_osas38ir']);
  const candidates = await client.query('SELECT * FROM "Candidate" WHERE "purchaseId" = $1', ['pur_1794149129429_osas38ir']);
  const approvals = await client.query('SELECT * FROM "Approval" WHERE "purchaseId" = $1', ['pur_1794149129429_osas38ir']);

  console.log('=== TARGET PURCHASE ===');
  console.log(JSON.stringify(p.rows[0], null, 2));

  console.log('\n=== AUDIT EVENTS (' + audits.rows.length + ') ===');
  audits.rows.forEach(a => {
    console.log(`[${a.createdAt.toISOString()}] type=${a.type}, actor=${JSON.stringify(a.actor)}`);
    if (a.payload) console.log('  Payload:', JSON.stringify(a.payload));
  });

  console.log('\n=== CANDIDATES (' + candidates.rows.length + ') ===');
  candidates.rows.forEach(c => {
    console.log(`Candidate ${c.id}: ${c.title} (${c.merchantId})`);
  });

  console.log('\n=== APPROVALS (' + approvals.rows.length + ') ===');
  approvals.rows.forEach(ap => {
    console.log(`Approval ${ap.id}: ${ap.status}`);
  });

  await client.end();
}

run().catch(console.error);
