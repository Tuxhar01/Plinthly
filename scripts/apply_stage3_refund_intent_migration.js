const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');
const dotenv = require('dotenv');

const cfg = dotenv.parse(fs.readFileSync('.env.stage2'));

async function applyMigration() {
  const c = new Client({ connectionString: cfg.DATABASE_URL });
  await c.connect();

  const migrationName = '20261108030000_stage3_refund_intent_pre_persistence';
  const sqlPath = `prisma/migrations/${migrationName}/migration.sql`;
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(sqlPath)).digest('hex');

  console.log(`Applying forward migration ${migrationName}...`);
  console.log(`Computed SHA-256 Checksum: ${checksum}`);

  // Safety preflight: strictly plinthly_stage2_dev only
  const dbRes = await c.query('SELECT current_database(), current_user;');
  if (dbRes.rows[0].current_database !== 'plinthly_stage2_dev') {
    throw new Error(`FATAL: Not connected to plinthly_stage2_dev! Connected to: ${dbRes.rows[0].current_database}`);
  }

  await c.query('BEGIN;');
  await c.query(sql);

  // Record in _prisma_migrations
  await c.query(`
    INSERT INTO _prisma_migrations (
      id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
    ) VALUES (
      $1, $2, clock_timestamp(), $3, NULL, NULL, clock_timestamp(), 1
    ) ON CONFLICT (id) DO NOTHING;
  `, [crypto.randomUUID(), checksum, migrationName]);

  await c.query('COMMIT;');
  console.log('Migration applied and tracked in _prisma_migrations successfully!');

  await c.end();
}

applyMigration().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});

