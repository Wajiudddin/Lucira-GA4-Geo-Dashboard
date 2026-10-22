// Calendar-based comparison periods, computed dynamically off the real
// wall-clock date in Asia/Kolkata every time this is called — nothing here
// is hardcoded to a specific date, so "today" advances automatically.
//
// Definitions (documented in the dashboard's Logic tab too):
//   Yesterday  — today minus `yesterdayOffsetDays` (default 1), in Asia/Kolkata.
//   Last Week  — the previous full calendar week, Monday through Sunday.
//   Last Month — the previous full calendar month, 1st through last day.
//
// All dates are plain 'YYYY-MM-DD' strings. Every date this module compares
// is such a string, so lexicographic ordering is correct without parsing
// back into Date objects — comparisons like `d >= start && d <= end` work
// directly on the strings.

// True calendar yesterday, for every metric EXCEPT City/Paid/Retargeting/
// Communication Sessions — those 4 use today-minus-2 instead, by explicit
// request (storePerformanceService.js calls getComparisonPeriods(today, 2)
// a second time, specifically for those 4). Everything else (Meetings,
// Walkins, Orders, Revenue, Calls, Deals) uses this default, today-minus-1.
const DEFAULT_YESTERDAY_OFFSET_DAYS = 1;

function istDateKey(date) {
  // Shifts a UTC instant by +5:30 and reads the calendar date off the
  // shifted UTC fields — equivalent to formatting in Asia/Kolkata without
  // depending on the host's ICU/timezone database.
  const shifted = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

// 0 = Monday ... 6 = Sunday (ISO weekday, zero-based)
function isoWeekdayIndex(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday ... 6 = Saturday
  return (jsDay + 6) % 7;
}

function firstOfMonth(dateKey) {
  const [y, m] = dateKey.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDisplayDate(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return `${d} ${MONTH_LABELS[m - 1]} ${y}`;
}

function formatDisplayRange(start, end) {
  return start === end ? formatDisplayDate(start) : `${formatDisplayDate(start)} - ${formatDisplayDate(end)}`;
}

/**
 * @param {string} [todayKey] Override "today" (IST, 'YYYY-MM-DD') — for tests, or to
 *   reuse an already-computed `today` when calling this a second time (see
 *   `yesterdayOffsetDays` below).
 * @param {number} [yesterdayOffsetDays] How many days before `today` "Yesterday" is.
 *   Defaults to 1 (true calendar yesterday). Pass 2 for GA4's own comparison periods.
 */
function getComparisonPeriods(todayKey, yesterdayOffsetDays, customRange, opts) {
  const today = todayKey || istDateKey(new Date());
  const offset = yesterdayOffsetDays == null ? DEFAULT_YESTERDAY_OFFSET_DAYS : yesterdayOffsetDays;

  const yesterday = addDays(today, -offset);

  const currentWeekMonday = addDays(today, -isoWeekdayIndex(today));
  const lastWeekEnd = addDays(currentWeekMonday, -1); // last Sunday
  const lastWeekStart = addDays(lastWeekEnd, -6); // the Monday before that

  const thisMonthFirst = firstOfMonth(today);
  const lastMonthEnd = addDays(thisMonthFirst, -1); // last day of previous month
  const lastMonthStart = firstOfMonth(lastMonthEnd);

  const periods = {
    // Optional extra period (Store Comparison tab): today so far, in IST.
    ...(opts && opts.withToday ? { today: { key: 'today', label: 'Today', start: today, end: today } } : {}),
    yesterday: { key: 'yesterday', label: 'Yesterday', start: yesterday, end: yesterday },
    lastWeek: { key: 'lastWeek', label: 'Last Week', start: lastWeekStart, end: lastWeekEnd },
    lastMonth: { key: 'lastMonth', label: 'Last Month', start: lastMonthStart, end: lastMonthEnd },
  };
  // Optional 4th period: a user-chosen range (already validated by validateCustomRange).
  if (customRange && customRange.start && customRange.end) {
    // perDay: show per-day averages like Last Week/Last Month; otherwise the range's totals.
    periods.custom = { key: 'custom', label: 'Custom', start: customRange.start, end: customRange.end, perDay: !!customRange.perDay };
  }
  for (const p of Object.values(periods)) {
    p.displayRange = formatDisplayRange(p.start, p.end);
  }

  // The data fetch must cover every period, including the custom one.
  const allStarts = Object.values(periods).map(p => p.start);
  const allEnds = Object.values(periods).map(p => p.end);
  const queryRange = {
    start: allStarts.reduce((a, b) => (a < b ? a : b)),
    end: allEnds.reduce((a, b) => (a > b ? a : b)),
  };

  return { today, periods, queryRange };
}

// Sums a per-day Map<'YYYY-MM-DD', number> into the three named periods.
function bucketDailyMap(dailyMap, periods, round = n => Math.round(n)) {
  const sumRange = (start, end) => {
    let total = 0;
    dailyMap.forEach((v, k) => { if (k >= start && k <= end) total += v; });
    return total;
  };
  const out = {};
  Object.keys(periods).forEach(k => { out[k] = round(sumRange(periods[k].start, periods[k].end)); });
  return out;
}

// Custom range limits: valid dates, from <= to, ending no later than yesterday (today's data is
// incomplete), at most 92 days long, and starting no more than 120 days back (every source is
// fetched from the range start up to now, so a very old start would be slow).
const CUSTOM_MAX_DAYS = 92;
const CUSTOM_MAX_LOOKBACK_DAYS = 120;
// The Store Comparison and City Wise tabs can reach back to the very start of the data (the first
// store sale is 13 Sep 2025), so their ranges have no 92/120-day limit: any range from that date.
const DATA_START = '2025-09-13';
const CUSTOM_LONG_MAX_DAYS = 3650;
function badRange(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}
function isRealDate(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const t = new Date(key + 'T00:00:00Z');
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === key;
}
function validateCustomRange(from, to, todayKey, opts) {
  const maxDays = opts && opts.long ? CUSTOM_LONG_MAX_DAYS : CUSTOM_MAX_DAYS;
  const today = todayKey || istDateKey(new Date());
  if (!isRealDate(from) || !isRealDate(to)) throw badRange('Pick a valid From and To date.');
  if (from > to) throw badRange('The From date must be on or before the To date.');
  const yesterday = addDays(today, -1);
  if (to > yesterday) throw badRange('The To date can be at most yesterday (' + formatDisplayDate(yesterday) + ').');
  const earliest = opts && opts.long ? DATA_START : addDays(today, -CUSTOM_MAX_LOOKBACK_DAYS);
  if (from < earliest) {
    throw badRange(opts && opts.long
      ? 'The data starts on ' + formatDisplayDate(DATA_START) + '; pick a From date on or after it.'
      : 'The From date can be at most ' + CUSTOM_MAX_LOOKBACK_DAYS + ' days back (' + formatDisplayDate(earliest) + ').');
  }
  const days = Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
  if (days > maxDays) throw badRange('A custom range can be at most ' + maxDays + ' days long.');
  return { start: from, end: to };
}

module.exports = {
  istDateKey,
  addDays,
  getComparisonPeriods,
  bucketDailyMap,
  validateCustomRange,
  CUSTOM_MAX_DAYS,
  CUSTOM_MAX_LOOKBACK_DAYS,
  CUSTOM_LONG_MAX_DAYS,
  DATA_START,
  formatDisplayDate,
  formatDisplayRange,
};
