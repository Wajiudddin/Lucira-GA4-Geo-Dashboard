const { BigQuery } = require('@google-cloud/bigquery');
const bq = new BigQuery({ projectId: 'lucirajewelry-prod' });
(async () => {
  const [all] = await bq.query({
    query: `
      SELECT document_no, document_status
      FROM \`lucirajewelry-prod.Lucira_Prod.exchange\`
      WHERE REGEXP_CONTAINS(document_no, r'-EXC-')
      ORDER BY document_no
    `,
  });
  console.log('Total EXC document_no rows (no status filter):', all.length);
  console.log('Distinct document_no count:', new Set(all.map(r => r.document_no)).size);

  const byStatus = {};
  all.forEach(r => { byStatus[r.document_status] = (byStatus[r.document_status] || 0) + 1; });
  console.log('By document_status:', JSON.stringify(byStatus));

  const cancelled = all.filter(r => r.document_status === 2);
  console.log('Cancelled (status=2) EXC docs:', JSON.stringify(cancelled));

  const kept = all.filter(r => r.document_status !== 2);
  console.log('Kept after excluding status=2:', kept.length, 'distinct:', new Set(kept.map(r => r.document_no)).size);
})().catch(e => console.error('ERR', e.message));
