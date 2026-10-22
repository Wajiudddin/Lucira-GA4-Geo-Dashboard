const express = require('express');
const basicAuth = require('express-basic-auth');
const path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');
const { mainSql, optionsSql } = require('./sql-builder');

const app = express();
const PORT = process.env.PORT || 8080;
const bq = new BigQuery({ projectId: 'lucirajewelry-prod' });

if (process.env.DASHBOARD_USERNAME && process.env.DASHBOARD_PASSWORD) {
  app.use(basicAuth({
    users: { [process.env.DASHBOARD_USERNAME]: process.env.DASHBOARD_PASSWORD },
    challenge: true, realm: 'Lucira City Funnel',
  }));
} else {
  console.error('DASHBOARD_USERNAME / DASHBOARD_PASSWORD missing - refusing to start unprotected.');
  process.exit(1);
}

app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const strArr = v => Array.isArray(v) && v.length <= 100 && v.every(s => typeof s === 'string' && s.length <= 120);
function cleanFilters(b = {}) {
  if (!DATE.test(b.from) || !DATE.test(b.to) || b.from > b.to) throw new Error('Invalid date range');
  if (Date.parse(b.to) - Date.parse(b.from) > 3650 * 864e5) throw new Error('Date range too long (max 10 years)');
  const f = { from: b.from, to: b.to, status: ['active', 'all', 'cancelled'].includes(b.status) ? b.status : 'active' };
  for (const k of ['cities', 'stores', 'sources', 'fulfillment', 'category', 'karat', 'metal', 'custype']) {
    if (b[k] !== undefined && !strArr(b[k])) throw new Error('Invalid filter: ' + k);
    f[k] = b[k] || [];
  }
  return f;
}

const cache = new Map();
const TTL = 5 * 60 * 1000;
async function run(key, sql) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.rows;
  const [rows] = await bq.query({ query: sql, location: 'asia-south1', maximumBytesBilled: String(50e9) });
  cache.set(key, { t: Date.now(), rows });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return rows;
}
const wrap = fn => async (req, res) => {
  try { res.json({ rows: await fn(req) }); }
  catch (e) { console.error(e); res.status(e.message && /^Invalid|too long/.test(e.message) ? 400 : 500).json({ error: e.message }); }
};

app.post('/api/main', wrap(req => { const f = cleanFilters(req.body); return run('m:' + JSON.stringify(f), mainSql(f)); }));
app.get('/api/options', wrap(() => run('options', optionsSql())));
app.get('/healthz', (_, res) => res.send('ok'));
app.listen(PORT, () => console.log('lucira-city-funnel on ' + PORT));
