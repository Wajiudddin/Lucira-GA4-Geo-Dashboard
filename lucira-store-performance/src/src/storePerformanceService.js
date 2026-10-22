require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');
const { fetchRecordsSince } = require('./zohoClient');
const gbpClient = require('./gbpClient');
const staffCountStore = require('./staffCountStore');
const {
  STORES, ALL_GA4_CITIES, CONNECTED_CALL_STATUSES, ALL_STORES_KEY, ALL_STORES_DISPLAY_NAME,
} = require('./config/stores');
const { METRICS, SECTIONS } = require('./config/metrics');
const { getComparisonPeriods, bucketDailyMap } = require('./lib/dateWindows');

// Same auth pattern as every other BigQuery-backed service in this repo.
const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

function bqVal(v) {
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}
function toNumber(v) {
  const n = Number(bqVal(v));
  return Number.isFinite(n) ? n : 0;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}

const connectedStatusList = CONNECTED_CALL_STATUSES.map(s => `'${s}'`).join(',');

// --- Query builders -------------------------------------------------------
// Every query is scoped to the queryRange (min start .. max end across the
// three comparison periods) and grouped by day, so a single BigQuery scan
// per source table covers Yesterday + Last Week + Last Month at once —
// bucketing into the three named periods happens in JS afterwards.

// analytics_478308692 is the actual linked GA4 BigQuery export (one table
// per day, `events_YYYYMMDD`, the standard GA4 export schema) — the raw,
// authoritative event-level data, not a downstream ETL copy. Both tables
// previously used here (ga4_data.ga4_data, ga4_dashboard.ga4_fact_sessions)
// turned out to be flawed derivatives of this same underlying data: one
// inflated ~6-10x (item-scoped `sessions`), the other full of gaps. This
// computes sessions the standard GA4-BigQuery way — COUNT(DISTINCT session
// key), session key = user_pseudo_id + the 'ga_session_id' event param —
// and was verified directly against GA4's own reported number: Pune, 17 Sep
// 2026, computed 905 vs GA4 UI's reported 906. Both fresh (this export has
// had a table for every single calendar day from 2025-05-03 to yesterday,
// zero gaps, verified) and correct — no tradeoff needed here, unlike before.
//
// Paid Sessions is expressed as an exclude-list (NOT organic / NOT
// referral/none) rather than an exhaustive include-list of medium values —
// real ad-campaign medium tags are numerous and change over time. Retargeting
// matches source names containing "rtb" or "criteo" (verified actual values:
// 'rtbcom', 'criteo', plus minor tracking-pixel subdomains of criteo.com) —
// not an exact 'RTB'/'CRITEO' match, which verified 0 rows actually use.
// `source`/`medium` are read from event_params (present on the events that
// carry campaign attribution, e.g. session_start) — a session counts under a
// given channel if ANY of its events carries that source/medium, which is
// what grouping the raw (ungrouped-by-session) rows and taking
// COUNT(DISTINCT CASE WHEN ... THEN session_key END) naturally expresses.
function ga4Query(startDate, endDate) {
  const startSuffix = startDate.replace(/-/g, '');
  const endSuffix = endDate.replace(/-/g, '');
  return `
    SELECT
      CONCAT(SUBSTR(event_date, 1, 4), '-', SUBSTR(event_date, 5, 2), '-', SUBSTR(event_date, 7, 2)) AS event_date,
      CASE
        WHEN city = 'Mumbai' THEN 'mumbai'
        WHEN city IN ('Delhi', 'New Delhi') THEN 'delhi'
        WHEN city = 'Pune' THEN 'pune'
        WHEN city = 'Noida' THEN 'noida'
        WHEN city = 'Bengaluru' THEN 'bengaluru'
      END AS city_group,
      COUNT(DISTINCT session_key) AS city_sessions,
      COUNT(DISTINCT CASE
        WHEN LOWER(source) = 'google' AND COALESCE(LOWER(medium), '') != 'organic' THEN session_key
        WHEN LOWER(source) IN ('facebook', 'fb', 'ig') AND COALESCE(LOWER(medium), '') NOT IN ('referral', '(none)', '') THEN session_key
        WHEN LOWER(source) = 'broadcast' THEN session_key
        WHEN LOWER(source) = 'trigger' THEN session_key
      END) AS paid_sessions,
      COUNT(DISTINCT CASE WHEN LOWER(source) LIKE '%rtb%' OR LOWER(source) LIKE '%criteo%' THEN session_key END) AS retargeting_sessions,
      COUNT(DISTINCT CASE WHEN LOWER(source) IN ('broadcast', 'trigger') THEN session_key END) AS communication_sessions
    FROM (
      SELECT
        event_date,
        CONCAT(user_pseudo_id, '-', CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS STRING)) AS session_key,
        geo.city AS city,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'source') AS source,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'medium') AS medium
      FROM \`lucirajewelry-prod.analytics_478308692.events_*\`
      WHERE _TABLE_SUFFIX BETWEEN '${startSuffix}' AND '${endSuffix}'
    )
    WHERE city IN (${ALL_GA4_CITIES.map(c => `'${c}'`).join(',')})
    GROUP BY event_date, city_group
  `;
}

// Which day-tables (events_YYYYMMDD) actually exist in range — this export
// has had zero gaps for 500+ consecutive days (verified), but checking
// per-day existence (not just assuming it) keeps the same honest-freshness
// guarantee the rest of this dashboard has, in case that ever changes.
function ga4CoverageQuery(startDate, endDate) {
  const startSuffix = startDate.replace(/-/g, '');
  const endSuffix = endDate.replace(/-/g, '');
  return `
    SELECT DISTINCT _TABLE_SUFFIX AS suffix
    FROM \`lucirajewelry-prod.analytics_478308692.events_*\`
    WHERE _TABLE_SUFFIX BETWEEN '${startSuffix}' AND '${endSuffix}'
  `;
}

// Deal_Owner is a clean, one-value-per-store-team field (verified — no
// fuzzing needed, unlike the meetings Venue text). Call_Type = 'Outbound'
// scopes this to store-dialed calls, matching "Store Calls Dialed"; talktime
// is kept in seconds (not pre-converted) so the frontend can format it as
// "Xh Ym Zs".
//
// Calls come from the live Zoho CRM API (Calls module), not BigQuery — the
// BigQuery export (Lucira_Prod.lucira_zoho_Calls) lags several days behind
// (verified: its sync has, at times, only reached 3+ days before "today"),
// while the live API is current to the minute (verified: fetched a call
// created seconds before the request). This reuses the same zohoClient.js
// (`fetchRecordsSince`) every other dashboard in this app already uses for
// live Zoho data — same OAuth/token-refresh path, no new credentials.
// `Owner.name` on a live Call record is the same team-owner string as
// Deal_Owner was in the BigQuery export (verified: all 7 store team names —
// 'Borivali Team', 'Chembur Store', 'Malleshwaram Store', etc. — appear
// directly on Call.Owner).
const ZOHO_CALL_FIELDS = ['Owner', 'Call_Type', 'Call_Start_Time', 'Call_Duration_in_seconds', 'Call_Status', 'Created_Time'];

