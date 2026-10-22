const { formatHHMMSS, isWhatsAppTriggered, normalizeMobile } = require('./dailyReportService');

const WORKING_HOUR_START = 10; // 10am
const WORKING_HOUR_END = 21; // 9pm (exclusive)

// Deal stage -> a 3-bucket "called status" used only in the Zoho Calls table.
// Prospect is the only stage before any real engagement ("open"); everything
// mid-funnel is "wip"; both closed outcomes collapse to "closed". Any custom
// stage not listed here defaults to "wip" (treated as still in progress).
const STAGE_BUCKET = {
  Prospect: 'open',
  'Add to Cart': 'wip',
  Checkout: 'wip',
  Payment: 'wip',
  'Closed Won': 'closed',
  'Closed Lost': 'closed',
};

function stageBucket(stage) {
  return STAGE_BUCKET[stage] || 'wip';
}

// When a deal has been through groupByMobileAndDay dedup, the surviving record
// carries _groupDealIds — every raw id in that mobile+day group — so a call or
// task logged against a duplicate that got deduped away is still found.
function dealIdsToCheck(deal) {
  return deal._groupDealIds || [deal.id];
}

function firstCallForDeal(deal, callIndex) {
  let firstCall = null;
  for (const id of dealIdsToCheck(deal)) {
    const c = callIndex.get(id);
    if (c && (!firstCall || c.time < firstCall.time)) firstCall = c;
  }
  return firstCall;
}

function callStatsForDeal(deal, callStatsByDeal) {
  let count = 0;
  let connected = 0;
  for (const id of dealIdsToCheck(deal)) {
    const s = callStatsByDeal.get(id);
    if (s) { count += s.count; connected += s.connected; }
  }
  return { count, connected };
}

function taskCountForDeal(deal, taskIndex) {
  let count = 0;
  for (const id of dealIdsToCheck(deal)) {
    const t = taskIndex.get(id);
    if (t) count += t.count;
  }
  return count;
}

// The Zoho Deals table's "Work status" — a hybrid of Stage and call activity:
// Closed = Stage is Closed Won/Lost (regardless of calls); otherwise WIP if
// it's been called at all, Open if it's still sitting completely uncalled.
function dealWorkStatus(deal, callStatsByDeal) {
  const isClosed = deal.Stage === 'Closed Won' || deal.Stage === 'Closed Lost';
  if (isClosed) return 'Closed';
  return callStatsForDeal(deal, callStatsByDeal).count > 0 ? 'WIP' : 'Open';
}

function ownerName(record) {
  return (record.Owner && record.Owner.name) || 'Unassigned';
}

function isWorkingHour(isoTime) {
  if (!isoTime) return false;
  const hour = parseInt(isoTime.slice(11, 13), 10);
  return hour >= WORKING_HOUR_START && hour < WORKING_HOUR_END;
}

// Some agents' dialers log calls against the Contact (Who_Id), not the Deal
// (What_Id is null / $se_module isn't 'Deals') — so a call-to-deal link built
// only from What_Id silently misses those calls entirely. This resolves them
// by matching the Contact's phone number to a deal's Mobile field, and
// returns a NEW calls array with What_Id backfilled wherever that succeeds —
// buildCallFirstIndex/buildCallStatsByDeal then pick them up with no changes.
function buildDealsByMobile(deals) {
  const map = new Map();
  for (const deal of deals) {
    const mobile = normalizeMobile(deal.Mobile);
    if (!mobile || !deal.Created_Time) continue;
    if (!map.has(mobile)) map.set(mobile, []);
    map.get(mobile).push({ id: deal.id, time: new Date(deal.Created_Time).getTime() });
  }
  return map;
}

function buildContactMobileIndex(contacts) {
  const map = new Map();
  for (const contact of contacts) {
    const mobile = normalizeMobile(contact.Mobile || contact.Phone);
    if (mobile) map.set(contact.id, mobile);
  }
  return map;
}

