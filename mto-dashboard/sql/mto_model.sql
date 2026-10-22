-- MTO milestone model. ONE ROW PER MTO ORDER LINE (marketing_sale.item_line_no is unique across MTO rows).
-- Only raw milestones are produced here. Stage / ageing / status are derived client-side from public/js/config.js,
-- so targets can change without touching SQL.
--
-- EVERY STAGE IS MATCHED ON item_line_no (the order line number is carried through each ERP line table):
--   marketing_sale.item_line_no = purchase.order_items.item_line_no      -> PO   (header: purchase.order)
--                               = purchase.invoice_items.item_line_no    -> GRN  (header: purchase.invoice)
--                               = purchase.consignment_items.item_line_no -> APU inward (header: purchase.consignment)
--                               = Lucira_Prod.consignment_in_items.item_line_no -> store consignment-in (header: consignment_in)
--                               = tagging_items.item_line_no             -> Tagging (header: tagging)
--                               = stock_allocation_items.item_line_no    -> Allocated from stock (header: stock_allocation); piece line/sku via stock_allocated_items on transaction_item_id
--                               = ornaverse_erp_pos.invoice_items.item_line_no -> Invoice (header: ornaverse_erp_pos.invoice)
--                               = MarketPlace.invoice_items.item_line_no -> Online invoice (header: MarketPlace.invoice)
-- Rules applied uniformly: cancelled documents (document_status = 2) are ignored; a milestone dated BEFORE the
-- order date is ignored (it cannot belong to this order); dates are converted to Asia/Kolkata.
-- Multiple documents on one line (re-PO, partial GRN...): first date is used for timing, latest PO for vendor / PO no.
WITH ms AS (
  SELECT item_line_no, Fullfillment, document_no, Transaction_Date AS order_date, party_name, company_code,
         party_id, Full_sku, Product_Title, type_name, pieces
  FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
  WHERE Fullfillment IN ('Online_MTO','MTO')
),
-- store orders carry an ERP order header whose status can be 'cancelled' (2): those are not part of the MTO population
store_order AS (
  SELECT oi.item_line_no, ANY_VALUE(o.document_status) AS order_status
  FROM `lucirajewelry-prod.ornaverse_erp_pos.order_items` oi
  JOIN `lucirajewelry-prod.ornaverse_erp_pos.order` o ON o.transaction_id = oi.transaction_id
  GROUP BY oi.item_line_no
),
po_rows AS (
  SELECT i.item_line_no, h.document_no, DATE(h.document_date, 'Asia/Kolkata') AS d, pt.party_name AS vendor
  FROM `lucirajewelry-prod.purchase.order_items` i
  JOIN `lucirajewelry-prod.purchase.order` h ON h.transaction_id = i.transaction_id AND h.document_status <> 2
  LEFT JOIN `lucirajewelry-prod.ornaverse_erp_master.party` pt ON CAST(pt.party_id AS INT64) = h.party_id
),
grn_rows AS (
  SELECT i.item_line_no, h.document_no, DATE(h.document_date, 'Asia/Kolkata') AS d
  FROM `lucirajewelry-prod.purchase.invoice_items` i
  JOIN `lucirajewelry-prod.purchase.invoice` h ON h.transaction_id = i.transaction_id AND h.document_status <> 2
),
-- Inward evidence besides the GRN: APU = purchase.consignment (HO-APU-..., doc type 20) and store consignment-in (FCS-FCI-..., doc type 100).
apu_rows AS (
  SELECT i.item_line_no, h.document_no, DATE(h.document_date, 'Asia/Kolkata') AS d
  FROM `lucirajewelry-prod.purchase.consignment_items` i
  JOIN `lucirajewelry-prod.purchase.consignment` h ON h.transaction_id = i.transaction_id AND h.document_status <> 2
),
cin_rows AS (
  SELECT i.item_line_no, h.document_no, DATE(h.document_date, 'Asia/Kolkata') AS d
  FROM `lucirajewelry-prod.Lucira_Prod.consignment_in_items` i
  JOIN `lucirajewelry-prod.Lucira_Prod.consignment_in` h ON h.transaction_id = i.transaction_id AND h.document_status <> 2
),
tag_rows AS (
  SELECT i.item_line_no, h.document_no, DATE(h.document_date, 'Asia/Kolkata') AS d
  FROM `lucirajewelry-prod.Lucira_Prod.tagging_items` i
  JOIN `lucirajewelry-prod.Lucira_Prod.tagging` h ON h.transaction_id = i.transaction_id AND h.document_status <> 2
),
-- Two invoice sources: POS invoices (ornaverse_erp_pos) and online marketplace invoices (MarketPlace). Verified: MarketPlace.invoice_items
-- matches 224 Online MTO items on item_line_no (223 not in the POS table), same customer in 224/224, none dated before the order.
inv_rows AS (
  SELECT i.item_line_no, i.sku, h.document_no, DATE(h.document_date, 'Asia/Kolkata') AS d, h.party_id, pt.party_name, 'POS' AS channel
  FROM `lucirajewelry-prod.ornaverse_erp_pos.invoice_items` i
  JOIN `lucirajewelry-prod.ornaverse_erp_pos.invoice` h ON h.transaction_id = i.transaction_id AND h.document_status <> 2
  LEFT JOIN `lucirajewelry-prod.ornaverse_erp_master.party` pt ON CAST(pt.party_id AS INT64) = h.party_id
  UNION ALL
  SELECT i.item_line_no, i.sku, h.document_no, DATE(h.document_date, 'Asia/Kolkata') AS d, h.party_id, pt.party_name, 'Marketplace' AS channel
  FROM `lucirajewelry-prod.MarketPlace.invoice_items` i
  JOIN `lucirajewelry-prod.MarketPlace.invoice` h ON h.transaction_id = i.transaction_id AND h.document_status <> 2
  LEFT JOIN `lucirajewelry-prod.ornaverse_erp_master.party` pt ON CAST(pt.party_id AS INT64) = h.party_id
),
po_a AS (
  SELECT ms.item_line_no, MIN(r.d) po_first, COUNT(DISTINCT r.document_no) po_count,
         ARRAY_AGG(STRUCT(r.document_no AS doc, r.vendor AS vendor) ORDER BY r.d DESC LIMIT 1)[OFFSET(0)] last_po
  FROM ms JOIN po_rows r ON r.item_line_no = ms.item_line_no AND r.d >= ms.order_date GROUP BY 1
),
grn_a AS (
  SELECT ms.item_line_no, MIN(r.d) grn_first, COUNT(DISTINCT r.document_no) grn_count,
         ARRAY_AGG(r.document_no ORDER BY r.d LIMIT 1)[OFFSET(0)] grn_no
  FROM ms JOIN grn_rows r ON r.item_line_no = ms.item_line_no AND r.d >= ms.order_date GROUP BY 1
),
apu_a AS (
  SELECT ms.item_line_no, MIN(r.d) apu_first, ARRAY_AGG(r.document_no ORDER BY r.d LIMIT 1)[OFFSET(0)] apu_no
  FROM ms JOIN apu_rows r ON r.item_line_no = ms.item_line_no AND r.d >= ms.order_date GROUP BY 1
),
cin_a AS (
  SELECT ms.item_line_no, MIN(r.d) cin_first, ARRAY_AGG(r.document_no ORDER BY r.d LIMIT 1)[OFFSET(0)] cin_no
  FROM ms JOIN cin_rows r ON r.item_line_no = ms.item_line_no AND r.d >= ms.order_date GROUP BY 1
),
tag_a AS (
  SELECT ms.item_line_no, MIN(r.d) tag_first, ARRAY_AGG(r.document_no ORDER BY r.d LIMIT 1)[OFFSET(0)] tag_no
  FROM ms JOIN tag_rows r ON r.item_line_no = ms.item_line_no AND r.d >= ms.order_date GROUP BY 1
),
inv_a AS (
  SELECT ms.item_line_no,
         ARRAY_AGG(STRUCT(r.document_no AS doc, r.d AS d, r.party_id AS party_id, r.party_name AS party_name, r.channel AS channel) ORDER BY r.d LIMIT 1)[OFFSET(0)] v
  FROM ms JOIN inv_rows r ON r.item_line_no = ms.item_line_no AND r.d >= ms.order_date GROUP BY 1
),
-- STOCK ALLOCATION: an MTO order can be served from existing stock. stock_allocation_items carries the ORDER's line number
-- (new), stock_allocated_items carries the stock piece's own line number + sku (old); both rows share transaction_item_id.
-- (verified: 216 pairs, 205 with a different line number; the invoice for the piece carries the piece sku in 95 of 98 cases.)
alloc_rows AS (
  SELECT n.item_line_no AS order_line, n.allocated_pieces, h.document_no, DATE(h.document_date, 'Asia/Kolkata') AS d,
         o.item_line_no AS piece_line, o.sku AS piece_sku
  FROM `lucirajewelry-prod.Lucira_Prod.stock_allocation_items` n
  JOIN `lucirajewelry-prod.Lucira_Prod.stock_allocation` h ON h.transaction_id = n.transaction_id AND h.document_status <> 2
  LEFT JOIN `lucirajewelry-prod.Lucira_Prod.stock_allocated_items` o ON o.transaction_item_id = n.transaction_item_id
),
alloc_a AS (
  SELECT ms.item_line_no, MIN(r.d) alloc_first,
         ARRAY_AGG(STRUCT(r.document_no AS doc, r.allocated_pieces AS pcs, r.piece_line AS piece_line, r.piece_sku AS piece_sku) ORDER BY r.d LIMIT 1)[OFFSET(0)] a
  FROM ms JOIN alloc_rows r ON r.order_line = ms.item_line_no AND r.d >= ms.order_date GROUP BY 1
),
-- Invoice found through the allocated piece: invoice line has the piece's old line number or the piece's sku, and is dated on/after
-- the allocation (earlier invoices of the same physical piece belong to its previous sale, not to this order).
inv_piece AS (
  SELECT al.item_line_no,
         ARRAY_AGG(STRUCT(r.document_no AS doc, r.d AS d, r.party_id AS party_id, r.party_name AS party_name, r.channel AS channel) ORDER BY r.d LIMIT 1)[OFFSET(0)] v
  FROM alloc_a al JOIN inv_rows r
    ON (r.item_line_no = al.a.piece_line OR (al.a.piece_sku IS NOT NULL AND al.a.piece_sku <> '' AND r.sku = al.a.piece_sku)) AND r.d >= al.alloc_first
  GROUP BY 1
),
-- Fallback evidence of "sold": marketing_sale shows the same item_line_no under 'Rts' after the MTO order.
rts AS (
  SELECT item_line_no, ARRAY_AGG(STRUCT(document_no, Transaction_Date, party_id, company_code, Channel) ORDER BY Transaction_Date LIMIT 1)[OFFSET(0)] r
  FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale` WHERE Fullfillment = 'Rts' GROUP BY item_line_no
)
SELECT
  CAST(ms.item_line_no AS STRING) AS line_id,
  ms.document_no AS order_id,
  IF(ms.Fullfillment = 'Online_MTO', 'Online', 'Store') AS mto_type,
  CAST(ms.order_date AS STRING) AS order_date,
  ms.party_name AS customer,
  IF(ms.Fullfillment = 'Online_MTO', 'Online', ms.company_code) AS store,
  COALESCE(ms.pieces, 1) AS qty,
  ms.Full_sku AS sku, ms.Product_Title AS product, ms.type_name AS category,
  pa.last_po.vendor AS vendor,   -- vendor on the PO only; empty until a PO is raised (no default / product-master fallback)
  IF(pa.last_po.vendor IS NOT NULL, 'PO', NULL) AS vendor_src,
  TRUE AS order_line_mapped,   -- item_line_no is the universal key, so every MTO line is traceable; "no PO" now means PO not raised
  'item_line_no' AS bridge_src,
  pa.last_po.doc AS po_no, CAST(pa.po_first AS STRING) AS po_date, pa.po_count,
  ga.grn_no, CAST(ga.grn_first AS STRING) AS grn_date, ga.grn_count AS grn_lines,
  ap.apu_no, CAST(ap.apu_first AS STRING) AS apu_date, ci.cin_no, CAST(ci.cin_first AS STRING) AS cin_date,
  ta.tag_no, CAST(ta.tag_first AS STRING) AS tag_date,
  COALESCE(ia.v.doc, ip.v.doc) AS inv_no, CAST(COALESCE(ia.v.d, ip.v.d) AS STRING) AS inv_date,
  IF(ia.v.doc IS NOT NULL, 'item_line_no', IF(ip.v.doc IS NOT NULL, 'allocated piece', NULL)) AS inv_src,
  IF(COALESCE(ia.v.doc, ip.v.doc) IS NOT NULL, COALESCE(ia.v.party_id, ip.v.party_id) = ms.party_id, NULL) AS inv_same_customer,
  al.a.doc AS alloc_doc, CAST(al.alloc_first AS STRING) AS alloc_date, al.a.pcs AS alloc_pieces, CAST(al.a.piece_line AS STRING) AS alloc_piece_line, al.a.piece_sku AS alloc_piece_sku,
  COALESCE(ia.v.party_name, ip.v.party_name) AS inv_party,
  COALESCE(ia.v.channel, ip.v.channel) AS inv_channel,
  rt.r.document_no AS rts_doc, CAST(rt.r.Transaction_Date AS STRING) AS rts_date, rt.r.company_code AS rts_store, rt.r.Channel AS rts_channel,
  (rt.r.party_id = ms.party_id) AS rts_same_customer,
  FALSE AS inv_link_rejected
FROM ms
LEFT JOIN store_order so ON so.item_line_no = ms.item_line_no
LEFT JOIN po_a pa ON pa.item_line_no = ms.item_line_no
LEFT JOIN grn_a ga ON ga.item_line_no = ms.item_line_no
LEFT JOIN apu_a ap ON ap.item_line_no = ms.item_line_no
LEFT JOIN cin_a ci ON ci.item_line_no = ms.item_line_no
LEFT JOIN tag_a ta ON ta.item_line_no = ms.item_line_no
LEFT JOIN inv_a ia ON ia.item_line_no = ms.item_line_no
LEFT JOIN alloc_a al ON al.item_line_no = ms.item_line_no
LEFT JOIN inv_piece ip ON ip.item_line_no = ms.item_line_no
LEFT JOIN rts rt ON rt.item_line_no = ms.item_line_no AND rt.r.Transaction_Date >= ms.order_date
WHERE COALESCE(so.order_status, -1) <> 2 -- cancelled MTO orders are not part of the population
ORDER BY ms.order_date DESC, ms.item_line_no DESC
