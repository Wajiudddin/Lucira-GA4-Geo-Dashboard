require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');

// Locally: falls back to Application Default Credentials (gcloud auth
// application-default login — a personal login, machine-specific).
// In production (no local gcloud session to fall back to): set
// GOOGLE_APPLICATION_CREDENTIALS_JSON to the full contents of a service
// account key so the app authenticates on its own, the same way
// ZOHO_CLIENT_SECRET etc. are handled — a credential in an env var, not a
// personal session.
const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

const AGEING_RED_FLAG_DAYS = 180;
const SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'refill-snapshot.json');

// company_code (marketing_sale / Reffling) <-> Store_name (Live_inventory) — this
// pairing was confirmed by inspecting real distinct values in both tables (not
// guessed): each Store_name is an unambiguous, human-readable expansion of one
// company_code. CS1 and FCS sell (they appear in marketing_sale) but have no
// Live_inventory rows under any Store_name — a real data gap, accepted by the
// user — so stock for those two stores is reported as null/"no stock data",
// never coerced to 0.
const HO_STORE_NAME = 'Divinecarat Lifestyles Private Limited';
const HWI_STORE_NAME = 'HWI VENTURES';
const MAL_STORE_NAME = 'Divinecarat Lifestyles Private Limited (Malleshwaram)';

// Live_inventory's Store_name for the 5 non-HO/HWI stores was renamed at the
// ERP source (confirmed 2026-09-24 by querying distinct Store_name values —
// the old friendly names like "Noida Sector 18 CoCo Store" no longer appear
// at all, replaced by "Divinecarat Lifestyles Private Limited (<city>)").
// Mapped 1:1 by city/area name (Lajpat=LPN, Noida=N18, Paschim=PV1, Pune=PN1,
// Borivali=BO1) — unambiguous. Using a stale name here means fetchCurrentStock
// silently finds no stock at all for that store, which used to make Condition
// 2 (current stock = 0) pass for everything, badly inflating the refill list.
const STORE_CODE_TO_NAME = {
  HO: HO_STORE_NAME,
  LPN: 'Divinecarat Lifestyles Private Limited (Lajpat)',
  N18: 'Divinecarat Lifestyles Private Limited (Noida)',
  PV1: 'Divinecarat Lifestyles Private Limited (Paschim)',
  PN1: 'Divinecarat Lifestyles Private Limited (Pune)',
  BO1: 'Divinecarat Lifestyles Private Limited (Borivali)',
  // company_code for HWI Ventures is FCS (ornaverse_erp_master.company, same
  // source used for this pairing elsewhere) — confirmed it now has both RTS
  // sales and Live_inventory stock rows, so it can carry its own refill list
  // like any other store (previously excluded — see STORES_WITH_NO_STOCK_COVERAGE).
  FCS: HWI_STORE_NAME,
  // Malleshwaram (Bengaluru) has no Store_name of its own in Live_inventory and,
  // per user, only "Finish Goods" stock is counted — so it has no stock rows
  // here and every SKU it sold shows store stock 0.
  MAL: MAL_STORE_NAME,
};
const STORE_NAME_TO_CODE = Object.fromEntries(
  Object.entries(STORE_CODE_TO_NAME).map(([code, name]) => [name, code])
);
STORE_NAME_TO_CODE[HWI_STORE_NAME] = 'HWI';

// Refill rows display FCS as "HWI" (its established short label everywhere
// else in this file, e.g. peer-store entries) rather than the raw ERP code.
const DISPLAY_STORE_CODE = { FCS: 'HWI' };

const STORES_WITH_NO_STOCK_COVERAGE = ['CS1'];

// HO is Head Office/warehouse, not a retail store — it's excluded from the
// refill list itself (no "HO Refill List" table/row/filter option), but
// HO_STORE_NAME stays fully wired everywhere else: HO On Hand / HO Available
// still checks Head Office's stock for every OTHER store's refill rows, and
// HO still counts toward Network Availability (§13) as a location that can
// hold >=2 units.
const STORES_EXCLUDED_FROM_REFILL_LIST = ['HO'];

function bqDate(value) {
  if (!value) return null;
  return typeof value === 'object' && value.value ? value.value : value;
}

