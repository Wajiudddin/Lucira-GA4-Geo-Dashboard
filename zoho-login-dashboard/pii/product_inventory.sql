-- ═══════════════════════════════════════════════════════════════════════════
-- ZOHO PRODUCT -> ITEMS MASTER mapping layer (used by Deals VS Call 'Product Cut')
-- Project lucirajewelry-prod, dataset zoho_crm. Run top-to-bottom (idempotent).
--
--   zoho_crm.zoho_products_src        raw Zoho CRM Products CSV (pii/load_zoho_products.py)
--   zoho_crm.v_pii_item_master        Items Master, 1 row per SKU (dedup guard)
--   zoho_crm.v_pii_item_price         selling price + price band per SKU
--   zoho_crm.v_zoho_product_map       every Zoho product -> Items Master, with status
--
-- Sources (all verified 2026-10-03):
--   ds_imputed_reporting.items              Items Master. item_id + item_code both
--                                           unique (108,301 rows). item_code = the SKU
--                                           (e.g. LJ-R00155-14YGLGD-12). items.sku and
--                                           items.parent_style are empty — not used.
--   ornaverse_erp_master.common_attributes  category/karat/metal/... (key unique)
--   Pos.item_groups                         product group (key unique)
--   Pos.Product_price                       component selling prices — the same source
--                                           as the PP dashboard's Variant "Overall
--                                           Selling Price" (SUM of components)
--   ds_imputed_reporting.Live_inventory     current ERP stock, 1 row = 1 piece
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Karat display normaliser: 14 / 14K / 14KT / 14 Karat -> 14K; gold hallmark
--    fineness 375/585/750/916/995/999 -> 9K/14K/18K/22K/24K. Fineness is only
--    read as gold karat when the metal is Gold — silver 999 coins stay
--    'Silver 999', platinum '95' = 'Platinum 950'.
CREATE OR REPLACE FUNCTION `lucirajewelry-prod.zoho_crm.pii_karat`(k STRING, metal STRING) AS ((
  SELECT CASE
    WHEN x IS NULL OR x = '' THEN NULL
    WHEN mt LIKE 'SILVER%' THEN CONCAT('Silver ', IFNULL(REGEXP_EXTRACT(x, r'(\d{3})'), x))
    WHEN mt LIKE 'PLATINUM%' THEN IF(x IN ('95', '950', 'PT950'), 'Platinum 950', CONCAT('Platinum ', x))
    WHEN REGEXP_CONTAINS(x, r'^(9|10|14|18|22|24)\s*(K|KT|KARAT|CARAT|CT)?$')
      THEN CONCAT(REGEXP_EXTRACT(x, r'^(\d+)'), 'K')
    WHEN x = '375' THEN '9K'
    WHEN x = '585' THEN '14K'
    WHEN x = '750' THEN '18K'
    WHEN x = '916' THEN '22K'
    WHEN x IN ('995', '999') THEN '24K'
    WHEN REGEXP_CONTAINS(x, r'SILVER') THEN CONCAT('Silver ', IFNULL(REGEXP_EXTRACT(x, r'(\d{3})'), ''))
    ELSE k END
  FROM (SELECT UPPER(REGEXP_REPLACE(TRIM(k), r'\s+', ' ')) AS x, UPPER(TRIM(IFNULL(metal, ''))) AS mt)
));

-- ── Price band: the ERP's own Price_Range buckets (Sales_overview_table:
--    0-10K … 200K+, lower bound inclusive) applied to the SKU selling price.
CREATE OR REPLACE FUNCTION `lucirajewelry-prod.zoho_crm.pii_price_band`(p FLOAT64) AS (
  CASE
    WHEN p IS NULL OR p <= 0 THEN 'No Price'
    WHEN p < 10000  THEN '0 - 10K'
    WHEN p < 20000  THEN '10K - 20K'
    WHEN p < 30000  THEN '20K - 30K'
    WHEN p < 40000  THEN '30K - 40K'
    WHEN p < 50000  THEN '40K - 50K'
    WHEN p < 75000  THEN '50K - 75K'
    WHEN p < 100000 THEN '75K - 100K'
    WHEN p < 150000 THEN '100K - 150K'
    WHEN p < 200000 THEN '150K - 200K'
    ELSE '200K+' END
);