async function fetchZohoCallsRaw(startDateKey) {
  // Created_Time and Call_Start_Time are seconds apart in practice, but
  // pagination stops on Created_Time — a small day-of buffer before the
  // real window start keeps a call created just before midnight from being
  // cut off, at the cost of fetching (and then discarding) a few extra rows.
  const stopBeforeISO = new Date(`${startDateKey}T00:00:00+05:30`).toISOString();
  return withZohoRetry(() => fetchRecordsSince('Calls', ZOHO_CALL_FIELDS, { sortField: 'Created_Time', stopBeforeISO }));
}

// A month-wide window means dozens of sequential paginated requests to
// Zoho — verified directly that a lone transient ECONNRESET on one page can
// happen and would otherwise fail the whole group; a couple of retries
// absorbs that without masking a real, persistent failure (which still
// surfaces as "Data unavailable" after they're exhausted).
async function withZohoRetry(taskFn) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await taskFn();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
  throw lastErr;
}

// Deals has no reliable per-store field — Store_Assigned and Store_Name are
// verified 0% populated (0 of 8774 deals over ~35 days), Store_Executive is
// 1-in-8774. Address_City IS populated (~57% of deals) with real city/district
// values, so deals are bucketed by city group (same grain GA4 already uses
// for sessions) and, for a shared group (Mumbai: Borivali+Chembur; Delhi:
// Paschim Vihar+Lajpat Nagar), split evenly across the stores sharing it —
// an explicit, disclosed approximation (see METRICS.dataNote), not a fabricated
// per-store number. Zoho's Address_City for Delhi comes back as NCT
// sub-districts ("Central Delhi", "South Delhi", "East Delhi", "South West
// Delhi", "North Delhi", "West Delhi", ...), not a single "Delhi" value
// (verified directly), so the delhi group matches on "contains delhi" rather
// than an exact list. "Noida" appears as its own exact value. Deals whose
// Address_City isn't one of these 4 groups (Bengaluru, Hyderabad, Thane,
// online orders with no city, etc.) are real deals but not attributable to
// any of the 6 physical stores, so they're correctly excluded, not counted
// as 0 fabricated activity.
function dealCityGroup(addressCity) {
  if (!addressCity) return null;
  const c = addressCity.trim().toLowerCase();
  if (c === 'mumbai') return 'mumbai';
  if (c === 'pune') return 'pune';
  if (c === 'noida') return 'noida';
  if (c === 'bengaluru') return 'bengaluru';
  if (c.includes('delhi')) return 'delhi';
  return null;
}

const ZOHO_DEAL_FIELDS = ['Address_City', 'Created_Time'];

async function fetchZohoDealsRaw(startDateKey) {
  const stopBeforeISO = new Date(`${startDateKey}T00:00:00+05:30`).toISOString();
  return withZohoRetry(() => fetchRecordsSince('Deals', ZOHO_DEAL_FIELDS, { sortField: 'Created_Time', stopBeforeISO }));
}

// ds_imputed_reporting.ads_spend_live_city_daily — a single table carrying
// BOTH Google Ads and Meta Ads spend, one row per campaign per resolved city
// per day per platform. Replaces two previously-separate sources (a direct
// Google Ads BigQuery join, and a live Meta Graph API call requiring its own
// OAuth token) with one unified, verified source:
//   - Reconciled directly against the previously-used Google Ads source
//     (google_ads.ads_CampaignBasicStats_2348623547) for 2026-09-28: 81,475.24
//     here vs 81,462.03 there — a 0.02% difference, consistent with normal
//     between-pipeline rounding, not a real discrepancy.
//   - campaign_name is NEVER null here (verified — 0 of ~1.86M Google rows,
//     0 of ~168K Meta rows), unlike a sibling table (marketing_ads_geo_daily)
//     also tried and rejected for having a NULL campaign_name on 100% of its
//     Google rows, which silently broke store attribution despite an
//     accurate-looking total.
//   - Fresher than a view previously used here (v_marketing_ads_daily):
//     Meta verified through the SAME day as Google (2026-09-30), not a
//     3-day-lagged copy — no Meta API/token needed at all either way.
// campaign_name + spend are pulled through unchanged and run through this
// app's OWN adsAttribution() keyword classifier below — the table's own
// city/state/city_attributed columns are deliberately NOT used (see the
// comment above adsAttribution() for why — that column is a "where did the
// click come from" field, not a campaign-targeting one, and using it for
// store attribution was tried and reverted as a real correctness bug).
// A campaign can appear as several rows per day here (one per resolved
// city) — GROUP BY collapses that back to one true total per campaign/day,
// same as this app has always needed.
function marketingAdsSpendQuery(startDate, endDate) {
  return `
    SELECT campaign_name, date AS event_date, SUM(spend) AS cost_inr
    FROM \`lucirajewelry-prod.ds_imputed_reporting.ads_spend_live_city_daily\`
    WHERE date BETWEEN '${startDate}' AND '${endDate}' AND campaign_name IS NOT NULL
    GROUP BY campaign_name, date
  `;
}

