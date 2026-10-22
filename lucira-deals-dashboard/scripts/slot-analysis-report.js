require('dotenv').config();
const path = require('path');
const XLSX = require('xlsx');
const { fetchRecordsSince, fetchRecordsByIds } = require('../src/zohoClient');
const {
  isWhatsAppTriggered, groupByMobileAndDay, normalizeMobile, formatHHMMSS,
} = require('../src/dailyReportService');
const {
  buildDealsByMobile, buildContactMobileIndex, linkCallsToDealsByContact,
} = require('../src/agentPerformanceService');

const RANGE_START = '2026-08-01T00:00:00+05:30';
const RANGE_END = '2026-08-12T23:59:59+05:30';
const DATES = Array.from({ length: 12 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
const SLOTS = [
  { label: '7pm-8pm', hour: 19 },
  { label: '8pm-9pm', hour: 20 },
];

function ownerName(record) {
  return (record.Owner && record.Owner.name) || 'Unassigned';
}

function hourOf(iso) {
  return iso ? parseInt(iso.slice(11, 13), 10) : null;
}

function dateOf(iso) {
  return iso ? iso.slice(0, 10) : null;
}

async function main() {
  console.log(`Fetching Deals/Calls/Contacts for ${RANGE_START} .. ${RANGE_END}...`);

  const deals = await fetchRecordsSince('Deals',
    ['id', 'Owner', 'Mobile', 'Probability_Score', 'Deal_Trigger_Event', 'Created_Time'],
    { sortField: 'Created_Time', stopBeforeISO: RANGE_START });
  const dealsInRange = deals.filter(d => dateOf(d.Created_Time) && d.Created_Time >= RANGE_START && d.Created_Time <= RANGE_END);

  // Calls fetched from RANGE_START through now (no upper bound) so a deal
  // created near the end of the range can still find its first call, even if
  // that call landed after Aug 12.
  const rawCalls = await fetchRecordsSince('Calls',
    ['Owner', 'Call_Start_Time', 'What_Id', 'Who_Id', 'Created_Time'],
    { sortField: 'Created_Time', stopBeforeISO: RANGE_START });

  const contactIds = rawCalls
    .filter(c => !(c.What_Id && c.$se_module === 'Deals'))
    .map(c => c.Who_Id && c.Who_Id.id)
    .filter(Boolean);
  const contacts = await fetchRecordsByIds('Contacts', ['id', 'Phone', 'Mobile'], contactIds);
  const contactMobileById = buildContactMobileIndex(contacts);
  const dealsByMobile = buildDealsByMobile(dealsInRange);
  const calls = linkCallsToDealsByContact(rawCalls, dealsByMobile, contactMobileById);

  console.log(`Fetched ${dealsInRange.length} deals in range, ${calls.length} calls, ${contacts.length} contacts.`);

  const dealById = new Map(dealsInRange.map(d => [d.id, d]));

  const firstCallByDeal = new Map();
  for (const call of calls) {
    const dealId = call.What_Id && call.What_Id.id;
    if (!dealId || !call.Call_Start_Time) continue;
    const t = new Date(call.Call_Start_Time).getTime();
    const existing = firstCallByDeal.get(dealId);
    if (!existing || t < existing.time) firstCallByDeal.set(dealId, { time: t });
  }

  const callsInRange = calls.filter(c => {
    const iso = c.Call_Start_Time || c.Created_Time;
    return iso && iso >= RANGE_START && iso <= RANGE_END;
  });

  // Dedup by mobile+day, WhatsApp and non-WhatsApp separately — same rule the
  // rest of this dashboard uses, so a same-day WhatsApp deal never knocks out
  // a non-WhatsApp deal for the same customer, or vice versa.
  const nonWhatsAppDeduped = groupByMobileAndDay(dealsInRange.filter(d => !isWhatsAppTriggered(d)));
  const whatsAppDeduped = groupByMobileAndDay(dealsInRange.filter(isWhatsAppTriggered));

  function dealsInSlot(dealList, date, hour) {
    return dealList.filter(d => dateOf(d.Created_Time) === date && hourOf(d.Created_Time) === hour);
  }

  function uniqueCallingDone(date, hour) {
    const numbers = new Set();
    for (const call of callsInRange) {
      const iso = call.Call_Start_Time || call.Created_Time;
      if (dateOf(iso) !== date || hourOf(iso) !== hour) continue;
      const dealId = call.What_Id && call.What_Id.id;
      const deal = dealId ? dealById.get(dealId) : null;
      const mobile = deal ? normalizeMobile(deal.Mobile) : null;
      if (mobile) numbers.add(mobile);
    }
    return numbers;
  }

  function agentsActive(date, hour) {
    const agents = new Set();
    for (const d of dealsInRange) {
      if (dateOf(d.Created_Time) === date && hourOf(d.Created_Time) === hour) agents.add(ownerName(d));
    }
    for (const c of callsInRange) {
      const iso = c.Call_Start_Time || c.Created_Time;
      if (dateOf(iso) === date && hourOf(iso) === hour) agents.add(ownerName(c));
    }
    return agents;
  }

  const table1 = []; // deals vs calling
  const table2 = []; // high-prob deals vs calling
  const table3 = []; // chats vs FRT
  const table4 = []; // agents active

  const totals = SLOTS.map(() => ({
    uniqueDeals: 0, callingNumbers: new Set(), highProb: 0,
    chats: 0, frtSecondsSum: 0, frtCount: 0, agents: new Set(),
  }));

  DATES.forEach(date => {
    SLOTS.forEach((slot, slotIdx) => {
      const dealsHere = dealsInSlot(nonWhatsAppDeduped, date, slot.hour);
      const chatsHere = dealsInSlot(whatsAppDeduped, date, slot.hour);
      const highProbHere = dealsHere.filter(d => {
        const p = Number(d.Probability_Score);
        return !Number.isNaN(p) && p >= 70 && p <= 100;
      });
      const callingNumbers = uniqueCallingDone(date, slot.hour);
      const agents = agentsActive(date, slot.hour);

      let frtSecondsSum = 0, frtCount = 0;
      chatsHere.forEach(d => {
        const first = firstCallByDeal.get(d.id);
        if (!first) return;
        const diff = (first.time - new Date(d.Created_Time).getTime()) / 1000;
        if (diff >= 0) { frtSecondsSum += diff; frtCount += 1; }
      });

      table1.push({
        Date: date, Slot: slot.label,
        'Unique Deals Created': dealsHere.length,
        'Unique Calling Done': callingNumbers.size,
      });
      table2.push({
        Date: date, Slot: slot.label,
        'High Probability Deals Created (70-100%)': highProbHere.length,
        'Unique Calling Done': callingNumbers.size,
      });
      table3.push({
        Date: date, Slot: slot.label,
        'Unique Chats Created (WhatsApp)': chatsHere.length,
        'FRT (hh:mm:ss)': frtCount ? formatHHMMSS(frtSecondsSum / frtCount) : '',
      });
      table4.push({
        Date: date, Slot: slot.label,
        'Agents Active (logged-in proxy)': agents.size,
      });

      const t = totals[slotIdx];
      t.uniqueDeals += dealsHere.length;
      callingNumbers.forEach(n => t.callingNumbers.add(n));
      t.highProb += highProbHere.length;
      t.chats += chatsHere.length;
      t.frtSecondsSum += frtSecondsSum;
      t.frtCount += frtCount;
      agents.forEach(a => t.agents.add(a));
    });
  });

  SLOTS.forEach((slot, slotIdx) => {
    const t = totals[slotIdx];
    table1.push({
      Date: 'TOTAL (Aug 1-12)', Slot: slot.label,
      'Unique Deals Created': t.uniqueDeals,
      'Unique Calling Done': t.callingNumbers.size,
    });
    table2.push({
      Date: 'TOTAL (Aug 1-12)', Slot: slot.label,
      'High Probability Deals Created (70-100%)': t.highProb,
      'Unique Calling Done': t.callingNumbers.size,
    });
    table3.push({
      Date: 'TOTAL (Aug 1-12)', Slot: slot.label,
      'Unique Chats Created (WhatsApp)': t.chats,
      'FRT (hh:mm:ss)': t.frtCount ? formatHHMMSS(t.frtSecondsSum / t.frtCount) : '',
    });
    table4.push({
      Date: 'TOTAL (Aug 1-12)', Slot: slot.label,
      'Agents Active (logged-in proxy)': t.agents.size,
    });
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(table1), 'Deals vs Calling');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(table2), 'High-Prob Deals vs Calling');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(table3), 'Chats vs FRT');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(table4), 'Agents Active');

  const outPath = path.join(require('os').homedir(), 'Desktop', 'Lucira-Slot-Analysis-Report_2026-08-01_to_2026-08-12.xlsx');
  XLSX.writeFile(wb, outPath);
  console.log('Written to:', outPath);
  console.log('Table 1 sample:', JSON.stringify(table1.slice(0, 4), null, 2));
  console.log('Table 3 sample:', JSON.stringify(table3.slice(0, 4), null, 2));
}

main().catch(err => {
  console.error('ERROR', err);
  process.exit(1);
});
