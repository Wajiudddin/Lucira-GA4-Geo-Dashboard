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
function getComparisonPeriods(todayKey, yesterdayOffsetDays) {
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
    yesterday: { key: 'yesterday', label: 'Yesterday', start: yesterday, end: yesterday },
    lastWeek: { key: 'lastWeek', label: 'Last Week', start: lastWeekStart, end: lastWeekEnd },
    lastMonth: { key: 'lastMonth', label: 'Last Month', start: lastMonthStart, end: lastMonthEnd },
  };
  for (const p of Object.values(periods)) {
    p.displayRange = formatDisplayRange(p.start, p.end);
  }

  const allStarts = [periods.yesterday.start, periods.lastWeek.start, periods.lastMonth.start];
  const allEnds = [periods.yesterday.end, periods.lastWeek.end, periods.lastMonth.end];
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
  return {
    yesterday: round(sumRange(periods.yesterday.start, periods.yesterday.end)),
    lastWeek: round(sumRange(periods.lastWeek.start, periods.lastWeek.end)),
    lastMonth: round(sumRange(periods.lastMonth.start, periods.lastMonth.end)),
  };
}

module.exports = {
  istDateKey,
  addDays,
  getComparisonPeriods,
  bucketDailyMap,
  formatDisplayDate,
  formatDisplayRange,
};
