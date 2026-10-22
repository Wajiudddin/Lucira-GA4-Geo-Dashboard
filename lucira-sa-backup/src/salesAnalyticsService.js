require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');

// Same auth pattern as the other BigQuery-backed services in this repo.
const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

// marketing_sale is small (~4K sales lines), so the whole table is shipped to
// the browser as slim line-level rows and every KPI / chart / table is
// aggregated client-side from that one array. That keeps global filters,
// KPI totals and drill-down tables reconciling by construction.
// Email / mobile / address are deliberately NOT selected (no PII beyond
// party_name, which only appears in the customer detail table).
const COLUMNS = {
  line: 'CAST(item_line_no AS STRING)',
  doc: 'document_no',
  date: 'CAST(Transaction_Date AS STRING)',
  chan: 'Channel',
  ful: 'Fullfillment',
  co: 'company_code',
  party: 'party_id',
  ctype: 'customer_type',
  ageing: 'ageing',
  pname: 'party_name',
  city: 'city_name',
  state: 'state_name',
  country: 'country_name',
  ig: 'item_group_name',
  type: 'type_name',
  sub1: 'PF_sub_category_1',
  sub2: 'PF_sub_category_2',
  sku: 'Full_sku',
  half: 'half_sku',
  style: 'style_code',
  styleName: 'style_name',
  title: 'Product_Title',
  metal: 'metal_name',
  mcolor: 'metal_color_name',
  karat: 'karat_name',
  vendor: 'Vendor',
  sol: 'Is_Solitaire',
  dset: 'Diamond_Setting',
  dshape: 'Diamond_1_shape',
  gset: 'Gemstone_Setting',
  gshape: 'Gemstone_1_Shape',
  dband: 'Diamond_Weight_Band',
  price: 'Price_Range',
  best: 'bestseller',
  coll: 'collection_name',
  pcs: 'pieces',
  net: 'net_sale',
  tax: 'tax_amount',
  disc: 'discount',
  adisc: 'additional_discount',
  dAmt: 'diamond_amount',
  dWt: 'diamond_weight',
  dPcs: 'diamond_pieces',
  mAmt: 'metal_amount',
  csAmt: 'color_stone_amount',
  csPcs: 'color_stone_pieces',
  csWt: 'color_stone_weight',
  sAmt: 'stone_amount',
  sPcs: 'stone_pieces',
  sWt: 'stone_weight',
  oAmt: 'other_amount',
  wt: 'net_weight',
};

const WINDOW_FROM = '2025-10-01';
// Upper bound is always "today" (IST) so new sales appear as soon as marketing_sale has them.
const windowTo = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const NUMERIC_KEYS = new Set([
  'party', 'ageing', 'pcs', 'net', 'tax', 'disc', 'adisc', 'dAmt', 'dWt', 'dPcs', 'mAmt',
  'oi', 'csAmt', 'csPcs', 'csWt', 'sAmt', 'sPcs', 'sWt', 'oAmt', 'wt',
]);

function bqVal(v) {
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}

