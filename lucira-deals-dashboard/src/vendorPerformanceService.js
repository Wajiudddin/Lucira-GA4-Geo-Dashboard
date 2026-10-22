require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');

// Same auth pattern as oldGoldService.js / refillService.js.
const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

// ---------------------------------------------------------------------------
// Data model (validated against the live tables, Oct 2026)
//
//   purchase.invoice_items  = one row per purchased line (grain of this model)
//   purchase.invoice        = header: document date / status (2 = cancelled)
//   marketing_sale          = one row per sales line
//
// Join key: item_line_no. It is the unit-level identity shared by both tables.
// `invoice_items.sku` is NULL on 97% of purchase rows and `items.sku` never
// equals marketing_sale.Full_sku, so SKU cannot be the join key.
//
// Fan-out guards:
//   * Sales are pre-aggregated to one row per item_line_no BEFORE joining.
//   * 7 item_line_no values appear twice on the invoice side. Sales are
//     attached only to the first purchase row of each line (rn = 1); the other
//     row keeps its purchase qty/value but gets sold = 0 and is flagged `dup`.
//   * Vendor comes from the party master via invoice_items.party_id (the sales
//     table's own Vendor column is carried separately for reconciliation).
//   * Category / metal / karat come from common_attributes via
//     item_attribute_id, so unsold lines have attributes too.
// ---------------------------------------------------------------------------

// Sales lines that must NOT count as sold:
//   * POS invoices that were cancelled (ornaverse_erp_pos.invoice.document_status = 2)
//   * lines returned by the customer — they are back in stock (Live_inventory rows created
//     by a POS Return / e-commerce sales return). marketing_sale has no status / return flag.
// Such lines stay on the purchase side and show as purchased, not sold.
const NOT_SOLD_LINES = `
  SELECT CAST(ii.item_line_no AS STRING) AS line_id
  FROM \`lucirajewelry-prod.ornaverse_erp_pos.invoice_items\` ii
  JOIN \`lucirajewelry-prod.ornaverse_erp_pos.invoice\` i ON i.transaction_id = ii.transaction_id
  WHERE i.document_status = 2
  UNION DISTINCT
  SELECT CAST(item_line_no AS STRING)
  FROM \`lucirajewelry-prod.ds_imputed_reporting.Live_inventory\`
  WHERE document_name IN ('POS Return', 'ECommSalesReturn') AND item_line_no IS NOT NULL
`;

