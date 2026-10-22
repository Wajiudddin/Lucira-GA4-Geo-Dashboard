require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');

// Same auth pattern as refillService.js: local gcloud ADC, or a service
// account JSON in an env var in production.
const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

// lucirajewelry-prod.Lucira_Prod.exchange encodes the transaction type inside
// document_no's second segment (e.g. "BO1-URD-04-26-1", "PN1-EXC-05-26-00001"):
//   URD = plain old-gold purchase (Unregistered Dealer) — a cash buy, no new
//         jewelry sale attached. This is "old gold" in the business sense.
//   EXC = old gold traded in as part of a new-jewelry sale (Exchange) —
//         a sales transaction, not an old-gold purchase. Excluded per user.
//   BYB = Buy Back (5 rows) — also excluded; not asked for.
const DOC_TYPE_FILTER = 'URD';

// ornaverse_erp_master.company (8 rows, stable ERP master data).
const STORE_CODE_TO_NAME = {
  HO: 'Divinecarat Lifestyles Private Limited',
  CS1: 'Chembur Mumbai CoCo Store',
  PN1: 'JM Pune CoCo Store',
  BO1: 'Sky City Borivali CoCo Store',
  N18: 'Noida Sector 18 CoCo Store',
  FCS: 'HWI VENTURES',
  PV1: 'Paschim Vihar Lucira Jewelry',
  LPN: 'Lagpat Nagar Delhi, Lucira Jewelry',
};
const STORE_NAME_TO_CODE = Object.fromEntries(
  Object.entries(STORE_CODE_TO_NAME).map(([code, name]) => [name, code])
);

function bqVal(v) {
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}