function daysBetween(fromDateStr, toDateStr) {
  const from = new Date(fromDateStr + 'T00:00:00Z').getTime();
  const to = new Date(toDateStr + 'T00:00:00Z').getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

// --- BigQuery fetches -------------------------------------------------------

// Condition 1 (sold at this exact store, ever) + Condition 2 (current store
// stock = 0) is finished by the caller once current_stock is joined in — this
// only computes the "sold" side, per exact SKU per store. No date restriction
// (full sales history), per user's request to stop capping eligibility at 90
// days — a SKU that last sold long ago is still a valid refill candidate as
// long as it's currently out of stock at that store.
// Coins and silver jewelry are excluded (not the jewelry line this dashboard
// tracks): type_name catches 'Gold Coin'/'Silver Coin'; item_group_name
// catches the few rows correctly filed as 'Silver'/'Silver Jewellery'; but
// most 925-silver+diamond pieces are miscategorized under item_group_name
// 'Diamond Jewellery', so metal_name = 'Silver' is the reliable catch-all —
// confirmed against real SKUs (e.g. LJ-SLP001-925SLLGD), all three needed.
// Customize-order styles are excluded entirely (made-to-order, not real
// stock to refill): half_sku prefixes COR/COE/COP(D)/COB/COC/CNP/CTN/CNK,
// one per category (Ring/Earring/Pendant/Bracelet-Bangle/Chain-Mangalsutra/
// Nosepin/Tanmaniya/Necklace) — confirmed per-prefix against real type_name
// values, since some of these (e.g. COC014 = "Mangalsutra Chain", COC062 =
// "Chain") don't share one exact type_name, so filtering by style prefix is
// the only precise way to catch the whole family.
async function fetchRtsSalesAllTime() {
  const [rows] = await bigquery.query({
    query: `
      SELECT
        company_code AS store,
        Full_sku,
        half_sku AS style,
        ANY_VALUE(style_name) AS style_name,
        ANY_VALUE(metal_name) AS metal_name,
        ANY_VALUE(karat_name) AS karat_name,
        ANY_VALUE(metal_color_code) AS metal_color_code,
        MAX(Transaction_Date) AS last_sold_date,
        ARRAY_AGG(CAST(item_line_no AS STRING) IGNORE NULLS ORDER BY Transaction_Date DESC LIMIT 1)[SAFE_OFFSET(0)] AS item_line_no,
        SUM(pieces) AS qty_sold
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\` ms
      WHERE LOWER(Fullfillment) = 'rts'
        AND Full_sku IS NOT NULL
        AND company_code IS NOT NULL
        AND type_name NOT IN ('Gold Coin', 'Silver Coin')
        AND item_group_name NOT IN ('Silver', 'Silver Jewellery')
        AND metal_name != 'Silver'
        AND NOT REGEXP_CONTAINS(half_sku, r'^(COR|COE|COP|COB|COC|CNP|CTN|CNK)')
        -- A sale whose unit was returned (same item_line_no, return dated on or
        -- after the sale) is not a real sale — skipped so a returned product
        -- never creates a refill row. A later re-sale of the unit still counts.
        AND NOT EXISTS (
          SELECT 1
          FROM \`lucirajewelry-prod.ornaverse_erp_administration.return\` ra
          JOIN \`lucirajewelry-prod.ornaverse_erp_administration.return_items\` rb
            ON ra.transaction_id = rb.transaction_id
          WHERE rb.item_line_no = ms.item_line_no
            AND DATE(ra.document_date) >= DATE(ms.Transaction_Date)
        )
        -- Same for exchanges: a unit sold and then exchanged (Lucira_Prod.exchange
        -- / exchange_items, same item_line_no, exchange dated on or after the sale)
        -- is not a real sale either.
        AND NOT EXISTS (
          SELECT 1
          FROM \`lucirajewelry-prod.Lucira_Prod.exchange\` ea
          JOIN \`lucirajewelry-prod.Lucira_Prod.exchange_items\` eb
            ON ea.transaction_id = eb.transaction_id
          WHERE eb.item_line_no = ms.item_line_no
            AND DATE(ea.document_date) >= DATE(ms.Transaction_Date)
        )
      GROUP BY store, Full_sku, style
    `,
  });
  return rows.map(r => ({ ...r, last_sold_date: bqDate(r.last_sold_date) }));
}

// Current stock, per exact SKU per physical location (Store_name), from the
// Live_inventory per-unit ledger (each row there = one physical unit currently
// on hand). oldest_unit_date backs the peer-store ageing rule (§9/§15).
// location_name = 'Finish Goods' only — Live_inventory also carries rows under
// other locations (Repair, Vendor Return, Melting Stock, Certificate Pending,
// Market Place, Lost InTransit, Campaign, and a few duplicate-looking store
// labels like "Wave Noida"/"Banglore Malleshwaram") that aren't sellable
// finished-goods stock and would overcount what a store actually has on hand.
async function fetchCurrentStock() {
  const [rows] = await bigquery.query({
    query: `
      SELECT
        Store_name,
        Full_sku,
        ANY_VALUE(style_code) AS style_code,
        COUNT(*) AS qty_on_hand,
        ANY_VALUE(item_size_name) AS size_name,
        MIN(document_date) AS oldest_unit_date
      FROM \`lucirajewelry-prod.ds_imputed_reporting.Live_inventory\`
      WHERE Full_sku IS NOT NULL AND Store_name IS NOT NULL AND location_name = 'Finish Goods'
      GROUP BY Store_name, Full_sku
    `,
  });
  return rows.map(r => ({ ...r, oldest_unit_date: bqDate(r.oldest_unit_date) }));
}

// Lifetime Sales (Store, Style) — RTS only (matches the dashboard-wide RTS
// scope, §4), no date restriction, combines every size/metal/variant of the
// style (grouped by half_sku, not Full_sku) at that store.
async function fetchLifetimeStyleSales() {
  const [rows] = await bigquery.query({
    query: `
      SELECT company_code AS store, half_sku AS style, COUNT(*) AS lifetime_sales
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      WHERE LOWER(Fullfillment) = 'rts' AND half_sku IS NOT NULL AND company_code IS NOT NULL
        AND type_name NOT IN ('Gold Coin', 'Silver Coin')
        AND item_group_name NOT IN ('Silver', 'Silver Jewellery')
        AND metal_name != 'Silver'
        AND NOT REGEXP_CONTAINS(half_sku, r'^(COR|COE|COP|COB|COC|CNP|CTN|CNK)')
      GROUP BY store, style
    `,
  });
  return rows;
}

// Lifetime Sales for the exact SKU (unlike fetchLifetimeStyleSales above,
// this is Full_sku-level, not half_sku/style-level, all stores combined, and
// always shown — not gated on a red-flagged peer). RTS only, no date limit.
async function fetchLifetimeSkuSales() {
  const [rows] = await bigquery.query({
    query: `
      SELECT Full_sku, COUNT(*) AS lifetime_sku_sales
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      WHERE LOWER(Fullfillment) = 'rts' AND Full_sku IS NOT NULL
        AND type_name NOT IN ('Gold Coin', 'Silver Coin')
        AND item_group_name NOT IN ('Silver', 'Silver Jewellery')
        AND metal_name != 'Silver'
        AND NOT REGEXP_CONTAINS(half_sku, r'^(COR|COE|COP|COB|COC|CNP|CTN|CNK)')
      GROUP BY Full_sku
    `,
  });
  return new Map(rows.map(r => [r.Full_sku, r.lifetime_sku_sales]));
}

// Latest transfer per physical unit PER STORE (item_line_no persists across
// stores as a unit moves). One transfer is logged under every company the
// document touches (e.g. HO, BO1 and N18 for the same BIT document), so the
// partition must include company_code — partitioning by item_line_no alone
// kept an arbitrary one of them and dropped the selling store's own row.
// Joined to items
// for Full_sku since stock_in_Store only carries item_id. Used to compute
// Ageing Days as "last sold date minus the transfer that brought that stock
// into the selling store" (days sitting before it finally sold), replacing
// the old today-minus-last-sold basis.
async function fetchStockTransfers() {
  const [rows] = await bigquery.query({
    query: `
      SELECT
        s.company_code AS store,
        it.item_code AS Full_sku,
        s.Transfer_date AS transfer_date,
        s.document_no AS document_no,
        s.item_line_no AS item_line_no
      FROM (
        SELECT company_code, item_id, Transfer_date, document_no, CAST(item_line_no AS STRING) AS item_line_no
        FROM \`lucirajewelry-prod.ornaverse_erp_administration.stock_in_Store\`
        QUALIFY ROW_NUMBER() OVER (PARTITION BY item_line_no, company_code ORDER BY Transfer_date DESC) = 1
      ) s
      JOIN \`lucirajewelry-prod.ds_imputed_reporting.items\` it ON it.item_id = s.item_id
      WHERE it.item_code IS NOT NULL AND s.company_code IS NOT NULL
    `,
  });
  return rows.map(r => ({ store: r.store, Full_sku: r.Full_sku, transfer_date: bqDate(r.transfer_date), document_no: r.document_no, item_line_no: r.item_line_no }));
}

// Some sold units had their item_line_no changed by a stock allocation (the
// sale carries the NEW line no, while the original transfer was recorded under
// the line no the unit had before). stock_allocation_items.item_line_no (a) is
// the new line no, and the joined stock_allocated_items.item_line_no (b) is the
// one it replaced. Returns new line no -> [previous line nos], used to look the
// transfer date up under the previous line no when the new one has none.
async function fetchLineNoAliases() {
  const [rows] = await bigquery.query({
    query: `
      SELECT DISTINCT CAST(a.item_line_no AS STRING) AS new_line, CAST(b.item_line_no AS STRING) AS old_line
      FROM \`lucirajewelry-prod.Lucira_Prod.stock_allocation_items\` a
      LEFT JOIN \`lucirajewelry-prod.Lucira_Prod.stock_allocated_items\` b
        ON a.transaction_item_id = b.transaction_item_id
      WHERE a.item_line_no IS NOT NULL AND b.item_line_no IS NOT NULL AND a.item_line_no != b.item_line_no
    `,
  });
  const aliases = new Map();
  for (const r of rows) {
    if (!aliases.has(r.new_line)) aliases.set(r.new_line, []);
    aliases.get(r.new_line).push(r.old_line);
  }
  return aliases;
}

// rows of { item_line_no, transfer_date, document_no } -> every transfer date per
// item_line_no (a unit can move more than once) plus its document number.
function groupDatesByLine(rows) {
  const byLine = new Map();
  const docs = new Map(); // `${item_line_no}|${date}` -> document_no
  for (const r of rows) {
    if (!byLine.has(r.item_line_no)) byLine.set(r.item_line_no, []);
    const d = bqDate(r.transfer_date);
    byLine.get(r.item_line_no).push(d);
    docs.set(`${r.item_line_no}|${d}`, r.document_no);
  }
  return { byLine, docs };
}

// HWI Ventures (company_code FCS) receives stock by consignment-out from HO, not
// via stock_in_Store, so its Transfer Date is the consignment document_date of
// the unit, mapped by item_line_no (the sold unit's item_line_no from
// marketing_sale). A unit can be consigned more than once, so every date is kept
// and the caller picks the latest one on or before the sale.
async function fetchConsignmentOutDates() {
  const [rows] = await bigquery.query({
    query: `
      SELECT CAST(b.item_line_no AS STRING) AS item_line_no, DATE(a.document_date) AS transfer_date, a.document_no AS document_no
      FROM \`lucirajewelry-prod.Lucira_Prod.consignment_out\` a
      LEFT JOIN \`lucirajewelry-prod.Lucira_Prod.consignment_out_items\` b
        ON a.transaction_id = b.transaction_id
      WHERE b.item_line_no IS NOT NULL
    `,
  });
  return groupDatesByLine(rows);
}

// Fallback for HWI units with no consignment-out record: the stock_transfer
// document_date of the unit, mapped by item_line_no the same way.
async function fetchStockTransferDates() {
  const [rows] = await bigquery.query({
    query: `
      SELECT CAST(b.item_line_no AS STRING) AS item_line_no, DATE(a.document_date) AS transfer_date, a.document_no AS document_no
      FROM \`lucirajewelry-prod.Lucira_Prod.stock_transfer\` a
      LEFT JOIN \`lucirajewelry-prod.Lucira_Prod.stock_transfer_items\` b
        ON a.transaction_id = b.transaction_id
      WHERE b.item_line_no IS NOT NULL
    `,
  });
  return groupDatesByLine(rows);
}

// Last-resort Transfer Date source for any store: the branch receipt document_date
// of the unit, mapped by item_line_no.
async function fetchBranchReceiptDates() {
  const [rows] = await bigquery.query({
    query: `
      SELECT CAST(b.item_line_no AS STRING) AS item_line_no, DATE(a.document_date) AS transfer_date, a.document_no AS document_no
      FROM \`lucirajewelry-prod.Lucira_Prod.branch_receipt\` a
      LEFT JOIN \`lucirajewelry-prod.Lucira_Prod.branch_receipt_items\` b
        ON a.transaction_id = b.transaction_id
      WHERE b.item_line_no IS NOT NULL
    `,
  });
  return groupDatesByLine(rows);
}

// Final fallback after branch receipt: the finishing document_date of the unit,
// mapped by item_line_no.
async function fetchFinishingDates() {
  const [rows] = await bigquery.query({
    query: `
      SELECT CAST(b.item_line_no AS STRING) AS item_line_no, DATE(a.document_date) AS transfer_date, a.document_no AS document_no
      FROM \`lucirajewelry-prod.Lucira_Prod.finishing\` a
      LEFT JOIN \`lucirajewelry-prod.Lucira_Prod.finishing_items\` b
        ON a.transaction_id = b.transaction_id
      WHERE b.item_line_no IS NOT NULL
    `,
  });
  return groupDatesByLine(rows);
}

function latestDateOnOrBefore(dates, onOrBeforeDate) {
  return (dates || [])
    .filter(d => d <= onOrBeforeDate)
    .reduce((max, d) => (!max || d > max ? d : max), null);
}

// PO validity, per exact SKU (store-agnostic — no table links a PO to a store,
// confirmed during inspection; user accepted SKU-level PO validity). Joins
// order_items -> items (for item_code == Full_sku) -> order (for PO header
// fields). "PO Raised Date" = order.creation_date per user's confirmed choice.
async function fetchPoBySku() {
  const [rows] = await bigquery.query({
    query: `
      SELECT
        it.item_code AS Full_sku,
        o.document_no AS po_no,
        o.document_date AS po_date,
        o.creation_date AS po_raised_date
      FROM \`lucirajewelry-prod.purchase.order_items\` oi
      JOIN \`lucirajewelry-prod.ds_imputed_reporting.items\` it ON it.item_id = oi.item_id
      JOIN \`lucirajewelry-prod.purchase.order\` o ON o.transaction_id = oi.transaction_id
      WHERE it.item_code IS NOT NULL AND o.creation_date IS NOT NULL
    `,
  });
  return rows.map(r => ({
    Full_sku: r.Full_sku,
    po_no: r.po_no,
    po_date: bqDate(r.po_date),
    po_raised_date: bqDate(r.po_raised_date),
  }));
}

// Style key = the middle segment of a variant SKU ("LJ-R00034-14YWG-12" ->
// "R00034"); SKUs without hyphens fall back to the whole SKU. Must match the
// SPLIT(...)[1] expression in fetchPdpViews.
function styleKeyFromSku(sku) {
  const s = String(sku).toUpperCase().trim();
  return s.split('-')[1] || s;
}

// All-time PDP views + Add to Cart per style (all variants/sizes of the style
// summed; join key: style segment of ga4_data.sku == style segment of
// Full_sku), plus a site-wide daily trend for the last 90 days. Aggregated in
// SQL — ga4_data is ~9.2M rows, never pulled raw.
async function fetchPdpViews() {
  const [bySkuRows] = await bigquery.query({
    query: `
      SELECT style_key, ANY_VALUE(product_title) AS product_title,
        SUM(pdp_views) AS pdp_views,
        SUM(add_to_cart) AS add_to_cart
      FROM (
        SELECT product_title, pdp_views, add_to_cart,
          COALESCE(SPLIT(UPPER(TRIM(sku)), '-')[SAFE_OFFSET(1)], UPPER(TRIM(sku))) AS style_key
        FROM \`lucirajewelry-prod.ga4_data.ga4_data\`
        WHERE sku IS NOT NULL AND pdp_views IS NOT NULL
      )
      GROUP BY style_key
    `,
  });
  const [trendRows] = await bigquery.query({
    query: `
      SELECT event_date, SUM(pdp_views) AS pdp_views
      FROM \`lucirajewelry-prod.ga4_data.ga4_data\`
      WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY) AND pdp_views IS NOT NULL
      GROUP BY event_date
      ORDER BY event_date
    `,
  });
  return {
    bySku: bySkuRows,
    trend: trendRows.map(r => ({ date: bqDate(r.event_date), pdp_views: r.pdp_views })),
  };
}

// One product image per SKU (first non-certificate image on the earliest
// variant), from Shopify's own image list joined through product_view_table
// for the sku<->variant_id link. Query as given (uppercased/trimmed sku).
async function fetchSkuImages() {
  const [rows] = await bigquery.query({
    query: `
      SELECT sku, image_url, diamond_1_shape
      FROM (
        SELECT
          a.variant_id,
          a.image_url,
          UPPER(TRIM(b.sku)) AS sku,
          b.diamond_1_shape,
          ROW_NUMBER() OVER (
            PARTITION BY UPPER(TRIM(b.sku))
            ORDER BY a.variant_id
          ) AS sku1
        FROM (
          SELECT
            v.id AS variant_id,
            i.id AS image_id,
            i.src AS image_url,
            ROW_NUMBER() OVER (
              PARTITION BY v.id
              ORDER BY i.id
            ) AS rn
          FROM \`lucirajewelry-prod.Lucira_Prod.Lucira_Shopify_products\` p
          LEFT JOIN UNNEST(p.variants) v
          LEFT JOIN UNNEST(p.images) i
          WHERE i.src NOT LIKE '%Sample_Certificate%'
        ) AS a
        LEFT JOIN (
          SELECT DISTINCT variant_id, sku, diamond_1_shape
          FROM \`lucirajewelry-prod.ds_imputed_reporting.product_view_table\`
          WHERE sku IS NOT NULL
        ) AS b
        ON a.variant_id = b.variant_id
        WHERE rn = 1
      )
      WHERE sku1 = 1
    `,
  });
  return new Map(rows.map(r => [r.sku, { imageUrl: r.image_url || null, diamondShape: r.diamond_1_shape || null }]));
}

// --- Business logic ----------------------------------------------------------

function salesCycle(ageingDays) {
  if (ageingDays == null) return 'Unknown';
  return ageingDays > AGEING_RED_FLAG_DAYS ? 'Above 180' : 'Below 180';
}

// Latest transfer into (store, Full_sku) that happened on or before the sale
// it's being aged against — a transfer after the sale can't be the stock that
// sold, so it's not a candidate. Returns null when no qualifying transfer
// exists (ageing can't be computed rather than defaulting to 0).
function latestTransferOnOrBefore(transferDatesByStoreSku, store, sku, onOrBeforeDate) {
  const dates = transferDatesByStoreSku.get(`${store}|${sku}`);
  if (!dates || !dates.length) return null;
  const eligible = dates.filter(d => d <= onOrBeforeDate);
  if (!eligible.length) return null;
  return eligible.reduce((max, d) => (d > max ? d : max));
}

// City/area name for display in Network/Peer Availability, e.g. "Borivali"
// for "Divinecarat Lifestyles Private Limited (Borivali)" — pulled straight
// from the parenthetical in Store_name so it stays correct even if the ERP
// renames things again, rather than a separate hardcoded city map. HO and
// HWI Ventures have no parenthetical, so those fall back to the short code.
function storeShortLabel(storeName) {
  const cityMatch = storeName.match(/\(([^)]+)\)/);
  if (cityMatch) return cityMatch[1];
  return STORE_NAME_TO_CODE[storeName] || storeName;
}