-- ── Items Master, exactly 1 row per normalised SKU (QUALIFY guards against any
--    future duplicate item_code; today there are none).
CREATE OR REPLACE VIEW `lucirajewelry-prod.zoho_crm.v_pii_item_master` AS
SELECT
  i.item_id,
  i.item_code                                             AS master_sku,
  i.item_name                                             AS master_product_name,
  -- Style = the ERP half-code (same as Live_inventory.half_code):
  -- LJ-R00155-14YGLGD-12 -> LJ-R00155 ; non-LJ codes are their own style.
  IF(STARTS_WITH(UPPER(i.item_code), 'LJ-'),
     REGEXP_EXTRACT(UPPER(i.item_code), r'^(LJ-[^-]+)'), UPPER(i.item_code)) AS master_style,
  CAST(i.external_product_id AS STRING)                   AS shopify_product_id,
  i.is_disabled,
  ig.item_group_name                                      AS product_group,
  ca.type_name                                            AS category,
  ca.sub_type_name                                        AS sub_category,
  ca.super_type_name                                      AS super_type,
  ca.collection_name                                      AS collection,
  ca.brand_name                                           AS brand,
  ca.metal_name                                           AS metal,
  ca.metal_color_name                                     AS metal_colour,
  ca.karat_name                                           AS karat_raw,
  `lucirajewelry-prod.zoho_crm.pii_karat`(ca.karat_name, ca.metal_name) AS karat,
  UPPER(REGEXP_REPLACE(TRIM(i.item_code), r'\s+', ' '))   AS k_code,
  UPPER(REGEXP_REPLACE(TRIM(i.item_name), r'\s+', ' '))   AS k_name
FROM `lucirajewelry-prod.ds_imputed_reporting.items` i
LEFT JOIN `lucirajewelry-prod.ornaverse_erp_master.common_attributes` ca
  ON ca.item_attribute_id = i.item_attribute_id
LEFT JOIN `lucirajewelry-prod.Pos.item_groups` ig
  ON ig.item_group_id = i.item_group_id
WHERE i.item_code IS NOT NULL AND TRIM(i.item_code) != ''
QUALIFY ROW_NUMBER() OVER (PARTITION BY UPPER(REGEXP_REPLACE(TRIM(i.item_code), r'\s+', ' '))
                           ORDER BY i.is_disabled, i.modified_date DESC, i.item_id DESC) = 1;

-- ── Selling price per SKU = SUM of its Product_price component Saleing_price
--    (PP dashboard "Overall Selling Price"). If ANY component has no price, or
--    the sum is 0, the SKU price is NULL (band 'No Price') — never a partial sum.
CREATE OR REPLACE VIEW `lucirajewelry-prod.zoho_crm.v_pii_item_price` AS
SELECT
  item_code                                               AS master_sku,
  IF(COUNTIF(Saleing_price IS NULL) = 0, NULLIF(ROUND(SUM(Saleing_price), 2), 0), NULL) AS unit_selling_price,
  `lucirajewelry-prod.zoho_crm.pii_price_band`(
     IF(COUNTIF(Saleing_price IS NULL) = 0, SUM(Saleing_price), NULL)) AS price_band
FROM `lucirajewelry-prod.Pos.Product_price`
GROUP BY item_code;

-- ── Zoho product -> Items Master mapping (latest export only). One output row
--    per Zoho record, ALWAYS (unmapped rows are kept, never dropped).
--    Priority (a stronger tier is never overwritten by a weaker one):
--      1. Product Code == master SKU                         -> 'Mapped - Product Code'   (SKU level)
--      2. Product Name == master name AND External Product ID
--         (Shopify product id) == master shopify id          -> 'Mapped - Product Name + Shopify ID' (Style level)
--         NOTE: the CSV has no SKU column, so "Name + SKU" is not possible; the
--         Shopify product id is the only second identifier it carries.
--      3. Product Name only, resolving to exactly ONE style  -> 'Partial Match'  (Style level, unconfirmed)
--      any tier hitting >1 SKU / >1 style                    -> 'Multiple Match'
--      nothing                                               -> 'Unmapped'
CREATE OR REPLACE VIEW `lucirajewelry-prod.zoho_crm.v_zoho_product_map` AS
WITH z AS (
  SELECT
    record_id, export_date,
    product_code                                          AS zoho_product_code,
    product_name                                          AS zoho_product_name,
    external_product_id                                   AS zoho_shopify_product_id,
    product_category                                      AS zoho_product_category,
    product_type                                          AS zoho_product_type,
    SAFE_CAST(quantity_in_stock AS INT64)                 AS zoho_qty_in_stock,
    SAFE_CAST(unit_amount AS FLOAT64)                     AS zoho_unit_amount,
    product_url                                           AS zoho_product_url,
    created_time                                          AS zoho_created_time,
    modified_time                                         AS zoho_modified_time,
    UPPER(REGEXP_REPLACE(TRIM(IFNULL(product_code, '')), r'\s+', ' ')) AS zk,
    UPPER(REGEXP_REPLACE(TRIM(IFNULL(product_name, '')), r'\s+', ' ')) AS zn,
    NULLIF(TRIM(IFNULL(external_product_id, '')), '')     AS zext
  FROM `lucirajewelry-prod.zoho_crm.zoho_products_src`
  WHERE export_date = (SELECT MAX(export_date) FROM `lucirajewelry-prod.zoho_crm.zoho_products_src`)
),
m AS (SELECT * FROM `lucirajewelry-prod.zoho_crm.v_pii_item_master`),
t1 AS (SELECT z.record_id, COUNT(*) n_sku, ANY_VALUE(m.master_sku) sku, ANY_VALUE(m.master_style) style
       FROM z JOIN m ON m.k_code = z.zk WHERE z.zk != '' GROUP BY 1),
