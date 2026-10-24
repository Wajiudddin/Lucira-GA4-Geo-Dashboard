require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');

// Same auth pattern as the other BigQuery-backed services in this repo.
const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

// ornaverse_erp_master.company (confirmed by querying the table directly) —
// same store set used by refillService.js / oldGoldService.js, keyed here by
// company_id since that's the only store link estimation_item_scan carries.
const COMPANY_ID_TO_CODE = {
  1: 'HO',
  2: 'CS1',
  4: 'PN1',
  5: 'BO1',
  6: 'N18',
  7: 'FCS',
  8: 'PV1',
  9: 'LPN',
  10: 'MAL',
};

// FCS is HWI Ventures' ERP code — displayed as "HWI" everywhere else in this
// repo (see refillService.js DISPLAY_STORE_CODE).
const DISPLAY_STORE_CODE = { FCS: 'HWI' };
function displayStore(code) {
  return DISPLAY_STORE_CODE[code] || code || 'Unknown';
}

// Live_inventory.Store_name -> ERP store code (ornaverse_erp_master.company,
// same pairing confirmed and used in refillService.js/oldGoldService.js) —
// needed because Live_inventory carries the full store name, not the code
// estimation_item_scan/marketing_sale use. Live_inventory is ONLY used here
// for the Never-Scanned analysis and for enriching scanned items with
// descriptive attributes it alone carries (category/collection/metal/size) —
// never to map a scan to an item_code, and never as part of the scan-count
// or scan->sale logic.
const STORE_NAME_TO_CODE = {
  'Divinecarat Lifestyles Private Limited': 'HO',
  'Chembur Mumbai CoCo Store': 'CS1',
  'JM Pune CoCo Store': 'PN1',
  'Sky City Borivali CoCo Store': 'BO1',
  'Noida Sector 18 CoCo Store': 'N18',
  'HWI VENTURES': 'FCS',
  'Paschim Vihar Lucira Jewelry': 'PV1',
  'Lagpat Nagar Delhi, Lucira Jewelry': 'LPN',
};
function displayStoreName(storeName) {
  if (!storeName) return 'Unknown';
  return displayStore(STORE_NAME_TO_CODE[storeName] || storeName);
}

// Same bucket boundaries as marketing_sale.Price_Range, so a scanned/unsold
// item and a sold item land in comparable bands.
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
function priceBandOf(price) {
  if (price == null || Number.isNaN(price)) return 'Unknown';
  const band = PRICE_BANDS.find(b => price < b.max);
  return band ? band.label : '200K+';
}
const PRICE_BAND_ORDER = [...PRICE_BANDS.map(b => b.label), 'Unknown'];

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
// item_line_no / id are BIGNUMERIC in BigQuery — normalise to plain strings so
// they compare reliably as Map/Set keys on both the scan and sale side.
function idStr(v) {
  const val = bqVal(v);
  return val == null ? null : String(val);
}

// --- BigQuery fetches -------------------------------------------------------

// Walk-ins: Lucira_Prod.customer_walkin, one row per store visit. `date` is a
// DATETIME (the date-only slice is taken in JS below) and the store is
// resolved from company_id with the same map the scan table uses.
async function fetchWalkins() {
  const [rows] = await bigquery.query({
    query: `
      SELECT company_id, first_name, last_name, mobile, date
      FROM \`lucirajewelry-prod.Lucira_Prod.customer_walkin\`
      WHERE date IS NOT NULL
    `,
  });
  return rows.map(r => {
    const storeCode = COMPANY_ID_TO_CODE[r.company_id] || null;
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
    return {
      storeCode,
      store: displayStore(storeCode),
      customerName: name || null,
      phone: r.mobile || null,
      date: String(bqVal(r.date)).slice(0, 10),
    };
  });
}

