require('dotenv').config();
const express = require('express');
const basicAuth = require('express-basic-auth');
const cron = require('node-cron');
const path = require('path');
const { fetchRecordsSince, fetchRecordsByIds, getAccessToken } = require('./src/zohoClient');
const {
  isWhatsAppTriggered,
  groupByMobileAndDay,
  buildCallFirstIndex,
  buildDailyRows,
  buildProbabilityRows,
  buildAgentProbabilityPivot,
  buildAgentProbabilityRows,
  getRangeWindow,
  formatHHMMSS,
  istDateKey,
} = require('./src/dailyReportService');
const {
  buildDealsByMobile, buildContactMobileIndex, linkCallsToDealsByContact,
  buildDealsRows, buildDealStatusDump, buildDealCallStatusRows, buildCallsRows, buildCallStatsByDeal,
  buildClosedLostRows, buildTasksRows,
} = require('./src/agentPerformanceService');
const { buildRefillDashboard } = require('./src/refillService');
const { buildOldGoldDashboard, buildExchangeBuybackDashboard } = require('./src/oldGoldService');
const { buildSchemeDashboard } = require('./src/schemeService');
const { buildScanDashboard } = require('./src/scanService');
const { buildProductScanConversionDashboard } = require('./src/productScanConversionService');
const {
  fetchMeetingsFromSheet, fetchWalkinIndex, buildDealsByMobileForVerification, buildVerifiedMeetingRows,
} = require('./src/verifiedMeetingService');
const { chat: assistantChat } = require('./src/assistantService');
const { buildStorePerformanceDashboard } = require('./src/storePerformanceService');
const staffCountStore = require('./src/staffCountStore');
const { STORES: STORE_PERFORMANCE_STORES } = require('./src/config/stores');
const { buildMeetingDashboard } = require('./src/meetingDashboardService');

const app = express();
const PORT = process.env.PORT || 3000;

// Login is required whenever credentials are configured — always required
// once this server is reachable from outside this machine. Refuses to start
// without credentials rather than falling back to an insecure default, since
// the whole point is to gate access before this goes on a public URL.
if (process.env.DASHBOARD_USERNAME && process.env.DASHBOARD_PASSWORD) {
  app.use(basicAuth({
    users: { [process.env.DASHBOARD_USERNAME]: process.env.DASHBOARD_PASSWORD },
    challenge: true,
    realm: 'Lucira Dashboards',
  }));
} else {
  console.warn(
    'WARNING: DASHBOARD_USERNAME / DASHBOARD_PASSWORD not set in .env — running with NO login protection. ' +
    'Do not expose this server to the internet until both are set.'
  );
}

let salesAnalyticsCache = null;
let salesAnalyticsCacheTime = 0;
const SALES_ANALYTICS_CACHE_TTL_MS = 60 * 1000; // dashboard polls every 60s
let salesAnalyticsInflight = null;

app.get('/api/sales-analytics', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh && salesAnalyticsCache && Date.now() - salesAnalyticsCacheTime < SALES_ANALYTICS_CACHE_TTL_MS) {
      return res.json(salesAnalyticsCache);
    }
    // Share one BigQuery run between concurrent viewers.
    if (!salesAnalyticsInflight) salesAnalyticsInflight = require('./src/salesAnalyticsService').buildSalesAnalytics().finally(() => { salesAnalyticsInflight = null; });
    const data = await salesAnalyticsInflight;
    salesAnalyticsCache = data;
    salesAnalyticsCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


