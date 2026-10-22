// Canonical registry of every metric on the Store Performance dashboard —
// the single place that says what a metric is called, which section it
// belongs to, how it should be formatted, and whether it's backed by a
// verified BigQuery source yet. The backend uses `pending` to decide what
// to compute; the frontend uses this whole list (returned as part of the
// API response) to render sections/labels/formats without duplicating any
// of it locally, and the Logic tab documents the `sourceNote`/`pendingReason`
// for every row.
//
// format: 'int' | 'currency' | 'duration' | 'rating'
// sourceGroup: which BigQuery query group (in storePerformanceService.js)
// this metric is computed from — used to mark it "Data unavailable" (not
// pending, not fabricated) if that one query fails while the rest of the
// dashboard succeeds. Absent on `pending` metrics, which have no source at all.
const METRICS = [
  // --- Section 1: Traffic & Acquisition (GA4) ---
  // Sourced from analytics_478308692 (the linked GA4 BigQuery export, raw
  // event-level data) — computed as COUNT(DISTINCT session key), the
  // standard GA4-BigQuery session calculation. Verified directly against
  // GA4's own reported number (Pune, 17 Sep 2026: 905 computed vs 906
  // reported) — no known accuracy gap, unlike the two other GA4-derived
  // tables in this project that were tried and rejected (see storePerformanceService.js).
  {
    key: 'citySessions', label: 'City Sessions', section: 'traffic', format: 'int', sourceGroup: 'ga4',
    sourceNote: 'analytics_478308692.events_* — COUNT(DISTINCT session key), all traffic sources, no channel filter.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected. Cost Per Session still divides Spend by the real period total, not this average.',
  },
  {
    key: 'paidSessions', label: 'Paid Sessions', section: 'traffic', format: 'int', sourceGroup: 'ga4',
    sourceNote: 'analytics_478308692.events_* — COUNT(DISTINCT session key) where source=google (medium not organic), source IN (facebook, fb, ig) (medium not referral/none), or source IN (broadcast, trigger).',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'retargetingSessions', label: 'Retargeting Sessions', section: 'traffic', format: 'int', sourceGroup: 'ga4',
    sourceNote: 'analytics_478308692.events_* — COUNT(DISTINCT session key) where LOWER(source) LIKE \'%rtb%\' OR LOWER(source) LIKE \'%criteo%\'.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'communicationSessions', label: 'Communication Sessions', section: 'traffic', format: 'int', sourceGroup: 'ga4',
    sourceNote: 'analytics_478308692.events_* — COUNT(DISTINCT session key) where source IN (broadcast, trigger).',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },

  // --- Section 2: Lead / CRM Funnel ---
  {
    key: 'deals', label: 'Deals', section: 'crm', format: 'int', sourceGroup: 'deals',
    sourceNote: 'Zoho CRM API — Deals module — COUNT of all deals created, bucketed by Address_City into a city group (Mumbai / Delhi / Pune / Noida / Bengaluru) and split evenly across the stores sharing that group.',
    dataNote: 'Approximate, not exact per store: Deals has no reliable store field (Store_Assigned/Store_Name are verified 0% populated, across all 30,204 deals ever), so a city’s deal count is split evenly between its stores (Mumbai: Borivali/Chembur; Delhi: Paschim Vihar/Lajpat Nagar). Deals outside these 5 city groups are real but not attributable to any of the 7 stores, and are excluded, not counted as 0. Noida is verified genuinely low-volume in this field (12 "Noida"-tagged deals in the table’s entire history) — a near-0 count there reflects that, not a mapping bug. Last Week/Last Month show the average per day, not the period total (Yesterday is unaffected); Cost Per Deal still divides Spend by the real period total, not this average.',
  },
  {
    key: 'meetingsRaised', label: 'Meetings Raised', section: 'crm', format: 'int', sourceGroup: 'meetings',
    sourceNote: 'zoho_crm.cdc_meetings — COUNT of meeting records by created_time_ist (Asia/Kolkata).',
    dataNote: 'BigQuery sync for this table has been observed to show stale/mismatched records for the most recent day — live Zoho API access is blocked (Meetings module not in this app’s OAuth scope). Treat "Yesterday" as indicative, not exact. Last Week/Last Month show the average per day, not the period total; Cost Per Appointment still divides Spend by the real period total, not this average.',
  },
  {
    key: 'walkins', label: 'Walkins', section: 'crm', format: 'int', sourceGroup: 'walkins',
    sourceNote: 'ds_imputed_reporting.Walkin_marge — COUNT of rows by store_code and walkin_date.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'orders', label: 'Orders', section: 'crm', format: 'int', sourceGroup: 'orders',
    sourceNote: 'ds_imputed_reporting.marketing_sale — COUNT(DISTINCT document_no) where Channel = \'Store\'.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'revenue', label: 'Revenue', section: 'crm', format: 'currency', sourceGroup: 'orders',
    sourceNote: 'ds_imputed_reporting.marketing_sale — SUM(net_sale) where Channel = \'Store\'.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },

  // --- Section 3: Call Performance ---
  // Live Zoho CRM API (Calls module), not BigQuery — the BigQuery export
  // (Lucira_Prod.lucira_zoho_Calls) lags several days behind at times, while
  // the live API is current to the minute. Reuses the same zohoClient.js
  // every other dashboard in this app already uses for live Zoho data.
  {
    key: 'callsDialed', label: 'Store Calls Dialed', section: 'calls', format: 'int', sourceGroup: 'calls',
    sourceNote: 'Zoho CRM API — Calls module — COUNT of records where Call_Type = \'Outbound\' and Owner.name matches the store.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'callsConnected', label: 'Connected Calls', section: 'calls', format: 'int', sourceGroup: 'calls',
    sourceNote: 'Zoho CRM API — Calls module — COUNT where Call_Status IN connected-status list.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'callsConnected30s', label: 'Connected Calls > 30 Seconds', section: 'calls', format: 'int', sourceGroup: 'calls',
    sourceNote: 'Zoho CRM API — Calls module — connected calls where Call_Duration_in_seconds > 30.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'talktimeSeconds', label: 'Store Talktime', section: 'calls', format: 'duration', sourceGroup: 'calls',
    sourceNote: 'Zoho CRM API — Calls module — SUM(Call_Duration_in_seconds) over connected calls.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },

  // --- Section 4: Store / Google Performance ---
  // Sourced live from Google Business Profile APIs (see src/gbpClient.js),
  // via an OAuth account ("Bizloc8 Lucira") that actually manages all 7 real
  // store listings — found after the originally connected account turned out
  // to only have access to 1 unrelated corporate office listing.
  {
    key: 'gmbStrength', label: 'GMB Strength', section: 'google', format: 'rating', sourceGroup: 'gbp',
    sourceNote: 'mybusinessbusinessinformation.googleapis.com/v1 locations.get — a 0-10 completeness score computed by this app (not an official Google metric) from how many of 6 profile fields (phone, address, website, hours, categories, description) are populated.',
    dataNote: 'Google\'s own Business Profile Manager UI shows only a partial-progress ring, not a numeric score — this is our own proxy for "how complete is the listing," not something Google publishes directly.',
  },
  {
    key: 'googleReviews', label: 'Lifetime Google Reviews', section: 'google', format: 'int', sourceGroup: 'gbp',
    sourceNote: 'mybusiness.googleapis.com/v4 reviews.list — totalReviewCount, a current snapshot (not period-based), same as Inventory.',
  },
  {
    key: 'googleRating', label: 'Google Rating', section: 'google', format: 'rating', sourceGroup: 'gbp',
    sourceNote: 'mybusiness.googleapis.com/v4 reviews.list — averageRating, a current snapshot (not period-based). Verified directly against the public Google Maps listing (e.g. Chembur: 4.9, 260 reviews — exact match).',
  },
  {
    key: 'storeDirectionClicks', label: 'Store Direction Clicks', section: 'google', format: 'int', sourceGroup: 'gbp',
    sourceNote: 'businessprofileperformance.googleapis.com/v1 :fetchMultiDailyMetricsTimeSeries — BUSINESS_DIRECTION_REQUESTS, real per-day counts.',
    dataNote: 'Google\'s performance data lags roughly 2-3 days behind today — the most recent day or two may show as unavailable/lower than final, not because nothing happened but because Google hasn\'t finished processing it yet. Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'storeIncomingCalls', label: 'Store Calls Clicked', section: 'google', format: 'int', sourceGroup: 'gbp',
    sourceNote: 'businessprofileperformance.googleapis.com/v1 :fetchMultiDailyMetricsTimeSeries — CALL_CLICKS, real per-day counts.',
    dataNote: 'This counts taps on the "Call" button on the Business Profile listing itself, not completed/answered phone calls (Google doesn\'t expose actual call volume) — same processing lag as Direction Clicks applies. Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },

  // --- Section 5: Store Operations ---
  {
    key: 'inventory', label: 'Inventory', section: 'operations', format: 'int', snapshot: true, sourceGroup: 'inventory',
    sourceNote: 'ds_imputed_reporting.Live_inventory — SUM(pieces) where location_name = \'Finish Goods\', a live/current snapshot (not period-based).',
  },
  {
    key: 'staffCount', label: 'Number of Staff', section: 'operations', format: 'int', snapshot: true, editable: true,
    sourceNote: 'Manually entered on this dashboard (store_performance_app_data.store_staff_counts) — no HR/staffing source table exists in the project, so this is a live snapshot the store team fills in themselves, not a query.',
    dataNote: 'Blank until entered for a store — never shown as 0 just because nothing has been typed in yet. "All Stores" sums whichever stores have a value entered so far.',
  },

  // --- Section 6: Marketing Efficiency ---
  // Combined Google Ads + Meta Ads, both from ONE table —
  // ds_imputed_reporting.ads_spend_live_city_daily (see marketingAdsSpendQuery()
  // in storePerformanceService.js) — real per-campaign-per-day spend for
  // both platforms, no separate Meta API/token needed. Reconciled directly
  // against the previously-used Google-only source for 2026-09-28: 81,475.24
  // here vs 81,462.03 there — a 0.02% difference, normal cross-pipeline
  // rounding, not a real discrepancy. campaign_name is verified never null
  // (0 of ~1.86M Google rows, 0 of ~168K Meta rows) and Meta is fresh
  // through the same day as Google — better on both counts than two
  // sibling tables also tried and rejected: marketing_ads_geo_daily (exact
  // total match, but campaign_name is NULL on 100% of its Google rows,
  // silently breaking store attribution) and v_marketing_ads_daily (real
  // campaign names, but Meta lagged ~3 days behind Google). Neither
  // platform has a store field — spend is attributed by matching
  // city/store keywords in the campaign name (the same naming convention
  // both teams use on both platforms, e.g. "chembur", "pune",
  // "malleswaram") — this app's own classifier, not the table's own
  // city/state/city_attributed columns (which only resolve to city level,
  // not store level). A campaign naming several stores at once (common on
  // Meta, e.g. "mumbai-pune-noida") splits evenly across all of them, not
  // just the first match. Most campaigns on both platforms carry no such
  // keyword (pan-India/multi-category) and are excluded, so this is
  // store/city-attributable spend, not the company's total ad spend.
  {
    key: 'spend', label: 'Spend', section: 'marketing', format: 'currency', sourceGroup: 'ads',
    sourceNote: 'ds_imputed_reporting.ads_spend_live_city_daily (Google Ads + Meta Ads combined) — SUM(spend) attributed to a store by city/store keywords in the campaign name; a campaign naming multiple stores splits evenly across all of them.',
    dataNote: 'Partial, not total ad spend: only campaigns whose name tags a specific city/store are counted (verified — e.g. "offline_mof_all_chembur_acqn_search-gmb", "offline_tof_bangalore_malleswaram_acqn_iform"). Most campaigns run pan-India with no city signal and are excluded from every store and from "All Stores" too — this is store/city-attributable spend, not the company’s full ad spend on either platform. A campaign named for a city is presumed, not proven, to be geo-restricted there. This table\'s own city/city_attributed columns are deliberately NOT used for attribution — verified that field reflects where a click physically came from (a pan-India campaign gets "city" rows for over 100 Indian cities with real clicks, most with no Lucira store at all), not which store a campaign was built for. Last Week/Last Month show the average per day, not the period total (Yesterday stays a single day\'s total); the Cost-Per-X ratios always divide by the real period total, not this average.',
  },
  {
    key: 'costPerSession', label: 'Cost Per Session', section: 'marketing', format: 'currency',
    sourceNote: 'Spend / City Sessions, computed per period.',
    formula: 'Spend / City Sessions',
    dataNote: 'Inherits Spend’s partial city/store attribution — see the Spend row.',
  },
  {
    key: 'costPerDeal', label: 'Cost Per Deal', section: 'marketing', format: 'currency',
    sourceNote: 'Spend / Deals, computed per period.',
    formula: 'Spend / Deals',
    dataNote: 'Inherits Spend’s partial city/store attribution and Deals’ city-split approximation.',
  },
  {
    key: 'costPerAppointment', label: 'Cost Per Appointment', section: 'marketing', format: 'currency',
    sourceNote: 'Spend / Meetings Raised, computed per period.',
    formula: 'Spend / Meetings Raised',
    dataNote: 'Inherits Spend’s partial city/store attribution and Meetings Raised’s sync caveat.',
  },
];

const SECTIONS = [
  { key: 'traffic', title: 'Traffic & Acquisition' },
  { key: 'crm', title: 'Lead / CRM Funnel' },
  { key: 'calls', title: 'Call Performance' },
  { key: 'google', title: 'Store / Google Performance' },
  { key: 'operations', title: 'Store Operations' },
  { key: 'marketing', title: 'Marketing Efficiency' },
];

module.exports = { METRICS, SECTIONS };
