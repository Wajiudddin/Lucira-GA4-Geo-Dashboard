// Filters + KPI/chart/table aggregation over the normalized dataset from
// storeMeetingAnalyticsService.buildDataset(). All dashboard numbers come from
// here so KPIs, charts and tables can never disagree.
const { RULES, MARKETS, DIRECT_DEAL_STORES } = require('./config/storeMeetingRules');
const { STORES } = require('./config/stores');
const { STORE_CITY_LABEL } = require('./meetingDashboardService');
const L = require('./lib/storeMeetingLogic');
const { productTables } = require('./storeMeetingProducts');

const STORE_MARKET_BY_KEY = Object.fromEntries(Object.entries(STORE_CITY_LABEL).map(([k, c]) => [k, c === 'Bengaluru' ? 'Bangalore' : c]));
const normMarket = c => (c === 'Bengaluru' ? 'Bangalore' : c);
const storeMarket = m => normMarket(STORE_CITY_LABEL[m.storeKey]) || m.market || null;
const inRange = (key, from, to) => !(from && (!key || key < from)) && !(to && (!key || key > to));
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const OPEN_STATUSES = ['Open', 'WIP', 'Not set'];

function csv(v) { return v ? String(v).split(',').filter(Boolean) : null; }
const has = (list, v) => !list || list.includes(v);

function filterAll(ds, q) {
  const f = {
    market: csv(q.market), store: csv(q.store), agent: csv(q.agent), category: csv(q.category),
    meetingStatus: csv(q.meetingStatus), visit: csv(q.visit), conversion: csv(q.conversion),
  };
  const deals = ds.deals.filter(d =>
    inRange(d.createdDateKey, q.dealFrom, q.dealTo) && has(f.agent, d.agent) && has(f.category, d.category)
    && (!f.market || (d.market && f.market.includes(d.market)))
    && (!f.store || (d.storeKey ? f.store.includes(d.storeKey) : !!d.market && f.store.some(k => !DIRECT_DEAL_STORES.includes(k) && STORE_MARKET_BY_KEY[k] === d.market))));

  const baseMeeting = m =>
    has(f.store, m.storeKey) && has(f.agent, m.agent) && has(f.meetingStatus, m.meetingStatus)
    && has(f.visit, m.visitStatus) && has(f.conversion, m.conversionStatus) && has(f.category, m.dealCategory)
    && (!f.market || f.market.includes(storeMarket(m)));
  // Date-independent set: used for "Scheduled This Week", which is always the current week.
  const meetingsNoDate = ds.meetings.filter(baseMeeting);
  const meetings = meetingsNoDate.filter(m =>
    inRange(m.raisedDateKey, q.raisedFrom, q.raisedTo) && inRange(m.fromDateKey, q.scheduledFrom, q.scheduledTo));

  const ids = new Set(meetings.map(m => m.id));
  // Follow-up calls never depend on a date filter: every call between a meeting's raised time and its scheduled
  // scheduled date counts, for each meeting in view.
  const calls = ds.calls.filter(c => c.meetingId && ids.has(c.meetingId));
  return { deals, meetings, meetingsNoDate, calls };
}

