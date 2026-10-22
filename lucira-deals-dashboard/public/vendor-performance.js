(function () {
'use strict';

/* Simple vendor dashboard.
   One logic: for every purchase line (purchase.invoice_items) we attach the sales of
   the same item_line_no (marketing_sale) and compare bought vs sold.
   Sell-through % = Qty sold / Qty purchased x 100
   Purchased, not sold = sum of max(purchased - sold, 0) per line (NOT current stock). */

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BLANK = '(blank)';

function inr(n) {
  if (n == null || !isFinite(n)) return '–';
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(1) + ' L';
  if (a >= 1e3) return s + '₹' + (a / 1e3).toFixed(1) + ' K';
  return s + '₹' + Math.round(a);
}
const inrFull = n => (n == null || !isFinite(n)) ? '–' : '₹' + Math.round(n).toLocaleString('en-IN');
const int = n => (n == null || !isFinite(n)) ? '–' : Math.round(n).toLocaleString('en-IN');
const pc = n => (n == null || !isFinite(n)) ? '–' : n.toFixed(1) + '%';
const money = n => `<span title="${esc(inrFull(n))}">${inr(n)}</span>`;
const fv = (r, f) => (r[f] == null || r[f] === '') ? BLANK : r[f];

const S = { data: null, f: { v: new Set(), cat: new Set(), kt: new Set(), mt: new Set(), from: '', to: '' }, sort: {}, mv: '', mq: '', mst: new Set() };
let chartInst = null;

function rows() {
  const f = S.f;
  return S.data.lines.filter(r =>
    (!f.v.size || f.v.has(fv(r, 'v'))) && (!f.cat.size || f.cat.has(fv(r, 'cat'))) && (!f.kt.size || f.kt.has(fv(r, 'kt'))) &&
    (!f.mt.size || f.mt.has(fv(r, 'mt'))) && (!f.from || r.d >= f.from) && (!f.to || r.d <= f.to));
}

function agg(rs, keyFn) {
  const m = new Map();
  for (const r of rs) {
    const k = keyFn(r);
    let o = m.get(k);
    if (!o) { o = { k, q: 0, a: 0, sq: 0, sv: 0, rq: 0, un: 0, cats: new Set() }; m.set(k, o); }
    o.q += r.q; o.a += r.a; o.sq += r.sq; o.sv += r.sv; o.rq += r.crq;
    o.un += Math.max(r.q - r.sq, 0);
    o.cats.add(fv(r, 'cat'));
  }
  return [...m.values()].map(o => {
    o.st = o.q > 0 ? o.sq / o.q * 100 : null;
    o.asp = o.sq > 0 ? o.sv / o.sq : null;
    return o;
  });
}

const stCell = v => v == null ? '–' : `<span class="st-cell" style="background:rgba(79,122,85,${(0.05 + 0.4 * Math.min(v, 100) / 100).toFixed(2)})">${pc(v)}</span>`;

function kpi(label, value, def, sub, hero) {
  return `<div class="kpi ${hero ? 'hero' : ''}" title="${esc(def)}"><span class="kpi-l">${label}</span><span class="kpi-v">${value}</span><span class="kpi-d">${sub || ''}</span></div>`;
}

/* Sortable table. cols: [key, label, isNumeric] */
function table(id, list, cols, { clickable = false, selKey = null, max = 480 } = {}) {
  const st = S.sort[id] || (S.sort[id] = { k: 'a', dir: -1 });
  const sorted = list.slice().sort((a, b) => {
    const x = a[st.k], y = b[st.k];
    if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * st.dir;
  });
  const maxUn = Math.max(0, ...list.map(o => o.un));
  const head = cols.map(c => `<th data-t="${id}" data-k="${c[0]}" class="${c[2] ? 'num ' : ''}${st.k === c[0] ? (st.dir > 0 ? 'asc' : 'desc') : ''}">${c[1]}</th>`).join('');
  const body = sorted.map(o => `<tr ${clickable ? `class="clk ${selKey === o.k ? 'sel' : ''}" data-pick="${esc(o.k)}"` : ''}>${cols.map(c => {
    let h;
    if (c[0] === 'un') h = `<div class="cell-bar"><i style="width:${maxUn ? o.un / maxUn * 100 : 0}%"></i><span style="position:relative">${int(o.un)}</span></div>`;
    else if (c[0] === 'st') h = stCell(o.st);
    else if (c[0] === 'a' || c[0] === 'sv' || c[0] === 'asp') h = o[c[0]] == null ? '–' : money(o[c[0]]);
    else if (c[0] === 'av') h = o.ag == null ? esc(o.av) : `<span title="${esc(o.agFrom)}">${esc(o.av)} (${int(o.ag)})</span>`;
    else if (c[0] === 'q' || c[0] === 'sq' || c[0] === 'rq') h = int(o[c[0]]);
    else h = esc(o[c[0]]);
    return `<td class="${c[2] ? 'num' : 'lead'}">${h}</td>`;
  }).join('')}</tr>`).join('');
  const t = list.reduce((s, o) => { s.q += o.q; s.a += o.a; s.sq += o.sq; s.sv += o.sv; s.rq += o.rq; s.un += o.un; return s; }, { q: 0, a: 0, sq: 0, sv: 0, rq: 0, un: 0 });
  const foot = `<tr class="tot"><td>Total</td>${cols.slice(1).map(c => `<td class="num">${
    c[0] === 'q' || c[0] === 'sq' || c[0] === 'rq' || c[0] === 'un' ? int(t[c[0]]) : c[0] === 'a' || c[0] === 'sv' ? money(t[c[0]]) : c[0] === 'st' ? pc(t.q ? t.sq / t.q * 100 : null) : c[0] === 'asp' ? (t.sq ? money(t.sv / t.sq) : '–') : ''}</td>`).join('')}</tr>`;
  return `<div class="tbl-wrap" style="max-height:${max}px"><table class="t sticky1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`;
}

const COLS = label => [
  ['k', label], ['q', 'Qty purchased', 1], ['a', 'Purchase value', 1], ['sq', 'Qty sold', 1], ['sv', 'Sales value', 1], ['rq', 'Return', 1],
  ['un', 'Purchased, not sold', 1], ['asp', 'Avg selling price', 1],
];

function render() {
  const rs = rows();
  { const n = rs.filter(isNotFound); $('nfBtn').innerHTML = `Not found at store <b>${int(n.reduce((t, r) => t + Math.max(r.q - r.sq, 0), 0))}</b>`; }
  $('scope').textContent = `${int(rs.length)} of ${int(S.data.lines.length)} purchase lines`;
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  if (!rs.length) { $('body').innerHTML = '<div class="card"><p class="empty">No purchase lines match these filters.</p></div>'; return; }

  const tot = agg(rs, () => 'all')[0];
  const nf = rs.filter(isNotFound);
  const nfQty = nf.reduce((t, r) => t + Math.max(r.q - r.sq, 0), 0), nfVal = nf.reduce((t, r) => t + r.a, 0);
  const vendors = agg(rs, r => r.v);
  const unm = S.data.unmatchedSales.reduce((s, r) => s + r.val, 0);
  const unmPct = S.data.salesTotals.val ? unm / S.data.salesTotals.val * 100 : 0;
  const byA = vendors.slice().sort((a, b) => b.a - a.a);

  $('body').innerHTML = `
    <div class="kpis k4">
      ${kpi('Vendors', int(vendors.length), 'Vendors with purchases in the current filter')}
      ${kpi('Qty purchased', int(tot.q), 'Pieces on non-cancelled purchase invoice lines')}
      ${kpi('Purchase value', money(tot.a), 'Sum of net_amount on purchase invoice lines', inrFull(tot.a))}
      ${kpi('Qty sold', int(tot.sq), 'marketing_sale pieces for the same item_line_no as the purchased lines')}
      ${kpi('Sales value', money(tot.sv), 'marketing_sale net_sale for the same item_line_no', inrFull(tot.sv))}
      ${kpi('Return', int(tot.rq), 'Pieces sold and then returned by the customer (POS Return / e-commerce return). Not counted in Qty sold; they show under Purchased, not sold.', 'customer returns')}
      <div class="kpi clk" data-nf="1" title="Bought, not sold, and not found in any store (Live_inventory). Click to see the list of SKUs."><span class="kpi-l">Not found at store</span><span class="kpi-v">${int(nfQty)}</span><span class="kpi-d">${int(nf.length)} SKUs · ${inr(nfVal)} · click to open</span></div>
      ${kpi('Purchased, not sold', int(tot.un), 'Sum of max(purchased - sold, 0) per line. NOT current stock - there is no reliable current-stock source in this data.', 'qty · not current stock')}
    </div>
    <p class="note" style="margin:6px 0 14px">Sales = lifetime sales of the purchased lines. ${inr(unm)} (${unmPct.toFixed(0)}%) of all sales value has no purchase invoice line and is not included here.</p>

    <section class="card wide"><header><h3>Purchase value vs sales value, by vendor</h3></header>
      <div class="chart-h" style="height:${Math.max(240, byA.length * 26 + 70)}px"><canvas id="ch"></canvas></div></section>

    <section class="card wide"><header><h3>Vendors</h3><p>Click a header to sort. Click a vendor name to see its products.</p></header>
      ${table('v', vendors.map(o => Object.assign(o, { cs: [...o.cats].slice(0, 3).join(', ') })), COLS('Vendor').concat([['cs', 'Main categories']]), { clickable: true, max: 560 })}</section>

    <div class="grid g1">
      <section class="card"><header><h3>By category</h3></header>${table('cat', agg(rs, r => fv(r, 'cat')), COLS('Category'), { max: 420 })}</section>
      <section class="card"><header><h3>By karat</h3></header>${table('kt', agg(rs, r => fv(r, 'kt')), COLS('Karat'), { max: 420 })}</section>
      <section class="card"><header><h3>By metal</h3></header>${table('mt', agg(rs, r => fv(r, 'mt')), COLS('Metal'), { max: 420 })}</section>
    </div>`;

  if (typeof Chart !== 'undefined') {
    const cs = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const txt = cs('--text-2'), grid = cs('--border');
    chartInst = new Chart($('ch'), {
      type: 'bar',
      data: { labels: byA.map(o => o.k), datasets: [
        { label: 'Purchase value', data: byA.map(o => o.a), backgroundColor: cs('--c1') },
        { label: 'Sales value', data: byA.map(o => o.sv), backgroundColor: cs('--c2') }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { labels: { color: txt, boxWidth: 12 } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${inrFull(c.parsed.x)}` } } },
        scales: { x: { ticks: { color: txt, callback: v => inr(v) }, grid: { color: grid } }, y: { ticks: { color: txt }, grid: { display: false } } } },
    });
  }
}

function sortClick(th) {
  const st = S.sort[th.dataset.t];
  if (st.k === th.dataset.k) st.dir = -st.dir; else { st.k = th.dataset.k; st.dir = ['k', 'sku', 'cat', 'kt', 'mt', 'doc', 'bill', 'line', 'd'].includes(th.dataset.k) ? 1 : -1; }
}

/* Product list for one vendor — only shown in a pop-up when a vendor is clicked. */
function openVendor(name) {
  S.mode = 'vendor'; S.mv = name; S.mq = ''; S.mst = new Set();
  let m = $('vmodal');
  if (!m) { m = document.createElement('div'); m.id = 'vmodal'; m.className = 'modal'; document.body.appendChild(m); }
  m.innerHTML = `<div class="modal-card"><button class="modal-x" type="button" title="Close">✕</button>
    <h2>${esc(name)}</h2><p class="muted" id="mSub"></p>
    <div class="tbl-bar"><input id="mQ" class="tq" type="search" placeholder="Search SKU, product, GRN, bill no, line no…">
      <details class="ms" id="mStore"><summary><span class="ms-t">All stores</span><b class="ms-n"></b></summary><div class="ms-panel" id="mStorePanel"></div></details></div>
    <div id="mTable"></div></div>`;
  document.body.classList.add('modal-open');
  buildStorePanel();
  drawProducts();
}
/* Where a purchase line is now: the store/location from Live_inventory; an unsold piece that is in no store
   is "Not found"; a sold piece is just "–". */
/* Bought, not sold, and in no store (not in Live_inventory). Duplicate invoice rows are ignored. */
const isNotFound = r => !r.av && !r.dup && Math.max(r.q - r.sq, 0) > 0;
const storeOf = r => r.av || (isNotFound(r) ? 'Not found' : '–');
const storeLabel = v => v === '–' ? 'Sold (not in stock)' : v;
function buildStorePanel() {
  const vals = [...new Set(rows().filter(r => r.v === S.mv).map(storeOf))].sort((a, b) => a.localeCompare(b));
  $('mStorePanel').innerHTML = `<input type="search" class="ms-q" id="mStoreQ" placeholder="Search store…">
    <div class="ms-actions"><button type="button" data-sa="all">Select all</button> <button type="button" data-sa="clear">Clear</button></div>` +
    vals.map(v => `<label data-n="${esc(storeLabel(v).toLowerCase())}"><input type="checkbox" value="${esc(v)}"> ${esc(storeLabel(v))}</label>`).join('');
  storeSummary();
}
function storeSummary() {
  const n = S.mst.size;
  $('mStore').querySelector('.ms-t').textContent = n === 0 ? 'All stores' : n === 1 ? storeLabel([...S.mst][0]) : n + ' stores selected';
  $('mStore').querySelector('.ms-n').textContent = n > 1 ? n : '';
  $('mStore').classList.toggle('on', n > 0);
}
/* Pop-up: every SKU that is bought, not sold and not in any store (honours the page filters). */
function openNotFound() {
  S.mode = 'nf'; S.mq = '';
  let m = $('vmodal');
  if (!m) { m = document.createElement('div'); m.id = 'vmodal'; m.className = 'modal'; document.body.appendChild(m); }
  m.innerHTML = `<div class="modal-card"><button class="modal-x" type="button" title="Close">✕</button>
    <h2>Not found at store</h2><p class="muted" id="mSub"></p>
    <div class="tbl-bar"><input id="mQ" class="tq" type="search" placeholder="Search vendor, SKU, product, GRN, bill no, line no…">
      <button id="nfExport" class="btn sm" type="button">Export CSV</button></div>
    <div id="mTable"></div></div>`;
  document.body.classList.add('modal-open');
  drawNotFound();
}
function nfList() {
  let list = rows().filter(isNotFound).map(r => ({
    v: r.v || '–', sku: r.sku || '–', k: r.t || ('line ' + r.id), cat: fv(r, 'cat'), kt: fv(r, 'kt'), mt: fv(r, 'mt'),
    doc: r.doc || '–', bill: r.bill || '–', line: r.id, d: r.d, q: r.q, a: r.a, sq: r.sq, un: Math.max(r.q - r.sq, 0) }));
  const qs = (S.mq || '').trim().toLowerCase();
  if (qs) list = list.filter(o => [o.v, o.sku, o.k, o.cat, o.kt, o.mt, o.doc, o.bill, o.line].join(' ').toLowerCase().includes(qs));
  return list;
}
const NF_COLS = [['v', 'Vendor'], ['sku', 'SKU'], ['k', 'Product'], ['cat', 'Category'], ['kt', 'Karat'], ['mt', 'Metal'],
  ['doc', 'Document no (GRN)'], ['bill', 'Vendor bill no'], ['line', 'Item line no'], ['d', 'Purchase date'],
  ['q', 'Qty purchased', 1], ['a', 'Purchase value', 1], ['sq', 'Qty sold', 1], ['un', 'Purchased, not sold', 1]];
function drawNotFound(keepFocus) {
  if (!$('vmodal')) return;
  const list = nfList();
  const t = list.reduce((s, o) => ({ q: s.q + o.q, a: s.a + o.a }), { q: 0, a: 0 });
  $('mSub').textContent = `${int(list.length)} SKUs · ${int(t.q)} pcs · ${inr(t.a)} purchase value · bought, not sold, and not found in any store (current filters applied)`;
  $('mTable').innerHTML = table('nf', list, NF_COLS, { max: 520 });
  if (keepFocus) { const el = $('mQ'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}
function exportNotFound() {
  const list = nfList();
  const cell = v => { const x = v == null ? '' : String(v); return /[",\r\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
  const head = NF_COLS.map(c => c[1]);
  const csv = [head].concat(list.map(o => NF_COLS.map(c => o[c[0]]))).map(r => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'not-found-at-store-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function closeVendor() {
  const m = $('vmodal'); if (m) m.remove();
  document.body.classList.remove('modal-open');
}
function drawProducts(keepFocus) {
  if (!$('vmodal')) return;
  if (S.mode === 'nf') return drawNotFound(keepFocus);
  const rs = rows().filter(r => r.v === S.mv);
  // One row per purchase line, so GRN / bill / item_line_no are exact for each row.
  let list = rs.map(r => {
    const q = r.q, un = Math.max(r.q - r.sq, 0);
    return { sku: r.sku || '–', k: r.t || ('line ' + r.id), cat: fv(r, 'cat'), kt: fv(r, 'kt'), mt: fv(r, 'mt'),
      doc: r.doc || '–', bill: r.bill || '–', line: r.id, d: r.d,
      q, a: r.a, sq: r.sq, sv: r.sv, rq: r.crq, av: storeOf(r), agFrom: r.av === 'Head Office' ? (r.d ? 'GRN ' + r.d : null) : (r.tdt ? 'Transferred ' + r.tdt : null),
      ag: (d => d ? Math.max(0, Math.floor((Date.now() - Date.parse(d + 'T00:00:00+05:30')) / 864e5)) : null)(r.av === 'Head Office' ? r.d : r.tdt), un, st: q > 0 ? r.sq / q * 100 : null };
  });
  if (S.mst.size) list = list.filter(o => S.mst.has(o.av));
  const qs = (S.mq || '').trim().toLowerCase();
  if (qs) list = list.filter(o => [o.sku, o.k, o.cat, o.kt, o.mt, o.doc, o.bill, o.line, o.av].join(' ').toLowerCase().includes(qs));
  const tot = list.reduce((s, o) => ({ q: s.q + o.q, sq: s.sq + o.sq }), { q: 0, sq: 0 });
  $('mSub').textContent = `${int(list.length)} purchase lines · ${int(tot.q)} pcs purchased · ${int(tot.sq)} sold (current filters applied)`;
  const cols = [['sku', 'SKU'], ['k', 'Product'], ['cat', 'Category'], ['kt', 'Karat'], ['mt', 'Metal'],
    ['doc', 'Document no (GRN)'], ['bill', 'Vendor bill no'], ['line', 'Item line no'], ['d', 'Purchase date'],
    ['q', 'Qty purchased', 1], ['a', 'Purchase value', 1], ['sq', 'Qty sold', 1], ['sv', 'Sales value', 1], ['rq', 'Return', 1], ['un', 'Purchased, not sold', 1], ['av', 'Available at (ageing days)']];
  $('mTable').innerHTML = table('prod', list, cols, { max: 520 });
  if (keepFocus) { const el = $('mQ'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

/* Filters Vendor / Category / Karat / Metal: checkbox dropdowns, any number of values can be ticked. */
const MS = { v: ['vendors', 'vendor'], cat: ['categories', 'category'], kt: ['karats', 'karat'], mt: ['metals', 'metal'] };
const msEl = k => document.querySelector(`details[data-ms="${k}"]`);
function msSummary(k) {
  const n = S.f[k].size, el = msEl(k);
  el.querySelector('.ms-t').textContent = n === 0 ? 'All ' + MS[k][0] : n === 1 ? [...S.f[k]][0] : n + ' ' + MS[k][0] + ' selected';
  el.querySelector('.ms-n').textContent = n > 1 ? n : '';
  el.classList.toggle('on', n > 0);
}
function msBuild(k, values) {
  msEl(k).querySelector('.ms-panel').innerHTML =
    `<input type="search" class="ms-q" placeholder="Search ${MS[k][1]}…">
    <div class="ms-actions"><button type="button" data-a="all">Select all</button> <button type="button" data-a="clear">Clear</button></div>` +
    values.map(v => `<label data-n="${esc(v.toLowerCase())}"><input type="checkbox" value="${esc(v)}" ${S.f[k].has(v) ? 'checked' : ''}> ${esc(v)}</label>`).join('');
  msSummary(k);
}
function buildFilters() {
  const L = S.data.lines;
  const uniq = f => [...new Set(L.map(r => fv(r, f)))].sort((a, b) => a.localeCompare(b));
  for (const k of Object.keys(MS)) msBuild(k, uniq(k));
}

function wire() {
  const bind = (id, key) => $(id).addEventListener('change', e => { S.f[key] = e.target.value; render(); });
  bind('dFrom', 'from'); bind('dTo', 'to');
  document.querySelectorAll('details[data-ms]').forEach(el => {
    const k = el.dataset.ms, panel = el.querySelector('.ms-panel');
    panel.addEventListener('change', e => {
      if (e.target.type !== 'checkbox') return;
      e.target.checked ? S.f[k].add(e.target.value) : S.f[k].delete(e.target.value);
      msSummary(k); render();
    });
    panel.addEventListener('click', e => {
      const a = e.target.dataset.a; if (!a) return;
      panel.querySelectorAll('label:not([hidden]) input').forEach(b => { b.checked = a === 'all'; a === 'all' ? S.f[k].add(b.value) : S.f[k].delete(b.value); });
      msSummary(k); render();
    });
    panel.addEventListener('input', e => {
      if (!e.target.classList.contains('ms-q')) return;
      const q = e.target.value.trim().toLowerCase();
      panel.querySelectorAll('label').forEach(l => { l.hidden = !!q && !l.dataset.n.includes(q); });
    });
  });
  document.addEventListener('click', e => {
    document.querySelectorAll('details[data-ms]').forEach(el => { if (!el.contains(e.target)) el.removeAttribute('open'); });
  });
  $('resetBtn').addEventListener('click', () => {
    S.f = { v: new Set(), cat: new Set(), kt: new Set(), mt: new Set(), from: '', to: '' };
    $('dFrom').value = $('dTo').value = ''; buildFilters(); render();
  });
  $('refreshBtn').addEventListener('click', () => load(true));
  $('nfBtn').addEventListener('click', openNotFound);
  $('themeToggle').addEventListener('click', () => setTimeout(render, 30));
  $('body').addEventListener('click', e => {
    const th = e.target.closest('th[data-t]');
    if (th) { sortClick(th); render(); return; }
    if (e.target.closest('[data-nf]')) { openNotFound(); return; }
    const tr = e.target.closest('tr[data-pick]');
    if (tr) openVendor(tr.dataset.pick);
  });
  document.addEventListener('click', e => {
    const th = e.target.closest('#vmodal th[data-t]');
    if (th) { sortClick(th); drawProducts(); return; }
    if (e.target.id === 'nfExport') { exportNotFound(); return; }
    if (e.target.id === 'vmodal' || e.target.closest('.modal-x')) closeVendor();
  });
  document.addEventListener('input', e => { if (e.target.id === 'mQ') { S.mq = e.target.value; drawProducts(true); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeVendor(); });
  // Store filter inside the vendor pop-up
  document.addEventListener('change', e => {
    if (!e.target.closest('#mStorePanel') || e.target.type !== 'checkbox') return;
    e.target.checked ? S.mst.add(e.target.value) : S.mst.delete(e.target.value);
    storeSummary(); drawProducts();
  });
  document.addEventListener('click', e => {
    const a = e.target.dataset && e.target.dataset.sa;
    if (a && e.target.closest('#mStorePanel')) {
      $('mStorePanel').querySelectorAll('label:not([hidden]) input').forEach(b => { b.checked = a === 'all'; a === 'all' ? S.mst.add(b.value) : S.mst.delete(b.value); });
      storeSummary(); drawProducts();
    }
    const d = $('mStore'); if (d && !d.contains(e.target)) d.removeAttribute('open');
  });
  document.addEventListener('input', e => {
    if (e.target.id !== 'mStoreQ') return;
    const q = e.target.value.trim().toLowerCase();
    $('mStorePanel').querySelectorAll('label').forEach(l => { l.hidden = !!q && !l.dataset.n.includes(q); });
  });
}

async function load(refresh) {
  $('refreshBtn').disabled = true;
  try {
    const res = await fetch('/api/vendor-performance' + (refresh ? '?refresh=true' : ''));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    S.data = await res.json();
    $('updated').textContent = 'Data as of ' + new Date(S.data.generatedAt).toLocaleString('en-IN');
    buildFilters();
    render();
  } catch (err) {
    $('body').innerHTML = `<div class="card"><p class="warn">Could not load vendor data: ${esc(err.message)}</p></div>`;
  } finally { $('refreshBtn').disabled = false; }
}

document.addEventListener('DOMContentLoaded', () => { wire(); load(false); });
})();