// Among same-mobile candidates, pick the deal closest in time to the call —
// a customer calling in about their most recent deal is the common case.
function pickClosestDeal(candidates, callTimeMs) {
  if (candidates.length === 1 || callTimeMs == null) return candidates[0].id;
  let best = candidates[0];
  let bestDiff = Math.abs(best.time - callTimeMs);
  for (const c of candidates.slice(1)) {
    const diff = Math.abs(c.time - callTimeMs);
    if (diff < bestDiff) { best = c; bestDiff = diff; }
  }
  return best.id;
}

function linkCallsToDealsByContact(calls, dealsByMobile, contactMobileById) {
  return calls.map(call => {
    if (call.What_Id && call.$se_module === 'Deals') return call; // already linked directly

    const contactId = call.Who_Id && call.Who_Id.id;
    const mobile = contactId ? contactMobileById.get(contactId) : null;
    const candidates = mobile ? dealsByMobile.get(mobile) : null;
    if (!candidates || !candidates.length) return call;

    const callTimeMs = call.Call_Start_Time
      ? new Date(call.Call_Start_Time).getTime()
      : (call.Created_Time ? new Date(call.Created_Time).getTime() : null);
    const dealId = pickClosestDeal(candidates, callTimeMs);
    return { ...call, What_Id: { id: dealId }, $se_module: 'Deals', _linkedViaContact: true };
  });
}

function rowStore(emptyRowFn) {
  const rows = new Map();
  const getRow = agent => {
    if (!rows.has(agent)) rows.set(agent, emptyRowFn(agent));
    return rows.get(agent);
  };
  return { getRow, all: () => Array.from(rows.values()) };
}

// One row per deal OWNER: workload + call-linkage stats, against the full,
// unbounded callIndex so a deal called weeks after range-start still counts.
// Working/non-working hours are based on the deal's own Created_Time (when
// it was assigned), not on when any call happened. attempt1/2/3/4PlusCount
// bucket deals by their total call attempts (callStatsByDeal) — a deal with
// 0 attempts (never called) isn't in any bucket, matching calledCount's gap.
// workStatusOpen/Wip/ClosedCount comes from dealWorkStatus (see above).
function buildDealsRows(dealsInRange, callIndex, callStatsByDeal) {
  const store = rowStore(agent => ({
    agent, totalDeals: 0, calledCount: 0, under15MinCount: 0,
    workingHourCount: 0, workingHourCalledCount: 0, nonWorkingHourCount: 0,
    attempt1Count: 0, attempt2Count: 0, attempt3Count: 0, attempt4PlusCount: 0,
    workStatusOpenCount: 0, workStatusWipCount: 0, workStatusClosedCount: 0,
  }));

  for (const deal of dealsInRange) {
    const row = store.getRow(ownerName(deal));
    row.totalDeals += 1;

    const firstCall = firstCallForDeal(deal, callIndex);
    if (firstCall) {
      row.calledCount += 1;
      if (deal.Created_Time) {
        const diffSeconds = (firstCall.time - new Date(deal.Created_Time).getTime()) / 1000;
        if (diffSeconds >= 0 && diffSeconds <= 900) row.under15MinCount += 1;
      }
    }

    // Deals assigned during working hours are expected to be called — this
    // tracks how many of them actually were, regardless of when the call landed.
    if (isWorkingHour(deal.Created_Time)) {
      row.workingHourCount += 1;
      if (firstCall) row.workingHourCalledCount += 1;
    } else {
      row.nonWorkingHourCount += 1;
    }

    const attempts = callStatsForDeal(deal, callStatsByDeal).count;
    if (attempts === 1) row.attempt1Count += 1;
    else if (attempts === 2) row.attempt2Count += 1;
    else if (attempts === 3) row.attempt3Count += 1;
    else if (attempts >= 4) row.attempt4PlusCount += 1;

    const status = dealWorkStatus(deal, callStatsByDeal);
    if (status === 'Closed') row.workStatusClosedCount += 1;
    else if (status === 'WIP') row.workStatusWipCount += 1;
    else row.workStatusOpenCount += 1;
  }

  return store.all().sort((a, b) => b.totalDeals - a.totalDeals);
}

