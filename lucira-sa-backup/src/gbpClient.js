require('dotenv').config();

// Google Business Profile integration — verified directly against the live
// APIs (2026-09-29) before building this, same as every other source in this
// app. Three separate Google APIs are combined per store:
//   - mybusiness.googleapis.com/v4 reviews.list — averageRating/totalReviewCount
//     (a snapshot/lifetime total, not period-bucketed — same treatment as Inventory).
//     This is the legacy "Google My Business API v4"; it still works for
//     reviews (verified live) even though most other v4 endpoints have been
//     superseded by the newer Business Profile API family below.
//   - mybusinessbusinessinformation.googleapis.com/v1 locations.get — full
//     profile fields, used to compute a completeness score (GMB Strength).
//     There is no official numeric "profile strength" field in Google's API
//     (the Business Profile Manager UI only shows a partial-progress ring) —
//     this is OUR OWN completeness proxy, computed from which real fields are
//     populated, not a number Google itself publishes. Disclosed in metrics.js.
//   - businessprofileperformance.googleapis.com/v1 :fetchMultiDailyMetricsTimeSeries
//     — CALL_CLICKS and BUSINESS_DIRECTION_REQUESTS, real per-day counts.
//     Verified this data lags ~2-3 days behind "today" (the most recent
//     couple of days often come back with no `value` field at all, meaning
//     not-yet-processed, not zero) — never treated as a real 0.
//
// The OAuth account connected here (see scripts/gbp-auth.js) manages the
// actual 7 store listings under accounts/106076369511962860792 ("Bizloc8
// Lucira") — a different account from the one originally connected, which
// only had access to 1 unrelated corporate office listing.

const CLIENT_ID = process.env.GBP_CLIENT_ID;
const CLIENT_SECRET = process.env.GBP_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GBP_REFRESH_TOKEN;

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);
}

// Fields whose presence/absence feeds the GMB Strength completeness proxy.
const COMPLETENESS_FIELDS = ['phoneNumbers', 'storefrontAddress', 'websiteUri', 'regularHours', 'categories', 'profile'];

let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry) return cachedAccessToken;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`GBP token refresh failed: ${JSON.stringify(data)}`);
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiry = Date.now() + (Number(data.expires_in || 3600) - 60) * 1000;
  return cachedAccessToken;
}

function dateParts(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return { year, month, day };
}

// One store's reviews aggregate — a current snapshot, not scoped to any period.
async function fetchReviewsAggregate(accessToken, accountName, locationName) {
  const res = await fetch(
    `https://mybusiness.googleapis.com/v4/${accountName}/${locationName}/reviews?pageSize=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`GBP reviews fetch failed (${res.status}) for ${locationName}`);
  const data = await res.json();
  return {
    averageRating: typeof data.averageRating === 'number' ? data.averageRating : null,
    totalReviewCount: typeof data.totalReviewCount === 'number' ? data.totalReviewCount : null,
  };
}

// One store's profile completeness — computed from real field presence, not
// an official Google score. See COMPLETENESS_FIELDS above.
async function fetchProfileStrength(accessToken, locationName) {
  const res = await fetch(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}?readMask=${COMPLETENESS_FIELDS.join(',')}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`GBP location info fetch failed (${res.status}) for ${locationName}`);
  const data = await res.json();
  const presentCount = COMPLETENESS_FIELDS.filter(f => data[f] != null).length;
  return Math.round((presentCount / COMPLETENESS_FIELDS.length) * 10 * 10) / 10; // 0-10 scale, 1 decimal
}

// Direction requests + call-button clicks, real per-day counts across the
// given window. Days with no `value` field are still-processing (Google's
// ~2-3 day lag), not a real 0 — callers must only bump days that actually
// have a value, same discipline as every other daily-map source in this app.
async function fetchPerformanceMetrics(accessToken, locationName, startDate, endDate) {
  const start = dateParts(startDate);
  const end = dateParts(endDate);
  const params = new URLSearchParams();
  params.append('dailyMetrics', 'CALL_CLICKS');
  params.append('dailyMetrics', 'BUSINESS_DIRECTION_REQUESTS');
  params.append('dailyRange.start_date.year', start.year);
  params.append('dailyRange.start_date.month', start.month);
  params.append('dailyRange.start_date.day', start.day);
  params.append('dailyRange.end_date.year', end.year);
  params.append('dailyRange.end_date.month', end.month);
  params.append('dailyRange.end_date.day', end.day);

  const res = await fetch(
    `https://businessprofileperformance.googleapis.com/v1/${locationName}:fetchMultiDailyMetricsTimeSeries?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`GBP performance fetch failed (${res.status}) for ${locationName}`);
  const data = await res.json();
  const series = (data.multiDailyMetricTimeSeries && data.multiDailyMetricTimeSeries[0] && data.multiDailyMetricTimeSeries[0].dailyMetricTimeSeries) || [];

  const callClicks = new Map();
  const directionRequests = new Map();
  for (const metricSeries of series) {
    const target = metricSeries.dailyMetric === 'CALL_CLICKS' ? callClicks : (metricSeries.dailyMetric === 'BUSINESS_DIRECTION_REQUESTS' ? directionRequests : null);
    if (!target) continue;
    for (const dv of (metricSeries.timeSeries && metricSeries.timeSeries.datedValues) || []) {
      if (dv.value == null) continue; // not-yet-processed day, not a real 0
      const d = dv.date;
      const dateKey = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
      target.set(dateKey, Number(dv.value));
    }
  }
  return { callClicks, directionRequests };
}

// Fetches all 3 data types for every store in one pass, tolerating individual
// store/location failures (e.g. Malleshwaram is still "Processing" in
// Business Profile Manager as of this writing, so may not fully respond yet)
// without failing the whole group — same Promise.allSettled discipline as
// runSourceGroups() elsewhere in storePerformanceService.js.
async function fetchAllStoreData(stores, startDate, endDate) {
  if (!isConfigured()) return new Map();
  const accessToken = await getAccessToken();
  const results = new Map();
  await Promise.all(stores.filter(s => s.gbpLocationName).map(async (store) => {
    try {
      const [reviews, strength, performance] = await Promise.all([
        fetchReviewsAggregate(accessToken, store.gbpAccountName, store.gbpLocationName),
        fetchProfileStrength(accessToken, store.gbpLocationName),
        fetchPerformanceMetrics(accessToken, store.gbpLocationName, startDate, endDate),
      ]);
      results.set(store.key, { ...reviews, strength, ...performance });
    } catch (err) {
      results.set(store.key, { error: err.message });
    }
  }));
  return results;
}

module.exports = { isConfigured, fetchAllStoreData };
