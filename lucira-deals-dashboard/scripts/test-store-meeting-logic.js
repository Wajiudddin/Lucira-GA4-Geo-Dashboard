// node scripts/test-store-meeting-logic.js
const assert = require('assert');
const { classifyCity, RULES } = require('../src/config/storeMeetingRules');
const L = require('../src/lib/storeMeetingLogic');

// City mapping
const cases = [
  ['Mumbai','Maharashtra','Mumbai'],['Thane','Maharashtra','Mumbai'],['Bengaluru','Karnataka','Bangalore'],
  ['Bangalore Rural','Karnataka','Bangalore'],['South West Delhi','Delhi','Delhi'],['delhi',null,'Delhi'],['New Delhi','Delhi','Delhi'],
  ['Noida','Uttar Pradesh','Noida'],['Greater Noida','Uttar Pradesh','Noida'],['Gautam Buddha Nagar','Uttar Pradesh','Noida'],
  ['Pune','Maharashtra','Pune'],['  PUNE ','Maharashtra','Pune'],
];
cases.forEach(([c, s, m]) => assert.strictEqual(classifyCity(c, s).market, m, c));
['Hyderabad','Gurgaon','Ghaziabad','Navi Mumbai'].forEach(c => assert.strictEqual(classifyCity(c, '').category, 'non_city', c));
['', null, undefined, 'Unknown City'].forEach(c => assert.strictEqual(classifyCity(c, '').category, 'unknown'));

// Week boundaries (IST, Mon-Sun)
const ms = s => new Date(s).getTime();
let w = L.istWeekBounds(ms('2026-10-16T12:00:00+05:30')); // Friday
assert.deepStrictEqual([w.startKey, w.endKey], ['2026-10-12', '2026-10-18']);
w = L.istWeekBounds(ms('2026-10-18T23:59:59+05:30')); // Sunday night -> same week
assert.deepStrictEqual([w.startKey, w.endKey], ['2026-10-12', '2026-10-18']);
w = L.istWeekBounds(ms('2026-10-19T00:00:00+05:30')); // Monday 00:00 -> next week
assert.deepStrictEqual([w.startKey, w.endKey], ['2026-10-19', '2026-10-25']);
w = L.istWeekBounds(ms('2026-10-18T19:00:00Z')); // = Mon 00:30 IST
assert.strictEqual(w.startKey, '2026-10-19');
w = L.istWeekBounds(ms('2026-10-12T00:00:00+05:30'));
assert.strictEqual(w.startKey, '2026-10-12');
const sun = ms('2026-10-18T23:59:00+05:30'), mon = ms('2026-10-19T00:00:00+05:30');
w = L.istWeekBounds(ms('2026-10-14T10:00:00+05:30'));
assert.ok(sun >= w.startMs && sun < w.endMs && !(mon >= w.startMs && mon < w.endMs));

