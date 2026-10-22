require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');

// Same auth pattern as the other BigQuery-backed services in this repo.
const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

const WINDOW_FROM = '2025-10-01'; // same reporting window as the sales data

// Daily ad spend by platform, aggregated in BigQuery (the Google/Meta table is city-level and ~2M rows, so it is never shipped raw).
//  - ds_imputed_reporting.ads_spend_live_city_daily : Google + Meta (platform, lob = online / offline)
//  - criteo.advertiser_119792_report                : Criteo (all online; columns are STRING, cost in INR)
// Revenue is NOT taken from the ad platforms (their conversion_value is not reliable); the dashboard uses real net sales instead.
async function buildAdSpend() {
  const [rows] = await bigquery.query({
    query: `
      SELECT CAST(date AS STRING) AS d, platform AS p, IFNULL(lob, 'unknown') AS l,
             SUM(spend) AS sp, SUM(impressions) AS im, SUM(clicks) AS cl
      FROM \`lucirajewelry-prod.ds_imputed_reporting.ads_spend_live_city_daily\`
      WHERE date >= DATE '${WINDOW_FROM}'
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT Day AS d, 'criteo' AS p, 'online' AS l,
             SUM(SAFE_CAST(AdvertiserCost AS FLOAT64)) AS sp,
             SUM(SAFE_CAST(Displays AS FLOAT64)) AS im,
             SUM(SAFE_CAST(Clicks AS FLOAT64)) AS cl
      FROM \`lucirajewelry-prod.criteo.advertiser_119792_report\`
      WHERE SAFE_CAST(Day AS DATE) >= DATE '${WINDOW_FROM}'
      GROUP BY 1`,
  });
  const out = rows.map(r => ({
    d: String(r.d && r.d.value ? r.d.value : r.d),
    p: String(r.p).toLowerCase(),
    l: String(r.l).toLowerCase(),
    sp: Number(r.sp) || 0,
    im: Number(r.im) || 0,
    cl: Number(r.cl) || 0,
  })).filter(r => r.sp || r.im || r.cl);
  return { generatedAt: new Date().toISOString(), rows: out };
}

module.exports = { buildAdSpend };