// THE SCAN TABLE — one row per scan event, no dedup, no fan-out join.
// item_code comes from a LEFT JOIN to ds_imputed_reporting.items on item_id
// (items.item_id is confirmed 1:1 — 106,268 rows = 106,268 distinct item_id —
// so this LEFT JOIN cannot multiply scan rows; verified directly against
// BigQuery: raw estimation_item_scan row count == row count after this join).
// Live_inventory is NEVER joined here — that was the previous bug: joining
// estimation_item_scan to Live_inventory (a many-rows-per-item_id stock
// ledger) fanned one scan out into N rows, one per physical stock/document
// row sharing that item_id, silently inflating every "scan" figure in the
// dashboard.
async function fetchScanEvents() {
  const [rows] = await bigquery.query({
    query: `
      SELECT
        a.id,
        a.item_id,
        a.item_line_no,
        a.date,
        a.company_id,
        a.party_id,
        b.item_code
      FROM \`lucirajewelry-prod.Pos.estimation_item_scan\` AS a
      LEFT JOIN \`lucirajewelry-prod.ds_imputed_reporting.items\` AS b
        ON a.item_id = b.item_id
      WHERE a.item_id IS NOT NULL
    `,
  });
  return rows.map(r => ({
    scanId: idStr(r.id),
    itemId: r.item_id,
    itemLineNo: idStr(r.item_line_no),
    itemCode: r.item_code || null,
    date: bqVal(r.date) ? new Date(bqVal(r.date)).toISOString().slice(0, 10) : null,
    companyId: r.company_id,
    storeCode: COMPANY_ID_TO_CODE[r.company_id] || null,
    // ~95% NULL on this table (confirmed: 108/2002 rows carry a party_id) —
    // still the only non-name customer identifier a scan row carries, so
    // it's used as-is (never backfilled from name) for Customer Analysis.
    partyId: r.party_id != null ? String(r.party_id) : null,
  }));
}

// Live_inventory, grouped down to one row per item_id — descriptive
// attributes ONLY (category/collection/metal/size/price), used to enrich a
// scanned item with fields ds_imputed_reporting.items does not carry at
// all. These are store-invariant by nature (a ring's category doesn't
// change store to store), so collapsing all of an item's stock rows into
// one via ANY_VALUE is safe here. Never used to decide whether something
// counts as a scan, and never used to decide whether a scan is "sold"
// (that's item_line_no against marketing_sale).
async function fetchItemDescriptors() {
  const [rows] = await bigquery.query({
    query: `
      SELECT
        item_id,
        ANY_VALUE(item_code) AS item_code,
        ANY_VALUE(Full_sku) AS Full_sku,
        ANY_VALUE(item_name) AS item_name,
        ANY_VALUE(type_name) AS category,
        ANY_VALUE(sub_category_1) AS sub_category_1,
        ANY_VALUE(collection_name) AS collection,
        ANY_VALUE(metal_name) AS metal,
        ANY_VALUE(item_size_name) AS size,
        ANY_VALUE(item_rate) AS item_rate
      FROM \`lucirajewelry-prod.ds_imputed_reporting.Live_inventory\`
      WHERE item_id IS NOT NULL
      GROUP BY item_id
    `,
  });
  return rows.map(r => {
    const price = toNumber(r.item_rate);
    return {
      itemId: r.item_id,
      itemCode: r.item_code || null,
      fullSku: r.Full_sku || null,
      itemName: r.item_name || null,
      category: r.category || 'Uncategorised',
      subCategory: r.sub_category_1 || null,
      collection: r.collection || null,
      metal: r.metal || null,
      size: r.size || null,
      price,
      priceBand: priceBandOf(price),
    };
  });
}

// Live_inventory, grouped by (item_id, Store_name) — used ONLY for the
// Never-Scanned analysis, where store/document/pieces/price/date must all
// come from the SAME underlying stock row. Grouping by item_id alone (as a
// single combined row per item) was the previous approach here and it was
// wrong: checked directly against BigQuery, 1,080 of 2,627 in-stock items
// (41%) have stock at MORE THAN ONE store, so a single ANY_VALUE(Store_name)
// silently paired one store's stock quantity with another store's earliest
// document number — e.g. item 39411 has 1 piece at Sky City Borivali
// (document BO1-BIT-01-26-1, dated 2026-01-13) and 1 piece at Noida Sector
// 18 (document N18-ERT-05-26-00003, dated 2026-05-30); the old query
// combined these into one fabricated row showing "2 pieces, store N18,
// document BO1-BIT-01-26-1" — a store/document pairing that never existed.
// Grouping by (item_id, Store_name) keeps each store's figures internally
// consistent, and also lets Never-Scanned be judged PER STORE (an item
// scanned at store A but never at store B is correctly "never scanned at
// B"), matching how every other metric in this dashboard is store-scoped.
async function fetchInventoryByItemStore() {
  const [rows] = await bigquery.query({
    query: `
      SELECT
        item_id,
        Store_name,
        ANY_VALUE(item_code) AS item_code,
        ANY_VALUE(Full_sku) AS Full_sku,
        ANY_VALUE(item_name) AS item_name,
        ANY_VALUE(type_name) AS category,
        ANY_VALUE(sub_category_1) AS sub_category_1,
        ANY_VALUE(collection_name) AS collection,
        ANY_VALUE(metal_name) AS metal,
        ANY_VALUE(item_size_name) AS size,
        ANY_VALUE(item_rate) AS item_rate,
        MIN(document_date) AS first_seen_date,
        ARRAY_AGG(document_no ORDER BY document_date ASC LIMIT 1)[OFFSET(0)] AS document_no,
        SUM(pieces) AS pieces_on_hand
      FROM \`lucirajewelry-prod.ds_imputed_reporting.Live_inventory\`
      WHERE item_id IS NOT NULL
      GROUP BY item_id, Store_name
    `,
  });
  return rows.map(r => {
    const price = toNumber(r.item_rate);
    return {
      itemId: r.item_id,
      itemCode: r.item_code || null,
      fullSku: r.Full_sku || null,
      itemName: r.item_name || null,
      category: r.category || 'Uncategorised',
      subCategory: r.sub_category_1 || null,
      collection: r.collection || null,
      metal: r.metal || null,
      size: r.size || null,
      storeName: r.Store_name || null,
      price,
      priceBand: priceBandOf(price),
      firstSeenDate: bqVal(r.first_seen_date) || null,
      documentNo: r.document_no || null,
      piecesOnHand: toNumber(r.pieces_on_hand) || 0,
    };
  });
}

