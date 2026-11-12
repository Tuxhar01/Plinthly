const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');
const dotenv = require('dotenv');

async function check() {
  const content = fs.readFileSync('prisma/migrations/20261107020000_stage2_canonical_routines/migration.sql');
  const fileHash = crypto.createHash('sha256').update(content).digest('hex');

  const cfg = dotenv.parse(fs.readFileSync('.env.stage2'));
  const c = new Client({ connectionString: cfg.DATABASE_URL });
  await c.connect();

  const res = await c.query("SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = '20261107020000_stage2_canonical_routines';");
  const row = res.rows[0];
  const dbChecksum = row.checksum;

  console.log({
    migration_name: row.migration_name,
    file_sha256: fileHash,
    db_checksum: dbChecksum,
    matches: fileHash === dbChecksum,
    finished_at: row.finished_at,
    rolled_back_at: row.rolled_back_at
  });

  await c.end();
}

check().catch(console.error);

