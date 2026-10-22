// Single source of truth for the 6 physical Lucira stores this dashboard
// covers. Every service/query in the app must import this file rather than
// re-listing store names/codes — adding a 7th store or renaming one only
// happens here.
//
// Each field is the exact identifier that store uses in a specific source
// (verified directly against the data, not assumed):
//   - dealOwner:          zoho_crm.cdc_meetings.Owner.name (BigQuery) AND
//                          the live Zoho CRM API Calls module's Owner.name
//   - shortCode:           Lucira_Prod.customer_walkin (company_code) AND
//                          ds_imputed_reporting.marketing_sale.company_code
//   - inventoryStoreName:  ds_imputed_reporting.Live_inventory.Store_name
//   - cityGroup:           bucket used for Deals (Zoho Deals has no reliable
//                          store field; deals are split evenly across the
//                          stores sharing a cityGroup — see the Deals metric
//                          in storePerformanceService.js).
//   - ga4CityGroup:        bucket of the GA4 export's `geo.city` this store's
//                          web sessions fall into — kept as a SEPARATE field
//                          from cityGroup (both currently have the same
//                          values, but the two groupings are allowed to
//                          differ, e.g. a business-chosen GA4 grouping that
//                          doesn't apply to Deals — see storePerformanceService.js).
//                          Borivali/Chembur and Paschim Vihar/Lajpat Nagar
//                          each share one GA4 figure because GA4 genuinely
//                          cannot tell them apart (both report the same
//                          `city` value, no finer dimension exists). Noida
//                          has its own distinct `city` value in GA4 (verified)
//                          and is kept separate, not merged with Delhi.
//                          `citySharedLabel` documents the sharing reason
//                          on-screen wherever a GA4-sourced metric is shown.
// gbpAccountName/gbpLocationName: the real Google Business Profile listing
// for each store, verified live via the Performance/Reviews/Business
// Information APIs (2026-09-29) — found under a SECOND Google account
// ("Bizloc8 Lucira", accounts/106076369511962860792) after the originally
// connected account turned out to only manage 1 unrelated corporate office
// listing. See src/gbpClient.js.
// areaSqFt: the store's floor area in square feet (supplied by the business; used for
// Margin / Sq Ft). staff: the store's fixed headcount (supplied by the business; shown as
// Number of Staff). Change either here if a store changes.
const GBP_ACCOUNT = 'accounts/106076369511962860792';