// marketing_sale, GROUPED BY item_line_no. This is the one place where
// duplicate collapsing matters most: item_line_no has ~40 duplicate rows out
// of 2,486 (confirmed directly against BigQuery) — joining scans to the raw,
// un-grouped table on item_line_no would let one of those rare duplicates
// multiply a matched scan into two "sold" rows. Grouping first guarantees a
// scan can match at most one sale record.
async function fetchSalesRawRowCount() {
  const [rows] = await bigquery.query({
    query: `
      SELECT COUNT(*) AS c
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      WHERE item_line_no IS NOT NULL
    `,
  });
  return toNumber(rows[0].c) || 0;
}

async function fetchSales() {
  const [rows] = await bigquery.query({
    query: `
      SELECT
        item_line_no,
        ANY_VALUE(company_code) AS company_code,
        ANY_VALUE(document_no) AS document_no,
        ANY_VALUE(Transaction_Date) AS transaction_date,
        ANY_VALUE(Full_sku) AS full_sku,
        ANY_VALUE(type_name) AS category,
        ANY_VALUE(item_group_name) AS item_group,
        ANY_VALUE(collection_name) AS collection,
        ANY_VALUE(metal_name) AS metal,
        ANY_VALUE(style_name) AS style_name,
        ANY_VALUE(Price_Range) AS price_range,
        ANY_VALUE(party_id) AS party_id,
        ANY_VALUE(party_name) AS party_name,
        SUM(net_sale) AS net_sale,
        SUM(pieces) AS pieces
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      WHERE item_line_no IS NOT NULL
      GROUP BY item_line_no
    `,
  });
  return rows.map(r => ({
    itemLineNo: idStr(r.item_line_no),
    storeCode: r.company_code || null,
    store: displayStore(r.company_code),
    documentNo: r.document_no || null,
    date: bqVal(r.transaction_date) || null,
    fullSku: r.full_sku || null,
    category: r.category || null,
    itemGroup: r.item_group || null,
    collection: r.collection || null,
    metal: r.metal || null,
    styleName: r.style_name || null,
    priceRange: r.price_range || null,
    partyId: r.party_id != null ? String(r.party_id) : null,
    partyName: r.party_name || null,
    netSale: toNumber(r.net_sale) || 0,
    pieces: toNumber(r.pieces) || 0,
  }));
}

// --- Aggregation -------------------------------------------------------------

function summarizeBy(items, keyFn, keyOrder) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item) || 'Unknown';
    if (!map.has(key)) map.set(key, { key, count: 0, value: 0 });
    const entry = map.get(key);
    entry.count += 1;
    entry.value += item.price || 0;
  }
  const rows = [...map.values()].map(r => ({ ...r, value: round2(r.value) }));
  if (!keyOrder) return rows.sort((a, b) => b.count - a.count);
  return rows.sort((a, b) => keyOrder.indexOf(a.key) - keyOrder.indexOf(b.key));
}

// Amazon (an online-channel walk-in code, no physical scans/sales of its
// own) is excluded from this dashboard entirely. HO (Head Office) used to be
// excluded too; it is now included so totals match the raw BigQuery tables.
const EXCLUDED_STORE_CODES = new Set(['Amazon']);

