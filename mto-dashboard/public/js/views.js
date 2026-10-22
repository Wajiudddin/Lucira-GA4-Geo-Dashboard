// Rendering helpers. Each function takes derived data and returns an HTML/SVG string. No state, no fetching.
import { CONFIG, STAGES, STATUS } from './config.js';
import { avg, Q } from './model.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtD = s => (s ? `${s.slice(8, 10)} ${MON[+s.slice(5, 7) - 1]} ${s.slice(2, 4)}` : '—');
export const n0 = v => (v == null ? '—' : Math.round(v).toLocaleString('en-IN'));
export const n1 = v => (v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1));
export const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
export const days = v => (v == null ? '—' : `${v}d`);

export const statusClass = s => ({ [STATUS.DONE]: 's-good', [STATUS.ON_TRACK]: 's-good', [STATUS.AT_RISK]: 's-warn', [STATUS.DELAYED]: 's-bad', [STATUS.REVIEW]: 's-warn', [STATUS.NO_DATA]: 's-none' }[s]);
export const stageClass = s => ({ [STAGES.DONE]: 's-good', [STAGES.PO_PENDING]: 's-warn', [STAGES.TAG_PENDING]: 's-warn', [STAGES.INV_PENDING]: 's-warn', [STAGES.PRODUCTION]: 's-info', [STAGES.RTS]: 's-warn', [STAGES.ALLOC]: 's-info', [STAGES.PENDING_MAP]: 's-none' }[s]);
export const badge = (txt, cls) => `<span class="badge ${cls}">${esc(txt)}</span>`;
const tip = t => `data-tip="${esc(t)}"`;

const ICON = {
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4V7zM3 7l9 4m0 0l9-4m-9 4v10"/>', globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  store: '<path d="M4 10v10h16V10M3 10l2-6h14l2 6M9 20v-6h6v6"/>', doc: '<path d="M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', factory: '<path d="M3 21V10l6 4v-4l6 4V6h6v15zM7 21v-3m4 3v-3m4 3v-3"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>', tag: '<path d="M3 12V4h8l10 10-8 8zM7.5 8.5h.01"/>',
  inv: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>', alert: '<path d="M12 3l10 18H2zM12 10v5M12 18v.01"/>', timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>',
};
const ico = k => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;

// Every stage card counts QUANTITY (pieces). Orders = distinct order documents.
// What each KPI card counts, so the card and its popup list always agree.
export const KPI_DEFS = {
  total:     { title: 'All MTO orders', test: () => true },
  qty:       { title: 'All MTO pieces ordered', test: () => true },
  online:    { title: 'Online MTO', test: r => r.mto_type === 'Online' },
  store:     { title: 'Store MTO', test: r => r.mto_type === 'Store' },
  po:        { title: 'PO raised', test: r => r.t.po },
  popending: { title: 'PO pending (no PO raised yet)', test: r => r.stage === STAGES.PO_PENDING },
  prod:      { title: 'In production / awaiting GRN', test: r => r.stage === STAGES.PRODUCTION },
  alloc:     { title: 'Allocated from stock', test: r => r.alloc_date },
  grn:       { title: 'GRN / inward completed', test: r => r.t.grn },
  tagpend:   { title: 'Tagging pending', test: r => r.stage === STAGES.TAG_PENDING },
  invpend:   { title: 'Invoice pending', test: r => r.stage === STAGES.INV_PENDING },
  invoiced:  { title: 'Invoiced to the customer', test: r => r.done },
  delayed:   { title: 'Delayed (open and past target)', test: r => r.status === STATUS.DELAYED },
  unmapped:  { title: 'Unmapped orders (Data Mapping Pending): no PO, inward, tagging, allocation or invoice found. All dates.', test: r => r.stage === STAGES.PENDING_MAP, allDates: true },
  tat:       { title: 'Vendor production time (PO to inward, or to today while still at vendor)', test: r => r.prodDays != null, sort: 'prodDays', extra: ['poToGrn'] },
};
const KPI_KEYS = ['total', 'qty', 'online', 'store', 'po', 'popending', 'prod', 'alloc', 'grn', 'tagpend', 'invpend', 'invoiced', 'delayed', 'tat'];