const DEAL_STATUS_DUMP_LIMIT = 500;

// Raw per-deal listing, WhatsApp-triggered deals excluded: Owner, Mobile,
// Stage, the same hybrid Work status (dealWorkStatus) shown in the Zoho
// Deals table, and whether it's ever been called at all — lets you check an
// individual deal against the aggregate Work status counts instead of just
// trusting the sums.
function buildDealStatusDump(dealsInRange, callStatsByDeal, taskIndex) {
  const filtered = dealsInRange.filter(d => !isWhatsAppTriggered(d));
  const sorted = [...filtered].sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time));
  const dump = sorted.slice(0, DEAL_STATUS_DUMP_LIMIT).map(deal => {
    const stats = callStatsForDeal(deal, callStatsByDeal);
    return {
      id: deal.id,
      dealName: deal.Deal_Name || null,
      owner: ownerName(deal),
      mobile: deal.Mobile || null,
      stage: deal.Stage || null,
      triggerEvent: deal.Deal_Trigger_Event || null,
      workStatus: dealWorkStatus(deal, callStatsByDeal),
      called: stats.count > 0,
      callCount: stats.count,
      activityCount: taskCountForDeal(deal, taskIndex),
    };
  });
  return { dump, total: sorted.length, truncated: sorted.length > DEAL_STATUS_DUMP_LIMIT };
}

// One row per deal OWNER, WhatsApp-triggered deals excluded. Connected/
// notConnected/undialed are mutually exclusive per-deal buckets
// (callStatsByDeal); calledButOpenCount is an overlay on top — a deal can be
// both "connected" and "called but still open" at once. "Open" here is the
// same CRM Stage bucket as the Deals table's "Work status: Open"
// (Stage === Prospect via stageBucket). taskWithoutCallCount is specifically
// tasks linked to THIS agent's own undialed deals (not just any task
// anywhere whose deal happens to be uncalled) — it can still exceed
// undialedCount if a deal has multiple tasks, but every task it counts
// traces back to a deal in that same bucket.
function buildDealCallStatusRows(dealsInRange, tasksInRange, callStatsByDeal) {
  const store = rowStore(agent => ({
    agent, dealAssignCount: 0, connectedCount: 0, notConnectedCount: 0,
    calledButOpenCount: 0, undialedCount: 0, taskWithoutCallCount: 0,
  }));

  const undialedDealIds = new Set();
  for (const deal of dealsInRange) {
    if (isWhatsAppTriggered(deal)) continue;
    const row = store.getRow(ownerName(deal));
    row.dealAssignCount += 1;

    const stats = callStatsForDeal(deal, callStatsByDeal);
    const wasCalled = stats.count > 0;
    if (!wasCalled) {
      row.undialedCount += 1;
      undialedDealIds.add(deal.id);
    } else if (stats.connected > 0) row.connectedCount += 1;
    else row.notConnectedCount += 1;

    if (wasCalled && stageBucket(deal.Stage) === 'open') row.calledButOpenCount += 1;
  }

  const dealOwnerById = new Map(dealsInRange.map(d => [d.id, ownerName(d)]));
  for (const task of tasksInRange) {
    const dealId = task.What_Id && task.What_Id.id;
    if (!dealId || !undialedDealIds.has(dealId)) continue;
    const row = store.getRow(dealOwnerById.get(dealId));
    row.taskWithoutCallCount += 1;
  }

  return store.all().sort((a, b) => b.dealAssignCount - a.dealAssignCount);
}

// One row per CALL owner: raw call activity.
function buildCallsRows(callsInRange) {
  const store = rowStore(agent => ({
    agent, totalCalls: 0, totalDurationSeconds: 0, over30sCount: 0,
  }));

  for (const call of callsInRange) {
    const row = store.getRow(ownerName(call));
    row.totalCalls += 1;
    const duration = call.Call_Duration_in_seconds || 0;
    row.totalDurationSeconds += duration;
    if (duration >= 30) row.over30sCount += 1;
  }

  return store.all()
    .map(row => ({ ...row, talkTimeFormatted: formatHHMMSS(row.totalDurationSeconds) }))
    .sort((a, b) => b.totalCalls - a.totalCalls);
}

