/* SQL builders for the City Funnel dashboard. Pure functions: filters in -> SQL string out. */
const GA_SESSIONS = '`lucirajewelry-prod.ds_imputed_reporting.ga4_city_sessions_daily`';
/* Live Zoho deals feed (zoho_crm.cdc_deals). Lucira_Prod.lucira_zoho_Deals is a snapshot that stopped on 2026-09-16. */
const DEALS = `(SELECT id, DATE(created_time,'Asia/Kolkata') Creat_time, JSON_VALUE(data,'$.Lead_Source') Lead_Source, JSON_VALUE(data,'$.Mobile') Mobile, JSON_VALUE(data,'$.Email') Email, JSON_VALUE(data,'$.Address_City') Address_City
  FROM \`lucirajewelry-prod.zoho_crm.cdc_deals\` WHERE created_time IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_time DESC) = 1)`;
const CONTACTS = '`lucirajewelry-prod.zoho_crm.cdc_contacts`';
const MEET = '`lucirajewelry-prod.zoho_crm.cdc_meetings`';
const WALK = '`lucirajewelry-prod.ds_imputed_reporting.Walkin_marge`';
const SALE = '`lucirajewelry-prod.ds_imputed_reporting.marketing_sale`';

const q = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const list = a => a.map(q).join(',');
const ymd = d => d.replaceAll('-', '');
/* t-2 rule: sessions come from ga4_city_sessions_daily one day behind the selected day (yesterday shows today minus 2). */
const GA_LAG_DAYS = 1; // t-2 rule: a selected day shows the sessions of the day before it
const shiftDay = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/* Free-text place -> reporting city. NULL/blank -> Unknown; anything else not a hub -> Other Cities. */
function cityCase(expr) {
  const x = `LOWER(TRIM(${expr}))`;
  return `CASE
    WHEN ${expr} IS NULL OR TRIM(${expr}) = '' THEN 'Unknown'
    WHEN REGEXP_CONTAINS(${x}, r'noida|gautam bud') THEN 'Noida'
    WHEN REGEXP_CONTAINS(${x}, r'mumbai|thane|borivali|boriwali|chembur|chembure|chmbur|malad|goregaon|juhu|bhiwandi|kalyan|nala sopara|raigad|palghar|vasai|andheri|bandra|khaerghar|navi mum') THEN 'Mumbai'
    WHEN REGEXP_CONTAINS(${x}, r'pune|hadapsar|pimpri|lohegaon|pabal') THEN 'Pune'
    WHEN REGEXP_CONTAINS(${x}, r'bengaluru|bangalore|banglore|malleshwaram|malleswaram') THEN 'Bengaluru'
    WHEN REGEXP_CONTAINS(${x}, r'hyderabad|rangareddy|rangareddi|secunderabad') THEN 'Hyderabad'
    WHEN REGEXP_CONTAINS(${x}, r'delhi|lajpat|lachpat|paschim|pashchim|pachim|pashim|ppashcim|vihar|vhir|vihra|gurgaon|gurugram|faridabad|ghaziabad') THEN 'Delhi NCR'
    WHEN REGEXP_CONTAINS(${x}, r'^(ho|head office|ho malad|video call|store vist)$') THEN 'Unknown'
    ELSE 'Other Cities' END`;
}
/* Deal Address_City (Delhi zone) -> store. Mumbai deals are split between its two stores in the dashboard; other cities have one store. */
function dealStore(expr) {
  const n = `LOWER(TRIM(REGEXP_REPLACE(IFNULL(${expr},''), r'[-\\s]+', ' ')))`;
  return `CASE
    WHEN REGEXP_CONTAINS(${n}, r'noida|gautam bud|^east delhi$') THEN 'Noida'
    WHEN REGEXP_CONTAINS(${n}, r'^(central|south|south west) delhi$|gurgaon|gurugram') THEN 'Lajpat Nagar'
    WHEN REGEXP_CONTAINS(${n}, r'^(north|north west|west) delhi$') THEN 'Paschim Vihar'
    ELSE NULL END`;
}
const phoneKey = expr => `IF(LENGTH(REGEXP_REPLACE(IFNULL(${expr},''), r'\\D', '')) >= 10, RIGHT(REGEXP_REPLACE(${expr}, r'\\D', ''), 10), NULL)`;

