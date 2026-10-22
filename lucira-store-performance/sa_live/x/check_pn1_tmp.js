require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');
const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({ projectId: 'lucirajewelry-prod', credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

async function q(label, query) {
  console.log('\n=== ' + label + ' ===');
  const [rows] = await bigquery.query({ query });
  rows.forEach(r => console.log(JSON.stringify(r)));
}

async function main() {
  await q('scan date range + count per company_id', `
    SELECT company_id, COUNT(*) c, MIN(date) min_d, MAX(date) max_d, COUNT(DISTINCT DATE(date)) distinct_days
    FROM \`lucirajewelry-prod.Pos.estimation_item_scan\`
    GROUP BY company_id ORDER BY c DESC
  `);

  await q('PN1 (company_id=4) scans per day, top 15 busiest days', `
    SELECT DATE(date) AS d, COUNT(*) c
    FROM \`lucirajewelry-prod.Pos.estimation_item_scan\`
    WHERE company_id = 4
    GROUP BY d ORDER BY c DESC LIMIT 15
  `);

  await q('PN1 scans per user_id (is it one device/user doing bulk scans?)', `
    SELECT user_id, COUNT(*) c, COUNT(DISTINCT item_id) distinct_items, COUNT(DISTINCT DATE(date)) distinct_days
    FROM \`lucirajewelry-prod.Pos.estimation_item_scan\`
    WHERE company_id = 4
    GROUP BY user_id ORDER BY c DESC
  `);

  await q('PN1 scans: same item_id scanned repeatedly same day (top repeat offenders)', `
    SELECT item_id, DATE(date) AS d, COUNT(*) c
    FROM \`lucirajewelry-prod.Pos.estimation_item_scan\`
    WHERE company_id = 4
    GROUP BY item_id, d
    HAVING COUNT(*) > 5
    ORDER BY c DESC LIMIT 15
  `);

  await q('all stores: user_id count (is scanning app rolled out to fewer users elsewhere)', `
    SELECT company_id, COUNT(DISTINCT user_id) distinct_users
    FROM \`lucirajewelry-prod.Pos.estimation_item_scan\`
    GROUP BY company_id ORDER BY company_id
  `);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
