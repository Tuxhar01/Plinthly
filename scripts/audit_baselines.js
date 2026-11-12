const { Client } = require('pg');
const fs = require('fs');
const crypto = require('crypto');

async function auditBaselines() {
  console.log('=== 1. AUDITING STAGE 1 DATABASE (plinthly_dev) ===');
  const clientDev = new Client({ connectionString: 'postgresql://postgres:Tushar@2028@localhost:5432/plinthly_dev' });
  await clientDev.connect();

  const dbDevInfo = await clientDev.query(`
    SELECT current_database(), pg_database.oid 
    FROM pg_database 
    WHERE datname = current_database()
  `);
  console.log('Database identity:', dbDevInfo.rows[0]);

  const purCount = await clientDev.query('SELECT count(*) FROM "Purchase"');
  console.log('Purchase count:', purCount.rows[0].count);

  const payCount = await clientDev.query('SELECT count(*) FROM "PaymentAttempt"');
  console.log('PaymentAttempt count:', payCount.rows[0].count);

  const protPur = await clientDev.query(`
    SELECT id, status, version, "updatedAt" 
    FROM "Purchase" 
    WHERE id IN ('pur_1792633876502_s7jvwi22', 'pur_1792654701712_f2iks5to')
    ORDER BY id
  `);
  console.log('Protected purchases:', protPur.rows);

  const stage2Tables = await clientDev.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_name IN ('ApprovedMerchantCart', 'TaxEvidenceRecord', 'AuditSigningKey', 'NonceRegistry')
  `);
  console.log('Stage 2 tables in plinthly_dev (must be 0):', stage2Tables.rows.length);

  await clientDev.end();

  console.log('\n=== 2. AUDITING STAGE 2 DATABASE (plinthly_stage2_dev) ===');
  const clientStage2 = new Client({ connectionString: 'postgresql://postgres:Tushar@2028@localhost:5432/plinthly_stage2_dev' });
  await clientStage2.connect();

  const dbStage2Info = await clientStage2.query(`
    SELECT current_database(), pg_database.oid 
    FROM pg_database 
    WHERE datname = current_database()
  `);
  console.log('Database identity:', dbStage2Info.rows[0]);

  const s2PurCount = await clientStage2.query('SELECT count(*) FROM "Purchase"');
  console.log('Stage 2 Purchase count:', s2PurCount.rows[0].count);

  const s2ProtPur = await clientStage2.query(`
    SELECT id, status, version, "updatedAt" 
    FROM "Purchase" 
    WHERE id IN ('pur_1792633876502_s7jvwi22', 'pur_1792654701712_f2iks5to')
    ORDER BY id
  `);
  console.log('Stage 2 protected purchases:', s2ProtPur.rows);

  const s2Stage2Tables = await clientStage2.query(`
    SELECT count(*) 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_name IN ('ApprovedMerchantCart', 'TaxEvidenceRecord', 'AuditSigningKey', 'NonceRegistry')
  `);
  console.log('Stage 2 tables in plinthly_stage2_dev:', s2Stage2Tables.rows[0].count);

  await clientStage2.end();

  console.log('\n=== 3. AUDITING FILE CHECKSUMS ===');
  const backupPath = '.backups/plinthly_dev_stage1_baseline.dump';
  if (fs.existsSync(backupPath)) {
    const backupBuf = fs.readFileSync(backupPath);
    const backupHash = crypto.createHash('sha256').update(backupBuf).digest('hex').toUpperCase();
    console.log('Backup SHA-256:', backupHash);
    console.log('Backup Size:', backupBuf.length);
  } else {
    console.log('Backup file NOT FOUND at', backupPath);
  }

  const gate1Path = 'C:/paypal-gate1/gate1.mjs';
  if (fs.existsSync(gate1Path)) {
    const gate1Buf = fs.readFileSync(gate1Path);
    const gate1Hash = crypto.createHash('sha256').update(gate1Buf).digest('hex').toUpperCase();
    console.log('Gate 1 script SHA-256:', gate1Hash);
    console.log('Gate 1 Size:', gate1Buf.length);
  } else {
    console.log('Gate 1 script NOT FOUND at', gate1Path);
  }
}

auditBaselines().catch(console.error);