const STORES = [
  {
    key: 'borivali', displayName: 'Borivali Mumbai', shortCode: 'BO1', areaSqFt: 513, staff: 5,
    dealOwner: 'Borivali Team', inventoryStoreName: 'Divinecarat Lifestyles Private Limited (Borivali)',
    cityGroup: 'mumbai', ga4CityGroup: 'mumbai',
    citySharedLabel: 'Mumbai-wide figure — GA4 cannot separate Borivali from Chembur',
    accent: '#c0504d',
    gbpAccountName: GBP_ACCOUNT, gbpLocationName: 'locations/6052781422524984127',
  },
  // Chembur's company_code/store_code changed from 'CS1' to 'FCS' at some
  // point in mid-2026 (verified directly: CS1's last customer_walkin/
  // marketing_sale row is Aug/May 2026; FCS has been carrying all of
  // Chembur's real activity since, through the most recent day). 'FCS' is
  // also the code the old-gold dashboard already maps to Chembur's ERP
  // entity 'HWI VENTURES' — the same name already used below as this store's
  // inventoryStoreName. Both codes are kept (via extraShortCodes) so no
  // historical Walkins/Orders data is lost, not just the currently-active one.
  {
    key: 'chembur', displayName: 'Chembur Mumbai', shortCode: 'CS1', extraShortCodes: ['FCS'], areaSqFt: 650, staff: 5,
    dealOwner: 'Chembur Store', inventoryStoreName: 'HWI VENTURES',
    cityGroup: 'mumbai', ga4CityGroup: 'mumbai',
    citySharedLabel: 'Mumbai-wide figure — GA4 cannot separate Borivali from Chembur',
    accent: '#96625e',
    gbpAccountName: GBP_ACCOUNT, gbpLocationName: 'locations/3055992412259498601',
  },
  {
    key: 'pune', displayName: 'Pune', shortCode: 'PN1', areaSqFt: 1500, staff: 7,
    dealOwner: 'Pune Store', inventoryStoreName: 'Divinecarat Lifestyles Private Limited (Pune)',
    cityGroup: 'pune', ga4CityGroup: 'pune', citySharedLabel: null,
    accent: '#6e8f52',
    gbpAccountName: GBP_ACCOUNT, gbpLocationName: 'locations/12953187546662035729',
  },
  {
    key: 'paschimVihar', displayName: 'Paschim Vihar Delhi', shortCode: 'PV1', areaSqFt: 1184, staff: 4,
    dealOwner: 'Pashchim Vihar', inventoryStoreName: 'Divinecarat Lifestyles Private Limited (Paschim)',
    cityGroup: 'delhi', ga4CityGroup: 'delhi',
    citySharedLabel: 'Delhi-wide figure — GA4 cannot separate Paschim Vihar from Lajpat Nagar',
    accent: '#4a7c9e',
    gbpAccountName: GBP_ACCOUNT, gbpLocationName: 'locations/17576267208640023831',
  },
  {
    key: 'noida', displayName: 'Noida Delhi', shortCode: 'N18', areaSqFt: 1600, staff: 6,
    dealOwner: 'Noida Store', inventoryStoreName: 'Divinecarat Lifestyles Private Limited (Noida)',
    cityGroup: 'noida', ga4CityGroup: 'noida', citySharedLabel: null,
    accent: '#9e7c4a',
    gbpAccountName: GBP_ACCOUNT, gbpLocationName: 'locations/10408913288017402930',
  },
  {
    key: 'lajpatNagar', displayName: 'Lajpat Nagar Delhi', shortCode: 'LPN', areaSqFt: 690, staff: 5,
    dealOwner: 'Lajpat Nagar Store', inventoryStoreName: 'Divinecarat Lifestyles Private Limited (Lajpat)',
    cityGroup: 'delhi', ga4CityGroup: 'delhi',
    citySharedLabel: 'Delhi-wide figure — GA4 cannot separate Paschim Vihar from Lajpat Nagar',
    accent: '#7c4a9e',
    gbpAccountName: GBP_ACCOUNT, gbpLocationName: 'locations/11791209734796066239',
  },
  // Malleshwaram has no store_code/company_code in customer_walkin or
  // marketing_sale (verified — those tables' only Bengaluru-area entries are
  // 'HO'/'FCS', unrelated administrative/warehouse codes, not this store),
  // and no entry in Live_inventory either. shortCode/inventoryStoreName are
  // left null on purpose — storePerformanceService.js treats a null value on
  // either as "not tracked for this store" and shows those specific metrics
  // (Walkins, Orders, Revenue, Inventory) as unavailable rather than a
  // fabricated 0. Everything else (Calls, Meetings via dealOwner; Sessions,
  // Deals via the 'bengaluru' city; Spend via Google Ads) is real and works
  // the same as every other store — Bengaluru is a single-store city here,
  // so none of it needs a shared split.
  // This location is still "Processing" (unverified) in Business Profile
  // Manager as of 2026-09-29 — gbpClient.js's per-store try/catch marks
  // GBP metrics unavailable here rather than failing, if the API isn't
  // ready to serve it yet.
  {
    key: 'malleshwaram', displayName: 'Malleshwaram Bengaluru', shortCode: null, areaSqFt: 1350, staff: 5,
    dealOwner: 'Malleshwaram Store', inventoryStoreName: null,
    cityGroup: 'bengaluru', ga4CityGroup: 'bengaluru', citySharedLabel: null,
    accent: '#3d7a70',
    gbpAccountName: GBP_ACCOUNT, gbpLocationName: 'locations/10224652227514643489',
  },
];

// GA4 `city` values that roll up into each cityGroup (verified distinct
// values in ga4_dashboard.ga4_fact_sessions — Delhi appears both as "Delhi"
// and "New Delhi").
const CITY_GROUP_CITIES = {
  mumbai: ['Mumbai'],
  delhi: ['Delhi', 'New Delhi'],
  pune: ['Pune'],
  noida: ['Noida'],
  bengaluru: ['Bengaluru'],
};
const ALL_GA4_CITIES = Object.values(CITY_GROUP_CITIES).flat();
const ALL_CITY_GROUPS = Object.keys(CITY_GROUP_CITIES);

// Call_Status values (Lucira_Prod.lucira_zoho_Calls) that count as a
// "connected" call — verified against the actual distinct values in the
// table: Unattended Dialled, Attended Dialled, Missed, Received, Overdue,
// Scheduled, Scheduled Attended Delay, Scheduled Attended. Only the
// attended/received/scheduled-attended statuses represent an actual
// two-way conversation.
const CONNECTED_CALL_STATUSES = ['Attended Dialled', 'Received', 'Scheduled Attended', 'Scheduled Attended Delay'];

const ALL_STORES_KEY = 'all';
const ALL_STORES_DISPLAY_NAME = 'All Stores';

function findStore(key) {
  return STORES.find(s => s.key === key) || null;
}

module.exports = {
  STORES,
  CITY_GROUP_CITIES,
  ALL_GA4_CITIES,
  ALL_CITY_GROUPS,
  CONNECTED_CALL_STATUSES,
  ALL_STORES_KEY,
  ALL_STORES_DISPLAY_NAME,
  findStore,
};
