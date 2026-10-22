require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');

// Same auth pattern as the other BigQuery-backed services in this repo.
const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

// --- Matching / classification configuration --------------------------------
// A scanned product (linked via Live_inventory) is matched to a sold product
// (marketing_sale) on this single field. Change this constant — nothing else —
// if the SKU convention between the two tables ever changes.
const SALE_MATCH_FIELD = 'fullSku';

// item_id is confirmed 1:1 with Live_inventory.item_code / Full_sku (checked
// directly against BigQuery: 2603 distinct item_id vs 2603 distinct item_code
// vs 2604 distinct Full_sku, no item_id maps to more than one of either) — so
// no separate variant-collapsing step is needed before using it as the SKU key.

// ornaverse_erp_master.company (confirmed by querying the table directly) —
// same store set used by refillService.js / oldGoldService.js / scanService.js,
// keyed here by company_id since that's the only store link
// estimation_item_scan / Live_inventory carry.
const COMPANY_ID_TO_CODE = {
  1: 'HO',
  2: 'CS1',
  4: 'PN1',
  5: 'BO1',
  6: 'N18',
  7: 'FCS',
  8: 'PV1',
  9: 'LPN',
};

// FCS is HWI Ventures' ERP code, displayed as "HWI" everywhere else in this
// repo (see refillService.js DISPLAY_STORE_CODE) — Walkin_marge already uses
// the literal string "HWI" for some rows and "FCS" for others (confirmed by
// querying store_code directly), so both must fold to the same canonical
// value or the same physical store would appear twice in every filter/table.
function canonicalStore(rawCode) {
  if (!rawCode) return 'Unknown';
  return rawCode === 'FCS' ? 'HWI' : rawCode;
}

// Same bucket boundaries as marketing_sale.Price_Range (confirmed by querying
// DISTINCT Price_Range directly) — reused rather than the 0-5K/5K-10K bands a
// generic spec might suggest, per "use the existing definition if one exists".
const PRICE_BANDS = [
  { label: '0 - 10K', max: 10000 },
  { label: '10K - 20K', max: 20000 },
  { label: '20K - 30K', max: 30000 },
  { label: '30K - 40K', max: 40000 },
  { label: '40K - 50K', max: 50000 },
  { label: '50K - 75K', max: 75000 },
  { label: '75K - 100K', max: 100000 },
  { label: '100K - 150K', max: 150000 },
  { label: '150K - 200K', max: 200000 },
  { label: '200K+', max: Infinity },
];
const PRICE_BAND_ORDER = [...PRICE_BANDS.map(b => b.label), 'Unknown'];
function priceBandOf(price) {
  if (price == null || Number.isNaN(price)) return 'Unknown';
  const band = PRICE_BANDS.find(b => price < b.max);
  return band ? band.label : '200K+';
}

// Ageing bands for unscanned inventory, as specified.
const AGE_BANDS = [
  { label: '0-30 Days', max: 30 },
  { label: '31-60 Days', max: 60 },
  { label: '61-90 Days', max: 90 },
  { label: '91-180 Days', max: 180 },
  { label: '181-365 Days', max: 365 },
  { label: '365+ Days', max: Infinity },
];
const AGE_BAND_ORDER = AGE_BANDS.map(b => b.label);
function ageBandOf(days) {
  if (days == null || Number.isNaN(days)) return 'Unknown';
  const band = AGE_BANDS.find(b => days <= b.max);
  return band ? band.label : '365+ Days';
}

function bqVal(v) {
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}
function toNumber(v) {
  const n = Number(bqVal(v));
  return Number.isFinite(n) ? n : null;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}
