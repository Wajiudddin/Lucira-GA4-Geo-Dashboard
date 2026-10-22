require('dotenv').config();
const path = require('path');
const os = require('os');
const XLSX = require('xlsx');
const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

// BigQuery TIMESTAMP/DATE fields come back as wrapper objects ({ value }),
// same pattern as bqDate() in refillService.js.
function bqVal(v) {
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}

function toNumber(v) {
  const n = Number(bqVal(v));
  return Number.isFinite(n) ? n : 0;
}

const TRANSACTIONS_QUERY = `
  SELECT
    e.document_no,
    e.document_date,
    c.company_name AS store,
    p.party_name AS customer,
    p.mobile AS customer_mobile,
    p.phone AS customer_phone,
    emp.employee_name AS created_by,
    sp.employee_name AS sales_person,
    e.pieces,
    e.weight,
    e.net_weight,
    e.sub_total,
    e.tax_amount,
    e.discount,
    e.net_amount,
    e.receipt_amount,
    e.balance_amount,
    e.document_status,
    e.narration,
    e.remark,
    e.transaction_id
  FROM \`lucirajewelry-prod.Lucira_Prod.exchange\` e
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.company\` c ON e.company_id = c.company_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.party\` p ON e.party_id = p.party_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_administration_1.employee\` emp ON e.employee_id = emp.employee_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_administration_1.employee\` sp ON e.sales_person_id = sp.employee_id
  ORDER BY e.document_date
`;

