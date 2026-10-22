const { buildRefillDashboard } = require('../src/refillService');

(async () => {
  const start = Date.now();
  const data = await buildRefillDashboard();
  console.log(`Built in ${Date.now() - start}ms`);
  console.log(`Total refill rows: ${data.rows.length}`);
  console.log(`Data quality notes:`, data.dataQualityNotes);
  console.log(`T-1:`, {
    newlyFlagged: data.t1.newlyFlagged.length,
    stillPending: data.t1.stillPending.length,
    noLongerRequired: data.t1.noLongerRequired.length,
    previousRunMissing: data.t1.previousRunMissing,
  });
  console.log(`PDP trend points: ${data.pdpTrend.length}`);

  console.log('\n-- rows with a red-flagged peer (transfer logic) --');
  console.log(JSON.stringify(data.rows.filter(r => r.peerHasRedFlag).slice(0, 5), null, 2));

  console.log('\n-- rows with a valid PO --');
  console.log(JSON.stringify(data.rows.filter(r => r.poStatus === 'VALID').slice(0, 5), null, 2));

  console.log('\n-- rows with network availability --');
  console.log(JSON.stringify(data.rows.filter(r => r.availableAtNetwork).slice(0, 5), null, 2));

  console.log('\n-- KPI sanity --');
  console.log({
    totalRefillSkus: data.rows.length,
    totalRefillQty: data.rows.reduce((s, r) => s + r.reorderQty, 0),
    hoAvailable: data.rows.filter(r => r.hoOnHand > 0).length,
    hoNotAvailable: data.rows.filter(r => r.hoOnHand === 0).length,
    validPo: data.rows.filter(r => r.poStatus === 'VALID').length,
    noValidPo: data.rows.filter(r => r.poStatus === 'NO VALID PO').length,
    oldPeerStock180: data.rows.filter(r => r.peerHasRedFlag).length,
    transferCandidates: data.rows.filter(r => r.transferStatus === 'TRANSFER CANDIDATE').length,
    totalPdpViews: data.rows.reduce((s, r) => s + (r.pdpViews || 0), 0),
  });
})().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