const PURCHASE_FACT_QUERY = `
  WITH pur AS (
    SELECT
      ii.transaction_item_id,
      CAST(ii.item_line_no AS STRING) AS line_id,
      ii.party_id,
      ii.item_id,
      ii.item_attribute_id,
      ii.pieces,
      ii.net_amount,
      ii.net_weight,
      ii.sku AS inv_sku,
      i.document_no,
      i.bill_no,
      i.document_status,
      DATE(i.document_date) AS pdate,
      ROW_NUMBER() OVER (
        PARTITION BY ii.item_line_no
        ORDER BY i.document_date, ii.transaction_item_id
      ) AS rn
    FROM \`lucirajewelry-prod.purchase.invoice_items\` ii
    JOIN \`lucirajewelry-prod.purchase.invoice\` i ON i.transaction_id = ii.transaction_id
    WHERE i.document_status != 2          -- 2 = cancelled
  ),
  party AS (
    SELECT CAST(party_id AS INT64) AS party_id, ANY_VALUE(party_name) AS party_name
    FROM \`lucirajewelry-prod.ornaverse_erp_master.party\`
    GROUP BY 1
  ),
  attr AS (
    SELECT item_attribute_id,
      ANY_VALUE(type_name)        AS type_name,
      ANY_VALUE(item_group_name)  AS item_group_name,
      ANY_VALUE(metal_name)       AS metal_name,
      ANY_VALUE(karat_name)       AS karat_name,
      ANY_VALUE(metal_color_name) AS metal_color_name,
      ANY_VALUE(collection_name)  AS collection_name,
      ANY_VALUE(brand_name)       AS brand_name
    FROM \`lucirajewelry-prod.ornaverse_erp_master.common_attributes\`
    GROUP BY 1
  ),
  itm AS (
    SELECT item_id, ANY_VALUE(item_name) AS item_name, ANY_VALUE(sku) AS sku, ANY_VALUE(item_code) AS item_code
    FROM \`lucirajewelry-prod.ornaverse_erp_master.items\`
    GROUP BY 1
  ),
  sale AS (
    SELECT
      CAST(item_line_no AS STRING) AS line_id,
      SUM(pieces)                  AS sold_qty,
      SUM(net_sale)                AS sales_val,
      COUNT(*)                     AS sale_rows,
      MIN(Transaction_Date)        AS first_sale,
      MAX(Transaction_Date)        AS last_sale,
      ANY_VALUE(Vendor)            AS s_vendor,
      ANY_VALUE(Full_sku)          AS full_sku,
      ANY_VALUE(Product_Title)     AS title,
      ANY_VALUE(PF_sub_category_1) AS subcat,
      ANY_VALUE(company_code)      AS store,
      ANY_VALUE(Fullfillment)      AS fulfil,
      ANY_VALUE(Channel)           AS channel
    FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
    WHERE CAST(item_line_no AS STRING) NOT IN (${NOT_SOLD_LINES})
    GROUP BY 1
  ),
  live AS (
    -- Where the piece is right now (one Live_inventory row per item_line_no). Most stock sits in the
    -- generic "Finish Goods" location, so for that the owning store / company is shown instead.
    SELECT CAST(item_line_no AS STRING) AS line_id,
      ANY_VALUE(CASE
        -- "Banglore Malleshwaram" is only a location inside the Head Office company (no Bangalore store).
        WHEN location_name = 'Banglore Malleshwaram' THEN 'Head Office'
        WHEN location_name IS NOT NULL AND location_name != 'Finish Goods' THEN location_name
        WHEN company_code = 'HO' THEN 'Head Office'
        WHEN company_code = 'FCS' THEN 'FCS (HWI Ventures)'
        ELSE COALESCE(NULLIF(TRIM(REGEXP_EXTRACT(company_name, r'\\(([^)]+)\\)')), ''), company_name)
      END) AS avail,
      ANY_VALUE(document_date) AS avail_since
    FROM \`lucirajewelry-prod.ds_imputed_reporting.Live_inventory\`
    WHERE item_line_no IS NOT NULL
    GROUP BY 1
  ),
  xfer AS (
    -- Latest branch-in transfer of each piece (stock_in_Store = BIT documents; a piece can be transferred
    -- several times, the latest one is when it reached its current store). Ageing = today - this date.
    SELECT CAST(item_line_no AS STRING) AS line_id, MAX(Transfer_date) AS transfer_date
    FROM \`lucirajewelry-prod.ornaverse_erp_administration.stock_in_Store\`
    WHERE item_line_no != 0
    GROUP BY 1
  ),
  cret AS (
    -- Sold and then returned by the customer (back in stock via POS Return / e-commerce return).
    SELECT CAST(item_line_no AS STRING) AS line_id, SUM(pieces) AS cust_ret_qty, SUM(net_sale) AS cust_ret_val
    FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
    WHERE CAST(item_line_no AS STRING) IN (
      SELECT CAST(item_line_no AS STRING)
      FROM \`lucirajewelry-prod.ds_imputed_reporting.Live_inventory\`
      WHERE document_name IN ('POS Return', 'ECommSalesReturn') AND item_line_no IS NOT NULL)
    GROUP BY 1
  ),
  ret AS (
    SELECT CAST(ri.item_line_no AS STRING) AS line_id, SUM(ri.pieces) AS ret_qty
    FROM \`lucirajewelry-prod.purchase.return_items\` ri
    JOIN \`lucirajewelry-prod.purchase.return\` r ON r.transaction_id = ri.transaction_id
    WHERE r.document_status != 2
    GROUP BY 1
  )
  SELECT
    p.line_id, p.rn, p.document_no, p.bill_no, p.document_status,
    FORMAT_DATE('%Y-%m-%d', p.pdate) AS pdate,
    pa.party_name AS vendor,
    a.type_name, a.item_group_name, a.metal_name, a.karat_name, a.metal_color_name,
    a.collection_name, a.brand_name,
    COALESCE(NULLIF(TRIM(s.full_sku), ''), NULLIF(TRIM(it.sku), ''), NULLIF(TRIM(it.item_code), ''), NULLIF(TRIM(p.inv_sku), '')) AS sku,
    COALESCE(s.title, it.item_name) AS title,
    p.pieces, p.net_amount, p.net_weight,
    IF(p.rn = 1, s.sold_qty, NULL)   AS sold_qty,
    IF(p.rn = 1, s.sales_val, NULL)  AS sales_val,
    IF(p.rn = 1, s.sale_rows, NULL)  AS sale_rows,
    IF(p.rn = 1, FORMAT_DATE('%Y-%m-%d', s.first_sale), NULL) AS first_sale,
    IF(p.rn = 1, FORMAT_DATE('%Y-%m-%d', s.last_sale), NULL)  AS last_sale,
    s.s_vendor, s.subcat, s.store, s.fulfil, s.channel,
    r.ret_qty,
    IF(p.rn = 1, cr.cust_ret_qty, NULL) AS cust_ret_qty,
    IF(p.rn = 1, cr.cust_ret_val, NULL) AS cust_ret_val,
    IF(p.rn = 1, lv.avail, NULL) AS avail,
    IF(p.rn = 1, FORMAT_DATE('%Y-%m-%d', lv.avail_since), NULL) AS avail_since,
    IF(p.rn = 1 AND lv.avail IS NOT NULL, FORMAT_DATE('%Y-%m-%d', xf.transfer_date), NULL) AS transfer_date
  FROM pur p
  LEFT JOIN party pa ON pa.party_id = p.party_id
  LEFT JOIN attr a   ON a.item_attribute_id = p.item_attribute_id
  LEFT JOIN itm it   ON it.item_id = p.item_id
  LEFT JOIN sale s   ON s.line_id = p.line_id
  LEFT JOIN ret r    ON r.line_id = p.line_id AND p.rn = 1
  LEFT JOIN cret cr  ON cr.line_id = p.line_id
  LEFT JOIN live lv  ON lv.line_id = p.line_id
  LEFT JOIN xfer xf  ON xf.line_id = p.line_id
  ORDER BY p.pdate, p.transaction_item_id
`;