// Per-deal call stats (every call linked to that deal, not just the first):
// total count and how many were connected (>=30s) — used by buildClosedLostRows
// so it shows real call volume, not just a called/not-called flag.
function buildCallStatsByDeal(calls) {
  const stats = new Map();
  for (const call of calls) {
    const dealId = call.What_Id && call.What_Id.id;
    if (!dealId) continue;
    if (call.$se_module && call.$se_module !== 'Deals') continue;

    if (!stats.has(dealId)) stats.set(dealId, { count: 0, connected: 0 });
    const s = stats.get(dealId);
    s.count += 1;
    if ((call.Call_Duration_in_seconds || 0) >= 30) s.connected += 1;
  }
  return stats;
}

// One row per deal OWNER, Closed Lost deals only, WhatsApp-triggered deals
// excluded: how many they lost, and — per deal, not summed across calls —
// whether the agent ever actually connected (>=30s call), merely called
// without connecting, or closed it without making any call at all.
function buildClosedLostRows(dealsInRange, callStatsByDeal) {
  const store = rowStore(agent => ({
    agent, closedCount: 0, connectedCount: 0, calledNotConnectedCount: 0, noCallCount: 0,
  }));
  for (const deal of dealsInRange) {
    if (deal.Stage !== 'Closed Lost') continue;
    if (isWhatsAppTriggered(deal)) continue;
    const row = store.getRow(ownerName(deal));
    row.closedCount += 1;

    const stats = callStatsForDeal(deal, callStatsByDeal);
    if (stats.count === 0) row.noCallCount += 1;
    else if (stats.connected > 0) row.connectedCount += 1;
    else row.calledNotConnectedCount += 1;
  }
  return store.all().sort((a, b) => b.closedCount - a.closedCount);
}

// One row per task OWNER: how many tasks they were assigned, and — via the
// task's What_Id — whether the deal it's linked to has a call logged against
// it at all (callIndex, unbounded). A task with no deal link, or one linking
// to a non-Deal record, counts as not called (no call could be attributed to it).
// dueCount/overdueCount match Zoho's own Task definitions (Due_Date vs today,
// Status not Completed) rather than anything computed from call activity:
//   Due     = Due_Date <= today AND Status != 'Completed'
//   Overdue = Due_Date <  today AND Status != 'Completed' (a subset of Due)
// todayKey is a 'YYYY-MM-DD' string (istDateKey) so this is timezone-stable
// regardless of when the request happens to run.
function buildTasksRows(tasksInRange, callIndex, todayKey) {
  const store = rowStore(agent => ({
    agent, totalTasks: 0, calledCount: 0, notCalledCount: 0, dueCount: 0, overdueCount: 0,
  }));
  for (const task of tasksInRange) {
    const row = store.getRow(ownerName(task));
    row.totalTasks += 1;

    const dealId = task.What_Id && task.What_Id.id;
    const wasCalled = !!(dealId && callIndex.get(dealId));
    if (wasCalled) row.calledCount += 1;
    else row.notCalledCount += 1;

    const notCompleted = task.Status !== 'Completed';
    const dueDateKey = task.Due_Date ? task.Due_Date.slice(0, 10) : null;
    if (notCompleted && dueDateKey && dueDateKey <= todayKey) row.dueCount += 1;
    if (notCompleted && dueDateKey && dueDateKey < todayKey) row.overdueCount += 1;
  }
  return store.all().sort((a, b) => b.totalTasks - a.totalTasks);
}

module.exports = {
  buildDealsByMobile, buildContactMobileIndex, linkCallsToDealsByContact,
  buildDealsRows, buildDealStatusDump, buildDealCallStatusRows, buildCallsRows, buildCallStatsByDeal,
  buildClosedLostRows, buildTasksRows,
};
