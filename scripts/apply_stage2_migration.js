const { Client } = require('pg');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Enforce loading strictly from .env.stage2
const envConfig = dotenv.parse(fs.readFileSync(path.resolve('.env.stage2')));
if (!envConfig.DATABASE_URL || !envConfig.DATABASE_URL.includes('plinthly_stage2_dev')) {
  console.error('FATAL: .env.stage2 does not point to plinthly_stage2_dev!');
  process.exit(1);
}

const client = new Client({ connectionString: envConfig.DATABASE_URL });

async function runMigration() {
  await client.connect();
  
  // Mandatory Safety Check 1: Verify current database
  const dbCheck = await client.query('SELECT current_database(), inet_server_addr(), inet_server_port();');
  const row = dbCheck.rows[0];
  console.log('Safety preflight check:', row);
  
  if (row.current_database !== 'plinthly_stage2_dev') {
    console.error(`FATAL: Connected to unexpected database '${row.current_database}'! Expected 'plinthly_stage2_dev'. ABORTING.`);
    process.exit(1);
  }
  
  const serverAddr = row.inet_server_addr ? row.inet_server_addr.toString() : '127.0.0.1';
  if (serverAddr !== '127.0.0.1' && serverAddr !== '::1') {
    console.error(`FATAL: Connected to remote host '${serverAddr}'! Expected local instance. ABORTING.`);
    process.exit(1);
  }

  console.log('Safety checks PASSED. Executing Phase 1 DDL...');

  // Step 1: Execute init_roles.sql
  const rolesSql = fs.readFileSync(path.resolve('prisma/migrations/init_roles.sql'), 'utf8');
  console.log('Applying init_roles.sql...');
  await client.query(rolesSql);
  console.log('init_roles.sql applied successfully.');

  // Step 2: Execute migration.sql
  const migrationSqlPath = path.resolve('prisma/migrations/20261107000000_stage2_schema/migration.sql');
  const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8');
  console.log('Applying 20261107000000_stage2_schema/migration.sql...');
  
  const startTime = Date.now();
  await client.query(migrationSql);
  const finishedTime = Date.now();
  console.log('20261107000000_stage2_schema/migration.sql applied successfully.');

  // Step 3: Record in _prisma_migrations
  const migrationName = '20261107000000_stage2_schema';
  const checksum = crypto.createHash('sha256').update(migrationSql).digest('hex');
  const migrationId = crypto.randomUUID();

  // Check if already recorded
  const checkRec = await client.query('SELECT id FROM _prisma_migrations WHERE migration_name = $1', [migrationName]);
  if (checkRec.rows.length === 0) {
    await client.query(`
      INSERT INTO _prisma_migrations (
        id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
      ) VALUES ($1, $2, clock_timestamp(), $3, $4, NULL, clock_timestamp(), 1)
    `, [migrationId, checksum, migrationName, 'Phase 1 Stage 2 schema applied']);
    console.log(`Recorded migration '${migrationName}' in _prisma_migrations.`);
  }

  // Step 4: Verification of 13 entities
  const tables = [
    'ProcurementPlan',
    'ProcurementLineItem',
    'ApprovalAggregate',
    'ApprovedMerchantCart',
    'CartAllocation',
    'PlannedShipmentRecord',
    'AuditSigningKey',
    'TaxAuthorityCertificate',
    'NonceRegistry',
    'WebhookTransmission',
    'PaymentEvidenceRecord',
    'TaxEvidenceRecord',
    'RefundEvidenceRecord'
  ];

  const foundTables = await client.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = ANY($1)
  `, [tables]);

  console.log(`Verified ${foundTables.rows.length} / 13 Stage 2 tables in plinthly_stage2_dev:`);
  foundTables.rows.forEach(r => console.log('  - ' + r.table_name));

  if (foundTables.rows.length !== 13) {
    throw new Error(`Expected 13 Stage 2 tables, but found ${foundTables.rows.length}`);
  }

  // Step 5: Verification of trigger
  const triggerCheck = await client.query(`
    SELECT trigger_name, event_manipulation, event_object_table
    FROM information_schema.triggers
    WHERE trigger_name = 'trg_webhook_transmission_immutability'
  `);
  console.log('Trigger verification:', triggerCheck.rows);
  if (triggerCheck.rows.length === 0) {
    throw new Error('Trigger trg_webhook_transmission_immutability not found!');
  }

  await client.end();
  console.log('Phase 1 DDL execution & verification completed successfully!');
}

runMigration().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