/* Real customer e-mail only: lower-cased, and the placeholder <phone>@lucirajewelry.com addresses are ignored. */
const emailKey = expr => `IF(STRPOS(IFNULL(${expr},''),'@') > 1 AND NOT ENDS_WITH(LOWER(TRIM(${expr})),'@lucirajewelry.com'), LOWER(TRIM(${expr})), NULL)`;

/* A meeting counts as a store-visit when its title is not a video call / test / try-at-home etc. */
const NOT_STORE_VISIT = `r'video|viodeo|test|try ?at ?home|tryathome|trial|complaint|call only|ok will see|check riung|nail art'`;

/* Store codes in Walkin_marge that are real stores (HO / Amazon are not walk-ins; FCS & HWI have no known city). */
const STORE_CITY = `CASE store_code WHEN 'BO1' THEN 'Mumbai' WHEN 'CS1' THEN 'Mumbai' WHEN 'PN1' THEN 'Pune'
    WHEN 'LPN' THEN 'Delhi NCR' WHEN 'PV1' THEN 'Delhi NCR' WHEN 'N18' THEN 'Noida' WHEN 'MAL' THEN 'Bengaluru'
    WHEN 'FCS' THEN 'Other Cities' WHEN 'HWI' THEN 'Other Cities' ELSE NULL END`;

/* Meeting venue text -> store. NULL when no store can be identified (e.g. HO, video call, "Delhi"). */
function storeCase(expr) {
  const x = `LOWER(TRIM(${expr}))`;
  return `CASE
    WHEN ${expr} IS NULL THEN NULL
    WHEN REGEXP_CONTAINS(${x}, r'borivali|boriwali') THEN 'Borivali'
    WHEN REGEXP_CONTAINS(${x}, r'chembur|chembure|chmbur') THEN 'Chembur'
    WHEN REGEXP_CONTAINS(${x}, r'lajpat|lachpat') THEN 'Lajpat Nagar'
    WHEN REGEXP_CONTAINS(${x}, r'paschim|pashchim|pachim|pashim|ppashcim|vihar|vhir|vihra') THEN 'Paschim Vihar'
    WHEN REGEXP_CONTAINS(${x}, r'noida') THEN 'Noida'
    WHEN REGEXP_CONTAINS(${x}, r'malleshwaram|malleswaram') THEN 'Malleshwaram'
    WHEN REGEXP_CONTAINS(${x}, r'pune|hadapsar') THEN 'Pune'
    ELSE NULL END`;
}
const STORE_NAME = `CASE store_code WHEN 'BO1' THEN 'Borivali' WHEN 'CS1' THEN 'Chembur' WHEN 'LPN' THEN 'Lajpat Nagar'
    WHEN 'PV1' THEN 'Paschim Vihar' WHEN 'N18' THEN 'Noida' WHEN 'MAL' THEN 'Malleshwaram' WHEN 'PN1' THEN 'Pune' ELSE NULL END`;

function optionsSql() {
  return `
SELECT 'source' k, IFNULL(NULLIF(TRIM(Lead_Source),''),'Unknown') v FROM ${DEALS} GROUP BY 2
UNION ALL SELECT 'fulfillment', Fullfillment FROM ${SALE} WHERE Fullfillment IS NOT NULL GROUP BY 2
UNION ALL SELECT 'category', item_group_name FROM ${SALE} WHERE item_group_name IS NOT NULL GROUP BY 2
UNION ALL SELECT 'karat', karat_name FROM ${SALE} WHERE karat_name IS NOT NULL GROUP BY 2
UNION ALL SELECT 'metal', metal_name FROM ${SALE} WHERE metal_name IS NOT NULL GROUP BY 2
UNION ALL SELECT 'custype', customer_type FROM ${SALE} WHERE customer_type IS NOT NULL GROUP BY 2
UNION ALL SELECT 'freshness_deals', CAST(MAX(Creat_time) AS STRING) FROM ${DEALS}
UNION ALL SELECT 'freshness_meetings', CAST(MAX(DATE(created_time,'Asia/Kolkata')) AS STRING) FROM ${MEET}
UNION ALL SELECT 'freshness_walkins', CAST(MAX(DATE(SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%S', walkin_date))) AS STRING) FROM ${WALK}
UNION ALL SELECT 'freshness_sales', CAST(MAX(Transaction_Date) AS STRING) FROM ${SALE}
UNION ALL SELECT 'freshness_ga4', FORMAT_DATE('%Y%m%d', DATE_ADD(MAX(event_date), INTERVAL ${GA_LAG_DAYS} DAY)) FROM ${GA_SESSIONS}
UNION ALL SELECT 'earliest_ga4', FORMAT_DATE('%Y%m%d', DATE_ADD(MIN(event_date), INTERVAL ${GA_LAG_DAYS} DAY)) FROM ${GA_SESSIONS}
ORDER BY 1, 2`;
}