t2 AS (SELECT z.record_id, COUNT(DISTINCT m.master_style) n_style, COUNT(*) n_sku, ANY_VALUE(m.master_style) style
       FROM z JOIN m ON m.k_name = z.zn AND m.shopify_product_id = z.zext WHERE z.zn != '' GROUP BY 1),
t3 AS (SELECT z.record_id, COUNT(DISTINCT m.master_style) n_style, COUNT(*) n_sku, ANY_VALUE(m.master_style) style
       FROM z JOIN m ON m.k_name = z.zn WHERE z.zn != '' GROUP BY 1),
decided AS (
  SELECT z.*,
    CASE
      WHEN t1.n_sku = 1   THEN 'Mapped - Product Code'
      WHEN t1.n_sku > 1   THEN 'Multiple Match'
      WHEN t2.n_style = 1 THEN 'Mapped - Product Name + Shopify ID'
      WHEN t2.n_style > 1 THEN 'Multiple Match'
      WHEN t3.n_style = 1 THEN 'Partial Match'
      WHEN t3.n_style > 1 THEN 'Multiple Match'
      ELSE 'Unmapped' END                                   AS mapping_status,
    CASE
      WHEN t1.n_sku = 1   THEN 'product_code'
      WHEN t1.n_sku > 1   THEN 'product_code'
      WHEN t2.n_style >= 1 THEN 'product_name+shopify_id'
      WHEN t3.n_style >= 1 THEN 'product_name'
      ELSE NULL END                                         AS mapping_method,
    CASE WHEN t1.n_sku = 1 THEN 'SKU'
         WHEN COALESCE(t2.n_style, t3.n_style) = 1 THEN 'Style' END AS mapping_level,
    CASE WHEN t1.n_sku = 1 THEN t1.sku END                  AS mapped_sku,
    CASE WHEN t1.n_sku = 1 THEN t1.style
         WHEN t2.n_style = 1 THEN t2.style
         WHEN t3.n_style = 1 AND t2.n_style IS NULL THEN t3.style END AS mapped_style,
    CASE
      WHEN t1.n_sku = 1 THEN 'Product Code matches Items Master SKU'
      WHEN t1.n_sku > 1 THEN FORMAT('Product Code matches %d master SKUs', t1.n_sku)
      WHEN t2.n_style = 1 THEN FORMAT('%s: Name + Shopify ID -> style (%d variants); CSV has no SKU',
                                      IF(z.zk != '', 'Product Code not in Items Master', 'No Product Code'), t2.n_sku)
      WHEN t2.n_style > 1 THEN FORMAT('Name + Shopify ID match %d styles', t2.n_style)
      WHEN t3.n_style = 1 THEN FORMAT('Name-only match to 1 style (%d variants); Shopify ID %s',
                                      t3.n_sku, IF(z.zext IS NULL, 'blank', 'did not confirm'))
      WHEN t3.n_style > 1 THEN FORMAT('Product Name matches %d different styles', t3.n_style)
      WHEN z.zk != '' THEN 'Product Code and Product Name not found in Items Master'
      ELSE 'No Product Code; Product Name not found in Items Master' END AS mapping_reason
  FROM z
  LEFT JOIN t1 USING (record_id)
  LEFT JOIN t2 USING (record_id)
  LEFT JOIN t3 USING (record_id)
),
style_attr AS (   -- style-level attributes (only fields constant within a style)
  SELECT master_style,
         ANY_VALUE(master_product_name) style_product_name,
         IF(COUNT(DISTINCT category) = 1, ANY_VALUE(category), 'Mixed') style_category,
         IF(COUNT(DISTINCT product_group) = 1, ANY_VALUE(product_group), 'Mixed') style_product_group,
         COUNT(*) style_variants
  FROM m GROUP BY master_style
)
SELECT
  d.* EXCEPT (zk, zn, zext),
  mm.master_sku, mm.master_product_name,
  COALESCE(mm.category, sa.style_category)                AS master_category,
  mm.sub_category                                          AS master_sub_category,
  COALESCE(mm.product_group, sa.style_product_group)      AS master_product_group,
  mm.collection AS master_collection, mm.metal AS master_metal, mm.metal_colour AS master_metal_colour,
  mm.karat AS master_karat, sa.style_variants
FROM decided d
LEFT JOIN m mm ON mm.master_sku = d.mapped_sku
LEFT JOIN style_attr sa ON sa.master_style = d.mapped_style;