function daysBetween(fromDateStr, toDateStr) {
  const from = new Date(fromDateStr + 'T00:00:00Z').getTime();
  const to = new Date(toDateStr + 'T00:00:00Z').getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

// --- BigQuery fetches ---------------------------------------------------------

// Walkin_marge: one row per store visit (event_name is always 'StoreVisit',
// confirmed by querying DISTINCT directly). walkin_date is a plain
// "YYYY-MM-DD HH:MM:SS" string carrying real second-level timestamps — checked
// directly, every row is already a distinct phone+date+store combination
// (2952 rows == 2952 distinct combos), so repeat rows for the same phone are
// genuine repeat visits, not import duplicates. store_code also includes
// "Amazon" for some rows (an online channel logged through the same event),
// kept as its own filterable value rather than silently dropped.
async function fetchWalkins() {
  const [rows] = await bigquery.query({
    query: `
      SELECT store_code, phone, walkin_date
      FROM \`lucirajewelry-prod.ds_imputed_reporting.Walkin_marge\`
      WHERE walkin_date IS NOT NULL
    `,
  });
  return rows.map(r => ({
    store: canonicalStore(r.store_code),
    phone: r.phone || null,
    date: String(r.walkin_date).slice(0, 10),
  }));
}

// One row per scan event. item_id is the only link to the product catalog
// (Live_inventory); company_id is the only link to a store. The scan table's
// own "sku" column is NOT a product SKU — checked directly against Full_sku /
// item_code, it holds inconsistent-case ids in a completely different format
// (e.g. "Lj11254968" vs a Full_sku of "LJ-E00342-14YGLGD") — so item_id via
// Live_inventory is the only reliable product link, as specified.
async function fetchScanEvents() {
  const [rows] = await bigquery.query({
    query: `
      SELECT item_id, date, company_id
      FROM \`lucirajewelry-prod.Pos.estimation_item_scan\`
      WHERE item_id IS NOT NULL
    `,
  });
  return rows.map(r => ({
    itemId: r.item_id,
    date: bqVal(r.date) ? new Date(bqVal(r.date)).toISOString().slice(0, 10) : null,
    store: canonicalStore(COMPANY_ID_TO_CODE[r.company_id]),
  }));
}

// Live_inventory is a per-unit stock ledger (many physical-unit rows can share
// one item_id), grouped down to one row per item_id here — the product/SKU
// master used for "Not Scanned" and every Price Band / Category breakdown.
// ANY_VALUE is safe for descriptive columns (identical for every unit of a
// given item_id, confirmed directly); MIN(document_date) is the oldest unit on
// record for that item, used as its inward/ageing date — the only date field
// on this table that represents "when this item entered stock".
async function fetchItemMaster() {
  const [rows] = await bigquery.query({
    query: `
      SELECT
        item_id,
        ANY_VALUE(item_code) AS item_code,
        ANY_VALUE(Full_sku) AS full_sku,
        ANY_VALUE(item_name) AS item_name,
        ANY_VALUE(item_group_name) AS category,
        ANY_VALUE(sub_category_1) AS sub_category,
        ANY_VALUE(metal_name) AS metal,
        ANY_VALUE(item_size_name) AS size,
        ANY_VALUE(company_id) AS company_id,
        ANY_VALUE(item_rate) AS item_rate,
        MIN(document_date) AS first_seen_date,
        SUM(pieces) AS pieces_on_hand
      FROM \`lucirajewelry-prod.ds_imputed_reporting.Live_inventory\`
      WHERE item_id IS NOT NULL
      GROUP BY item_id
    `,
  });
  return rows.map(r => {
    const price = toNumber(r.item_rate);
    const piecesOnHand = toNumber(r.pieces_on_hand) || 0;
    return {
      itemId: r.item_id,
      itemCode: r.item_code || null,
      fullSku: r.full_sku || null,
      itemName: r.item_name || null,
      category: r.category || 'Unknown',
      subCategory: r.sub_category || null,
      metal: r.metal || 'Unknown',
      size: r.size || 'Unknown',
      store: canonicalStore(COMPANY_ID_TO_CODE[r.company_id]),
      price,
      priceBand: priceBandOf(price),
      piecesOnHand,
      inventoryValue: price != null ? round2(price * piecesOnHand) : 0,
      firstSeenDate: bqVal(r.first_seen_date) || null,
    };
  });
}

// One row per sale line. marketing_sale already carries its own item_group_name
// / metal_name / Price_Range, used as a fallback when a sold Full_sku has no
// current Live_inventory match (sold out / discontinued item) so it still
// counts toward Category / Price Band performance rather than disappearing.
async function fetchSales() {
  const [rows] = await bigquery.query({
    query: `
      SELECT
        company_code, document_no, Full_sku, Transaction_Date, net_sale, pieces,
        item_group_name, metal_name, Price_Range
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      WHERE Full_sku IS NOT NULL
    `,
  });
  return rows.map(r => ({
    store: canonicalStore(r.company_code),
    documentNo: r.document_no || null,
    fullSku: r.Full_sku,
    date: bqVal(r.Transaction_Date) || null,
    netSale: toNumber(r.net_sale) || 0,
    qty: toNumber(r.pieces) || 0,
    fallbackCategory: r.item_group_name || 'Unknown',
    fallbackMetal: r.metal_name || 'Unknown',
    fallbackPriceBand: r.Price_Range || 'Unknown',
  }));
}

// --- Assembly -----------------------------------------------------------------

function distinctSorted(values) {
  return [...new Set(values.filter(v => v != null && v !== ''))].sort();
}

async function buildProductScanConversionDashboard() {
  const today = todayISODate();

  const [walkins, scanEventsRaw, itemMaster, salesRaw] = await Promise.all([
    fetchWalkins(),
    fetchScanEvents(),
    fetchItemMaster(),
    fetchSales(),
  ]);

  const itemById = new Map(itemMaster.map(i => [i.itemId, i]));
  const itemByFullSku = new Map(itemMaster.filter(i => i.fullSku).map(i => [i.fullSku, i]));

  // Products = the Live_inventory master, one row per SKU/variant, with ageing.
  const products = itemMaster.map(i => ({
    itemId: i.itemId,
    itemCode: i.itemCode,
    fullSku: i.fullSku,
    itemName: i.itemName,
    category: i.category,
    subCategory: i.subCategory,
    metal: i.metal,
    size: i.size,
    store: i.store,
    price: i.price,
    priceBand: i.priceBand,
    piecesOnHand: i.piecesOnHand,
    inventoryValue: i.inventoryValue,
    firstSeenDate: i.firstSeenDate,
    ageDays: i.firstSeenDate ? daysBetween(i.firstSeenDate, today) : null,
    ageBand: i.firstSeenDate ? ageBandOf(daysBetween(i.firstSeenDate, today)) : 'Unknown',
  }));

  // Scan events enriched with product attributes at the time of loading —
  // matchedInInventory=false marks a scanned item_id with no current
  // Live_inventory row (sold out / discontinued); it still counts as a scan
  // event but can't be checked against a sale (no SKU to match on) and is
  // excluded once any SKU-attribute filter (category/price band/metal/size)
  // is active, since it can't be confirmed to belong to that bucket.
  const scanEvents = scanEventsRaw.map(s => {
    const item = itemById.get(s.itemId);
    return {
      date: s.date,
      store: s.store,
      itemId: s.itemId,
      itemCode: item ? item.itemCode : null,
      fullSku: item ? item.fullSku : null,
      itemName: item ? item.itemName : null,
      category: item ? item.category : null,
      subCategory: item ? item.subCategory : null,
      metal: item ? item.metal : null,
      size: item ? item.size : null,
      price: item ? item.price : null,
      priceBand: item ? item.priceBand : null,
      matchedInInventory: !!item,
    };
  });

  // Sales enriched the same way — [SALE_MATCH_FIELD] is the join key used
  // everywhere a scanned product is checked against sales.
  const sales = salesRaw.map(s => {
    const item = itemByFullSku.get(s.fullSku);
    return {
      date: s.date,
      store: s.store,
      documentNo: s.documentNo,
      fullSku: s.fullSku,
      netSale: s.netSale,
      qty: s.qty,
      itemId: item ? item.itemId : null,
      itemCode: item ? item.itemCode : null,
      itemName: item ? item.itemName : null,
      category: item ? item.category : s.fallbackCategory,
      subCategory: item ? item.subCategory : null,
      metal: item ? item.metal : s.fallbackMetal,
      size: item ? item.size : 'Unknown',
      priceBand: item ? item.priceBand : s.fallbackPriceBand,
      matchedInInventory: !!item,
    };
  });

  const filterOptions = {
    stores: distinctSorted([
      ...walkins.map(w => w.store),
      ...scanEvents.map(s => s.store),
      ...sales.map(s => s.store),
      ...products.map(p => p.store),
    ]),
    categories: distinctSorted([...products.map(p => p.category), ...sales.map(s => s.category)]),
    priceBands: PRICE_BAND_ORDER.filter(b =>
      products.some(p => p.priceBand === b) || sales.some(s => s.priceBand === b)
    ),
    metals: distinctSorted([...products.map(p => p.metal), ...sales.map(s => s.metal)]),
    sizes: distinctSorted(products.map(p => p.size)),
    dateMin: [...walkins.map(w => w.date), ...scanEvents.map(s => s.date), ...sales.map(s => s.date)]
      .filter(Boolean).sort()[0] || null,
    dateMax: today,
  };

  return {
    generatedAt: new Date().toISOString(),
    today,
    matchField: SALE_MATCH_FIELD,
    priceBandOrder: PRICE_BAND_ORDER,
    ageBandOrder: AGE_BAND_ORDER,
    filterOptions,
    walkins,
    scanEvents,
    sales,
    products,
  };
}

module.exports = { buildProductScanConversionDashboard };
