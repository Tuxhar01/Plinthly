const { Client } = require('pg');

async function run() {
  const client = new Client({ connectionString: 'postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_dev?schema=public' });
  await client.connect();
  const c1 = await client.query('SELECT * FROM "Candidate" WHERE "purchaseId" = $1 LIMIT 2', ['pur_1794149129429_osas38ir']);
  console.log('Sample candidates:');
  console.log(JSON.stringify(c1.rows, null, 2));
  await client.end();
}

run().catch(console.error);