// Monthly sales for lines that exist on the purchase side (feeds the sales
// trend and vendor monthly trend; the client filters it by purchase-line id).
const SALES_MONTHLY_QUERY = `
  SELECT
    CAST(item_line_no AS STRING) AS line_id,
    FORMAT_DATE('%Y-%m', Transaction_Date) AS m,
    SUM(pieces) AS qty,
    SUM(net_sale) AS val
  FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
  WHERE CAST(item_line_no AS STRING) NOT IN (${NOT_SOLD_LINES})
  AND CAST(item_line_no AS STRING) IN (
    SELECT CAST(ii.item_line_no AS STRING)
    FROM \`lucirajewelry-prod.purchase.invoice_items\` ii
    JOIN \`lucirajewelry-prod.purchase.invoice\` i ON i.transaction_id = ii.transaction_id
    WHERE i.document_status != 2)
  GROUP BY 1, 2
`;

// Sales lines that cannot be mapped to a (non-cancelled) purchase invoice line.
// Grouped by the sales table's own Vendor column; flags whether the line is in
// consignment_items instead (stock received on consignment, not invoiced).
const UNMATCHED_SALES_QUERY = `
  WITH inv AS (
    SELECT DISTINCT CAST(ii.item_line_no AS STRING) AS line_id
    FROM \`lucirajewelry-prod.purchase.invoice_items\` ii
    JOIN \`lucirajewelry-prod.purchase.invoice\` i ON i.transaction_id = ii.transaction_id
    WHERE i.document_status != 2),
  con AS (
    SELECT DISTINCT CAST(item_line_no AS STRING) AS line_id
    FROM \`lucirajewelry-prod.purchase.consignment_items\`)
  SELECT
    COALESCE(ms.Vendor, '(no vendor on sale row)') AS vendor,
    con.line_id IS NOT NULL AS in_consignment,
    COUNT(DISTINCT ms.item_line_no) AS lines,
    COUNT(*) AS sale_rows,
    SUM(ms.pieces) AS qty,
    SUM(ms.net_sale) AS val
  FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\` ms
  LEFT JOIN inv ON inv.line_id = CAST(ms.item_line_no AS STRING)
  LEFT JOIN con ON con.line_id = CAST(ms.item_line_no AS STRING)
  WHERE inv.line_id IS NULL
  GROUP BY 1, 2
  ORDER BY val DESC
`;

const SALES_TOTALS_QUERY = `
  SELECT COUNT(*) AS rows_, COUNT(DISTINCT item_line_no) AS lines, SUM(pieces) AS qty, SUM(net_sale) AS val,
    COUNTIF(net_sale = 0) AS zero_value_rows,
    COUNTIF(Vendor IS NULL OR TRIM(Vendor) = '') AS no_vendor_rows,
    MIN(Transaction_Date) AS d0, MAX(Transaction_Date) AS d1
  FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
`;

const PURCHASE_TOTALS_QUERY = `
  SELECT
    COUNT(*) AS all_rows,
    COUNTIF(i.document_status = 2) AS cancelled_rows,
    COUNTIF(i.document_status = 0) AS draft_rows,
    COUNT(DISTINCT i.transaction_id) AS invoices
  FROM \`lucirajewelry-prod.purchase.invoice_items\` ii
  JOIN \`lucirajewelry-prod.purchase.invoice\` i ON i.transaction_id = ii.transaction_id
`;

