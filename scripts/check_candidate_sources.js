const { Client } = require('pg');

async function run() {
  const client = new Client({ connectionString: 'postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_dev?schema=public' });
  await client.connect();
  const res = await client.query('SELECT source, count(*) FROM "Candidate" WHERE "purchaseId" = $1 GROUP BY source', ['pur_1794149129429_osas38ir']);
  console.log('Candidate sources:', res.rows);
  await client.end();
}

run().catch(console.error);