// Spend attribution: campaign_name is checked for explicit city/store
// keywords the marketing team already uses in its own naming convention —
// verified against the full campaign list on BOTH platforms (Google Ads:
// "offline_mof_all_chembur_acqn_search-gmb"; Meta: "offline_tof_mumbai_
// chembur_acqn_video{Chembur Store}", "offline_tof_bangalore_malleswaram_
// acqn_iform") — the same team uses the same convention on both, so one
// classifier serves both platforms.
//
// Meta's names are messier than Google's: a single campaign often names
// SEVERAL stores at once (e.g. "mumbai-pune-noida_...borivali-chembur-
// jmroad-india_..."), unlike Google's mostly one-store-per-campaign names.
// So every specific store keyword actually present is collected into a set
// and the cost is split evenly across all of them — a campaign naming only
// "chembur" still gets 100% to Chembur (a set of 1), same as before.
//
// A generic city keyword (mumbai/delhi, which map to 2 stores each) is only
// consulted as a fallback for that city group specifically, and only if
// NEITHER store in that group was already named specifically — e.g.
// "mumbai_borivali_..." matches Borivali only (mumbai here is just a
// category prefix ahead of the specific store); "mumbai-pune-noida_..." has
// no specific Mumbai store named, so mumbai's generic keyword pulls in both
// Borivali AND Chembur alongside the specifically-named Pune and Noida.
//
// Campaigns with no city/store signal at all — the majority: "AllCategories",
// "MetroCities", "PAN India", generic Shopping/Search/Pmax/retargeting feeds
// — are real spend but not attributable to any of the 7 stores, so they're
// excluded from every store's total AND from "All Stores" (this is store/
// city-attributable spend, not the company's full ad spend — see
// METRICS.dataNote on 'spend'). Name-matching is also a weaker signal than a
// verified targeting field: a campaign named for a city is presumed, not
// proven, to be geo-restricted there — disclosed for the same reason.
const ADS_STORE_KEYWORDS = {
  chembur: ['chembur'],
  borivali: ['borivali'],
  noida: ['noida'],
  paschimVihar: ['paschim_vihar', 'paschim vihar', 'paschimvihar'],
  lajpatNagar: ['lajpat'],
  pune: ['pune', 'jmroad', 'jm road'],
  malleshwaram: ['bangalore', 'bengaluru', 'malleshwaram', 'malleswaram'],
};
const ADS_CITYGROUP_FALLBACK = {
  mumbai: { keywords: ['mumbai'], stores: ['borivali', 'chembur'] },
  delhi: { keywords: ['delhi'], stores: ['paschimVihar', 'lajpatNagar'] },
};
function adsAttribution(campaignName) {
  const name = (campaignName || '').toLowerCase();
  const matched = new Set();
  for (const [storeKey, keywords] of Object.entries(ADS_STORE_KEYWORDS)) {
    if (keywords.some(k => name.includes(k))) matched.add(storeKey);
  }
  for (const group of Object.values(ADS_CITYGROUP_FALLBACK)) {
    const alreadySpecific = group.stores.some(s => matched.has(s));
    if (!alreadySpecific && group.keywords.some(k => name.includes(k))) {
      group.stores.forEach(s => matched.add(s));
    }
  }
  return matched.size ? { keys: [...matched] } : null;
}

// A city-based fallback (using this table's own city/city_attributed
// columns instead of the name classifier above) was tried and reverted:
// verified that column is the platform's standard "user/conversion
// location" reporting dimension — WHERE the person who clicked physically
// was — not a campaign-targeting field. A pan-India campaign run for the
// whole country still gets city_attributed=true rows for wherever real
// clicks happened to come from (confirmed: over 100 distinct Indian
// cities show up this way for a single day, including cities with no
// Lucira store at all — Hyderabad, Kolkata, Jaipur, Gurugram, etc.).
// Attributing spend to a store because a pan-India ad happened to get a
// click from that city would be a real correctness bug, not a refinement —
// a campaign's own NAME (checked above) is the only signal here that
// reflects actual marketing intent.

// Computes a per-period ratio metric (e.g. Cost Per Session) from two
// already-bucketed metric-value objects. Unavailable propagates from either
// side (a failed source shouldn't silently read as "spend was 0"); a zero or
// missing denominator returns null (rendered "—"), never Infinity/NaN.
function ratioMetric(numMetric, denomMetric) {
  if ((numMetric && numMetric.unavailable) || (denomMetric && denomMetric.unavailable)) {
    return { yesterday: null, lastWeek: null, lastMonth: null, unavailable: true };
  }
  const out = {};
  for (const p of ['yesterday', 'lastWeek', 'lastMonth']) {
    const num = numMetric ? numMetric[p] : null;
    const den = denomMetric ? denomMetric[p] : null;
    out[p] = (num == null || den == null || !den) ? null : round2(num / den);
  }
  return out;
}

function allShortCodes() {
  return STORES.filter(s => s.shortCode).flatMap(s => [s.shortCode, ...(s.extraShortCodes || [])]);
}

function walkinsQuery(startDate, endDate) {
  const codes = allShortCodes().map(c => `'${c}'`).join(',');
  return `
    SELECT
      store_code,
      DATE(SAFE.PARSE_DATETIME('%Y-%m-%d %H:%M:%S', walkin_date)) AS walkin_day,
      COUNT(*) AS walkins
    FROM \`lucirajewelry-prod.ds_imputed_reporting.Walkin_marge\`
    WHERE store_code IN (${codes})
      AND SAFE.PARSE_DATETIME('%Y-%m-%d %H:%M:%S', walkin_date) IS NOT NULL
      AND DATE(SAFE.PARSE_DATETIME('%Y-%m-%d %H:%M:%S', walkin_date)) BETWEEN '${startDate}' AND '${endDate}'
    GROUP BY store_code, walkin_day
  `;
}

// Channel = 'Store' restricts this to in-store sales (online orders aren't
// attributable to a physical store); document_no is distinct-counted so a
// multi-line order counts once, not once per line item.
function ordersQuery(startDate, endDate) {
  const codes = allShortCodes().map(c => `'${c}'`).join(',');
  return `
    SELECT
      company_code AS store_code,
      Transaction_Date AS txn_date,
      COUNT(DISTINCT document_no) AS orders,
      SUM(net_sale) AS revenue
    FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
    WHERE Channel = 'Store'
      AND company_code IN (${codes})
      AND Transaction_Date BETWEEN '${startDate}' AND '${endDate}'
    GROUP BY store_code, txn_date
  `;
}

// Point-in-time snapshot, not scoped to any window. `location_name =
// 'Finish Goods'` is the saleable-stock location for 6 of the 7 stores —
// Malleshwaram has no entry in this table at all (verified), so its
// inventoryStoreName is left null and its Inventory metric shows
// unavailable rather than a fabricated 0. Each of the other 6 stores has its
// own distinct Store_name entity (verified directly, not assumed): Chembur
// is 'HWI VENTURES'; Borivali, Pune, Noida, Paschim Vihar and Lajpat Nagar
// are each 'Divinecarat Lifestyles Private Limited (<Store>)' — a per-store
// suffixed variant, distinct from the unsuffixed 'Divinecarat Lifestyles
// Private Limited' (a separate, shared/pooled entity whose location_name
// breaks out small quantities per store under non-'Finish Goods' labels —
// correctly excluded here, since it isn't any one store's saleable stock).
// Noida's saleable stock is split across two location_name buckets under its
// own Store_name — 'Finish Goods' (353 pieces) and 'Wave Noida' (360 pieces,
// the Wave Mall counter) — verified directly (713 total matches Live_inventory
// as seen by the store team). Every other store only ever uses 'Finish Goods'.
// Including 'Wave Noida' here is safe for the other stores too: it only
// matches rows whose Store_name is also in our IN-list, and the only other
// 'Wave Noida' row in the table (2 pieces) sits under the generic, unsuffixed
// 'Divinecarat Lifestyles Private Limited' entity, which isn't in that list.
function inventoryQuery() {
  const names = STORES.filter(s => s.inventoryStoreName).map(s => `'${s.inventoryStoreName.replace(/'/g, "''")}'`).join(',');
  return `
    SELECT Store_name, SUM(pieces) AS inventory_pieces
    FROM \`lucirajewelry-prod.ds_imputed_reporting.Live_inventory\`
    WHERE location_name IN ('Finish Goods', 'Wave Noida')
      AND Store_name IN (${names})
    GROUP BY Store_name
  `;
}

