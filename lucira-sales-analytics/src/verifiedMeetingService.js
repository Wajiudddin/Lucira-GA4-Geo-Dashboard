require('dotenv').config();
const { GoogleAuth } = require('google-auth-library');
const { BigQuery } = require('@google-cloud/bigquery');
const { normalizeMobile } = require('./dailyReportService');

// Same auth pattern as the other BigQuery-backed services in this repo:
// local gcloud ADC / GOOGLE_APPLICATION_CREDENTIALS file, or a service
// account JSON in an env var in production.
const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

// Same service account as BigQuery above, just scoped for Sheets too — it
// must be shared as a Viewer on the target spreadsheet (Share -> paste its
// client_email) or every read below fails with a 403.
const sheetsAuth = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
  : new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });

const SPREADSHEET_ID = process.env.VERIFIED_MEETING_SHEET_ID || '1cs5bnZe5t-x3JC7Cja3E6dlYztIsHysOvluOfsFX1Lc';
const SHEET_GID = process.env.VERIFIED_MEETING_SHEET_GID || '0';

async function sheetsGet(pathAndQuery) {
  const client = await sheetsAuth.getClient();
  const { token } = await client.getAccessToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google Sheets API error: ${(data.error && data.error.message) || res.status}`);
  }
  return data;
}

// The URL's gid is the tab's numeric sheetId, not its title — the values.get
// endpoint addresses a range by title, so this resolves gid -> title once.
async function resolveSheetTitle() {
  const meta = await sheetsGet('?fields=sheets(properties(sheetId,title))');
  const sheet = (meta.sheets || []).find(s => String(s.properties.sheetId) === String(SHEET_GID));
  if (!sheet) throw new Error(`No tab with gid=${SHEET_GID} found in the Verified Meeting spreadsheet`);
  return sheet.properties.title;
}

// FORMATTED_VALUE (the default) so dates/numbers read exactly as displayed
// in the sheet (e.g. "07/12/2025"), matching how the sheet is actually used.
async function fetchSheetValues() {
  const title = await resolveSheetTitle();
  const range = `'${title.replace(/'/g, "''")}'!A1:AZ5000`;
  const data = await sheetsGet(`/values/${encodeURIComponent(range)}`);
  return data.values || [];
}

function normHeader(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// The sheet's header row isn't always row 1 (a stray blank row sometimes sits
// above it), so this scans for the row that actually looks like the header
// instead of assuming a fixed position.
function findHeaderRowIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const norm = rows[i].map(normHeader);
    if (norm.includes('cx name') && norm.includes('date')) return i;
  }
  throw new Error('Could not find the header row in the Verified Meeting sheet (expected "CX NAME" and "DATE" columns)');
}

function findAny(norm, needles) {
  return norm.findIndex(h => needles.some(n => h.includes(n)));
}

// "K" is the sheet's actual (terse) header for the customer mobile column,
// and "ONLIE EXCUTIVE" is a typo in the sheet itself for the online
// executive who owns the meeting — matched loosely so the typo doesn't need
// fixing in the sheet for this to keep working.
function buildColumnIndex(headerRow) {
  const norm = headerRow.map(normHeader);
  return {
    customerName: norm.indexOf('cx name'),
    mobile: norm.indexOf('k'),
    date: norm.indexOf('date'),
    action: norm.indexOf('action'),
    store: norm.indexOf('store'),
    executive: findAny(norm, ['excutive', 'executive']),
  };
}

// Sheet dates are entered as DD/MM/YYYY text. Anything that doesn't match
// (blank, or a stray note in the DATE cell) comes back null and is treated
// as "no date on record" by classifyMeeting below, not as an error.
function parseSheetDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// One meeting per sheet row. Rows with no usable mobile number are dropped —
// they're blank/section rows in the sheet, not real meetings.
async function fetchMeetingsFromSheet() {
  const rows = await fetchSheetValues();
  const headerIdx = findHeaderRowIndex(rows);
  const cols = buildColumnIndex(rows[headerIdx]);
  if (cols.mobile === -1) {
    throw new Error('Could not find the mobile number ("K") column in the Verified Meeting sheet');
  }

  const meetings = [];
  for (const row of rows.slice(headerIdx + 1)) {
    const mobile = normalizeMobile(row[cols.mobile]);
    if (!mobile) continue;
    meetings.push({
      customerName: (row[cols.customerName] || '').toString().trim() || null,
      mobile,
      dateKey: parseSheetDate(row[cols.date]),
      action: (row[cols.action] || '').toString().trim() || null,
      store: (row[cols.store] || '').toString().trim() || null,
      agent: cols.executive !== -1 ? ((row[cols.executive] || '').toString().trim() || 'Unassigned') : 'Unassigned',
    });
  }
  return meetings;
}

