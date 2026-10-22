require('dotenv').config();
const path = require('path');
const os = require('os');
const XLSX = require('xlsx');
const { fetchRecordsSince, fetchRecordsByIds } = require('../src/zohoClient');
const { groupByMobileAndDay, formatHHMMSS } = require('../src/dailyReportService');
const {
  buildDealsByMobile, buildContactMobileIndex, linkCallsToDealsByContact,
  buildDealsRows, buildCallsRows, buildCallStatsByDeal,
} = require('../src/agentPerformanceService');
const { buildCallFirstIndex } = require('../src/dailyReportService');

const DEAL_FIELDS = [
  'id', 'Deal_Name', 'Amount', 'Probability_Score', 'Stage',
  'Deal_Trigger_Event', 'Owner', 'Mobile', 'Created_Time', 'Modified_Time',
];
const CALL_FIELDS_WITH_OWNER = [
  'What_Id', 'Call_Start_Time', 'Call_Duration_in_seconds', 'Call_Type', 'Created_Time', 'Owner', 'Who_Id',
];
const CONTACT_FIELDS = ['id', 'Phone', 'Mobile'];

const TODAY = '2026-08-19';
const RANGE_START = `${TODAY}T00:00:00+05:30`;
const RANGE_END = `${TODAY}T18:00:00+05:30`;

function inWindow(iso, startMs, endMs) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= startMs && t <= endMs;
}

async function main() {
  const startMs = new Date(RANGE_START).getTime();
  const endMs = new Date(RANGE_END).getTime();

  console.log(`Fetching Deals/Calls for ${RANGE_START} .. ${RANGE_END}...`);

  const deals = await fetchRecordsSince('Deals', DEAL_FIELDS, { sortField: 'Created_Time', stopBeforeISO: RANGE_START });

  const callStopBeforeISO = new Date(startMs - 2 * 24 * 60 * 60 * 1000).toISOString();
  const rawCalls = await fetchRecordsSince('Calls', CALL_FIELDS_WITH_OWNER, { sortField: 'Created_Time', stopBeforeISO: callStopBeforeISO });

  let calls = rawCalls;
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
  }

  const dealsInRange = deals.filter(d => inWindow(d.Created_Time, startMs, endMs));
  const callsInRange = calls.filter(c => inWindow(c.Call_Start_Time || c.Created_Time, startMs, endMs));

  console.log(`Deals in range: ${dealsInRange.length}, Calls in range: ${callsInRange.length}`);

  const dedupedDealsInRange = groupByMobileAndDay(dealsInRange);
  const callIndex = buildCallFirstIndex(calls);
  const callStatsByDeal = buildCallStatsByDeal(calls);

  const dealsRows = buildDealsRows(dedupedDealsInRange, callIndex, callStatsByDeal);
  const callsRows = buildCallsRows(callsInRange);

  const dealsByAgent = new Map(dealsRows.map(r => [r.agent, r.totalDeals]));
  const callsByAgent = new Map(callsRows.map(r => [r.agent, r]));

  const agents = new Set([...dealsByAgent.keys(), ...callsByAgent.keys()]);

  const summaryRows = Array.from(agents).map(agent => {
    const totalDeals = dealsByAgent.get(agent) || 0;
    const c = callsByAgent.get(agent);
    return {
      'Agent': agent,
      'Total Deals': totalDeals,
      'Total Calls': c ? c.totalCalls : 0,
      'Talk Time (hh:mm:ss)': c ? c.talkTimeFormatted : formatHHMMSS(0),
      'Calls >= 30 sec': c ? c.over30sCount : 0,
    };
  }).sort((a, b) => b['Total Calls'] - a['Total Calls']);

  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, sheet, 'Agent Summary');

  const outPath = path.join(os.homedir(), 'Desktop', `Lucira-Agent-Summary_${TODAY}_till-6pm.xlsx`);
  XLSX.writeFile(wb, outPath);
  console.log('Written to:', outPath);
  console.log(JSON.stringify(summaryRows, null, 2));
}

main().catch(err => {
  console.error('ERROR', err);
  process.exit(1);
});
