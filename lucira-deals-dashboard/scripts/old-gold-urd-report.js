require('dotenv').config();
const path = require('path');
const os = require('os');
const XLSX = require('xlsx');
const { buildOldGoldDashboard } = require('../src/oldGoldService');

// Same classification as public/old-gold.js's metalTypeOf() — item_name is
// "URD GOLD" / "URD Silver" / an occasional finished-piece name.
function metalTypeOf(itemName) {
  const name = (itemName || '').toLowerCase();
  if (name.includes('gold')) return 'Gold';
  if (name.includes('silver')) return 'Silver';
  return 'Other';
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function metalStats(rows) {
  const pureWeight = round2(rows.reduce((s, r) => s + r.pureWeight, 0));
  const amount = round2(rows.reduce((s, r) => s + r.netAmount, 0));
  return {
    transactions: new Set(rows.map(r => r.documentNo)).size,
    items: rows.length,
    customers: new Set(rows.map(r => r.customer).filter(Boolean)).size,
    grossWeight: round2(rows.reduce((s, r) => s + r.grossWeight, 0)),
    netWeight: round2(rows.reduce((s, r) => s + r.netWeight, 0)),
    pureWeight,
    amount,
    avgRate: pureWeight > 0 ? round2(amount / pureWeight) : null,
  };
}

function itemToRow(r) {
  return {
    'Document No': r.documentNo,
    'Date': r.date,
    'Store': r.storeCode,
    'Store Name': r.store,
    'Customer': r.customer,
    'Customer Mobile': r.customerMobile,
    'Metal Type': metalTypeOf(r.itemName),
    'Item Name': r.itemName,
    'Location': r.location,
    'Gross Weight (g)': r.grossWeight,
    'Net Weight (g)': r.netWeight,
    'Purity (%)': r.purity ? round2(r.purity * 100) : null,
    'Pure Weight (g)': r.pureWeight,
    'Rate': r.rate,
    'Metal Amount': r.metalAmount,
    'Diamond Amount': r.diamondAmount,
    'Stone Amount': r.stoneAmount,
    'Other Amount': r.otherAmount,
    'Net Amount': r.netAmount,
  };
}

async function main() {
  console.log('Fetching URD old-gold data from BigQuery (via src/oldGoldService.js — same source as the dashboard)...');
  const data = await buildOldGoldDashboard();
  const items = data.items;
  console.log(`Fetched ${items.length} URD line items across ${new Set(items.map(i => i.documentNo)).size} transactions.`);

  const hasOther = items.some(i => metalTypeOf(i.itemName) === 'Other');
  const metals = ['Gold', 'Silver', ...(hasOther ? ['Other'] : [])];

  // --- Metal Summary ------------------------------------------------------
  const metalSummaryRows = metals.map(metal => {
    const stats = metalStats(items.filter(i => metalTypeOf(i.itemName) === metal));
    return {
      'Metal': metal,
      'Transactions': stats.transactions,
      'Items': stats.items,
      'Customers': stats.customers,
      'Gross Wt (g)': stats.grossWeight,
      'Net Wt (g)': stats.netWeight,
      'Pure Wt (g)': stats.pureWeight,
      'Amount Paid': stats.amount,
      'Avg Rate / g': stats.avgRate,
    };
  });
  const totalStats = metalStats(items);
  metalSummaryRows.push({
    'Metal': 'TOTAL',
    'Transactions': totalStats.transactions,
    'Items': totalStats.items,
    'Customers': totalStats.customers,
    'Gross Wt (g)': totalStats.grossWeight,
    'Net Wt (g)': totalStats.netWeight,
    'Pure Wt (g)': totalStats.pureWeight,
    'Amount Paid': totalStats.amount,
    'Avg Rate / g': totalStats.avgRate,
  });

  // --- Summary by Store -----------------------------------------------------
  const storeCodes = [...new Set(items.map(i => i.storeCode))].sort();
  const storeSummaryRows = storeCodes.map(code => {
    const stats = metalStats(items.filter(i => i.storeCode === code));
    return {
      'Store': code,
      'Transactions': stats.transactions,
      'Items': stats.items,
      'Gross Wt (g)': stats.grossWeight,
      'Net Wt (g)': stats.netWeight,
      'Pure Wt (g)': stats.pureWeight,
      'Amount Paid': stats.amount,
    };
  }).sort((a, b) => b['Amount Paid'] - a['Amount Paid']);

  // --- Summary by Month -----------------------------------------------------
  const months = [...new Set(items.map(i => i.month))].sort();
  const monthSummaryRows = months.map(m => {
    const stats = metalStats(items.filter(i => i.month === m));
    return {
      'Month': m,
      'Transactions': stats.transactions,
      'Items': stats.items,
      'Gross Wt (g)': stats.grossWeight,
      'Net Wt (g)': stats.netWeight,
      'Pure Wt (g)': stats.pureWeight,
      'Amount Paid': stats.amount,
    };
  });

  // --- Detail sheets --------------------------------------------------------
  const allRows = items.map(itemToRow).sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0));
  const goldRows = allRows.filter(r => r['Metal Type'] === 'Gold');
  const silverRows = allRows.filter(r => r['Metal Type'] === 'Silver');
  const otherRows = allRows.filter(r => r['Metal Type'] === 'Other');

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(metalSummaryRows), 'Metal Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(storeSummaryRows), 'Summary by Store');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(monthSummaryRows), 'Summary by Month');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allRows), 'All URD Transactions');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(goldRows), 'Gold Transactions');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(silverRows), 'Silver Transactions');
  if (otherRows.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(otherRows), 'Other Transactions');
  }

  const outPath = path.join(os.homedir(), 'Desktop', 'Lucira-Old-Gold-URD-Report.xlsx');
  XLSX.writeFile(wb, outPath);
  console.log('Written to:', outPath);
  console.log('Metal Summary:', JSON.stringify(metalSummaryRows, null, 2));
}

main().catch(err => {
  console.error('ERROR', err);
  process.exit(1);
});
