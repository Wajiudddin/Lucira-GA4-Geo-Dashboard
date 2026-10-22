// Controller: load data, hold filter state, wire events, call views. Business rules live in model.js / config.js.
import { CONFIG, STAGE_ORDER, STATUS } from './config.js';
import { derive, journey, vendorStats, dataQuality, todayUTC, Q } from './model.js';
import * as V from './views.js';

const $ = id => document.getElementById(id);
const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch { return null; } };

const S = {
  rows: [], meta: {}, preset: 'lastmonth', from: '', to: '', type: [], vendor: [], storeCode: [], stage: [], status: [],
  grain: 'month', vendorSort: 'pending', q: '', actionOnly: true, page: 0, sort: { key: 'delayDays', dir: -1 },
  cols: store('mto.cols.v3') || V.DEFAULT_COLS,
};

// ---------- data ----------
async function load(refresh) {
  const res = await fetch('/api/mto' + (refresh ? '?refresh=1' : ''));
  if (!res.ok) throw new Error('Data unavailable');
  const d = await res.json(), today = todayUTC();
  S.rows = d.rows.map(r => derive(r, today));
  S.meta = { at: d.generatedAt, source: d.source, coverage: d.coverage };
}

// ---------- filtering ----------
const iso = ms => new Date(ms).toISOString().slice(0, 10);
function range() {
  const t = todayUTC(), D = 864e5, d = new Date(t);
  switch (S.preset) {
    case 'today': return [iso(t), iso(t)];
    case 'yesterday': return [iso(t - D), iso(t - D)];
    case 'lastweek': { const mon = t - ((d.getUTCDay() + 6) % 7) * D; return [iso(mon - 7 * D), iso(mon - D)]; } // previous Monday to Sunday
    case 'lastmonth': return [iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)), iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0))];
    case 'custom': return [S.from || '0000', S.to || '9999'];
    default: return ['0000', '9999'];
  }
}
const has = (sel, v) => !sel.length || sel.includes(v); // multi-select: nothing ticked = all
function filtered() {
  const [a, b] = range();
  return S.rows.filter(r => r.order_date >= a && r.order_date <= b && has(S.type, r.mto_type) && has(S.vendor, r.vendor) &&
    has(S.storeCode, r.store) && has(S.stage, r.stage) && has(S.status, r.status));
}
const uniq = k => [...new Set(S.rows.map(r => r[k]).filter(Boolean))].sort();

// Multi-select filters (checkbox list). Add a filter by adding a row here and a key in S.
const MS = [
  { key: 'type', label: 'MTO type', all: 'All', opts: () => ['Online', 'Store'] },
  { key: 'vendor', label: 'Vendor', all: 'All vendors', opts: () => uniq('vendor'), search: true },
  { key: 'storeCode', label: 'Store', all: 'All stores', opts: () => uniq('store') },
  { key: 'stage', label: 'Current stage', all: 'All stages', opts: () => STAGE_ORDER },
  { key: 'status', label: 'Status', all: 'All', opts: () => Object.values(STATUS) },
];
const msText = m => { const n = S[m.key].length; return n === 0 ? m.all : n === 1 ? S[m.key][0] : `${n} selected`; };
const msHtml = m => `<div class="f ms" data-ms="${m.key}"><label>${m.label}</label>
  <button type="button" class="ms-btn" aria-haspopup="true" aria-expanded="false"><span class="ms-text">${V.esc(msText(m))}</span><span class="ms-caret">▾</span></button>
  <div class="ms-pop" hidden>${m.search ? '<input type="search" class="ms-search" placeholder="Search…" aria-label="Search options">' : ''}
    <div class="ms-actions"><button type="button" data-ms-all>Select all</button><button type="button" data-ms-clear>Clear</button></div>
    <div class="ms-list">${m.opts().map(o => `<label class="ms-opt"><input type="checkbox" data-ms-key="${m.key}" value="${V.esc(o)}" ${S[m.key].includes(o) ? 'checked' : ''}> <span>${V.esc(o)}</span></label>`).join('')}</div>
  </div></div>`;
const msRefresh = k => { const m = MS.find(x => x.key === k); document.querySelector(`[data-ms="${k}"] .ms-text`).textContent = msText(m); };
const closeMs = () => document.querySelectorAll('.ms').forEach(el => { el.querySelector('.ms-pop').hidden = true; el.querySelector('.ms-btn').setAttribute('aria-expanded', 'false'); });

