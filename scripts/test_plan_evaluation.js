const { getPurchaseWorkflowService } = require('./lib/workflow/service');

async function testPlan() {
  const service = getPurchaseWorkflowService();
  const purchaseId = 'pur_1794149129429_osas38ir';
  const actor = { kind: 'user', userId: 'usr_buyer_1' };

  const res = await service.createMultiItemPlan(
    purchaseId,
    {
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
    },
    actor
  );

  console.log('=== MULTI-ITEM PLAN RESULT ===');
  console.log('Strategies count:', res.strategies.length);
  res.strategies.forEach((s, idx) => {
    console.log(`\n--- Strategy [${idx + 1}]: ${s.strategyId} (${s.strategyType}) ---`);
    console.log('  Feasible:', s.isFeasible);
    console.log('  Items in strategy:', s.allocations.map(a => `${a.lineItemId} -> cand: ${a.candidateId} (${a.merchantName})`));
    console.log('  Pre-Tax Subtotal:', s.financialSummary.preTaxLandedSubtotalCents, 'cents');
    console.log('  Estimated Tax:', s.financialSummary.estimatedTaxCents, 'cents');
    console.log('  Estimated Landed Total:', s.financialSummary.estimatedLandedTotalCents, 'cents');
    console.log('  Within Budget:', s.financialSummary.withinBudget);
    console.log('  Blockers:', s.blockers);
    console.log('  Shipments count:', s.shipments.length);
    s.shipments.forEach(sh => {
      console.log(`    Shipment: merchant=${sh.merchantName}, carrier=${sh.carrier}, shippingCents=${sh.shippingCents}, items=[${sh.lineItemIds.join(', ')}]`);
    });
  });
}

testPlan().catch(console.error);

