// Pure business logic: raw milestone rows -> derived operational fields. No DOM, no fetching.
import { CONFIG, STAGES, STATUS } from './config.js';

const DAY = 864e5;
export const parseD = s => (s ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : null);
const diff = (a, b) => (a == null || b == null ? null : Math.round((b - a) / DAY));
export const todayUTC = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()); };
export const Q = a => a.reduce((s, r) => s + (r.qty || 0), 0); // quantity (pieces) is the counting unit everywhere
export const avg = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

export function derive(raw, today = todayUTC()) {
  const r = { ...raw };
  // Invoice is matched on item_line_no. Invoiced to the SAME customer = delivered; to a DIFFERENT customer = the piece was re-sold as RTS.
  r.invOther = !!r.inv_no && r.inv_same_customer === false;
  r.rtsDate = r.invOther ? r.inv_date : r.rts_date;
  r.rtsDoc = r.invOther ? r.inv_no : r.rts_doc;
  r.rtsBuyer = r.invOther ? r.inv_party : null;
  // Inward = GRN, APU or store consignment-in (see CONFIG.INWARD_DATE_RULE). t.grn is the effective inward date used by every downstream rule.
  const inw = [['GRN', r.grn_date, r.grn_no], ['APU', r.apu_date, r.apu_no], ['Consignment-in', r.cin_date, r.cin_no]].filter(x => x[1]);
  const pick = CONFIG.INWARD_DATE_RULE === 'earliest' ? [...inw].sort((a, b) => (a[1] < b[1] ? -1 : 1))[0] : inw[0];
  r.inwardDate = pick ? pick[1] : null; r.inwardSrc = pick ? pick[0] : null; r.inwardNo = pick ? pick[2] : null;
  const t = { order: parseD(r.order_date), po: parseD(r.po_date), grn: parseD(r.inwardDate), tag: parseD(r.tag_date), inv: parseD(r.inv_date), rts: parseD(r.rtsDate) };
  r.t = t;
  r.vendor = r.vendor || ''; // vendor exists only once a PO is raised

  // Stage = latest CONFIRMED milestone. Unmapped lines are never guessed.
  let stage, start;
  if (t.inv && !r.invOther) { stage = STAGES.DONE; start = t.inv; }   // invoice evidence does not need the ERP order bridge
  else if (t.rts) { stage = STAGES.RTS; start = t.rts; }
  else if (!r.order_line_mapped) { stage = STAGES.PENDING_MAP; start = null; }
  else if (t.tag) { stage = STAGES.INV_PENDING; start = t.tag; }
  else if (t.grn) { stage = STAGES.TAG_PENDING; start = t.grn; }
  else if (r.alloc_date) { stage = STAGES.ALLOC; start = parseD(r.alloc_date); }   // piece allocated from stock: no vendor wait
  else if (t.po) { stage = STAGES.PRODUCTION; start = t.po; }
  else if (r.mto_type === 'Online' && CONFIG.ONLINE_PO_LINK_FROM && r.order_date < CONFIG.ONLINE_PO_LINK_FROM) { stage = STAGES.PENDING_MAP; start = null; } // legacy Online order, PO not linkable
  else { stage = STAGES.PO_PENDING; start = t.order; }
  r.stage = stage;
  r.done = stage === STAGES.DONE;
  r.rtsConverted = stage === STAGES.RTS;
  r.open = !r.done && !r.rtsConverted && stage !== STAGES.PENDING_MAP;

  r.orderToPo = diff(t.order, t.po);
  r.poToGrn = diff(t.po, t.grn);
  r.grnToTag = diff(t.grn, t.tag);
  r.tagToInv = diff(t.tag, t.inv);
  r.prodDays = t.po && stage !== STAGES.ALLOC ? diff(t.po, t.grn ?? today) : null; // vendor production elapsed (live while still at vendor)
  r.stageAge = r.open ? diff(start, today) : null;
  r.overallAge = diff(t.order, r.done ? t.inv : r.rtsConverted ? t.rts : today);

  r.prodDelay = r.prodDays != null ? Math.max(0, r.prodDays - CONFIG.VENDOR_PRODUCTION_TAT) : null;
  r.prodLate = r.prodDelay > 0;
  r.delayDays = stage !== STAGES.PENDING_MAP && !r.rtsConverted && r.overallAge != null ? Math.max(0, r.overallAge - CONFIG.OVERALL_MTO_TAT) : null;

  const T = CONFIG.AT_RISK_RATIO;
  if (stage === STAGES.PENDING_MAP) r.status = STATUS.NO_DATA;
  else if (r.rtsConverted) r.status = STATUS.REVIEW;
  else if (r.done) r.status = STATUS.DONE;
  else if (r.overallAge > CONFIG.OVERALL_MTO_TAT || (stage === STAGES.PRODUCTION && r.prodLate)) r.status = STATUS.DELAYED;
  else if (r.overallAge >= CONFIG.OVERALL_MTO_TAT * T || (stage === STAGES.PRODUCTION && r.prodDays >= CONFIG.VENDOR_PRODUCTION_TAT * T)) r.status = STATUS.AT_RISK;
  else r.status = STATUS.ON_TRACK;
  r.completedLate = r.done && r.overallAge > CONFIG.OVERALL_MTO_TAT;

  const b = r.open ? CONFIG.AGEING_BUCKETS.find(([, lo, hi]) => r.overallAge >= lo && r.overallAge <= hi) : null;
  r.bucket = b ? b[0] : null;
  r.search = [r.order_id, r.line_id, r.customer, r.sku, r.product, r.vendor, r.po_no, r.store].join(' ').toLowerCase();
  return r;
}