const WALKIN_QUERY = `
  SELECT phone, event_time
  FROM \`lucirajewelry-prod.store_customer.walkin_data\`
  WHERE phone IS NOT NULL
`;

// mobile -> sorted array of walk-in epoch-ms timestamps for that number
// (a customer can walk in more than once).
async function fetchWalkinIndex() {
  const [rows] = await bigquery.query({ query: WALKIN_QUERY });
  const index = new Map();
  for (const row of rows) {
    const mobile = normalizeMobile(row.phone);
    const raw = row.event_time && typeof row.event_time === 'object' ? row.event_time.value : row.event_time;
    const t = raw ? new Date(raw).getTime() : NaN;
    if (!mobile || Number.isNaN(t)) continue;
    if (!index.has(mobile)) index.set(mobile, []);
    index.get(mobile).push(t);
  }
  index.forEach(list => list.sort((a, b) => a - b));
  return index;
}

function istDayStartMs(dateKey) {
  return new Date(`${dateKey}T00:00:00+05:30`).getTime();
}

// Verified = the customer actually walked into a store on or after the date
// the meeting was booked for (a match from before the meeting existed
// doesn't confirm this specific meeting). No date on the sheet row -> no
// lower bound, any walk-in on record counts. A meeting dated in the future
// is still Upcoming regardless of any walk-in match.
function classifyMeeting(meeting, walkinIndex, todayKey) {
  if (meeting.dateKey && meeting.dateKey > todayKey) return 'upcoming';
  const cutoffMs = meeting.dateKey ? istDayStartMs(meeting.dateKey) : -Infinity;
  const events = walkinIndex.get(meeting.mobile);
  return events && events.some(t => t >= cutoffMs) ? 'verified' : 'no_visit';
}

// mobile -> Zoho deals for that number, trimmed to just what verification
// needs (stage + amount + when it was created).
function buildDealsByMobileForVerification(deals) {
  const map = new Map();
  for (const deal of deals) {
    const mobile = normalizeMobile(deal.Mobile);
    if (!mobile || !deal.Created_Time) continue;
    if (!map.has(mobile)) map.set(mobile, []);
    map.get(mobile).push({
      stage: deal.Stage,
      amount: Number(deal.Amount) || 0,
      createdAtMs: new Date(deal.Created_Time).getTime(),
    });
  }
  return map;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// One row per agent (the sheet's ONLIE EXCUTIVE, not the Zoho deal owner).
// Verified -> Deal / Revenue only look at deals created on/after the same
// meeting date used for the walk-in check, so a deal from months earlier
// can't be credited to a fresh meeting for the same customer.
function buildVerifiedMeetingRows(meetings, walkinIndex, dealsByMobile, todayKey) {
  const rowsByAgent = new Map();
  const getRow = agent => {
    if (!rowsByAgent.has(agent)) {
      rowsByAgent.set(agent, {
        agent, meetingsRaised: 0, verified: 0, noVisit: 0, upcoming: 0,
        verifiedToDeal: 0, revenue: 0,
      });
    }
    return rowsByAgent.get(agent);
  };

  for (const meeting of meetings) {
    const row = getRow(meeting.agent);
    row.meetingsRaised += 1;

    const status = classifyMeeting(meeting, walkinIndex, todayKey);
    if (status === 'upcoming') { row.upcoming += 1; continue; }
    if (status === 'no_visit') { row.noVisit += 1; continue; }

    row.verified += 1;
    const cutoffMs = meeting.dateKey ? istDayStartMs(meeting.dateKey) : -Infinity;
    const wonDeal = (dealsByMobile.get(meeting.mobile) || [])
      .find(d => d.stage === 'Closed Won' && d.createdAtMs >= cutoffMs);
    if (wonDeal) {
      row.verifiedToDeal += 1;
      row.revenue += wonDeal.amount;
    }
  }

  return Array.from(rowsByAgent.values())
    .map(r => ({
      ...r,
      verificationPct: r.meetingsRaised > 0 ? round1((r.verified / r.meetingsRaised) * 100) : 0,
    }))
    .sort((a, b) => b.meetingsRaised - a.meetingsRaised);
}

module.exports = {
  fetchMeetingsFromSheet,
  fetchWalkinIndex,
  buildDealsByMobileForVerification,
  buildVerifiedMeetingRows,
};