// Follow-up attribution: raised (exact time) < call < END of the scheduled date (IST); time of day on From is ignored
const raised = ms('2026-10-10T10:00:00+05:30'), from = ms('2026-10-12T05:30:00+05:30');   // From has only a date (05:30)
const meetings = [{ id: 'm1', customerKeys: ['d1'], raisedMs: raised, fromMs: from }];
const mk = (id, t) => ({ id, keys: ['d1'], tsMs: ms(t) });
const res = L.attributeCalls(meetings, [
  mk('before-raised', '2026-10-09T10:00:00+05:30'), mk('between', '2026-10-11T10:00:00+05:30'),
  mk('scheduled-day-after-0530', '2026-10-12T15:00:00+05:30'), mk('scheduled-day-late', '2026-10-12T23:59:00+05:30'),
  mk('next-day-start', '2026-10-13T00:00:00+05:30'), mk('later', '2026-10-13T10:00:00+05:30'),
], ms('2026-10-16T00:00:00+05:30'));
assert.deepStrictEqual(res.map(r => !!r.meeting), [false, true, true, true, false, false]);
// Krishna raj example: raised 2 Oct 11:00, scheduled 3 Oct (05:30)
const kr = [{ id: 'kr', customerKeys: ['c1'], raisedMs: ms('2026-10-02T11:00:00+05:30'), fromMs: ms('2026-10-03T05:30:00+05:30') }];
const k2 = (id, t) => ({ id, keys: ['c1'], tsMs: ms(t) });
const rk = L.attributeCalls(kr, [k2('a', '2026-10-02T10:52:00+05:30'), k2('b', '2026-10-03T10:46:00+05:30'), k2('c', '2026-10-03T13:47:00+05:30'), k2('d', '2026-10-03T15:26:00+05:30'), k2('e', '2026-10-06T12:24:00+05:30')], ms('2026-10-17T00:00:00+05:30'));
assert.deepStrictEqual(rk.map(r => !!r.meeting), [false, true, true, true, false]);
// Two meetings on the same deal: a call is given to the latest-raised meeting whose window contains it
const two = [
  { id: 'a', customerKeys: ['d1'], raisedMs: ms('2026-10-01T10:00:00+05:30'), fromMs: ms('2026-10-20T05:30:00+05:30') },
  { id: 'b', customerKeys: ['d1'], raisedMs: ms('2026-10-05T10:00:00+05:30'), fromMs: ms('2026-10-20T05:30:00+05:30') },
];
const r2 = L.attributeCalls(two, [mk('c', '2026-10-06T10:00:00+05:30'), mk('c0', '2026-10-03T10:00:00+05:30')], ms('2026-10-16T00:00:00+05:30'));
assert.deepStrictEqual(r2.map(r => r.meeting && r.meeting.id), ['b', 'a']);
// No From -> window runs up to now; a future call timestamp is never counted
const noFrom = [{ id: 'z', customerKeys: ['d1'], raisedMs: raised, fromMs: null }];
assert.ok(L.attributeCalls(noFrom, [mk('n', '2026-10-11T10:00:00+05:30')], ms('2026-10-16T00:00:00+05:30'))[0].meeting);
assert.ok(!L.attributeCalls(noFrom, [mk('f', '2026-10-17T10:00:00+05:30')], ms('2026-10-16T00:00:00+05:30'))[0].meeting);
// Calls AFTER the scheduled date: Krishna raj - the 6 Oct call is after the 3 Oct scheduled day
assert.deepStrictEqual(rk.map(r => !!r.postMeeting), [false, false, false, false, true]);
assert.strictEqual(rk[4].postMeeting.id, 'kr');
// ...but a call inside a LATER meeting's window is that meeting's follow-up, never an after-schedule call of the first
const later = [
  { id: 'A', customerKeys: ['d1'], raisedMs: ms('2026-10-01T10:00:00+05:30'), fromMs: ms('2026-10-05T05:30:00+05:30') },
  { id: 'B', customerKeys: ['d1'], raisedMs: ms('2026-10-10T10:00:00+05:30'), fromMs: ms('2026-10-12T05:30:00+05:30') },
];
const rl = L.attributeCalls(later, [mk('x', '2026-10-08T10:00:00+05:30'), mk('y', '2026-10-11T10:00:00+05:30'), mk('z', '2026-10-14T10:00:00+05:30')], ms('2026-10-16T00:00:00+05:30'));
assert.deepStrictEqual(rl.map(r => [r.meeting && r.meeting.id, r.postMeeting && r.postMeeting.id]), [[null, 'A'], ['B', null], [null, 'B']]);
// Two-step matching: mobile number first, then every other way
const raisedT = ms('2026-10-10T10:00:00+05:30'), fromT = ms('2026-10-12T05:30:00+05:30');
const mm = [{ id: 'A', customerKeys: ['m:9665114249'], customerKeys2: ['c:C1', 'd:D1'], raisedMs: raisedT, fromMs: fromT }];
const cc = (id, keys, keys2) => ({ id, keys, keys2, tsMs: ms('2026-10-11T10:00:00+05:30') });
const r3 = L.attributeCalls(mm, [
  cc('same-number', ['m:9665114249'], []),                    // step 1: the number matches
  cc('other-number-same-deal', ['m:9240925786'], ['d:D1']),   // step 2: a different number, but logged on the same deal
  cc('no-number-same-contact', [], ['c:C1']),                 // step 2: no number, same contact
  cc('unrelated', ['m:9000000000'], ['d:OTHER']),             // nothing matches
], ms('2026-10-16T00:00:00+05:30'));
assert.deepStrictEqual(r3.map(r => !!r.meeting), [true, true, true, false]);
// number-based match wins when two meetings could take the call
const two2 = [
  { id: 'byNumber', customerKeys: ['m:111'], customerKeys2: [], raisedMs: ms('2026-10-05T10:00:00+05:30'), fromMs: ms('2026-10-20T05:30:00+05:30') },
  { id: 'byDealOnly', customerKeys: ['m:222'], customerKeys2: ['d:D9'], raisedMs: ms('2026-10-08T10:00:00+05:30'), fromMs: ms('2026-10-20T05:30:00+05:30') },
];
const r4 = L.attributeCalls(two2, [cc('x', ['m:111'], ['d:D9'])], ms('2026-10-16T00:00:00+05:30'));
assert.strictEqual(r4[0].meeting.id, 'byNumber');
console.log('two-step matching tests passed');
console.log('follow-up attribution tests passed');