export function kpis(rows, J) {
  const T = Q(rows), q = f => Q(rows.filter(f));
  const stage = s => q(r => r.stage === s);
  const orders = f => new Set(rows.filter(f).map(r => r.order_id)).size, D = orders(() => true);
  const online = orders(r => r.mto_type === 'Online'), store = orders(r => r.mto_type === 'Store');
  const jk = k => J.find(s => s.key === k) || {};
  const delayed = q(r => r.status === STATUS.DELAYED), prod = jk('prod');
  const P = n => `${pct(n, T)} of ${n0(T)} pcs`;
  const cards = [
    ['Total MTO Orders', D, `${n0(T)} pieces ordered`, 'box'],
    ['MTO Quantity (pcs)', T, `across ${n0(D)} orders`, 'box'],
    ['Online MTO', online, `${pct(online, D)} of orders · ${n0(q(r => r.mto_type === 'Online'))} pcs`, 'globe'],
    ['Store MTO', store, `${pct(store, D)} of orders · ${n0(q(r => r.mto_type === 'Store'))} pcs`, 'store'],
    ['PO Raised (pcs)', jk('po').n, P(jk('po').n), 'doc', 'good'],
    ['PO Pending (pcs)', stage(STAGES.PO_PENDING), 'mapped orders, no PO yet', 'clock', stage(STAGES.PO_PENDING) ? 'warn' : ''],
    ['In Production / Awaiting GRN (pcs)', stage(STAGES.PRODUCTION), `${q(r => r.stage === STAGES.PRODUCTION && r.prodLate)} pcs past ${CONFIG.VENDOR_PRODUCTION_TAT}-day target`, 'factory'],
    ['Allocated from Stock (pcs)', jk('alloc').n, `${n0(stage(STAGES.ALLOC))} awaiting invoice`, 'box'],
    ['GRN / Inward Completed (pcs)', jk('grn').n, P(jk('grn').n), 'check', 'good'],
    ['Tagging Pending (pcs)', stage(STAGES.TAG_PENDING), 'GRN done, not tagged', 'tag', stage(STAGES.TAG_PENDING) ? 'warn' : ''],
    ['Invoice Pending (pcs)', stage(STAGES.INV_PENDING), 'Tagged, not invoiced', 'inv', stage(STAGES.INV_PENDING) ? 'warn' : ''],
    ['Invoiced (pcs)', jk('inv').n, P(jk('inv').n), 'check', 'good'],
    ['Delayed (pcs)', delayed, 'open and past target', 'alert', delayed ? 'bad' : 'good'],
    ['Avg Vendor Production TAT', prod.tat == null ? '—' : `${n1(prod.tat)}d`, `target ${CONFIG.VENDOR_PRODUCTION_TAT}d`, 'timer', prod.tat > CONFIG.VENDOR_PRODUCTION_TAT ? 'bad' : ''],
  ];
  return cards.map(([l, val, s, i, k], idx) => `<div class="kpi clickable ${k ? 'k-' + k : ''}" data-kpi="${KPI_KEYS[idx]}" role="button" tabindex="0" title="Click to see the orders">${ico(i)}<div class="lab">${esc(l)}</div><div class="num">${typeof val === 'number' ? n0(val) : val}</div><div class="sub">${esc(s)}</div></div>`).join('');
}

export function journeyView(J, N) {
  return J.map((s, i) => {
    const w = N ? Math.round((s.n / N) * 100) : 0;
    const rowsHtml = [
      s.pending != null ? `<div class="row"><span>Pending</span><b class="${s.pending ? 'warnc' : ''}">${n0(s.pending)} <span class="muted">${esc(s.pendingLabel)}</span></b></div>` : '',
      s.note ? `<div class="subs">${esc(s.note)}</div>` : '',
      s.tat != null ? `<div class="row"><span>${esc(s.tatLabel)}</span><b>${n1(s.tat)}d</b></div>` : '',
      s.target ? `<div class="row"><span>Delayed &gt; ${s.target}d</span><b class="${s.delayed ? 'bad' : 'goodc'}">${n0(s.delayed)}</b></div>` : '',
    ].join('');
    const extra = s.key === 'prod' ? `<div><span class="target">Target ${s.target} days</span></div><div class="subs">${CONFIG.PRODUCTION_SUBSTEPS.map(([a, d]) => `${a} ${d}d`).join(' · ')}</div>` : '';
    return `<div class="stage ${s.key === 'prod' ? 'focus' : ''}"><div class="name">${i + 1}. ${esc(s.label)}</div><div><span class="big">${n0(s.n)}</span><span class="pct">${pct(s.n, N)}</span></div><div class="bar"><i style="width:${w}%"></i></div>${rowsHtml}${extra}</div>`;
  }).join('');
}

