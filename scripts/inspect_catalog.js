const { Client } = require('pg');

async function inspectCatalog() {
  const client = new Client({ connectionString: 'postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_stage2_dev' });
  await client.connect();

  console.log('--- Database Identity ---');
  const dbRes = await client.query('SELECT current_database(), current_user, session_user, version()');
  console.log(dbRes.rows[0]);

  console.log('\n--- extensions.crypto_asym_verify Catalog Entry ---');
  const fnRes = await client.query(`
    SELECT p.proname, n.nspname, pg_get_functiondef(p.oid) as def,
           pg_get_userbyid(p.proowner) as owner,
           p.prosecdef as security_definer,
           p.provolatile,
           p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'crypto_asym_verify' AND n.nspname = 'extensions'
  `);
  console.log('Count:', fnRes.rows.length);
  if (fnRes.rows.length > 0) {
    console.log('Owner:', fnRes.rows[0].owner);
    console.log('Security Definer:', fnRes.rows[0].security_definer);
    console.log('Volatility:', fnRes.rows[0].provolatile);
    console.log('Config:', fnRes.rows[0].proconfig);
    console.log('\nDefinition:\n', fnRes.rows[0].def);
  }

  console.log('\n--- Routine Privileges for crypto_asym_verify ---');
  const privRes = await client.query(`
    SELECT grantee, privilege_type
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'extensions' AND routine_name = 'crypto_asym_verify'
  `);
  console.log(privRes.rows);

  console.log('\n--- Prisma Migrations Status ---');
  const migRes = await client.query(`
    SELECT migration_name, finished_at, checksum, applied_steps_count
    FROM _prisma_migrations
    ORDER BY finished_at ASC
  `);
  console.log(migRes.rows);

  await client.end();
}

inspectCatalog().catch(console.error);