// Delhi zone -> store (business table) and single-store markets
const zones = { 'Central Delhi': 'lajpatNagar', 'South Delhi': 'lajpatNagar', 'South West Delhi': 'lajpatNagar', 'North Delhi': 'paschimVihar', 'North West Delhi': 'paschimVihar', 'West Delhi': 'paschimVihar', 'East Delhi': 'noida', 'New Delhi': null, 'Noida': 'noida', 'Pune': 'pune', 'Bengaluru': 'malleshwaram', 'Mumbai': null };
Object.entries(zones).forEach(([c, s]) => assert.strictEqual(classifyCity(c, '').storeKey, s, c));
console.log('delhi zone store mapping tests passed');

// Show / Conversion with the walk-in / sales fallback (RULES 'crm_first'; the live setting is 'crm_only', tested below)
const liveShow = RULES.showSource, liveConv = RULES.conversionSource;
RULES.showSource = 'crm_first'; RULES.conversionSource = 'crm_first';
// Show / Conversion rules: Zoho positive wins; otherwise walk-in / sales evidence is checked before deciding
const now = ms('2026-10-16T12:00:00+05:30');
const walkins = [{ ts: ms('2026-10-12T16:00:00+05:30') }];
const base = { visitDateKey: '2026-10-12', mobile: '9999999999', walkinEvents: walkins, nowMs: now };
assert.strictEqual(L.decideVisit({ ...base, showStatus: 'Show' }).status, 'show');
assert.strictEqual(L.decideVisit({ ...base, showStatus: null }).source, 'walkin');                  // no mark -> walk-in found
assert.strictEqual(L.decideVisit({ ...base, showStatus: 'No Show' }).status, 'show');                // No Show is not final if a walk-in exists
assert.strictEqual(L.decideVisit({ ...base, showStatus: 'No Show', walkinEvents: [] }).source, 'crm'); // no walk-in -> keeps the No Show
assert.strictEqual(L.decideVisit({ ...base, showStatus: null, walkinEvents: [] }).source, 'walkin_inferred');
assert.strictEqual(L.decideVisit({ ...base, showStatus: null, mobile: null }).status, 'unverifiable');
assert.strictEqual(L.decideVisit({ ...base, showStatus: null, visitDateKey: '2026-10-20' }).status, 'upcoming');
const showV = { status: 'show' }, orders = [{ dateKey: '2026-10-13', documentNo: 'D1', amount: 100 }];
assert.strictEqual(L.decideConversion({ conversionStatus: 'Converted', visit: showV, visitDateKey: '2026-10-12', orderEvents: [] }).status, 'converted');
assert.strictEqual(L.decideConversion({ conversionStatus: null, visit: showV, visitDateKey: '2026-10-12', orderEvents: orders }).source, 'sales');
assert.strictEqual(L.decideConversion({ conversionStatus: 'Non-Converted', visit: showV, visitDateKey: '2026-10-12', orderEvents: orders }).status, 'converted'); // sale overrides Non-Converted
assert.strictEqual(L.decideConversion({ conversionStatus: 'Non-Converted', visit: showV, visitDateKey: '2026-10-12', orderEvents: [] }).source, 'crm');
assert.strictEqual(L.decideConversion({ conversionStatus: null, visit: { status: 'no_show' }, visitDateKey: '2026-10-12', orderEvents: orders }).status, 'n/a');
RULES.showSource = liveShow; RULES.conversionSource = liveConv;
// LIVE setting: Zoho meeting only. A walk-in or a sale never changes Show / Converted.
assert.strictEqual(liveShow, 'crm_only'); assert.strictEqual(liveConv, 'crm_only');
assert.strictEqual(L.decideVisit({ ...base, showStatus: 'No Show' }).status, 'no_show');
assert.strictEqual(L.decideVisit({ ...base, showStatus: null }).status, 'unverifiable');   // no Zoho mark -> not a Show, even with a walk-in
assert.strictEqual(L.decideVisit({ ...base, showStatus: 'Show' }).status, 'show');
assert.strictEqual(L.decideConversion({ conversionStatus: null, visit: showV, visitDateKey: '2026-10-12', orderEvents: orders }).status, 'not_converted');
assert.strictEqual(L.decideConversion({ conversionStatus: 'Converted', visit: showV, visitDateKey: '2026-10-12', orderEvents: [] }).status, 'converted');
console.log('show / conversion rule tests passed');