export function hbars(items, { color = 'var(--brand)', clickKey } = {}) {
  const max = Math.max(1, ...items.map(i => i.n)), tot = items.reduce((s, i) => s + i.n, 0);
  return items.map(i => `<div class="hbar ${clickKey ? 'clickable' : ''}" ${clickKey ? `data-${clickKey}="${esc(i.key ?? i.label)}"` : ''} ${tip(i.tip || `${i.label}: ${i.n}`)}>
    <span class="lbl">${esc(i.label)}</span><div class="track"><div class="fill" style="width:${(i.n / max) * 100}%;background:${i.color || color}"></div></div>
    <span class="v">${n0(i.n)} <small>${pct(i.n, tot)}</small></span></div>`).join('') || '<div class="empty">Nothing to show</div>';
}

// ---- Trend: stacked columns, Online vs Store ----
const wk = d => { const t = new Date(d + 'T00:00:00Z'); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day); return t.toISOString().slice(0, 10); };
const bucketKey = (d, g) => (g === 'month' ? d.slice(0, 7) : g === 'week' ? wk(d) : d);
export function trendView(rows, grain) {
  const m = new Map();
  // Bars = distinct orders (what marketing_sale reconciles to); the tooltip adds quantity (pieces).
  const seen = { Online: new Map(), Store: new Map() };
  rows.forEach(r => {
    const k = bucketKey(r.order_date, grain), o = m.get(k) || { Online: 0, Store: 0, pcs: { Online: 0, Store: 0 } };
    const set = seen[r.mto_type].get(k) || new Set(); seen[r.mto_type].set(k, set);
    if (!set.has(r.order_id)) { set.add(r.order_id); o[r.mto_type]++; }
    o.pcs[r.mto_type] += r.qty; m.set(k, o);
  });
  let ks = [...m.keys()].sort();
  const cap = { day: 60, week: 52, month: 24 }[grain];
  const trimmed = ks.length > cap; ks = ks.slice(-cap);
  if (!ks.length) return '<div class="empty">No orders in range</div>';
  const W = 1000, H = 230, L = 36, B = 26, T = 8, bw = (W - L) / ks.length;
  const max = Math.max(...ks.map(k => m.get(k).Online + m.get(k).Store)), nice = Math.ceil(max / 4) * 4 || 4;
  const y = v => T + (H - B - T) * (1 - v / nice);
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = (nice / 4) * i; g += `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`; }
  const step = Math.ceil(ks.length / 12);
  ks.forEach((k, i) => {
    const o = m.get(k), x = L + i * bw + bw * 0.18, w = Math.max(2, bw * 0.64), hs = (H - B - T) * (o.Store / nice), ho = (H - B - T) * (o.Online / nice);
    const lab = grain === 'month' ? `${MON[+k.slice(5, 7) - 1]} ${k.slice(2, 4)}` : fmtD(k).slice(0, 6);
    g += `<g ${tip(`${grain === 'week' ? 'Week of ' : ''}${grain === 'month' ? lab : fmtD(k)} — Online ${o.Online} orders (${o.pcs.Online} pcs) · Store ${o.Store} orders (${o.pcs.Store} pcs)`)}>
      <rect x="${L + i * bw}" y="${T}" width="${bw}" height="${H - B - T}" fill="transparent"/>
      <rect x="${x}" y="${y(o.Store)}" width="${w}" height="${hs}" fill="var(--store)"/>
      <rect x="${x}" y="${y(o.Store + o.Online) }" width="${w}" height="${ho}" fill="var(--online)" rx="2" stroke="var(--card)" stroke-width="${o.Store && o.Online ? 2 : 0}"/></g>`;
    if (i % step === 0) g += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${lab}</text>`;
  });
  return `<div class="legend"><span><i style="background:var(--online)"></i>Online MTO</span><span><i style="background:var(--store)"></i>Store MTO</span>${trimmed ? `<span class="muted">showing latest ${cap} ${grain}s</span>` : ''}</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="MTO orders over time, Online and Store">${g}</svg>`;
}

export function compareView(rows) {
  return ['Online', 'Store'].map(t => {
    const x = rows.filter(r => r.mto_type === t), T = Q(x), c = f => Q(x.filter(f)), m = x.filter(r => r.order_line_mapped);
    const dl = [
      ['PO raised', `${c(r => r.t.po)} (${pct(c(r => r.t.po), T)})`], ['Production pending (at vendor)', n0(c(r => r.stage === STAGES.PRODUCTION))],
      ['GRN completed', n0(c(r => r.t.grn))], ['Tagging pending', n0(c(r => r.stage === STAGES.TAG_PENDING))], ['Invoice pending', n0(c(r => r.stage === STAGES.INV_PENDING))],
      ['Allocated from stock', n0(c(r => r.alloc_date))], ['Invoiced', n0(c(r => r.done))], ['Converted to RTS', n0(c(r => r.rtsConverted))],
      ['Delayed', `<span class="${c(r => r.status === STATUS.DELAYED) ? 'bad' : ''}">${n0(c(r => r.status === STATUS.DELAYED))}</span>`],
      ['Data mapping pending', `<span class="${T - Q(m) ? 'warnc' : ''}">${n0(T - Q(m))}</span>`],
    ];
    return `<div class="cmp" style="--c:var(--${t === 'Online' ? 'online' : 'store'})"><h3>${t} MTO</h3><div class="n">${n0(new Set(x.map(r => r.order_id)).size)}</div><div class="muted">orders · ${n0(T)} pieces (figures below are pieces)</div>
      <dl>${dl.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl></div>`;
  }).join('');
}

export function vendorView(rows, sortKey) {
  const V = rows.slice();
  const dir = { pending: -1, delayPct: -1, total: -1, avgTat: -1 }[sortKey] || -1;
  V.sort((a, b) => dir * ((a[sortKey] ?? -1) - (b[sortKey] ?? -1)) || b.total - a.total);
  const heat = (v, lo, hi) => (v == null ? '' : v >= hi ? 'background:var(--bad-bg);color:var(--bad)' : v >= lo ? 'background:var(--warn-bg);color:var(--warn)' : '');
  if (!V.length) return '<div class="empty">No vendor-mapped orders in range</div>';
  return `<table><thead><tr><th>Vendor</th><th class="num">MTO orders</th><th class="num">PO</th><th class="num">In production</th><th class="num">GRN</th><th class="num">Pending</th><th class="num">Avg TAT</th><th class="num">&gt; ${CONFIG.VENDOR_PRODUCTION_TAT} days</th><th class="num">Delay %</th></tr></thead><tbody>
    ${V.map(v => `<tr><td><b>${esc(v.vendor)}</b></td><td class="num">${n0(v.total)}</td><td class="num">${n0(v.po)}</td><td class="num">${n0(v.inProd)}</td><td class="num">${n0(v.grn)}</td><td class="num">${n0(v.pending)}</td>
      <td class="num"><span class="heat" style="${heat(v.avgTat, CONFIG.VENDOR_PRODUCTION_TAT * CONFIG.AT_RISK_RATIO, CONFIG.VENDOR_PRODUCTION_TAT)}">${v.avgTat == null ? '—' : n1(v.avgTat) + 'd'}</span></td>
      <td class="num">${n0(v.late)}</td><td class="num"><span class="heat" style="${heat(v.delayPct, 0.2, 0.5)}">${v.delayPct == null ? '—' : Math.round(v.delayPct * 100) + '%'}</span></td></tr>`).join('')}
    </tbody></table><div class="note">Vendor = vendor on the PO. Orders with no PO yet are not attributed to a vendor. Avg TAT = PO date → GRN date (elapsed days while still at vendor). Delay % = share past the ${CONFIG.VENDOR_PRODUCTION_TAT}-day target.</div>`;
}

// ---- Order table ----
export const COLUMNS = [
  { k: 'order_id', h: 'MTO Order ID', v: r => `<b>${esc(r.order_id)}</b>`, sort: r => r.order_id, csv: r => r.order_id },
  { k: 'line_id', h: 'Item Line No', v: r => esc(r.line_id), sort: r => Number(r.line_id), csv: r => r.line_id },
  { k: 'mto_type', h: 'Type', v: r => esc(r.mto_type), sort: r => r.mto_type, csv: r => r.mto_type },
  { k: 'order_date', h: 'Order Date', v: r => fmtD(r.order_date), sort: r => r.order_date, csv: r => r.order_date },
  { k: 'qty', h: 'Qty', num: 1, v: r => n0(r.qty), sort: r => r.qty, csv: r => r.qty },
  { k: 'customer', h: 'Customer', v: r => esc(r.customer || '—'), sort: r => r.customer || '', csv: r => r.customer },
  { k: 'store', h: 'Store', v: r => esc(r.store), sort: r => r.store, csv: r => r.store },
  { k: 'sku', h: 'SKU / Item', v: r => `${esc(r.sku)}`, sort: r => r.sku || '', csv: r => r.sku },
  { k: 'vendor', h: 'Vendor', v: r => (r.vendor ? esc(r.vendor) : '—'), sort: r => r.vendor, csv: r => r.vendor },
  { k: 'po_no', h: 'PO Number', v: r => esc(r.po_no || '—'), sort: r => r.po_no || '', csv: r => r.po_no },
  { k: 'po_date', h: 'PO Date', v: r => fmtD(r.po_date), sort: r => r.po_date || '', csv: r => r.po_date },
  { k: 'grn_date', h: 'GRN Date', v: r => fmtD(r.grn_date), sort: r => r.grn_date || '', csv: r => r.grn_date },
  { k: 'apu_date', h: 'APU Date', v: r => fmtD(r.apu_date), sort: r => r.apu_date || '', csv: r => r.apu_date },
  { k: 'inwardDate', h: 'Inward Date', v: r => fmtD(r.inwardDate), sort: r => r.inwardDate || '', csv: r => r.inwardDate },
  { k: 'inwardSrc', h: 'Inward Source', v: r => esc(r.inwardSrc || '—'), sort: r => r.inwardSrc || '', csv: r => r.inwardSrc },
  { k: 'tag_date', h: 'Tagging Date', v: r => fmtD(r.tag_date), sort: r => r.tag_date || '', csv: r => r.tag_date },
  { k: 'alloc_date', h: 'Allocated Date', v: r => fmtD(r.alloc_date), sort: r => r.alloc_date || '', csv: r => r.alloc_date },
  { k: 'inv_date', h: 'Invoice Date', v: r => fmtD(r.inv_date), sort: r => r.inv_date || '', csv: r => r.inv_date },
  { k: 'inv_channel', h: 'Invoice Channel', v: r => esc(r.inv_channel || '—'), sort: r => r.inv_channel || '', csv: r => r.inv_channel },
  { k: 'rts_date', h: 'RTS Sale Date', v: r => fmtD(r.rtsDate), sort: r => r.rtsDate || '', csv: r => r.rtsDate },
  { k: 'stage', h: 'Current Stage', v: r => badge(r.stage, stageClass(r.stage)), sort: r => r.stage, csv: r => r.stage },
  { k: 'stageAge', h: 'Stage Age', num: 1, v: r => days(r.stageAge), sort: r => r.stageAge ?? -1, csv: r => r.stageAge },
  { k: 'overallAge', h: 'Order Age', num: 1, v: r => days(r.overallAge), sort: r => r.overallAge ?? -1, csv: r => r.overallAge },
  { k: 'poToGrn', h: 'Production TAT', num: 1, v: r => (r.prodDays == null ? '—' : `${r.prodDays}d${r.t.grn ? '' : '*'}`), sort: r => r.prodDays ?? -1, csv: r => r.prodDays },
  { k: 'target', h: 'Target', num: 1, v: r => (r.t.po ? `${CONFIG.VENDOR_PRODUCTION_TAT}d / ${CONFIG.OVERALL_MTO_TAT}d` : `${CONFIG.OVERALL_MTO_TAT}d`), sort: () => 0, csv: () => `${CONFIG.VENDOR_PRODUCTION_TAT}/${CONFIG.OVERALL_MTO_TAT}` },
  { k: 'delayDays', h: 'Delay', num: 1, v: r => (r.delayDays == null ? '—' : r.delayDays ? `<span class="bad">+${r.delayDays}d</span>` : '0'), sort: r => r.delayDays ?? -1, csv: r => r.delayDays },
  { k: 'status', h: 'Status', v: r => badge(r.status, statusClass(r.status)), sort: r => r.status, csv: r => r.status },
];
export const DEFAULT_COLS = ['order_id', 'line_id', 'mto_type', 'order_date', 'qty', 'customer', 'vendor', 'po_no', 'po_date', 'inwardDate', 'inwardSrc', 'stage', 'stageAge', 'overallAge', 'poToGrn', 'delayDays', 'status'];

export function tableView(pageRows, cols, sort) {
  if (!pageRows.length) return '<div class="empty">No orders match these filters</div>';
  const C = COLUMNS.filter(c => cols.includes(c.k));
  return `<table><thead><tr>${C.map(c => `<th class="${c.num ? 'num' : ''}" data-sort="${c.k}">${c.h}${sort.key === c.k ? `<span class="arr"> ${sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead>
    <tbody>${pageRows.map(r => `<tr class="click" data-line="${esc(r.line_id)}">${C.map(c => `<td class="${c.num ? 'num' : ''}">${c.v(r)}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <div class="note">* still at vendor — elapsed days since PO. Qty = pieces. Click any row for its journey.</div>`;
}

export function csv(rows, cols) {
  const C = COLUMNS.filter(c => cols.includes(c.k)), q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [C.map(c => q(c.h)).join(','), ...rows.map(r => C.map(c => q(c.csv(r))).join(','))].join('\n');
}

// ---- Order drawer ----
export function drawerView(r) {
  const T = CONFIG.VENDOR_PRODUCTION_TAT, O = CONFIG.OVERALL_MTO_TAT;
  const unm = !r.order_line_mapped;
  const st = (label, date, detail, state) => ({ label, date, detail, state });
  const cur = r.stage;
  const steps = [
    st('MTO order', r.order_date, r.order_id, 'done'),
    st('PO raised', r.po_date, r.po_no ? `${r.po_no}${r.po_count > 1 ? ` · ${r.po_count} POs raised` : ''}${r.orderToPo != null ? ` · ${r.orderToPo}d after order` : ''}` : (unm ? 'Not traceable' : ''), r.t.po ? 'done' : cur === STAGES.PO_PENDING ? 'cur' : 'todo'),
    st('Vendor production / QC', r.grn_date, r.t.po ? (r.t.grn ? `${r.poToGrn}d vs ${T}d target${r.poToGrn > T ? ` · <b class="bad">+${r.poToGrn - T}d late</b>` : ' · <b class="goodc">on target</b>'}`
      : `${r.prodDays}d elapsed of ${T}d target · ${r.prodDays > T ? `<b class="bad">${r.prodDays - T}d over</b>` : `${T - r.prodDays}d remaining`}`) : '', r.t.grn ? 'done' : cur === STAGES.PRODUCTION ? (r.prodLate ? 'bad' : 'cur') : 'todo'),
    st('GRN / inward', r.inwardDate, r.inwardDate ? `${r.inwardNo} (${r.inwardSrc})` + [r.grn_no && r.inwardSrc !== 'GRN' ? ` · GRN ${r.grn_no} ${fmtD(r.grn_date)}` : '', r.apu_no && r.inwardSrc !== 'APU' ? ` · APU ${r.apu_no} ${fmtD(r.apu_date)}` : '', r.cin_no && r.inwardSrc !== 'Consignment-in' ? ` · consignment-in ${r.cin_no} ${fmtD(r.cin_date)}` : ''].join('') : '', r.t.grn ? 'done' : 'todo'),
    st('Tagging', r.tag_date, r.t.tag ? `${r.tag_no} · ${r.grnToTag}d after GRN` : (cur === STAGES.TAG_PENDING ? `${r.stageAge}d waiting (no target defined)` : ''), r.t.tag ? 'done' : cur === STAGES.TAG_PENDING ? 'cur' : 'todo'),
    st('Allocated from stock', r.alloc_date, r.alloc_doc ? `${r.alloc_doc} · stock piece ${r.alloc_piece_sku || ''} (its own line ${r.alloc_piece_line})` : '', r.alloc_date ? (cur === STAGES.ALLOC ? 'cur' : 'done') : 'todo'),
    st('Converted to RTS', r.rtsDate, r.t.rts ? `${r.rtsDoc} · invoiced to a DIFFERENT customer${r.rtsBuyer ? ' (' + r.rtsBuyer + ')' : ''} · ${Math.round((r.t.rts - r.t.order) / 864e5)}d after the MTO order. The original customer's order needs review.` : '', r.t.rts ? 'bad' : 'todo'),
    st('Invoice', r.inv_date, r.done ? `${r.inv_no} (${r.inv_channel || 'invoice'}) · to ${r.customer || 'the customer'} · matched by item line number${r.tagToInv != null ? ` · ${r.tagToInv}d after tagging` : ''}` : (cur === STAGES.INV_PENDING ? `${r.stageAge}d waiting (no target defined)` : ''), r.done ? 'done' : cur === STAGES.INV_PENDING ? 'cur' : 'todo'),
  ];
  const mark = s => (s === 'done' ? '✓' : s === 'cur' ? '●' : s === 'bad' ? '!' : '–');
  return `<button class="btn close" data-close>Close</button>
    <div class="eyebrow">${esc(r.mto_type)} MTO · item ${esc(r.line_id)} · qty ${r.qty}</div><h3>${esc(r.order_id)}</h3>
    <div>${badge(r.stage, stageClass(r.stage))} ${badge(r.status, statusClass(r.status))}</div>
    <dl class="facts"><dt>Customer</dt><dd>${esc(r.customer || '—')}</dd><dt>Store</dt><dd>${esc(r.store)}</dd><dt>Item</dt><dd>${esc(r.product || '')}<br><span class="muted">${esc(r.sku || '')}</span></dd>
      <dt>Vendor</dt><dd>${r.vendor ? esc(r.vendor) : '<span class="muted">— (no PO raised yet)</span>'}</dd>
      <dt>Order age</dt><dd>${days(r.overallAge)} <span class="muted">of ${O}d target${r.delayDays ? ` · <b class="bad">+${r.delayDays}d</b>` : ''}</span></dd></dl>
    ${unm ? `<div class="note" style="margin:-8px 0 16px"><b>Data Mapping Pending.</b> This order line has no matching row in the ERP order table, so PO, GRN, tagging and invoice cannot be traced for it. Nothing is assumed.</div>` : ''}
    <ul class="tl">${steps.map(s => `<li class="${s.state}"><div class="mk">${mark(s.state)}</div><div><b>${s.label}</b><span>${s.date ? fmtD(s.date) : s.state === 'cur' || s.state === 'bad' ? 'In progress' : 'Not reached'}</span><span>${s.detail || ''}</span></div></li>`).join('')}</ul>`;
}

// Live check on inward evidence: pieces already tagged / invoiced with no inward record at all, and ordering anomalies.
export function coverageWarn(rows) {
  const recv = rows.filter(r => r.tag_no || r.inv_no), noInw = recv.filter(r => !r.inwardDate && !r.alloc_date); // allocated-from-stock pieces need no inward
  if (!Q(recv)) return '';
  const early = Q(rows.filter(r => r.inwardDate && ((r.tag_date && r.tag_date < r.inwardDate) || (r.inv_date && r.inv_date < r.inwardDate))));
  const lag = Q(rows.filter(r => r.grn_date && r.apu_date && r.apu_date < r.grn_date));
  const note = CONFIG.INWARD_DATE_RULE === 'earliest' ? 'Inward = earliest of GRN, APU and store consignment-in.' : 'Inward = GRN, else APU, else consignment-in.';
  return `<div class="warnbox"><b>Inward is read from GRN, APU and store consignment-in.</b> ${note} ${n0(lag)} pieces have an APU earlier than their GRN (the GRN is posted later), ${n0(Q(noInw))} tagged or invoiced pieces still have no inward record or stock allocation, and ${n0(early)} were tagged or invoiced before their inward date.</div>`;
}

// Short, plain-language explanation of how every number is built. Values come from CONFIG so it never goes stale.
export function logicView(snapAt, source) {
  const T = CONFIG.VENDOR_PRODUCTION_TAT, O = CONFIG.OVERALL_MTO_TAT, risk = Math.round(CONFIG.AT_RISK_RATIO * 100);
  const rule = CONFIG.INWARD_DATE_RULE === 'earliest' ? 'the earliest of the three dates' : 'the GRN date, else APU, else consignment-in';
  const step = (n, name, src, date) => `<tr><td class="num"><b>${n}</b></td><td><b>${name}</b></td><td>${src}</td><td>${date}</td></tr>`;
  return `<div class="card-h"><h2>How this dashboard works</h2><span class="muted">Short version</span></div>

  <h3>1. What is counted</h3>
  <ul>
    <li>Each row is one <b>item</b> ordered as MTO in <code>marketing_sale</code> (Online MTO or Store MTO).</li>
    <li><b>Orders</b> = distinct order numbers. Every other number is <b>pieces</b> (quantity).</li>
  </ul>

  <h3>2. The journey and where each step comes from</h3>
  <div class="scroll"><table class="logic-table"><thead><tr><th></th><th>Step</th><th>Taken from</th><th>Date used</th></tr></thead><tbody>
    ${step(1, 'Order placed', 'marketing_sale', 'order date')}
    ${step(2, 'PO raised', 'purchase.order', 'first PO date (vendor = latest PO)')}
    ${step(3, 'Vendor production / QC', 'time between PO and inward', '—')}
    ${step(4, 'Inward', 'GRN (purchase.invoice), APU (purchase.consignment), store consignment-in', rule)}
    ${step(5, 'Tagging', 'Lucira_Prod.tagging', 'tagging date')}
    ${step('5b', 'Allocated from stock', 'Lucira_Prod.stock_allocation (+ stock_allocated_items for the stock piece)', 'allocation date')}
    ${step(6, 'Invoiced', 'ornaverse_erp_pos.invoice (POS) and MarketPlace.invoice (online), to the customer who ordered', 'invoice date')}
    ${step(7, 'Converted to RTS', 'same invoice table, but billed to a different customer', 'invoice date')}
  </tbody></table></div>
  <p class="logic-note">Every step is matched with the <b>item line number</b>. Cancelled documents (status 2) and anything dated before the order are ignored.</p>

  <h3>3. Current stage = the last step confirmed</h3>
  <ul>
    <li><b>Invoiced / Completed</b>: invoice found for the ordering customer.</li>
    <li><b>Invoice Pending</b>: tagged, no invoice. <b>Tagging Pending</b>: inwarded, not tagged.</li>
    <li><b>Allocated from Stock</b>: a piece from existing stock was allocated to the order, so no vendor PO is needed; waiting for the invoice.</li>
    <li><b>Vendor Production / QC</b>: PO raised, not inwarded yet. <b>PO Pending</b>: no PO yet.</li>
    <li><b>Converted to RTS</b>: invoiced to someone else, so the original order needs a review.</li>
    <li><b>Data Mapping Pending</b>: older Online order where nothing could be linked (see section 5).</li>
  </ul>

  <h3>4. Targets and status</h3>
  <ul>
    <li><b>Vendor production target: ${T} days</b> (PO to inward). Shown as sub-steps only: ${CONFIG.PRODUCTION_SUBSTEPS.map(([n, d]) => n + ' ' + d + 'd').join(', ')}.</li>
    <li><b>Overall target: ${O} days</b> (order to invoice).</li>
    <li><b>Delayed</b> = over a target. <b>At Risk</b> = ${risk}% or more of a target used. <b>On Track</b> = otherwise. <b>Completed</b> = invoiced. <b>Needs Review</b> = converted to RTS.</li>
  </ul>

  <h3>5. Good to know</h3>
  <ul>
    <li><b>Old Online orders:</b> Online POs only link reliably from <b>${CONFIG.ONLINE_PO_LINK_FROM || 'n/a'}</b>. Older Online orders with nothing found show as Data Mapping Pending, not delayed.</li>
    <li><b>Vendor:</b> taken from the PO only (the latest PO if there is more than one). It stays blank until a PO is raised.</li>
    <li><b>GRN is booked late:</b> the APU is usually earlier than the GRN, so inward uses ${rule}.</li>
    <li><b>Item line number changes on allocation:</b> the allocation gives the order's line number and the stock piece's own (old) line number, joined on transaction item id. Invoices are also looked up on the piece's old line number and SKU. An invoice must be dated on or after the allocation: earlier invoices of the same piece belong to its previous sale. Today this finds no extra invoices.</li>
    <li>The journey is not a strict funnel: an invoiced item counts as Invoiced even if an earlier step was not recorded against its line number.</li>
  </ul>

  <h3>6. Changing a rule</h3>
  <p>Targets, the Online cut-off date and the inward rule are in one place: <code>config.js</code>.</p>
  <div class="note">Data source: ${source === 'live' ? 'live BigQuery query' : 'saved snapshot (live query unavailable)'} · built ${esc(snapAt)}</div>`;
}

// ---- KPI popup: list of the items behind a card ----
const POPUP_COLS = ['order_id', 'line_id', 'mto_type', 'order_date', 'qty', 'customer', 'vendor', 'stage', 'overallAge', 'status'];
// one extra date column that matches what the card counts
const POPUP_EXTRA = { po: ['po_date'], prod: ['po_date'], tat: ['po_date', 'poToGrn'], grn: ['inwardDate', 'inwardSrc'], tagpend: ['inwardDate'], invpend: ['tag_date'],
  alloc: ['alloc_date'], invoiced: ['inv_date'], rts: ['rts_date'], delayed: ['po_date', 'inwardDate'] };
export function popupCols(key) { return POPUP_COLS.concat(POPUP_EXTRA[key] || []); }
export function popupRows(rows, key, q) {
  const def = KPI_DEFS[key]; if (!def) return [];
  let x = rows.filter(def.test);
  if (q) { const s = q.toLowerCase(); x = x.filter(r => r.search.includes(s)); }
  const k = def.sort;
  return x.sort((a, b) => (k ? (b[k] ?? -1) - (a[k] ?? -1) : (b.delayDays ?? -1) - (a.delayDays ?? -1) || (b.overallAge ?? -1) - (a.overallAge ?? -1)));
}
export function popupView(key, all, limit) {
  const C = COLUMNS.filter(c => popupCols(key).includes(c.k));
  const shown = all.slice(0, limit), orders = new Set(all.map(r => r.order_id)).size;
  const head = `<div class="muted" style="margin:0 0 8px">${KPI_DEFS[key].allDates ? 'Ignores the date and other filters. ' : ''}${n0(all.length)} items · ${n0(Q(all))} pieces · ${n0(orders)} orders. Each row is one item; an order can have several. Click a row for its journey.</div>`;
  if (!all.length) return head + '<div class="empty">Nothing in this group</div>';
  return head + `<div class="scroll"><table><thead><tr>${C.map(c => `<th class="${c.num ? 'num' : ''}" style="cursor:default">${c.h}</th>`).join('')}</tr></thead>
    <tbody>${shown.map(r => `<tr class="click" data-line="${esc(r.line_id)}">${C.map(c => `<td class="${c.num ? 'num' : ''}">${c.v(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${all.length > limit ? `<div class="pager"><span>Showing ${n0(limit)} of ${n0(all.length)}</span><button class="btn" data-more>Show ${n0(Math.min(200, all.length - limit))} more</button></div>` : ''}`;
}
