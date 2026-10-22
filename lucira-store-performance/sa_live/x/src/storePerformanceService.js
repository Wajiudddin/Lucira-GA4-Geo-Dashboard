require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');
const { fetchRecordsSince } = require('./zohoClient');
const gbpClient = require('./gbpClient');
const {
  STORES, ALL_GA4_CITIES, CONNECTED_CALL_STATUSES, ALL_STORES_KEY, ALL_STORES_DISPLAY_NAME,
} = require('./config/stores');
const { METRICS, SECTIONS } = require('./config/metrics');
const { getComparisonPeriods, bucketDailyMap, validateCustomRange } = require('./lib/dateWindows');

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

// Website sessions come from a small daily summary table, NOT straight from the GA4 export, so a
// dashboard load no longer scans the big events_* tables (which cost real money every time):
//   lucirajewelry-prod.ds_imputed_reporting.ga4_city_sessions_daily
// one row per day per city group (mumbai / delhi / pune / noida / bengaluru) with city, paid,
// retargeting and communication sessions. It is built from the linked GA4 BigQuery export
// (analytics_478308692.events_*) with the standard GA4-BigQuery session count — COUNT(DISTINCT
// session key), session key = user_pseudo_id + the 'ga_session_id' event param (verified against
// GA4's own number: Pune, 17 Sep 2026, computed 905 vs GA4 UI 906).
//   - Paid = source google (medium not organic) or facebook/fb/ig (medium not referral/none);
//     Retargeting = source contains rtb or criteo; Communication = source broadcast or trigger.
//   - Refreshed by the BigQuery scheduled query "GA4 city sessions daily refresh (store
//     performance)" every 12 hours, which rebuilds the last 4 days (GA4 can still adjust recent
//     days) and never touches older ones. The whole history (from 3 May 2025) was loaded once.
const GA4_SUMMARY_TABLE = 'lucirajewelry-prod.ds_imputed_reporting.ga4_city_sessions_daily';

// Returns rows in the shape the rest of this file expects: event_date as 'YYYY-MM-DD'.
async function loadGa4Rows(todayKey, rangeStart, rangeEnd) {
  const [rows] = await bigquery.query({
    query: `
      SELECT FORMAT_DATE('%Y-%m-%d', event_date) AS event_date, city_group,
             city_sessions, paid_sessions, retargeting_sessions, communication_sessions
      FROM \`${GA4_SUMMARY_TABLE}\`
      WHERE event_date BETWEEN '${rangeStart}' AND '${rangeEnd}'
    `,
  });
  return rows;
}

// Which days the summary table has — a day missing here simply has not been loaded yet (the
// freshness banner then says "only N of M days available" instead of showing a partial sum as final).
function ga4CoverageQuery(startDate, endDate) {
  return `
    SELECT DISTINCT FORMAT_DATE('%Y%m%d', event_date) AS suffix
    FROM \`${GA4_SUMMARY_TABLE}\`
    WHERE event_date BETWEEN '${startDate}' AND '${endDate}'
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
//
// Business-defined routing (zone -> store), no longer an even split for Delhi:
//   Mumbai                          -> Borivali 50% / Chembur 50%
//   Central / South / South West    -> Lajpat Nagar
//   North / North West / West       -> Paschim Vihar
//   East Delhi, Noida               -> Noida
//   any other Delhi value ("Delhi", "New Delhi", "South East Delhi", ...) has
//   no assigned zone, so it falls back to Lajpat Nagar 50% / Paschim Vihar 50%.
// Returns [{ storeKey, share }] (shares sum to 1), or null if not attributable.
const DELHI_ZONE_STORE = {
  'central delhi': 'lajpatNagar',
  'south delhi': 'lajpatNagar',
  'south west delhi': 'lajpatNagar',
  'north delhi': 'paschimVihar',
  'north west delhi': 'paschimVihar',
  'west delhi': 'paschimVihar',
  'east delhi': 'noida',
};
function dealStoreShares(addressCity) {
  if (!addressCity) return null;
  const c = addressCity.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  if (c === 'mumbai') return [{ storeKey: 'borivali', share: 0.5 }, { storeKey: 'chembur', share: 0.5 }];
  if (c === 'pune') return [{ storeKey: 'pune', share: 1 }];
  if (c === 'noida') return [{ storeKey: 'noida', share: 1 }];
  if (c === 'bengaluru') return [{ storeKey: 'malleshwaram', share: 1 }];
  if (c.includes('delhi')) {
    const zoneStore = DELHI_ZONE_STORE[c];
    if (zoneStore) return [{ storeKey: zoneStore, share: 1 }];
    return [{ storeKey: 'lajpatNagar', share: 0.5 }, { storeKey: 'paschimVihar', share: 0.5 }];
  }
  return null;
}

const ZOHO_DEAL_FIELDS = ['Address_City', 'Created_Time'];

// Zoho Meetings (module "Events") with their Show Status (Show / No Show) and Conversion Status
// (Converted / Non-Converted), filled in by the store team. Live API: the BigQuery copy of the
// meetings carries these fields on almost no rows.
const ZOHO_MEETING_FIELDS = ['Venue', 'Owner', 'Show_Status', 'Conversion_Status', 'Created_Time'];
async function fetchZohoMeetingStatusRaw(startDateKey) {
  const stopBeforeISO = new Date(`${startDateKey}T00:00:00+05:30`).toISOString();
  return withZohoRetry(() => fetchRecordsSince('Events', ZOHO_MEETING_FIELDS, { sortField: 'Created_Time', stopBeforeISO }));
}

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
const PERIOD_KEY_NAMES = ['today', 'yesterday', 'lastWeek', 'lastMonth', 'custom'];
function ratioMetric(numMetric, denomMetric) {
  // Works over whichever periods the inputs carry (the 3 standard ones, plus 'custom' when a
  // custom range is loaded).
  const present = PERIOD_KEY_NAMES.filter(k => (numMetric && k in numMetric) || (denomMetric && k in denomMetric));
  const keys = present.length ? present : ['yesterday', 'lastWeek', 'lastMonth'];
  if ((numMetric && numMetric.unavailable) || (denomMetric && denomMetric.unavailable)) {
    const na = { unavailable: true };
    keys.forEach(k => { na[k] = null; });
    return na;
  }
  const out = {};
  for (const p of keys) {
    const num = numMetric ? numMetric[p] : null;
    const den = denomMetric ? denomMetric[p] : null;
    out[p] = (num == null || den == null || !den) ? null : round2(num / den);
  }
  return out;
}

// Like ratioMetric but expressed as a percentage (one decimal), e.g. 35.0 for 35%.
function percentMetric(numMetric, denomMetric) {
  const present = PERIOD_KEY_NAMES.filter(k => (numMetric && k in numMetric) || (denomMetric && k in denomMetric));
  const keys = present.length ? present : ['yesterday', 'lastWeek', 'lastMonth'];
  if ((numMetric && numMetric.unavailable) || (denomMetric && denomMetric.unavailable)) {
    const na = { unavailable: true };
    keys.forEach(k => { na[k] = null; });
    return na;
  }
  const out = {};
  for (const p of keys) {
    const num = numMetric ? numMetric[p] : null;
    const den = denomMetric ? denomMetric[p] : null;
    out[p] = (num == null || den == null || !den) ? null : round1((num / den) * 100);
  }
  return out;
}

function allShortCodes() {
  return STORES.filter(s => s.shortCode).flatMap(s => [s.shortCode, ...(s.extraShortCodes || [])]);
}

// Store visits (walk-ins) come from Lucira_Prod.customer_walkin, the ERP's walk-in log; the old
// ds_imputed_reporting.Walkin_marge table is no longer used anywhere on this dashboard.
//   - Only rows with source = 'Store Walkin' are visits (the table also logs bills, receipts,
//     orders, enquiries etc. against the customer, which are not store visits).
//   - The store is company_id -> ERP company.company_code (the same codes sales use).
//   - `date` is a true timestamp, so the India day is DATE(date, 'Asia/Kolkata') — no time shift.
//   - A person with a valid 10-digit mobile counts once per store per day; visits with no
//     mobile can't be matched, so each row counts on its own.
// Returns one CTE, \`visits\`, with: store_code, mobile (10 digits or NULL), ts (TIMESTAMP).
function walkinVisitsCte() {
  return `
    visits AS (
      SELECT store_code, mobile, ts
      FROM (
        SELECT c.company_code AS store_code,
               IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(w.mobile, ''), r'\\D', ''), 10), r'^[6-9][0-9]{9}$'),
                  RIGHT(REGEXP_REPLACE(w.mobile, r'\\D', ''), 10), NULL) AS mobile,
               w.date AS ts,
               w.id AS id
        FROM \`lucirajewelry-prod.Lucira_Prod.customer_walkin\` w
        JOIN \`lucirajewelry-prod.ornaverse_erp_administration.company\` c ON c.company_id = w.company_id
        WHERE w.source = 'Store Walkin'
      )
      WHERE TRUE
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY IF(mobile IS NULL, CAST(id AS STRING), CONCAT(store_code, '|', mobile, '|', CAST(DATE(ts, 'Asia/Kolkata') AS STRING)))
        ORDER BY ts) = 1
    )`;
}

// New vs Repeat walk-in: derived from the phone number across the table's WHOLE history (all stores,
// since the log starts in Oct 2025) — a number's first visit is New, every later visit is Repeat.
// The ranking runs over every row BEFORE the store/date filter below, otherwise a returning
// visitor whose first visit was outside the requested range would wrongly count as New. A visit
// with no phone number can't be matched, so it counts as New (disclosed on the Logic tab).
function walkinsQuery(startDate, endDate) {
  const codes = allShortCodes().map(c => `'${c}'`).join(',');
  return `
    WITH ${walkinVisitsCte()},
    ranked AS (
      SELECT
        store_code,
        DATE(ts, 'Asia/Kolkata') AS walkin_day,
        IF(mobile IS NULL, 1, ROW_NUMBER() OVER (PARTITION BY mobile ORDER BY ts)) AS visit_no
      FROM visits
    )
    SELECT
      store_code,
      walkin_day,
      COUNT(*) AS walkins,
      COUNTIF(visit_no = 1) AS new_walkins,
      COUNTIF(visit_no > 1) AS repeat_walkins
    FROM ranked
    WHERE store_code IN (${codes})
      AND walkin_day BETWEEN '${startDate}' AND '${endDate}'
    GROUP BY store_code, walkin_day
  `;
}