function bqVal(v) {
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}
function num(v) {
  const n = Number(bqVal(v));
  return Number.isFinite(n) ? n : 0;
}
function str(v) {
  const s = bqVal(v);
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t === '' ? null : t;
}

// Gold items carry their tone in metal_color_name (Yellow/Rose/White Gold, …).
// "Metal" for analysis = that tone for gold, else the base metal.
function metalTone(metal, colour) {
  const m = str(metal);
  const c = str(colour);
  if (m === 'Gold' && c && c !== 'NA' && c !== 'Silver') return c;
  if (m && m !== 'NA') return m;
  if (c && c !== 'NA') return c;
  return null;
}
const clean = v => {
  const s = str(v);
  return s === 'NA' ? null : s;
};

async function buildVendorPerformance() {
  const run = async q => (await bigquery.query({ query: q, location: 'asia-south1' }))[0];
  const [factRows, salesMonthly, unmatched, salesTot, purTot] = await Promise.all([
    run(PURCHASE_FACT_QUERY),
    run(SALES_MONTHLY_QUERY),
    run(UNMATCHED_SALES_QUERY),
    run(SALES_TOTALS_QUERY),
    run(PURCHASE_TOTALS_QUERY),
  ]);

  const lines = factRows.map(r => ({
    id: str(r.line_id),
    dup: num(r.rn) > 1 ? 1 : 0,
    doc: str(r.document_no),   // GRN number, e.g. HO-GRN-09-26-79
    bill: str(r.bill_no),      // vendor's own invoice number
    ds: num(r.document_status),
    d: str(r.pdate),
    v: str(r.vendor),
    cat: clean(r.type_name),
    grp: clean(r.item_group_name),
    kt: clean(r.karat_name),
    mt: metalTone(r.metal_name, r.metal_color_name),
    coll: clean(r.collection_name),
    brand: clean(r.brand_name),
    sku: str(r.sku),
    t: str(r.title),
    q: num(r.pieces),
    a: num(r.net_amount),
    w: num(r.net_weight),
    sq: num(r.sold_qty),
    sv: num(r.sales_val),
    sr: num(r.sale_rows),
    fs: str(r.first_sale),
    ls: str(r.last_sale),
    sven: str(r.s_vendor),
    sub: clean(r.subcat),
    st: str(r.store),
    ful: str(r.fulfil),
    ch: str(r.channel),
    ret: num(r.ret_qty),
    crq: num(r.cust_ret_qty),   // customer returns: sold, then returned
    crv: num(r.cust_ret_val),
    avs: str(r.avail_since),    // date of the stock document that put it at this location
    tdt: str(r.transfer_date),  // latest branch-in transfer date (only for pieces in live stock)
    av: str(r.avail),          // current location / store from Live_inventory (null = not in stock)
  }));

  // Server-side reconciliation numbers that the client cannot derive.
  const fanOutCheck = {
    // Sales value attached to the model must equal sales value on matched sale lines.
    modelSalesValue: lines.reduce((s, l) => s + l.sv, 0),
    modelSoldQty: lines.reduce((s, l) => s + l.sq, 0),
  };
  const matchedSalesLines = new Set(lines.filter(l => l.sr > 0).map(l => l.id)).size;

  return {
    generatedAt: new Date().toISOString(),
    lines,
    salesMonthly: salesMonthly.map(r => [str(r.line_id), str(r.m), num(r.qty), num(r.val)]),
    unmatchedSales: unmatched.map(r => ({
      vendor: str(r.vendor),
      inConsignment: !!bqVal(r.in_consignment),
      lines: num(r.lines),
      saleRows: num(r.sale_rows),
      qty: num(r.qty),
      val: num(r.val),
    })),
    salesTotals: {
      rows: num(salesTot[0].rows_),
      lines: num(salesTot[0].lines),
      qty: num(salesTot[0].qty),
      val: num(salesTot[0].val),
      zeroValueRows: num(salesTot[0].zero_value_rows),
      noVendorRows: num(salesTot[0].no_vendor_rows),
      from: str(salesTot[0].d0),
      to: str(salesTot[0].d1),
    },
    purchaseTotals: {
      allRows: num(purTot[0].all_rows),
      cancelledRows: num(purTot[0].cancelled_rows),
      draftRows: num(purTot[0].draft_rows),
      invoices: num(purTot[0].invoices),
    },
    fanOutCheck: { ...fanOutCheck, matchedSalesLines },
  };
}

module.exports = { buildVendorPerformance };
