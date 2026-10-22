// Runs sql/mto_model.sql against BigQuery and writes data/snapshot.json (also used by server.js).
const fs = require('fs'), path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');
async function build() {
  const bq = new BigQuery({ projectId: 'lucirajewelry-prod', location: 'asia-south1' });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'mto_model.sql'), 'utf8');
  const [rows] = await bq.query({ query: sql });
  const out = { generatedAt: new Date().toISOString(), rows };
  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'snapshot.json'), JSON.stringify(out));
  return out;
}
module.exports = { build };
if (require.main === module) build().then(o => console.log('rows', o.rows.length)).catch(e => { console.error(e.message); process.exit(1); });