const LINE_ITEMS_QUERY = `
  SELECT
    e.document_no,
    e.document_date,
    c.company_name AS store,
    p.party_name AS customer,
    ei.sku,
    it.item_name,
    loc.location_name,
    ei.pieces,
    ei.weight,
    ei.net_weight,
    ei.purity,
    ei.pure_weight,
    ei.item_rate,
    ei.metal_amount,
    ei.diamond_amount,
    ei.stone_amount,
    ei.other_amount,
    ei.net_amount,
    ei.huid,
    ei.narration,
    e.transaction_id
  FROM \`lucirajewelry-prod.Lucira_Prod.exchange_items\` ei
  JOIN \`lucirajewelry-prod.Lucira_Prod.exchange\` e ON ei.transaction_id = e.transaction_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.company\` c ON e.company_id = c.company_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.party\` p ON e.party_id = p.party_id
  LEFT JOIN \`lucirajewelry-prod.ds_imputed_reporting.items\` it ON ei.item_id = it.item_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.location\` loc ON ei.location_id = loc.location_id
  ORDER BY e.document_date, ei.item_line_no
`;

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function main() {
  console.log('Fetching exchange transactions + line items from BigQuery...');
  const [[txRows], [itemRows]] = await Promise.all([
    bigquery.query({ query: TRANSACTIONS_QUERY }),
    bigquery.query({ query: LINE_ITEMS_QUERY }),
  ]);
  console.log(`Fetched ${txRows.length} transactions, ${itemRows.length} line items.`);

  // The header `pieces` field is mostly 0/unreliable in the source data —
  // the real per-transaction item count is how many exchange_items rows
  // belong to it (each row = one physical old-gold item exchanged).
  const itemCountByTxn = new Map();
  for (const r of itemRows) {
    const key = String(bqVal(r.transaction_id));
    itemCountByTxn.set(key, (itemCountByTxn.get(key) || 0) + 1);
  }

  const transactionRows = txRows.map(r => ({
    'Document No': r.document_no,
    'Date': bqVal(r.document_date) ? bqVal(r.document_date).slice(0, 10) : null,
    'Store': r.store,
    'Customer': r.customer,
    'Customer Mobile': r.customer_mobile || r.customer_phone || null,
    'Created By': r.created_by,
    'Sales Person': r.sales_person,
    'Items Exchanged': itemCountByTxn.get(String(bqVal(r.transaction_id))) || 0,
    'Gross Weight (g)': round2(toNumber(r.weight)),
    'Net Weight (g)': round2(toNumber(r.net_weight)),
    'Sub Total': round2(toNumber(r.sub_total)),
    'Tax': round2(toNumber(r.tax_amount)),
    'Discount': round2(toNumber(r.discount)),
    'Net Amount': round2(toNumber(r.net_amount)),
    'Receipt Amount': round2(toNumber(r.receipt_amount)),
    'Balance Amount': round2(toNumber(r.balance_amount)),
    'Status': r.document_status,
    'Narration': r.narration,
    'Remark': r.remark,
  }));

  const itemRowsOut = itemRows.map(r => ({
    'Document No': r.document_no,
    'Date': bqVal(r.document_date) ? bqVal(r.document_date).slice(0, 10) : null,
    'Store': r.store,
    'Customer': r.customer,
    'SKU': r.sku,
    'Item Name': r.item_name,
    'Location': r.location_name,
    'Pieces': toNumber(r.pieces),
    'Gross Weight (g)': round2(toNumber(r.weight)),
    'Net Weight (g)': round2(toNumber(r.net_weight)),
    'Purity (%)': toNumber(r.purity),
    'Pure Weight (g)': round2(toNumber(r.pure_weight)),
    'Rate': round2(toNumber(r.item_rate)),
    'Metal Amount': round2(toNumber(r.metal_amount)),
    'Diamond Amount': round2(toNumber(r.diamond_amount)),
    'Stone Amount': round2(toNumber(r.stone_amount)),
    'Other Amount': round2(toNumber(r.other_amount)),
    'Net Amount': round2(toNumber(r.net_amount)),
    'HUID': r.huid,
    'Narration': r.narration,
  }));

  // --- Summary by store -------------------------------------------------
  const byStore = new Map();
  for (const r of transactionRows) {
    const key = r.Store || 'Unknown';
    if (!byStore.has(key)) {
      byStore.set(key, { store: key, transactions: 0, items: 0, grossWeight: 0, netWeight: 0, netAmount: 0 });
    }
    const row = byStore.get(key);
    row.transactions += 1;
    row.items += r['Items Exchanged'];
    row.grossWeight += r['Gross Weight (g)'];
    row.netWeight += r['Net Weight (g)'];
    row.netAmount += r['Net Amount'];
  }
  const storeSummaryRows = Array.from(byStore.values())
    .sort((a, b) => b.netAmount - a.netAmount)
    .map(r => ({
      'Store': r.store,
      'Transactions': r.transactions,
      'Items Exchanged': r.items,
      'Gross Weight (g)': round2(r.grossWeight),
      'Net Weight (g)': round2(r.netWeight),
      'Net Amount': round2(r.netAmount),
    }));

  // --- Summary by month --------------------------------------------------
  const byMonth = new Map();
  for (const r of transactionRows) {
    const key = r.Date ? r.Date.slice(0, 7) : 'Unknown';
    if (!byMonth.has(key)) {
      byMonth.set(key, { month: key, transactions: 0, items: 0, grossWeight: 0, netWeight: 0, netAmount: 0 });
    }
    const row = byMonth.get(key);
    row.transactions += 1;
    row.items += r['Items Exchanged'];
    row.grossWeight += r['Gross Weight (g)'];
    row.netWeight += r['Net Weight (g)'];
    row.netAmount += r['Net Amount'];
  }
  const monthSummaryRows = Array.from(byMonth.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(r => ({
      'Month': r.month,
      'Transactions': r.transactions,
      'Items Exchanged': r.items,
      'Gross Weight (g)': round2(r.grossWeight),
      'Net Weight (g)': round2(r.netWeight),
      'Net Amount': round2(r.netAmount),
    }));

  const grandTotal = {
    'Store/Month': 'GRAND TOTAL',
    'Transactions': transactionRows.length,
    'Items Exchanged': transactionRows.reduce((s, r) => s + r['Items Exchanged'], 0),
    'Gross Weight (g)': round2(transactionRows.reduce((s, r) => s + r['Gross Weight (g)'], 0)),
    'Net Weight (g)': round2(transactionRows.reduce((s, r) => s + r['Net Weight (g)'], 0)),
    'Net Amount': round2(transactionRows.reduce((s, r) => s + r['Net Amount'], 0)),
  };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(storeSummaryRows), 'Summary by Store');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(monthSummaryRows), 'Summary by Month');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([grandTotal]), 'Grand Total');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(transactionRows), 'Transactions');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(itemRowsOut), 'Line Items');

  const outPath = path.join(os.homedir(), 'Desktop', 'Lucira-Old-Gold-Exchange-Report.xlsx');
  XLSX.writeFile(wb, outPath);
  console.log('Written to:', outPath);
  console.log('Store summary:', JSON.stringify(storeSummaryRows, null, 2));
  console.log('Grand total:', JSON.stringify(grandTotal, null, 2));
}

main().catch(err => {
  console.error('ERROR', err);
  process.exit(1);
});
