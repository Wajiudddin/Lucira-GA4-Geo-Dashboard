/* Sales Analytics — core: data model, aggregation, filters, reusable components.
   Every number on every page is derived from S.f (the filtered line-level rows)
   through group()/total(), so KPIs and detail tables reconcile by construction. */
'use strict';

const NP = 'Not populated';
const PRICE_ORDER = ['0 - 10K', '10K - 20K', '20K - 30K', '30K - 40K', '40K - 50K', '50K - 75K', '75K - 100K', '100K - 150K', '150K - 200K', '200K+'];
// Default reporting window: the 12 months 1 Oct 2025 – 30 Sep 2026 (Aug–Sep 2025 are partial/ramp-up months in the data).
const DEFAULT_DATE = { from: '2025-10-01', to: '2026-09-30' };
const S = { all: [], f: [], fNoDate: [], filters: {}, text: {}, date: { ...DEFAULT_DATE }, page: 'p1', hm: 'sales', preset: 'month', maxDate: null, generatedAt: null };

// ---------- formatting ----------
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Amounts are shown compactly as k (thousand) / L (lakh) / cr (crore) everywhere; moneyE keeps the exact figure for hints.
function money(n) {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n), sg = n < 0 ? '-' : '', f1 = x => x.toLocaleString('en-IN', { maximumFractionDigits: 1 });
  if (a >= 1e7) return `${sg}₹${f1(a / 1e7)} cr`; // 1 crore and above -> cr
  if (a >= 1e5) return `${sg}₹${f1(a / 1e5)} L`; // 1 lakh to <1 crore -> L
  if (a >= 1e3) return `${sg}₹${f1(a / 1e3)} k`; // 1 thousand to <1 lakh -> k
  return `${sg}₹${Math.round(a)}`;
}
const moneyE = n => (n == null || isNaN(n)) ? '—' : `${n < 0 ? '-' : ''}₹${inr.format(Math.abs(Math.round(n)))}`;
const moneyX = money;
const int = n => (n == null || isNaN(n)) ? '—' : inr.format(Math.round(n));
const pct = n => (n == null || !isFinite(n)) ? '—' : `${n.toFixed(1)}%`;
const wt = n => (n == null || isNaN(n)) ? '—' : `${n.toFixed(2)} ct`;
const div = (a, b) => b ? a / b : 0;
const nz = v => (v == null || v === '') ? NP : String(v);
const sumBy = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
function growth(cur, prev) { return prev ? (cur - prev) / Math.abs(prev) * 100 : null; }
function gTxt(g) { return g == null ? 'n/a' : `${g >= 0 ? '+' : ''}${g.toFixed(1)}%`; }
function isoWeekStart(d) { const x = new Date(d + 'T00:00:00Z'); const day = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - day); return x.toISOString().slice(0, 10); }
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function addDays(iso, n) { const x = new Date(iso + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5); }
function monthLabel(m) { const [y, mo] = m.split('-'); return new Date(Date.UTC(+y, +mo - 1, 1)).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' }); }
function shortDate(d) { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' }); }

// ---------- row preparation ----------
const PLACEHOLDERS = { coll: 0, sub2: 0 };
// The source stores districts / localities as the "city" (e.g. East Delhi, Hadapsar Pune, Mumbai Suburban).
// Merge them into the one city people mean, so every page counts a city once. Raw value kept in r.cityRaw.
const CITY_MERGE = {
  'Mumbai Suburban': 'Mumbai', 'Borivali': 'Mumbai', 'Malad': 'Mumbai',
  'Hadapsar Pune': 'Pune', 'Pune Division': 'Pune',
  'Bangalore Urban': 'Bengaluru', 'Bangalore': 'Bengaluru',
};
function canonCity(city, state) {
  if (!city) return city;
  if (state === 'Delhi') return 'Delhi'; // New / East / West / North / South / North West / South West Delhi, Rohini ...
  if (city === 'Delhi') return `Delhi (${state || 'other'})`; // e.g. Delhi, Louisiana — not the Indian capital
  return CITY_MERGE[city] || city;
}
const CITY_MERGE_NOTE = 'Merged into one city: all Delhi areas → Delhi; Mumbai Suburban, Borivali, Malad → Mumbai; Hadapsar Pune, Pune Division → Pune; Bangalore Urban → Bengaluru.';
function prepare(rows) {
  rows.forEach((r, i) => {
    r._i = i;
    // Placeholder text the source uses for "no value" is treated as missing (counted in Data Quality, never shown as a real category).
    if (r.coll === 'NA') { r.coll = null; PLACEHOLDERS.coll++; }
    if (r.sub2 === '0') { r.sub2 = null; PLACEHOLDERS.sub2++; }
    r.net = r.net || 0; r.disc = r.disc || 0; r.adisc = r.adisc || 0; r.pcs = r.pcs || 0;
    r.gross = r.net + r.disc + r.adisc; // Gross/Base = net_sale + discount + additional_discount (see Definitions)
    if (r.date) { r.month = r.date.slice(0, 7); r.week = isoWeekStart(r.date); r.dow = (new Date(r.date + 'T00:00:00Z').getUTCDay() + 6) % 7; }
    if (r.city) { r.cityRaw = r.city; r.city = canonCity(r.city, r.state); }
    r.k_chan = nz(r.chan); r.k_ful = nz(r.ful); r.k_co = nz(r.co); r.k_ctype = nz(r.ctype);
    r.k_ig = nz(r.ig); r.k_type = nz(r.type); r.k_sub1 = nz(r.sub1); r.k_sub2 = nz(r.sub2);
    r.k_metal = nz(r.metal); r.k_mcolor = nz(r.mcolor); r.k_karat = nz(r.karat); r.k_price = nz(r.price);
    r.k_vendor = nz(r.vendor); r.k_coll = nz(r.coll); r.k_dband = nz(r.dband); r.k_dshape = nz(r.dshape);
    r.k_dset = nz(r.dset); r.k_gset = nz(r.gset); r.k_gshape = nz(r.gshape);
    r.k_oi = r.k_chan !== 'Store' ? 'Not a store sale' : r.oi ? 'Online-influenced store' : 'Store only';
    r.k_sol = r.sol === 'true' ? 'Solitaire' : r.sol === 'false' ? 'Non-solitaire' : NP;
    r.k_best = r.best === 'Bestseller' ? 'Bestseller-tagged' : r.best === '0' ? 'Flag = 0' : NP;
    r.k_sku = nz(r.sku); r.k_style = nz(r.style); r.k_cust = r.party == null ? NP : String(r.party);
  });
  return rows;
}

// ---------- aggregation ----------
function newG(key) {
  return { key, lines: 0, sales: 0, gross: 0, disc: 0, adisc: 0, tax: 0, pcs: 0, dAmt: 0, mAmt: 0, csAmt: 0, sAmt: 0, oAmt: 0, dWt: 0, dPcs: 0, newSales: 0, repSales: 0, newPcs: 0, repPcs: 0,
    _o: new Set(), _c: new Set(), _s: new Set(), _st: new Set(), _pl: new Map(), _no: new Set(), _ro: new Set(), first: null, last: null };
}
function addTo(g, r) {
  g.lines++; g.sales += r.net; g.gross += r.gross; g.disc += r.disc; g.adisc += r.adisc; g.tax += r.tax || 0; g.pcs += r.pcs;
  g.dAmt += r.dAmt || 0; g.mAmt += r.mAmt || 0; g.csAmt += r.csAmt || 0; g.sAmt += r.sAmt || 0; g.oAmt += r.oAmt || 0; g.dWt += r.dWt || 0; g.dPcs += r.dPcs || 0;
  if (r.doc) g._o.add(r.doc);
  if (r.party != null) g._c.add(r.party);
  if (r.sku) g._s.add(r.sku);
  if (r.style) g._st.add(r.style);
  if (r.ctype === 'New') { g.newSales += r.net; g.newPcs += r.pcs; if (r.doc) g._no.add(r.doc); }
  else if (r.ctype === 'Repeat') { g.repSales += r.net; g.repPcs += r.pcs; if (r.doc) g._ro.add(r.doc); }
  if (r.party != null && (r.ctype === 'New' || r.ctype === 'Repeat')) { // a customer is New or Repeat by their most recent purchase (Repeat wins a same-day tie)
    const d = r.date || '', cur = g._pl.get(r.party);
    if (!cur || d > cur.d || (d === cur.d && r.ctype === 'Repeat')) g._pl.set(r.party, { d, t: r.ctype });
  }
  if (r.date) { if (!g.first || r.date < g.first) g.first = r.date; if (!g.last || r.date > g.last) g.last = r.date; }
}
function finalize(g) {
  g.o = g._o.size; g.c = g._c.size; g.sk = g._s.size; g.st = g._st.size; g.nc = 0; g.rc = 0; g._pl.forEach(v => { v.t === 'New' ? g.nc++ : g.rc++; }); g.ncAll = g.nc; /* each customer is New or Repeat, decided by their most recent purchase */ g.no = g._no.size; g.ro = g._ro.size;
  g.aov = div(g.sales, g.o); g.asp = div(g.sales, g.pcs); g.spc = div(g.sales, g.c); g.ppo = div(g.pcs, g.o);
  g.dTot = g.disc + g.adisc; g.discPct = div(g.dTot, g.gross) * 100;
  g.newPct = div(g.nc, g.c) * 100; g.repPct = div(g.rc, g.c) * 100;
  g.newAov = div(g.newSales, g.no); g.repAov = div(g.repSales, g.ro);
  return g;
}
function group(rows, keyFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (k == null) continue; let g = m.get(k); if (!g) { g = newG(k); m.set(k, g); } addTo(g, r); }
  const out = [...m.values()]; out.forEach(finalize);
  const t = out.reduce((s, g) => s + g.sales, 0);
  out.forEach(g => g.share = div(g.sales, t) * 100);
  return out;
}
function total(rows) { const g = newG('Total'); rows.forEach(r => addTo(g, r)); return finalize(g); }
const bySales = (a, b) => b.sales - a.sales;
function orderBy(list, order) { return order ? list.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99)) : list.sort(bySales); }
function groupTop(rows, keyFn, n) {
  const top = new Set(group(rows, keyFn).sort(bySales).slice(0, n).map(g => g.key));
  return group(rows, r => { const k = keyFn(r); return k == null ? null : top.has(k) ? k : 'Other'; });
}