// Network Availability (§13): every location (incl. HO) holding >=2 units of
// this STYLE (any size/metal variant, aggregated — see stockByStyleAtStore).
// Single-unit locations are excluded by rule.
function buildNetworkAvailability(stockRowsForStyle) {
  return stockRowsForStyle
    .filter(r => r.qty_on_hand >= 2)
    .map(r => `${storeShortLabel(r.Store_name)}-${r.qty_on_hand}`)
    .join(', ');
}

// Peer Store Availability (§14/§15): style-level (any size/metal variant),
// excludes HO, HWI Ventures, and the selling store itself. Self-exclusion
// matters now that matching is style-level (not exact SKU) — a store that
// sold out of this exact size/metal can still hold OTHER variants of the
// same style, which would otherwise show up as a "peer" of itself, breaking
// the Transfer Candidate concept (a store can't transfer stock to itself).
// Shown as Name-Qty(AgeingDays), e.g. "Borivali-1(254)"; ageing uses the
// oldest unit at that store (user's confirmed choice) and is red-flagged
// when > 180 days.
function buildPeerAvailability(stockRowsForStyle, today, sellingStoreName) {
  const peers = stockRowsForStyle.filter(
    r => r.Store_name !== HO_STORE_NAME && r.Store_name !== HWI_STORE_NAME && r.Store_name !== sellingStoreName
  );
  const entries = peers.map(r => {
    const ageing = r.oldest_unit_date ? daysBetween(r.oldest_unit_date, today) : null;
    return {
      store: storeShortLabel(r.Store_name),
      qty: r.qty_on_hand,
      ageingDays: ageing,
      isRedFlag: ageing != null && ageing > AGEING_RED_FLAG_DAYS,
    };
  });
  const display = entries
    .map(e => `${e.store}-${e.qty}(${e.ageingDays != null ? e.ageingDays : '—'})`)
    .join(', ');
  return { entries, display };
}