async function buildSalesAnalytics() {
  const WINDOW_TO = windowTo();
  const select = Object.entries(COLUMNS).map(([k, expr]) => `${expr} AS ${k}`).join(', ');
  // Online-influenced store sale: a Store line whose customer already had an online touch on or before the sale date. Matched on mobile (and
  // email for Shopify). Online touch = (a) a website-activity deal in Zoho CRM (zoho_deal_intelligence: visitor = product view / add-to-cart,
  // subscriber = signup / login) or (b) a Shopify customer with email_consent_state = 'subscribed' (created_at = signup date).
  // If these tables can't be read the dashboard still loads, just without this flag.
  const baseWhere = `WHERE Transaction_Date BETWEEN DATE '${WINDOW_FROM}' AND DATE '${WINDOW_TO}' OR Transaction_Date IS NULL`;
  const withOi = `WITH web AS (
              SELECT m, MIN(d) AS fw FROM (
                SELECT mobile_norm AS m, deal_created_date AS d FROM \`lucirajewelry-prod.zoho_crm.zoho_deal_intelligence\`
                  WHERE (visitor_flag OR subscriber_flag) AND mobile_norm IS NOT NULL
                UNION ALL
                SELECT RIGHT(REGEXP_REPLACE(mobile, r'[^0-9]', ''), 10), created_at FROM \`lucirajewelry-prod.ds_imputed_reporting.Shopify_customer\`
                  WHERE email_consent_state = 'subscribed' AND mobile IS NOT NULL) GROUP BY 1),
            webe AS (SELECT LOWER(TRIM(email)) AS em, MIN(created_at) AS fe FROM \`lucirajewelry-prod.ds_imputed_reporting.Shopify_customer\`
                  WHERE email_consent_state = 'subscribed' AND email IS NOT NULL GROUP BY 1)
            SELECT ${select},
              IF(Channel = 'Store' AND LEAST(IFNULL(web.fw, DATE '2999-01-01'), IFNULL(webe.fe, DATE '2999-01-01')) <= Transaction_Date, 1, 0) AS oi
            FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\` s
            LEFT JOIN web ON web.m = RIGHT(REGEXP_REPLACE(IFNULL(NULLIF(s.Cus_mobile, ''), s.mobile1), r'[^0-9]', ''), 10)
            LEFT JOIN webe ON webe.em = LOWER(TRIM(IFNULL(NULLIF(s.email, ''), s.email_id))) ${baseWhere}`;
  let rows;
  try { [rows] = await bigquery.query({ query: withOi }); }
  catch (e) {
    console.error('online-influenced flag unavailable, loading without it:', e.message);
    [rows] = await bigquery.query({ query: `SELECT ${select} FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\` ${baseWhere}` });
  }
  const out = rows.map(r => {
    const o = {};
    for (const k of [...Object.keys(COLUMNS), 'oi']) {
      let v = bqVal(r[k]);
      if (v === undefined || v === null || v === '' || (k === 'oi' && !Number(v))) { continue; } // omitted keys = NULL (keeps payload small)
      if (NUMERIC_KEYS.has(k)) v = Number(v);
      o[k] = v;
    }
    return o;
  });
  // Sale returns (POS sale-return documents, series *-PSR-*). return_items.net_amount is on the same basis as
  // marketing_sale.net_sale (verified: identical for the original sale line). Counted by return document date.
  const [retRows] = await bigquery.query({
    query: `SELECT ri.party_id AS party, ri.pieces AS pcs, ri.net_amount AS net, ri.sku AS sku,
                   CAST(DATE(h.document_date) AS STRING) AS date, h.document_no AS doc,
                   inv.document_no AS origDoc, CAST(ii.item_line_no AS STRING) AS origLine
            FROM \`lucirajewelry-prod.ornaverse_erp_administration.return_items\` ri
            JOIN \`lucirajewelry-prod.ornaverse_erp_administration.return\` h ON h.transaction_id = ri.transaction_id
            LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_administration.invoice_items\` ii ON ii.transaction_item_id = ri.ref_transaction_item_id
            LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_administration.invoice\` inv ON inv.transaction_id = COALESCE(ii.transaction_id, ri.ref_transaction_id)
            WHERE DATE(h.document_date) BETWEEN DATE '${WINDOW_FROM}' AND DATE '${WINDOW_TO}'`,
  });
  const returns = retRows.map(r => ({ party: Number(bqVal(r.party)), pcs: Number(bqVal(r.pcs)) || 0, net: Number(bqVal(r.net)) || 0, sku: bqVal(r.sku), date: bqVal(r.date), doc: bqVal(r.doc), origDoc: bqVal(r.origDoc) || null, origLine: bqVal(r.origLine) || null }));
  return { generatedAt: new Date().toISOString(), source: 'ds_imputed_reporting.marketing_sale', rows: out, returns };
}

module.exports = { buildSalesAnalytics };