function summarize(meetings, calls, deals, weekB, nowMs) {
  const shows = meetings.filter(m => m.visitStatus === 'show');
  const showCustomers = new Set(shows.map(m => m.customerKey));
  const convertedCustomers = new Set(shows.filter(m => m.conversionStatus === 'converted').map(m => m.customerKey));
  const orderDocs = new Set();
  shows.forEach(m => { if (m.conversionStatus === 'converted' && m.order) orderDocs.add(m.order.documentNo); });
  const meetingCalls = new Map();
  calls.forEach(c => { if (c.inWindow) meetingCalls.set(c.meetingId, (meetingCalls.get(c.meetingId) || 0) + 1); });
  const fu = calls.filter(c => c.inWindow);
  const dealCat = { store_city: 0, non_city: 0, unknown: 0 };
  deals.forEach(d => { dealCat[d.category] += 1; });
  const todayKey = L.istDateKeyFromMs(nowMs);
  const schedTill = meetings.filter(m => m.fromDateKey && m.fromDateKey <= todayKey);   // raised meetings whose scheduled date has come (today or earlier)
  const week = meetings.filter(m => m.fromMs != null && m.fromMs >= weekB.startMs && m.fromMs < weekB.endMs);
  return {
    totalDeals: deals.length, storeCityDeals: dealCat.store_city, nonCityDeals: dealCat.non_city, unknownDeals: dealCat.unknown,
    // Unmapped = a store-city deal that could not be given a store (for example Delhi with no zone)
    unmappedDeals: deals.filter(d => d.category === 'store_city' && !d.storeKey).length,
    meetingsRaised: meetings.length,
    scheduledTillDate: schedTill.length,
    showMeetings: shows.length, showCustomers: showCustomers.size,
    convertedCustomers: convertedCustomers.size,
    // Orders are only countable where the sale was matched in marketing_sale;
    // CRM-flagged conversions carry no order document.
    convertedOrders: orderDocs.size, convertedWithoutOrderDoc: shows.filter(m => m.conversionStatus === 'converted' && !m.order).length,
    scheduledThisWeek: week.length,
    followUpCalls: fu.length,
    // Calls dialed AFTER each meeting's scheduled date had ended (separate from follow-up calls; never overlaps)
    afterCalls: meetings.reduce((s, m) => s + (m.followUp.after || 0), 0),
    meetingsWithFollowUp: meetings.filter(m => meetingCalls.get(m.id) > 0).length,
    meetingsZeroFollowUp: meetings.filter(m => !meetingCalls.get(m.id)).length,
    avgFollowUpPerMeeting: meetings.length ? Math.round((fu.length / meetings.length) * 100) / 100 : null,
    showRate: pct(shows.length, schedTill.length),
    conversionRate: pct(convertedCustomers.size, showCustomers.size),
  };
}

function groupRows(keyFn, labelFn, meetings, calls, dealsByKey, weekB, nowMs) {
  const groups = new Map();
  meetings.forEach(m => { const k = keyFn(m); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); });
  const callsByMeeting = new Map();
  calls.forEach(c => { if (!callsByMeeting.has(c.meetingId)) callsByMeeting.set(c.meetingId, []); callsByMeeting.get(c.meetingId).push(c); });
  return [...groups.entries()].map(([k, ms]) => {
    const cs = ms.flatMap(m => callsByMeeting.get(m.id) || []);
    const base = summarize(ms, cs, (dealsByKey && dealsByKey.get(k)) || [], weekB, nowMs);
    return { key: k, label: labelFn(k, ms), ...base };
  }).sort((a, b) => b.meetingsRaised - a.meetingsRaised);
}