// Channel = 'Store' restricts this to in-store sales (online orders aren't
// attributable to a physical store); document_no is distinct-counted so a
// multi-line order counts once, not once per line item.
// Free items are ignored. A bill whose TOTAL net sale is 0 (a free-gift bill) is not counted as
// an order — not in Orders, New/Repeat Orders or New/Repeat Buyers, so ATV is over real, paid
// bills too (doc_net is the bill's total net sale). And an item line whose own net sale is 0
// (e.g. a free gold coin on a paid bill) is not counted in Sales Qty. Revenue is unaffected
// (those lines add 0). Purchase / Sales Amount / Margin skip such lines too (salesMarginQuery).
function ordersQuery(startDate, endDate, opts) {
  const codes = allShortCodes().map(c => `'${c}'`).join(',');
  const noMto = opts && opts.excludeMto ? "AND IFNULL(Fullfillment, '') != 'MTO'" : '';
  return `
    SELECT
      company_code AS store_code,
      Transaction_Date AS txn_date,
      COUNT(DISTINCT IF(doc_net != 0, document_no, NULL)) AS orders,
      SUM(net_sale) AS revenue,
      SUM(IF(net_sale != 0, pieces, 0)) AS sales_qty,
      COUNT(DISTINCT IF(doc_net != 0 AND UPPER(TRIM(customer_type)) = 'NEW', document_no, NULL)) AS new_orders,
      COUNT(DISTINCT IF(doc_net != 0 AND UPPER(TRIM(customer_type)) = 'REPEAT', document_no, NULL)) AS repeat_orders,
      SUM(IF(UPPER(TRIM(customer_type)) = 'NEW', net_sale, 0)) AS new_revenue,
      SUM(IF(UPPER(TRIM(customer_type)) = 'REPEAT', net_sale, 0)) AS repeat_revenue,
      COUNT(DISTINCT IF(doc_net != 0 AND UPPER(TRIM(customer_type)) = 'NEW', CAST(party_id AS STRING), NULL)) AS new_buyers,
      COUNT(DISTINCT IF(doc_net != 0 AND UPPER(TRIM(customer_type)) = 'REPEAT', CAST(party_id AS STRING), NULL)) AS repeat_buyers
    FROM (
      SELECT *, SUM(net_sale) OVER (PARTITION BY company_code, document_no) AS doc_net
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      WHERE Channel = 'Store'
        AND company_code IN (${codes})
        ${noMto}
        AND Transaction_Date BETWEEN '${startDate}' AND '${endDate}'
    )
    GROUP BY store_code, txn_date
  `;
}

// Store Comparison tab only: made-to-order (MTO) pieces that have been BUILT. An MTO is booked as a
// pre-order (RPO) bill at order time; once made it is billed again as an RTS bill. This returns those
// billed pieces by the day the RTS bill was made, at the RTS bill amount (the price can move between
// the pre-order and the final bill). ds_imputed_reporting.MTO_Orders carries RTS_NO / RTS_Amount.
// If the RTS bill is already in marketing_sale with a non-zero net sale it is counted there
// already, so it is skipped here to avoid counting it twice. New/Repeat comes from the
// pre-order line's customer type.
function mtoBuiltCtes(startDate, endDate) {
  const codes = allShortCodes().map(c => `'${c}'`).join(',');
  return `
    mto AS (
      SELECT *
      FROM \`lucirajewelry-prod.ds_imputed_reporting.MTO_Orders\`
      WHERE fullfillment = 'MTO'
        AND RTS_NO IS NOT NULL AND TRIM(RTS_NO) != ''
        AND IFNULL(RTS_Amount, 0) > 0
        AND company_code IN (${codes})
        AND DATE(transaction_date) BETWEEN '${startDate}' AND '${endDate}'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY item_line_no ORDER BY DATE(transaction_date) DESC) = 1
    ),
    counted AS (
      SELECT document_no
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      GROUP BY document_no
      HAVING SUM(net_sale) != 0
    )`;
}
function mtoBuiltQuery(startDate, endDate) {
  return `
    WITH ${mtoBuiltCtes(startDate, endDate)},
    cust AS (
      SELECT item_line_no, ANY_VALUE(customer_type) AS customer_type, ANY_VALUE(CAST(party_id AS STRING)) AS party_id
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      WHERE item_line_no > 0
      GROUP BY item_line_no
    )
    SELECT
      m.company_code AS store_code,
      DATE(m.transaction_date) AS txn_date,
      COUNT(DISTINCT m.RTS_NO) AS orders,
      SUM(m.RTS_Amount) AS revenue,
      SUM(m.pieces) AS sales_qty,
      COUNT(DISTINCT IF(UPPER(TRIM(c.customer_type)) = 'NEW', m.RTS_NO, NULL)) AS new_orders,
      COUNT(DISTINCT IF(UPPER(TRIM(c.customer_type)) = 'REPEAT', m.RTS_NO, NULL)) AS repeat_orders,
      SUM(IF(UPPER(TRIM(c.customer_type)) = 'NEW', m.RTS_Amount, 0)) AS new_revenue,
      SUM(IF(UPPER(TRIM(c.customer_type)) = 'REPEAT', m.RTS_Amount, 0)) AS repeat_revenue,
      COUNT(DISTINCT IF(UPPER(TRIM(c.customer_type)) = 'NEW', c.party_id, NULL)) AS new_buyers,
      COUNT(DISTINCT IF(UPPER(TRIM(c.customer_type)) = 'REPEAT', c.party_id, NULL)) AS repeat_buyers
    FROM mto m
    LEFT JOIN cust c ON c.item_line_no = m.item_line_no
    LEFT JOIN counted ct ON ct.document_no = m.RTS_NO
    WHERE ct.document_no IS NULL
    GROUP BY store_code, txn_date
  `;
}

