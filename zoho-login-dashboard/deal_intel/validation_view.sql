-- Validation view for Zoho Deal Intelligence (spec §23): one row per deal with the
-- inputs and every flag side by side, plus the check each row is meant to prove.
CREATE OR REPLACE VIEW `lucirajewelry-prod.zoho_crm.zoho_deal_intelligence_validation_v` AS
SELECT
  deal_id, deal_created_date, minimum_sale_date, sale_match_method,
  lead_source, deal_trigger_event,
  buyer_flag, subscriber_flag, visitor_flag, ctwa_flag,
  deal_category, matched_rules, buyer_reason,
  CASE
    WHEN ctwa_flag                                         THEN '7. Trigger contains WHATSAPP -> CTWA'
    WHEN buyer_reason = 'Sale before deal'                 THEN '1. Sale before Deal -> Buyer'
    WHEN buyer_reason = 'First sale on deal date'          THEN '2. Sale same day as Deal -> Non-Buyer'
    WHEN LOWER(deal_trigger_event) LIKE '%nitroproductview%' THEN '4. NitroProductView -> Visitor, not Subscriber'
    WHEN LOWER(deal_trigger_event) LIKE '%nitroaddtocart%'   THEN '5. NitroAddToCart -> Visitor, not Subscriber'
    WHEN LOWER(deal_trigger_event) LIKE '%nitro%'            THEN '6. Other Nitro -> Visitor'
    WHEN deal_trigger_event IS NULL AND buyer_reason = 'No matching sale' THEN '6b. Blank trigger -> Subscriber'
    WHEN buyer_reason = 'No matching sale'                 THEN '3. No Sale -> Non-Buyer'
    ELSE '3b. First sale after Deal -> Non-Buyer'
  END AS validation_case
FROM `lucirajewelry-prod.zoho_crm.zoho_deal_intelligence`;
