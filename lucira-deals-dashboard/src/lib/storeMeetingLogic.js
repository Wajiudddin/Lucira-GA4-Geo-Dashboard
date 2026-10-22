// Pure functions (no I/O) behind the Store Meeting & Conversion dashboard, kept
// separate so they can be unit-tested (scripts/test-store-meeting-logic.js).
const { RULES } = require('../config/storeMeetingRules');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDateKeyFromMs(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function istDayStartMs(dateKey) {
  return new Date(`${dateKey}T00:00:00+05:30`).getTime();
}

function addDaysKey(dateKey, n) {
  return istDateKeyFromMs(istDayStartMs(dateKey) + n * 86400000 + 12 * 3600000);
}

// Monday..Sunday IST week containing `nowMs`. Returns date keys plus the
// half-open [startMs, endMs) range so a 23:59 Sunday meeting is still inside.
function istWeekBounds(nowMs = Date.now()) {
  const todayKey = istDateKeyFromMs(nowMs);
  const dow = new Date(istDayStartMs(todayKey) + IST_OFFSET_MS).getUTCDay(); // 0=Sun..6=Sat, of the IST date
  const sinceMonday = (dow + 6) % 7;
  const startKey = addDaysKey(todayKey, -sinceMonday);
  const endKey = addDaysKey(startKey, 6);
  return {
    startKey, endKey,
    startMs: istDayStartMs(startKey),
    endMs: istDayStartMs(addDaysKey(startKey, 7)),
  };
}

// Visit ("Show") decision for one meeting. Returns
// { status: 'show'|'no_show'|'upcoming'|'pending'|'unverifiable', source, visitTsMs, precision }
// Rule: a meeting marked "Show" in Zoho is a Show. Anything else (no mark, or "No Show") is NOT final:
// the walk-in data is checked next, and only if no walk-in is found is it a No Show.
function decideVisit({ showStatus, showDate, visitDateKey, mobile, walkinEvents, nowMs }) {
  const todayKey = istDateKeyFromMs(nowMs);
  const dayStart = visitDateKey ? istDayStartMs(visitDateKey) : -Infinity;
  const useCrm = RULES.showSource !== 'walkin_only';
  const useWalkin = RULES.showSource !== 'crm_only';
  const walkin = useWalkin ? ((walkinEvents || []).find(e => e.ts >= dayStart) || null) : null;
  const crmShow = useCrm && showStatus === 'Show';
  const crmNoShow = useCrm && showStatus === 'No Show';

  if (crmShow) {
    if (walkin) return { status: 'show', source: 'crm', visitTsMs: walkin.ts, precision: 'exact' };
    if (showDate) return { status: 'show', source: 'crm', visitTsMs: istDayStartMs(showDate), precision: 'date' };
    return { status: 'show', source: 'crm', visitTsMs: null, precision: 'unknown' };
  }
  if (visitDateKey && visitDateKey > todayKey && !crmNoShow) return { status: 'upcoming', source: null, visitTsMs: null, precision: null };
  // Not marked Show in Zoho -> look for a walk-in by the same mobile on/after the meeting day.
  if (!useWalkin || !mobile) {
    return crmNoShow ? { status: 'no_show', source: 'crm', visitTsMs: null, precision: null }
      : { status: 'unverifiable', source: null, visitTsMs: null, precision: null };
  }
  if (walkin) return { status: 'show', source: 'walkin', visitTsMs: walkin.ts, precision: 'exact' };
  if (crmNoShow) return { status: 'no_show', source: 'crm', visitTsMs: null, precision: null };
  if (visitDateKey === todayKey) return { status: 'pending', source: null, visitTsMs: null, precision: null };
  return { status: 'no_show', source: 'walkin_inferred', visitTsMs: null, precision: null };
}

// Conversion decision. Rule: "Converted" in Zoho counts. Anything else (no mark, or "Non-Converted") is NOT
// final for a customer who showed up: the store sales (marketing_sale) are checked next.
function decideConversion({ conversionStatus, visit, visitDateKey, orderEvents }) {
  const useCrm = RULES.conversionSource !== 'sales_only';
  if (useCrm && conversionStatus === 'Converted') return { status: 'converted', source: 'crm', order: null };
  const crmNon = useCrm && conversionStatus === 'Non-Converted';
  if (RULES.conversionSource === 'crm_only') {      // Zoho meeting only: no sales lookup
    if (visit.status !== 'show') return crmNon ? { status: 'not_converted', source: 'crm', order: null } : { status: 'n/a', source: null, order: null };
    return { status: 'not_converted', source: 'crm', order: null };
  }
  if (visit.status !== 'show') {
    return crmNon ? { status: 'not_converted', source: 'crm', order: null } : { status: 'n/a', source: null, order: null };
  }
  const from = visitDateKey || '0000-00-00';
  const order = (orderEvents || []).find(o => o.dateKey >= from) || null;
  if (order) return { status: 'converted', source: 'sales', order };
  return { status: 'not_converted', source: crmNon ? 'crm' : 'sales_inferred', order: null };
}

// Attribute each call to AT MOST one meeting of the same customer: a call is a follow-up for a meeting when it was
// made AFTER the exact time the meeting was raised and BEFORE THE END OF THE SCHEDULED DATE (IST) — the time of day on
// the "From" field is ignored (many meetings only carry a date, stored as 05:30). With no From date, the window runs
// to now. If several meetings qualify, the most recently raised wins so a call is never counted twice.
// meetings: [{ id, customerKeys:[...], raisedMs, fromMs }]; calls: [{ id, keys:[...], tsMs }]
const endOfScheduledDayMs = fromMs => istDayStartMs(istDateKeyFromMs(fromMs)) + 86400000;
function attributeCalls(meetings, calls, nowMs) {
  // Two-step matching. STEP 1: the mobile number (meeting.customerKeys vs call.keys). STEP 2, only when step 1 does not
  // give a follow-up: every other way (contact, deal, the deal's mobile, a number inside the contact name):
  // meeting.customerKeys2 + customerKeys vs call.keys2 + keys. A follow-up found by either step beats an
  // after-schedule match, and the number-based match is always preferred.
  const add = (map, k, m) => { if (!map.has(k)) map.set(k, []); map.get(k).push(m); };
  const primary = new Map(), all = new Map();
  meetings.forEach(m => {
    (m.customerKeys || []).forEach(k => { add(primary, k, m); add(all, k, m); });
    (m.customerKeys2 || []).forEach(k => add(all, k, m));
  });

  const classify = (c, keys, byKey) => {
    const seen = new Set();
    let best = null;        // follow-up: raised -> end of the scheduled date
    let post = null;        // after-schedule: made after the end of the scheduled date (e.g. the customer did not come that day)
    keys.forEach(k => (byKey.get(k) || []).forEach(m => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      if (c.tsMs <= m.raisedMs) return;                          // before the meeting was raised
      const dayEnd = m.fromMs != null ? endOfScheduledDayMs(m.fromMs) : null;
      if (dayEnd == null || c.tsMs < dayEnd) {                   // inside the follow-up window
        if (c.tsMs <= nowMs && (!best || m.raisedMs > best.raisedMs)) best = m;
      } else if (c.tsMs <= nowMs) {                              // after the scheduled date has ended
        if (!post || dayEnd > post.dayEnd) post = { meeting: m, dayEnd };
      }
    }));
    return { best, post };
  };

  const out = [];
  for (const c of calls) {
    const r1 = classify(c, c.keys || [], primary);
    let best = r1.best, post = r1.post;
    if (!best) {
      const r2 = classify(c, [...(c.keys || []), ...(c.keys2 || [])], all);
      if (r2.best) best = r2.best;
      else if (r2.post && (!post || r2.post.dayEnd > post.dayEnd)) post = r2.post;   // newest meeting of the customer wins
    }
    // A call that is a follow-up for one meeting is never also counted as an after-schedule call of another.
    out.push({ call: c, meeting: best, postMeeting: best ? null : (post ? post.meeting : null) });
  }
  return out;
}

module.exports = { istDateKeyFromMs, istDayStartMs, istWeekBounds, decideVisit, decideConversion, attributeCalls, addDaysKey };
