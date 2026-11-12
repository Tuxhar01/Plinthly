const { Client } = require('pg');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: '.env.stage2' });

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !dbUrl.includes('plinthly_stage2_dev')) {
    console.error('FATAL PREFLIGHT ERROR: DATABASE_URL is not targeting plinthly_stage2_dev!');
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const check = await client.query('SELECT current_database(), current_user, inet_server_addr(), inet_server_port();');
  const row = check.rows[0];
  console.log('Safety Preflight Check:');
  console.log('  Database:', row.current_database);
  console.log('  User:', row.current_user);

  if (row.current_database !== 'plinthly_stage2_dev') {
    console.error('FATAL PREFLIGHT ERROR: Connected database is NOT plinthly_stage2_dev! ABORTING.');
    await client.end();
    process.exit(1);
  }

  const migrationName = '20261107020000_stage2_canonical_routines';
  const migrationPath = path.resolve('prisma/migrations', migrationName, 'migration.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const checksum = crypto.createHash('sha256').update(sql).digest('hex');

  console.log(`Applying hardened migration ${migrationName}...`);
  console.log(`Checksum (SHA-256): ${checksum}`);

  const startTime = Date.now();
  await client.query('BEGIN');
  try {
    await client.query(sql);

    // Update or insert migration in _prisma_migrations
    await client.query(`
      DELETE FROM _prisma_migrations WHERE migration_name = $1;
    `, [migrationName]);

    await client.query(`
      INSERT INTO _prisma_migrations (
        id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
      ) VALUES (
        $1, $2, clock_timestamp(), $3, $4, NULL, clock_timestamp(), 1
      );
    `, [crypto.randomUUID(), checksum, migrationName, 'Applied Phase 2 canonical routines and six-level locking protocol']);

    await client.query('COMMIT');
    console.log(`Migration ${migrationName} successfully applied and committed in ${Date.now() - startTime}ms.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error applying migration. Transaction ROLLED BACK.');
    console.error(err);
    await client.end();
    process.exit(1);
  }

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