function renderFilters() {
  // Order date: visible buttons (click the active one again to clear = all dates) + From/To always shown. The resolved range is printed so it is never ambiguous.
  const presets = [['today', 'Today'], ['yesterday', 'Yesterday'], ['lastweek', 'Last week'], ['lastmonth', 'Last month'], ['custom', 'Custom']];
  const [ra, rb] = range();
  const rangeText = S.preset === 'all' ? 'All dates' : ra === '0000' && rb === '9999' ? 'Pick From / To' : ra === '0000' ? `Up to ${V.fmtD(rb)}` : rb === '9999' ? `From ${V.fmtD(ra)}` : ra === rb ? V.fmtD(ra) : `${V.fmtD(ra)} – ${V.fmtD(rb)}`;
  $('filters').innerHTML =
    `<div class="f"><label>Order date</label><div class="chips">${presets.map(([k, l]) => `<button type="button" data-preset="${k}" class="${S.preset === k ? 'on' : ''}" aria-pressed="${S.preset === k}">${l}</button>`).join('')}</div><span class="muted rangeNote">${rangeText}</span></div>` +
    (S.preset === 'custom' ? `<div class="f"><label for="fFrom">From</label><input type="date" id="fFrom" value="${S.from}"></div><div class="f"><label for="fTo">To</label><input type="date" id="fTo" value="${S.to}"></div>` : '') +
    MS.map(msHtml).join('') +
    `<div class="f reset"><label>&nbsp;</label><button class="btn" id="fReset">Reset</button></div>`;
}

// ---------- render ----------
function render() {
  const rows = filtered(), J = journey(rows);
  $('kpis').innerHTML = V.kpis(rows, J);
  if (!$('modal').hidden) renderModal();
  $('journey').innerHTML = V.journeyView(J, Q(rows));
  $('journeyNote').textContent = `${V.n0(Q(rows))} pieces in view · all figures are quantity (pcs) · % of filtered total`;
  $('journeyWarn').innerHTML = V.coverageWarn(rows);
  $('trend').innerHTML = V.trendView(rows, S.grain);
  document.querySelectorAll('#grain button').forEach(b => b.classList.toggle('on', b.dataset.g === S.grain));
  $('compare').innerHTML = V.compareView(rows);
  $('vendors').innerHTML = V.vendorView(vendorStats(rows), S.vendorSort);
  document.querySelectorAll('#vendorSort button').forEach(b => b.classList.toggle('on', b.dataset.s === S.vendorSort));
  renderTable(rows);
  $('logicBody').innerHTML = V.logicView(new Date(S.meta.at).toLocaleString('en-IN'), S.meta.source);
  const dq = dataQuality(S.rows);
  $('dqPill').textContent = dq.unmatched ? `⚠ ${V.n0(dq.unmatched)} pcs unmapped` : '✓ All orders mapped';
  $('dqPill').className = 'pill ' + (dq.unmatched ? 'warn' : 'ok');
  $('freshness').textContent = `${S.meta.source === 'live' ? 'Live' : 'Snapshot'} · ${new Date(S.meta.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`;
}

function tableRows(rows) {
  let x = rows;
  if (S.actionOnly) x = x.filter(r => r.status === STATUS.DELAYED || r.status === STATUS.AT_RISK || r.status === STATUS.REVIEW);
  if (S.q) { const q = S.q.toLowerCase(); x = x.filter(r => r.search.includes(q)); }
  const col = V.COLUMNS.find(c => c.k === S.sort.key) || V.COLUMNS[0];
  return [...x].sort((a, b) => { const A = col.sort(a), B = col.sort(b); return (A < B ? -1 : A > B ? 1 : 0) * S.sort.dir || b.overallAge - a.overallAge; });
}
function renderTable(rows) {
  const all = tableRows(rows ?? filtered()), pages = Math.max(1, Math.ceil(all.length / CONFIG.PAGE_SIZE));
  S.page = Math.min(S.page, pages - 1);
  const slice = all.slice(S.page * CONFIG.PAGE_SIZE, (S.page + 1) * CONFIG.PAGE_SIZE);
  $('table').innerHTML = V.tableView(slice, S.cols, S.sort);
  $('tableNote').textContent = S.actionOnly ? 'Delayed, at-risk or converted-to-RTS orders, most delayed first' : 'All orders in view';
  $('pager').innerHTML = `<span>${V.n0(all.length)} records · ${V.n0(Q(all))} pcs · page ${S.page + 1} of ${pages}</span><span><button class="btn" data-pg="-1" ${S.page ? '' : 'disabled'}>Previous</button> <button class="btn" data-pg="1" ${S.page < pages - 1 ? '' : 'disabled'}>Next</button></span>`;
  $('colMenu').innerHTML = V.COLUMNS.map(c => `<label><input type="checkbox" data-col="${c.k}" ${S.cols.includes(c.k) ? 'checked' : ''}> ${c.h}</label>`).join('');
}