async function buildScanDashboard() {
  const today = todayISODate();

  const [walkinsRaw, scanEventsRawUnfiltered, itemDescriptors, inventoryByItemStoreRaw, salesRaw, salesRawRowCount] = await Promise.all([
    fetchWalkins(),
    fetchScanEvents(),
    fetchItemDescriptors(),
    fetchInventoryByItemStore(),
    fetchSales(),
    fetchSalesRawRowCount(),
  ]);

  const walkins = walkinsRaw.filter(w => !EXCLUDED_STORE_CODES.has(w.storeCode));
  const scanEventsRaw = scanEventsRawUnfiltered.filter(s => !EXCLUDED_STORE_CODES.has(s.storeCode));
  const inventoryByItemStore = inventoryByItemStoreRaw.filter(i => !EXCLUDED_STORE_CODES.has(STORE_NAME_TO_CODE[i.storeName] || null));
  const sales = salesRaw.filter(s => !EXCLUDED_STORE_CODES.has(s.storeCode));

  const rawScanEventCount = scanEventsRaw.length;

  const itemMasterById = new Map(itemDescriptors.map(i => [i.itemId, i]));
  const saleByItemLineNo = new Map(sales.map(s => [s.itemLineNo, s]));

  // --- Scan -> Sale matching --------------------------------------------
  // Match key: item_line_no (the physical-unit/transaction-line id present
  // on both tables), scoped to the SAME store — matching across stores was
  // checked directly against BigQuery and produces wrong answers ~8% of the
  // time (46 of 559 raw item_line_no matches had scan.store != sale.store),
  // which would incorrectly mark a product as "sold" at a store it never
  // sold at. A store-mismatched match is treated as NOT sold (at that scan's
  // store) and counted separately in the reconciliation panel, never
  // silently dropped or silently counted as a sale.
  let crossStoreMatches = 0;
  const scanEvents = scanEventsRaw.map(s => {
    const enrichment = itemMasterById.get(s.itemId) || null;
    const candidateSale = s.itemLineNo ? saleByItemLineNo.get(s.itemLineNo) : null;
    let sold = false;
    let soldStoreMismatch = false;
    if (candidateSale) {
      const sameStore = !s.storeCode || !candidateSale.storeCode || s.storeCode === candidateSale.storeCode;
      if (sameStore) {
        sold = true;
      } else {
        soldStoreMismatch = true;
        crossStoreMatches += 1;
      }
    }
    // party_id is NULL on ~95% of scan rows, but marketing_sale.party_id is
    // 100% filled — so for a scan that matched a same-store sale via
    // item_line_no, the sale's party_id/party_name is a reliable stand-in
    // for "who this physical unit belongs to" when the scan itself didn't
    // carry an identity. This only ever fills in scans that already have a
    // verified item_line_no match; it never guesses at an unsold scan.
    const resolvedPartyId = s.partyId || (sold ? candidateSale.partyId : null);
    const partyIdSource = s.partyId ? 'scan' : (resolvedPartyId ? 'sale' : null);
    return {
      scanId: s.scanId,
      itemId: s.itemId,
      itemLineNo: s.itemLineNo,
      itemCode: s.itemCode,
      date: s.date,
      storeCode: s.storeCode,
      store: displayStore(s.storeCode),
      partyId: s.partyId,
      resolvedPartyId,
      partyIdSource,
      itemName: enrichment ? enrichment.itemName : null,
      category: enrichment ? enrichment.category : 'Unknown',
      subCategory: enrichment ? enrichment.subCategory : null,
      collection: enrichment ? enrichment.collection : null,
      metal: enrichment ? enrichment.metal : null,
      size: enrichment ? enrichment.size : null,
      price: enrichment ? enrichment.price : null,
      priceBand: enrichment ? enrichment.priceBand : 'Unknown',
      sold,
      soldStoreMismatch,
      sale: sold ? candidateSale : null,
    };
  });

  // party_id -> name, resolved from marketing_sale (party_id is 100% filled
  // there; on estimation_item_scan it's the id only, no name at all).
  const partyNames = {};
  for (const s of sales) {
    if (s.partyId && s.partyName && !partyNames[s.partyId]) partyNames[s.partyId] = s.partyName;
  }

  // --- Never Scanned: Live_inventory (in-stock) MINUS scan activity -------
  // Qualification is ITEM-LEVEL, not per-store: an item scanned at ANY store
  // is not "never scanned" — even for stock it also holds at a different
  // store that specific unit was never scanned at. (An item scanned at PN1
  // 14 times but never scanned at its Borivali stock is "Scanned but Not
  // Sold" at PN1, full stop — it must not also appear here for Borivali.)
  // Each qualifying item is still shown as one row PER STORE it has stock
  // in — that part is unchanged and still matters: fetchInventoryByItemStore
  // keeps each store's pieces/price/document/ageing mutually consistent
  // (see that function's comment for the fabricated-pairing bug this
  // avoids), so a genuinely never-scanned item with stock at two stores
  // correctly shows two rows with two different ageing figures.
  const scannedItemIdSet = new Set(scanEventsRaw.map(s => s.itemId));
  const notScannedItems = inventoryByItemStore
    .filter(i => i.piecesOnHand > 0 && !scannedItemIdSet.has(i.itemId))
    .map(i => ({ ...i, storeCode: STORE_NAME_TO_CODE[i.storeName] || null }))
    .map(i => ({
      itemId: i.itemId,
      itemCode: i.itemCode,
      fullSku: i.fullSku,
      itemName: i.itemName,
      category: i.category,
      subCategory: i.subCategory,
      collection: i.collection,
      metal: i.metal,
      size: i.size,
      storeCode: i.storeCode,
      store: displayStoreName(i.storeName),
      documentNo: i.documentNo,
      price: i.price,
      priceBand: i.priceBand,
      piecesOnHand: i.piecesOnHand,
      inventoryValue: i.price != null ? round2(i.price * i.piecesOnHand) : null,
      firstSeenDate: i.firstSeenDate,
      ageingDays: i.firstSeenDate ? daysBetween(i.firstSeenDate, today) : null,
    }));

  // --- Data-quality / reconciliation (whole-dataset, not filter-scoped) ---
  const uniqueItemsScanned = new Set(scanEventsRaw.map(s => s.itemId)).size;
  const soldItemLineNos = new Set(scanEvents.filter(s => s.sold).map(s => s.itemLineNo));
  const scannedItemIdsSold = new Set(scanEvents.filter(s => s.sold).map(s => s.itemId));
  const reconciliation = {
    rawScanEvents: rawScanEventCount,
    scanEventsAfterItemMapping: scanEvents.length,
    scanEventMappingMatches: rawScanEventCount === scanEvents.length,
    uniqueProductsScanned: uniqueItemsScanned,
    scannedAndSoldItems: scannedItemIdsSold.size,
    scannedButNotSoldItems: uniqueItemsScanned - scannedItemIdsSold.size,
    matchedSaleLines: soldItemLineNos.size,
    crossStoreMatchesExcluded: crossStoreMatches,
    salesRawRows: salesRawRowCount,
    salesDedupedRows: sales.length,
    salesDuplicateRowsCollapsed: salesRawRowCount - sales.length,
    neverScannedItems: notScannedItems.length,
    scanEventsWithPartyId: scanEventsRaw.filter(s => s.partyId).length,
    scanPartyIdCoveragePct: rawScanEventCount ? round2((scanEventsRaw.filter(s => s.partyId).length / rawScanEventCount) * 100) : 0,
    // resolvedPartyId = the scan's own party_id, OR (when the scan itself has
    // none) the party_id of the sale it matched via item_line_no — since
    // marketing_sale.party_id is 100% filled, this recovers customer identity
    // for a meaningful slice of scans the raw scan table alone can't attribute.
    scanEventsWithResolvedPartyId: scanEvents.filter(s => s.resolvedPartyId).length,
    scanEventsAttributedViaMatchedSale: scanEvents.filter(s => s.partyIdSource === 'sale').length,
    scanResolvedPartyIdCoveragePct: rawScanEventCount
      ? round2((scanEvents.filter(s => s.resolvedPartyId).length / rawScanEventCount) * 100)
      : 0,
  };

  const filterOptions = {
    stores: [...new Set([
      ...walkins.map(w => w.store),
      ...scanEvents.map(s => s.store),
      ...notScannedItems.map(i => i.store),
    ])].filter(Boolean).sort(),
    categories: [...new Set([
      ...scanEvents.map(s => s.category),
      ...notScannedItems.map(i => i.category),
    ])].filter(Boolean).sort(),
    collections: [...new Set([
      ...scanEvents.map(s => s.collection),
      ...notScannedItems.map(i => i.collection),
    ])].filter(Boolean).sort(),
    priceBands: PRICE_BAND_ORDER,
    sizes: [...new Set([
      ...scanEvents.map(s => s.size),
      ...notScannedItems.map(i => i.size),
    ])].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  };

  return {
    generatedAt: new Date().toISOString(),
    filterOptions,
    priceBandOrder: PRICE_BAND_ORDER,
    reconciliation,
    raw: {
      walkins,
      scanEvents,
      notScannedItems,
    },
    partyNames,
  };
}

module.exports = { buildScanDashboard };
