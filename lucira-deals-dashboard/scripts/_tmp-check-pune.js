const { BigQuery } = require('@google-cloud/bigquery');
const bq = new BigQuery({ projectId: 'lucirajewelry-prod' });

async function main() {
  const [rows] = await bq.query({
    query: `
      SELECT a.scheme_enrollment_id, a.scheme_unique_code, a.company_id, c.company_name, c.company_code,
        p.party_name, a.creation_date, a.is_cancelled, a.scheme_status
      FROM \`lucirajewelry-prod.Pos.scheme_enrollment\` a
      LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.company\` c ON a.company_id = c.company_id
      LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.party\` p ON a.party_id = p.party_id
      WHERE a.company_id = 4
      ORDER BY a.scheme_unique_code
    `
  });
  console.log('total company_id=4 rows:', rows.length);
  rows.forEach(r => console.log(JSON.stringify(r)));

  // Group by the prefix of scheme_unique_code to spot naming-convention splits
  const prefixCounts = {};
  rows.forEach(r => {
    const prefix = (r.scheme_unique_code || '').split('-')[0];
    prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
  });
  console.log('--- prefix breakdown ---');
  console.log(JSON.stringify(prefixCounts, null, 2));
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