// ---------- filters ----------
const FDEFS = [
  { k: 'chan', label: 'Channel', get: r => r.k_chan }, { k: 'ful', label: 'Fulfillment', get: r => r.k_ful }, { k: 'co', label: 'Company / Store', get: r => r.k_co },
  { k: 'ctype', label: 'Customer Type', get: r => r.k_ctype }, { k: 'oi', label: 'Online-influenced (store)', get: r => r.k_oi }, { k: 'ig', label: 'Category (Item Group)', get: r => r.k_ig }, { k: 'type', label: 'Type', get: r => r.k_type },
  { k: 'sub1', label: 'Sub-category 1', get: r => r.k_sub1 }, { k: 'sub2', label: 'Sub-category 2', get: r => r.k_sub2 }, { k: 'price', label: 'Price Range', get: r => r.k_price, order: PRICE_ORDER },
  { k: 'metal', label: 'Metal', get: r => r.k_metal }, { k: 'mcolor', label: 'Metal Color', get: r => r.k_mcolor }, { k: 'karat', label: 'Karat', get: r => r.k_karat },
  { k: 'dband', label: 'Diamond Weight Band', get: r => r.k_dband, numOrder: true }, { k: 'dshape', label: 'Diamond Shape', get: r => r.k_dshape }, { k: 'sol', label: 'Solitaire', get: r => r.k_sol },
  { k: 'coll', label: 'Collection', get: r => r.k_coll }, { k: 'best', label: 'Bestseller', get: r => r.k_best }, { k: 'vendor', label: 'Vendor', get: r => r.k_vendor },
  { k: 'month', label: 'Month', get: r => r.month || NP, sortKey: true }, { k: 'week', label: 'Week (starts Mon)', get: r => r.week || NP, sortKey: true },
];
const TEXT_FILTERS = [
  { k: 'sku', label: 'SKU contains', get: r => (r.sku || '').toLowerCase() },
  { k: 'style', label: 'Style code / name contains', get: r => ((r.style || '') + ' ' + (r.styleName || '')).toLowerCase() },
  { k: 'cust', label: 'Customer ID / name contains', get: r => ((r.party ?? '') + ' ' + (r.pname || '')).toLowerCase() },
];
function applyFilters(rows, ignoreDate) {
  const active = FDEFS.filter(d => S.filters[d.k] && S.filters[d.k].size);
  const texts = TEXT_FILTERS.filter(d => S.text[d.k]);
  return rows.filter(r => {
    if (!ignoreDate) { if (S.date.from && (!r.date || r.date < S.date.from)) return false; if (S.date.to && (!r.date || r.date > S.date.to)) return false; }
    for (const d of active) if (!S.filters[d.k].has(d.get(r))) return false;
    for (const d of texts) if (!d.get(r).includes(S.text[d.k])) return false;
    return true;
  });
}
function refilter() { S.fNoDate = applyFilters(S.all, true); S.f = applyFilters(S.all, false); }

