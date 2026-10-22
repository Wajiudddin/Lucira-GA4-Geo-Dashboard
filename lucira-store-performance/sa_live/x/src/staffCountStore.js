// Manual, user-entered staff counts per store — there is no HR/staffing
// source table anywhere in the project (verified earlier), so this is a
// tiny BigQuery table the user fills in themselves via the dashboard's own
// input field. Deliberately NOT a local file: Cloud Run's local filesystem
// is wiped on every redeploy (and this app gets redeployed often), so a
// local JSON store would silently lose whatever staff counts were entered
// the next time anything else here gets shipped. BigQuery is the one
// storage layer in this project that's actually durable across deploys.
require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

const DATASET = 'store_performance_app_data';
const TABLE = 'store_staff_counts';
const FULL_TABLE = `\`lucirajewelry-prod.${DATASET}.${TABLE}\``;

let ensuredTable = null;
async function ensureTable() {
  if (ensuredTable) return ensuredTable;
  ensuredTable = (async () => {
    const dataset = bigquery.dataset(DATASET);
    const [datasetExists] = await dataset.exists();
    if (!datasetExists) await bigquery.createDataset(DATASET, { location: 'asia-south1' });
    const table = dataset.table(TABLE);
    const [tableExists] = await table.exists();
    if (!tableExists) {
      await dataset.createTable(TABLE, {
        schema: [
          { name: 'store_key', type: 'STRING', mode: 'REQUIRED' },
          { name: 'count', type: 'INT64', mode: 'REQUIRED' },
          { name: 'updated_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
        ],
      });
    }
  })();
  return ensuredTable;
}

// Returns { [storeKey]: { count, updatedAt } } for every store that has ever
// had a count entered — a store never entered simply has no key here.
async function readAll() {
  await ensureTable();
  const [rows] = await bigquery.query({
    query: `
      SELECT store_key, count, updated_at
      FROM ${FULL_TABLE}
      QUALIFY ROW_NUMBER() OVER (PARTITION BY store_key ORDER BY updated_at DESC) = 1
    `,
  });
  const out = {};
  for (const row of rows) {
    out[row.store_key] = { count: Number(row.count), updatedAt: row.updated_at && row.updated_at.value };
  }
  return out;
}

async function writeOne(storeKey, count) {
  await ensureTable();
  const updatedAt = new Date().toISOString();
  // A raw ISO string for a TIMESTAMP-typed named parameter arrives as null
  // server-side (verified — "Required field updated_at cannot be null") —
  // the client needs its own Timestamp wrapper for this type.
  await bigquery.query({
    query: `
      INSERT INTO ${FULL_TABLE} (store_key, count, updated_at)
      VALUES (@storeKey, @count, @updatedAt)
    `,
    params: { storeKey, count, updatedAt: BigQuery.timestamp(updatedAt) },
    types: { storeKey: 'STRING', count: 'INT64', updatedAt: 'TIMESTAMP' },
  });
  return { count, updatedAt };
}

module.exports = { readAll, writeOne };