function aggregate(ds, q = {}) {
  const nowMs = Date.now();
  const weekB = L.istWeekBounds(nowMs);
  const { deals, meetings, meetingsNoDate, calls } = filterAll(ds, q);

  const kpis = summarize(meetings, calls, deals, weekB, nowMs);
  // Scheduled-this-week ignores the date filters (always the current IST week).
  const weekMeetings = meetingsNoDate.filter(m => m.fromMs != null && m.fromMs >= weekB.startMs && m.fromMs < weekB.endMs);
  kpis.scheduledThisWeek = weekMeetings.length;
  // Scheduled / Shows / Converted / Show Rate / Conversion Rate cards are based on the meetings SCHEDULED (From date)
  // inside the page's selected Date range (periodFrom/periodTo: Today, Yesterday, Last Week, Last Month or Custom).
  // With no date selected they cover every scheduled meeting. The Meeting Funnel chart and the store/agent tables
  // stay on meetings raised in the selected range.
  const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const pFrom = isDay(q.periodFrom) ? q.periodFrom : '', pTo = isDay(q.periodTo) ? q.periodTo : (isDay(q.periodFrom) ? q.periodFrom : '');
  const schedMeetings = meetingsNoDate.filter(m => m.fromDateKey && inRange(m.fromDateKey, pFrom, pTo));
  // Show / Converted cards: counted on the day the customer VISITED / BOUGHT, whatever the scheduled date was
  // (e.g. scheduled 11th, customer came on the 18th -> the Show and the Conversion are added on the 18th).
  const visitDay = m => m.visitDateKey || m.fromDateKey;
  const convDay = m => m.convertedDateKey || visitDay(m);   // the day Conversion was set to Converted in Zoho; the order is only for revenue
  const sShows = meetingsNoDate.filter(m => m.visitStatus === 'show' && inRange(visitDay(m), pFrom, pTo));
  const sShowCustomers = new Set(sShows.map(m => m.customerKey));
  const sConvMeetings = meetingsNoDate.filter(m => m.visitStatus === 'show' && m.conversionStatus === 'converted' && inRange(convDay(m), pFrom, pTo));
  const sConverted = new Set(sConvMeetings.map(m => m.customerKey));
  const sOrders = new Set();
  sConvMeetings.forEach(m => { if (m.order) sOrders.add(m.order.documentNo); });
  const sUpcoming = schedMeetings.filter(m => m.fromMs != null && m.fromMs >= nowMs).length;
  // Follow-up Calls card: calls dialed between each SCHEDULED meeting's raised time and the end of its scheduled date (no date filter on calls).
  const schedIds = new Set(schedMeetings.map(m => m.id));
  const schedFollowCalls = ds.calls.filter(c => c.meetingId && schedIds.has(c.meetingId));
  const schedAfterCalls = (ds.afterCalls || []).filter(c => c.meetingId && schedIds.has(c.meetingId));
  const schedCalls = [...schedFollowCalls, ...schedAfterCalls];                 // both kinds, each marked with c.kind
  const sCalled = schedMeetings.filter(m => m.followUp.total + (m.followUp.after || 0) > 0).length;
  // Total Calls Done / Total Talk Time: EVERY outbound call dialed (any customer, any deal) in the selected Date period.
  const aList = csv(q.agent);
  const dayOf = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
  const periodCalls = (ds.allCalls || []).filter(c => inRange(dayOf(c.tsMs), pFrom, pTo) && (!aList || aList.includes(c.agent)));
  kpis.allCalls = {
    count: periodCalls.length, seconds: periodCalls.reduce((s, c) => s + c.dur, 0), connected: periodCalls.filter(c => c.dur >= 30).length,
  };
  kpis.sched = {
    from: pFrom || null, to: pTo || null,
    meetings: schedMeetings.length, upcoming: sUpcoming, passed: schedMeetings.length - sUpcoming,
    followUpCalls: schedCalls.length, followUpOnly: schedFollowCalls.length, afterOnly: schedAfterCalls.length,
    meetingsWithFollowUp: sCalled, meetingsZeroFollowUp: schedMeetings.length - sCalled,
    showMeetings: sShows.length, showCustomers: sShowCustomers.size,
    convertedCustomers: sConverted.size, convertedOrders: sOrders.size,
    showRate: pct(sShows.length, schedMeetings.length), conversionRate: pct(sConverted.size, sShowCustomers.size),
    convertedMeetings: sConvMeetings.length,
  };

  // Deals have no store in Zoho; they're attributed to a city MARKET. Store rows show their market's
  // deals (shared by every store in that market), flagged so nobody sums them.
  const dealsByMarket = new Map();
  deals.forEach(d => { const k = d.market || '__none'; if (!dealsByMarket.has(k)) dealsByMarket.set(k, []); dealsByMarket.get(k).push(d); });
  const dealsByAgent = new Map();
  deals.forEach(d => { if (!dealsByAgent.has(d.agent)) dealsByAgent.set(d.agent, []); dealsByAgent.get(d.agent).push(d); });

  const storeRows = groupRows(m => m.storeKey, (k, ms) => ms[0].store, meetings, calls, null, weekB, nowMs).map(r => {
    const market = storeMarket(meetings.find(m => m.storeKey === r.key));
    const direct = DIRECT_DEAL_STORES.includes(r.key);
    // Direct stores own their deals; Borivali/Chembur share Mumbai's unassigned deals.
    const md = direct ? deals.filter(d => d.storeKey === r.key) : [];
    const c = { store_city: 0, non_city: 0, unknown: 0 };
    md.forEach(d => { c[d.category] += 1; });
    return { ...r, market, totalDeals: md.length, storeCityDeals: c.store_city, nonCityDeals: c.non_city, unknownDeals: c.unknown, dealsAreMarketLevel: false,
      scheduledThisWeek: weekMeetings.filter(m => m.storeKey === r.key).length };
  });

  const weekByAgent = new Map();
  weekMeetings.forEach(m => weekByAgent.set(m.agent, (weekByAgent.get(m.agent) || 0) + 1));
  const agentRows = groupRows(m => m.agent, k => k, meetings, calls, dealsByAgent, weekB, nowMs).map(r => {
    const stores = {};
    meetings.filter(m => m.agent === r.key).forEach(m => { stores[m.store] = (stores[m.store] || 0) + 1; });
    const store = Object.entries(stores).sort((a, b) => b[1] - a[1])[0];
    return { ...r, store: store ? store[0] : null, scheduledThisWeek: weekByAgent.get(r.key) || 0 };
  });
  // Agents with deals but no meetings in range still belong in the table.
  dealsByAgent.forEach((ds2, a) => {
    if (!agentRows.some(r => r.key === a)) agentRows.push({ key: a, label: a, store: null, ...summarize([], [], ds2, weekB, nowMs), scheduledThisWeek: 0 });
  });

  const storeAgentRows = groupRows(m => `${m.storeKey}||${m.agent}`, (k, ms) => `${ms[0].store} · ${ms[0].agent}`, meetings, calls, null, weekB, nowMs)
    .map(r => ({ ...r, store: r.label.split(' · ')[0], agent: r.label.split(' · ')[1],
      scheduledThisWeek: weekMeetings.filter(m => `${m.storeKey}||${m.agent}` === r.key).length }));

  // Scheduled-week details
  const days = [];
  for (let i = 0; i < 7; i++) {
    const key = L.addDaysKey(weekB.startKey, i);
    days.push({ date: key, count: weekMeetings.filter(m => m.fromDateKey === key).length });
  }
  // Table under the weekly chart: per day, meetings and UNIQUE deals scheduled (a deal can have several meetings),
  // plus the store split. It has its OWN date range (weekFrom/weekTo, on the meeting From date) that defaults to the
  // current Mon–Sun week; the other filters (store, agent, ...) still apply, the page-level Date filter does not.
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  let wFrom = isDate(q.weekFrom) ? q.weekFrom : weekB.startKey;
  let wTo = isDate(q.weekTo) ? q.weekTo : (isDate(q.weekFrom) ? q.weekFrom : weekB.endKey);
  if (wFrom > wTo) [wFrom, wTo] = [wTo, wFrom];
  const tableDays = [];
  for (let d = wFrom; d <= wTo && tableDays.length < 370; d = L.addDaysKey(d, 1)) tableDays.push(d);
  const tblMeetings = meetingsNoDate.filter(m => m.fromDateKey && m.fromDateKey >= wFrom && m.fromDateKey <= wTo);
  const weekStores = [...new Set(tblMeetings.map(m => m.store))].filter(s => s !== 'Head Office').sort();
  const dealKey = m => m.dealId || `meeting:${m.id}`;
  const weekTable = {
    from: wFrom, to: wTo, isCurrentWeek: wFrom === weekB.startKey && wTo === weekB.endKey,
    stores: weekStores,
    rows: tableDays.map(date => {
      const ms = tblMeetings.filter(m => m.fromDateKey === date);
      const byStore = {};
      ms.forEach(m => { byStore[m.store] = (byStore[m.store] || 0) + 1; });
      return { date, meetings: ms.length, deals: new Set(ms.map(dealKey)).size, byStore };
    }),
  };
  const totalByStore = {};
  tblMeetings.forEach(m => { totalByStore[m.store] = (totalByStore[m.store] || 0) + 1; });
  weekTable.total = { meetings: tblMeetings.length, deals: new Set(tblMeetings.map(dealKey)).size, byStore: totalByStore };
  // Store-wise and agent-wise schedule for the same meetings (scheduled date inside the table's own period).
  const schedStats = (list) => {
    const shows = list.filter(m => m.visitStatus === 'show');
    const called = list.filter(m => m.followUp.total + (m.followUp.after || 0) > 0).length;
    return {
      meetings: list.length,
      upcoming: list.filter(m => m.fromMs != null && m.fromMs >= nowMs).length,
      shows: shows.length,
      converted: new Set(shows.filter(m => m.conversionStatus === 'converted').map(m => m.customerKey)).size,
      followUp: list.reduce((s, m) => s + m.followUp.total, 0),
      after: list.reduce((s, m) => s + (m.followUp.after || 0), 0),
      notCalled: list.length - called,
    };
  };
  const schedGroups = (keyFn, labelFn) => {
    const groups = new Map();
    tblMeetings.forEach(m => { const k = keyFn(m); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); });
    return [...groups.entries()].map(([key, list]) => ({ key, label: labelFn(list[0]), ...schedStats(list) }))
      .sort((x, y) => y.meetings - x.meetings || String(x.label).localeCompare(String(y.label)));
  };
  weekTable.storeRows = schedGroups(m => m.storeKey, m => m.store);
  weekTable.agentRows = schedGroups(m => m.agent, m => m.agent);
  weekTable.totals = schedStats(tblMeetings);
  const upcoming = weekMeetings.filter(m => m.fromMs >= nowMs).length;
  const pastDue = weekMeetings.filter(m => m.fromMs < nowMs && m.visitStatus !== 'show' && OPEN_STATUSES.includes(m.meetingStatus)).length;

  const callerAgg = new Map();
  calls.filter(c => c.inWindow).forEach(c => callerAgg.set(c.agent, (callerAgg.get(c.agent) || 0) + 1));

  const charts = {
    dealCategory: [
      { key: 'store_city', label: 'Store City', value: kpis.storeCityDeals },
      { key: 'non_city', label: 'Non-City', value: kpis.nonCityDeals },
      { key: 'unknown', label: 'Unknown / Unmapped', value: kpis.unknownDeals },
    ],
    byStore: storeRows.map(r => ({ key: r.key, label: r.label, raised: r.meetingsRaised, show: r.showMeetings, converted: r.convertedCustomers })),
    byAgent: agentRows.filter(r => r.meetingsRaised).slice(0, 15).map(r => ({ key: r.key, label: r.label, raised: r.meetingsRaised, show: r.showMeetings, converted: r.convertedCustomers })),
    scheduledByDay: days,
    followUpByAgent: [...callerAgg.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 15),
    funnel: [
      { label: 'Meetings Raised', value: kpis.meetingsRaised },
      { label: 'Shows', value: kpis.showMeetings },
      { label: 'Converted', value: kpis.convertedCustomers },
    ],
  };

  const dealDrill = q.dealPage != null || q.dealCategoryDrill;
  const mapMeeting = m => ({
      id: m.id, customer: m.customer, customerKey: m.customerKey, mobile: m.mobile || null, dealId: m.dealId, agent: m.agent, store: m.store, storeKey: m.storeKey,
      raisedMs: m.raisedMs, fromMs: m.fromMs, meetingStatus: m.meetingStatus, title: m.title, meetingType: m.meetingType,
      visitStatus: m.visitStatus, visitSource: m.visitSource, visitMs: m.visitTsMs, visitPrecision: m.visitPrecision,
      conversionStatus: m.conversionStatus, conversionSource: m.conversionSource,
      order: m.order ? { documentNo: m.order.documentNo, amount: m.order.amount, date: m.order.dateKey } : null,
      followUp: m.followUp, dealCategory: m.dealCategory,
  });
  // Full details of every meeting in the Deals Scheduled table's own scheduled-date range (the same meetings its counts come from).
  weekTable.meetings = tblMeetings.map(mapMeeting);
  // Product tables for the meetings scheduled in the same period as the Scheduled Meetings section.
  const productView = productTables(ds.products, tblMeetings, new Map(ds.deals.map(d => [d.id, d])));
  if (productView) productView.period = { from: wFrom, to: wTo };
  const out = {
    generatedAt: ds.generatedAt,
    week: { startKey: weekB.startKey, endKey: weekB.endKey, upcoming, pastDue, total: weekMeetings.length },
    productView, productsError: ds.productsError || null,
    weekTable, kpis, charts, storeRows, agentRows, storeAgentRows,
    meetings: meetings.map(mapMeeting),
    weekMeetings: weekMeetings.map(mapMeeting),
    schedMeetings: schedMeetings.map(mapMeeting),
    visitedMeetings: sShows.map(mapMeeting),
    convertedMeetings: sConvMeetings.map(mapMeeting),
    calls: calls.filter(c => c.inWindow),
    schedCalls,
    filterOptions: {
      markets: MARKETS,
      stores: [...new Set(ds.meetings.map(m => m.storeKey))].map(k => ({ key: k, label: (ds.meetings.find(m => m.storeKey === k) || {}).store })),
      agents: [...new Set([...ds.meetings.map(m => m.agent), ...ds.deals.map(d => d.agent)])].sort((a, b) => a.localeCompare(b)),
      categories: [{ key: 'store_city', label: 'Store City' }, { key: 'non_city', label: 'Non-City' }, { key: 'unknown', label: 'Unknown' }],
      meetingStatuses: [...new Set(ds.meetings.map(m => m.meetingStatus))],
      visits: ['show', 'no_show', 'upcoming', 'pending', 'unverifiable'],
      conversions: ['converted', 'not_converted', 'n/a'],
    },
    meta: ds.meta,
    rules: { showSource: RULES.showSource, conversionSource: RULES.conversionSource, showRate: RULES.showRate, conversionRate: RULES.conversionRate, weekStartsOn: RULES.weekStartsOn, timezone: RULES.timezone },
  };
  if (dealDrill) {
    const cat = q.dealCategoryDrill;
    const dStore = csv(q.dealStore), dAgent = csv(q.dealAgent);   // extra filters from inside the pop-up
    const rows = deals.filter(d => (!cat || (cat === 'unknown_unmapped' ? (d.category === 'unknown' || (d.category === 'store_city' && !d.storeKey)) : d.category === cat))
      && (!dStore || dStore.includes(d.storeKey || '__none')) && (!dAgent || dAgent.includes(d.agent)));
    const page = Math.max(0, Number(q.dealPage) || 0);
    const size = Math.min(Math.max(Number(q.dealSize) || 100, 1), 100000);   // dealSize is only raised for CSV export
    // Search ignores upper / lower case and extra spaces, and looks in every column of the list.
    const needle = String(q.dealSearch || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const callStatus = d => (!d.callsDialed ? 'not called' : d.connectedCalls ? 'connected' : 'called, not connected');
    const hay = d => `${d.name || ''} ${d.mobile || ''} ${d.cityRaw || ''} ${d.stateRaw || ''} ${d.agent || ''} ${d.id} ${d.createdDateKey || ''} ${d.category || ''} ${String(d.category || '').replace('_', ' ')} ${callStatus(d)}`.toLowerCase().replace(/\s+/g, ' ');
    // A clicked breakdown tile narrows the list to that group of deals (the breakdown itself keeps counting all deals).
    const GROUPS = {
      meeting: d => d.meetingsRaised > 0, online: d => d.onlineOrders > 0, called: d => d.callsDialed > 0,
      connected: d => d.connectedCalls > 0, notcalled: d => !d.callsDialed, storeorder: d => d.storeOrders > 0 && !d.meetingsRaised,
    };
    const grp = GROUPS[q.dealGroup];
    const inGroup = grp ? rows.filter(grp) : rows;
    const matched = needle ? inGroup.filter(d => hay(d).includes(needle)) : inGroup;
    const bd = {
      total: rows.length,
      meetingRaised: rows.filter(d => d.meetingsRaised > 0).length,
      meetingsCount: rows.reduce((s, d) => s + (d.meetingsRaised || 0), 0),
      onlineOrder: rows.filter(d => d.onlineOrders > 0).length,
      callDialed: rows.filter(d => d.callsDialed > 0).length,
      connected: rows.filter(d => d.connectedCalls > 0).length,
      notCalled: rows.filter(d => !d.callsDialed).length,
      storeOrderNoMeeting: rows.filter(d => d.storeOrders > 0 && !d.meetingsRaised).length,
    };
    out.dealDrill = { total: matched.length, page, size, breakdown: bd, rows: matched.slice(page * size, page * size + size) };
  }
  if (q.weekOnly) return { generatedAt: out.generatedAt, weekTable: out.weekTable, productView: out.productView };
  if (q.dealsOnly && out.dealDrill) return { generatedAt: out.generatedAt, dealDrill: out.dealDrill };
  return out;
}

module.exports = { aggregate, filterAll };
