const express = require("express");
const compression = require("compression");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(compression());
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.send("ok"));

// ---- Live store inventory (Store Comparison tab) ---------------------------
// Reads ds_imputed_reporting.Live_inventory straight from BigQuery using the
// Cloud Run service account, cached for a few minutes. If BigQuery can't be
// reached (local dev, permissions, outage) it serves the last good response, or
// the bundled snapshot, and says so in `source` so the page can show it.
const PROJECT = process.env.GCP_PROJECT || "lucirajewelry-prod";
const CACHE_MS = 10 * 60 * 1000;
const SNAPSHOT_FILE = path.join(__dirname, "public", "data", "store_inventory_snapshot.json");

// company_code is the store key in Live_inventory. HO (head office / warehouse)
// is deliberately not listed. "Repair" is not sellable store stock.
const STORE_INVENTORY_SQL = `
SELECT company_code, location_name, Full_sku, sku, pieces, type_name, sub_category_1,
       karat_name, Shopify_price, Product_Title, item_name, item_size_name,
       metal_color_name, Is_Solitaire, collection_name, bestseller
FROM \`${PROJECT}.ds_imputed_reporting.Live_inventory\`
WHERE company_code IN ('BO1','FCS','LPN','N18','PN1','PV1')
  AND IFNULL(location_name, '') != 'Repair'
  AND IFNULL(pieces, 0) > 0`;

let tokenCache = { value: null, expiresAt: 0 };
async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.value;
  const r = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) }
  );
  if (!r.ok) throw new Error("metadata token " + r.status);
  const j = await r.json();
  tokenCache = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return tokenCache.value;
}

async function queryBigQuery(sql) {
  const token = await getAccessToken();
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}`;
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  let r = await fetch(`${base}/queries`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: sql, useLegacySql: false, maxResults: 50000, timeoutMs: 30000 }),
    signal: AbortSignal.timeout(45000),
  });
  let j = await r.json();
  if (!r.ok) throw new Error("bigquery " + r.status + " " + JSON.stringify(j.error || j).slice(0, 300));
  if (!j.jobComplete) throw new Error("bigquery job not complete");
  const cols = j.schema.fields.map(f => f.name);
  const rows = [];
  const pushRows = page => (page.rows || []).forEach(x => rows.push(x.f.map(c => c.v)));
  pushRows(j);
  const loc = j.jobReference.location;
  while (j.pageToken) {
    r = await fetch(
      `${base}/queries/${j.jobReference.jobId}?location=${loc}&maxResults=50000&pageToken=${encodeURIComponent(j.pageToken)}`,
      { headers, signal: AbortSignal.timeout(45000) }
    );
    j = await r.json();
    if (!r.ok) throw new Error("bigquery page " + r.status);
    pushRows(j);
  }
  return { cols, rows };
}

let liveCache = null;     // { at, payload }
let inflight = null;

async function loadLive() {
  const { cols, rows } = await queryBigQuery(STORE_INVENTORY_SQL);
  return { asOf: new Date().toISOString(), source: "live", cols, rows };
}

app.get("/api/store-inventory", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    // ?refresh=1 skips the cache, but at most once every 30s so it can't hammer BigQuery.
    const forced = req.query.refresh === "1" && liveCache && Date.now() - liveCache.at > 30000;
    if (!liveCache || forced || Date.now() - liveCache.at > CACHE_MS) {
      if (!inflight) inflight = loadLive().finally(() => { inflight = null; });
      liveCache = { at: Date.now(), payload: await inflight };
    }
    return res.json(liveCache.payload);
  } catch (err) {
    console.error("store-inventory live load failed:", err.message);
    if (liveCache) return res.json({ ...liveCache.payload, source: "stale-cache" });
    try {
      const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
      return res.json({ ...snap, source: "snapshot" });
    } catch (e2) {
      return res.status(503).json({ error: "store inventory unavailable" });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Karat Allocator listening on port ${PORT}`);
});
