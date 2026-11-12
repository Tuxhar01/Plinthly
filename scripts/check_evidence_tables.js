const { Client } = require('pg');

async function run() {
  const client = new Client({ connectionString: 'postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_dev?schema=public' });
  await client.connect();
  const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  console.log('Tables:', tables.rows.map(r => r.table_name));

  if (tables.rows.some(r => r.table_name === 'EvidenceRecord')) {
    const ev = await client.query('SELECT count(*) FROM "EvidenceRecord"');
    console.log('EvidenceRecord count:', ev.rows[0].count);
  }
  await client.end();
}

run().catch(console.error);

