const { Client } = require('pg');

async function run() {
  const client = new Client({ connectionString: 'postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_dev?schema=public' });
  await client.connect();

  const evItems = await client.query('SELECT count(*) FROM "EvidenceItem" WHERE "candidateId" LIKE $1', ['cand_ch3_%']);
  console.log('EvidenceItem count for candidateId cand_ch3_%:', evItems.rows[0].count);

  const polResults = await client.query('SELECT count(*) FROM "PolicyResult" WHERE "purchaseId" = $1', ['pur_1794149129429_osas38ir']);
  console.log('PolicyResult count for target purchase:', polResults.rows[0].count);

  await client.end();
}

run().catch(console.error);

