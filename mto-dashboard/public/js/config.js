// ---- Business parameters: the ONLY place targets live. Change here, nothing else needs rebuilding. ----
export const CONFIG = {
  VENDOR_PRODUCTION_TAT: 8,   // days, Vendor Production / QC (management working target)
  OVERALL_MTO_TAT: 14,        // days, order -> completion (management working target)
  AT_RISK_RATIO: 0.75,        // open order is "At Risk" once it has used this share of a target
  // Sub-activities of Vendor Production / QC. Informational only: no timestamps exist, so no sub-stage TAT is computed.
  PRODUCTION_SUBSTEPS: [['Coating', 2], ['Filling / Polishing', 3], ['Setting', 2], ['Final Polish', 1]],
  AGEING_BUCKETS: [ // [label, min, max]
    ['0–3 days', 0, 3], ['4–7 days', 4, 7], ['8–14 days', 8, 14], ['15–21 days', 15, 21], ['22+ days', 22, Infinity]],
  // PO matching on item_line_no is only reliable for Online orders from about this date (Online PO coverage: Mar 0%, Apr 12%,
  // Jun 45%, Aug 62%, Sep 73%). Older Online orders with NO milestone at all are shown as Data Mapping Pending,
  // not PO Pending / Delayed, because their PO most likely exists but cannot be linked. Set to '' to disable.
  ONLINE_PO_LINK_FROM: '2026-06-01',
  // Inward date: 'grn_first' = GRN date, else APU (purchase.consignment), else store consignment-in.
  //              'earliest'  = earliest date among GRN / APU / consignment-in. DEFAULT: on live data the APU is earlier than the GRN
  //              for 161 of 170 items that have both (never later; GRN median +5 days), and with 'grn_first' those same 161 items
  //              show as tagged before they were inwarded. The GRN is the late accounting posting; the APU is the arrival.
  INWARD_DATE_RULE: 'earliest',
  PAGE_SIZE: 25,
};

// Current-stage vocabulary. Order = journey order. Add a stage by adding a row here + a rule in model.js.
export const STAGES = {
  PENDING_MAP: 'Data Mapping Pending',
  PO_PENDING: 'PO Pending',
  PRODUCTION: 'Vendor Production / QC',
  TAG_PENDING: 'Tagging Pending',
  INV_PENDING: 'Invoice Pending',
  ALLOC: 'Allocated from Stock',   // served from existing stock (stock_allocation), not yet invoiced
  RTS: 'Converted to RTS',   // same item_line_no re-appears as an Rts sale (to another customer) after the MTO order
  DONE: 'Invoiced / Completed',
};
export const STAGE_ORDER = [STAGES.PO_PENDING, STAGES.PRODUCTION, STAGES.TAG_PENDING, STAGES.ALLOC, STAGES.INV_PENDING, STAGES.DONE, STAGES.RTS, STAGES.PENDING_MAP];
export const STATUS = { ON_TRACK: 'On Track', AT_RISK: 'At Risk', DELAYED: 'Delayed', DONE: 'Completed', REVIEW: 'Needs Review', NO_DATA: 'No Data' };