/* f = {from:'YYYY-MM-DD', to:'YYYY-MM-DD', cities:[], sources:[], fulfillment:[], category:[], karat:[], metal:[], custype:[], status:'all'|'active'|'cancelled'} */
function mainSql(f) {
  const arr = k => f[k] && f[k].length;
  const saleWhere = [
    arr('fulfillment') && `Fullfillment IN (${list(f.fulfillment)})`,
    arr('category') && `item_group_name IN (${list(f.category)})`,
    arr('karat') && `karat_name IN (${list(f.karat)})`,
    arr('metal') && `metal_name IN (${list(f.metal)})`,
    arr('custype') && `customer_type IN (${list(f.custype)})`,
    f.status === 'active' && `Fullfillment != 'cancel_order'`,
    f.status === 'cancelled' && `Fullfillment = 'cancel_order'`,
  ].filter(Boolean).map(s => ' AND ' + s).join('');
  const dealSrc = arr('sources') ? ` AND IFNULL(NULLIF(TRIM(Lead_Source),''),'Unknown') IN (${list(f.sources)})` : '';
  const meetSrc = arr('sources') ? ` AND src IN (${list(f.sources)})` : '';
  const conds = [arr('cities') && `city IN (${list(f.cities)})`, arr('stores') && `(store IS NULL OR store IN (${list(f.stores)}))`].filter(Boolean);
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  return `
WITH
-- 1. SESSIONS: daily GA4 city sessions table (ds_imputed_reporting.ga4_city_sessions_daily), shifted by the t-2 rule
sessions AS (
  SELECT DATE_ADD(event_date, INTERVAL ${GA_LAG_DAYS} DAY) d,
         CASE city_group WHEN 'mumbai' THEN 'Mumbai' WHEN 'delhi' THEN 'Delhi NCR' WHEN 'noida' THEN 'Noida'
                         WHEN 'pune' THEN 'Pune' WHEN 'bengaluru' THEN 'Bengaluru' ELSE INITCAP(city_group) END city,
         SUM(city_sessions) n
  FROM ${GA_SESSIONS}
  WHERE event_date BETWEEN DATE '${shiftDay(f.from, -GA_LAG_DAYS)}' AND DATE '${shiftDay(f.to, -GA_LAG_DAYS)}'
  GROUP BY 1, 2
),

-- 2. DEALS: one row per Zoho deal id, dated by Creat_time
deals AS (
  SELECT Creat_time d, ${cityCase('Address_City')} city, ${dealStore('Address_City')} store, COUNT(DISTINCT id) n
  FROM ${DEALS}
  WHERE Creat_time BETWEEN DATE '${f.from}' AND DATE '${f.to}'${dealSrc}
  GROUP BY 1,2,3
),

-- 3. STORE VISIT RAISED: one row per customer (phone; meeting id if no phone), first meeting in range
mt AS (
  SELECT id, created_time,
         DATE(created_time,'Asia/Kolkata') md,
         JSON_VALUE(data,'$.Event_Title') title,
         JSON_VALUE(data,'$.Venue') venue,
         JSON_VALUE(data,'$.What_Id.id') what_id,
         JSON_VALUE(data,'$.Who_Id.id') who_id,
         JSON_VALUE(data,'$.Who_Id.name') who_name
  FROM ${MEET}
),
mt2 AS (
  SELECT m.id, m.created_time, m.md, ${cityCase('m.venue')} city, ${storeCase('m.venue')} store,
         COALESCE(${phoneKey('ct.Mobile')}, ${phoneKey('ct.Phone')}, ${phoneKey('d.Mobile')}, ${phoneKey('m.who_name')}) phone,
         IFNULL(NULLIF(TRIM(d.Lead_Source),''),'Unknown') src,
         COALESCE(${emailKey('ct.Email')}, ${emailKey('d.Email')}) email
  FROM mt m LEFT JOIN ${DEALS} d ON d.id = m.what_id
  LEFT JOIN (SELECT id, JSON_VALUE(data,'$.Mobile') Mobile, JSON_VALUE(data,'$.Phone') Phone, JSON_VALUE(data,'$.Email') Email
             FROM ${CONTACTS} WHERE TRUE QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_time DESC) = 1) ct ON ct.id = m.who_id
  WHERE m.md BETWEEN DATE '${f.from}' AND DATE '${f.to}'
    AND NOT REGEXP_CONTAINS(LOWER(IFNULL(m.title,'')), ${NOT_STORE_VISIT})
),
raised_k AS (
  SELECT IFNULL(phone, CONCAT('M:', id)) k, MAX(phone) phone, MAX(email) email, MIN(md) md,
         ARRAY_AGG(city ORDER BY created_time LIMIT 1)[OFFSET(0)] city,
         ARRAY_AGG(store ORDER BY created_time LIMIT 1)[OFFSET(0)] store
  FROM mt2 WHERE store IS NOT NULL${meetSrc} GROUP BY k
),

-- 4. STORE VISITED: raised customers with a store check-in on/after the meeting date
walk AS (
  SELECT ${phoneKey('phone')} phone, ${emailKey('email')} email, DATE(SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%S', walkin_date)) wd
  FROM ${WALK}
  WHERE event_name='StoreVisit' AND ${STORE_CITY} IS NOT NULL AND IFNULL(state,'') != 'Billed Returns'
),
visited_k AS (
  SELECT r.k, MIN(w.wd) wd FROM raised_k r JOIN walk w ON (w.phone = r.phone OR w.email = r.email) AND w.wd >= r.md GROUP BY r.k
),

-- 5/6/7. ORDERS & REVENUE: documents of raised customers on/after meeting date (one row per customer x document)
sale AS (
  SELECT document_no, MAX(${phoneKey('COALESCE(Cus_mobile, mobile1)')}) phone, MAX(${emailKey("COALESCE(NULLIF(email,''), email_id)")}) email, MIN(Transaction_Date) td, SUM(net_sale) rev
  FROM ${SALE}
  WHERE Transaction_Date <= CURRENT_DATE('Asia/Kolkata')${saleWhere}
  GROUP BY document_no
),
ord AS (
  SELECT DISTINCT r.k, s.document_no, s.rev FROM raised_k r JOIN sale s ON (s.phone = r.phone OR s.email = r.email) AND s.td >= r.md
),

stage AS (
  SELECT d, city, CAST(NULL AS STRING) store, n AS sessions, 0 deals, 0 raised, 0 visited, 0 orders, 0 revenue, 0 walkins FROM sessions
  UNION ALL SELECT d, city, store, 0, n, 0, 0, 0, 0, 0 FROM deals
  UNION ALL SELECT md, city, store, 0, 0, 1, 0, 0, 0, 0 FROM raised_k
  UNION ALL SELECT r.md, r.city, r.store, 0, 0, 0, 1, 0, 0, 0 FROM raised_k r JOIN visited_k v USING (k)
  UNION ALL SELECT r.md, r.city, r.store, 0, 0, 0, 0, COUNT(DISTINCT o.document_no), SUM(o.rev), 0 FROM raised_k r JOIN ord o USING (k) GROUP BY 1,2,3
  UNION ALL SELECT DATE(SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%S', walkin_date)), ${STORE_CITY}, ${STORE_NAME}, 0,0,0,0,0,0, COUNT(DISTINCT ${phoneKey('phone')})
    FROM ${WALK}
    WHERE event_name='StoreVisit' AND ${STORE_CITY} IS NOT NULL AND IFNULL(state,'') != 'Billed Returns'
      AND DATE(SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%S', walkin_date)) BETWEEN DATE '${f.from}' AND DATE '${f.to}'
    GROUP BY 1,2,3
)
SELECT CAST(d AS STRING) d, city, store, SUM(sessions) sessions, SUM(deals) deals, SUM(raised) raised, SUM(visited) visited,
       SUM(orders) orders, ROUND(SUM(revenue),2) revenue, SUM(walkins) walkins
FROM stage ${where}
GROUP BY d, city, store ORDER BY d, city, store`;
}
if (typeof module !== 'undefined') module.exports = { mainSql, optionsSql };