// ---------- KPI popup ----------
const M = { key: null, q: '', limit: 100 };
// card popups follow the filters; the unmapped list always covers every date
const popupSource = () => (V.KPI_DEFS[M.key].allDates ? S.rows : filtered());
function renderModal() {
  const all = V.popupRows(popupSource(), M.key, M.q);
  $('modalTitle').textContent = V.KPI_DEFS[M.key].title;
  $('modalBody').innerHTML = V.popupView(M.key, all, M.limit);
}
function openModal(key) {
  Object.assign(M, { key, q: '', limit: 100 }); $('mq').value = '';
  $('modal').hidden = false; renderModal(); $('modalBody').scrollTop = 0;
}
function closeModal() { $('modal').hidden = true; }

// ---------- tabs ----------
function showTab(name) {
  $('tab-dash').hidden = name !== 'dash'; $('tab-logic').hidden = name !== 'logic';
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  closeDrawer(); window.scrollTo({ top: 0 });
  try { history.replaceState(null, '', name === 'logic' ? '#logic' : location.pathname); } catch {}
}

// ---------- drawer ----------
function openDrawer(id) {
  const r = S.rows.find(x => x.line_id === id); if (!r) return;
  const d = $('drawer'); d.innerHTML = V.drawerView(r); d.hidden = false;
  if (!$('scrim')) { const s = document.createElement('div'); s.id = 'scrim'; s.className = 'scrim'; document.body.appendChild(s); }
  d.querySelector('.close').focus();
}
function closeDrawer() { $('drawer').hidden = true; $('scrim')?.remove(); }