let adSpendCache = null, adSpendCacheTime = 0, adSpendInflight = null;
const AD_SPEND_CACHE_TTL_MS = 10 * 60 * 1000; // the Google/Meta table is large; spend only changes a few times a day
app.get('/api/ad-spend', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh && adSpendCache && Date.now() - adSpendCacheTime < AD_SPEND_CACHE_TTL_MS) return res.json(adSpendCache);
    if (!adSpendInflight) adSpendInflight = require('./src/adSpendService').buildAdSpend().finally(() => { adSpendInflight = null; });
    adSpendCache = await adSpendInflight; adSpendCacheTime = Date.now();
    res.json(adSpendCache);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const VALID_RANGES = ['daily', 'yesterday', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom'];
const VALID_DATE_FIELDS = ['Created_Time', 'Modified_Time'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const DEAL_FIELDS = [
  'id', 'Deal_Name', 'Amount', 'Probability_Score', 'Stage',
  'Deal_Trigger_Event', 'Owner', 'Mobile', 'Created_Time', 'Modified_Time',
];
const CALL_FIELDS = ['What_Id', 'Call_Start_Time', 'Call_Duration_in_seconds', 'Call_Type', 'Created_Time'];
const CALL_FIELDS_WITH_OWNER = [...CALL_FIELDS, 'Owner', 'Who_Id'];
const TASK_FIELDS = ['id', 'Owner', 'Status', 'What_Id', 'Created_Time', 'Modified_Time', 'Due_Date'];
const CONTACT_FIELDS = ['id', 'Phone', 'Mobile'];
const DUMP_LIMIT = 500;

// Earliest task per deal, keyed by the task's What_Id -> deal id, plus a
// running count of every task linked to that deal.
function buildTaskFirstIndex(tasks) {
  const index = new Map();
  for (const task of tasks) {
    const dealId = task.What_Id && task.What_Id.id;
    if (!dealId || !task.Created_Time) continue;
    const t = new Date(task.Created_Time).getTime();

    const existing = index.get(dealId);
    if (!existing) {
      index.set(dealId, { firstCreatedTime: task.Created_Time, time: t, count: 1 });
    } else {
      existing.count += 1;
      if (t < existing.time) {
        existing.time = t;
        existing.firstCreatedTime = task.Created_Time;
      }
    }
  }
  return index;
}

// Raw per-deal listing — always the full deduped set (ignores the qualifiedOnly
// toggle on purpose) so the underlying Zoho-mapped data can be audited directly.
// taskIndex/callStatsByDeal are optional — the /api/daily-report route doesn't
// fetch Tasks and doesn't need a per-deal call count, so it calls this without
// them and those columns come back null.
function buildDealsDump(deduped, callIndex, taskIndex = null, callStatsByDeal = null) {
  const sorted = [...deduped].sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time));
  const dump = sorted.slice(0, DUMP_LIMIT).map(d => {
    const prob = Number(d.Probability_Score);

    const idsToCheck = d._groupDealIds || [d.id];
    let firstCall = null;
    for (const id of idsToCheck) {
      const c = callIndex.get(id);
      if (c && (!firstCall || c.time < firstCall.time)) firstCall = c;
    }

    let callDiffSeconds = null;
    let callDiffFormatted = null;
    if (firstCall) {
      callDiffSeconds = (firstCall.time - new Date(d.Created_Time).getTime()) / 1000;
      callDiffFormatted = (callDiffSeconds < 0 ? '-' : '') + formatHHMMSS(Math.abs(callDiffSeconds));
    }

    const task = taskIndex ? taskIndex.get(d.id) : null;
    const callCount = callStatsByDeal
      ? idsToCheck.reduce((sum, id) => sum + (callStatsByDeal.get(id) ? callStatsByDeal.get(id).count : 0), 0)
      : null;

    return {
      id: d.id,
      dealName: d.Deal_Name || null,
      createdTime: d.Created_Time,
      modifiedTime: d.Modified_Time,
      stage: d.Stage || null,
      probability: Number.isNaN(prob) ? null : prob,
      qualified: !Number.isNaN(prob) && prob >= 70,
      amount: Number(d.Amount) || 0,
      mobile: d.Mobile || null,
      owner: (d.Owner && d.Owner.name) || null,
      triggerEvent: d.Deal_Trigger_Event || null,
      whatsApp: isWhatsAppTriggered(d),
      firstCallTime: firstCall ? firstCall.startTime : null,
      callType: firstCall ? firstCall.callType || null : null,
      callDurationSeconds: firstCall ? firstCall.durationSeconds || 0 : null,
      callConnected: firstCall ? (firstCall.durationSeconds || 0) >= 30 : null,
      callDiffFormatted,
      callCount,
      taskCreatedTime: task ? task.firstCreatedTime : null,
      taskCount: task ? task.count : 0,
    };
  });
  return { dump, total: sorted.length, truncated: sorted.length > DUMP_LIMIT };
}

let rawCache = new Map();
let metaCache = null;