function buildFilterUI() {
  const box = document.getElementById('filterGrid');
  const parts = FDEFS.map(d => {
    const g = group(S.all, d.get);
    let keys;
    if (d.order) keys = d.order.filter(k => g.some(x => x.key === k)).concat(g.filter(x => !d.order.includes(x.key)).map(x => x.key));
    else if (d.sortKey) keys = g.map(x => x.key).sort();
    else if (d.numOrder) keys = g.map(x => x.key).sort((a, b) => (parseFloat(a) || (a === NP ? 99 : 98)) - (parseFloat(b) || (b === NP ? 99 : 98)) || a.localeCompare(b));
    else keys = g.sort(bySales).map(x => x.key);
    return `<details class="ms" data-k="${d.k}"><summary><span>${esc(d.label)}</span><b class="ms-n"></b></summary><div class="ms-panel">
      <div class="ms-actions"><button type="button" data-a="clear">Clear</button></div>
      ${keys.map(k => `<label><input type="checkbox" value="${esc(k)}"> ${esc(k)}</label>`).join('')}</div></details>`;
  });
  const texts = TEXT_FILTERS.map(d => `<label class="tf"><span>${esc(d.label)}</span><input type="search" data-t="${d.k}" placeholder="type to filter"></label>`);
  const html = parts.join('') + texts.join('');
  if (box.dataset.bound) {
    // Live refresh: only rebuild when the option lists changed, and keep the user's selections.
    if (box.dataset.sig === html) return;
    box.innerHTML = html; box.dataset.sig = html;
    box.querySelectorAll('details.ms').forEach(d => { const set = S.filters[d.dataset.k]; if (set && set.size) d.querySelectorAll('input[type=checkbox]').forEach(i => { i.checked = set.has(i.value); }); });
    box.querySelectorAll('input[data-t]').forEach(i => { i.value = S.text[i.dataset.t] || ''; });
    syncFilterBadges(); return;
  }
  box.dataset.bound = '1'; box.dataset.sig = html; box.innerHTML = html;
  box.addEventListener('change', e => {
    const cb = e.target; if (cb.type !== 'checkbox') return;
    const k = cb.closest('details').dataset.k; const set = S.filters[k] || (S.filters[k] = new Set());
    cb.checked ? set.add(cb.value) : set.delete(cb.value); syncFilterBadges(); onFilterChange();
  });
  box.addEventListener('click', e => {
    if (e.target.dataset.a !== 'clear') return;
    const d = e.target.closest('details'); S.filters[d.dataset.k] = new Set(); d.querySelectorAll('input').forEach(i => i.checked = false); syncFilterBadges(); onFilterChange();
  });
  let tm; box.addEventListener('input', e => { if (!e.target.dataset.t) return; clearTimeout(tm); tm = setTimeout(() => { S.text[e.target.dataset.t] = e.target.value.trim().toLowerCase(); onFilterChange(); }, 250); });
  document.addEventListener('click', e => { if (!e.target.closest('.ms')) document.querySelectorAll('.ms[open]').forEach(d => d.removeAttribute('open')); });
}
function syncFilterBadges() {
  document.querySelectorAll('#filterGrid .ms').forEach(d => { const n = (S.filters[d.dataset.k] || new Set()).size; d.querySelector('.ms-n').textContent = n ? n : ''; d.classList.toggle('on', n > 0); });
}
function istToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// Quick date ranges (IST). "month" = the month of the newest data (so it still works on the 1st before any sale lands).
function presetRange(k, mx) {
  const t = istToday();
  if (k === 'today') return [t, t];
  if (k === 'yesterday') { const y = addDays(t, -1); return [y, y]; }
  if (k === 'month') { const b = mx && mx < t ? mx : t; return [b.slice(0, 8) + '01', b]; }
  if (k === 'lastweek') { const dow = (new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7, mon = addDays(t, -dow - 7); return [mon, addDays(mon, 6)]; }
  const d = new Date(t + 'T00:00:00Z');
  return [new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10), new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10)];
}
function markPreset() { document.querySelectorAll('#presets button').forEach(b => b.classList.toggle('on', b.dataset.p === S.preset)); }
function applyPreset(k) {
  const [f, t] = presetRange(k, S.maxDate); S.date = { from: f, to: t }; S.preset = k;
  document.getElementById('dateFrom').value = f; document.getElementById('dateTo').value = t; markPreset(); onFilterChange();
}
function setHm(v) { const y = window.scrollY; S.hm = v; renderPage(); window.scrollTo(0, y); }
function resetFilters() {
  S.filters = {}; S.text = {}; S.date = { ...DEFAULT_DATE }; S.preset = 'month'; markPreset();
  document.querySelectorAll('#filterGrid input[type=checkbox]').forEach(i => i.checked = false);
  document.querySelectorAll('#filterGrid input[type=search]').forEach(i => i.value = '');
  document.getElementById('dateFrom').value = DEFAULT_DATE.from; document.getElementById('dateTo').value = DEFAULT_DATE.to;
  syncFilterBadges(); onFilterChange();
}
function filterSummary() {
  const bits = [];
  if (S.date.from || S.date.to) bits.push(`Date ${S.date.from || '…'} → ${S.date.to || '…'}`);
  FDEFS.forEach(d => { const n = (S.filters[d.k] || new Set()).size; if (n) bits.push(`${d.label}: ${n === 1 ? [...S.filters[d.k]][0] : n + ' selected'}`); });
  TEXT_FILTERS.forEach(d => { if (S.text[d.k]) bits.push(`${d.label} “${S.text[d.k]}”`); });
  return bits;
}

