const http = require('http');

const payload = JSON.stringify({
  lineItems: [
    {
      id: 'li_1_laptopfors',
      title: 'laptop for software development',
      quantity: 1,
      quantitySource: 'explicit',
      quantityConfirmed: true,
      budgetCents: 100000,
      currency: 'USD',
      requirements: [{ key: 'purpose', expectedValue: 'software development' }],
      verificationLevel: 'standard'
    },
    {
      id: 'li_2_monitor',
      title: 'monitor',
      quantity: 1,
      quantitySource: 'explicit',
      quantityConfirmed: true,
      budgetCents: 50000,
      currency: 'USD',
      requirements: [],
      verificationLevel: 'standard'
    }
  ],
  destination: {
    country: 'US',
    postalCode: '98101',
    deliveryMethodPreference: 'standard_ground'
  }
});

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/purchases/pur_1794149129429_osas38ir/multi-item/plan',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-actor-id': 'usr_buyer_1',
    'x-actor-kind': 'user',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('HTTP Status:', res.statusCode);
    const parsed = JSON.parse(body);
    console.log('Purchase ID:', parsed.purchaseId);
    console.log('Strategies returned:', parsed.strategies ? parsed.strategies.length : 0);
    if (parsed.strategies) {
      parsed.strategies.forEach(s => {
        console.log(`- Strategy [${s.strategyId}]: ${s.name} | Feasibility: ${s.feasibility} | Items: ${s.allocations.length} | Landed: $${((s.totalLandedCostCents || 0)/100).toFixed(2)} | Disclosures: ${s.riskDisclosures.length}`);
        s.allocations.forEach(a => {
          console.log(`    * ${a.lineItemId}: "${a.title}" from ${a.merchantName} ($${(a.unitPriceCents/100).toFixed(2)})`);
        });
      });
    }
  });
});
req.on('error', console.error);
req.write(payload);
req.end();