// Sales Amount / Purchase Amount / Margin. Sales Amount = sub_total - discount (the POS invoice
// line's taxable amount); Purchase Amount = sub_total. Each sold store line in
// marketing_sale (which carries the store and the sale date) is tied by
// item_line_no to the ERP POS invoice line (sales amount = sub_total - discount) and to
// the purchase invoice line for the same item (purchase amount = sub_total).
//   - Margin = Sales Amount - Purchase Amount (net sale is NOT used), summed over the matched
//     lines; Margin % = Margin / Sales Amount of the same lines.
//   - Only lines found in BOTH tables are counted (inner joins), so the margin
//     is always sales amount minus the cost of the very same items.
//   - item_line_no = 0 is an ERP placeholder (57 purchase rows share it with
//     wildly different amounts) and is ignored.
//   - A few item_line_no values repeat in the invoice tables; one value per
//     line (MAX) is used so a repeat can't double-count.
//   - Pre-order bills (document no. containing "-RPO-") mostly have no POS or
//     purchase invoice line yet, so they drop out of these three metrics.
// Purchase cost per sold piece (item_line_no) = the purchase invoice (GRN) line's sub_total; for a
// piece that has no purchase invoice line (stock received on consignment has none), the
// consignment-in (APU) line's sub_total (purchase.consignment_items) is used instead. The purchase
// invoice always wins when both exist.
// Some pieces are sold under a DIFFERENT item_line_no than the one they were purchased under (for
// example a made-to-order piece: the order's line is later allocated a real stock piece). The ERP
// records that in two tables joined on transaction_item_id:
//   Lucira_Prod.stock_allocation_items  item_line_no = the sold / ordered line
//   Lucira_Prod.stock_allocated_items   item_line_no = the stock piece actually allocated
// When the sold line itself has no purchase cost, the cost of the allocated piece's line is used.
// Returns the CTE `purchase` (with purchase_line = the line the cost came from) and, with
// opts.withDoc, purchase_doc: the document number of that purchase invoice (GRN, e.g.
// HO-GRN-02-26-45) or consignment-in (APU, e.g. HO-APU-09-26-060), found on the header table.
function purchaseCostCte(opts) {
  const withDoc = !!(opts && opts.withDoc);
  const docCol = withDoc ? ', ARRAY_AGG(h.document_no ORDER BY it.sub_total DESC LIMIT 1)[SAFE_OFFSET(0)] AS purchase_doc' : '';
  const joinHeader = table => withDoc
    ? `LEFT JOIN \`lucirajewelry-prod.purchase.${table}\` h ON h.transaction_id = it.transaction_id AND h.document_id = it.document_id`
    : '';
  return `purchase_by_line AS (
      SELECT COALESCE(i.item_line_no, c.item_line_no) AS item_line_no,
             COALESCE(i.purchase_amount, c.purchase_amount) AS purchase_amount${withDoc ? ', IF(i.purchase_amount IS NOT NULL, i.purchase_doc, c.purchase_doc) AS purchase_doc' : ''}
      FROM (
        SELECT it.item_line_no, MAX(it.sub_total) AS purchase_amount${docCol}
        FROM \`lucirajewelry-prod.purchase.invoice_items\` it
        ${joinHeader('invoice')}
        WHERE it.item_line_no > 0
        GROUP BY it.item_line_no
      ) i
      FULL JOIN (
        SELECT it.item_line_no, MAX(it.sub_total) AS purchase_amount${docCol}
        FROM \`lucirajewelry-prod.purchase.consignment_items\` it
        ${joinHeader('consignment')}
        WHERE it.item_line_no > 0 AND it.sub_total > 0
        GROUP BY it.item_line_no
      ) c ON c.item_line_no = i.item_line_no
    ),
    alloc_map AS (
      SELECT a.item_line_no AS sold_line, MIN(b.item_line_no) AS piece_line
      FROM \`lucirajewelry-prod.Lucira_Prod.stock_allocation_items\` a
      JOIN \`lucirajewelry-prod.Lucira_Prod.stock_allocated_items\` b ON b.transaction_item_id = a.transaction_item_id
      WHERE a.item_line_no > 0 AND b.item_line_no > 0 AND b.item_line_no != a.item_line_no
      GROUP BY a.item_line_no
    ),
    purchase AS (
      SELECT COALESCE(d.item_line_no, m.sold_line) AS item_line_no,
             COALESCE(d.purchase_amount, p.purchase_amount) AS purchase_amount,
             IF(d.purchase_amount IS NOT NULL, d.item_line_no, m.piece_line) AS purchase_line${withDoc ? ',\n             IF(d.purchase_amount IS NOT NULL, d.purchase_doc, p.purchase_doc) AS purchase_doc' : ''}
      FROM purchase_by_line d
      FULL JOIN alloc_map m ON m.sold_line = d.item_line_no
      LEFT JOIN purchase_by_line p ON p.item_line_no = m.piece_line
    )`;
}
// With opts.mtoBuilt (Store Comparison tab) a made-to-order piece counts only once billed: the
// pre-order (MTO) lines are left out and each billed MTO piece is added on the day its RTS bill was
// made. A billed MTO piece keeps its own item_line_no (the same line is on the RTS bill's ERP invoice
// line), so its sales and purchase cost are looked up by that line number like any other piece.
// An RTS bill already in marketing_sale (non-zero) is counted there, not twice.
function salesMarginQuery(startDate, endDate, opts) {
  const codes = allShortCodes().map(c => `'${c}'`).join(',');
  const mtoBasis = !!(opts && opts.mtoBuilt);
  const noMto = mtoBasis ? "AND IFNULL(Fullfillment, '') != 'MTO'" : '';
  const builtMto = mtoBasis ? `
      UNION ALL
      SELECT m.company_code AS store_code, DATE(m.transaction_date) AS txn_date, m.RTS_NO AS document_no,
             CAST(m.item_line_no AS INT64) AS item_line_no, CAST(m.RTS_Amount AS FLOAT64) AS line_net,
             UPPER(TRIM(c.customer_type)) AS customer_type
      FROM mto m
      LEFT JOIN cust c ON c.item_line_no = m.item_line_no
      LEFT JOIN counted ct ON ct.document_no = m.RTS_NO
      WHERE ct.document_no IS NULL AND m.item_line_no > 0 AND m.company_code IN (${codes})` : '';
  const mtoCtes = mtoBasis ? `${mtoBuiltCtes(startDate, endDate)},
    cust AS (
      SELECT item_line_no, ANY_VALUE(customer_type) AS customer_type
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      WHERE item_line_no > 0
      GROUP BY item_line_no
    ),` : '';
  return `
    WITH ${mtoCtes}
    sold AS (
      SELECT * FROM (
        SELECT company_code AS store_code, Transaction_Date AS txn_date, document_no, CAST(item_line_no AS INT64) AS item_line_no,
               CAST(SUM(net_sale) AS FLOAT64) AS line_net, ANY_VALUE(UPPER(TRIM(customer_type))) AS customer_type
        FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
        WHERE Channel = 'Store'
          AND company_code IN (${codes})
          AND item_line_no > 0
          ${noMto}
          AND Transaction_Date BETWEEN '${startDate}' AND '${endDate}'
        GROUP BY store_code, txn_date, document_no, item_line_no
        HAVING SUM(net_sale) != 0 -- a free item (net sale 0) is ignored: no quantity, cost or margin
      )${builtMto}
    ),
    sales AS (
      SELECT item_line_no, MAX(sub_total - IFNULL(discount, 0)) AS sales_amount
      FROM \`lucirajewelry-prod.ornaverse_erp_pos.invoice_items\`
      WHERE item_line_no > 0
      GROUP BY item_line_no
    ),
    ${purchaseCostCte()}
    SELECT
      sold.store_code,
      sold.txn_date,
      SUM(sales.sales_amount) AS sales_amount,
      SUM(IF(sold.customer_type = 'NEW', sales.sales_amount, 0)) AS new_sales_amount,
      SUM(IF(sold.customer_type = 'REPEAT', sales.sales_amount, 0)) AS repeat_sales_amount,
      SUM(purchase.purchase_amount) AS purchase_amount,
      SUM(sold.line_net) AS net_sale
    FROM sold
    JOIN sales USING (item_line_no)
    JOIN purchase USING (item_line_no)
    GROUP BY sold.store_code, sold.txn_date
  `;
}

// Scans: one row per item scanned on the POS (Pos.estimation_item_scan), counted per
// store per IST day. The table stores UTC timestamps, so the date is taken in
// Asia/Kolkata (same basis as every other date on this dashboard). The store comes
// from company_id -> ERP company.company_code (the same codes the sales data uses).
// Head Office (HO) scans are not store activity and are left out.
function scansQuery(startDate, endDate) {
  const codes = allShortCodes().map(c => `'${c}'`).join(',');
  return `
    SELECT
      c.company_code AS store_code,
      DATE(s.date, 'Asia/Kolkata') AS scan_day,
      COUNT(*) AS scans
    FROM \`lucirajewelry-prod.Pos.estimation_item_scan\` s
    JOIN \`lucirajewelry-prod.ornaverse_erp_administration.company\` c ON c.company_id = s.company_id
    WHERE c.company_code IN (${codes})
      AND DATE(s.date, 'Asia/Kolkata') BETWEEN '${startDate}' AND '${endDate}'
    GROUP BY store_code, scan_day
  `;
}

// Walkins From Meetings: store visits by a customer who had a meeting raised before the visit.
// For every meeting in zoho_meeting_journey_v (which already works out the customer's 10-digit
// mobile through the Deal / Contact / Lead), take the FIRST store visit (customer_walkin) by that
// mobile after the meeting was created (no time limit). Each such visit is counted once, on the
// day (IST) and at the store where it happened, so the count can never exceed Walkins.
function meetingWalkinsQuery(startDate, endDate) {
  const codes = allShortCodes().map(c => `'${c}'`).join(',');
  return `
    WITH meet AS (
      SELECT mobile,
             TIMESTAMP(SAFE.PARSE_DATETIME('%Y-%m-%dT%H:%M:%S', meeting_created_ist), 'Asia/Kolkata') AS created_ts
      FROM \`lucirajewelry-prod.ds_imputed_reporting.zoho_meeting_journey_v\`
      WHERE mobile IS NOT NULL AND meeting_created_ist IS NOT NULL
    ),
    ${walkinVisitsCte()},
    first_visit AS (
      SELECT m.mobile, m.created_ts, MIN(v.ts) AS ts
      FROM meet m
      JOIN visits v ON v.mobile = m.mobile AND v.store_code IN (${codes}) AND v.ts > m.created_ts
      GROUP BY m.mobile, m.created_ts
    )
    SELECT v.store_code,
           DATE(v.ts, 'Asia/Kolkata') AS walkin_day,
           COUNT(DISTINCT CONCAT(f.mobile, '|', CAST(f.ts AS STRING))) AS walkins_from_meetings
    FROM first_visit f
    JOIN visits v ON v.mobile = f.mobile AND v.ts = f.ts AND v.store_code IN (${codes})
    WHERE DATE(v.ts, 'Asia/Kolkata') BETWEEN '${startDate}' AND '${endDate}'
    GROUP BY v.store_code, walkin_day
  `;
}

// Meetings raised BEFORE the store team started marking Show / Converted in Zoho (22 Sep 2026): one
// row per meeting with
//   visited   = the same 10-digit mobile has a store visit (customer_walkin) after the meeting was
//               raised (any time later), and
//   converted = that visitor then placed a non-zero store bill (marketing_sale) on the day of that
//               first visit or any time after.
// Counted on the day the meeting was raised, at the store the meeting belongs to (the store is
// worked out in JS from the owner and Venue, like Meetings Raised).
const ZOHO_STATUS_FROM = '2026-09-22';
function meetingVisitsQuery(startDate, endDate) {
  const lastDay = addDaysISO(ZOHO_STATUS_FROM, -1);
  const end = endDate < lastDay ? endDate : lastDay;
  return `
    WITH meet AS (
      SELECT meeting_id, ANY_VALUE(meeting_owner) AS owner, ANY_VALUE(venue) AS venue, ANY_VALUE(mobile) AS mobile,
             MIN(TIMESTAMP(SAFE.PARSE_DATETIME('%Y-%m-%dT%H:%M:%S', meeting_created_ist), 'Asia/Kolkata')) AS created_ts
      FROM \`lucirajewelry-prod.ds_imputed_reporting.zoho_meeting_journey_v\`
      WHERE mobile IS NOT NULL AND meeting_created_ist IS NOT NULL
      GROUP BY meeting_id
    ),
    in_range AS (
      SELECT * FROM meet WHERE DATE(created_ts, 'Asia/Kolkata') BETWEEN '${startDate}' AND '${end}'
    ),
    ${walkinVisitsCte()},
    first_visit AS (
      SELECT m.meeting_id, MIN(v.ts) AS ts
      FROM in_range m JOIN visits v ON v.mobile = m.mobile AND v.ts > m.created_ts
      GROUP BY m.meeting_id
    ),
    orders AS (
      SELECT RIGHT(REGEXP_REPLACE(COALESCE(Cus_mobile, mobile1, ''), r'\\D', ''), 10) AS mobile, Transaction_Date AS d
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      WHERE Channel = 'Store' AND Transaction_Date >= '${startDate}'
      GROUP BY mobile, d, document_no
      HAVING SUM(net_sale) != 0
    )
    SELECT m.meeting_id, m.owner, m.venue, DATE(m.created_ts, 'Asia/Kolkata') AS created_day,
           f.ts IS NOT NULL AS visited,
           f.ts IS NOT NULL AND EXISTS (SELECT 1 FROM orders o WHERE o.mobile = m.mobile AND o.d >= DATE(f.ts, 'Asia/Kolkata')) AS converted
    FROM in_range m
    LEFT JOIN first_visit f ON f.meeting_id = m.meeting_id
  `;
}

