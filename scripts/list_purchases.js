const { Client } = require('pg');

async function checkDb(url, name) {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const res = await client.query('SELECT id, status, "createdAt", "budgetCents", requirements FROM "Purchase" ORDER BY "createdAt" DESC LIMIT 10');
    console.log(name, 'Purchases:');
    res.rows.forEach(r => console.log(' ', r.id, r.status, r.budgetCents, JSON.stringify(r.requirements)));
  } catch (err) {
    console.log(name, 'Error:', err.message);
  } finally {
    await client.end();
  }
}

async function run() {
  await checkDb('postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_dev?schema=public', 'plinthly_dev');
  await checkDb('postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_stage2_dev?schema=public', 'plinthly_stage2_dev');
}
run();

