require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');
const { fetchRecordsSince } = require('./zohoClient');
const { normalizeMobile, istDateKey } = require('./dailyReportService');
const { STORES } = require('./config/stores');

// Same auth pattern as every other BigQuery-backed service in this repo.
const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

function bqVal(v) {
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}

// BigQuery TIMESTAMP values arrive as ISO strings (or Date-parsable values);
// this shifts to IST and returns the calendar-day key, same convention as
// istDateKeyFromRaw in storePerformanceService.js.
function istDateKeyFromRaw(raw) {
  const s = bqVal(raw);
  if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) return null;
  const shifted = new Date(t + 5.5 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function istDayStartMs(dateKey) {
  return new Date(`${dateKey}T00:00:00+05:30`).getTime();
}

// --- Store matching --------------------------------------------------------
// Neither cdc_meetings (owner_name / free-text Venue) nor walkin_data
// (store_name, a messy ERP field with many spellings per store) carry a
// clean store key, so both are matched by keyword against the same city/
// store-name fragments — verified directly against every distinct value
// each source actually contains (see the BigQuery samples this was built
// from). Anything that matches no keyword (an individual agent's own name,
// a blank walkin store_name, "Divinecarat Lifestyles Private Limited" with
// no store suffix, etc.) is left unmapped rather than guessed at.
const STORE_KEYWORDS = {
  borivali: ['borivali', 'boriwali'],
  chembur: ['chembur', 'chmebur', 'chembure'],
  pune: ['pune'],
  paschimVihar: ['paschim', 'pashcim', 'pashchim', 'pachim'],
  lajpatNagar: ['lajpat', 'lagpat'],
  noida: ['noida'],
  malleshwaram: ['malleshwaram', 'malleswaram', 'bengaluru', 'bangalore'],
};

function matchStoreKeyword(text) {
  const t = (text || '').toLowerCase();
  for (const [key, keywords] of Object.entries(STORE_KEYWORDS)) {
    if (keywords.some(k => t.includes(k))) return key;
  }
  return null;
}

function matchMeetingStore(ownerName, venue) {
  return matchStoreKeyword(ownerName) || matchStoreKeyword(venue) || null;
}

// walkin_data.store_name uses the legal-entity name (not a city/store word)
// for Chembur specifically ("HWI VENTURES", verified) — every other store's
// variants all contain a keyword from STORE_KEYWORDS already.
function matchWalkinStore(storeName) {
  const t = (storeName || '').trim().toLowerCase();
  if (t === 'hwi ventures') return 'chembur';
  return matchStoreKeyword(storeName);
}

const STORE_CITY_LABEL = {
  borivali: 'Mumbai', chembur: 'Mumbai', pune: 'Pune',
  paschimVihar: 'Delhi', lajpatNagar: 'Delhi', noida: 'Noida', malleshwaram: 'Bengaluru',
};

// Deals has no store field at all (Store_Assigned is 0% populated — verified
// directly), but Address_City is populated on a real, if minority, share of
// rows — grouped into the same 5 city buckets the store keywords roll up
// into, so the City filter behaves consistently across the Deals and
// Meetings sections. Delhi is matched by "contains delhi" because Zoho's
// Address_City for Delhi deals comes back as NCT sub-districts ("South West
// Delhi", "Central Delhi", ...), not a single "Delhi" value (same finding
// documented in storePerformanceService.js's dealCityGroup).
function cityGroupFromAddress(addressCity) {
  if (!addressCity) return null;
  const c = addressCity.trim().toLowerCase();
  if (c === 'mumbai') return 'Mumbai';
  if (c === 'pune') return 'Pune';
  if (c === 'noida') return 'Noida';
  if (c === 'bengaluru' || c === 'bangalore') return 'Bengaluru';
  if (c.includes('delhi')) return 'Delhi';
  return null;
}

// --- Query builders ---------------------------------------------------------

// Deals comes from the LIVE Zoho CRM API, not the lucira_zoho_Deals BigQuery
// export — verified directly that export's sync lags badly (MAX(Creat_time)
// sat at 8+ days behind "today" when checked), which silently zeroed out
// every "yesterday"-scoped KPI. This is the same live-vs-BigQuery tradeoff
// storePerformanceService.js already made for Deals and Calls, for the same
// reason (see its ZOHO_DEAL_FIELDS comment). Unbounded (no stopBeforeISO) so
// a meeting's linked deal can be found regardless of how old it is — same
// pattern as getAllTasksAndCalls in server.js.
const ZOHO_DEAL_FIELDS = ['id', 'Owner', 'Mobile', 'Stage', 'Created_Time', 'Address_City', 'Amount'];

async function fetchAllDeals() {
  return fetchRecordsSince('Deals', ZOHO_DEAL_FIELDS, { sortField: 'Created_Time' });
}

// data is a JSON blob synced from Zoho's Meeting activity, parsed in JS below
// (not with BigQuery's JSON_VALUE) so nested Participants array fields are
// reachable — JSON_VALUE on this STRING column only supports scalar paths.
const MEETINGS_QUERY = `
  SELECT id, owner_name, created_time, data
  FROM \`lucirajewelry-prod.zoho_crm.cdc_meetings\`
`;

// Only what's needed to know "was an outbound call ever logged against this
// deal" — what_id is the same Zoho Deal id a meeting's What_Id.id points to
// (verified: both are populated from the same Zoho "What_Id"/"$se_module"
// activity-linking field), so this becomes a simple Set membership check
// per meeting, not a full row-by-row fetch of the 70k-row Calls table.
//
// This BigQuery export is stale by the same ~8+ days verified on Deals
// (MAX(Created_Time) sat 8 days behind "today" when checked) — pulling the
// entire history live instead (70k+ rows, ~350+ pages) would be far slower
// than Deals' already-slow live pull, so instead this covers older history
// and CALLS_LIVE_LOOKBACK_DAYS below tops it up with just the recent window,
// fetched live, where the export's lag actually bites.
const CALLED_DEAL_IDS_QUERY = `
  SELECT DISTINCT what_id
  FROM \`lucirajewelry-prod.Lucira_Prod.lucira_zoho_Calls\`
  WHERE what_id IS NOT NULL AND Call_Type = 'Outbound'
`;

const CALLS_LIVE_LOOKBACK_DAYS = 30;
const ZOHO_CALL_FIELDS = ['What_Id', 'Call_Type', 'Created_Time'];

async function fetchRecentCalledDealIdsLive() {
  const stopBeforeISO = new Date(Date.now() - CALLS_LIVE_LOOKBACK_DAYS * 86400000).toISOString();
  const calls = await fetchRecordsSince('Calls', ZOHO_CALL_FIELDS, { sortField: 'Created_Time', stopBeforeISO });
  const ids = new Set();
  calls.forEach(c => {
    if (c.Call_Type === 'Outbound' && c.What_Id && c.What_Id.id) ids.add(c.What_Id.id);
  });
  return ids;
}

const WALKINS_QUERY = `
  SELECT phone, event_time, store_name
  FROM \`lucirajewelry-prod.store_customer.walkin_data\`
  WHERE phone IS NOT NULL
`;

// "Order" = an actual completed in-store sale (Channel = 'Store', same
// filter storePerformanceService.js's ordersQuery uses), matched to a
// meeting by the same customer mobile used for the walk-in match — not the
// linked Zoho Deal's Stage, which can say "Closed Won" without a real sale
// (or vice versa). One row per document_no (a sale can have many line
// items); Cus_mobile/mobile1 are identical on every sampled row, so either
// works as the customer identifier.
const ORDERS_QUERY = `
  SELECT
    document_no,
    ANY_VALUE(Cus_mobile) AS mobile,
    MIN(Transaction_Date) AS txn_date,
    SUM(net_sale) AS amount
  FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
  WHERE Channel = 'Store'
  GROUP BY document_no
`;

async function buildMeetingDashboard() {
  const [dealRows, [meetingRowsRaw], [calledDealIdRows], [walkinRows], recentCalledDealIdsLive, [orderRows]] = await Promise.all([
    fetchAllDeals(),
    bigquery.query({ query: MEETINGS_QUERY }),
    bigquery.query({ query: CALLED_DEAL_IDS_QUERY }),
    bigquery.query({ query: WALKINS_QUERY }),
    fetchRecentCalledDealIdsLive(),
    bigquery.query({ query: ORDERS_QUERY }),
  ]);

  const todayKey = istDateKey(new Date());

  // --- Deals: keyed by id (for the meeting -> deal link) and reduced to a
  // light per-deal row (for the Total Deals / Total City Deals KPIs). ------
  const dealById = new Map();
  const deals = [];
  let dealsWithCity = 0;
  for (const d of dealRows) {
    const cityRaw = (d.Address_City || '').toString().trim() || null;
    const cityGroup = cityGroupFromAddress(cityRaw);
    if (cityRaw) dealsWithCity += 1;
    // Created_Time from the live API is an ISO string already carrying the
    // +05:30 offset (same convention used throughout this app, e.g.
    // storePerformanceService.js's call handling), so the first 10 chars are
    // the IST calendar date directly.
    const dateKey = d.Created_Time ? d.Created_Time.slice(0, 10) : null;
    dealById.set(d.id, { mobile: normalizeMobile(d.Mobile) });
    deals.push({
      dateKey,
      agent: (d.Owner && d.Owner.name) || 'Unassigned',
      cityRaw,
      cityGroup,
    });
  }

  const calledDealIds = new Set([
    ...calledDealIdRows.map(r => r.what_id),
    ...recentCalledDealIdsLive,
  ]);

  // mobile -> sorted array of { ts, storeKey } walk-in events for that number.
  const walkinIndex = new Map();
  for (const w of walkinRows) {
    const mobile = normalizeMobile(w.phone);
    const ts = new Date(bqVal(w.event_time)).getTime();
    if (!mobile || Number.isNaN(ts)) continue;
    if (!walkinIndex.has(mobile)) walkinIndex.set(mobile, []);
    walkinIndex.get(mobile).push({ ts, storeKey: matchWalkinStore(w.store_name) });
  }
  walkinIndex.forEach(list => list.sort((a, b) => a.ts - b.ts));

  // mobile -> sorted array of { dateKey, amount } completed in-store sales.
  // Transaction_Date is a plain DATE (no time-of-day, and already the IST
  // calendar day the sale happened on — same convention ordersQuery in
  // storePerformanceService.js relies on), so this compares date-key
  // strings directly rather than converting to a timestamp.
  const ordersByMobile = new Map();
  for (const o of orderRows) {
    const mobile = normalizeMobile(o.mobile);
    const dateKey = bqVal(o.txn_date);
    if (!mobile || !dateKey) continue;
    if (!ordersByMobile.has(mobile)) ordersByMobile.set(mobile, []);
    ordersByMobile.get(mobile).push({ dateKey, amount: Number(o.amount) || 0 });
  }
  ordersByMobile.forEach(list => list.sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0)));

  // --- Meetings: one row per Meeting activity, enriched with its matched
  // store, its linked deal (mobile/stage, via What_Id.id), whether a walk-in
  // followed, whether the store called, and whether it closed as an order. -
  let meetingsWithDealLink = 0;
  const meetings = meetingRowsRaw.map(m => {
    let data = {};
    try { data = JSON.parse(m.data || '{}'); } catch { data = {}; }

    const dealId = (data.What_Id && data.What_Id.id) || null;
    const deal = dealId ? dealById.get(dealId) : null;
    if (dealId && deal) meetingsWithDealLink += 1;

    const storeKey = matchMeetingStore(m.owner_name, data.Venue);
    // owner_name is the CRM-record owner, which for a huge share of meetings
    // is a shared store/team inbox account ("Borivali Team", "Noida Store",
    // ...) rather than the person who actually worked the meeting — verified
    // directly: whenever owner_name is a team account, Created_By.name
    // reliably holds the real individual (and matches owner_name exactly
    // when owner_name already was an individual). owner_name is still the
    // right signal for storeKey above; Created_By is the right one for Agent.
    const agentName = (data.Created_By && data.Created_By.name) || m.owner_name || 'Unassigned';
    const startRaw = data.Start_DateTime || null;
    // Two distinct dates: raisedDateKey is when the agent logged the meeting
    // (created_time) — this is what "Meetings Raised" and the Date filter
    // mean, and what most meetings actually vary on. visitDateKey is the
    // separate scheduled-visit date (Start_DateTime), used only for the
    // Upcoming/Today/Visited status classification and the walk-in cutoff
    // below, and for "Today's Meetings" / "Meetings Fixed Today" specifically
    // (falls back to raisedDateKey when a meeting has no Start_DateTime).
    const raisedDateKey = istDateKeyFromRaw(m.created_time);
    const visitDateKey = startRaw ? istDateKeyFromRaw(startRaw) : raisedDateKey;

    const mobile = deal ? deal.mobile : null;
    const walkinEvents = mobile ? (walkinIndex.get(mobile) || []) : [];
    const orderEvents = mobile ? (ordersByMobile.get(mobile) || []) : [];
    const dayStartMs = visitDateKey ? istDayStartMs(visitDateKey) : -Infinity;
    // "Visited" requires a walk-in on/after the meeting's own calendar day —
    // an earlier, unrelated walk-in by the same customer doesn't confirm
    // THIS meeting (same rule verifiedMeetingService.js uses).
    const matchedWalkin = walkinEvents.find(e => e.ts >= dayStartMs) || null;
    // "Order" is a real completed in-store sale (marketing_sale) by this same
    // customer on/after the meeting's visit day — not the linked deal's CRM
    // Stage, which can drift from what actually happened at the till.
    const matchedOrder = orderEvents.find(e => e.dateKey >= visitDateKey) || null;

    let status;
    if (visitDateKey && visitDateKey > todayKey) status = 'upcoming';
    else if (matchedWalkin) status = 'visited';
    else if (visitDateKey === todayKey) status = 'today';
    else status = 'not_visited';

    const contactParticipant = (data.Participants || []).find(p => p.type === 'contact');
    const customerName = (contactParticipant && contactParticipant.name)
      || (data.Who_Id && data.Who_Id.name) || null;

    return {
      id: m.id,
      agent: agentName,
      storeKey: storeKey || 'unmapped',
      city: storeKey ? STORE_CITY_LABEL[storeKey] : 'Unknown',
      dateKey: raisedDateKey,
      visitDateKey,
      dateTimeIso: startRaw || bqVal(m.created_time) || null,
      customerName,
      hasDealLink: !!(dealId && deal),
      // No deal link means the mobile/stage this depends on is unknown —
      // counted as "not called" / "no order" rather than left ambiguous,
      // and disclosed via meta.meetingsWithDealLinkPct below.
      calledByStore: !!(dealId && calledDealIds.has(dealId)),
      status,
      walkinDateKey: matchedWalkin ? istDateKeyFromRaw(new Date(matchedWalkin.ts).toISOString()) : null,
      orderWon: !!matchedOrder,
      orderAmount: matchedOrder ? matchedOrder.amount : 0,
      orderDateKey: matchedOrder ? matchedOrder.dateKey : null,
    };
  });

  const meetingsFixedToday = meetings.filter(m => m.visitDateKey === todayKey).length;

  const storeOptions = STORES.map(s => ({ key: s.key, label: s.displayName }))
    .concat([{ key: 'unmapped', label: 'Unmapped / Other' }]);

  const agentSet = new Set();
  meetings.forEach(m => agentSet.add(m.agent));
  deals.forEach(d => agentSet.add(d.agent));
  const agents = [...agentSet].sort((a, b) => a.localeCompare(b));

  const cities = ['Mumbai', 'Delhi', 'Pune', 'Noida', 'Bengaluru', 'Unknown'];
  const statuses = [
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'today', label: 'Today' },
    { key: 'visited', label: 'Visited (Walk-in Confirmed)' },
    { key: 'not_visited', label: 'Not Visited' },
  ];

  const meetingsWithDealLinkPct = meetings.length ? Math.round((meetingsWithDealLink / meetings.length) * 1000) / 10 : 0;
  const dealsWithCityPct = deals.length ? Math.round((dealsWithCity / deals.length) * 1000) / 10 : 0;

  return {
    generatedAt: new Date().toISOString(),
    today: todayKey,
    stores: storeOptions,
    agents,
    cities,
    statuses,
    meetings,
    deals,
    meta: {
      totalMeetings: meetings.length,
      meetingsWithDealLink,
      meetingsWithDealLinkPct,
      totalDeals: deals.length,
      dealsWithCity,
      dealsWithCityPct,
      meetingsFixedToday,
      dataNotes: [
        `Deals is pulled live from the Zoho CRM API, not the lucira_zoho_Deals BigQuery export — that export was found to lag by over a week (its newest row is more than 7 days behind "today" as of this writing), which silently zeroed out "yesterday"-scoped numbers. This mirrors the same live-vs-BigQuery choice already made for Deals/Calls elsewhere in this app.`,
        `A meeting's customer (and therefore its walk-in / order match) is resolved through the Zoho Deal it's linked to — ${meetingsWithDealLinkPct}% of meetings (${meetingsWithDealLink} of ${meetings.length}) have that link. The rest are conservatively counted as Not Visited, Not Called by Store, and No Order.`,
        `"Called by Store" means at least one outbound call is logged in Zoho (lucira_zoho_Calls, topped up with the live Zoho API for the last ${CALLS_LIVE_LOOKBACK_DAYS} days since that BigQuery export also lags by over a week) against the same deal as the meeting — not necessarily a call about that specific meeting.`,
        `"Order" means the same customer (by mobile) has a completed in-store sale in marketing_sale (Channel = 'Store') on or after the meeting's visit date — a real recorded sale, not the linked deal's CRM Stage.`,
        `A store is identified from the meeting owner/venue text or the walk-in's store name by keyword match — meetings logged under an individual agent's own name (not a store account) can't be attributed to a store and appear under "Unmapped / Other".`,
        `Agent is the meeting's Created By, not its Owner — Owner is very often a shared store/team account (e.g. "Borivali Team"), not the person who actually worked it, so it's used for Store attribution only, never shown as Agent.`,
        `Address_City is populated on only ${dealsWithCityPct}% of deals (${dealsWithCity} of ${deals.length}) — Total City Deals and the city breakdown only cover deals with a known city; Store_Assigned is 0% populated and isn't used.`,
      ],
    },
  };
}

module.exports = { buildMeetingDashboard };