// cdc_meetings.data is a JSON blob synced from Zoho's Meeting activity;
// owner_name/created_time are already extracted as native columns. Fetching
// the (small) window and matching store in JS is simpler than expressing
// the fuzzy Venue match in SQL (Venue is free text with typos, e.g. "Chmebur").
function meetingsQuery(startDate, endDate) {
  return `
    SELECT
      owner_name,
      created_time,
      JSON_VALUE(data, '$.Venue') AS venue
    FROM \`lucirajewelry-prod.zoho_crm.cdc_meetings\`
    WHERE created_time >= TIMESTAMP('${startDate}T00:00:00+05:30')
      AND created_time < TIMESTAMP('${addDaysISO(endDate, 1)}T00:00:00+05:30')
  `;
}
function addDaysISO(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + delta * 86400000).toISOString().slice(0, 10);
}

function matchMeetingStore(ownerName, venue) {
  const byOwner = STORES.find(s => s.dealOwner === ownerName);
  if (byOwner) return byOwner.key;
  const v = (venue || '').toLowerCase();
  if (/borivali|boriwali/.test(v)) return 'borivali';
  if (/chembur|chmebur/.test(v)) return 'chembur';
  if (/pune/.test(v)) return 'pune';
  if (/paschim|pashcim|pashchim/.test(v)) return 'paschimVihar';
  if (/noida/.test(v)) return 'noida';
  if (/lajpat/.test(v)) return 'lajpatNagar';
  return null;
}

// --- Aggregation helpers ---------------------------------------------------