// §16's Lifetime Sales trigger is "any red-flagged peer stock" (no quantity
// requirement) — a strictly looser gate than §18's Transfer Candidate, which
// additionally requires that peer to hold >=2 units. Keeping these as two
// separate functions (rather than one shared filter) avoids the bug where a
// single-unit red-flagged peer silently suppressed Lifetime Sales entirely.
function computeLifetimeSalesDisplay(peerEntries, lifetimeSalesLookup, style) {
  const redFlagged = peerEntries.filter(e => e.isRedFlag);
  if (!redFlagged.length) return null;
  const strongest = redFlagged.reduce((a, b) => (b.ageingDays > a.ageingDays ? b : a));
  return lifetimeSalesLookup.get(`${strongest.store}|${style}`) ?? 0;
}

function classifyTransfer(peerEntries, lifetimeSalesLookup, style) {
  const qualifying = peerEntries.filter(e => e.isRedFlag && e.qty >= 2);
  if (!qualifying.length) return null;

  const strongest = qualifying.reduce((a, b) => (b.ageingDays > a.ageingDays ? b : a));
  const lifetimeSales = lifetimeSalesLookup.get(`${strongest.store}|${style}`) ?? 0;

  if (lifetimeSales === 0) return 'NO SALES HISTORY';
  if (lifetimeSales <= 2) return 'TRANSFER CANDIDATE';
  return 'REVIEW';
}