// ---------- charts ----------
const CH = {};
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
const PAL = () => [css('--c1'), css('--c2'), css('--c3'), css('--c4'), css('--c5'), css('--c6'), css('--c7'), css('--c8')];
// Draws each value as a % share on every chart: doughnut = share of total, stacked bar = share of its column,
// bar / line = share of that series' total across the points shown. Averages (e.g. AOV) are skipped — a share of an average is meaningless.
const PctLabels = {
  id: 'pctLabels',
  afterDatasetsDraw(chart) {
    const type = chart.config.type, ctx = chart.ctx, tx = css('--text'), vis = chart.data.datasets.map((_, i) => chart.isDatasetVisible(i));
    const stacked = chart.options.scales && Object.values(chart.options.scales).some(sc => sc && sc.stacked);
    const horiz = chart.options.indexAxis === 'y';
    const pctTxt = v => (v < 10 ? v.toFixed(1) : Math.round(v)) + '%';
    chart.data.datasets.forEach((ds, di) => {
      if (!vis[di]) return;
      if (/average|avg|aov/i.test(ds.label || '')) return;
      const kind = ds.type || type, meta = chart.getDatasetMeta(di), data = ds.data.map(v => (typeof v === 'number' ? v : (v && typeof v === 'object' ? (horiz ? v.x : v.y) : Number(v))) || 0);
      if (kind === 'line' && (data.length > 24)) return;
      if (kind === 'bar' && !stacked && data.length > 40) return;
      let den;
      if (kind === 'doughnut' || kind === 'pie') den = null;
      else if (kind === 'bar' && stacked) den = null;
      else den = data.reduce((a, v) => a + Math.abs(v), 0);
      ctx.save(); ctx.font = '600 10px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      meta.data.forEach((el, i) => {
        const v = data[i]; if (!v || meta.hidden || el.hidden) return;
        let total;
        if (kind === 'doughnut' || kind === 'pie') total = data.reduce((a, x, k) => a + (chart.getDataVisibility(k) ? Math.abs(x) : 0), 0);
        else if (kind === 'bar' && stacked) total = chart.data.datasets.reduce((a, d2, k) => a + (vis[k] && !/average|avg|aov/i.test(d2.label || '') ? Math.abs(Number(d2.data[i]) || 0) : 0), 0);
        else total = den;
        if (!total) return;
        const share = Math.abs(v) / total * 100; if (share < 2) return;
        const t = pctTxt(share), pos = el.tooltipPosition ? el.tooltipPosition(true) : { x: el.x, y: el.y };
        if (kind === 'doughnut' || kind === 'pie') { ctx.fillStyle = '#fff'; ctx.fillText(t, pos.x, pos.y); }
        else if (kind === 'bar' && stacked) {
          const w = horiz ? Math.abs(el.x - el.base) : Math.abs(el.y - el.base), h = horiz ? el.height : el.width;
          if (w < (horiz ? 30 : 14) || h < (horiz ? 12 : 26)) return;
          ctx.fillStyle = '#fff'; ctx.fillText(t, el.x - (horiz ? (el.x - el.base) / 2 : 0), el.y + (horiz ? 0 : (el.base - el.y) / 2));
        } else if (kind === 'bar') {
          ctx.fillStyle = tx;
          if (horiz) { ctx.textAlign = 'left'; ctx.fillText(t, el.x + 4, el.y); } else ctx.fillText(t, el.x, el.y - 8);
        } else { ctx.fillStyle = ds.borderColor && typeof ds.borderColor === 'string' ? ds.borderColor : tx; ctx.fillText(t, el.x, el.y - 10); }
      });
      ctx.restore();
    });
  },
};
function mk(id, cfg) {
  const el = document.getElementById(id); if (!el) return;
  if (CH[id]) CH[id].destroy();
  const grid = css('--border'), tx = css('--text-2');
  cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: { duration: 250 } }, cfg.options || {});
  const o = cfg.options; o.plugins = o.plugins || {};
  o.plugins.legend = Object.assign({ labels: { color: tx, boxWidth: 12, font: { size: 11 } } }, o.plugins.legend || {});
  if (cfg.type !== 'doughnut') {
    o.scales = o.scales || {};
    Object.values(o.scales).forEach(s => { s.ticks = Object.assign({ color: tx, font: { size: 11 } }, s.ticks || {}); s.grid = Object.assign({ color: grid }, s.grid || {}); });
  }
  if (cfg.type !== 'doughnut') o.layout = Object.assign({ padding: { top: 18, right: o.indexAxis === 'y' ? 34 : 4 } }, o.layout || {});
  cfg.plugins = (cfg.plugins || []).concat(PctLabels);
  CH[id] = new Chart(el, cfg);
  return CH[id];
}
const axisMoney = { callback: v => money(v) };

