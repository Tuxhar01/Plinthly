const { Client } = require('pg');
const PG_CONN = 'postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_dev?schema=public';

async function run() {
  const client = new Client({ connectionString: PG_CONN });
  await client.connect();

  const purchaseId = 'pur_1794149129429_osas38ir';
  const cRes = await client.query('SELECT id, title, "merchantName", "unitPriceCents", "merchantUrl", "source", "capturedAt", "snapshotHash", "externalId" FROM "Candidate" WHERE "purchaseId" = $1', [purchaseId]);

  console.log(`=== Candidate URLs & Evidence Audit (${cRes.rows.length} candidates) ===`);

  // Sample check of URLs
  const sampleUrls = cRes.rows.slice(0, 8);
  sampleUrls.forEach((c, i) => {
    console.log(`[${i+1}] ID: ${c.id}`);
    console.log(`    Title: ${c.title}`);
    console.log(`    Merchant: ${c.merchantName}`);
    console.log(`    URL: ${c.merchantUrl}`);
    console.log(`    Price: $${(c.unitPriceCents/100).toFixed(2)}`);
    console.log(`    CapturedAt: ${c.capturedAt.toISOString()}`);
    console.log(`    SnapshotHash: ${c.snapshotHash}`);
    console.log(`    ExternalId: ${c.externalId}`);
  });

  // Check for duplicates
  const extIdMap = new Map();
  const duplicates = [];
  for (const c of cRes.rows) {
    if (extIdMap.has(c.externalId)) {
      duplicates.push({ id1: extIdMap.get(c.externalId), id2: c.id, externalId: c.externalId });
    } else {
      extIdMap.set(c.externalId, c.id);
    }
  }
  console.log('\nDuplicate externalId count:', duplicates.length);

  // Check for synthetic source
  const synthetic = cRes.rows.filter(c => c.source === 'seeded' || c.merchantName.includes('Synthetic') || c.title.includes('Synthetic'));
  console.log('Synthetic candidates count in target purchase:', synthetic.length);

  await client.end();
}

run().catch(console.error);

