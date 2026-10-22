require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');
const { fetchRecordsSince } = require('./zohoClient');
const { normalizeMobile } = require('./dailyReportService');
const { STORES } = require('./config/stores');
const { RULES, MARKETS, classifyCity, STORE_NAME_TO_KEY, MUMBAI_SPLIT_STORES } = require('./config/storeMeetingRules');
const {
  matchMeetingStore,
} = require('./meetingDashboardService');
const L = require('./lib/storeMeetingLogic');
const { loadProductData } = require('./storeMeetingProducts');

const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({ projectId: 'lucirajewelry-prod', credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

let MARK_DATES = {};
try { MARK_DATES = require('./config/meetingMarkDates.json'); } catch (e) { MARK_DATES = {}; }
const bqVal = v => (v && typeof v === 'object' && 'value' in v ? v.value : v);

const DEAL_FIELDS = ['id', 'Owner', 'Deal_Name', 'Mobile', 'Stage', 'Created_Time', 'Address_City', 'Address_State', 'Contact_Name', 'Email', 'Probability_Score',
  'Latest_Product_Code', 'Latest_Product_Name', 'Latest_Product_Category', 'Latest_Product_Price'];
const EVENT_FIELDS = [
  'id', 'Event_Title', 'Start_DateTime', 'End_DateTime', 'Created_Time', 'Owner', 'Created_By', 'Who_Id', 'What_Id',
  'Venue', 'Meeting_Status', 'Show_Status', 'Conversion_Status', 'Show_Date', 'Store_Name', 'Connection_Status',
  'Meeting_Type', 'Mobile_Number', 'Modified_Time',
];
const CALL_FIELDS = [
  'id', 'Owner', 'Subject', 'Call_Type', 'Who_Id', 'What_Id', 'Call_Start_Time', 'Created_Time',
  'Call_Duration_in_seconds', 'Call_Result', 'Outgoing_Call_Status',
];

// Store visits: ds_imputed_reporting.Walkin_marge. walkin_date is an IST 'YYYY-MM-DD HH:MM:SS' string
// (date-only entries show as 05:30). store_code 'Amazon' is marketplace returns under one dummy phone
// number, not a customer visit, so it is left out.
const WALKINS_QUERY = `
  SELECT phone, walkin_date, store_code
  FROM \`lucirajewelry-prod.ds_imputed_reporting.Walkin_marge\`
  WHERE phone IS NOT NULL AND TRIM(phone) != '' AND (store_code IS NULL OR store_code != 'Amazon')`;

// One row per sale document; documents netting to <= 0 are dropped (no
// cancel/status column exists in marketing_sale — see dataNotes).
const ORDERS_QUERY = `
  SELECT document_no, ANY_VALUE(Cus_mobile) AS mobile, MIN(Transaction_Date) AS txn_date, SUM(net_sale) AS amount
  FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
  WHERE Channel = 'Store'
  GROUP BY document_no HAVING SUM(net_sale) > 0`;

// Calls: BigQuery Lucira_Prod.lucira_zoho_Calls is the main source. It is rebuilt every night from Zoho and now carries
// the call id, the contact (who_id / who_name), the number dialed and the deal (what_id), so a call can be matched to
// a meeting's customer by contact, number or deal. Call_Start_Time / Created_Time are IST strings ('YYYY-MM-DD HH:MM:SS').
const callsQuerySince = (istStr) => `
  SELECT call_id, what_id, who_id, who_name, dialled_number, Call_Start_Time, Created_Time,
         Call_Duration_in_seconds, Call_Status, Call_Result, Created_By_name, Deal_Owner
  FROM \`lucirajewelry-prod.Lucira_Prod.lucira_zoho_Calls\`
  WHERE Call_Type = 'Outbound' AND Created_Time >= '${istStr}'`;
// Deal bifurcation (Store City Deals pop-up): ALL store and online sales (customer mobile + name) and every outbound call
// dialed on a deal. Used only to describe the deals; they do not change any other number.
const DEAL_ORDERS_QUERY = `
  SELECT document_no, ANY_VALUE(Channel) AS channel, ANY_VALUE(Cus_mobile) AS mobile, ANY_VALUE(mobile1) AS mobile1,
         ANY_VALUE(email) AS email, ANY_VALUE(email_id) AS email_id, ANY_VALUE(party_name) AS party_name, MIN(Transaction_Date) AS txn_date, SUM(net_sale) AS amount
  FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
  WHERE Channel IN ('Store', 'Online')
  GROUP BY document_no HAVING SUM(net_sale) > 0`;
const dealCallsQuery = `
  SELECT call_id, what_id, who_id, who_name, dialled_number, Call_Start_Time, Created_Time, Call_Duration_in_seconds, Created_By_name, Deal_Owner
  FROM \`lucirajewelry-prod.Lucira_Prod.lucira_zoho_Calls\`
  WHERE Call_Type = 'Outbound'`;
const CALLS_MAX_QUERY = `SELECT MAX(Created_Time) AS max_created FROM \`lucirajewelry-prod.Lucira_Prod.lucira_zoho_Calls\``;
const istString = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

function istStringToMs(str) {
  if (!str) return null;
  const t = new Date(String(str).trim().replace(' ', 'T') + '+05:30').getTime();
  return Number.isNaN(t) ? null : t;
}

const storeLabel = key => {
  const s = STORES.find(x => x.key === key);
  if (s) return s.displayName;
  return key === 'headOffice' ? 'Head Office' : 'Unmapped / Other';
};

function toMs(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? null : t;
}

// zoho_crm.cdc_meetings is the CDC sync of the same Zoho Events records; `data`
// holds the Events payload under the same API field names.
const CDC_MEETINGS_QUERY = `
  SELECT id, created_time, data FROM \`lucirajewelry-prod.zoho_crm.cdc_meetings\``;

// Live Zoho Events needs the ZohoCRM.modules.events.READ scope on the refresh
// token. The token currently configured lacks it (OAUTH_SCOPE_MISMATCH), so
// fall back to the CDC table and say so in meta.meetingsSource.
async function fetchEvents() {
  try {
    const rows = await fetchRecordsSince('Events', EVENT_FIELDS, { sortField: 'Created_Time' });
    return { rows, source: 'zoho_api' };
  } catch (err) {
    if (!/OAUTH_SCOPE_MISMATCH|invalid oauth scope/i.test(err.message)) throw err;
    const [raw] = await bigquery.query({ query: CDC_MEETINGS_QUERY });
    const rows = raw.map(r => {
      let data = {};
      try { data = JSON.parse(r.data || '{}'); } catch { data = {}; }
      return { ...data, id: r.id, Created_Time: data.Created_Time || bqVal(r.created_time) };
    });
    return { rows, source: 'bigquery_cdc', scopeError: err.message };
  }
}

async function buildDataset() {
  const nowMs = Date.now();
  const [dealRaw, events, [walkinRows], [orderRows]] = await Promise.all([
    fetchRecordsSince('Deals', DEAL_FIELDS, { sortField: 'Created_Time' }),
    fetchEvents(),
    bigquery.query({ query: WALKINS_QUERY }),
    bigquery.query({ query: ORDERS_QUERY }),
  ]);
  const eventRaw = events.rows;

  // ---- Deals (unique by id) --------------------------------------------
  const dealById = new Map();
  for (const d of dealRaw) {
    if (dealById.has(d.id)) continue;
    const c = classifyCity(d.Address_City, d.Address_State);
    dealById.set(d.id, {
      id: d.id,
      name: d.Deal_Name || null,
      agent: (d.Owner && d.Owner.name) || 'Unassigned',
      mobile: normalizeMobile(d.Mobile),
      contactId: (d.Contact_Name && d.Contact_Name.id) || null,
      email: String(d.Email || '').trim().toLowerCase() || null,
      // the product the customer last looked at on the website: used only when the deal has no product of its own
      latestProduct: (d.Latest_Product_Code || d.Latest_Product_Name) ? { code: String(d.Latest_Product_Code || '').trim().toUpperCase(), name: String(d.Latest_Product_Name || '').trim(), category: d.Latest_Product_Category || null, price: Number(d.Latest_Product_Price) || null } : null,
      probability: d.Probability_Score != null && d.Probability_Score !== '' && !Number.isNaN(Number(d.Probability_Score)) ? Number(d.Probability_Score) : null,
      stage: d.Stage || null,
      createdDateKey: d.Created_Time ? d.Created_Time.slice(0, 10) : null,
      createdMs: d.Created_Time ? (new Date(d.Created_Time).getTime() || null) : null,
      cityRaw: (d.Address_City || '').toString().trim() || null,
      stateRaw: (d.Address_State || '').toString().trim() || null,
      category: c.category, market: c.market, storeKey: c.storeKey, cityReason: c.reason,
    });
  }

  // Mumbai deals: split 50/50 between Borivali and Chembur. Sorted by id and
  // alternated, so the split is exact (differs by at most 1) and stable between refreshes.
  [...dealById.values()].filter(d => d.market === 'Mumbai' && !d.storeKey)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    .forEach((d, i) => { d.storeKey = MUMBAI_SPLIT_STORES[i % 2]; });

  // ---- Walk-ins / orders indexed by mobile -----------------------------
  const walkinIdx = new Map();
  for (const w of walkinRows) {
    const m = normalizeMobile(w.phone);
    const ts = istStringToMs(w.walkin_date);
    if (!m || ts == null) continue;
    if (!walkinIdx.has(m)) walkinIdx.set(m, []);
    walkinIdx.get(m).push({ ts, storeCode: w.store_code || null });
  }
  walkinIdx.forEach(l => l.sort((a, b) => a.ts - b.ts));
  const orderIdx = new Map();
  for (const o of orderRows) {
    const m = normalizeMobile(o.mobile);
    const dateKey = bqVal(o.txn_date);
    if (!m || !dateKey) continue;
    if (!orderIdx.has(m)) orderIdx.set(m, []);
    orderIdx.get(m).push({ documentNo: o.document_no, dateKey, amount: Number(o.amount) || 0 });
  }
  orderIdx.forEach(l => l.sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1)));

  // ---- Meetings (unique by id) -----------------------------------------
  const seenEvents = new Set();
  const meetings = [];
  for (const e of eventRaw) {
    if (seenEvents.has(e.id)) continue;
    seenEvents.add(e.id);
    const raisedMs = toMs(e.Created_Time);
    // "From" in the Zoho UI is the Events Start_DateTime field.
    const fromMs = toMs(e.Start_DateTime);
    const dealId = (e.What_Id && e.What_Id.id) || null;
    const deal = dealId ? dealById.get(dealId) : null;
    const mobile = normalizeMobile(e.Mobile_Number) || (deal && deal.mobile) || null;
    const contactId = (e.Who_Id && e.Who_Id.id) || null;

    const raisedDateKey = raisedMs != null ? L.istDateKeyFromMs(raisedMs) : null;
    const fromDateKey = fromMs != null ? L.istDateKeyFromMs(fromMs) : raisedDateKey;

    // Show and Converted are counted on the day the agent set each status in Zoho (Zoho field history, saved in
    // config/meetingMarkDates.json). A meeting not in that file falls back to its last modified day.
    const modKey = e.Modified_Time ? String(e.Modified_Time).slice(0, 10) : null;
    const mark = MARK_DATES[e.id] || {};
    const istKey = iso => (iso ? String(iso).slice(0, 10) : null);
    // The meeting copy in BigQuery can be behind Zoho. A meeting in the saved Zoho list uses the Show / Conversion Status read live from Zoho.
    const showStatus = mark.showStatus || e.Show_Status;
    const conversionStatus = mark.showStatus ? mark.conversionStatus : e.Conversion_Status;
    const showDate = showStatus === 'Show' ? (istKey(mark.show) || modKey) : null;
    const convertedDateKey = conversionStatus === 'Converted' ? (istKey(mark.converted) || modKey) : null;
    const visit = L.decideVisit({
      showStatus, showDate, visitDateKey: fromDateKey,
      mobile, walkinEvents: mobile && e.Meeting_Type !== 'Video Call' ? walkinIdx.get(mobile) : [], nowMs,   // a Video Call is not a store visit: only a Zoho Show mark makes it a Show
    });
    const visitDateKey = visit.visitTsMs != null ? L.istDateKeyFromMs(visit.visitTsMs) : null;
    const conv = L.decideConversion({
      conversionStatus, visit,
      visitDateKey: visitDateKey || fromDateKey,
      orderEvents: mobile ? orderIdx.get(mobile) : [],
    });

    // Revenue only (Converted itself comes from Zoho): the customer's store sale (by mobile), net_sale from marketing_sale. The customer
    // often buys BEFORE the agent marks the meeting Converted, so: the latest store sale on or before the Converted day (up to 60 days
    // earlier); if there is none, the first store sale after it.
    if (conv.status === 'converted' && !conv.order && mobile) {
      const day = convertedDateKey || visitDateKey || fromDateKey;
      const sales = orderIdx.get(mobile) || [];
      if (day) {
        const floor = L.addDaysKey(day, -60);
        const before = sales.filter(o => o.dateKey <= day && o.dateKey >= floor);
        conv.order = before.length ? before[before.length - 1] : (sales.find(o => o.dateKey > day) || null);
      }
    }

    const storeKey = (e.Store_Name && STORE_NAME_TO_KEY[e.Store_Name])
      || matchMeetingStore(e.Owner && e.Owner.name, e.Venue) || 'unmapped';

    meetings.push({
      id: e.id,
      title: e.Event_Title || null,
      meetingType: e.Meeting_Type || null,
      customer: (e.Who_Id && e.Who_Id.name) || (deal && deal.name) || null,
      mobile, dealId, contactId,
      // Agent = who actually raised it (Owner is often a shared store account).
      agent: (e.Created_By && e.Created_By.name) || (e.Owner && e.Owner.name) || 'Unassigned',
      owner: (e.Owner && e.Owner.name) || null,
      storeKey, store: storeLabel(storeKey),
      storeSource: e.Store_Name ? 'crm' : (storeKey === 'unmapped' ? null : 'owner/venue keyword'),
      market: deal ? deal.market : null,
      dealCategory: deal ? deal.category : 'unknown',
      meetingStatus: e.Meeting_Status || 'Not set',
      raisedMs, fromMs, raisedDateKey, fromDateKey,
      visitStatus: visit.status, visitSource: visit.source, visitPrecision: visit.precision,
      visitTsMs: visit.visitTsMs, visitDateKey, convertedDateKey,
      conversionStatus: conv.status, conversionSource: conv.source,
      order: conv.order,
      customerKey: mobile || contactId || dealId || `m${e.id}`,
      followUp: { total: 0, days: 0, after: 0, seconds: 0, afterSeconds: 0 },   // seconds = talk time of the follow-up calls, afterSeconds = of the calls after the scheduled date
    });
  }

  // ---- Calls ---------------------------------------------------------------
  // Main source: BigQuery lucira_zoho_Calls (outbound calls). A call is matched to a meeting in two steps: FIRST by mobile number
  // (the number on the call = the customer's mobile), THEN by every other way (same contact, same deal, the mobile of the call's
  // deal, a number inside the contact name) so that a call is never missed just because the dialed number differs.
  // The table is rebuilt overnight, so calls made after its latest call are topped up live from Zoho (small and
  // recent) so today's numbers stay correct. Duplicates are removed by call id.
  const earliestRaised = meetings.reduce((m, x) => (x.raisedMs != null && x.raisedMs < m ? x.raisedMs : m), nowMs);
  const sinceMs = earliestRaised - 86400000;
  // Two-step matching of calls to meetings: STEP 1 the MOBILE NUMBER; STEP 2 every other way (contact, deal, the mobile of
  // the call's deal, a number inside the contact name). See attributeCalls in lib/storeMeetingLogic.js.
  const meetingKeyList = m => (m.mobile ? [`m:${m.mobile}`] : []);
  const meetingKeyList2 = m => [m.contactId && `c:${m.contactId}`, m.dealId && `d:${m.dealId}`].filter(Boolean);
  const meetingKeys = new Set();
  meetings.forEach(m => [...meetingKeyList(m), ...meetingKeyList2(m)].forEach(k => meetingKeys.add(k)));
  // The number at the end of a call subject, with or without brackets. Calls logged without a contact or deal
  // ("Outgoing call to +919891851800") can only be matched through this number.
  const subjectNumber = subject => {
    const m = String(subject || '').match(/(\+?[0-9][0-9 ]{8,}[0-9])\)?\s*$/);
    return m ? m[1] : null;
  };
  const phoneKey = text => {
    const d = normalizeMobile(text);
    return d && d.length >= 10 ? `m:${d}` : null;
  };
  const callKeyList = (dealId, contactId, contactName, dialled) => {
    const own = phoneKey(dialled);                       // the number that was dialed (table column, or the end of the subject)
    const keys2 = [];
    const deal = dealId ? dealById.get(dealId) : null;
    if (deal && deal.mobile) keys2.push(`m:${deal.mobile}`);   // the mobile of the deal the call is logged on
    const nameNum = phoneKey(contactName);                    // contact names are often the phone number
    if (nameNum) keys2.push(nameNum);
    if (contactId) keys2.push(`c:${contactId}`);
    if (dealId) keys2.push(`d:${dealId}`);
    return { keys: own ? [own] : [], keys2: [...new Set(keys2)] };
  };
  const relevant = ck => [...ck.keys, ...ck.keys2].some(k => meetingKeys.has(k));

  // ---- Calls: the heavy BigQuery part is built ONCE; the live Zoho part is re-run every few seconds (ds.refreshLive) ----
  const bqCallObjs = [];            // BigQuery calls that belong to a meeting customer
  const seenBase = new Set();       // every BigQuery call id used above
  const [[bqCalls], [bqMaxRows]] = await Promise.all([
    bigquery.query({ query: callsQuerySince(istString(sinceMs)) }),
    bigquery.query({ query: CALLS_MAX_QUERY }),
  ]);
  const bqMaxMs = istStringToMs(bqMaxRows[0] && bqMaxRows[0].max_created) || 0;
  let bqAdded = 0;
  for (const r of bqCalls) {
    const ck = callKeyList(r.what_id, r.who_id, r.who_name, r.dialled_number);
    if (!relevant(ck)) continue;
    const tsMs = istStringToMs(r.Call_Start_Time) || istStringToMs(r.Created_Time);
    if (tsMs == null) continue;
    const id = r.call_id || `bq:${r.what_id}:${tsMs}`;
    if (seenBase.has(id)) continue;
    seenBase.add(id);
    bqCallObjs.push({
      id, dealId: r.what_id || null, keys: ck.keys, keys2: ck.keys2, tsMs,
      durationSec: Number(r.Call_Duration_in_seconds) || 0, result: r.Call_Result || null,
      status: r.Call_Status || null, agent: r.Created_By_name || r.Deal_Owner || 'Unassigned', source: 'bigquery',
    });
    bqAdded += 1;
  }
  // A live Zoho call (made after the table's latest call) as a meeting call, or null when it is not a meeting customer's call.
  const liveMeetingCall = c => {
    if (!RULES.followUpCallTypes.includes(c.Call_Type)) return null;
    if ((toMs(c.Created_Time) || 0) <= bqMaxMs) return null;          // already in the table
    const dealId = (c.What_Id && c.What_Id.id) || null;
    const contactId = (c.Who_Id && c.Who_Id.id) || null;
    const ck = callKeyList(dealId, contactId, c.Who_Id && c.Who_Id.name, subjectNumber(c.Subject));
    if (!relevant(ck)) return null;
    const tsMs = toMs(c.Call_Start_Time) || toMs(c.Created_Time);
    if (tsMs == null) return null;
    return {
      id: c.id, dealId, keys: ck.keys, keys2: ck.keys2, tsMs, durationSec: Number(c.Call_Duration_in_seconds) || 0,
      result: c.Call_Result || null, status: c.Outgoing_Call_Status || null,
      agent: (c.Owner && c.Owner.name) || 'Unassigned', source: 'zoho_live',
    };
  };

  // ---- Deal side: sales (store / online) and the BigQuery call index ----
  const dealList = [...dealById.values()];
  const [[dealOrderRows], [dealCallRows]] = await Promise.all([
    bigquery.query({ query: DEAL_ORDERS_QUERY }),
    bigquery.query({ query: dealCallsQuery }),
  ]);
  const salesByMobile = new Map(), salesByEmail = new Map();
  const emailOf = e => { const t = String(e || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null; };
  const addSale = (map, k, o) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(o); };
  for (const o of dealOrderRows) {
    const dateKey = bqVal(o.txn_date);
    if (!dateKey) continue;
    const sale = { documentNo: o.document_no, channel: o.channel, dateKey, amount: Number(o.amount) || 0 };
    new Set([normalizeMobile(o.mobile), normalizeMobile(o.mobile1)].filter(Boolean)).forEach(k => addSale(salesByMobile, k, sale));
    new Set([emailOf(o.email), emailOf(o.email_id)].filter(Boolean)).forEach(k => addSale(salesByEmail, k, sale));
  }
  // An index of EVERY outbound call (for the Total Calls Done / Total Talk Time cards and the deal breakdown).
  const makeCallIndex = () => ({ byDeal: new Map(), byNumber: new Map(), byContact: new Map(), all: [], seen: new Set() });
  const addTo = (map, k, c) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(c); };
  const pushIndexCall = (idx, id, whatId, dialled, tsMs, dur, whoId, whoName, agent) => {
    if (tsMs == null || idx.seen.has(id)) return;
    idx.seen.add(id);
    idx.all.push({ id, tsMs, dur: Number(dur) || 0, agent: agent || 'Unassigned' });
    const c = { id, tsMs, dur: Number(dur) || 0 };
    addTo(idx.byDeal, whatId, c);
    const num = normalizeMobile(dialled);
    if (num) addTo(idx.byNumber, num, c);
    // every other trace of the same customer in Zoho: a call logged on another deal with the same mobile, on the same contact,
    // or a contact name that is the phone number
    const otherDeal = whatId ? dealById.get(whatId) : null;
    if (otherDeal && otherDeal.mobile && otherDeal.mobile !== num) addTo(idx.byNumber, otherDeal.mobile, c);
    const nameNum = normalizeMobile(whoName);
    if (nameNum && nameNum !== num) addTo(idx.byNumber, nameNum, c);
    addTo(idx.byContact, whoId, c);
  };
  const baseIdx = makeCallIndex();
  dealCallRows.forEach(r => pushIndexCall(baseIdx, r.call_id, r.what_id, r.dialled_number, istStringToMs(r.Call_Start_Time) || istStringToMs(r.Created_Time), r.Call_Duration_in_seconds, r.who_id, r.who_name, r.Created_By_name || r.Deal_Owner));

  // Meetings of a deal: the meeting is linked to the deal, OR the meeting has the same mobile number as the deal
  // (a customer often has several deals / a meeting on another deal). Each meeting is counted once per deal.
  const meetingById = new Map(meetings.map(m => [m.id, m]));
  const meetingsByDeal = new Map(), meetingsByMobile = new Map();
  meetings.forEach(m => {
    if (m.dealId) { if (!meetingsByDeal.has(m.dealId)) meetingsByDeal.set(m.dealId, []); meetingsByDeal.get(m.dealId).push(m.id); }
    if (m.mobile) { if (!meetingsByMobile.has(m.mobile)) meetingsByMobile.set(m.mobile, []); meetingsByMobile.get(m.mobile).push(m.id); }
  });
  dealList.forEach(d => {
    const from = d.createdDateKey || '0000-00-00';
    const sales = new Map();                                // unique by document number
    // Orders are matched FIRST by the mobile number, and only when the mobile finds no sale, by the e-mail address.
    // Names are never used ("Amit Kumar" belongs to many different customers).
    let found = (d.mobile ? salesByMobile.get(d.mobile) || [] : []).filter(s => s.dateKey >= from);
    let matchedBy = found.length ? 'mobile' : null;
    if (!found.length && emailOf(d.email)) { found = (salesByEmail.get(emailOf(d.email)) || []).filter(s => s.dateKey >= from); if (found.length) matchedBy = 'email'; }
    found.forEach(s => sales.set(s.documentNo, s));
    d.orderMatchedBy = matchedBy;
    const online = [...sales.values()].filter(s => s.channel === 'Online');
    const store = [...sales.values()].filter(s => s.channel === 'Store');
    const ownMeetings = meetingsByDeal.get(d.id) || [];
    const mobileMeetings = (d.mobile ? meetingsByMobile.get(d.mobile) || [] : []).filter(id => !ownMeetings.includes(id));
    d.meetingsRaised = ownMeetings.length + mobileMeetings.length;
    // how the meeting was found: on the deal itself, or only through the same mobile number (meeting sits on another deal of the customer)
    d.meetingMatchedBy = ownMeetings.length ? 'deal' : mobileMeetings.length ? 'mobile' : null;
    d.meetingOtherDeals = ownMeetings.length ? [] : [...new Set(mobileMeetings.map(id => (meetingById.get(id) || {}).dealId).filter(Boolean))];
    d.onlineOrders = online.length; d.onlineRevenue = Math.round(online.reduce((s, x) => s + x.amount, 0));
    d.storeOrders = store.length; d.storeRevenue = Math.round(store.reduce((s, x) => s + x.amount, 0));
  });

  // ---- The call layer: everything that depends on calls. Re-run with the newest live Zoho calls. ----
  const CONNECTED_SEC = 30;
  const computeCallLayer = (live) => {
    // meeting calls = BigQuery calls + live calls
    const calls = [...bqCallObjs];
    const seenLive = new Set();
    let liveAdded = 0;
    live.forEach(c => {
      const o = liveMeetingCall(c);
      if (!o || seenBase.has(o.id) || seenLive.has(o.id)) return;
      seenLive.add(o.id); calls.push(o); liveAdded += 1;
    });
    meetings.forEach(m => { m.followUp = { total: 0, days: 0, after: 0, seconds: 0, afterSeconds: 0 }; });
    // A call counts for a meeting when it was made AFTER the exact time the meeting was raised and BEFORE THE END OF ITS SCHEDULED DATE
    // (one call is given to at most one meeting).
    const attributed = L.attributeCalls(
      meetings.map(m => ({ id: m.id, customerKeys: meetingKeyList(m), customerKeys2: meetingKeyList2(m), raisedMs: m.raisedMs || 0, fromMs: m.fromMs })),
      calls, Date.now(),
    );
    const callRows = attributed.map(({ call, meeting }) => {
      const m = meeting ? meetingById.get(meeting.id) : null;
      return {
        id: call.id, customer: m ? m.customer : null, meetingId: m ? m.id : null, dealId: call.dealId || (m && m.dealId) || null,
        agent: call.agent, store: m ? m.store : null, storeKey: m ? m.storeKey : null,
        tsMs: call.tsMs, result: call.result, status: call.status, durationSec: call.durationSec,
        source: call.source,
        kind: 'followup',
        inWindow: !!m,
        windowNote: m ? 'after meeting raised, up to the end of the scheduled date' : 'outside every raised → scheduled-day window',
      };
    });
    // Calls made AFTER the end of a meeting's scheduled date (e.g. the customer did not come that day), counted per meeting.
    const afterCalls = [];
    attributed.forEach(({ call, postMeeting }) => {
      if (!postMeeting) return;
      const m = meetingById.get(postMeeting.id);
      m.followUp.after += 1;
      m.followUp.afterSeconds += call.durationSec || 0;
      afterCalls.push({
        id: call.id, customer: m.customer, meetingId: m.id, dealId: call.dealId || m.dealId || null,
        agent: call.agent, store: m.store, storeKey: m.storeKey, tsMs: call.tsMs, durationSec: call.durationSec,
        source: call.source, kind: 'after', inWindow: true,
      });
    });
    callRows.forEach(c => {
      if (!c.meetingId) return;
      const fm = meetingById.get(c.meetingId);
      fm.followUp.total += 1;
      fm.followUp.seconds += c.durationSec || 0;
    });
    meetings.forEach(m => {
      m.followUp.called = m.followUp.total > 0;
      m.followUp.days = new Set(callRows.filter(c => c.meetingId === m.id).map(c => L.istDateKeyFromMs(c.tsMs))).size;
    });

    // deal side: every outbound call = BigQuery index + live calls
    const liveIdx = makeCallIndex();
    live.forEach(c => {
      if (!RULES.followUpCallTypes.includes(c.Call_Type)) return;
      if ((toMs(c.Created_Time) || 0) <= bqMaxMs) return;
      if (baseIdx.seen.has(c.id)) return;
      pushIndexCall(liveIdx, c.id, (c.What_Id && c.What_Id.id) || null, subjectNumber(c.Subject), toMs(c.Call_Start_Time) || toMs(c.Created_Time), c.Call_Duration_in_seconds, (c.Who_Id && c.Who_Id.id) || null, (c.Who_Id && c.Who_Id.name) || null, (c.Owner && c.Owner.name) || null);
    });
    const pick = (map, k) => (k ? [...(baseIdx[map].get(k) || []), ...(liveIdx[map].get(k) || [])] : []);
    dealList.forEach(d => {
      const dc = new Map();
      // ANY call log of this customer in Zoho counts, whenever it was made: by the mobile number first, then the deal, the contact,
      // or another deal / contact name carrying the same mobile.
      [...pick('byNumber', d.mobile), ...pick('byDeal', d.id), ...pick('byContact', d.contactId)].forEach(c => dc.set(c.id, c));
      const callList = [...dc.values()];
      d.callsDialed = callList.length;
      d.connectedCalls = callList.filter(c => c.dur >= CONNECTED_SEC).length;
    });
    return {
      callRows, afterCalls, allCalls: [...baseIdx.all, ...liveIdx.all],
      callsMeta: { source: 'bigquery', bigqueryRows: bqCalls.length, bigqueryMatched: bqAdded, bigqueryLastCallMs: bqMaxMs || null, liveTopUpRows: live.length, liveTopUpAdded: liveAdded },
    };
  };

  // Live Zoho calls: the first fetch reads every call since the table's latest call; later refreshes only read what is new.
  const liveById = new Map();
  let liveFetchedUpToMs = bqMaxMs;
  const fetchLiveCalls = async () => {
    if (!(RULES.callsLiveTopUp && bqMaxMs)) return [];
    const since = Math.max(bqMaxMs, liveFetchedUpToMs - 5 * 60000);       // small overlap so nothing is missed
    const fresh = await fetchRecordsSince('Calls', CALL_FIELDS, { sortField: 'Created_Time', stopBeforeISO: new Date(since).toISOString() });
    fresh.forEach(c => {
      liveById.set(c.id, c);
      const t = toMs(c.Created_Time) || 0;
      if (t > liveFetchedUpToMs) liveFetchedUpToMs = t;
    });
    return [...liveById.values()];
  };
  const layer = computeCallLayer(await fetchLiveCalls());
  const callRows = layer.callRows, afterCalls = layer.afterCalls, allCalls = layer.allCalls, callsMeta = layer.callsMeta;

  const deals = dealList;
  const withDeal = meetings.filter(m => m.dealId && dealById.has(m.dealId)).length;
  // Products of the deals (stock, attributes): loaded once per build; a failure here must not break the rest of the dashboard.
  let products = null, productsError = null;
  try { products = await loadProductData(bigquery); } catch (err) { productsError = err.message; console.error('product data failed:', err.message); }

  const dataset = {
    products, productsError,
    generatedAt: new Date(nowMs).toISOString(),
    deals, meetings, calls: callRows, afterCalls, allCalls,
    meta: {
      dealsFetched: deals.length, meetingsFetched: meetings.length, callsLinked: callRows.length,
      callsMeta,
      meetingsSource: events.source, meetingsScopeError: events.scopeError || null,
      meetingsWithDealLink: withDeal,
      meetingsWithDealLinkPct: meetings.length ? Math.round((withDeal / meetings.length) * 1000) / 10 : 0,
      dealsWithCityPct: deals.length ? Math.round((deals.filter(d => d.cityRaw).length / deals.length) * 1000) / 10 : 0,
    },
  };
  // Re-reads the newest Zoho calls and rebuilds everything that depends on calls (meeting follow-ups, Total Calls Done / Talk Time,
  // the deal call breakdown). Cheap: only calls created since the last refresh are fetched.
  dataset.liveAt = Date.now();
  dataset.refreshLive = async () => {
    const live = await fetchLiveCalls();
    const next = computeCallLayer(live);
    dataset.calls = next.callRows; dataset.afterCalls = next.afterCalls; dataset.allCalls = next.allCalls;
    dataset.meta.callsMeta = next.callsMeta; dataset.meta.callsLinked = next.callRows.length;
    dataset.liveAt = Date.now();
  };
  return dataset;
}

module.exports = { buildDataset, MARKETS, storeLabel };
