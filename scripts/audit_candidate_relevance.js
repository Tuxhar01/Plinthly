const { Client } = require('pg');
const PG_CONN = 'postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_dev?schema=public';

async function run() {
  const client = new Client({ connectionString: PG_CONN });
  await client.connect();

  const purchaseId = 'pur_1794149129429_osas38ir';
  const pRes = await client.query('SELECT * FROM "Purchase" WHERE id = $1', [purchaseId]);
  console.log('=== Purchase Record ===');
  console.log('ID:', pRes.rows[0].id);
  console.log('Status:', pRes.rows[0].status);
  console.log('BudgetCents:', pRes.rows[0].budgetCents);
  console.log('Requirements:', JSON.stringify(pRes.rows[0].requirements, null, 2));

  const cRes = await client.query('SELECT * FROM "Candidate" WHERE "purchaseId" = $1', [purchaseId]);
  console.log('\n=== Candidate Pool ===');
  console.log('Total Candidates:', cRes.rows.length);

  const laptops = [];
  const monitors = [];
  const others = [];

  for (const c of cRes.rows) {
    const t = (c.title || '').toLowerCase();
    if (t.includes('laptop') || t.includes('notebook') || t.includes('thinkpad') || t.includes('zenbook') || t.includes('inspiron')) {
      laptops.push(c);
    } else if (t.includes('monitor') || t.includes('display')) {
      monitors.push(c);
    } else {
      others.push(c);
    }
  }

  console.log(`Laptops count: ${laptops.length}`);
  console.log(`Monitors count: ${monitors.length}`);
  console.log(`Others count: ${others.length}`);

  console.log('\n--- Laptop Candidates Analysis ---');
  laptops.forEach((l, i) => {
    console.log(`[Laptop ${i+1}] ID: ${l.id} | Price: $${(l.unitPriceCents/100).toFixed(2)} | Title: "${l.title}" | Merchant: ${l.merchantName}`);
    if (l.title.includes('P50') || l.title.includes('ThinkPad')) {
      console.log('   P50 Full Attributes:', JSON.stringify(l.rawAttributes));
      console.log('   P50 RawSourceData:', JSON.stringify(l.rawSourceData));
    }
  });

  console.log('\n--- Monitor Candidates Analysis (Top 5) ---');
  monitors.slice(0, 5).forEach((m, i) => {
    console.log(`[Monitor ${i+1}] ID: ${m.id} | Price: $${(m.unitPriceCents/100).toFixed(2)} | Title: "${m.title}" | Merchant: ${m.merchantName}`);
    console.log('   Attributes:', JSON.stringify(m.rawAttributes));
  });

  await client.end();
}

run().catch(console.error);