// Journey funnel, counted in QUANTITY (pieces). "Pending" = reached the previous stage but not this one.
export function journey(rows) {
  const N = Q(rows), m = rows.filter(r => r.order_line_mapped);
  const has = k => m.filter(r => r.t[k]);
  const po = has("po"), grn = has("grn"), tag = has("tag"), inv = rows.filter(r => r.done), rts = rows.filter(r => r.rtsConverted);
  const at = s => Q(rows.filter(r => r.stage === s));
  const prodRows = po.filter(r => r.prodDays != null);
  return [
    { key: "order", label: "MTO Order", n: N, pending: at(STAGES.PENDING_MAP), pendingLabel: "mapping pending" },
    { key: "po", label: "PO Raised", n: Q(po), pending: at(STAGES.PO_PENDING), pendingLabel: "PO pending", tat: avg(po.map(r => r.orderToPo)), tatLabel: "Order → PO" },
    { key: "prod", label: "Vendor Production / QC", n: Q(po), pending: at(STAGES.PRODUCTION), pendingLabel: "at vendor",
      target: CONFIG.VENDOR_PRODUCTION_TAT, tat: avg(prodRows.map(r => r.prodDays)), tatLabel: "Avg elapsed", delayed: Q(prodRows.filter(r => r.prodLate)) },
    { key: "grn", label: "GRN / Inward", n: Q(grn), pending: at(STAGES.PRODUCTION), pendingLabel: "awaiting GRN", tat: avg(grn.map(r => r.poToGrn)), tatLabel: "PO → GRN" },
    { key: "tag", label: "Tagging", n: Q(tag), pending: at(STAGES.TAG_PENDING), pendingLabel: "pending tagging", tat: avg(tag.filter(r => r.grnToTag >= 0).map(r => r.grnToTag)), tatLabel: "GRN → Tag (≥0d)" },
    { key: "alloc", label: "Allocated from Stock", n: Q(rows.filter(r => r.alloc_date)), pending: at(STAGES.ALLOC), pendingLabel: "awaiting invoice", note: "Served from existing stock, so no vendor PO is needed" },
    { key: "inv", label: "Invoiced to Customer", n: Q(inv), pending: at(STAGES.INV_PENDING), pendingLabel: "pending invoice", tat: avg(inv.map(r => r.tagToInv)), tatLabel: "Tag → Invoice", note: "Matched by item line number; invoice must be to the ordering customer" },
    { key: "rts", label: "Converted to RTS", n: Q(rts), pending: null, pendingLabel: "", note: "Same item line was invoiced to a different customer (re-sold as RTS)" },
  ];
}

export function vendorStats(rows) {
  const by = new Map();
  rows.filter(r => r.order_line_mapped && r.vendor).forEach(r => { if (!by.has(r.vendor)) by.set(r.vendor, []); by.get(r.vendor).push(r); });
  return [...by].map(([vendor, x]) => {
    const po = x.filter(r => r.t.po), timed = po.filter(r => r.prodDays != null), late = timed.filter(r => r.prodLate);
    const prod = x.filter(r => r.stage === STAGES.PRODUCTION);
    return { vendor, total: Q(x), po: Q(po), inProd: Q(prod), grn: Q(x.filter(r => r.t.grn)), pending: Q(x.filter(r => r.open)),
      avgTat: avg(timed.map(r => r.prodDays)), late: Q(late), delayPct: Q(timed) ? Q(late) / Q(timed) : null };
  });
}

export function dataQuality(rows) {
  const unm = rows.filter(r => r.stage === STAGES.PENDING_MAP), m = rows.filter(r => r.order_line_mapped); // unmatched = cannot be traced at all (invoiced / RTS lines are traceable)
  const split = t => ({ total: Q(rows.filter(r => r.mto_type === t)), unmapped: Q(unm.filter(r => r.mto_type === t)) });
  return {
    base: Q(rows), orders: new Set(rows.map(r => r.order_id)).size,
    mappedLines: Q(m), po: Q(m.filter(r => r.po_no)), grn: Q(rows.filter(r => r.inwardDate)),
    tag: Q(m.filter(r => r.tag_no)), inv: Q(rows.filter(r => r.done)), invByLine: Q(rows.filter(r => r.inv_src === "item_line_no")), rts: Q(rows.filter(r => r.rtsConverted)),
    unmatched: Q(unm),
    tagBeforeGrn: Q(rows.filter(r => r.tag_date && r.inwardDate && r.tag_date < r.inwardDate)),
    invBeforeGrn: Q(rows.filter(r => r.inv_date && r.inwardDate && r.inv_date < r.inwardDate)),
    tagNoGrn: Q(rows.filter(r => r.tag_no && !r.inwardDate)),
    inwGrn: Q(rows.filter(r => r.inwardSrc === 'GRN')), inwApu: Q(rows.filter(r => r.inwardSrc === 'APU')), inwCin: Q(rows.filter(r => r.inwardSrc === 'Consignment-in')),
    apuWithGrn: Q(rows.filter(r => r.apu_date && r.grn_date)), apuEarlier: Q(rows.filter(r => r.apu_date && r.grn_date && r.apu_date < r.grn_date)), online: split("Online"), store: split("Store"),
    multiPo: Q(m.filter(r => r.po_count > 1)), invRejected: Q(rows.filter(r => r.inv_link_rejected)),
  };
}