// Online Influenced Orders: in-store orders (counted the same way as Orders — bills with a
// non-zero total net sale) whose buyer was already known online BEFORE the order, i.e.
//   (a) has a Zoho deal created before the order  — a deal means the customer interacted
//       with the brand online first (mostly website activity), or
//   (b) is a Shopify customer whose email marketing consent is 'subscribed', created before
//       the order — they signed up on the website before coming to the store.
// The buyer is matched on the 10-digit mobile number or on the email address. Fresh copies
// are used: zoho_crm.cdc_deals (the plain deals table stops mid-September) and
// Lucira_Prod.Lucira_Shopify_customers (the Shopify_customer copy stops in July); both carry
// the same fields and the same 'subscribed' state.
function onlineInfluencedQuery(startDate, endDate, opts) {
  const codes = allShortCodes().map(c => `'${c}'`).join(',');
  const mtoBasis = !!(opts && opts.mtoBuilt); // Store Comparison tab: an MTO counts once billed
  const noMto = mtoBasis ? "AND IFNULL(Fullfillment, '') != 'MTO'" : '';
  const mobileOf = col => `RIGHT(REGEXP_REPLACE(${col}, r'\\D', ''), 10)`;
  const builtMto = mtoBasis ? `
      UNION ALL
      SELECT m.company_code, DATE(m.transaction_date), m.RTS_NO,
             MIN(TIMESTAMP(DATETIME(DATE(m.transaction_date), TIME '23:59:59'), 'Asia/Kolkata')),
             ANY_VALUE(IF(REGEXP_CONTAINS(${mobileOf("COALESCE(m.mobile, m.mobile1, '')")}, r'^[6-9][0-9]{9}$'),
                          ${mobileOf("COALESCE(m.mobile, m.mobile1, '')")}, NULL)),
             ANY_VALUE(NULLIF(LOWER(TRIM(IFNULL(m.email, ''))), ''))
      FROM mto m
      LEFT JOIN counted ct ON ct.document_no = m.RTS_NO
      WHERE ct.document_no IS NULL
      GROUP BY m.company_code, DATE(m.transaction_date), m.RTS_NO` : '';
  return `
    WITH ${mtoBasis ? mtoBuiltCtes(startDate, endDate) + ',' : ''}
    ord AS (
      SELECT company_code AS store_code, Transaction_Date AS txn_date, document_no,
             COALESCE(
               ANY_VALUE(TIMESTAMP(SAFE.PARSE_DATETIME('%d-%m-%Y %H:%M:%S', document_date), 'Asia/Kolkata')),
               TIMESTAMP(DATETIME(Transaction_Date, TIME '23:59:59'), 'Asia/Kolkata')
             ) AS order_ts,
             ANY_VALUE(IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(COALESCE(Cus_mobile, mobile1, ''), r'\\D', ''), 10), r'^[6-9][0-9]{9}$'),
                          RIGHT(REGEXP_REPLACE(COALESCE(Cus_mobile, mobile1, ''), r'\\D', ''), 10), NULL)) AS mobile,
             ANY_VALUE(NULLIF(LOWER(TRIM(COALESCE(email, email_id, ''))), '')) AS email
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      WHERE Channel = 'Store'
        AND company_code IN (${codes})
        ${noMto}
        AND Transaction_Date BETWEEN '${startDate}' AND '${endDate}'
      GROUP BY store_code, txn_date, document_no
      HAVING SUM(net_sale) != 0${builtMto}
    ),
    deals AS (
      SELECT IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.Mobile'), ''), r'\\D', ''), 10), r'^[6-9][0-9]{9}$'),
                RIGHT(REGEXP_REPLACE(JSON_VALUE(data, '$.Mobile'), r'\\D', ''), 10), NULL) AS mobile,
             NULLIF(LOWER(TRIM(IFNULL(JSON_VALUE(data, '$.Email'), ''))), '') AS email,
             TIMESTAMP(JSON_VALUE(data, '$.Created_Time')) AS created
      FROM \`lucirajewelry-prod.zoho_crm.cdc_deals\`
    ),
    subscribers AS (
      SELECT IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(phone, ''), r'\\D', ''), 10), r'^[6-9][0-9]{9}$'),
                RIGHT(REGEXP_REPLACE(phone, r'\\D', ''), 10), NULL) AS mobile,
             NULLIF(LOWER(TRIM(IFNULL(email, ''))), '') AS email,
             TIMESTAMP(created_at) AS created
      FROM \`lucirajewelry-prod.Lucira_Prod.Lucira_Shopify_customers\`
      WHERE email_marketing_consent[SAFE_OFFSET(0)].state = 'subscribed'
    )
    SELECT o.store_code, o.txn_date,
           COUNT(*) AS online_orders
    FROM ord o
    WHERE EXISTS (SELECT 1 FROM deals d WHERE d.created < o.order_ts
                    AND ((o.mobile IS NOT NULL AND d.mobile = o.mobile) OR (o.email IS NOT NULL AND d.email = o.email)))
       OR EXISTS (SELECT 1 FROM subscribers s WHERE s.created < o.order_ts
                    AND ((o.mobile IS NOT NULL AND s.mobile = o.mobile) OR (o.email IS NOT NULL AND s.email = o.email)))
    GROUP BY o.store_code, o.txn_date
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
  if (/paschim|pashcim|pashchim|pachim|pashim/.test(v)) return 'paschimVihar';
  if (/noida/.test(v)) return 'noida';
  if (/lajpat|lachpat|lajpath/.test(v)) return 'lajpatNagar';
  if (/malleshwaram|malleswaram|bangalore|banglore|bengaluru|blr/.test(v)) return 'malleshwaram';
  return null;
}

// A meeting whose Venue is filled in but names no store ("HO", "Malad HO",
// "Video Call", "Goregaon", ...) isn't store activity, so it's ignored in every
// total, including "All Stores". Only a BLANK venue is kept, in "All Stores"
// alone, since it may well be a real store meeting nobody filled the venue in for.
function isNonStoreMeetingVenue(venue) {
  return !!(venue && String(venue).trim());
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
  const keys = Object.keys(periods); // the 3 standard periods, plus 'custom' when one is loaded
  const filled = v => { const o = {}; keys.forEach(k => { o[k] = v; }); return o; };
  if (pending) return { ...filled(null), pending: true };
  if (unavailable) return { ...filled(null), unavailable: true };
  if (snapshot) return { ...filled(snapshotValue), snapshot: true };
  const bucketed = bucketDailyMap(dailyMap, periods, avgPerDay ? (n => n) : round);
  if (!avgPerDay) return bucketed;
  // Last Week / Last Month become a per-day average (real calendar day count — 7 for a week,
  // 28-31 for a month — never hardcoded), not the period total. Yesterday is already a single
  // day, so it's left as-is, just rounded. A Custom range shows the range's TOTAL unless the
  // user asked for per-day averages (periods.custom.perDay).
  const out = {};
  keys.forEach(k => {
    // 'today' is a single day; periods flagged .total (Store Comparison tab) show real totals.
    const keepTotal = k === 'yesterday' || k === 'today' || periods[k].total || (k === 'custom' && !periods[k].perDay);
    out[k] = keepTotal ? round(bucketed[k]) : round(bucketed[k] / expectedDays(periods[k]).length);
  });
  return out;
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

async function buildStorePerformanceDashboard(customRange, opts) {
  // opts.totals (Store Comparison tab): adds a Today period and shows the whole period's totals for
  // Last Week / Last Month / Custom instead of per-day averages.
  const totals = !!(opts && opts.totals);
  const { today, periods, queryRange } = getComparisonPeriods(undefined, undefined, customRange, { withToday: totals });
  if (totals) Object.values(periods).forEach(p => { p.total = true; });
  // City/Paid/Retargeting/Communication Sessions alone get their own
  // "Yesterday" (today-2, not today-1) — by explicit request. Every other
  // metric uses `periods` above (today-1). Last Week / Last Month are
  // identical between the two — only `.yesterday` differs. `queryRange`
  // above (built from the later today-1 date) already covers today-2 too,
  // so this doesn't need its own BigQuery scan.
  const { periods: ga4Periods } = getComparisonPeriods(today, 2, customRange);
  if (totals) Object.values(ga4Periods).forEach(p => { p.total = true; });

  // Number of Staff is a fixed headcount per store, set in config/stores.js (no longer a
  // manually typed value, so nothing is read from the old staff-count table).

  const { rows, failed: failedGroups } = await runSourceGroups({
    ga4: () => loadGa4Rows(today, queryRange.start, queryRange.end),
    ga4Coverage: bq(ga4CoverageQuery(queryRange.start, queryRange.end)),
    // The totals tabs (Store Comparison, City Wise) show no call metrics, and a long range would make
    // the call history very large, so it is not loaded for them.
    calls: totals ? (async () => []) : () => fetchZohoCallsRaw(queryRange.start),
    deals: () => fetchZohoDealsRaw(queryRange.start),
    meetingStatus: () => fetchZohoMeetingStatusRaw(queryRange.start),
    meetingVisits: bq(meetingVisitsQuery(queryRange.start, queryRange.end)),
    walkins: bq(walkinsQuery(queryRange.start, queryRange.end)),
    orders: bq(ordersQuery(queryRange.start, queryRange.end)),
    ordersRts: bq(ordersQuery(queryRange.start, queryRange.end, { excludeMto: true })),
    mtoBuilt: bq(mtoBuiltQuery(queryRange.start, queryRange.end)),
    onlineInfluencedRts: bq(onlineInfluencedQuery(queryRange.start, queryRange.end, { mtoBuilt: true })),
    salesMargin: bq(salesMarginQuery(queryRange.start, queryRange.end)),
    salesMarginRts: bq(salesMarginQuery(queryRange.start, queryRange.end, { mtoBuilt: true })),
    scans: bq(scansQuery(queryRange.start, queryRange.end)),
    meetingWalkins: bq(meetingWalkinsQuery(queryRange.start, queryRange.end)),
    onlineInfluenced: bq(onlineInfluencedQuery(queryRange.start, queryRange.end)),
    inventory: bq(inventoryQuery()),
    meetings: bq(meetingsQuery(queryRange.start, queryRange.end)),
    ads: bq(marketingAdsSpendQuery(queryRange.start, queryRange.end)),
    gbp: () => gbpClient.fetchAllStoreData(STORES, queryRange.start, queryRange.end),
  });
  const ga4Rows = rows.ga4, ga4CoverageRows = rows.ga4Coverage, callRows = rows.calls, dealRows = rows.deals,
    walkinRows = rows.walkins, orderRows = rows.orders, salesMarginRows = rows.salesMargin, scanRows = rows.scans, meetingWalkinRows = rows.meetingWalkins, onlineInfluencedRows = rows.onlineInfluenced, inventoryRows = rows.inventory, meetingRows = rows.meetings,
    adsRows = rows.ads, meetingStatusRows = rows.meetingStatus, meetingVisitRows = rows.meetingVisits;
  const gbpByStore = rows.gbp instanceof Map ? rows.gbp : new Map();
  // Show / Converted use the phone-matched visits for meetings before ZOHO_STATUS_FROM, so if that
  // part failed the whole Show / Converted figure is unavailable (and Meetings Raised falls back).
  if (failedGroups.has('meetingVisits')) failedGroups.add('meetingStatus');

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
  const ga4Coverage = {};
  Object.keys(ga4Periods).forEach(k => { ga4Coverage[k] = periodCoverage(ga4Periods[k], ga4CoveredDates); });
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
  const deals = emptyMapPerKey(storeKeys);
  for (const deal of dealRows) {
    const shares = dealStoreShares(bqVal(deal.Address_City));
    if (!shares) continue;
    const dateKey = (deal.Created_Time || '').slice(0, 10);
    if (!dateKey || dateKey < queryRange.start || dateKey > queryRange.end) continue;
    shares.forEach(({ storeKey, share }) => bump(deals.get(storeKey), dateKey, share));
  }

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

  // New/Repeat split metrics — daily maps per store, keyed by metric key.
  const NEW_REPEAT_KEYS = ['newWalkins', 'repeatWalkins', 'newBuyers', 'repeatBuyers',
    'newRevenue', 'repeatRevenue', 'newOrders', 'repeatOrders'];
  const newRepeat = {};
  NEW_REPEAT_KEYS.forEach(k => { newRepeat[k] = emptyMapPerKey(storeKeys); });

  const walkins = emptyMapPerKey(storeKeys);
  const storeByCode = new Map(STORES.flatMap(s => [[s.shortCode, s.key], ...(s.extraShortCodes || []).map(c => [c, s.key])]));
  for (const row of walkinRows) {
    const key = storeByCode.get(bqVal(row.store_code));
    if (!key) continue;
    bump(walkins.get(key), bqVal(row.walkin_day), toNumber(row.walkins));
    bump(newRepeat.newWalkins.get(key), bqVal(row.walkin_day), toNumber(row.new_walkins));
    bump(newRepeat.repeatWalkins.get(key), bqVal(row.walkin_day), toNumber(row.repeat_walkins));
  }

  const orders = emptyMapPerKey(storeKeys);
  const revenue = emptyMapPerKey(storeKeys);
  const salesQty = emptyMapPerKey(storeKeys);
  const salesAmount = emptyMapPerKey(storeKeys);
  const purchaseAmount = emptyMapPerKey(storeKeys);
  const margin = emptyMapPerKey(storeKeys);
  const newSalesAmount = emptyMapPerKey(storeKeys);
  const repeatSalesAmount = emptyMapPerKey(storeKeys);
  // Loads the sales / purchase / margin daily maps from a set of rows (emptying them first), so the
  // Store Comparison tab can be built a second time on the MTO-built basis.
  function fillSalesMarginMaps(rowList) {
    [salesAmount, purchaseAmount, margin, newSalesAmount, repeatSalesAmount]
      .forEach(perStore => perStore.forEach(daily => daily.clear()));
    for (const row of rowList) {
      const key = storeByCode.get(bqVal(row.store_code));
      if (!key) continue;
      const dateKey = bqVal(row.txn_date);
      const s = toNumber(row.sales_amount), pu = toNumber(row.purchase_amount);
      bump(salesAmount.get(key), dateKey, s);
      bump(purchaseAmount.get(key), dateKey, pu);
      bump(margin.get(key), dateKey, s - pu); // Margin = Sales Amount - Purchase Amount
      bump(newSalesAmount.get(key), dateKey, toNumber(row.new_sales_amount));
      bump(repeatSalesAmount.get(key), dateKey, toNumber(row.repeat_sales_amount));
    }
  }
  fillSalesMarginMaps(salesMarginRows);
  const scans = emptyMapPerKey(storeKeys);
  for (const row of scanRows) {
    const key = storeByCode.get(bqVal(row.store_code));
    if (!key) continue;
    bump(scans.get(key), bqVal(row.scan_day), toNumber(row.scans));
  }
  const walkinsFromMeetings = emptyMapPerKey(storeKeys);
  for (const row of meetingWalkinRows) {
    const key = storeByCode.get(bqVal(row.store_code));
    if (!key) continue;
    bump(walkinsFromMeetings.get(key), bqVal(row.walkin_day), toNumber(row.walkins_from_meetings));
  }
  const onlineInfluenced = emptyMapPerKey(storeKeys);
  function fillOnlineInfluenced(rowList) {
    onlineInfluenced.forEach(daily => daily.clear());
    for (const row of rowList) {
      const key = storeByCode.get(bqVal(row.store_code));
      if (!key) continue;
      bump(onlineInfluenced.get(key), bqVal(row.txn_date), toNumber(row.online_orders));
    }
  }
  fillOnlineInfluenced(onlineInfluencedRows);
  // Loads the order-based daily maps from a set of rows (emptying them first), so the Store
  // Comparison tab can be built a second time on the MTO-built basis.
  function fillOrderMaps(rowList) {
    [orders, revenue, salesQty, newRepeat.newBuyers, newRepeat.repeatBuyers, newRepeat.newRevenue,
      newRepeat.repeatRevenue, newRepeat.newOrders, newRepeat.repeatOrders]
      .forEach(perStore => perStore.forEach(daily => daily.clear()));
    for (const row of rowList) {
      const key = storeByCode.get(bqVal(row.store_code));
      if (!key) continue;
      const dateKey = bqVal(row.txn_date);
      bump(orders.get(key), dateKey, toNumber(row.orders));
      bump(revenue.get(key), dateKey, toNumber(row.revenue));
      bump(salesQty.get(key), dateKey, toNumber(row.sales_qty));
      bump(newRepeat.newBuyers.get(key), dateKey, toNumber(row.new_buyers));
      bump(newRepeat.repeatBuyers.get(key), dateKey, toNumber(row.repeat_buyers));
      bump(newRepeat.newRevenue.get(key), dateKey, toNumber(row.new_revenue));
      bump(newRepeat.repeatRevenue.get(key), dateKey, toNumber(row.repeat_revenue));
      bump(newRepeat.newOrders.get(key), dateKey, toNumber(row.new_orders));
      bump(newRepeat.repeatOrders.get(key), dateKey, toNumber(row.repeat_orders));
    }
  }
  fillOrderMaps(orderRows);

  const inventoryByStoreName = new Map();
  for (const row of inventoryRows) {
    inventoryByStoreName.set(bqVal(row.Store_name), toNumber(row.inventory_pieces));
  }

  const meetingsRaised = emptyMapPerKey(storeKeys);
  // Real meetings whose venue names no store (e.g. a blank Venue): counted in
  // the "All Stores" total only, never attributed to any one store.
  const meetingsUnassigned = new Map();
  let unmappedMeetingsCount = 0;
  // Meetings come from Zoho CRM itself (the Meetings module, live), so Meetings Raised, Show and
  // Converted are all counted from the same records. The BigQuery copy is only the fallback when
  // the live Zoho call fails.
  const useZohoMeetings = !failedGroups.has('meetingStatus');
  const meetingList = useZohoMeetings
    ? meetingStatusRows.map(r => ({
      owner: r.Owner && typeof r.Owner === 'object' ? r.Owner.name : r.Owner,
      venue: r.Venue,
      dateKey: (r.Created_Time || '').slice(0, 10), // Zoho sends IST times (+05:30), so the date is the IST day
      // Zoho's Show / Converted marks are only reliable from ZOHO_STATUS_FROM; earlier meetings use
      // the phone-matched visits below.
      show: (r.Created_Time || '').slice(0, 10) >= ZOHO_STATUS_FROM && r.Show_Status === 'Show',
      converted: (r.Created_Time || '').slice(0, 10) >= ZOHO_STATUS_FROM && r.Conversion_Status === 'Converted',
    }))
    : meetingRows.map(r => {
      const createdRaw = bqVal(r.created_time);
      return { owner: bqVal(r.owner_name), venue: bqVal(r.venue), dateKey: createdRaw ? istDateKeyFromRaw(createdRaw) : null, show: false, converted: false };
    });
  for (const m of meetingList) {
    const key = matchMeetingStore(m.owner, m.venue);
    if (!m.dateKey || m.dateKey < queryRange.start || m.dateKey > queryRange.end) continue;
    if (key) { bump(meetingsRaised.get(key), m.dateKey, 1); continue; }
    if (isNonStoreMeetingVenue(m.venue)) continue;
    bump(meetingsUnassigned, m.dateKey, 1);
    unmappedMeetingsCount += 1;
  }

  // Meetings the store team marked Show (visited) / Converted, counted on the day the meeting was
  // raised and at the store it belongs to (same owner / Venue matching as Meetings Raised).
  const meetingsShown = emptyMapPerKey(storeKeys);
  const meetingsConverted = emptyMapPerKey(storeKeys);
  for (const m of meetingList) {
    const key = matchMeetingStore(m.owner, m.venue);
    if (!key || !m.dateKey || m.dateKey < queryRange.start || m.dateKey > queryRange.end) continue;
    if (m.show) bump(meetingsShown.get(key), m.dateKey, 1);
    if (m.converted) bump(meetingsConverted.get(key), m.dateKey, 1);
  }
  // Meetings raised before ZOHO_STATUS_FROM: visited / converted by phone matching (see meetingVisitsQuery).
  if (useZohoMeetings) {
    for (const row of meetingVisitRows) {
      const key = matchMeetingStore(bqVal(row.owner), bqVal(row.venue));
      const dateKey = bqVal(row.created_day);
      if (!key || !dateKey) continue;
      if (bqVal(row.visited) === true || bqVal(row.visited) === 'true') bump(meetingsShown.get(key), dateKey, 1);
      if (bqVal(row.converted) === true || bqVal(row.converted) === 'true') bump(meetingsConverted.get(key), dateKey, 1);
    }
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
    const nrRawTotals = {}; // real period totals, for the New/Repeat ATV ratios
    let walkinsRawTotal, scansRawTotal; // real period totals, for Scans Per Visitor
    let ordersRawTotal, onlineRawTotal; // real period totals, for Online Influenced %
    for (const def of METRICS) {
      if (def.pending) { out[def.key] = metricValue(null, periods, { pending: true }); continue; }
      if (def.sourceGroup && failedGroups.has(def.sourceGroup)) { out[def.key] = metricValue(null, periods, { unavailable: true }); continue; }
      // Malleshwaram (so far the only store like this) has no store_code in
      // customer_walkin/marketing_sale — an empty daily map would otherwise
      // silently compute a real-looking 0 for these 3, which would read as
      // "zero walk-ins/orders ever" rather than "not tracked here."
      if (storeObj && !storeObj.shortCode && (def.key === 'walkins' || def.key === 'orders' || def.key === 'revenue' || def.key === 'salesQty' || NEW_REPEAT_KEYS.includes(def.key) || def.key === 'newAtv' || def.key === 'repeatAtv' || def.key === 'purchaseAmount' || def.key === 'salesAmount' || def.key === 'margin' || def.key === 'newSalesAmount' || def.key === 'repeatSalesAmount' || def.key === 'scans' || def.key === 'scansPerVisitor' || def.key === 'marginPerSqft' || def.key === 'walkinsFromMeetings' || def.key === 'onlineInfluenced' || def.key === 'onlineInfluencedPct' || def.key === 'revenuePerStaff')) {
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
        case 'walkins': {
          const rawMap = walkins.get(storeKey) || new Map();
          walkinsRawTotal = metricValue(rawMap, periods);
          out[def.key] = metricValue(rawMap, periods, { avgPerDay: true });
          break;
        }
        // One decimal: these are small numbers, a whole-number daily average would round them to 0.
        case 'walkinsFromMeetings': out[def.key] = metricValue(walkinsFromMeetings.get(storeKey) || new Map(), periods, { round: round1, avgPerDay: true }); break;
        case 'meetingsShown': out[def.key] = metricValue(meetingsShown.get(storeKey) || new Map(), periods, { round: round1, avgPerDay: true }); break;
        case 'meetingsConverted': out[def.key] = metricValue(meetingsConverted.get(storeKey) || new Map(), periods, { round: round1, avgPerDay: true }); break;
        case 'onlineInfluenced': {
          const rawMap = onlineInfluenced.get(storeKey) || new Map();
          onlineRawTotal = metricValue(rawMap, periods);
          out[def.key] = metricValue(rawMap, periods, { round: round1, avgPerDay: true });
          break;
        }
        // Online Influenced Orders / Orders over the REAL period totals (never the per-day averages shown).
        case 'onlineInfluencedPct': out[def.key] = percentMetric(onlineRawTotal, ordersRawTotal); break;
        case 'orders': {
          const rawMap = orders.get(storeKey) || new Map();
          ordersRawTotal = metricValue(rawMap, periods);
          out[def.key] = metricValue(rawMap, periods, { avgPerDay: true });
          break;
        }
        case 'revenue': out[def.key] = metricValue(revenue.get(storeKey) || new Map(), periods, { round: round2, avgPerDay: true }); break;
        case 'salesQty': out[def.key] = metricValue(salesQty.get(storeKey) || new Map(), periods, { avgPerDay: true }); break;
        case 'purchaseAmount': out[def.key] = metricValue(purchaseAmount.get(storeKey) || new Map(), periods, { round: round2, avgPerDay: true }); break;
        case 'salesAmount': out[def.key] = metricValue(salesAmount.get(storeKey) || new Map(), periods, { round: round2, avgPerDay: true }); break;
        case 'margin': out[def.key] = metricValue(margin.get(storeKey) || new Map(), periods, { round: round2, avgPerDay: true }); break;
        case 'newSalesAmount': out[def.key] = metricValue(newSalesAmount.get(storeKey) || new Map(), periods, { round: round2, avgPerDay: true }); break;
        case 'repeatSalesAmount': out[def.key] = metricValue(repeatSalesAmount.get(storeKey) || new Map(), periods, { round: round2, avgPerDay: true }); break;
        // Margin per square foot of the store's floor area. Same per-day-average basis as
        // Margin itself (Last Week/Last Month), so this is "average daily margin per sq ft".
        case 'marginPerSqft': {
          const area = storeObj ? storeObj.areaSqFt : null;
          if (!area) { out[def.key] = metricValue(null, periods, { unavailable: true }); break; }
          const src = margin.get(storeKey) || new Map();
          out[def.key] = metricValue(new Map([...src].map(([k, v]) => [k, v / area])), periods, { round: round2, avgPerDay: true });
          break;
        }
        // Revenue divided by the store's fixed headcount. Same basis as Revenue itself (Last
        // Week/Last Month are per-day averages, a Custom range is a total), so this is average
        // daily revenue per staff member for those periods.
        case 'revenuePerStaff': {
          const staff = storeObj ? storeObj.staff : null;
          if (!staff) { out[def.key] = metricValue(null, periods, { unavailable: true }); break; }
          const src = revenue.get(storeKey) || new Map();
          out[def.key] = metricValue(new Map([...src].map(([k, v]) => [k, v / staff])), periods, { round: round2, avgPerDay: true });
          break;
        }
        case 'scans': {
          const rawMap = scans.get(storeKey) || new Map();
          scansRawTotal = metricValue(rawMap, periods);
          out[def.key] = metricValue(rawMap, periods, { round: round1, avgPerDay: true }); // 1 decimal: scan counts are small, a whole-number average would round them to 0
          break;
        }
        // Scans / Walkins (store visitors) over the REAL period totals, never the per-day averages shown above.
        case 'scansPerVisitor': out[def.key] = ratioMetric(scansRawTotal, walkinsRawTotal); break;
        case 'newWalkins': case 'repeatWalkins': case 'newBuyers': case 'repeatBuyers':
        case 'newOrders': case 'repeatOrders': case 'newRevenue': case 'repeatRevenue': {
          const rawMap = newRepeat[def.key].get(storeKey) || new Map();
          const isMoney = def.key === 'newRevenue' || def.key === 'repeatRevenue';
          nrRawTotals[def.key] = metricValue(rawMap, periods, isMoney ? { round: round2 } : {});
          out[def.key] = metricValue(rawMap, periods, isMoney ? { round: round2, avgPerDay: true } : { avgPerDay: true });
          break;
        }
        // ATV = revenue / orders over the REAL period totals, never the
        // per-day averages shown for the revenue/order metrics themselves.
        case 'newAtv': out[def.key] = ratioMetric(nrRawTotals.newRevenue, nrRawTotals.newOrders); break;
        case 'repeatAtv': out[def.key] = ratioMetric(nrRawTotals.repeatRevenue, nrRawTotals.repeatOrders); break;
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
        // Fixed headcount from config/stores.js (same value for every period).
        case 'staffCount': {
          const fixed = storeObj && storeObj.staff != null ? storeObj.staff : null;
          out[def.key] = metricValue(null, periods, { snapshot: true, snapshotValue: fixed });
          break;
        }
        default:
          out[def.key] = metricValue(null, periods, { pending: true });
      }
    }
    out.__rawTotals = { citySessionsRawTotal, dealsRawTotal, meetingsRawTotal, spendRawTotal };
    return out;
  }

  // GA4 can't tell stores in a shared city apart, so each store gets an even
  // share (50/50 for Mumbai and Delhi) of the city's daily sessions. The
  // "All Stores" aggregate below still uses the unscaled per-group totals.
  const storesPerGa4Group = new Map();
  STORES.forEach(s => storesPerGa4Group.set(s.ga4CityGroup, (storesPerGa4Group.get(s.ga4CityGroup) || 0) + 1));
  const ga4FieldsFor = s => {
    const groupFields = ga4ByGroup.get(s.ga4CityGroup);
    const splitFactor = 1 / storesPerGa4Group.get(s.ga4CityGroup);
    const ga4DailyByField = new Map();
    GA4_FIELDS.forEach(([k]) => {
      const scaled = new Map();
      if (groupFields) groupFields.get(k).forEach((v, dateKey) => scaled.set(dateKey, v * splitFactor));
      ga4DailyByField.set(k, scaled);
    });
    return ga4DailyByField;
  };
  const stores = STORES.map(s => {
    const ga4DailyByField = ga4FieldsFor(s);
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
      areaSqFt: s.areaSqFt || null,
      staff: s.staff || null,
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
  const meetingsRawTotal = sumIfAvailable('meetings', [...meetingsRaised.values(), meetingsUnassigned]);
  const spendRawTotal = sumIfAvailable('ads', [...spend.values()], { round: round2 });
  const citySessionsRawTotal = allMetrics.__rawTotals.citySessionsRawTotal;
  delete allMetrics.__rawTotals;
  allMetrics.deals = sumIfAvailable('deals', [...deals.values()], { avgPerDay: true });
  allMetrics.meetingsRaised = sumIfAvailable('meetings', [...meetingsRaised.values(), meetingsUnassigned], { avgPerDay: true });
  allMetrics.walkins = sumIfAvailable('walkins', [...walkins.values()], { avgPerDay: true });
  allMetrics.walkinsFromMeetings = sumIfAvailable('meetingWalkins', [...walkinsFromMeetings.values()], { round: round1, avgPerDay: true });
  allMetrics.meetingsShown = sumIfAvailable('meetingStatus', [...meetingsShown.values()], { round: round1, avgPerDay: true });
  allMetrics.meetingsConverted = sumIfAvailable('meetingStatus', [...meetingsConverted.values()], { round: round1, avgPerDay: true });
  // The All Stores figures that come from orders. A function so the Store Comparison tab can
  // build the same figures a second time from the MTO-built order maps.
  function applyAllOrderMetrics(target) {
    target.onlineInfluenced = sumIfAvailable('onlineInfluenced', [...onlineInfluenced.values()], { round: round1, avgPerDay: true });
    target.onlineInfluencedPct = percentMetric(
      sumIfAvailable('onlineInfluenced', [...onlineInfluenced.values()]),
      sumIfAvailable('orders', [...orders.values()])
    );
    target.orders = sumIfAvailable('orders', [...orders.values()], { avgPerDay: true });
    target.revenue = sumIfAvailable('orders', [...revenue.values()], { round: round2, avgPerDay: true });
    target.salesQty = sumIfAvailable('orders', [...salesQty.values()], { avgPerDay: true });
    // All Stores revenue per staff: total revenue over the headcount of the stores that have
    // revenue data (Malleshwaram has none, so its staff are left out too).
    const revenueStaffTotal = STORES.filter(s => s.shortCode && s.staff).reduce((a, s) => a + s.staff, 0);
    target.revenuePerStaff = (failedGroups.has('orders') || !revenueStaffTotal)
      ? metricValue(null, periods, { unavailable: true })
      : metricValue(new Map([...mergeDailyMaps([...revenue.values()])].map(([k, v]) => [k, v / revenueStaffTotal])), periods, { round: round2, avgPerDay: true });
    NEW_REPEAT_KEYS.filter(k => k !== 'newWalkins' && k !== 'repeatWalkins').forEach(k => {
      const isMoney = k === 'newRevenue' || k === 'repeatRevenue';
      target[k] = sumIfAvailable('orders', [...newRepeat[k].values()], isMoney ? { round: round2, avgPerDay: true } : { avgPerDay: true });
    });
    const nrTotal = k => sumIfAvailable('orders', [...newRepeat[k].values()], k.endsWith('Revenue') ? { round: round2 } : {});
    target.newAtv = ratioMetric(nrTotal('newRevenue'), nrTotal('newOrders'));
    target.repeatAtv = ratioMetric(nrTotal('repeatRevenue'), nrTotal('repeatOrders'));
    // Purchase / Sales Amount / Margin (the Store Comparison tab recomputes these on the MTO-built basis).
    target.purchaseAmount = sumIfAvailable('salesMargin', [...purchaseAmount.values()], { round: round2, avgPerDay: true });
    target.salesAmount = sumIfAvailable('salesMargin', [...salesAmount.values()], { round: round2, avgPerDay: true });
    target.margin = sumIfAvailable('salesMargin', [...margin.values()], { round: round2, avgPerDay: true });
    target.newSalesAmount = sumIfAvailable('salesMargin', [...newSalesAmount.values()], { round: round2, avgPerDay: true });
    target.repeatSalesAmount = sumIfAvailable('salesMargin', [...repeatSalesAmount.values()], { round: round2, avgPerDay: true });
    // All Stores margin per sq ft: total margin over the floor area of the stores that
    // actually have margin data (Malleshwaram has none, so its area is left out too).
    const marginAreaTotal = STORES.filter(s => s.shortCode && s.areaSqFt).reduce((a, s) => a + s.areaSqFt, 0);
    target.marginPerSqft = (failedGroups.has('salesMargin') || !marginAreaTotal)
      ? metricValue(null, periods, { unavailable: true })
      : metricValue(new Map([...mergeDailyMaps([...margin.values()])].map(([k, v]) => [k, v / marginAreaTotal])), periods, { round: round2, avgPerDay: true });
  }
  applyAllOrderMetrics(allMetrics);
  allMetrics.scans = sumIfAvailable('scans', [...scans.values()], { round: round1, avgPerDay: true });
  allMetrics.scansPerVisitor = ratioMetric(
    sumIfAvailable('scans', [...scans.values()]),
    sumIfAvailable('walkins', [...walkins.values()])
  );
  ['newWalkins', 'repeatWalkins'].forEach(k => {
    allMetrics[k] = sumIfAvailable('walkins', [...newRepeat[k].values()], { avgPerDay: true });
  });
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
  // All Stores = the fixed headcounts of every store added up.
  const totalStaffCount = STORES.reduce((sum, s) => sum + (s.staff || 0), 0);
  allMetrics.staffCount = metricValue(null, periods, { snapshot: true, snapshotValue: totalStaffCount || null });

  // Store Comparison tab only: the order-based metrics again, with a made-to-order (MTO) piece
  // counted only once it is billed (the RTS bill, by its date) and at the RTS bill amount instead
  // of the pre-order amount. Everything else, and the Dashboard tab, is unchanged. If either
  // source failed there is no compareMetrics and the page falls back to the normal figures.
  const MTO_COMPARE_KEYS = ['orders', 'revenue', 'salesQty', 'newBuyers', 'repeatBuyers', 'newRevenue',
    'repeatRevenue', 'newOrders', 'repeatOrders', 'newAtv', 'repeatAtv', 'revenuePerStaff', 'onlineInfluenced', 'onlineInfluencedPct',
    'purchaseAmount', 'salesAmount', 'margin', 'marginPerSqft', 'newSalesAmount', 'repeatSalesAmount'];
  const pickCompare = m => { const o = {}; MTO_COMPARE_KEYS.forEach(k => { if (m[k]) o[k] = m[k]; }); return o; };
  let allCompare = null;
  if (!failedGroups.has('orders') && !failedGroups.has('ordersRts') && !failedGroups.has('mtoBuilt') &&
      !failedGroups.has('onlineInfluenced') && !failedGroups.has('onlineInfluencedRts') &&
      !failedGroups.has('salesMargin') && !failedGroups.has('salesMarginRts')) {
    fillOrderMaps([...rows.ordersRts, ...rows.mtoBuilt]);
    fillSalesMarginMaps(rows.salesMarginRts);
    fillOnlineInfluenced(rows.onlineInfluencedRts);
    STORES.forEach((s, i) => {
      const m = buildMetricsFor(s.key, ga4FieldsFor(s), s);
      stores[i].compareMetrics = pickCompare(m);
    });
    const cm = {};
    applyAllOrderMetrics(cm);
    allCompare = pickCompare(cm);
    fillOrderMaps(orderRows);
    fillSalesMarginMaps(salesMarginRows);
    fillOnlineInfluenced(onlineInfluencedRows);
  }

  const allStores = {
    key: ALL_STORES_KEY,
    displayName: ALL_STORES_DISPLAY_NAME,
    shortCode: null,
    accent: '#241a18',
    citySharedLabel: null,
    metrics: allMetrics,
    compareMetrics: allCompare,
  };

  const ga4DataFailed = failedGroups.has('ga4');
  const SOURCE_GROUP_LABELS = {
    ga4: 'Traffic & Acquisition (GA4)', calls: 'Call Performance', deals: 'Deals', walkins: 'Walkins',
    orders: 'Orders & Revenue', salesMargin: 'Purchase / Sales / Margin', scans: 'Scans', meetingWalkins: 'Walkins From Meetings', onlineInfluenced: 'Online Influenced Orders', inventory: 'Inventory', meetings: 'Meetings Raised', meetingStatus: 'Meeting Show / Converted', meetingVisits: 'Meeting Visits (earlier meetings)',
    ads: 'Spend (Google Ads + Meta Ads)', gbp: 'Google Business Profile',
  };
  const failedSourceLabels = [...failedGroups].filter(g => g !== 'ga4Coverage').map(g => SOURCE_GROUP_LABELS[g] || g);

  // One clause per incomplete period, e.g. "Last Month (1 Aug - 31 Aug 2026):
  // 15 of 31 days available" — never implies a partial sum is a final total.
  const ga4Notes = [];
  if (!ga4DataFailed) {
    for (const key of Object.keys(ga4Periods)) {
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

// --- Order drill-down ------------------------------------------------------
// The bills behind an Orders count on the dashboard. Uses exactly the same
// source, filters and dates as ordersQuery() (marketing_sale, Channel='Store',
// the store's company_code(s), the same Yesterday / Last Week / Last Month
// window), so the number of bills listed here always equals the count that was
// clicked. Customer phone numbers are masked to the last 4 digits.
function maskMobile(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  return digits.length >= 4 ? 'XXXXXX' + digits.slice(-4) : '';
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function getOrderDetails(storesParam, periodKey, customRange) {
  const { periods } = getComparisonPeriods(undefined, undefined, customRange, { withToday: true });
  const period = periods[periodKey];
  if (!period) throw badRequest('Unknown period.');

  let wanted;
  if (!storesParam || storesParam === 'all') {
    wanted = STORES.filter(s => s.shortCode);
  } else {
    wanted = String(storesParam).split(',').map(k => STORES.find(s => s.key === k.trim()));
    if (wanted.some(s => !s)) throw badRequest('Unknown store.');
    wanted = wanted.filter(s => s.shortCode); // a store with no sales code has no bills here
  }

  const base = {
    period: { key: period.key, label: period.label, start: period.start, end: period.end, displayRange: period.displayRange },
    stores: wanted.map(s => ({ key: s.key, displayName: s.displayName })),
    generatedAt: new Date().toISOString(),
  };
  const codes = wanted.flatMap(s => [s.shortCode, ...(s.extraShortCodes || [])]);
  if (!codes.length) {
    return { ...base, totals: { orders: 0, pieces: 0, netSale: 0, newOrders: 0, repeatOrders: 0, cancelledOrders: 0, zeroValueOrders: 0 }, orders: [] };
  }
  const storeByCode = new Map(wanted.flatMap(s => [[s.shortCode, s], ...(s.extraShortCodes || []).map(c => [c, s])]));

  // Same basis as the Orders count on the Store Comparison tab: a made-to-order (MTO) pre-order bill
  // is not listed; instead each BUILT MTO is listed as its final RTS bill, on the RTS date and at
  // the RTS amount (unless that RTS bill is already in marketing_sale, which then lists it).
  const codeList = codes.map(c => `'${c}'`).join(',');
  const sql = `
    WITH ${mtoBuiltCtes(period.start, period.end)},
    cust AS (
      SELECT item_line_no, ANY_VALUE(customer_type) AS customer_type
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      WHERE item_line_no > 0
      GROUP BY item_line_no
    ),
    base AS (
      SELECT company_code, Transaction_Date AS txn_date, document_no, CAST(document_date AS STRING) AS document_date, customer_type,
             party_name, CAST(Cus_mobile AS STRING) AS Cus_mobile, Fullfillment, CAST(item_line_no AS INT64) AS item_line_no,
             Full_sku, Product_Title, item_group_name, CAST(pieces AS FLOAT64) AS pieces,
             CAST(net_sale AS FLOAT64) AS net_sale, CAST(discount AS FLOAT64) AS discount, FALSE AS is_mto_built
      FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
      WHERE Channel = 'Store'
        AND company_code IN (${codeList})
        AND IFNULL(Fullfillment, '') != 'MTO'
        AND Transaction_Date BETWEEN '${period.start}' AND '${period.end}'
    ),
    built AS (
      SELECT m.company_code, DATE(m.transaction_date) AS txn_date, m.RTS_NO AS document_no, CAST(NULL AS STRING) AS document_date,
             c.customer_type, m.party_name, CAST(COALESCE(m.mobile, m.mobile1) AS STRING) AS Cus_mobile,
             'MTO billed (RTS)' AS Fullfillment, CAST(m.item_line_no AS INT64) AS item_line_no,
             m.full_sku AS Full_sku, m.item_name AS Product_Title, CAST(NULL AS STRING) AS item_group_name,
             CAST(m.pieces AS FLOAT64) AS pieces, CAST(m.RTS_Amount AS FLOAT64) AS net_sale, CAST(0 AS FLOAT64) AS discount, TRUE AS is_mto_built
      FROM mto m
      LEFT JOIN cust c ON c.item_line_no = m.item_line_no
      LEFT JOIN counted ct ON ct.document_no = m.RTS_NO
      WHERE ct.document_no IS NULL AND m.company_code IN (${codeList})
    ),
    lines AS (
      SELECT * FROM base
      UNION ALL
      SELECT * FROM built
    ),
    sales AS (
      SELECT item_line_no, MAX(sub_total - IFNULL(discount, 0)) AS sales_amount
      FROM \`lucirajewelry-prod.ornaverse_erp_pos.invoice_items\`
      WHERE item_line_no > 0 GROUP BY item_line_no
    ),
    ${purchaseCostCte({ withDoc: true })}
    SELECT l.*, s.sales_amount, p.purchase_amount, p.purchase_doc, p.purchase_line
    FROM lines l
    LEFT JOIN sales s ON l.item_line_no > 0 AND s.item_line_no = l.item_line_no
    LEFT JOIN purchase p ON l.item_line_no > 0 AND p.item_line_no = l.item_line_no
    ORDER BY l.txn_date DESC, l.document_no
  `;
  const [rows] = await bigquery.query({ query: sql });

  const byDoc = new Map();
  for (const row of rows) {
    const docNo = bqVal(row.document_no);
    if (!docNo) continue;
    let o = byDoc.get(docNo);
    if (!o) {
      const store = storeByCode.get(bqVal(row.company_code));
      o = {
        documentNo: docNo,
        date: String(bqVal(row.txn_date)),
        billedAt: bqVal(row.document_date) || '',
        storeKey: store ? store.key : null,
        store: store ? store.displayName : bqVal(row.company_code),
        customer: bqVal(row.party_name) || '',
        mobile: maskMobile(bqVal(row.Cus_mobile)),
        customerType: bqVal(row.customer_type) || '',
        fulfilment: [],
        pieces: 0, netSale: 0, discount: 0,
        items: [],
        freeItems: 0,
        salesAmount: 0, purchaseAmount: 0, matchedLines: 0,
        _seenLines: new Set(),
      };
      byDoc.set(docNo, o);
    }
    const lineNo = bqVal(row.item_line_no);
    // A free item (net sale 0) is not counted: not in the pieces, the list, the amounts or the
    // totals. It is only remembered, so the bill can say how many free items were left out.
    if (toNumber(row.net_sale) === 0) {
      o.freeItems = (o.freeItems || 0) + 1;
      continue;
    }
    o.pieces += toNumber(row.pieces);
    o.netSale += toNumber(row.net_sale);
    o.discount += toNumber(row.discount);
    const ful = bqVal(row.Fullfillment);
    if (ful && !o.fulfilment.includes(ful)) o.fulfilment.push(ful);
    o.items.push({
      lineNo: lineNo == null ? '' : String(lineNo),
      sku: bqVal(row.Full_sku) || '',
      title: bqVal(row.Product_Title) || bqVal(row.item_group_name) || '',
      pieces: toNumber(row.pieces),
      netSale: round2(toNumber(row.net_sale)),
      // This piece's own amounts, by item_line_no: Sales Amount = POS sub_total - discount,
      // Purchase Amount = purchase invoice (or consignment) sub_total, Margin = this piece's sales amount - purchase.
      // Each is null when that side has no line for the piece; `matched` means both exist,
      // which is the only case that counts toward the bill total and the dashboard's Margin.
      salesAmount: row.sales_amount == null ? null : round2(toNumber(row.sales_amount)),
      purchaseAmount: row.purchase_amount == null ? null : round2(toNumber(row.purchase_amount)),
      // Document number of the purchase invoice (GRN) or consignment-in (APU) the cost came from.
      purchaseDoc: row.purchase_amount == null ? '' : (bqVal(row.purchase_doc) || ''),
      // The item line number the purchase cost was found under, when it differs from the sold line
      // (a piece allocated to the order under another line number). Empty when it is the same.
      purchaseLine: (row.purchase_amount != null && bqVal(row.purchase_line) != null && String(bqVal(row.purchase_line)) !== String(lineNo)) ? String(bqVal(row.purchase_line)) : '',
      matched: row.sales_amount != null && row.purchase_amount != null,
      margin: (row.sales_amount != null && row.purchase_amount != null)
        ? round2(toNumber(row.sales_amount) - toNumber(row.purchase_amount)) : null,
    });
    // Sales/Purchase Amount follow the dashboard's Margin rule: only lines found
    // in BOTH ERP invoice tables, each item line counted once.
    const s = row.sales_amount == null ? null : toNumber(row.sales_amount);
    const p = row.purchase_amount == null ? null : toNumber(row.purchase_amount);
    if (s != null && p != null && !o._seenLines.has(String(lineNo))) {
      o._seenLines.add(String(lineNo));
      o.salesAmount += s;
      o.purchaseAmount += p;
      o.matchedLines += 1;
    }
  }

  const allBills = [...byDoc.values()].map(o => {
    const matched = o.matchedLines > 0;
    const cancelled = o.fulfilment.some(f => /cancel/i.test(f));
    delete o._seenLines;
    return {
      ...o,
      fulfilment: o.fulfilment.join(', '),
      cancelled,
      netSale: round2(o.netSale),
      discount: round2(o.discount),
      salesAmount: matched ? round2(o.salesAmount) : null,
      purchaseAmount: matched ? round2(o.purchaseAmount) : null,
      margin: matched ? round2(o.salesAmount - o.purchaseAmount) : null, // Sales Amount - Purchase Amount (matched lines)
    };
  });

  // Same rule as the Orders count: a bill with a total net sale of 0 is not an order, so it
  // is left out of the list (and counted separately as "not counted").
  const orders = allBills.filter(o => o.netSale !== 0);
  const totals = {
    orders: orders.length,
    pieces: orders.reduce((a, o) => a + o.pieces, 0),
    netSale: round2(orders.reduce((a, o) => a + o.netSale, 0)),
    newOrders: orders.filter(o => /^new$/i.test(o.customerType)).length,
    repeatOrders: orders.filter(o => /^repeat$/i.test(o.customerType)).length,
    cancelledOrders: orders.filter(o => o.cancelled).length,
    zeroValueOrders: allBills.length - orders.length, // ₹0 bills left out of the list
  };
  return { ...base, totals, orders };
}

module.exports = { buildStorePerformanceDashboard, getOrderDetails, validateCustomRange, STORES };