// ---------- events ----------
const set = (k, v) => { S[k] = v; S.page = 0; render(); };
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'fFrom' || t.id === 'fTo') { S[t.id === 'fFrom' ? 'from' : 'to'] = t.value; S.preset = 'custom'; S.page = 0; renderFilters(); render(); return; }
  if (t.dataset.msKey) { const k = t.dataset.msKey; S[k] = t.checked ? (S[k].includes(t.value) ? S[k] : S[k].concat(t.value)) : S[k].filter(v => v !== t.value); S.page = 0; msRefresh(k); render(); return; }
  if (t.id === 'actionOnly') set('actionOnly', t.checked);
  else if (t.dataset.col) { S.cols = V.COLUMNS.map(c => c.k).filter(k => (k === t.dataset.col ? t.checked : S.cols.includes(k))); store('mto.cols.v3', S.cols); renderTable(); }
});
document.addEventListener('input', e => { if (e.target.id === 'q') { S.q = e.target.value; S.page = 0; renderTable(); } else if (e.target.id === 'mq') { M.q = e.target.value; M.limit = 100; renderModal(); } else if (e.target.classList?.contains('ms-search')) { const s = e.target.value.toLowerCase(); e.target.closest('.ms').querySelectorAll('.ms-opt').forEach(l => (l.hidden = !l.textContent.toLowerCase().includes(s))); } });
document.addEventListener('click', e => {
  const t = e.target, c = sel => t.closest(sel);
  const msEl = c('.ms');
  if (c('.ms-btn')) { const pop = msEl.querySelector('.ms-pop'), willOpen = pop.hidden; closeMs(); pop.hidden = !willOpen; msEl.querySelector('.ms-btn').setAttribute('aria-expanded', String(willOpen)); if (willOpen) msEl.querySelector('.ms-search')?.focus(); return; }
  if (c('[data-ms-all]') || c('[data-ms-clear]')) { const k = msEl.dataset.ms, m = MS.find(x => x.key === k); S[k] = c('[data-ms-all]') ? m.opts().slice() : []; msEl.querySelectorAll('input[type=checkbox]').forEach(i => (i.checked = S[k].includes(i.value))); S.page = 0; msRefresh(k); render(); return; }
  if (!msEl) closeMs();
  if (c('[data-preset]')) { const p = c('[data-preset]').dataset.preset; S.preset = S.preset === p ? 'all' : p; if (S.preset !== 'custom') { S.from = ''; S.to = ''; } S.page = 0; renderFilters(); return render(); }
  if (c('#fReset')) { Object.assign(S, { preset: 'lastmonth', from: '', to: '', type: [], vendor: [], storeCode: [], stage: [], status: [] }); renderFilters(); return render(); }
  if (c('#refreshBtn')) { t.textContent = 'Refreshing…'; return load(true).then(() => { renderFilters(); render(); }).catch(() => alert('Refresh failed')).finally(() => (t.textContent = 'Refresh')); }
  if (c('[data-kpi]')) return openModal(c('[data-kpi]').dataset.kpi);
  if (c('[data-mclose]')) return closeModal();
  if (c('[data-more]')) { M.limit += 200; return renderModal(); }
  if (c('#mExport')) { const rows = V.popupRows(popupSource(), M.key, M.q), b = new Blob([V.csv(rows, V.popupCols(M.key))], { type: 'text/csv' }), a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `mto-${M.key}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); return; }
  if (c('#dqPill')) return openModal('unmapped');
  if (c('#tabs button')) return showTab(c('#tabs button').dataset.tab);
  if (c('#colBtn')) { $('colMenu').hidden = !$('colMenu').hidden; return; }
  if (!c('.menu')) $('colMenu').hidden = true;
  if (c('#exportBtn')) { const b = new Blob([V.csv(tableRows(filtered()), S.cols)], { type: 'text/csv' }), a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `mto-orders-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); return; }
  if (c('#grain button')) return set('grain', c('#grain button').dataset.g);
  if (c('#vendorSort button')) return set('vendorSort', c('#vendorSort button').dataset.s);
  if (c('[data-pg]')) { S.page += +c('[data-pg]').dataset.pg; return renderTable(); }
  if (c('th[data-sort]')) { const k = c('th[data-sort]').dataset.sort; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : -1 }; return renderTable(); }
  if (c('tr[data-line]')) return openDrawer(c('tr[data-line]').dataset.line);
  if (c('[data-close]') || c('#scrim')) closeDrawer();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (document.querySelector('.ms-pop:not([hidden])')) closeMs(); else if (!$('drawer').hidden) closeDrawer(); else closeModal(); }
  else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-kpi]')) { e.preventDefault(); openModal(e.target.dataset.kpi); }
});

// tooltip (delegated; works for HTML and SVG marks)
const tipEl = $('tip');
document.addEventListener('pointermove', e => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) { tipEl.hidden = true; return; }
  tipEl.textContent = el.dataset.tip; tipEl.hidden = false;
  tipEl.style.left = Math.min(e.clientX + 14, innerWidth - tipEl.offsetWidth - 8) + 'px'; tipEl.style.top = e.clientY + 16 + 'px';
});

load().then(() => { const dp = (location.hash.match(/date=([a-z]+)/) || [])[1]; if (['today', 'yesterday', 'lastweek', 'lastmonth', 'custom'].includes(dp)) S.preset = dp; const hp = new URLSearchParams(location.hash.slice(1)); [['type', 'type'], ['vendor', 'vendor'], ['store', 'storeCode'], ['stage', 'stage'], ['status', 'status']].forEach(([h, k]) => { if (hp.get(h)) S[k] = hp.get(h).split('|'); }); renderFilters(); render(); if (location.hash === '#logic') showTab('logic'); const hk = (location.hash.match(/^#kpi=([a-z]+)/) || [])[1]; if (hk && V.KPI_DEFS[hk]) openModal(hk); }).catch(err => { document.querySelector('main').innerHTML = `<div class="card empty">Could not load MTO data. ${V.esc(err.message)}</div>`; });