function toNumber(v) {
  const n = Number(bqVal(v));
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function daysBetween(fromDateStr, toDateStr) {
  const from = new Date(fromDateStr + 'T00:00:00Z').getTime();
  const to = new Date(toDateStr + 'T00:00:00Z').getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

// "Gold"/"Silver" for the two real metals — same keyword classification used
// client-side (item_name is "URD GOLD" / "URD Silver", never a dedicated
// metal column on these rows).
function metalTypeOfServer(itemName) {
  const name = (itemName || '').toLowerCase();
  if (name.includes('gold')) return 'Gold';
  if (name.includes('silver')) return 'Silver';
  return 'Other';
}

// No lookup table maps metal_type_id to a name (checked — doesn't exist
// anywhere in this BigQuery project). Inferred from the rate magnitude and
// confirmed against the user's own worked example (their "Gold rate 28th"
// and "Today gold rate" match these exact 106 rows for those two dates):
//   106 = Gold (₹10,000–18,000/g, matches real purchase rates)
//   107 = Silver (₹224–305/g, ~60x cheaper than gold — matches real ratios)
const GOLD_METAL_TYPE_ID = 106;
const SILVER_METAL_TYPE_ID = 107;

const METAL_RATES_QUERY = `
  SELECT metal_type_id, sales_rate, from_date, to_date
  FROM \`lucirajewelry-prod.Pos.metal_rates\`
  WHERE metal_type_id IN (${GOLD_METAL_TYPE_ID}, ${SILVER_METAL_TYPE_ID})
  ORDER BY from_date
`;

// Each rate row is valid from from_date through to_date inclusive (almost
// always the same single day; occasionally spans a weekend when the rate
// wasn't updated). Finds the rate valid on targetDate, falling back to the
// most recent earlier rate if targetDate falls in a gap (e.g. a date before
// this metal's rate history begins has no fallback and returns null).
function findRateForDate(rateRows, targetDate) {
  if (!targetDate) return null;
  let fallback = null;
  for (const r of rateRows) {
    if (r.fromDate <= targetDate && targetDate <= r.toDate) return r.rate;
    if (r.fromDate <= targetDate) fallback = r.rate;
  }
  return fallback;
}

const LINE_ITEMS_QUERY = `
  SELECT
    e.document_no,
    e.document_date,
    c.company_name AS store,
    p.party_name AS customer,
    p.mobile AS customer_mobile,
    p.phone AS customer_phone,
    emp.employee_name AS created_by,
    sp.employee_name AS sales_person,
    ei.sku,
    ei.lot_no,
    it.item_name,
    loc.location_name,
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
    e.transaction_id
  FROM \`lucirajewelry-prod.Lucira_Prod.exchange_items\` ei
  JOIN \`lucirajewelry-prod.Lucira_Prod.exchange\` e ON ei.transaction_id = e.transaction_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.company\` c ON e.company_id = c.company_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.party\` p ON e.party_id = p.party_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_administration_1.employee\` emp ON e.employee_id = emp.employee_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_administration_1.employee\` sp ON e.sales_person_id = sp.employee_id
  LEFT JOIN \`lucirajewelry-prod.ds_imputed_reporting.items\` it ON ei.item_id = it.item_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.location\` loc ON ei.location_id = loc.location_id
  WHERE REGEXP_CONTAINS(e.document_no, r'-URD-')
    AND e.document_status != 2 -- 2 = cancelled
  ORDER BY e.document_date, ei.item_line_no
`;

// branch_out_items/branch_out is the ERP's inter-branch stock-transfer ledger
// (not linked to exchange_items by any transaction key) — a store physically
// sends its collected URD gold/silver on. Matched on company_id (store) +
// net_weight + purity only — NOT on the destination party — so any
// branch-out event for that store/weight/purity counts as "moved on from
// the counter", including internal same-store reclassifications (e.g. a
// company_id == party_id row moving stock from a raw-material bucket to a
// finished-goods bucket), not just a leg that lands specifically on HO.
// company_code != 'HO' excludes HO's own outbound activity (irrelevant here
// — a purchase made directly at HO is marked N/A elsewhere, never Pending).
const BRANCH_OUT_TO_HO_QUERY = `
  SELECT
    e.company_code AS store_code,
    c.item_code,
    a.lot_no,
    a.net_weight,
    a.purity,
    b.document_no,
    b.document_date
  FROM \`lucirajewelry-prod.ornaverse_erp_inventory.branch_out_items\` a
  LEFT JOIN \`lucirajewelry-prod.Lucira_Prod.branch_out\` b ON a.transaction_id = b.transaction_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_administration.items\` c ON a.item_id = c.item_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.company\` e ON a.company_id = e.company_id
  WHERE c.item_code IN ('URD GOLD', 'URDSILVER')
    AND e.company_code != 'HO'
  ORDER BY b.document_date
`;

function normalizeItemLabel(name) {
  return (name || '').toUpperCase().replace(/\s+/g, '');
}

// There's no shared transaction key between a purchase (exchange_items) and
// its later transfer to HO (branch_out_items) — exchange_items.lot_no /
// branch_out_items.lot_no is the real link (same physical lot carries the
// same lot_no through both records; verified against known-matched pairs,
// and confirmed unique — no lot_no repeats across stores or within a store
// in this data). Grouped by store + lot_no rather than lot_no alone purely
// as defense-in-depth against a future collision, not because one exists
// today.
//
// A handful of rows have no lot_no at all (~1 in 250) — those fall back to
// the old heuristic: same store, metal, exact net weight AND purity,
// matched in chronological order (1st purchase pairs with 1st transfer,
// 2nd with 2nd, etc.) since net weight alone collides across different
// pieces often enough (e.g. four separate 1.000g purchases at one store)
// that a plain lookup would double-match.
function matchTransfersToHO(items, transfers) {
  const lotTransferGroups = new Map();
  const weightTransferGroups = new Map();
  transfers.forEach(t => {
    if (t.lotNo) {
      const lotKey = `${t.storeCode}|${t.lotNo}`;
      if (!lotTransferGroups.has(lotKey)) lotTransferGroups.set(lotKey, []);
      lotTransferGroups.get(lotKey).push(t);
    } else {
      const weightKey = `${t.storeCode}|${normalizeItemLabel(t.itemCode)}|${t.netWeightRaw.toFixed(3)}|${t.purityRaw.toFixed(4)}`;
      if (!weightTransferGroups.has(weightKey)) weightTransferGroups.set(weightKey, []);
      weightTransferGroups.get(weightKey).push(t);
    }
  });
  const byDate = (a, b) => (a.documentDate < b.documentDate ? -1 : 1);
  lotTransferGroups.forEach(list => list.sort(byDate));
  weightTransferGroups.forEach(list => list.sort(byDate));

  const applyMatch = (item, match) => {
    item.transferStatus = match ? 'Transferred' : 'Pending';
    item.transferDate = match ? match.documentDate : null;
    item.transferDocumentNo = match ? match.documentNo : null;
  };

  const weightItemGroups = new Map();
  items.forEach(item => {
    if (item.lotNo) {
      const lotKey = `${item.storeCode}|${item.lotNo}`;
      const candidates = lotTransferGroups.get(lotKey) || [];
      applyMatch(item, candidates[0]);
    } else {
      const weightKey = `${item.storeCode}|${normalizeItemLabel(item.itemName)}|${item.netWeightRaw.toFixed(3)}|${item.purity.toFixed(4)}`;
      if (!weightItemGroups.has(weightKey)) weightItemGroups.set(weightKey, []);
      weightItemGroups.get(weightKey).push(item);
    }
  });

  weightItemGroups.forEach((list, key) => {
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    const candidates = weightTransferGroups.get(key) || [];
    list.forEach((item, idx) => applyMatch(item, candidates[idx]));
  });
}

async function buildOldGoldDashboard() {
  const [[rows], [transferRows], [rateRows]] = await Promise.all([
    bigquery.query({ query: LINE_ITEMS_QUERY }),
    bigquery.query({ query: BRANCH_OUT_TO_HO_QUERY }),
    bigquery.query({ query: METAL_RATES_QUERY }),
  ]);

  const goldRates = [];
  const silverRates = [];
  rateRows.forEach(r => {
    const entry = {
      rate: toNumber(r.sales_rate),
      fromDate: bqVal(r.from_date) ? bqVal(r.from_date).slice(0, 10) : null,
      toDate: bqVal(r.to_date) ? bqVal(r.to_date).slice(0, 10) : null,
    };
    const metalTypeId = Number(r.metal_type_id);
    if (metalTypeId === GOLD_METAL_TYPE_ID) goldRates.push(entry);
    else if (metalTypeId === SILVER_METAL_TYPE_ID) silverRates.push(entry);
  });

  const items = rows.map(r => {
    const date = bqVal(r.document_date) ? bqVal(r.document_date).slice(0, 10) : null;
    const store = r.store || 'Unknown';
    return {
      documentNo: r.document_no,
      date,
      month: date ? date.slice(0, 7) : 'Unknown',
      store,
      storeCode: STORE_NAME_TO_CODE[store] || store,
      customer: r.customer,
      customerMobile: r.customer_mobile || r.customer_phone || null,
      createdBy: r.created_by,
      salesPerson: r.sales_person,
      sku: r.sku,
      lotNo: r.lot_no || null,
      itemName: r.item_name,
      location: r.location_name,
      grossWeight: round2(toNumber(r.weight)),
      netWeight: round2(toNumber(r.net_weight)),
      netWeightRaw: toNumber(r.net_weight),
      purity: toNumber(r.purity),
      pureWeight: round2(toNumber(r.pure_weight)),
      rate: round2(toNumber(r.item_rate)),
      metalAmount: round2(toNumber(r.metal_amount)),
      diamondAmount: round2(toNumber(r.diamond_amount)),
      stoneAmount: round2(toNumber(r.stone_amount)),
      otherAmount: round2(toNumber(r.other_amount)),
      netAmount: round2(toNumber(r.net_amount)),
      huid: r.huid,
    };
  });

  const transfers = transferRows.map(r => ({
    storeCode: r.store_code,
    itemCode: r.item_code,
    lotNo: r.lot_no || null,
    netWeightRaw: toNumber(r.net_weight),
    purityRaw: toNumber(r.purity),
    documentNo: r.document_no,
    documentDate: bqVal(r.document_date) ? bqVal(r.document_date).slice(0, 10) : null,
  }));
  matchTransfersToHO(items, transfers);
  // Purchases made directly at HO never generate a "store -> HO" transfer —
  // it's already there. Distinct from Pending, which means a store purchase
  // genuinely hasn't been sent on yet.
  items.filter(i => i.storeCode === 'HO').forEach(i => {
    i.transferStatus = 'N/A';
    i.transferDate = null;
    i.transferDocumentNo = null;
  });

  // Transferred: how long it actually sat before moving on. Pending: how
  // long it's been sitting so far (purchase date -> today). N/A: not
  // applicable, since an HO purchase was never waiting on a transfer.
  const today = todayISODate();
  items.forEach(i => {
    if (i.transferStatus === 'Transferred') {
      i.daysToTransfer = daysBetween(i.date, i.transferDate);
    } else if (i.transferStatus === 'Pending') {
      i.daysToTransfer = daysBetween(i.date, today);
    } else {
      i.daysToTransfer = null;
    }
  });

  // Received Amount = the market rate on the day this piece was bought,
  // scaled to its actual purity. Today Amount = the same formula using
  // today's rate instead — "if we valued this same piece at today's market
  // rate". Both use lucirajewelry-prod.Pos.metal_rates, refreshed daily
  // (updates automatically whenever this dashboard's cache/cron refreshes,
  // same as everything else here — no separate schedule needed). Silver
  // items use the silver rate table the same way; anything that's neither
  // Gold nor Silver has no reference rate and is left null (shown as "—").
  items.forEach(i => {
    const metal = metalTypeOfServer(i.itemName);
    const rateRows = metal === 'Gold' ? goldRates : metal === 'Silver' ? silverRates : null;
    const receivedRate = rateRows ? findRateForDate(rateRows, i.date) : null;
    const todayRate = rateRows ? findRateForDate(rateRows, today) : null;
    i.receivedRate = receivedRate != null ? round2(receivedRate) : null;
    i.todayRate = todayRate != null ? round2(todayRate) : null;
    i.receivedValue = receivedRate != null ? round2(receivedRate * i.netWeight * i.purity) : null;
    i.todayValue = todayRate != null ? round2(todayRate * i.netWeight * i.purity) : null;
    i.rateGainLoss = (i.receivedValue != null && i.todayValue != null) ? round2(i.todayValue - i.receivedValue) : null;
  });

  const transactionCount = new Set(items.map(i => i.documentNo)).size;
  const customerCount = new Set(items.map(i => i.customer).filter(Boolean)).size;
  const totalNetWeight = items.reduce((s, i) => s + i.netWeight, 0);
  const totalPureWeight = items.reduce((s, i) => s + i.pureWeight, 0);
  const totalAmount = items.reduce((s, i) => s + i.netAmount, 0);

  const kpis = {
    transactionCount,
    itemCount: items.length,
    customerCount,
    totalGrossWeight: round2(items.reduce((s, i) => s + i.grossWeight, 0)),
    totalNetWeight: round2(totalNetWeight),
    totalPureWeight: round2(totalPureWeight),
    totalAmount: round2(totalAmount),
    avgRatePerGram: totalPureWeight > 0 ? round2(totalAmount / totalPureWeight) : null,
    transferredToHOCount: items.filter(i => i.transferStatus === 'Transferred').length,
    pendingToHOCount: items.filter(i => i.transferStatus === 'Pending').length,
    totalReceivedValue: round2(items.reduce((s, i) => s + (i.receivedValue || 0), 0)),
    totalTodayValue: round2(items.reduce((s, i) => s + (i.todayValue || 0), 0)),
    totalRateGainLoss: round2(items.reduce((s, i) => s + (i.rateGainLoss || 0), 0)),
  };

  return {
    generatedAt: new Date().toISOString(),
    docTypeFilter: DOC_TYPE_FILTER,
    items,
    kpis,
    storeCodeToName: STORE_CODE_TO_NAME,
  };
}

// EXC/BYB items are finished jewelry pieces (real SKU, real product name —
// e.g. "Pallavi Diamond Bali Nosepin") traded in or bought back from a
// customer, not generic old gold. None of the URD-specific concepts apply:
// no Metal Type (gold/silver) classification, and no Transfer to HO (that
// tracking is keyed on item_code IN ('URD GOLD','URDSILVER'), which these
// rows never have).
const EXCHANGE_BUYBACK_QUERY = `
  SELECT
    e.document_no,
    e.document_date,
    c.company_name AS store,
    p.party_name AS customer,
    p.mobile AS customer_mobile,
    p.phone AS customer_phone,
    ei.sku,
    it.item_name,
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
    ei.huid
  FROM \`lucirajewelry-prod.Lucira_Prod.exchange_items\` ei
  JOIN \`lucirajewelry-prod.Lucira_Prod.exchange\` e ON ei.transaction_id = e.transaction_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.company\` c ON e.company_id = c.company_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.party\` p ON e.party_id = p.party_id
  LEFT JOIN \`lucirajewelry-prod.ds_imputed_reporting.items\` it ON ei.item_id = it.item_id
  WHERE REGEXP_CONTAINS(e.document_no, r'-(EXC|BYB)-')
    AND e.document_status != 2 -- 2 = cancelled
  ORDER BY e.document_date
`;

function transactionTypeOf(documentNo) {
  if (/-EXC-/.test(documentNo)) return 'Exchange';
  if (/-BYB-/.test(documentNo)) return 'Buy Back';
  return 'Unknown';
}

async function buildExchangeBuybackDashboard() {
  const [rows] = await bigquery.query({ query: EXCHANGE_BUYBACK_QUERY });

  const items = rows.map(r => {
    const date = bqVal(r.document_date) ? bqVal(r.document_date).slice(0, 10) : null;
    const store = r.store || 'Unknown';
    return {
      documentNo: r.document_no,
      type: transactionTypeOf(r.document_no),
      date,
      month: date ? date.slice(0, 7) : 'Unknown',
      store,
      storeCode: STORE_NAME_TO_CODE[store] || store,
      customer: r.customer,
      customerMobile: r.customer_mobile || r.customer_phone || null,
      sku: r.sku,
      itemName: r.item_name,
      grossWeight: round2(toNumber(r.weight)),
      netWeight: round2(toNumber(r.net_weight)),
      purity: toNumber(r.purity),
      pureWeight: round2(toNumber(r.pure_weight)),
      rate: round2(toNumber(r.item_rate)),
      metalAmount: round2(toNumber(r.metal_amount)),
      diamondAmount: round2(toNumber(r.diamond_amount)),
      stoneAmount: round2(toNumber(r.stone_amount)),
      otherAmount: round2(toNumber(r.other_amount)),
      netAmount: round2(toNumber(r.net_amount)),
      huid: r.huid,
    };
  });

  const transactionCount = new Set(items.map(i => i.documentNo)).size;
  const customerCount = new Set(items.map(i => i.customer).filter(Boolean)).size;
  const totalAmount = items.reduce((s, i) => s + i.netAmount, 0);

  const kpis = {
    transactionCount,
    itemCount: items.length,
    customerCount,
    totalGrossWeight: round2(items.reduce((s, i) => s + i.grossWeight, 0)),
    totalNetWeight: round2(items.reduce((s, i) => s + i.netWeight, 0)),
    totalPureWeight: round2(items.reduce((s, i) => s + i.pureWeight, 0)),
    totalAmount: round2(totalAmount),
  };

  return {
    generatedAt: new Date().toISOString(),
    items,
    kpis,
    storeCodeToName: STORE_CODE_TO_NAME,
  };
}

module.exports = { buildOldGoldDashboard, buildExchangeBuybackDashboard };