function istDateKeyFromRaw(raw) {
  // BigQuery DATE values arrive as 'YYYY-MM-DD' strings already; TIMESTAMP
  // values need the same +5:30 shift used everywhere else in this file.
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const shifted = new Date(new Date(raw).getTime() + 5.5 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function emptyMapPerKey(keys) {
  const m = new Map();
  keys.forEach(k => m.set(k, new Map()));
  return m;
}
function bump(dailyMapForKey, dateKey, value) {
  dailyMapForKey.set(dateKey, (dailyMapForKey.get(dateKey) || 0) + value);
}
function mergeDailyMaps(maps) {
  const out = new Map();
  maps.forEach(m => m.forEach((v, k) => bump(out, k, v)));
  return out;
}

function metricValue(dailyMap, periods, { round = n => Math.round(n), pending = false, unavailable = false, snapshot = false, snapshotValue = null, avgPerDay = false } = {}) {
  if (pending) return { yesterday: null, lastWeek: null, lastMonth: null, pending: true };
  if (unavailable) return { yesterday: null, lastWeek: null, lastMonth: null, unavailable: true };
  if (snapshot) return { yesterday: snapshotValue, lastWeek: snapshotValue, lastMonth: snapshotValue, snapshot: true };
  const bucketed = bucketDailyMap(dailyMap, periods, avgPerDay ? (n => n) : round);
  if (!avgPerDay) return bucketed;
  // Last Week/Last Month become a per-day average (real calendar day count —
  // 7 for a week, 28-31 for a month — never hardcoded), not the period
  // total. Yesterday is already a single day, so it's left as-is, just
  // rounded the normal way.
  return {
    yesterday: round(bucketed.yesterday),
    lastWeek: round(bucketed.lastWeek / expectedDays(periods.lastWeek).length),
    lastMonth: round(bucketed.lastMonth / expectedDays(periods.lastMonth).length),
  };
}

// Runs every source group independently (Promise.allSettled, not
// Promise.all) so one failing source — a transient BigQuery error, a Zoho
// API/token error, a timeout — degrades only the metrics it feeds, not the
// whole dashboard. Each group is a task function returning an array of rows
// (BigQuery groups wrap `bigquery.query`; the Calls group wraps the live
// Zoho API fetch instead — same interface either way). Failed groups come
// back as an empty row set plus their name in `failed`; callers mark the
// affected metrics "Data unavailable" instead of computing (and definitely
// instead of showing a fabricated 0).
async function runSourceGroups(taskFns) {
  const names = Object.keys(taskFns);
  const settled = await Promise.allSettled(names.map(n => taskFns[n]()));
  const rows = {};
  const failed = new Set();
  settled.forEach((result, i) => {
    const name = names[i];
    if (result.status === 'fulfilled') {
      rows[name] = result.value;
    } else {
      rows[name] = [];
      failed.add(name);
      console.error(`store-performance: source group "${name}" failed:`, result.reason);
    }
  });
  return { rows, failed };
}
function bq(sql) {
  return () => bigquery.query({ query: sql }).then(([rows]) => rows);
}

// Which calendar days a period expects (inclusive) — used to measure how
// much of a period ga4_dashboard.ga4_fact_sessions' gaps actually cover.
function expectedDays(period) {
  const out = [];
  for (let d = period.start; d <= period.end; d = addDaysISO(d, 1)) out.push(d);
  return out;
}
function periodCoverage(period, coveredDatesSet) {
  const expected = expectedDays(period);
  const covered = expected.filter(d => coveredDatesSet.has(d)).length;
  return { expectedDays: expected.length, coveredDays: covered };
}

async function buildStorePerformanceDashboard() {
  const { today, periods, queryRange } = getComparisonPeriods();
  // City/Paid/Retargeting/Communication Sessions alone get their own
  // "Yesterday" (today-2, not today-1) — by explicit request. Every other
  // metric uses `periods` above (today-1). Last Week / Last Month are
  // identical between the two — only `.yesterday` differs. `queryRange`
  // above (built from the later today-1 date) already covers today-2 too,
  // so this doesn't need its own BigQuery scan.
  const { periods: ga4Periods } = getComparisonPeriods(today, 2);

  // Manually entered, not queried from anywhere — see staffCountStore.js.
  // A read failure here degrades to "nothing entered yet" (blank inputs),
  // not a fabricated value and not a whole-dashboard failure over one
  // non-critical, user-editable metric.
  let staffCounts = {};
  try {
    staffCounts = await staffCountStore.readAll();
  } catch (err) {
    console.error('store-performance: staff count read failed:', err);
  }

  const { rows, failed: failedGroups } = await runSourceGroups({
    ga4: bq(ga4Query(queryRange.start, queryRange.end)),
    ga4Coverage: bq(ga4CoverageQuery(queryRange.start, queryRange.end)),
    calls: () => fetchZohoCallsRaw(queryRange.start),
    deals: () => fetchZohoDealsRaw(queryRange.start),
    walkins: bq(walkinsQuery(queryRange.start, queryRange.end)),
    orders: bq(ordersQuery(queryRange.start, queryRange.end)),
    inventory: bq(inventoryQuery()),
    meetings: bq(meetingsQuery(queryRange.start, queryRange.end)),
    ads: bq(marketingAdsSpendQuery(queryRange.start, queryRange.end)),
    gbp: () => gbpClient.fetchAllStoreData(STORES, queryRange.start, queryRange.end),
  });
  const ga4Rows = rows.ga4, ga4CoverageRows = rows.ga4Coverage, callRows = rows.calls, dealRows = rows.deals,
    walkinRows = rows.walkins, orderRows = rows.orders, inventoryRows = rows.inventory, meetingRows = rows.meetings,
    adsRows = rows.ads;
  const gbpByStore = rows.gbp instanceof Map ? rows.gbp : new Map();

  // Each row is a 'YYYYMMDD' _TABLE_SUFFIX for a day-table that exists —
  // converted back to 'YYYY-MM-DD' to match this file's date-key convention
  // everywhere else. This export has had zero gaps for 500+ consecutive
  // days (verified directly), but checking per-day existence rather than
  // assuming it keeps the same honest-freshness guarantee as every other
  // source here, in case that ever changes.
  const ga4CoveredDates = new Set(
    ga4CoverageRows.map(r => bqVal(r.suffix)).map(s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`),
  );
  const sortedGa4Dates = [...ga4CoveredDates].sort();
  const ga4MinDate = sortedGa4Dates.length ? sortedGa4Dates[0] : null;
  const ga4MaxDate = sortedGa4Dates.length ? sortedGa4Dates[sortedGa4Dates.length - 1] : null;
  const ga4Coverage = {
    yesterday: periodCoverage(ga4Periods.yesterday, ga4CoveredDates),
    lastWeek: periodCoverage(ga4Periods.lastWeek, ga4CoveredDates),
    lastMonth: periodCoverage(ga4Periods.lastMonth, ga4CoveredDates),
  };
  const ga4Stale = Object.values(ga4Coverage).some(c => c.coveredDays < c.expectedDays);

  // GA4 rows are per city_group, not per store — fanned out to every store
  // that shares the group when building each store's payload below, and
  // summed once per unique group (not once per store) for the "All Stores"
  // aggregate so Mumbai/Delhi's shared figure isn't double-counted.
  const ga4ByGroup = new Map(); // cityGroup -> field -> Map(dateKey -> value)
  const GA4_FIELDS = [
    ['citySessions', 'city_sessions'], ['paidSessions', 'paid_sessions'],
    ['retargetingSessions', 'retargeting_sessions'], ['communicationSessions', 'communication_sessions'],
  ];
  for (const row of ga4Rows) {
    const group = bqVal(row.city_group);
    if (!group) continue;
    const dateKey = bqVal(row.event_date);
    if (!ga4ByGroup.has(group)) {
      const perField = new Map();
      GA4_FIELDS.forEach(([k]) => perField.set(k, new Map()));
      ga4ByGroup.set(group, perField);
    }
    const perField = ga4ByGroup.get(group);
    GA4_FIELDS.forEach(([metricKey, col]) => bump(perField.get(metricKey), dateKey, toNumber(row[col])));
  }

  const storeKeys = STORES.map(s => s.key);
  // Shared by Deals and Spend below — both bucket by cityGroup and split a
  // shared group's total evenly across however many stores share it (2 for
  // Mumbai/Delhi, 1 for Pune/Noida — computed from STORES, not hardcoded).
  const storesPerGroup = new Map();
  STORES.forEach(s => storesPerGroup.set(s.cityGroup, (storesPerGroup.get(s.cityGroup) || 0) + 1));

  const callsDialed = emptyMapPerKey(storeKeys);
  const callsConnected = emptyMapPerKey(storeKeys);
  const callsConnected30s = emptyMapPerKey(storeKeys);
  const talktimeSeconds = emptyMapPerKey(storeKeys);
  const storeByOwner = new Map(STORES.map(s => [s.dealOwner, s.key]));
  const connectedStatusSet = new Set(CONNECTED_CALL_STATUSES);
  for (const call of callRows) {
    const key = storeByOwner.get(call.Owner && call.Owner.name);
    if (!key || call.Call_Type !== 'Outbound') continue;
    // Call_Start_Time/Created_Time from the live API are ISO strings already
    // carrying the +05:30 offset, so the first 10 chars are the IST calendar
    // date directly — no separate timezone shift needed (unlike the old
    // BigQuery export's plain-string Call_Start_Time).
    const rawTime = call.Call_Start_Time || call.Created_Time;
    if (!rawTime) continue;
    const dateKey = rawTime.slice(0, 10);
    if (dateKey < queryRange.start || dateKey > queryRange.end) continue;
    bump(callsDialed.get(key), dateKey, 1);
    const connected = connectedStatusSet.has(call.Call_Status);
    const duration = toNumber(call.Call_Duration_in_seconds);
    if (connected) {
      bump(callsConnected.get(key), dateKey, 1);
      bump(talktimeSeconds.get(key), dateKey, duration);
      if (duration > 30) bump(callsConnected30s.get(key), dateKey, 1);
    }
  }

  // Deals has no per-store field (see fetchZohoDealsRaw) — bucket by city
  // group first, exactly like GA4 sessions, then split each group's daily
  // count evenly across however many stores share that group (2 for
  // Mumbai/Delhi, 1 for Pune/Noida/Bengaluru — computed from STORES, not hardcoded, so
  // this keeps working if a 7th store is ever added to a shared group).
  const dealsByGroup = new Map(); // cityGroup -> Map(dateKey -> count)
  for (const deal of dealRows) {
    const group = dealCityGroup(bqVal(deal.Address_City));
    if (!group) continue;
    const dateKey = (deal.Created_Time || '').slice(0, 10);
    if (!dateKey || dateKey < queryRange.start || dateKey > queryRange.end) continue;
    if (!dealsByGroup.has(group)) dealsByGroup.set(group, new Map());
    bump(dealsByGroup.get(group), dateKey, 1);
  }
  const deals = emptyMapPerKey(storeKeys);
  STORES.forEach(s => {
    const groupDaily = dealsByGroup.get(s.cityGroup);
    if (!groupDaily) return;
    const splitFactor = 1 / storesPerGroup.get(s.cityGroup);
    const storeDaily = deals.get(s.key);
    groupDaily.forEach((count, dateKey) => bump(storeDaily, dateKey, count * splitFactor));
  });

  // adsRows already carries both platforms (see marketingAdsSpendQuery) —
  // one pass through the same classifier (adsAttribution) gives a true
  // combined total per store, not just Google's.
  const spend = emptyMapPerKey(storeKeys);
  function applyAdSpend(campaignName, dateKey, cost) {
    if (!dateKey || dateKey < queryRange.start || dateKey > queryRange.end) return;
    const attribution = adsAttribution(campaignName);
    if (!attribution) return;
    const factor = 1 / attribution.keys.length;
    attribution.keys.forEach(storeKey => bump(spend.get(storeKey), dateKey, cost * factor));
  }
  for (const row of adsRows) {
    applyAdSpend(bqVal(row.campaign_name), bqVal(row.event_date), toNumber(row.cost_inr));
  }

  const walkins = emptyMapPerKey(storeKeys);
  const storeByCode = new Map(STORES.flatMap(s => [[s.shortCode, s.key], ...(s.extraShortCodes || []).map(c => [c, s.key])]));
  for (const row of walkinRows) {
    const key = storeByCode.get(bqVal(row.store_code));
    if (!key) continue;
    bump(walkins.get(key), bqVal(row.walkin_day), toNumber(row.walkins));
  }

  const orders = emptyMapPerKey(storeKeys);
  const revenue = emptyMapPerKey(storeKeys);
  for (const row of orderRows) {
    const key = storeByCode.get(bqVal(row.store_code));
    if (!key) continue;
    const dateKey = bqVal(row.txn_date);
    bump(orders.get(key), dateKey, toNumber(row.orders));
    bump(revenue.get(key), dateKey, toNumber(row.revenue));
  }

  const inventoryByStoreName = new Map();
  for (const row of inventoryRows) {
    inventoryByStoreName.set(bqVal(row.Store_name), toNumber(row.inventory_pieces));
  }

  const meetingsRaised = emptyMapPerKey(storeKeys);
  let unmappedMeetingsCount = 0;
  for (const row of meetingRows) {
    const key = matchMeetingStore(bqVal(row.owner_name), bqVal(row.venue));
    const createdRaw = bqVal(row.created_time);
    const dateKey = createdRaw ? istDateKeyFromRaw(createdRaw) : null;
    if (!key || !dateKey) { unmappedMeetingsCount += 1; continue; }
    bump(meetingsRaised.get(key), dateKey, 1);
  }

  function buildMetricsFor(storeKey, ga4DailyByField, storeObj) {
    const out = {};
    // Raw (non-averaged) period totals, needed internally for the Cost
    // Per-X ratios below even though their matching display metrics
    // (Spend, City Sessions, Deals, Meetings Raised) now show an avg/day
    // figure on screen. Stashed onto `out` under double-underscore keys so
    // the "All Stores" recompute after this function returns can reuse them
    // too — deleted before the response is sent (see buildStorePerformanceDashboard).
    let dealsRawTotal, meetingsRawTotal, citySessionsRawTotal, spendRawTotal;
    for (const def of METRICS) {
      if (def.pending) { out[def.key] = metricValue(null, periods, { pending: true }); continue; }
      if (def.sourceGroup && failedGroups.has(def.sourceGroup)) { out[def.key] = metricValue(null, periods, { unavailable: true }); continue; }
      // Malleshwaram (so far the only store like this) has no store_code in
      // Walkin_marge/marketing_sale — an empty daily map would otherwise
      // silently compute a real-looking 0 for these 3, which would read as
      // "zero walk-ins/orders ever" rather than "not tracked here."
      if (storeObj && !storeObj.shortCode && (def.key === 'walkins' || def.key === 'orders' || def.key === 'revenue')) {
        out[def.key] = metricValue(null, periods, { unavailable: true }); continue;
      }
      switch (def.key) {
        // .get(storeKey) is undefined for the synthetic 'all' key (it isn't
        // a real store) — buildMetricsFor's caller overwrites these with
        // the true cross-store sum right after, so an empty map here is
        // just a safe placeholder, never the value actually returned.
        // City Sessions/Deals/Meetings Raised/Spend feed the Cost Per-X
        // ratios below, which need the real PERIOD TOTAL, not the avg/day
        // figure shown on screen — computed once here and reused, never
        // re-derived from the (now averaged) displayed value.
        case 'citySessions': {
          const rawMap = ga4DailyByField.get(def.key);
          citySessionsRawTotal = metricValue(rawMap, ga4Periods);
          out[def.key] = metricValue(rawMap, ga4Periods, { avgPerDay: true });
          break;
        }
        case 'paidSessions': case 'retargetingSessions': case 'communicationSessions':
          out[def.key] = metricValue(ga4DailyByField.get(def.key), ga4Periods, { avgPerDay: true });
          break;
        case 'deals': {
          const rawMap = deals.get(storeKey) || new Map();
          dealsRawTotal = metricValue(rawMap, periods);
          out[def.key] = metricValue(rawMap, periods, { avgPerDay: true });
          break;
        }
        case 'meetingsRaised': {
          const rawMap = meetingsRaised.get(storeKey) || new Map();
          meetingsRawTotal = metricValue(rawMap, periods);
          out[def.key] = metricValue(rawMap, periods, { avgPerDay: true });
          break;
        }
        case 'walkins': out[def.key] = metricValue(walkins.get(storeKey) || new Map(), periods, { avgPerDay: true }); break;
        case 'orders': out[def.key] = metricValue(orders.get(storeKey) || new Map(), periods, { avgPerDay: true }); break;
        case 'revenue': out[def.key] = metricValue(revenue.get(storeKey) || new Map(), periods, { round: round2, avgPerDay: true }); break;
        case 'callsDialed': out[def.key] = metricValue(callsDialed.get(storeKey) || new Map(), periods, { avgPerDay: true }); break;
        case 'callsConnected': out[def.key] = metricValue(callsConnected.get(storeKey) || new Map(), periods, { avgPerDay: true }); break;
        case 'callsConnected30s': out[def.key] = metricValue(callsConnected30s.get(storeKey) || new Map(), periods, { avgPerDay: true }); break;
        case 'talktimeSeconds': out[def.key] = metricValue(talktimeSeconds.get(storeKey) || new Map(), periods, { avgPerDay: true }); break;
        case 'spend': {
          const rawMap = spend.get(storeKey) || new Map();
          spendRawTotal = metricValue(rawMap, periods, { round: round2 });
          out[def.key] = metricValue(rawMap, periods, { round: round2, avgPerDay: true });
          break;
        }
        case 'costPerSession': out[def.key] = ratioMetric(spendRawTotal, citySessionsRawTotal); break;
        case 'costPerDeal': out[def.key] = ratioMetric(spendRawTotal, dealsRawTotal); break;
        case 'costPerAppointment': out[def.key] = ratioMetric(spendRawTotal, meetingsRawTotal); break;
        case 'inventory':
          // Placeholder — every caller overwrites this immediately after
          // buildMetricsFor() returns, with the real snapshot value (a
          // point-in-time sum, not something bucketed from a daily map).
          out[def.key] = metricValue(null, periods, { pending: true });
          break;
        // Google Business Profile metrics — gbpByStore.get(storeKey) is
        // undefined for the synthetic 'all' key (overwritten right after
        // buildMetricsFor() returns, same pattern as deals/meetings above),
        // and can also be a per-store {error} if that one location's API
        // calls failed (e.g. Malleshwaram still "Processing" as of writing)
        // even though the group as a whole succeeded — both cases show
        // unavailable, never a fabricated 0/blank.
        case 'gmbStrength': {
          const d = gbpByStore.get(storeKey);
          out[def.key] = (!d || d.error || d.strength == null)
            ? metricValue(null, periods, { unavailable: true })
            : metricValue(null, periods, { snapshot: true, snapshotValue: d.strength });
          break;
        }
        case 'googleReviews': {
          const d = gbpByStore.get(storeKey);
          out[def.key] = (!d || d.error || d.totalReviewCount == null)
            ? metricValue(null, periods, { unavailable: true })
            : metricValue(null, periods, { snapshot: true, snapshotValue: d.totalReviewCount });
          break;
        }
        case 'googleRating': {
          const d = gbpByStore.get(storeKey);
          out[def.key] = (!d || d.error || d.averageRating == null)
            ? metricValue(null, periods, { unavailable: true })
            : metricValue(null, periods, { snapshot: true, snapshotValue: round1(d.averageRating) });
          break;
        }
        case 'storeDirectionClicks': {
          const d = gbpByStore.get(storeKey);
          out[def.key] = (!d || d.error)
            ? metricValue(null, periods, { unavailable: true })
            : metricValue(d.directionRequests || new Map(), periods, { avgPerDay: true });
          break;
        }
        case 'storeIncomingCalls': {
          const d = gbpByStore.get(storeKey);
          out[def.key] = (!d || d.error)
            ? metricValue(null, periods, { unavailable: true })
            : metricValue(d.callClicks || new Map(), periods, { avgPerDay: true });
          break;
        }
        // Manually entered (see staffCountStore.js) — null until the user
        // fills it in for this store, never a fabricated 0. Not "unavailable"
        // (that implies a broken source); the frontend renders an editable
        // input for this one specifically, blank until set.
        case 'staffCount': {
          const entry = staffCounts[storeKey];
          out[def.key] = metricValue(null, periods, { snapshot: true, snapshotValue: entry ? entry.count : null });
          break;
        }
        default:
          out[def.key] = metricValue(null, periods, { pending: true });
      }
    }
    out.__rawTotals = { citySessionsRawTotal, dealsRawTotal, meetingsRawTotal, spendRawTotal };
    return out;
  }

  const stores = STORES.map(s => {
    const ga4DailyByField = ga4ByGroup.get(s.ga4CityGroup) || (() => {
      const empty = new Map();
      GA4_FIELDS.forEach(([k]) => empty.set(k, new Map()));
      return empty;
    })();
    const inventoryPieces = inventoryByStoreName.get(s.inventoryStoreName) || 0;
    const metrics = buildMetricsFor(s.key, ga4DailyByField, s);
    delete metrics.__rawTotals;
    metrics.inventory = (!s.inventoryStoreName || failedGroups.has('inventory'))
      ? metricValue(null, periods, { unavailable: true })
      : metricValue(null, periods, { snapshot: true, snapshotValue: inventoryPieces });

    return {
      key: s.key,
      displayName: s.displayName,
      shortCode: s.shortCode,
      accent: s.accent,
      citySharedLabel: s.citySharedLabel,
      metrics,
    };
  });

  // "All Stores" — GA4 metrics summed across the *unique* city groups (not
  // per store, which would double-count Mumbai and Delhi), every other
  // metric summed across all stores' daily maps.
  const allGa4DailyByField = new Map();
  GA4_FIELDS.forEach(([metricKey]) => {
    const perGroupMaps = [...ga4ByGroup.values()].map(pf => pf.get(metricKey));
    allGa4DailyByField.set(metricKey, mergeDailyMaps(perGroupMaps));
  });
  const allMetrics = buildMetricsFor(ALL_STORES_KEY, allGa4DailyByField);
  // Overwrite the non-GA4, non-pending metrics with the true cross-store sum
  // (buildMetricsFor above looked them up by storeKey='all', which has no
  // entry in the per-store maps — recompute explicitly here instead), unless
  // that source group failed, in which case buildMetricsFor already marked
  // it "unavailable" and there is nothing real to sum.
  const sumIfAvailable = (group, maps, opts) => failedGroups.has(group)
    ? metricValue(null, periods, { unavailable: true })
    : metricValue(mergeDailyMaps(maps), periods, opts);
  // Deals/Meetings Raised/Spend: computed once as real period totals for
  // the Cost Per-X ratios below, then overwritten with the avg/day figure
  // actually shown on screen — same split as buildMetricsFor. City Sessions'
  // raw total doesn't need recomputing here — buildMetricsFor(ALL_STORES_KEY,
  // allGa4DailyByField) above already used the true cross-store GA4 data
  // (not a per-store lookup), so its own __rawTotals.citySessionsRawTotal
  // is already correct.
  const dealsRawTotal = sumIfAvailable('deals', [...deals.values()]);
  const meetingsRawTotal = sumIfAvailable('meetings', [...meetingsRaised.values()]);
  const spendRawTotal = sumIfAvailable('ads', [...spend.values()], { round: round2 });
  const citySessionsRawTotal = allMetrics.__rawTotals.citySessionsRawTotal;
  delete allMetrics.__rawTotals;
  allMetrics.deals = sumIfAvailable('deals', [...deals.values()], { avgPerDay: true });
  allMetrics.meetingsRaised = sumIfAvailable('meetings', [...meetingsRaised.values()], { avgPerDay: true });
  allMetrics.walkins = sumIfAvailable('walkins', [...walkins.values()], { avgPerDay: true });
  allMetrics.orders = sumIfAvailable('orders', [...orders.values()], { avgPerDay: true });
  allMetrics.revenue = sumIfAvailable('orders', [...revenue.values()], { round: round2, avgPerDay: true });
  allMetrics.callsDialed = sumIfAvailable('calls', [...callsDialed.values()], { avgPerDay: true });
  allMetrics.callsConnected = sumIfAvailable('calls', [...callsConnected.values()], { avgPerDay: true });
  allMetrics.callsConnected30s = sumIfAvailable('calls', [...callsConnected30s.values()], { avgPerDay: true });
  allMetrics.talktimeSeconds = sumIfAvailable('calls', [...talktimeSeconds.values()], { avgPerDay: true });
  allMetrics.spend = sumIfAvailable('ads', [...spend.values()], { round: round2, avgPerDay: true });
  allMetrics.costPerSession = ratioMetric(spendRawTotal, citySessionsRawTotal);
  allMetrics.costPerDeal = ratioMetric(spendRawTotal, dealsRawTotal);
  allMetrics.costPerAppointment = ratioMetric(spendRawTotal, meetingsRawTotal);
  // GBP metrics for "All Stores": Reviews sums real per-store totals;
  // Rating is a review-count-weighted average (not a plain average, which
  // would let a low-review store swing the figure as much as a high-review
  // one); Strength is a plain average of each store's 0-10 completeness
  // score; Direction Clicks/Calls sum real per-store daily counts, same
  // pattern as Spend. Only counts stores gbpByStore actually has real data
  // for — a store still failing/unavailable is excluded from the sum/average,
  // not treated as 0.
  const gbpOkEntries = [...gbpByStore.entries()].filter(([, d]) => d && !d.error);
  if (failedGroups.has('gbp') || gbpOkEntries.length === 0) {
    allMetrics.gmbStrength = metricValue(null, periods, { unavailable: true });
    allMetrics.googleReviews = metricValue(null, periods, { unavailable: true });
    allMetrics.googleRating = metricValue(null, periods, { unavailable: true });
    allMetrics.storeDirectionClicks = metricValue(null, periods, { unavailable: true });
    allMetrics.storeIncomingCalls = metricValue(null, periods, { unavailable: true });
  } else {
    const strengths = gbpOkEntries.map(([, d]) => d.strength).filter(v => v != null);
    allMetrics.gmbStrength = metricValue(null, periods, {
      snapshot: true, snapshotValue: strengths.length ? round1(strengths.reduce((a, b) => a + b, 0) / strengths.length) : null,
    });
    const totalReviews = gbpOkEntries.reduce((sum, [, d]) => sum + (d.totalReviewCount || 0), 0);
    allMetrics.googleReviews = metricValue(null, periods, { snapshot: true, snapshotValue: totalReviews });
    const ratingWeightedSum = gbpOkEntries.reduce((sum, [, d]) => sum + (d.averageRating || 0) * (d.totalReviewCount || 0), 0);
    allMetrics.googleRating = metricValue(null, periods, {
      snapshot: true, snapshotValue: totalReviews > 0 ? round1(ratingWeightedSum / totalReviews) : null,
    });
    allMetrics.storeDirectionClicks = metricValue(mergeDailyMaps(gbpOkEntries.map(([, d]) => d.directionRequests || new Map())), periods, { avgPerDay: true });
    allMetrics.storeIncomingCalls = metricValue(mergeDailyMaps(gbpOkEntries.map(([, d]) => d.callClicks || new Map())), periods, { avgPerDay: true });
  }
  const totalInventory = STORES.reduce((sum, s) => sum + (inventoryByStoreName.get(s.inventoryStoreName) || 0), 0);
  allMetrics.inventory = failedGroups.has('inventory')
    ? metricValue(null, periods, { unavailable: true })
    : metricValue(null, periods, { snapshot: true, snapshotValue: totalInventory });
  // Sum of whichever stores actually have a count entered so far — a store
  // with nothing entered yet contributes 0 to this sum (not excluded from
  // it), since "All Stores" total staff is a real, meaningful figure even
  // while some individual stores are still blank.
  const anyStaffCountSet = STORES.some(s => staffCounts[s.key] != null);
  const totalStaffCount = STORES.reduce((sum, s) => sum + ((staffCounts[s.key] && staffCounts[s.key].count) || 0), 0);
  allMetrics.staffCount = metricValue(null, periods, { snapshot: true, snapshotValue: anyStaffCountSet ? totalStaffCount : null });

  const allStores = {
    key: ALL_STORES_KEY,
    displayName: ALL_STORES_DISPLAY_NAME,
    shortCode: null,
    accent: '#241a18',
    citySharedLabel: null,
    metrics: allMetrics,
  };

  const ga4DataFailed = failedGroups.has('ga4');
  const SOURCE_GROUP_LABELS = {
    ga4: 'Traffic & Acquisition (GA4)', calls: 'Call Performance', deals: 'Deals', walkins: 'Walkins',
    orders: 'Orders & Revenue', inventory: 'Inventory', meetings: 'Meetings Raised',
    ads: 'Spend (Google Ads + Meta Ads)', gbp: 'Google Business Profile',
  };
  const failedSourceLabels = [...failedGroups].filter(g => g !== 'ga4Coverage').map(g => SOURCE_GROUP_LABELS[g] || g);

  // One clause per incomplete period, e.g. "Last Month (1 Aug - 31 Aug 2026):
  // 15 of 31 days available" — never implies a partial sum is a final total.
  const ga4Notes = [];
  if (!ga4DataFailed) {
    for (const key of ['yesterday', 'lastWeek', 'lastMonth']) {
      const cov = ga4Coverage[key];
      const label = ga4Periods[key].label + ' (' + ga4Periods[key].displayRange + ')';
      if (cov.coveredDays === 0) ga4Notes.push(`${label}: no data available`);
      else if (cov.coveredDays < cov.expectedDays) ga4Notes.push(`${label}: only ${cov.coveredDays} of ${cov.expectedDays} days available — likely undercounted`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Kolkata',
    today,
    periods,
    ga4Periods,
    dataFreshness: {
      ga4: {
        minDate: ga4MinDate,
        maxDate: ga4MaxDate,
        stale: ga4Stale,
        coverage: ga4Coverage,
        note: (ga4Stale && !ga4DataFailed && ga4Notes.length)
          ? `GA4 source (analytics_478308692, the linked GA4 BigQuery export) is missing a day-table for: ${ga4Notes.join('; ')}.`
          : null,
      },
      meetings: { unmappedCount: unmappedMeetingsCount },
      failedSources: failedSourceLabels,
    },
    metricDefs: METRICS,
    sections: SECTIONS,
    stores,
    allStores,
  };
}

module.exports = { buildStorePerformanceDashboard, STORES };
