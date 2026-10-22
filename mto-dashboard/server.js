// Serves the dashboard + /api/mto. Live BigQuery (cached) with data/snapshot.json fallback.
const express = require('express');
const fs = require('fs');
const path = require('path');
const basicAuth = require('express-basic-auth');
const { build } = require('./scripts/snapshot');

const PORT = process.env.PORT || 4100;
const TTL_MS = 15 * 60 * 1000;
const SNAP = path.join(__dirname, 'data', 'snapshot.json');
let cache = null, inflight = null;

const readSnap = () => (fs.existsSync(SNAP) ? JSON.parse(fs.readFileSync(SNAP, 'utf8')) : null);

async function load(force) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!inflight) {
    inflight = build()
      .then(data => { cache = { at: Date.now(), data: { ...data, source: 'live' } }; return cache.data; })
      .catch(err => {
        console.error('BigQuery refresh failed:', err.message);
        const snap = readSnap();
        if (!snap) throw err;
        cache = { at: Date.now() - TTL_MS + 60 * 1000, data: { ...snap, source: 'snapshot' } }; // retry in 1 min
        return cache.data;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

const app = express();
// Same login model as the other Lucira dashboards. On Cloud Run (K_SERVICE set) refuse to run unprotected: this page holds customer names.
const { DASHBOARD_USERNAME: USER, DASHBOARD_PASSWORD: PASS } = process.env;
if (USER && PASS) app.use(basicAuth({ users: { [USER]: PASS }, challenge: true, realm: 'Lucira MTO Journey' }));
else if (process.env.K_SERVICE) { console.error('DASHBOARD_USERNAME / DASHBOARD_PASSWORD not set; refusing to start without a login.'); process.exit(1); }
else console.warn('No login configured (local use only).');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/mto', async (req, res) => {
  try { res.json(await load(req.query.refresh === '1')); }
  catch (e) { res.status(502).json({ error: 'Data unavailable' }); }
});
app.listen(PORT, () => console.log(`MTO control tower on http://localhost:${PORT}`));