async function getRawForRange(dateField, startISO, forceRefresh) {
  const key = `${dateField}|${startISO}`;
  if (!forceRefresh && rawCache.has(key)) return rawCache.get(key);

  const deals = await fetchRecordsSince('Deals', DEAL_FIELDS, { sortField: dateField, stopBeforeISO: startISO });

  const callStopBeforeISO = new Date(new Date(startISO).getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const calls = await fetchRecordsSince('Calls', CALL_FIELDS, { sortField: 'Created_Time', stopBeforeISO: callStopBeforeISO });

  const result = { deals, calls, fetchedAt: Date.now() };
  rawCache.set(key, result);
  return result;
}

async function getMeta(forceRefresh) {
  if (!forceRefresh && metaCache) return metaCache;
  const token = await getAccessToken();
  const domain = process.env.ZOHO_DOMAIN || 'zoho.com';
  const tld = domain.replace(/^zoho\./, '');
  const res = await fetch(`https://www.zohoapis.${tld}/crm/v2/settings/fields?module=Deals`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  const stageField = data.fields.find(f => f.api_name === 'Stage');

  // Owner has no fixed picklist — derive the agent list from who actually owns recent deals.
  const recentDeals = await fetchRecordsSince('Deals', ['Owner'], { sortField: 'Created_Time', maxPages: 15 });
  const agents = Array.from(new Set(
    recentDeals.map(d => d.Owner && d.Owner.name).filter(Boolean)
  )).filter(name => name !== 'Lucira Tech').sort();

  metaCache = {
    stages: (stageField ? stageField.pick_list_values : []).map(v => v.display_value).filter(v => v !== '-None-'),
    agents,
  };
  return metaCache;
}

let agentPerfRawCache = new Map();
let allTasksCallsCache = null;

// Due/Overdue task counts are all-time by design (not scoped to the selected
// date range), so they need the FULL task/call/deal-stage history — unbounded,
// no stopBeforeISO — independent of whatever range/dateField the page is
// viewing. Deal ids+Stage only (not the full deal record) so this stays light —
// matches Zoho's own Overdue Tasks report, which excludes tasks on closed deals.
async function getAllTasksAndCalls(forceRefresh) {
  if (!forceRefresh && allTasksCallsCache) return allTasksCallsCache;
  const tasks = await fetchRecordsSince('Tasks', TASK_FIELDS, { sortField: 'Created_Time' });
  const calls = await fetchRecordsSince('Calls', CALL_FIELDS, { sortField: 'Created_Time' });
  const deals = await fetchRecordsSince('Deals', ['id', 'Stage'], { sortField: 'Created_Time' });
  const dealStageById = new Map(deals.map(d => [d.id, d.Stage]));
  allTasksCallsCache = { tasks, calls, dealStageById, fetchedAt: Date.now() };
  return allTasksCallsCache;
}

// Deals scoped by dateField/range as usual. Calls are fetched from 2 days before
// the range starts (same import-lag buffer as getRawForRange) through now, so the
// callIndex used for deal-linkage can see a call that lands after the range ends.
// Tasks need no such buffer since they aren't linked back to deals here.
async function getAgentPerfRaw(dateField, startISO, forceRefresh) {
  const key = `${dateField}|${startISO}`;
  if (!forceRefresh && agentPerfRawCache.has(key)) return agentPerfRawCache.get(key);

  const deals = await fetchRecordsSince('Deals', DEAL_FIELDS, { sortField: dateField, stopBeforeISO: startISO });

  const callStopBeforeISO = new Date(new Date(startISO).getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const rawCalls = await fetchRecordsSince('Calls', CALL_FIELDS_WITH_OWNER, { sortField: 'Created_Time', stopBeforeISO: callStopBeforeISO });

  // Some agents' dialers log calls against the Contact (Who_Id), never the Deal
  // itself — resolve those by matching the Contact's phone to a deal's Mobile.
  // Contacts needs its own OAuth scope on top of Deals/Calls/Tasks; if that
  // scope hasn't been granted, skip resolution rather than failing the endpoint.
  let calls = rawCalls;
  let contactLinkingUnavailable = false;
  try {
    const contactIds = rawCalls
      .filter(c => !(c.What_Id && c.$se_module === 'Deals'))
      .map(c => c.Who_Id && c.Who_Id.id)
      .filter(Boolean);
    const contacts = await fetchRecordsByIds('Contacts', CONTACT_FIELDS, contactIds);
    const contactMobileById = buildContactMobileIndex(contacts);
    const dealsByMobile = buildDealsByMobile(deals);
    calls = linkCallsToDealsByContact(rawCalls, dealsByMobile, contactMobileById);
  } catch (err) {
    console.error('Contact-link resolution failed, continuing with direct What_Id links only:', err.message);
    contactLinkingUnavailable = true;
  }

  // Tasks needs its own OAuth scope (ZohoCRM.modules.tasks.READ) on top of what
  // Deals/Calls use — if that scope hasn't been granted on the refresh token yet,
  // degrade to zero task counts instead of failing the whole endpoint.
  let tasks = [];
  let tasksUnavailable = false;
  try {
    tasks = await fetchRecordsSince('Tasks', TASK_FIELDS, { sortField: 'Created_Time', stopBeforeISO: startISO });
  } catch (err) {
    console.error('Tasks fetch failed, continuing without task counts:', err.message);
    tasksUnavailable = true;
  }

  const result = { deals, calls, tasks, tasksUnavailable, contactLinkingUnavailable, fetchedAt: Date.now() };
  agentPerfRawCache.set(key, result);
  return result;
}

// Which dashboard loads at the bare URL depends on which Cloud Run service is
// serving this deploy (each dashboard gets its own service from this same
// codebase, e.g. lucira-refill-dashboard, lucira-old-gold-dashboard,
// lucira-scheme-dashboard) — DEFAULT_PAGE picks it per-deploy via an env var.
// Defaults to Refill Management to match every deploy made before this
// existed, so unset DEFAULT_PAGE never changes existing behavior.
const DEFAULT_PAGE = process.env.DEFAULT_PAGE || 'refill-management.html';
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', DEFAULT_PAGE));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/meta', async (req, res) => {
  try {
    res.json(await getMeta(req.query.refresh === 'true'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/daily-report', async (req, res) => {
  try {
    const dateField = VALID_DATE_FIELDS.includes(req.query.dateField) ? req.query.dateField : 'Created_Time';
    let range = VALID_RANGES.includes(req.query.range) ? req.query.range : 'yesterday';
    const forceRefresh = req.query.refresh === 'true';
    const customStart = DATE_ONLY.test(req.query.start || '') ? req.query.start : null;
    const customEnd = DATE_ONLY.test(req.query.end || '') ? req.query.end : null;
    if (range === 'custom' && (!customStart || !customEnd)) range = 'yesterday';
    const stages = req.query.stage ? req.query.stage.split(',').filter(Boolean) : [];
    const agents = req.query.agent ? req.query.agent.split(',').filter(Boolean) : [];
    const qualifiedOnly = req.query.qualifiedOnly === 'true';

    const { start, end } = getRangeWindow(range, customStart, customEnd);
    const { deals: rawDeals, calls } = await getRawForRange(dateField, start.toISOString(), forceRefresh);

    const startTime = start.getTime();
    const endTime = end.getTime();
    const inRange = rawDeals.filter(d => {
      const t = new Date(d[dateField]).getTime();
      return t >= startTime && t <= endTime;
    });

    const stageAgentFilter = d => {
      if (stages.length && !stages.includes(d.Stage)) return false;
      if (agents.length && (!d.Owner || !agents.includes(d.Owner.name))) return false;
      return true;
    };

    const cleanDeals = inRange.filter(d => !isWhatsAppTriggered(d));
    const filteredDeals = cleanDeals.filter(stageAgentFilter);

    const deduped = groupByMobileAndDay(filteredDeals);
    const scopedDeals = qualifiedOnly
      ? deduped.filter(d => { const p = Number(d.Probability_Score); return !Number.isNaN(p) && p >= 70; })
      : deduped;

    // The dump is an audit view — it intentionally includes WhatsApp-triggered deals
    // (unlike the three aggregate tables above) so it can be cross-checked against
    // Zoho's own raw record counts, but is still scoped to Probability Score >= 70%.
    // WhatsApp and non-WhatsApp deals are deduped SEPARATELY (matching the main
    // pipeline's non-WhatsApp dedup exactly) so a same-day WhatsApp deal for a
    // customer never knocks their non-WhatsApp deal out of the count, or vice versa —
    // keeping dump_total == main_total + whatsapp_count always true.
    const dumpSourceDeals = inRange.filter(stageAgentFilter);
    const dumpNonWhatsAppDeduped = groupByMobileAndDay(dumpSourceDeals.filter(d => !isWhatsAppTriggered(d)));
    const dumpWhatsAppDeduped = groupByMobileAndDay(dumpSourceDeals.filter(isWhatsAppTriggered));
    const dumpDeduped = [...dumpNonWhatsAppDeduped, ...dumpWhatsAppDeduped];
    const dumpQualified = dumpDeduped.filter(d => { const p = Number(d.Probability_Score); return !Number.isNaN(p) && p >= 70; });

    const callIndex = buildCallFirstIndex(calls);
    const rows = buildDailyRows(scopedDeals, callIndex, dateField);
    const probabilityRows = buildProbabilityRows(scopedDeals, callIndex);
    const agentPivot = buildAgentProbabilityPivot(scopedDeals);
    const dealsDump = buildDealsDump(dumpQualified, callIndex);
    const dumpWhatsAppCount = dumpQualified.filter(isWhatsAppTriggered).length;

    const closedLostDeals = scopedDeals.filter(d => d.Stage === 'Closed Lost');
    const closedLostAgentRows = buildAgentProbabilityRows(closedLostDeals, callIndex);

    res.json({
      range,
      dateField,
      rangeStart: start.toISOString(),
      rangeEnd: end.toISOString(),
      stage: stages,
      agent: agents,
      qualifiedOnly,
      rawDealCount: inRange.length,
      excludedWhatsAppCount: inRange.length - cleanDeals.length,
      dedupedDealCount: deduped.length,
      qualifiedDealCount: scopedDeals.length,
      probabilityRows,
      agentPivot,
      closedLostAgentRows,
      dealsDump,
      dumpWhatsAppCount,
      rows,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agent-performance', async (req, res) => {
  try {
    const dateField = VALID_DATE_FIELDS.includes(req.query.dateField) ? req.query.dateField : 'Created_Time';
    let range = VALID_RANGES.includes(req.query.range) ? req.query.range : 'yesterday';
    const forceRefresh = req.query.refresh === 'true';
    const customStart = DATE_ONLY.test(req.query.start || '') ? req.query.start : null;
    const customEnd = DATE_ONLY.test(req.query.end || '') ? req.query.end : null;
    if (range === 'custom' && (!customStart || !customEnd)) range = 'yesterday';
    const agents = req.query.agent ? req.query.agent.split(',').filter(Boolean) : [];

    const { start, end } = getRangeWindow(range, customStart, customEnd);
    const raw = await getAgentPerfRaw(dateField, start.toISOString(), forceRefresh);

    const startTime = start.getTime();
    const endTime = end.getTime();
    const inWindow = (isoTime) => {
      if (!isoTime) return false;
      const t = new Date(isoTime).getTime();
      return t >= startTime && t <= endTime;
    };
    const ownerMatches = record => !agents.length || (record.Owner && agents.includes(record.Owner.name));

    const dealsInRange = raw.deals.filter(d => inWindow(d[dateField]) && ownerMatches(d));
    const callsInRange = raw.calls.filter(c => inWindow(c.Call_Start_Time || c.Created_Time) && ownerMatches(c));
    const tasksInRange = raw.tasks.filter(t => inWindow(t.Created_Time) && ownerMatches(t));

    // Zoho Deals / Deal Call Status / Deal Status Dump / Closed Lost all count
    // "deals", not raw records — dedup by mobile + Created_Time day (same rule
    // as the Daily Report dashboard) so Total deals is a distinct count and
    // every other column on those tables still reconciles against it.
    const dedupedDealsInRange = groupByMobileAndDay(dealsInRange);

    const callIndex = buildCallFirstIndex(raw.calls);
    const callStatsByDeal = buildCallStatsByDeal(raw.calls);
    const taskIndex = buildTaskFirstIndex(raw.tasks);

    const dealsRows = buildDealsRows(dedupedDealsInRange, callIndex, callStatsByDeal);
    const dealStatusDump = buildDealStatusDump(dedupedDealsInRange, callStatsByDeal, taskIndex);
    const dealCallStatusRows = buildDealCallStatusRows(dedupedDealsInRange, tasksInRange, callStatsByDeal);
    const callsRows = buildCallsRows(callsInRange);
    const totalDealsByAgent = new Map(dealsRows.map(r => [r.agent, r.totalDeals]));
    callsRows.forEach(row => { row.totalDealsAssigned = totalDealsByAgent.get(row.agent) || 0; });
    const closedLostRows = buildClosedLostRows(dedupedDealsInRange, callStatsByDeal);
    const todayKey = istDateKey(new Date());
    const tasksRows = buildTasksRows(tasksInRange, callIndex, todayKey);
    const dealsDump = buildDealsDump(dedupedDealsInRange, callIndex, taskIndex, callStatsByDeal);

    // Due/Overdue task counts live on the Zoho Deals table now, not Zoho Task,
    // and are all-time by design — not scoped to the selected date range — so
    // they're computed from the FULL task/call history, then merged onto each
    // deal owner's row by matching agent name (the same join key every
    // buildXRows groups by). Matches Zoho's own Overdue Tasks report: only
    // tasks linked to a deal that's still open (Stage isn't Closed Won/Lost)
    // count — a task with no deal link at all can't be confirmed "not closed".
    const allTasksAndCalls = await getAllTasksAndCalls(forceRefresh);
    const openDealTasks = allTasksAndCalls.tasks.filter(t => {
      const dealId = t.What_Id && t.What_Id.id;
      const stage = dealId ? allTasksAndCalls.dealStageById.get(dealId) : null;
      return stage && stage !== 'Closed Won' && stage !== 'Closed Lost';
    });
    const allTimeTasks = agents.length
      ? openDealTasks.filter(t => t.Owner && agents.includes(t.Owner.name))
      : openDealTasks;
    const allTimeCallIndex = buildCallFirstIndex(allTasksAndCalls.calls);
    const allTimeTasksRows = buildTasksRows(allTimeTasks, allTimeCallIndex, todayKey);
    const dueByAgent = new Map(allTimeTasksRows.map(r => [r.agent, { dueCount: r.dueCount, overdueCount: r.overdueCount }]));
    dealsRows.forEach(row => {
      const due = dueByAgent.get(row.agent) || { dueCount: 0, overdueCount: 0 };
      row.dueCount = due.dueCount;
      row.overdueCount = due.overdueCount;
    });

    res.json({
      range,
      dateField,
      rangeStart: start.toISOString(),
      rangeEnd: end.toISOString(),
      agent: agents,
      dealCount: dedupedDealsInRange.length,
      callCount: callsInRange.length,
      taskCount: tasksInRange.length,
      tasksUnavailable: raw.tasksUnavailable,
      contactLinkingUnavailable: raw.contactLinkingUnavailable,
      dealsRows,
      dealStatusDump,
      dealCallStatusRows,
      callsRows,
      closedLostRows,
      tasksRows,
      dealsDump,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

let refillCache = null;
let refillCacheTime = 0;
const REFILL_CACHE_TTL_MS = 15 * 60 * 1000;

// T-1 tracking (buildRefillDashboard) persists a snapshot to disk on every call
// and diffs against the prior one — so the cache here is purely to avoid
// re-hitting BigQuery on every page load/filter change, NOT a correctness
// concern for T-1 (a forced refresh mid-day would just re-diff against the
// same still-current snapshot from earlier that day).
app.get('/api/refill-management', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh && refillCache && Date.now() - refillCacheTime < REFILL_CACHE_TTL_MS) {
      return res.json(refillCache);
    }
    const data = await buildRefillDashboard();
    refillCache = data;
    refillCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Reuses the same 15-minute cache as /api/refill-management so a chat message
// doesn't trigger its own BigQuery rebuild — the assistant always answers
// against whatever the dashboard itself is currently showing.
async function getRefillDataForContext() {
  if (refillCache && Date.now() - refillCacheTime < REFILL_CACHE_TTL_MS) return refillCache;
  const data = await buildRefillDashboard();
  refillCache = data;
  refillCacheTime = Date.now();
  return data;
}

let oldGoldCache = null;
let oldGoldCacheTime = 0;
const OLD_GOLD_CACHE_TTL_MS = 15 * 60 * 1000;

app.get('/api/old-gold', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh && oldGoldCache && Date.now() - oldGoldCacheTime < OLD_GOLD_CACHE_TTL_MS) {
      return res.json(oldGoldCache);
    }
    const data = await buildOldGoldDashboard();
    oldGoldCache = data;
    oldGoldCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

let exchangeBuybackCache = null;
let exchangeBuybackCacheTime = 0;
const EXCHANGE_BUYBACK_CACHE_TTL_MS = 15 * 60 * 1000;

app.get('/api/old-gold-exchange-buyback', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh && exchangeBuybackCache && Date.now() - exchangeBuybackCacheTime < EXCHANGE_BUYBACK_CACHE_TTL_MS) {
      return res.json(exchangeBuybackCache);
    }
    const data = await buildExchangeBuybackDashboard();
    exchangeBuybackCache = data;
    exchangeBuybackCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Dedicated refresh endpoint for Cloud Scheduler — Cloud Run scales to zero
// when idle, so an in-process node-cron schedule alone isn't reliable (there's
// nothing to fire it if no instance is running when 9am hits). A Cloud
// Scheduler job hitting this URL both wakes the service and forces the
// rebuild in one request. Gated by the same basic-auth middleware as every
// other route (Scheduler is configured with the dashboard credentials).
app.get('/api/cron/refresh-old-gold', async (req, res) => {
  const results = {};
  try {
    const oldGoldData = await buildOldGoldDashboard();
    oldGoldCache = oldGoldData;
    oldGoldCacheTime = Date.now();
    results.oldGoldItems = oldGoldData.items.length;
  } catch (err) {
    console.error('[cron-endpoint] old gold refresh failed:', err.message);
    results.oldGoldError = err.message;
  }
  try {
    const exchangeBuybackData = await buildExchangeBuybackDashboard();
    exchangeBuybackCache = exchangeBuybackData;
    exchangeBuybackCacheTime = Date.now();
    results.exchangeBuybackItems = exchangeBuybackData.items.length;
  } catch (err) {
    console.error('[cron-endpoint] exchange/buyback refresh failed:', err.message);
    results.exchangeBuybackError = err.message;
  }
  const ok = !results.oldGoldError && !results.exchangeBuybackError;
  res.status(ok ? 200 : 500).json({ ok, refreshedAt: new Date().toISOString(), ...results });
});

let schemeCache = null;
let schemeCacheTime = 0;
const SCHEME_CACHE_TTL_MS = 15 * 60 * 1000;

app.get('/api/scheme-dashboard', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh && schemeCache && Date.now() - schemeCacheTime < SCHEME_CACHE_TTL_MS) {
      return res.json(schemeCache);
    }
    const data = await buildSchemeDashboard();
    schemeCache = data;
    schemeCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

let scanCache = null;
let scanCacheTime = 0;
const SCAN_CACHE_TTL_MS = 15 * 60 * 1000;

app.get('/api/scan-dashboard', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh && scanCache && Date.now() - scanCacheTime < SCAN_CACHE_TTL_MS) {
      return res.json(scanCache);
    }
    const data = await buildScanDashboard();
    scanCache = data;
    scanCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

let productScanConversionCache = null;
let productScanConversionCacheTime = 0;
const PRODUCT_SCAN_CONVERSION_CACHE_TTL_MS = 15 * 60 * 1000;

app.get('/api/product-scan-conversion', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh && productScanConversionCache && Date.now() - productScanConversionCacheTime < PRODUCT_SCAN_CONVERSION_CACHE_TTL_MS) {
      return res.json(productScanConversionCache);
    }
    const data = await buildProductScanConversionDashboard();
    productScanConversionCache = data;
    productScanConversionCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

let verifiedMeetingCache = null;
let verifiedMeetingCacheTime = 0;
const VERIFIED_MEETING_CACHE_TTL_MS = 10 * 60 * 1000;

// Meetings come from the tracking Google Sheet, not Zoho's Meetings module —
// "Verified" here means the customer's mobile number shows up in the
// BigQuery walk-in log on/after the meeting date, not any Zoho activity.
app.get('/api/verified-meeting', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh && verifiedMeetingCache && Date.now() - verifiedMeetingCacheTime < VERIFIED_MEETING_CACHE_TTL_MS) {
      return res.json(verifiedMeetingCache);
    }

    const [meetings, walkinIndex, deals] = await Promise.all([
      fetchMeetingsFromSheet(),
      fetchWalkinIndex(),
      fetchRecordsSince('Deals', DEAL_FIELDS, { sortField: 'Created_Time' }),
    ]);
    const dealsByMobile = buildDealsByMobileForVerification(deals);
    const todayKey = istDateKey(new Date());
    const rows = buildVerifiedMeetingRows(meetings, walkinIndex, dealsByMobile, todayKey);

    const payload = { rows, meetingCount: meetings.length, generatedAt: new Date().toISOString() };
    verifiedMeetingCache = payload;
    verifiedMeetingCacheTime = Date.now();
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

let storePerformanceCache = null;
let storePerformanceCacheTime = 0;
const STORE_PERFORMANCE_CACHE_TTL_MS = 15 * 60 * 1000;

app.get('/api/store-performance', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh && storePerformanceCache && Date.now() - storePerformanceCacheTime < STORE_PERFORMANCE_CACHE_TTL_MS) {
      return res.json(storePerformanceCache);
    }
    const data = await buildStorePerformanceDashboard();
    storePerformanceCache = data;
    storePerformanceCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    // Full error (including any BigQuery/SQL detail) goes to the server log
    // only — the client only ever sees a generic message, never raw
    // credentials, SQL errors or stack traces.
    console.error('store-performance dashboard build failed:', err);
    res.status(500).json({ error: 'Unable to load dashboard data.' });
  }
});

// Manual "Number of Staff" input — no data source exists for this anywhere
// in the project, so this just persists whatever the user types in (see
// staffCountStore.js). Invalidates the 15-minute cache above so the new
// count shows up on the very next load, not up to 15 minutes later.
app.post('/api/store-performance/staff', async (req, res) => {
  const { storeKey, count } = req.body || {};
  if (!STORE_PERFORMANCE_STORES.some(s => s.key === storeKey)) {
    return res.status(400).json({ error: 'Unknown store.' });
  }
  const parsed = Number(count);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return res.status(400).json({ error: 'Count must be a whole number, 0 or higher.' });
  }
  try {
    const saved = await staffCountStore.writeOne(storeKey, parsed);
    storePerformanceCache = null;
    res.json({ ok: true, storeKey, count: saved.count });
  } catch (err) {
    console.error('staff count save failed:', err);
    res.status(500).json({ error: 'Could not save — try again.' });
  }
});

let meetingDashboardCache = null;
let meetingDashboardCacheTime = 0;
const MEETING_DASHBOARD_CACHE_TTL_MS = 15 * 60 * 1000;

app.get('/api/meeting-dashboard', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh && meetingDashboardCache && Date.now() - meetingDashboardCacheTime < MEETING_DASHBOARD_CACHE_TTL_MS) {
      return res.json(meetingDashboardCache);
    }
    const data = await buildMeetingDashboard();
    meetingDashboardCache = data;
    meetingDashboardCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error('meeting dashboard build failed:', err);
    res.status(500).json({ error: 'Unable to load dashboard data.' });
  }
});

app.post('/api/assistant/chat', async (req, res) => {
  try {
    const { message, history } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }
    const dashboardData = await getRefillDataForContext();
    const result = await assistantChat({ message, history, dashboardData });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Proactively rebuilds the refill data every morning so it's already fresh
// by the time anyone opens the dashboard — rather than relying on the first
// visitor of the day to trigger a (slower) cold BigQuery rebuild. This also
// gives T-1 Refill Tracking a predictable once-daily cadence: each run's
// snapshot is compared against "yesterday morning's" snapshot, not whatever
// the last incidental page-load happened to be.
// NOTE: this only fires while the Node process is actually running. On a
// host that spins the process down when idle (e.g. Render's free tier),
// nothing fires at 10am unless something else pings the server to wake it
// first — flagged when we get to deployment.
cron.schedule('0 10 * * *', async () => {
  console.log('[cron] 10:00 IST — refreshing refill dashboard data...');
  try {
    const data = await buildRefillDashboard();
    refillCache = data;
    refillCacheTime = Date.now();
    console.log(`[cron] refill data refreshed: ${data.rows.length} rows`);
  } catch (err) {
    console.error('[cron] refill data refresh failed:', err.message);
  }
}, { timezone: 'Asia/Kolkata' });

// Same idea as the refill cron above, at 9am instead — so both the Old Gold
// and Exchange & Buy Back tabs are already fresh before the first visitor of
// the day, rather than the first page load triggering a slower cold rebuild.
cron.schedule('0 9 * * *', async () => {
  console.log('[cron] 09:00 IST — refreshing old gold + exchange/buyback dashboard data...');
  try {
    const oldGoldData = await buildOldGoldDashboard();
    oldGoldCache = oldGoldData;
    oldGoldCacheTime = Date.now();
    console.log(`[cron] old gold data refreshed: ${oldGoldData.items.length} items`);
  } catch (err) {
    console.error('[cron] old gold data refresh failed:', err.message);
  }
  try {
    const exchangeBuybackData = await buildExchangeBuybackDashboard();
    exchangeBuybackCache = exchangeBuybackData;
    exchangeBuybackCacheTime = Date.now();
    console.log(`[cron] exchange/buyback data refreshed: ${exchangeBuybackData.items.length} items`);
  } catch (err) {
    console.error('[cron] exchange/buyback data refresh failed:', err.message);
  }
}, { timezone: 'Asia/Kolkata' });

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