async function persistSnapshotAndDiffT1(currentKeys) {
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch (err) {
    previous = null; // no prior run yet — first-ever run, nothing to diff against
  }

  const currentSet = new Set(currentKeys);
  const previousSet = new Set(previous ? previous.keys : []);

  const t1 = {
    newlyFlagged: [...currentSet].filter(k => !previousSet.has(k)),
    stillPending: [...currentSet].filter(k => previousSet.has(k)),
    noLongerRequired: [...previousSet].filter(k => !currentSet.has(k)),
    previousRunDate: previous ? previous.date : null,
    previousRunMissing: !previous,
  };

  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({ date: todayISODate(), keys: [...currentSet] }));

  return t1;
}

async function buildRefillDashboard() {
  const today = todayISODate();

  const [rtsSales, currentStock, lifetimeSalesRows, lifetimeSkuSalesLookup, poRows, pdp, stockTransfers, skuImages, consignmentOut, stockTransferOut, lineNoAliases, branchReceiptOut, finishingOut] = await Promise.all([
    fetchRtsSalesAllTime(),
    fetchCurrentStock(),
    fetchLifetimeStyleSales(),
    fetchLifetimeSkuSales(),
    fetchPoBySku(),
    fetchPdpViews(),
    fetchStockTransfers(),
    fetchSkuImages(),
    fetchConsignmentOutDates(),
    fetchStockTransferDates(),
    fetchLineNoAliases(),
    fetchBranchReceiptDates(),
    fetchFinishingDates(),
  ]);

  const consignmentDatesByLine = consignmentOut.byLine;
  const stockTransferDatesByLine = stockTransferOut.byLine;

  const transferDatesByStoreSku = new Map();
  const transferDocByStoreSkuDate = new Map(); // `${store}|${sku}|${date}` -> document_no
  for (const t of stockTransfers) {
    const key = `${t.store}|${t.Full_sku}`;
    if (!transferDatesByStoreSku.has(key)) transferDatesByStoreSku.set(key, []);
    transferDatesByStoreSku.get(key).push(t.transfer_date);
    transferDocByStoreSkuDate.set(`${key}|${t.transfer_date}`, t.document_no);
  }
  // stock_in_Store keeps one (latest) transfer per item_line_no + store — see fetchStockTransfers.
  const stockInByLineStore = new Map(
    stockTransfers.filter(t => t.item_line_no).map(t => [`${t.item_line_no}|${t.store}`, { date: t.transfer_date, doc: t.document_no }])
  );

  // "Store_name|Full_sku" indexes the exact-SKU eligibility check (Condition 2,
  // HO On Hand) — unchanged, still exact size + metal.
  // Network/Peer Availability instead index by style (style_code) x Store_name,
  // aggregating every size/metal variant of that style at a store into one
  // entry (summed qty, oldest unit's date) — per user's request, a peer
  // holding a different size of the same style should still count as
  // available, not just an exact Full_sku match.
  const stockByStoreAndSku = new Map();
  const stockByStyleAtStore = new Map(); // style_code -> Map(Store_name -> { qty_on_hand, oldest_unit_date })
  for (const row of currentStock) {
    stockByStoreAndSku.set(`${row.Store_name}|${row.Full_sku}`, row);

    if (!row.style_code) continue;
    if (!stockByStyleAtStore.has(row.style_code)) stockByStyleAtStore.set(row.style_code, new Map());
    const byStore = stockByStyleAtStore.get(row.style_code);
    const existing = byStore.get(row.Store_name);
    if (!existing) {
      byStore.set(row.Store_name, { qty_on_hand: row.qty_on_hand, oldest_unit_date: row.oldest_unit_date });
    } else {
      existing.qty_on_hand += row.qty_on_hand;
      if (row.oldest_unit_date && (!existing.oldest_unit_date || row.oldest_unit_date < existing.oldest_unit_date)) {
        existing.oldest_unit_date = row.oldest_unit_date;
      }
    }
  }

  const lifetimeSalesLookup = new Map(
    lifetimeSalesRows.map(r => [`${r.store}|${r.style}`, r.lifetime_sales])
  );

  const poByFullSku = new Map();
  for (const po of poRows) {
    if (!poByFullSku.has(po.Full_sku)) poByFullSku.set(po.Full_sku, []);
    poByFullSku.get(po.Full_sku).push(po);
  }

  const sizeBySku = new Map();
  for (const row of currentStock) {
    if (row.size_name && !sizeBySku.has(row.Full_sku)) sizeBySku.set(row.Full_sku, row.size_name);
  }

  const pdpByStyle = new Map(pdp.bySku.map(r => [r.style_key, r]));

  const rows = [];
  const dataQualityNotes = [];
  const stockCoverageGapStores = new Set();

  for (const sale of rtsSales) {
    if (STORES_EXCLUDED_FROM_REFILL_LIST.includes(sale.store)) continue;

    const hasStockCoverage = !STORES_WITH_NO_STOCK_COVERAGE.includes(sale.store);
    if (!hasStockCoverage) {
      stockCoverageGapStores.add(sale.store);
      continue; // cannot evaluate Condition 2 (stock = 0) without stock data — excluded, not assumed
    }

    const storeName = STORE_CODE_TO_NAME[sale.store];
    if (!storeName) continue; // store not in the mapped set at all

    const stockAtStore = stockByStoreAndSku.get(`${storeName}|${sale.Full_sku}`);
    const currentStoreStock = stockAtStore ? stockAtStore.qty_on_hand : 0;
    if (currentStoreStock !== 0) continue; // Condition 2 fails — not a refill candidate

    // Already refilled: stock_in_Store logs a transfer into this store as soon
    // as it is issued, before the unit shows up in Live_inventory Finish Goods.
    // A transfer dated after the last sale means the refill has been sent, so
    // the refill has been sent — kept on the list but flagged "Transfer Sent".
    const transfersSinceSale = (transferDatesByStoreSku.get(`${sale.store}|${sale.Full_sku}`) || [])
      .filter(d => d > sale.last_sold_date);
    const transferSentDate = transfersSinceSale.length
      ? transfersSinceSale.reduce((max, d) => (d > max ? d : max))
      : null;

    // Ageing = days between the transfer that brought this stock into the
    // selling store and the sale that emptied it out — not days since today.
    // HWI (FCS): consignment-out date of the sold unit, else its stock_transfer
    // date; every other store: stock_in_Store.
    // transferDocNo is the document number of that same transfer.
    let transferDate;
    let transferDocNo = null;
    if (sale.store === 'FCS') {
      const consignDate = latestDateOnOrBefore(consignmentDatesByLine.get(sale.item_line_no), sale.last_sold_date);
      if (consignDate) {
        transferDate = consignDate;
        transferDocNo = consignmentOut.docs.get(`${sale.item_line_no}|${consignDate}`) || null;
      } else {
        transferDate = latestDateOnOrBefore(stockTransferDatesByLine.get(sale.item_line_no), sale.last_sold_date);
        transferDocNo = transferDate ? (stockTransferOut.docs.get(`${sale.item_line_no}|${transferDate}`) || null) : null;
      }
    } else {
      transferDate = latestTransferOnOrBefore(transferDatesByStoreSku, sale.store, sale.Full_sku, sale.last_sold_date);
      transferDocNo = transferDate ? (transferDocByStoreSkuDate.get(`${sale.store}|${sale.Full_sku}|${transferDate}`) || null) : null;
    }
    // Item line no changed by an allocation: no transfer under the sold unit's
    // current line no, so try the line no(s) it had before (see fetchLineNoAliases).
    if (!transferDate && sale.item_line_no) {
      let best = null;
      for (const oldLine of lineNoAliases.get(sale.item_line_no) || []) {
        const candidates = [];
        const si = stockInByLineStore.get(`${oldLine}|${sale.store}`);
        if (si) candidates.push(si);
        if (sale.store === 'FCS') {
          for (const [src, docs] of [[consignmentDatesByLine, consignmentOut.docs], [stockTransferDatesByLine, stockTransferOut.docs]]) {
            const d = latestDateOnOrBefore(src.get(oldLine), sale.last_sold_date);
            if (d) candidates.push({ date: d, doc: docs.get(`${oldLine}|${d}`) || null });
          }
        }
        for (const c of candidates) {
          if (c.date <= sale.last_sold_date && (!best || c.date > best.date)) best = c;
        }
      }
      if (best) {
        transferDate = best.date;
        transferDocNo = best.doc || null;
      }
    }
    // Still nothing: last resorts, in order — the branch receipt date, then the
    // finishing date — each tried under the unit's current line no, then any
    // previous line no.
    if (!transferDate && sale.item_line_no) {
      const lines = [sale.item_line_no, ...(lineNoAliases.get(sale.item_line_no) || [])];
      for (const source of [branchReceiptOut, finishingOut]) {
        let best = null;
        for (const line of lines) {
          // Only a document of the selling store counts (its number starts with the
          // store code, e.g. BO1-FNG-...), so another store's / HO's date is never
          // shown. HWI stock comes from HO documents, so HWI is not restricted.
          const ownStoreDates = (source.byLine.get(line) || []).filter(d => {
            const doc = source.docs.get(`${line}|${d}`);
            return sale.store === 'FCS' || (doc && doc.startsWith(`${sale.store}-`));
          });
          const d = latestDateOnOrBefore(ownStoreDates, sale.last_sold_date);
          if (d && (!best || d > best.date)) best = { date: d, doc: source.docs.get(`${line}|${d}`) || null };
        }
        if (best) {
          transferDate = best.date;
          transferDocNo = best.doc;
          break;
        }
      }
    }
    const ageingDays = transferDate ? daysBetween(transferDate, sale.last_sold_date) : null;
    const hoStock = stockByStoreAndSku.get(`${HO_STORE_NAME}|${sale.Full_sku}`);
    const hoOnHand = hoStock ? hoStock.qty_on_hand : 0;

    const styleStockByStore = stockByStyleAtStore.get(sale.style);
    const stockRowsForStyle = styleStockByStore
      ? Array.from(styleStockByStore.entries()).map(([Store_name, v]) => ({
          Store_name, qty_on_hand: v.qty_on_hand, oldest_unit_date: v.oldest_unit_date,
        }))
      : [];
    const networkAvailability = buildNetworkAvailability(stockRowsForStyle);
    const peer = buildPeerAvailability(stockRowsForStyle, today, storeName);
    const hasRedFlaggedPeer = peer.entries.some(e => e.isRedFlag);
    const lifetimeSalesDisplay = computeLifetimeSalesDisplay(peer.entries, lifetimeSalesLookup, sale.style);
    const transferStatus = classifyTransfer(peer.entries, lifetimeSalesLookup, sale.style);

    const validPo = (poByFullSku.get(sale.Full_sku) || [])
      .filter(po => po.po_raised_date > sale.last_sold_date)
      .sort((a, b) => (a.po_raised_date < b.po_raised_date ? 1 : -1))[0] || null;

    const pdpInfo = pdpByStyle.get(styleKeyFromSku(sale.Full_sku));
    const pdpViews = pdpInfo ? pdpInfo.pdp_views : 0;
    const atc = pdpInfo ? (pdpInfo.add_to_cart || 0) : 0;
    // Null (not 0%) when there are no PDP views to rate against — an
    // undefined ratio, not a real zero.
    const atcRatio = pdpViews > 0 ? Math.round((atc / pdpViews) * 1000) / 10 : null;

    const imageInfo = skuImages.get(sale.Full_sku.toUpperCase().trim());

    rows.push({
      store: DISPLAY_STORE_CODE[sale.store] || sale.store,
      sku: sale.Full_sku,
      itemLineNo: sale.item_line_no || null,
      imageUrl: imageInfo ? imageInfo.imageUrl : null,
      style: sale.style,
      styleName: sale.style_name,
      size: sizeBySku.get(sale.Full_sku) || null,
      metal: [sale.karat_name, sale.metal_color_code].filter(Boolean).join(' '),
      transferDate,
      transferDocNo,
      transferSent: transferSentDate != null,
      transferSentDate,
      lastSold: sale.last_sold_date,
      lifetimeSkuSales: lifetimeSkuSalesLookup.get(sale.Full_sku) || 0,
      ageingDays,
      salesCycle: salesCycle(ageingDays),
      currentStoreStock,
      reorderQty: 1,
      hoOnHand,
      fulfillment: 'RTS',
      poNo: validPo ? validPo.po_no : null,
      poDate: validPo ? validPo.po_date : null,
      poRaised: validPo ? validPo.po_raised_date : null,
      poStatus: validPo ? 'VALID' : 'NO VALID PO',
      availableAtNetwork: networkAvailability,
      availableAtPeerStores: peer.display,
      peerEntries: peer.entries,
      peerHasRedFlag: hasRedFlaggedPeer,
      lifetimeSales: lifetimeSalesDisplay,
      transferStatus,
      pdpViews,
      productTitle: pdpInfo ? pdpInfo.product_title : null,
      atc,
      atcRatio,
    });
  }

  if (stockCoverageGapStores.size) {
    dataQualityNotes.push(
      `${[...stockCoverageGapStores].sort().join(', ')} sold RTS SKUs but have ` +
      `no matching stock records in Live_inventory — excluded from the refill list rather than assumed ` +
      `to be zero. Confirm whether these stores' inventory is tracked elsewhere.`
    );
  }

  const currentKeys = rows.map(r => `${r.store}|${r.sku}`);
  const t1 = await persistSnapshotAndDiffT1(currentKeys);

  return {
    generatedAt: new Date().toISOString(),
    rows,
    pdpTrend: pdp.trend,
    t1,
    dataQualityNotes,
    ageingRedFlagDays: AGEING_RED_FLAG_DAYS,
    storeCodeToName: STORE_CODE_TO_NAME,
    storesWithNoStockCoverage: STORES_WITH_NO_STOCK_COVERAGE,
  };
}

module.exports = { buildRefillDashboard };
