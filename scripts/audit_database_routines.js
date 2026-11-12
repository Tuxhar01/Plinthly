const { Client } = require('pg');
const fs = require('fs');
const dotenv = require('dotenv');

const cfg = dotenv.parse(fs.readFileSync('.env.stage2'));

async function audit() {
  const c = new Client({ connectionString: cfg.DATABASE_URL });
  await c.connect();

  console.log("=== 1. ROUTINE METADATA (OWNERSHIP, SECDEF, CONFIG) ===");
  const routines = [
    'record_tax_calculation_quote',
    'prepare_merchant_cart_capture',
    'record_webhook_transmission_ingress',
    'finalize_transmission_response',
    'execute_capture_confirmation',
    'record_cart_refund_attempt',
    'revoke_audit_signing_key',
    'revoke_tax_authority_certificate',
    'fn_parse_decimal_cents',
    'crypto_asym_verify'
  ];

  const resProc = await c.query(`
    SELECT 
      n.nspname AS schema,
      p.proname AS name,
      r.rolname AS owner,
      p.prosecdef AS security_definer,
      p.proconfig AS config,
      p.provolatile AS volatility
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_roles r ON p.proowner = r.oid
    WHERE p.proname = ANY($1)
    ORDER BY n.nspname, p.proname;
  `, [routines]);
  console.table(resProc.rows);

  console.log("\n=== 2. ROUTINE EXECUTION GRANTS ===");
  const resGrants = await c.query(`
    SELECT 
      p.proname,
      grantee,
      privilege_type
    FROM information_schema.routine_privileges rp
    JOIN pg_proc p ON p.proname = rp.routine_name
    WHERE routine_schema IN ('public', 'extensions')
      AND p.proname = ANY($1)
    ORDER BY p.proname, grantee;
  `, [routines]);
  console.table(resGrants.rows);

  console.log("\n=== 3. TABLE PRIVILEGES FOR APPLICATION ROLES ===");
  const roles = ['tax_verifier_role', 'app_orchestrator_role', 'webhook_ingress_role', 'admin_security_role'];
  const resTablePrivs = await c.query(`
    SELECT 
      grantee,
      table_name,
      string_agg(privilege_type, ', ') AS privileges
    FROM information_schema.table_privileges
    WHERE grantee = ANY($1)
      AND table_schema = 'public'
    GROUP BY grantee, table_name
    ORDER BY grantee, table_name;
  `, [roles]);
  console.table(resTablePrivs.rows);

  await c.end();
}

audit().catch(console.error);

