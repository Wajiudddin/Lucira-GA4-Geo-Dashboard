-- =============================================================================
-- Zoho Deal Intelligence — prepared reporting table (1 row per Zoho Deal)
--   lucirajewelry-prod.zoho_crm.zoho_deal_intelligence
--
-- Rebuilt by zoho-login-dashboard run_sync() every 30 min, right after the
-- cdc_* merge (the same schedule as the Zoho CDC sync). Manual run:
--   python -c "..." or  bq query --use_legacy_sql=false < deal_intel/build_deal_intelligence.sql
--
-- Sources
--   zoho_crm.cdc_deals                       live Zoho Deals (CDC, ~30 min)
--   zoho_crm.cdc_contacts                    deal's Contact (name / email / mobile / mailing address fallback)
--   zoho_crm.deals_address_live_patch        one-time address backfill (16-21 Sep 2026)
--   Lucira_Prod.lucira_zoho_Deals            legacy address export (deals before 16 Sep 2026)
--   zoho_crm.deals_probability_score_patch   Probability_Score history (COQL pull 2026-10-03);
--                                            cdc_deals carries the field itself from 2026-10-03 on
--   ds_imputed_reporting.marketing_sale      sale ledger (Buyer logic)
--
-- Raw fields are kept untouched next to every derived field so the business
-- rules below can be changed without rebuilding the dashboard.
-- =============================================================================
CREATE OR REPLACE TABLE `lucirajewelry-prod.zoho_crm.zoho_deal_intelligence` AS
WITH
-- ---------------------------------------------------------------- Deals ----
deals AS (
  SELECT * FROM `lucirajewelry-prod.zoho_crm.cdc_deals`
  WHERE id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_time DESC, synced_at DESC) = 1
),
contacts AS (
  SELECT * FROM `lucirajewelry-prod.zoho_crm.cdc_contacts`
  WHERE id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_time DESC, synced_at DESC) = 1
),
addr_patch AS (
  SELECT * FROM `lucirajewelry-prod.zoho_crm.deals_address_live_patch`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY pulled_at DESC) = 1
),
addr_legacy AS (
  SELECT id, ANY_VALUE(Address_City) Address_City, ANY_VALUE(Address_Zip) Address_Zip
  FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals` GROUP BY id
),
prob_patch AS (
  SELECT id, ANY_VALUE(probability_score) probability_score
  FROM `lucirajewelry-prod.zoho_crm.deals_probability_score_patch` GROUP BY id
),
d0 AS (
  SELECT
    d.id                                                         AS deal_id,
    DATETIME(d.created_time, 'Asia/Kolkata')                     AS deal_created_ts_ist,
    DATE(d.created_time, 'Asia/Kolkata')                         AS deal_created_date,
    JSON_VALUE(d.data, '$.Deal_Name')                            AS deal_name,
    COALESCE(NULLIF(TRIM(JSON_VALUE(d.data, '$.Contact_Name.name')), ''),
             NULLIF(TRIM(JSON_VALUE(c.data, '$.Full_Name')), ''),
             REGEXP_REPLACE(JSON_VALUE(d.data, '$.Deal_Name'), r'_[0-9]+$', '')) AS customer_name,
    d.owner_id                                                   AS agent_id,
    COALESCE(d.owner_name, JSON_VALUE(d.data, '$.Owner.name'))   AS agent,
    JSON_VALUE(d.data, '$.Stage')                                AS deal_stage,
    JSON_VALUE(d.data, '$.Lead_Source')                          AS lead_source,
    JSON_VALUE(d.data, '$.Deal_Trigger_Event')                   AS deal_trigger_event,
    JSON_VALUE(d.data, '$.Record_Type')                          AS record_type,
    -- raw identifiers (deal first, contact as fallback)
    COALESCE(NULLIF(TRIM(JSON_VALUE(d.data, '$.Mobile')), ''),
             NULLIF(TRIM(JSON_VALUE(c.data, '$.Mobile')), ''))   AS mobile_raw,
    COALESCE(NULLIF(TRIM(JSON_VALUE(d.data, '$.Email')), ''),
             NULLIF(TRIM(JSON_VALUE(c.data, '$.Email')), ''))    AS email_raw,
    -- Address - City: deal (CDC -> address patch -> legacy export), else contact mailing city
    INITCAP(TRIM(COALESCE(
      NULLIF(NULLIF(TRIM(JSON_VALUE(d.data, '$.Address_City')), ''), 'NA'),
      NULLIF(NULLIF(TRIM(ap.address_city), ''), 'NA'),
      NULLIF(NULLIF(TRIM(al.Address_City), ''), 'NA'),
      NULLIF(NULLIF(TRIM(JSON_VALUE(c.data, '$.Mailing_City')), ''), 'NA')))) AS address_city,
    CASE
      WHEN COALESCE(NULLIF(NULLIF(TRIM(JSON_VALUE(d.data, '$.Address_City')), ''), 'NA'),
                    NULLIF(NULLIF(TRIM(ap.address_city), ''), 'NA'),
                    NULLIF(NULLIF(TRIM(al.Address_City), ''), 'NA')) IS NOT NULL THEN 'Deal'
      WHEN NULLIF(NULLIF(TRIM(JSON_VALUE(c.data, '$.Mailing_City')), ''), 'NA') IS NOT NULL THEN 'Contact'
    END                                                          AS city_source,
    -- Address - Zip / Postal Code: same tiering; kept as text, only a real 6-digit code survives
    COALESCE(
      REGEXP_EXTRACT(JSON_VALUE(d.data, '$.Address_Zip_Postal_Code'), r'\b([1-9][0-9]{5})\b'),
      REGEXP_EXTRACT(ap.address_zip, r'\b([1-9][0-9]{5})\b'),
      REGEXP_EXTRACT(CAST(al.Address_Zip AS STRING), r'\b([1-9][0-9]{5})\b'),
      REGEXP_EXTRACT(JSON_VALUE(c.data, '$.Mailing_Zip'), r'\b([1-9][0-9]{5})\b')) AS postal_code,
    CASE
      WHEN COALESCE(REGEXP_EXTRACT(JSON_VALUE(d.data, '$.Address_Zip_Postal_Code'), r'\b([1-9][0-9]{5})\b'),
                    REGEXP_EXTRACT(ap.address_zip, r'\b([1-9][0-9]{5})\b'),
                    REGEXP_EXTRACT(CAST(al.Address_Zip AS STRING), r'\b([1-9][0-9]{5})\b')) IS NOT NULL THEN 'Deal'
      WHEN REGEXP_EXTRACT(JSON_VALUE(c.data, '$.Mailing_Zip'), r'\b([1-9][0-9]{5})\b') IS NOT NULL THEN 'Contact'
    END                                                          AS postal_source,
    -- Probability Score (%): Zoho Probability_Score. CDC JSON wins once the field is synced
    -- (JSON_QUERY is non-NULL when the key exists, even if its value is null).
    IF(JSON_QUERY(d.data, '$.Probability_Score') IS NOT NULL,
       SAFE_CAST(JSON_VALUE(d.data, '$.Probability_Score') AS FLOAT64),
       pp.probability_score)                                    AS probability_score,
    SAFE_CAST(JSON_VALUE(d.data, '$.Probability') AS FLOAT64)    AS zoho_probability_stage_pct
  FROM deals d
  LEFT JOIN contacts c     ON c.id = JSON_VALUE(d.data, '$.Contact_Name.id')
  LEFT JOIN addr_patch ap  ON ap.id = d.id
  LEFT JOIN addr_legacy al ON al.id = d.id
  LEFT JOIN prob_patch pp  ON pp.id = d.id
),
d1 AS (
  SELECT d0.*,
    -- Mobile normalisation: digits only; 91XXXXXXXXXX / 0XXXXXXXXXX / 091... -> 10 digits;
    -- valid only if it is an Indian mobile (starts 6-9) and not one repeated digit.
    (SELECT IF(REGEXP_CONTAINS(m10, r'^[6-9][0-9]{9}$') AND REPLACE(m10, SUBSTR(m10, 1, 1), '') != '', m10, NULL)
     FROM (SELECT CASE
             WHEN LENGTH(m) = 10 THEN m
             WHEN LENGTH(m) = 12 AND STARTS_WITH(m, '91')  THEN SUBSTR(m, 3)
             WHEN LENGTH(m) = 11 AND STARTS_WITH(m, '0')   THEN SUBSTR(m, 2)
             WHEN LENGTH(m) = 13 AND STARTS_WITH(m, '091') THEN SUBSTR(m, 4)
           END AS m10
           FROM (SELECT REGEXP_REPLACE(COALESCE(d0.mobile_raw, ''), r'[^0-9]', '') AS m))) AS mobile_norm,
    -- Email: trimmed + lower-case; placeholder addresses are NOT usable identifiers
    -- (all-digit local part = mobile-derived, @lucirajewelry.com = store/staff mailbox).
    IF(REGEXP_CONTAINS(LOWER(TRIM(d0.email_raw)), r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
       AND NOT REGEXP_CONTAINS(LOWER(TRIM(d0.email_raw)), r'^\+?[0-9]+@')
       AND NOT ENDS_WITH(LOWER(TRIM(d0.email_raw)), '@lucirajewelry.com'),
       LOWER(TRIM(d0.email_raw)), NULL)                         AS email_norm,
    -- Name: lower-case letters only, honorifics dropped, single-spaced (fallback key only)
    NULLIF(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(COALESCE(d0.customer_name, '')),
      r'[^a-z ]', ' '), r'\b(mr|mrs|ms|miss|dr|shri|smt)\b', ' '), r'\s+', ' ')), '') AS name_norm
  FROM d0
),
-- --------------------------------------------------------- Marketing Sale ----
-- Every sale row is reduced to ONE minimum sale date per identifier BEFORE joining
-- back to deals, so multiple sale lines / invoices can never multiply a deal.
sale_rows AS (
  SELECT
    Transaction_Date AS sale_date,
    (SELECT IF(REGEXP_CONTAINS(m10, r'^[6-9][0-9]{9}$') AND REPLACE(m10, SUBSTR(m10, 1, 1), '') != '', m10, NULL)
     FROM (SELECT CASE
             WHEN LENGTH(m) = 10 THEN m
             WHEN LENGTH(m) = 12 AND STARTS_WITH(m, '91')  THEN SUBSTR(m, 3)
             WHEN LENGTH(m) = 11 AND STARTS_WITH(m, '0')   THEN SUBSTR(m, 2)
             WHEN LENGTH(m) = 13 AND STARTS_WITH(m, '091') THEN SUBSTR(m, 4)
           END AS m10
           FROM (SELECT REGEXP_REPLACE(COALESCE(Cus_mobile, mobile1, ''), r'[^0-9]', '') AS m))) AS mobile_norm,
    IF(REGEXP_CONTAINS(LOWER(TRIM(email)), r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
       AND NOT REGEXP_CONTAINS(LOWER(TRIM(email)), r'^\+?[0-9]+@')
       AND NOT ENDS_WITH(LOWER(TRIM(email)), '@lucirajewelry.com'),
       LOWER(TRIM(email)), NULL)                                AS email_norm,
    NULLIF(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(COALESCE(party_name, '')),
      r'[^a-z ]', ' '), r'\b(mr|mrs|ms|miss|dr|shri|smt)\b', ' '), r'\s+', ' ')), '') AS name_norm
  FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
  WHERE Transaction_Date IS NOT NULL
),
sale_by_mobile AS (SELECT mobile_norm, MIN(sale_date) min_sale_date FROM sale_rows WHERE mobile_norm IS NOT NULL GROUP BY 1),
sale_by_email  AS (SELECT email_norm,  MIN(sale_date) min_sale_date FROM sale_rows WHERE email_norm  IS NOT NULL GROUP BY 1),
-- Name fallback only for names that belong to exactly ONE sale customer (two-word minimum),
-- so a common name can never turn a stranger into a Buyer.
sale_by_name   AS (
  SELECT name_norm, MIN(sale_date) min_sale_date
  FROM sale_rows
  WHERE name_norm IS NOT NULL AND STRPOS(name_norm, ' ') > 0
  GROUP BY 1
  HAVING COUNT(DISTINCT COALESCE(mobile_norm, email_norm, 'x')) = 1
),
d2 AS (
  SELECT d1.*,
    sm.min_sale_date AS min_sale_date_mobile,
    se.min_sale_date AS min_sale_date_email,
    -- name is used ONLY when the deal has no usable mobile and no usable email
    IF(d1.mobile_norm IS NULL AND d1.email_norm IS NULL, sn.min_sale_date, NULL) AS min_sale_date_name
  FROM d1
  LEFT JOIN sale_by_mobile sm ON sm.mobile_norm = d1.mobile_norm
  LEFT JOIN sale_by_email  se ON se.email_norm  = d1.email_norm
  LEFT JOIN sale_by_name   sn ON sn.name_norm   = d1.name_norm
),
d3 AS (
  SELECT d2.*,
    -- customer's first-ever sale across every identifier that matched
    (SELECT MIN(x) FROM UNNEST([min_sale_date_mobile, min_sale_date_email, min_sale_date_name]) x) AS minimum_sale_date
  FROM d2
),
-- ------------------------------------------------------------ Flags ----
d4 AS (
  SELECT d3.*,
    CASE
      WHEN minimum_sale_date IS NULL THEN 'None'
      WHEN minimum_sale_date = min_sale_date_mobile AND minimum_sale_date = min_sale_date_email THEN 'Mobile + Email'
      WHEN minimum_sale_date = min_sale_date_mobile THEN 'Mobile'
      WHEN minimum_sale_date = min_sale_date_email  THEN 'Email'
      ELSE 'Name (fallback)'
    END                                                          AS sale_match_method,
    -- Buyer: first sale STRICTLY before the deal's IST created date
    (minimum_sale_date IS NOT NULL AND minimum_sale_date < deal_created_date)          AS buyer_flag,
    CASE
      WHEN minimum_sale_date IS NULL               THEN 'No matching sale'
      WHEN minimum_sale_date <  deal_created_date  THEN 'Sale before deal'
      WHEN minimum_sale_date =  deal_created_date  THEN 'First sale on deal date'
      ELSE 'First sale after deal'
    END                                                          AS buyer_reason,
    IF(minimum_sale_date < deal_created_date,
       DATE_DIFF(deal_created_date, minimum_sale_date, DAY), NULL) AS days_since_previous_sale,
    LOWER(COALESCE(deal_trigger_event, '')) LIKE '%nitro%'      AS nitro_flag,
    (LOWER(COALESCE(deal_trigger_event, '')) LIKE '%nitroproductview%'
     OR LOWER(COALESCE(deal_trigger_event, '')) LIKE '%nitroaddtocart%') AS nitro_pv_atc_flag,
    -- CTWA: Deal Trigger Event contains 'whatsapp' (rule changed 2026-10-03; Lead Source 'chat' no longer used)
    LOWER(COALESCE(deal_trigger_event, '')) LIKE '%whatsapp%'   AS ctwa_flag
  FROM d3
),
d5 AS (
  SELECT d4.*,
    -- Subscriber: Deal Trigger Event contains neither 'nitro' nor 'whatsapp' (blank trigger included).
    -- Business definition confirmed 2026-10-03 against the Zoho CRM export of 2 Oct.
    (NOT nitro_flag AND NOT ctwa_flag)                           AS subscriber_flag,
    -- Visitor: Deal Trigger Event contains 'nitro' (NitroProductView, NitroAddToCart, ...).
    -- CTWA / Subscriber / Visitor are mutually exclusive and cover every deal.
    nitro_flag                                                   AS visitor_flag
  FROM d4
)
SELECT
  d5.*,
  CASE
    WHEN probability_score IS NULL THEN 'Not captured'
    WHEN probability_score <= 20 THEN '0-20%'
    WHEN probability_score <= 40 THEN '21-40%'
    WHEN probability_score <= 60 THEN '41-60%'
    WHEN probability_score <= 80 THEN '61-80%'
    ELSE '81-100%'
  END                                                            AS probability_band,
  -- Final single category. Priority: CTWA > Buyer > Subscriber > Visitor > Non-Buyer.
  -- (Buyer/Non-Buyer covers every deal, so Non-Buyer is applied LAST; otherwise
  --  Subscriber and Visitor could never be reached.)
  CASE
    WHEN ctwa_flag       THEN 'CTWA'
    WHEN buyer_flag      THEN 'Buyer'
    WHEN subscriber_flag THEN 'Subscriber'
    WHEN visitor_flag    THEN 'Visitor'
    WHEN NOT buyer_flag  THEN 'Non-Buyer'
    ELSE 'Other / Unclassified'
  END                                                            AS deal_category,
  -- every rule that fired, so conflicts are visible instead of hidden by the priority
  ARRAY_TO_STRING(ARRAY(SELECT x FROM UNNEST([
    IF(ctwa_flag, 'CTWA', NULL), IF(buyer_flag, 'Buyer', 'Non-Buyer'),
    IF(subscriber_flag, 'Subscriber', NULL), IF(visitor_flag, 'Visitor', NULL)]) x WHERE x IS NOT NULL), ' + ')
                                                                 AS matched_rules,
  CURRENT_TIMESTAMP()                                            AS built_at
FROM d5;
