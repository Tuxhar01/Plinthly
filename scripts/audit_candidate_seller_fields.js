const { Client } = require('pg');
const PG_CONN = 'postgresql://postgres:Tushar@2028@127.0.0.1:5432/plinthly_dev?schema=public';

async function run() {
  const client = new Client({ connectionString: PG_CONN });
  await client.connect();

  const cRes = await client.query(`
    SELECT id, title, "merchantName", "unitPriceCents", "sellerName", "isMarketplace", "isDirectRetailerSeller", "source"
    FROM "Candidate"
    WHERE "purchaseId" = 'pur_1794149129429_osas38ir' AND title LIKE '%ThinkPad P50%'
  `);

  console.log('ThinkPad P50 Candidate Row:');
  console.log(JSON.stringify(cRes.rows, null, 2));

  // Also check all 53 candidates: how many have isDirectRetailerSeller = true?
  const statsRes = await client.query(`
    SELECT
      count(*) as total,
      count(*) FILTER (WHERE "isDirectRetailerSeller" = true) as direct_count,
      count(*) FILTER (WHERE "isMarketplace" = true) as marketplace_count
    FROM "Candidate"
    WHERE "purchaseId" = 'pur_1794149129429_osas38ir'
  `);
  console.log('\nSeller Flags Stats:');
  console.log(statsRes.rows[0]);

  await client.end();
}

run().catch(console.error);