// ---------- HTML builders ----------
const card = (title, sub, inner, cls = '') => `<section class="card ${cls}"><header><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ''}</header>${inner}</section>`;
const chartCard = (id, title, sub, h = 300, cls = '') => card(title, sub, `<div class="chart-box" style="height:${h}px"><canvas id="${id}"></canvas></div>`, cls);
const tableCard = (id, title, sub, cls = '') => card(title, sub, `<div id="${id}" class="tbl-host"></div>`, cls);
// "What the Data Shows" panels removed from all tabs; kept as no-ops so the per-page calls stay harmless.
const insight = () => '';
const setInsight = () => {};
const kpi = (label, value, def, tone = '') => `<div class="kpi ${tone}" title="${esc(def)}"><span class="kpi-l">${esc(label)}</span><span class="kpi-v">${value}</span><span class="kpi-d">${esc(def)}</span></div>`;
const grid = (cls, ...cards) => `<div class="grid ${cls}">${cards.join('')}</div>`;

// ---------- generic sortable / searchable / paginated table ----------
// cols: [{h, f(row)->html|text, v(row)->sortable/exported raw, cls, html:true, hidden}]
// Metrics deliberately not shown anywhere in this dashboard.
const HIDDEN_COLS = new Set(['Discount', 'Discount %', 'SKUs', 'Lines', 'Repeat avg ticket', 'New avg ticket', 'Gross/Base', 'Net Sale', 'Δ from orders', 'Δ from AIV']);
function tbl(hostId, o) {
  const host = document.getElementById(hostId); if (!host) return;
  o.cols = o.cols.filter(c => !HIDDEN_COLS.has(c.h));
  if (o.sort && !o.cols.some(c => c.h === o.sort)) o.sort = null;
  const prev = host._st && host._st.same === o.name ? host._st : null;
  const st = host._st = Object.assign({ page: 0, sort: o.sort || null, dir: o.dir || -1, q: '', hidden: new Set(o.cols.filter(c => c.hidden).map(c => c.h)) }, prev || {});
  st.same = o.name;
  const size = o.pageSize || 15;
  function draw() {
    const cur = host._o;
    const cols = cur.cols.filter(c => !st.hidden.has(c.h));
    let rows = cur.rows;
    if (st.q) { const q = st.q.toLowerCase(); rows = rows.filter(r => cur.cols.some(c => String(c.v ? c.v(r) : c.f(r)).toLowerCase().includes(q))); }
    if (st.sort != null) { const c = cur.cols.find(c => c.h === st.sort); if (c) rows = [...rows].sort((a, b) => { const x = c.v ? c.v(a) : c.f(a), y = c.v ? c.v(b) : c.f(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * st.dir; }); }
    const pages = Math.max(1, Math.ceil(rows.length / size)); if (st.page >= pages) st.page = 0;
    const slice = rows.slice(st.page * size, st.page * size + size);
    host.innerHTML = `<div class="tbl-bar">${cur.search === false ? '' : `<input type="search" class="tq" placeholder="Search table…" value="${esc(st.q)}">`}
      <span class="tbl-count">${int(rows.length)} row${rows.length === 1 ? '' : 's'}</span>
      ${cur.colSelect ? `<details class="ms cs"><summary>Columns</summary><div class="ms-panel">${cur.cols.map(c => `<label><input type="checkbox" data-col="${esc(c.h)}" ${st.hidden.has(c.h) ? '' : 'checked'}> ${esc(c.h)}</label>`).join('')}</div></details>` : ''}
      <button type="button" class="btn sm" data-x="1">Export CSV</button></div>
      <div class="tbl-wrap"><table class="t ${cur.sticky === false ? '' : 'sticky1'}"><thead><tr>${cols.map(c => `<th data-h="${esc(c.h)}" class="${c.cls || ''} ${st.sort === c.h ? (st.dir > 0 ? 'asc' : 'desc') : ''}">${esc(c.h)}</th>`).join('')}</tr></thead>
      <tbody>${slice.map(r => `<tr data-i="${cur.rows.indexOf(r)}" class="${cur.onRow ? 'clk' : ''}">${cols.map(c => `<td class="${c.cls || ''}">${c.html ? c.f(r) : esc(c.f(r))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="empty">No rows</td></tr>`}</tbody>
      ${cur.foot ? `<tfoot>${cur.foot(rows, cols)}</tfoot>` : ''}</table></div>
      <div class="pager"><button class="btn sm" data-p="-1" ${st.page ? '' : 'disabled'}>‹ Prev</button><span>Page ${st.page + 1} / ${pages}</span><button class="btn sm" data-p="1" ${st.page + 1 < pages ? '' : 'disabled'}>Next ›</button></div>`;
    host._rows = rows;
  }
  if (!host._bound) {
    host._bound = true;
    host.addEventListener('click', e => {
      const cur = host._o, s = host._st;
      const th = e.target.closest('th[data-h]');
      if (th) { const h = th.dataset.h, c = cur.cols.find(c => c.h === h); const numeric = typeof (c.v ? c.v(cur.rows[0] || {}) : 0) === 'number'; s.dir = s.sort === h ? -s.dir : (numeric ? -1 : 1); s.sort = h; host._draw(); return; }
      const p = e.target.closest('[data-p]'); if (p) { s.page += +p.dataset.p; host._draw(); return; }
      if (e.target.closest('[data-x]')) { exportCSV(cur.name || 'table', cur.cols.filter(c => !s.hidden.has(c.h)), host._rows); return; }
      const tr = e.target.closest('tr[data-i]'); if (tr && cur.onRow) cur.onRow(cur.rows[+tr.dataset.i]);
    });
    host.addEventListener('input', e => { if (!e.target.classList.contains('tq')) return; const s = host._st; s.q = e.target.value; s.page = 0; const pos = e.target.selectionStart; host._draw(); const q = host.querySelector('.tq'); q.focus(); q.setSelectionRange(pos, pos); });
    host.addEventListener('change', e => { const c = e.target.dataset.col; if (!c) return; const s = host._st; e.target.checked ? s.hidden.delete(c) : s.hidden.add(c); host._draw(); host.querySelector('.cs')?.setAttribute('open', ''); });
  }
  host._o = o; host._draw = draw; draw();
}
function exportCSV(name, cols, rows) {
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.map(c => q(c.h)).join(',')].concat(rows.map(r => cols.map(c => q(c.v ? c.v(r) : c.f(r))).join(',')));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' })); a.download = name + '.csv'; a.click(); URL.revokeObjectURL(a.href);
}

// column factories for group() results
const C = {
  key: (h, cls = 'lead') => ({ h, f: g => g.key, cls }),
  sales: { h: 'Net Sales', f: g => moneyX(g.sales), v: g => g.sales, cls: 'num strong' },
  share: { h: 'Sales %', f: g => pct(g.share), v: g => g.share, cls: 'num' },
  orders: { h: 'Orders', f: g => int(g.o), v: g => g.o, cls: 'num' },
  lines: { h: 'Lines', f: g => int(g.lines), v: g => g.lines, cls: 'num' },
  pcs: { h: 'Pieces', f: g => int(g.pcs), v: g => g.pcs, cls: 'num' },
  cust: { h: 'Customers', f: g => int(g.c), v: g => g.c, cls: 'num' },
  aov: { h: 'Avg Invoice Value', f: g => moneyX(g.aov), v: g => g.aov, cls: 'num' },
  asp: { h: 'Avg Selling Price', f: g => moneyX(g.asp), v: g => g.asp, cls: 'num' },
  disc: { h: 'Discount', f: g => moneyX(g.dTot), v: g => g.dTot, cls: 'num' },
  discPct: { h: 'Discount %', f: g => pct(g.discPct), v: g => g.discPct, cls: 'num' },
  newC: { h: 'New Cust.', f: g => int(g.nc), v: g => g.nc, cls: 'num' },
  repC: { h: 'Repeat Cust.', f: g => int(g.rc), v: g => g.rc, cls: 'num' },
  newPct: { h: 'New %', f: g => pct(g.newPct), v: g => g.newPct, cls: 'num' },
  repPct: { h: 'Repeat %', f: g => pct(g.repPct), v: g => g.repPct, cls: 'num' },
  skus: { h: 'SKUs', f: g => int(g.sk), v: g => g.sk, cls: 'num' },
};
const std = (label, ...extra) => [C.key(label), C.sales, C.share, C.orders, C.pcs, C.cust, C.aov, C.asp, ...extra];
// Distinct-count columns are not additive across groups, so the footer leaves them blank
// rather than showing a misleading sum; the true de-duplicated total is in the KPI row.
const NON_ADDITIVE = ['Customers', 'SKUs', 'New Cust.', 'Repeat Cust.', 'New %', 'Repeat %', 'Orders'];
function dimTable(hostId, rows, keyFn, label, opt = {}) {
  const gs = orderBy(group(rows, keyFn).filter(g => g.sales > 0), opt.order); // zero-net-sale groups are not listed
  const t = total(rows);
  tbl(hostId, { name: opt.name || hostId, cols: opt.cols || std(label, C.disc, C.discPct), rows: gs, pageSize: opt.pageSize || 10, search: opt.search ?? gs.length > 10, sort: opt.order ? null : 'Net Sales',
    foot: opt.noFoot ? null : (rs, cols) => `<tr class="tot">${cols.map((c, i) => `<td class="${c.cls || ''}">${i === 0 ? 'Total (all rows)' : c.h === 'Sales %' ? '100.0%' : (c.h === 'Orders' ? int(t.o) : c.h === 'Customers' ? int(t.c) : c.h === 'SKUs' ? int(t.sk) : NON_ADDITIVE.includes(c.h) ? '' : esc(c.f(t)))}</td>`).join('')}</tr>` });
  return gs;
}

// ---------- heatmap (HTML table, row-normalised shading) ----------
function heat(hostId, rows, rowFn, colFn, o = {}) {
  const host = document.getElementById(hostId); if (!host) return;
  const m = S.hm, val = g => m === 'sales' ? g.sales : m === 'orders' ? g.o : g.pcs, fmt = v => m === 'sales' ? money(v) : int(v);
  const cells = group(rows, r => { const a = rowFn(r), b = colFn(r); return a == null || b == null ? null : a + '\u0001' + b; });
  const rowT = new Map(), colT = new Map();
  cells.forEach(g => { const [a, b] = g.key.split('\u0001'); rowT.set(a, (rowT.get(a) || 0) + val(g)); colT.set(b, (colT.get(b) || 0) + val(g)); });
  const rk = o.rowOrder ? o.rowOrder.filter(k => rowT.has(k)).concat([...rowT.keys()].filter(k => !o.rowOrder.includes(k))) : [...rowT.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const ck = o.colOrder ? o.colOrder.filter(k => colT.has(k)).concat([...colT.keys()].filter(k => !o.colOrder.includes(k))) : [...colT.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const R = rk.slice(0, o.maxRows || 14), Cc = ck.slice(0, o.maxCols || 10);
  const map = new Map(cells.map(g => [g.key, g]));
  if (!R.length) { host.innerHTML = '<p class="empty">No data</p>'; return; }
  host.innerHTML = `<div class="hm-bar"><label>Show <select onchange="setHm(this.value)">${[['sales', 'Net sales'], ['orders', 'Orders'], ['pcs', 'Pieces']].map(([v, l]) => `<option value="${v}"${m === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label></div><div class="tbl-wrap"><table class="t heat sticky1"><thead><tr><th>${esc(o.corner || '')}</th>${Cc.map(c => `<th class="num">${esc(c)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>${R.map(a => {
    const rt = rowT.get(a);
    return `<tr><td class="lead">${esc(a)}</td>${Cc.map(b => { const g = map.get(a + '\u0001' + b); if (!g) return '<td class="num hc"></td>'; const v = val(g), share = div(v, rt);
      return `<td class="num hc" style="--a:${Math.min(1, share * 1.6).toFixed(2)}" title="${esc(a)} × ${esc(b)}&#10;Sales ${moneyX(g.sales)}&#10;Orders ${int(g.o)} · Pieces ${int(g.pcs)} · Customers ${int(g.c)}&#10;${pct(share * 100)} of row">${fmt(v)}</td>`; }).join('')}<td class="num strong">${fmt(rt)}</td></tr>`; }).join('')}</tbody></table></div>
    <p class="note">Cell = ${m}. Shading = share of the row total. ${rk.length > R.length || ck.length > Cc.length ? `Showing top ${R.length} rows × ${Cc.length} columns by ${m}.` : ''}</p>`;
}

// ---------- hierarchical drill table (breadcrumb; click a row to go one level deeper) ----------
function drill(hostId, levels, baseRows, o = {}) {
  const host = document.getElementById(hostId); if (!host) return;
  const sig = levels.map(l => l.name).join();
  const st = host._dr = host._dr && host._dr.sig === sig ? host._dr : { sig, path: [] };
  function draw() {
    const depth = st.path.length; let rows = host._rows0;
    st.path.forEach((p, i) => { rows = rows.filter(r => levels[i].key(r) === p); });
    const lvl = levels[Math.min(depth, levels.length - 1)];
    const crumbs = [`<a data-d="0">${esc(o.root || 'All')}</a>`].concat(st.path.map((p, i) => `<a data-d="${i + 1}">${esc(levels[i].name)}: ${esc(p)}</a>`)).join(' <span>›</span> ');
    host.innerHTML = `<div class="crumbs">${crumbs}</div><div id="${hostId}_t"></div><p class="note">${depth < levels.length - 1 ? `Click a row to drill into ${esc(levels[depth + 1].name)}.` : 'Deepest level.'}</p>`;
    tbl(hostId + '_t', { name: hostId + '_' + lvl.name, cols: lvl.cols || std(lvl.name, C.discPct), rows: group(rows, lvl.key).filter(g => g.sales > 0), pageSize: 10, sort: 'Net Sales', onRow: depth < levels.length - 1 ? g => { st.path.push(g.key); draw(); } : null });
  }
  if (!host._b) { host._b = true; host.addEventListener('click', e => { const a = e.target.closest('a[data-d]'); if (a) { host._dr.path = host._dr.path.slice(0, +a.dataset.d); host._draw(); } }); }
  host._rows0 = baseRows; host._draw = draw; draw();
}
