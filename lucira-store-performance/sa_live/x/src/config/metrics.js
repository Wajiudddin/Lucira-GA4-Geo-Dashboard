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
    sourceNote: 'ds_imputed_reporting.ga4_city_sessions_daily (daily summary of the GA4 export analytics_478308692.events_*) — COUNT(DISTINCT session key), all traffic sources, no channel filter.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected. Cost Per Session still divides Spend by the real period total, not this average.',
  },
  {
    key: 'paidSessions', label: 'Paid Sessions', section: 'traffic', format: 'int', sourceGroup: 'ga4',
    sourceNote: 'ds_imputed_reporting.ga4_city_sessions_daily (daily summary of the GA4 export analytics_478308692.events_*) — COUNT(DISTINCT session key) where source=google (medium not organic), or source IN (facebook, fb, ig) (medium not referral/none). Excludes broadcast/trigger (see Communication Sessions).',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'retargetingSessions', label: 'Retargeting Sessions', section: 'traffic', format: 'int', sourceGroup: 'ga4',
    sourceNote: 'ds_imputed_reporting.ga4_city_sessions_daily (daily summary of the GA4 export analytics_478308692.events_*) — COUNT(DISTINCT session key) where LOWER(source) LIKE \'%rtb%\' OR LOWER(source) LIKE \'%criteo%\'.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'communicationSessions', label: 'Communication Sessions', section: 'traffic', format: 'int', sourceGroup: 'ga4',
    sourceNote: 'ds_imputed_reporting.ga4_city_sessions_daily (daily summary of the GA4 export analytics_478308692.events_*) — COUNT(DISTINCT session key) where source IN (broadcast, trigger).',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },

  // --- Section 2: Lead / CRM Funnel ---
  {
    key: 'deals', label: 'Deals', section: 'crm', format: 'int', sourceGroup: 'deals',
    sourceNote: 'Zoho CRM API — Deals module — COUNT of all deals created, routed by Address_City: Mumbai splits 50/50 Borivali/Chembur; Central, South and South West Delhi go to Lajpat Nagar; North, North West and West Delhi go to Paschim Vihar; East Delhi and Noida go to Noida; other Delhi values split 50/50 Lajpat Nagar/Paschim Vihar.',
    dataNote: 'Approximate, not exact per store: Deals has no reliable store field (Store_Assigned/Store_Name are verified 0% populated, across all 30,204 deals ever), so deals are routed by Address_City (Mumbai splits 50/50 Borivali/Chembur; Delhi deals follow the zone table on the Logic tab). Deals outside these city groups are real but not attributable to any of the 7 stores, and are excluded, not counted as 0. Noida is verified genuinely low-volume in this field (12 "Noida"-tagged deals in the table’s entire history) — a near-0 count there reflects that, not a mapping bug. Last Week/Last Month show the average per day, not the period total (Yesterday is unaffected); Cost Per Deal still divides Spend by the real period total, not this average.',
  },
  {
    key: 'meetingsRaised', label: 'Meetings Raised', section: 'crm', format: 'int', sourceGroup: 'meetings',
    sourceNote: 'zoho_crm.cdc_meetings — COUNT of meeting records by created_time_ist (Asia/Kolkata). Store comes from the meeting owner, else the free-text Venue field.',
    dataNote: 'Store is read from the meeting\'s Venue. Blank venues count in All Stores only; non-store venues (HO, Video Call, etc.) are ignored. Last Week/Last Month show the average per day.',
  },
  {
    key: 'walkinsFromMeetings', label: 'Walkins From Meetings', section: 'crm', format: 'smart', sourceGroup: 'meetingWalkins',
    sourceNote: 'Lucira_Prod.customer_walkin (source = Store Walkin) visits matched by mobile number to a meeting raised before the visit (meeting mobile from zoho_meeting_journey_v: Deal / Contact / Lead).',
    dataNote: 'Store visits by customers who had a meeting raised before the visit: the first visit after the meeting was raised (any time later), counted once, on the day and at the store of the visit. Always part of Walkins. Matched on the 10-digit mobile number, so a meeting or visit with no valid mobile cannot be linked. Last Week/Last Month show the average per day (one decimal).',
  },
  {
    key: 'walkins', label: 'Walkins', section: 'crm', format: 'int', sourceGroup: 'walkins',
    sourceNote: 'Lucira_Prod.customer_walkin — rows with source = Store Walkin, by store (company_id -> company_code) and India visit date; a person with a valid mobile counts once per store per day.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'orders', label: 'Orders', section: 'crm', format: 'int', sourceGroup: 'orders',
    sourceNote: 'ds_imputed_reporting.marketing_sale — COUNT(DISTINCT document_no) where Channel = \'Store\' and the bill\'s total net sale is not 0.',
    dataNote: 'Bills with a total net sale of ₹0 (free-gift bills) are not counted. Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'onlineInfluenced', label: 'Online Influenced Orders', section: 'crm', format: 'smart', sourceGroup: 'onlineInfluenced',
    sourceNote: 'marketing_sale orders matched (mobile or email) to a Zoho deal (zoho_crm.cdc_deals) created before the order, or to a Shopify customer with email consent "subscribed" (Lucira_Prod.Lucira_Shopify_customers) created before the order.',
    dataNote: 'Orders (same count as Orders, \u20B90 bills excluded) whose buyer was already known online before buying in store: they had a Zoho deal (a deal means they interacted online first) or had signed up on the website with email "subscribed". Matched on the 10-digit mobile or the email. An order is counted once even if both apply. Last Week/Last Month show the average per day (one decimal).',
  },
  {
    key: 'onlineInfluencedPct', label: 'Online Influenced %', section: 'crm', format: 'percent', sourceGroup: 'onlineInfluenced',
    sourceNote: 'Online Influenced Orders / Orders, computed per period.',
    formula: 'Online Influenced Orders / Orders',
    dataNote: 'Share of orders whose buyer was already known online before buying in store. Computed from the real period totals, not from the per-day averages shown for the two counts.',
  },
  {
    key: 'revenue', label: 'Revenue', section: 'crm', format: 'currency', sourceGroup: 'orders',
    sourceNote: 'ds_imputed_reporting.marketing_sale — SUM(net_sale) where Channel = \'Store\'.',
    dataNote: 'Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'salesQty', label: 'Sales Qty', section: 'crm', format: 'int', sourceGroup: 'orders',
    sourceNote: 'ds_imputed_reporting.marketing_sale — SUM(pieces) where Channel = \'Store\'.',
    dataNote: 'Number of pieces sold (a multi-piece order counts every piece, unlike Orders). Free items (item lines with a net sale of ₹0) are not counted. Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'purchaseAmount', label: 'Purchase Amount', section: 'crm', format: 'currency', sourceGroup: 'salesMargin',
    sourceNote: 'purchase.invoice_items — sub_total, tied to each sold store line by item_line_no; if the piece has no purchase invoice line, purchase.consignment_items — sub_total for the same item_line_no; if neither, the same lookup under the item line number of the stock piece allocated to it (Lucira_Prod.stock_allocation_items -> stock_allocated_items).',
    dataNote: 'Cost (purchase invoice sub_total, or the consignment-in line\'s sub_total when the piece has no purchase invoice) of the items sold. Free items (net sale ₹0) are left out. Counts only sold lines found in both the POS and a purchase cost table, so pre-order (RPO) bills that are not invoiced yet are not included. Last Week/Last Month show the average per day.',
  },
  {
    key: 'salesAmount', label: 'Sales Amount', section: 'crm', format: 'currency', sourceGroup: 'salesMargin',
    sourceNote: 'ornaverse_erp_pos.invoice_items — sub_total - discount (the line\'s taxable amount), tied to each sold store line by item_line_no.',
    dataNote: 'POS invoice sub_total less discount (taxable amount) of the same lines used for Purchase Amount, so it is lower than Revenue (which also includes pre-order bills). Last Week/Last Month show the average per day.',
  },
  {
    key: 'margin', label: 'Margin', section: 'crm', format: 'currency', sourceGroup: 'salesMargin',
    sourceNote: 'Sales Amount (POS invoice sub_total - discount) - Purchase Amount, per matched sold line, summed.',
    formula: 'Sales Amount - Purchase Amount',
    dataNote: 'Sales Amount minus Purchase Amount, for the same matched lines (net sale is not used); free items (net sale ₹0) are left out. Last Week/Last Month show the average per day.',
  },
  {
    key: 'marginPerSqft', label: 'Margin / Sq Ft', section: 'crm', format: 'currency1', sourceGroup: 'salesMargin',
    sourceNote: 'Margin / the store\'s floor area in sq ft (config/stores.js).',
    formula: 'Margin / Store Area (sq ft)',
    dataNote: 'Margin divided by the store\'s floor area. Like Margin, Last Week/Last Month are the average per day, so this is the average daily margin per sq ft. All Stores = total margin over the area of the stores that have margin data (Malleshwaram has none, so it is left out).',
  },
  {
    key: 'newWalkins', label: 'New Walkins', section: 'crm', format: 'int', sourceGroup: 'walkins',
    sourceNote: 'Lucira_Prod.customer_walkin — a phone number\'s FIRST visit (any store, history since Oct 2025).',
    dataNote: 'Derived from phone numbers (the table has no new/repeat flag). A visit with no phone number counts as New. Visitors first seen before Sep 2025 appear as New. Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'repeatWalkins', label: 'Repeat Walkins', section: 'crm', format: 'int', sourceGroup: 'walkins',
    sourceNote: 'Lucira_Prod.customer_walkin — every later visit by a phone number already seen at any store.',
    dataNote: 'Derived from phone numbers (the table has no new/repeat flag). New Walkins + Repeat Walkins = Walkins. Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'newBuyers', label: 'New Buyers', section: 'crm', format: 'int', sourceGroup: 'orders',
    sourceNote: 'ds_imputed_reporting.marketing_sale — COUNT(DISTINCT party_id) per day where customer_type = \'New\' and Channel = \'Store\'.',
    dataNote: 'Distinct customers per day; a customer buying on two different days is counted on each. Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'repeatBuyers', label: 'Repeat Buyers', section: 'crm', format: 'int', sourceGroup: 'orders',
    sourceNote: 'ds_imputed_reporting.marketing_sale — COUNT(DISTINCT party_id) per day where customer_type = \'Repeat\' and Channel = \'Store\'.',
    dataNote: 'Distinct customers per day; a customer buying on two different days is counted on each. Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'newRevenue', label: 'New Revenue', section: 'crm', format: 'currency', sourceGroup: 'orders',
    sourceNote: 'ds_imputed_reporting.marketing_sale — SUM(net_sale) where customer_type = \'New\' and Channel = \'Store\'.',
    dataNote: 'New Revenue + Repeat Revenue = Revenue. Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  {
    key: 'repeatRevenue', label: 'Repeat Revenue', section: 'crm', format: 'currency', sourceGroup: 'orders',
    sourceNote: 'ds_imputed_reporting.marketing_sale — SUM(net_sale) where customer_type = \'Repeat\' and Channel = \'Store\'.',
    dataNote: 'New Revenue + Repeat Revenue = Revenue. Last Week/Last Month show the average per day, not the period total; Yesterday is unaffected.',
  },
  // Hidden helpers (not shown as columns): the order counts that New/Repeat
  // ATV divides by, kept as real metrics so any store selection can recompute
  // ATV correctly instead of averaging averages.
  // Hidden helpers (City Wise tab): the store team's own Show / Converted marks on the Zoho meeting.
  {
    key: 'meetingsShown', label: 'Meetings Shown', section: 'crm', format: 'smart', sourceGroup: 'meetingStatus', hidden: true,
    sourceNote: 'Meetings raised from 22 Sep 2026: Zoho CRM Meetings with Show Status = Show. Earlier meetings: the same mobile has a store visit (customer_walkin) after the meeting. Counted on the day the meeting was raised.',
  },
  {
    key: 'meetingsConverted', label: 'Meetings Converted', section: 'crm', format: 'smart', sourceGroup: 'meetingStatus', hidden: true,
    sourceNote: 'Meetings raised from 22 Sep 2026: Zoho CRM Meetings with Conversion Status = Converted. Earlier meetings: the visitor then placed a non-zero store bill (marketing_sale) on the first visit day or later. Counted on the day the meeting was raised.',
  },
  // Sales Amount split by the bill's New / Repeat tag (used by the Store Comparison tab).
  {
    key: 'newSalesAmount', label: 'New Sales Amount', section: 'operations', format: 'currency', sourceGroup: 'salesMargin', hidden: true,
    sourceNote: 'Sales Amount (POS sub_total - discount) of the sold items with a purchase cost record, for New customers.',
    dataNote: 'Sales Amount from first-time customers (items that have a purchase cost record).',
  },
  {
    key: 'repeatSalesAmount', label: 'Repeat Sales Amount', section: 'operations', format: 'currency', sourceGroup: 'salesMargin', hidden: true,
    sourceNote: 'Sales Amount (POS sub_total - discount) of the sold items with a purchase cost record, for Repeat customers.',
    dataNote: 'Sales Amount from returning customers (items that have a purchase cost record).',
  },
  {
    key: 'newOrders', label: 'New Orders', section: 'crm', format: 'int', sourceGroup: 'orders', hidden: true,
    sourceNote: 'ds_imputed_reporting.marketing_sale — COUNT(DISTINCT document_no) where customer_type = \'New\' and Channel = \'Store\'.',
  },
  {
    key: 'repeatOrders', label: 'Repeat Orders', section: 'crm', format: 'int', sourceGroup: 'orders', hidden: true,
    sourceNote: 'ds_imputed_reporting.marketing_sale — COUNT(DISTINCT document_no) where customer_type = \'Repeat\' and Channel = \'Store\'.',
  },
  {
    key: 'newAtv', label: 'New Bill ATV', section: 'crm', format: 'currency', sourceGroup: 'orders',
    sourceNote: 'New Revenue / New Orders, computed per period.',
    formula: 'New Revenue / New Orders',
    dataNote: 'Average value per bill (order) from first-time customers. Computed from the real period totals, not from the per-day averages shown for the other metrics.',
  },
  {
    key: 'repeatAtv', label: 'Repeat Bill ATV', section: 'crm', format: 'currency', sourceGroup: 'orders',
    sourceNote: 'Repeat Revenue / Repeat Orders, computed per period.',
    formula: 'Repeat Revenue / Repeat Orders',
    dataNote: 'Average value per bill (order) from returning customers. Computed from the real period totals, not from the per-day averages shown for the other metrics.',
  },
  {
    key: 'scans', label: 'Scans', section: 'crm', format: 'smart', sourceGroup: 'scans',
    sourceNote: 'Pos.estimation_item_scan — COUNT of scanned items per store per day (IST); store from company_id via the ERP company table.',
    dataNote: 'Items scanned on the POS, counted per day per store. The scan feature is used mainly at Pune (about 90% of all scans on record); other stores log few or none, so a low number there may mean "not scanned", not "no interest". Last Week/Last Month show the average per day (to one decimal, since the numbers are small).',
  },
  {
    key: 'scansPerVisitor', label: 'Scans Per Visitor', section: 'crm', format: 'decimal', sourceGroup: 'scans',
    sourceNote: 'Scans / Walkins (store visitors), computed per period.',
    formula: 'Scans / Walkins',
    dataNote: 'Scans divided by Walkins (store visits) over the same period — real totals, not the per-day averages. A visitor here is a store visit, so the same person visiting twice counts twice. Only meaningful where scanning is actually used — mainly Pune.',
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
    key: 'staffCount', label: 'Number of Staff', section: 'operations', format: 'int', snapshot: true,
    sourceNote: 'Fixed headcount per store, set in config/stores.js (supplied by the business) — not queried from any system.',
    dataNote: 'A fixed number per store (same for every period). "All Stores" is the sum of the stores. Update it in the store config if a store\'s headcount changes.',
  },
  {
    key: 'revenuePerStaff', label: 'Revenue Per Staff', section: 'operations', format: 'currency', sourceGroup: 'orders',
    sourceNote: 'Revenue / the store\'s fixed headcount (config/stores.js).',
    formula: 'Revenue / Number of Staff',
    dataNote: 'Revenue divided by the store\'s number of staff. Like Revenue, Last Week/Last Month are the average per day, so this is average daily revenue per staff member; a Custom range shows the range total. All Stores = total revenue over the staff of the stores that have revenue data (Malleshwaram has none, so its staff are left out).',
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
