const { Client } = require('pg');
require('dotenv').config({ path: '.env.stage2' });

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const routines = [
    { name: 'record_tax_calculation_quote', sig: 'public.record_tax_calculation_quote(uuid, varchar, varchar, varchar, varchar, timestamptz, timestamptz, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, varchar, varchar, jsonb, jsonb, bytea, bytea, varchar, varchar, varchar, varchar, timestamptz, bytea, varchar, varchar)', authorizedRole: 'tax_verifier_role' },
    { name: 'prepare_merchant_cart_capture', sig: 'public.prepare_merchant_cart_capture(uuid, uuid, bigint, varchar, varchar)', authorizedRole: 'app_orchestrator_role' },
    { name: 'record_webhook_transmission_ingress', sig: 'public.record_webhook_transmission_ingress(varchar, varchar, varchar, varchar, varchar, bigint, varchar, varchar, bytea, varchar, varchar)', authorizedRole: 'webhook_ingress_role' },
    { name: 'finalize_transmission_response', sig: 'public.finalize_transmission_response(varchar, varchar, int)', authorizedRole: 'webhook_ingress_role' },
    { name: 'execute_capture_confirmation', sig: 'public.execute_capture_confirmation(uuid, varchar, varchar, varchar, varchar)', authorizedRole: 'app_orchestrator_role' },
    { name: 'record_cart_refund_attempt', sig: 'public.record_cart_refund_attempt(uuid, varchar, varchar, varchar, varchar, text)', authorizedRole: 'app_orchestrator_role' },
    { name: 'revoke_audit_signing_key', sig: 'public.revoke_audit_signing_key(varchar, text, varchar, varchar)', authorizedRole: 'admin_security_role' },
    { name: 'revoke_tax_authority_certificate', sig: 'public.revoke_tax_authority_certificate(varchar, varchar, text, varchar, varchar)', authorizedRole: 'admin_security_role' }
  ];

  const roles = [
    'public',
    'tax_verifier_role',
    'webhook_ingress_role',
    'app_orchestrator_role',
    'admin_security_role'
  ];

  console.log('Matrix Audit of Execute Privileges:');
  for (const r of routines) {
    console.log(`\nRoutine: ${r.name}`);
    for (const role of roles) {
      const q = await client.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') as has_exec;`, [role, r.sig]);
      const allowed = q.rows[0].has_exec;
      const expected = (role === r.authorizedRole);
      const mark = (role === 'public' && !allowed) || (role === r.authorizedRole && allowed) || (role !== r.authorizedRole && !allowed) ? 'PASS' : 'FAIL';
      console.log(`  Role [${role.padEnd(21)}]: ${allowed ? 'ALLOWED ' : 'DENIED  '} (Expected: ${expected ? 'ALLOWED ' : 'DENIED  '}) -> ${mark}`);
    }
  }

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

