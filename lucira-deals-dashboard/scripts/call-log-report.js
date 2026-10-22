require('dotenv').config();
const path = require('path');
const XLSX = require('xlsx');
const { fetchRecordsSince, fetchRecordsByIds } = require('../src/zohoClient');
const { formatHHMMSS, normalizeMobile } = require('../src/dailyReportService');
const {
  buildDealsByMobile, buildContactMobileIndex, linkCallsToDealsByContact,
} = require('../src/agentPerformanceService');

const RANGE_START = '2026-08-01T00:00:00+05:30';
const RANGE_END = '2026-08-12T23:59:59+05:30';
// First-call linkage needs deals/calls from a bit before RANGE_START too, so a
// deal created right at the edge can still find its first call.
const FETCH_FROM = '2026-07-30T00:00:00+05:30';

const CONNECTED_STATUSES = new Set(['Attended Dialled', 'Received']);

function ownerName(record) {
  return (record.Owner && record.Owner.name) || 'Unassigned';
}

function inRange(iso, startISO, endISO) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= new Date(startISO).getTime() && t <= new Date(endISO).getTime();
}

async function main() {
  console.log(`Fetching Deals/Calls/Contacts from ${FETCH_FROM} through ${RANGE_END}...`);

  const deals = await fetchRecordsSince('Deals',
    ['id', 'Owner', 'Mobile', 'Created_Time'],
    { sortField: 'Created_Time', stopBeforeISO: FETCH_FROM });

  const rawCalls = await fetchRecordsSince('Calls',
    ['Owner', 'Call_Start_Time', 'Call_Duration_in_seconds', 'Call_Status', 'What_Id', 'Who_Id', 'Created_Time'],
    { sortField: 'Created_Time', stopBeforeISO: FETCH_FROM });

  const contactIds = rawCalls
    .filter(c => !(c.What_Id && c.$se_module === 'Deals'))
    .map(c => c.Who_Id && c.Who_Id.id)
    .filter(Boolean);
  const contacts = await fetchRecordsByIds('Contacts', ['id', 'Phone', 'Mobile'], contactIds);
  const contactMobileById = buildContactMobileIndex(contacts);
  const dealsByMobile = buildDealsByMobile(deals);
  const calls = linkCallsToDealsByContact(rawCalls, dealsByMobile, contactMobileById);

  console.log(`Fetched ${deals.length} deals, ${calls.length} calls, ${contacts.length} contacts.`);

  const dealById = new Map(deals.map(d => [d.id, d]));

  // Earliest call per deal id, across the full fetched window (unbounded within
  // FETCH_FROM..RANGE_END) — used only for FRT (deal creation -> first call).
  const firstCallByDeal = new Map();
  for (const call of calls) {
    const dealId = call.What_Id && call.What_Id.id;
    if (!dealId || !call.Call_Start_Time) continue;
    const t = new Date(call.Call_Start_Time).getTime();
    const existing = firstCallByDeal.get(dealId);
    if (!existing || t < existing.time) firstCallByDeal.set(dealId, { time: t });
  }

  const dealsInRange = deals.filter(d => inRange(d.Created_Time, RANGE_START, RANGE_END));
  const callsInRange = calls.filter(c => inRange(c.Call_Start_Time || c.Created_Time, RANGE_START, RANGE_END));

  const store = new Map();
  const getRow = agent => {
    if (!store.has(agent)) {
      store.set(agent, {
        agent, dialled: 0, connected: 0, talkTimeSeconds: 0,
        frtSecondsSum: 0, frtDealCount: 0,
        // mobile -> day-of-month (1-12) -> call count that day
        attemptsByNumberDay: new Map(),
      });
    }
    return store.get(agent);
  };

  for (const call of callsInRange) {
    const row = getRow(ownerName(call));
    row.dialled += 1;
    if (CONNECTED_STATUSES.has(call.Call_Status)) row.connected += 1;
    row.talkTimeSeconds += call.Call_Duration_in_seconds || 0;

    const dealId = call.What_Id && call.What_Id.id;
    const deal = dealId ? dealById.get(dealId) : null;
    const mobile = deal ? normalizeMobile(deal.Mobile) : null;
    if (mobile) {
      const callTime = call.Call_Start_Time || call.Created_Time;
      const day = Number(callTime.slice(8, 10));
      if (!row.attemptsByNumberDay.has(mobile)) row.attemptsByNumberDay.set(mobile, new Map());
      const dayMap = row.attemptsByNumberDay.get(mobile);
      dayMap.set(day, (dayMap.get(day) || 0) + 1);
    }
  }

  for (const deal of dealsInRange) {
    const first = firstCallByDeal.get(deal.id);
    if (!first || !deal.Created_Time) continue;
    const diffSeconds = (first.time - new Date(deal.Created_Time).getTime()) / 1000;
    if (diffSeconds < 0) continue;
    const row = getRow(ownerName(deal));
    row.frtSecondsSum += diffSeconds;
    row.frtDealCount += 1;
  }

  const DAYS = Array.from({ length: 12 }, (_, i) => i + 1); // Aug 1..12

  function sanitizeSheetName(name) {
    return name.replace(/[\\/?*[\]:]/g, '-').slice(0, 31);
  }

  const summaryRows = [];
  for (const row of store.values()) {
    let attempt1 = 0, attempt2 = 0, attempt3 = 0, attempt4Plus = 0;
    for (const dayMap of row.attemptsByNumberDay.values()) {
      const total = Array.from(dayMap.values()).reduce((a, b) => a + b, 0);
      if (total === 1) attempt1 += 1;
      else if (total === 2) attempt2 += 1;
      else if (total === 3) attempt3 += 1;
      else attempt4Plus += 1;
    }

    summaryRows.push({
      'Agent Name': row.agent,
      'Call Dialled': row.dialled,
      'Call Connected %': row.dialled ? Math.round((row.connected / row.dialled) * 1000) / 10 : 0,
      'Talk Time (hh:mm:ss)': formatHHMMSS(row.talkTimeSeconds),
      'FRT (hh:mm:ss)': row.frtDealCount ? formatHHMMSS(row.frtSecondsSum / row.frtDealCount) : '',
      '1 Attempt': attempt1,
      '2 Attempts': attempt2,
      '3 Attempts': attempt3,
      '4+ Attempts': attempt4Plus,
    });
  }

  summaryRows.sort((a, b) => b['Call Dialled'] - a['Call Dialled']);

  const wb = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Agent-wise Call Log');

  // One sheet per agent: rows = mobile numbers they called, columns = Aug 1..12,
  // cell = how many times that agent called that number on that day.
  const usedSheetNames = new Set(['Agent-wise Call Log']);
  const sortedAgents = Array.from(store.values()).sort((a, b) => b.dialled - a.dialled);
  for (const row of sortedAgents) {
    if (!row.attemptsByNumberDay.size) continue;

    const mobileRows = Array.from(row.attemptsByNumberDay.entries())
      .map(([mobile, dayMap]) => {
        const total = Array.from(dayMap.values()).reduce((a, b) => a + b, 0);
        return { mobile, dayMap, total };
      })
      .sort((a, b) => b.total - a.total);

    const sheetData = [['', 'date'], ['Mobile', ...DAYS]];
    for (const { mobile, dayMap } of mobileRows) {
      sheetData.push([mobile, ...DAYS.map(d => dayMap.get(d) || 0)]);
    }

    let sheetName = sanitizeSheetName(row.agent);
    let suffix = 2;
    while (usedSheetNames.has(sheetName)) {
      sheetName = sanitizeSheetName(`${row.agent} (${suffix})`);
      suffix += 1;
    }
    usedSheetNames.add(sheetName);

    const agentSheet = XLSX.utils.aoa_to_sheet(sheetData);
    XLSX.utils.book_append_sheet(wb, agentSheet, sheetName);
  }

  const outPath = path.join(require('os').homedir(), 'Desktop', 'Lucira-Call-Log-Report_2026-08-01_to_2026-08-12.xlsx');
  XLSX.writeFile(wb, outPath);
  console.log('Written to:', outPath);
  console.log(JSON.stringify(summaryRows, null, 2));
}

main().catch(err => {
  console.error('ERROR', err);
  process.exit(1);
});
