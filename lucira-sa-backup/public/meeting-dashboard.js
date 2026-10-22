function formatCount(n) {
  return new Intl.NumberFormat('en-IN').format(n || 0);
}

function formatAmount(n) {
  if (!n) return '₹0';
  return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

function formatPct(n) {
  return `${(n || 0).toFixed(1)}%`;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDateOnly(dateKey) {
  if (!dateKey) return '—';
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function showStatus(message) {
  const bar = document.getElementById('statusBar');
  if (!message) {
    bar.hidden = true;
    bar.textContent = '';
    bar.style.color = '';
    return;
  }
  bar.hidden = false;
  bar.style.color = '';
  bar.textContent = `⚠ ${message}`;
}

// Same bar as showStatus, styled neutral instead of the error red — a cold
// load pulls ~30k Deals live from Zoho page-by-page and can take up to 30
// seconds, so without this the page just looks blank/broken for that long.
function showLoading(message) {
  const bar = document.getElementById('statusBar');
  bar.hidden = false;
  bar.style.color = 'var(--text-secondary)';
  bar.textContent = message;
}

function cell(html, className, isHtml, rawValue) {
  const td = document.createElement('td');
  if (className) td.className = className;
  if (isHtml) td.innerHTML = html;
  else td.textContent = html;
  if (rawValue !== undefined && rawValue !== null) td.dataset.raw = rawValue;
  return td;
}

// -----------------------------------------------------------------------
// Reusable checkbox multiselect (same pattern used across this app's other
// dashboards, e.g. old-gold.js / refill-management.js)
// -----------------------------------------------------------------------
function setupMultiselect({ toggleId, panelId, allLabel, onChange }) {
  const toggle = document.getElementById(toggleId);
  const panel = document.getElementById(panelId);
  let values = [];
  let labels = new Map();
  let selected = [];

  function updateToggleLabel() {
    if (!selected.length) toggle.textContent = allLabel;
    else if (selected.length === 1) toggle.textContent = labels.get(selected[0]) || selected[0];
    else toggle.textContent = `${selected.length} selected`;
  }

  function renderPanel() {
    panel.innerHTML = '';
    const allRow = document.createElement('label');
    allRow.className = 'multiselect-option multiselect-option--all';
    const allCheckbox = document.createElement('input');
    allCheckbox.type = 'checkbox';
    allCheckbox.checked = selected.length === 0;
    allCheckbox.addEventListener('change', () => {
      selected = [];
      updateToggleLabel();
      renderPanel();
      onChange(selected);
    });
    allRow.appendChild(allCheckbox);
    allRow.appendChild(document.createTextNode(allLabel));
    panel.appendChild(allRow);

    values.forEach(v => {
      const row = document.createElement('label');
      row.className = 'multiselect-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.includes(v);
      checkbox.addEventListener('change', () => {
        selected = checkbox.checked ? [...selected, v] : selected.filter(s => s !== v);
        updateToggleLabel();
        renderPanel();
        onChange(selected);
      });
      row.appendChild(checkbox);
      row.appendChild(document.createTextNode(labels.get(v) || v));
      panel.appendChild(row);
    });
  }

  toggle.addEventListener('click', () => {
    const willOpen = panel.hidden;
    document.querySelectorAll('.multiselect-panel').forEach(p => { p.hidden = true; });
    panel.hidden = !willOpen;
  });

  document.addEventListener('click', e => {
    if (!panel.hidden && !toggle.contains(e.target) && !panel.contains(e.target)) {
      panel.hidden = true;
    }
  });

  return {
    // options: either an array of strings, or an array of { key, label }
    setValues(options) {
      values = options.map(o => (typeof o === 'string' ? o : o.key));
      labels = new Map(options.map(o => (typeof o === 'string' ? [o, o] : [o.key, o.label])));
      renderPanel();
    },
    getSelected() { return selected; },
  };
}

// -----------------------------------------------------------------------
// State
// -----------------------------------------------------------------------
let lastData = null;
let searchTerm = '';
const filters = { dateFrom: null, dateTo: null, store: [], agent: [], city: [], status: [] };

// skipDate is used for the "Today's Meetings" table / KPI — that section is
// inherently about literal today, so it stays independent of whatever Date
// range the person has picked (otherwise the default "Yesterday" range would
// make it read empty every day).
function applyMeetingFilters(meetings, { skipDate } = {}) {
  return meetings.filter(m => {
    if (!skipDate) {
      if (filters.dateFrom && m.dateKey && m.dateKey < filters.dateFrom) return false;
      if (filters.dateTo && m.dateKey && m.dateKey > filters.dateTo) return false;
    }
    if (filters.store.length && !filters.store.includes(m.storeKey)) return false;
    if (filters.agent.length && !filters.agent.includes(m.agent)) return false;
    if (filters.city.length && !filters.city.includes(m.city)) return false;
    if (filters.status.length && !filters.status.includes(m.status)) return false;
    return true;
  });
}

// Deals have no store or meeting-status dimension, so only Date/Agent/City
// apply here — the Store and Meeting Status filters are left as a no-op for
// this section (disclosed in the Logic box, since Deals has no reliable
// per-store field to filter by).
function applyDealFilters(deals) {
  return deals.filter(d => {
    if (filters.dateFrom && d.dateKey && d.dateKey < filters.dateFrom) return false;
    if (filters.dateTo && d.dateKey && d.dateKey > filters.dateTo) return false;
    if (filters.agent.length && !filters.agent.includes(d.agent)) return false;
    if (filters.city.length && !filters.city.includes(d.cityGroup || 'Unknown')) return false;
    return true;
  });
}

function applyMeetingSearch(meetings) {
  const term = searchTerm.trim().toLowerCase();
  if (!term) return meetings;
  return meetings.filter(m => {
    const haystack = [m.agent, m.storeKey, m.city, m.customerName, m.status]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(term);
  });
}

// -----------------------------------------------------------------------
// KPIs
// -----------------------------------------------------------------------
function renderKpis(filteredMeetings, filteredDeals, todayMeetings) {
  const container = document.getElementById('kpiGrid');
  container.innerHTML = '';

  const totalDeals = filteredDeals.length;
  const cityDeals = filteredDeals.filter(d => d.cityRaw).length;
  const meetingsRaised = filteredMeetings.length;
  const meetingsToday = todayMeetings.filter(m => m.visitDateKey === lastData.today).length;
  const called = filteredMeetings.filter(m => m.calledByStore).length;
  const notCalled = meetingsRaised - called;
  const walkins = filteredMeetings.filter(m => m.walkinDateKey).length;
  const orders = filteredMeetings.filter(m => m.orderWon).length;

  // highlight marks the headline metrics called out by name in the design
  // brief (Total Deals, City Deals, Store Visits, Today's Fixed Meetings,
  // Walk-ins, Orders) for the gold-accented treatment; everything else is a
  // plain supporting KPI card.
  const kpis = [
    { label: 'Total Deals', value: formatCount(totalDeals), highlight: true },
    { label: 'Total City Deals', value: formatCount(cityDeals), highlight: true },
    { label: 'Store Visits / Meetings Raised', value: formatCount(meetingsRaised), highlight: true },
    { label: 'Meetings Fixed Today', value: formatCount(meetingsToday), highlight: true },
    { label: 'Called by Store', value: formatCount(called) },
    { label: 'Not Called by Store', value: formatCount(notCalled) },
    { label: 'Walk-ins (from Store Visits)', value: formatCount(walkins), highlight: true },
    { label: 'Orders (from Store-Visit Customers)', value: formatCount(orders), highlight: true },
    { label: 'Meeting → Walk-in %', value: formatPct(meetingsRaised ? (walkins / meetingsRaised) * 100 : 0) },
    { label: 'Walk-in → Order %', value: formatPct(walkins ? (orders / walkins) * 100 : 0) },
  ];

  kpis.forEach(k => {
    const card = document.createElement('div');
    card.className = k.highlight ? 'kpi-card kpi-card--highlight' : 'kpi-card';
    card.innerHTML = `<div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div>`;
    container.appendChild(card);
  });
}

// -----------------------------------------------------------------------
// Generic small summary table renderer
// -----------------------------------------------------------------------
function renderSummaryTable(containerId, columns, rows, totalRow, emptyMessage, extraWrapClass) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = extraWrapClass ? `table-wrap table-wrap--spaced ${extraWrapClass}` : 'table-wrap table-wrap--spaced';
  const table = document.createElement('table');
  table.className = 'report-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length;
    td.className = 'cell-muted';
    td.style.textAlign = 'center';
    td.textContent = emptyMessage;
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    rows.forEach(row => {
      const tr = document.createElement('tr');
      columns.forEach(col => tr.appendChild(cell(col.get(row), col.className ? col.className(row) : null, col.isHtml)));
      tbody.appendChild(tr);
    });
    if (totalRow) {
      const tr = document.createElement('tr');
      tr.className = 'row-total';
      columns.forEach(col => tr.appendChild(cell(col.get(totalRow), null, col.isHtml)));
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

// -----------------------------------------------------------------------
// Deals by City
// -----------------------------------------------------------------------
function renderCityDeals(deals) {
  const byCity = new Map();
  let noCityCount = 0;
  deals.forEach(d => {
    if (!d.cityRaw) { noCityCount += 1; return; }
    const key = d.cityRaw;
    if (!byCity.has(key)) byCity.set(key, { city: key, count: 0 });
    byCity.get(key).count += 1;
  });

  const rows = [...byCity.values()].sort((a, b) => b.count - a.count);
  const total = {
    city: 'GRAND TOTAL (known city)',
    count: rows.reduce((s, r) => s + r.count, 0),
  };

  const columns = [
    { label: 'City', get: r => r.city },
    { label: 'Deals', get: r => formatCount(r.count) },
  ];

  renderSummaryTable('cityDealsContainer', columns, rows, rows.length ? total : null,
    'No deals with a known Address_City for the current filters', 'md-table-compact table-wrap--scroll-y');

  if (noCityCount) {
    const note = document.createElement('p');
    note.className = 'th-sub';
    note.style.margin = '-4px 0 16px';
    note.textContent = `${formatCount(noCityCount)} deal(s) in the current filters have no recorded city and aren't in this table.`;
    document.getElementById('cityDealsContainer').appendChild(note);
  }
}

// -----------------------------------------------------------------------
// Store-wise Meetings (raised / called / not called)
// -----------------------------------------------------------------------
function renderStoreMeetings(meetings) {
  const byStore = new Map();
  lastData.stores.forEach(s => byStore.set(s.key, { store: s.label, raised: 0, called: 0 }));
  meetings.forEach(m => {
    if (!byStore.has(m.storeKey)) byStore.set(m.storeKey, { store: m.storeKey, raised: 0, called: 0 });
    const row = byStore.get(m.storeKey);
    row.raised += 1;
    if (m.calledByStore) row.called += 1;
  });

  const rows = [...byStore.values()].filter(r => r.raised > 0).sort((a, b) => b.raised - a.raised);
  const total = {
    store: 'GRAND TOTAL',
    raised: rows.reduce((s, r) => s + r.raised, 0),
    called: rows.reduce((s, r) => s + r.called, 0),
  };

  const columns = [
    { label: 'Store', get: r => r.store },
    { label: 'Meetings Raised', get: r => formatCount(r.raised) },
    { label: 'Called by Store', get: r => formatCount(r.called) },
    { label: 'Not Called by Store', get: r => formatCount(r.raised - r.called) },
    { label: 'Called %', get: r => formatPct(r.raised ? (r.called / r.raised) * 100 : 0) },
  ];

  renderSummaryTable('storeMeetingsContainer', columns, rows, rows.length ? total : null,
    'No meetings for the current filters');
}

// -----------------------------------------------------------------------
// Store-wise Conversion — Meeting -> Walk-in -> Order
// -----------------------------------------------------------------------
function renderConversion(meetings) {
  const byStore = new Map();
  lastData.stores.forEach(s => byStore.set(s.key, { store: s.label, meetings: 0, walkins: 0, orders: 0 }));
  meetings.forEach(m => {
    if (!byStore.has(m.storeKey)) byStore.set(m.storeKey, { store: m.storeKey, meetings: 0, walkins: 0, orders: 0 });
    const row = byStore.get(m.storeKey);
    row.meetings += 1;
    if (m.walkinDateKey) row.walkins += 1;
    if (m.orderWon) row.orders += 1;
  });

  const rows = [...byStore.values()].filter(r => r.meetings > 0).sort((a, b) => b.meetings - a.meetings);
  const total = {
    store: 'GRAND TOTAL',
    meetings: rows.reduce((s, r) => s + r.meetings, 0),
    walkins: rows.reduce((s, r) => s + r.walkins, 0),
    orders: rows.reduce((s, r) => s + r.orders, 0),
  };

  const columns = [
    { label: 'Store', get: r => r.store },
    { label: 'Meetings', get: r => formatCount(r.meetings) },
    { label: 'Walk-ins', get: r => formatCount(r.walkins) },
    { label: 'Orders', get: r => formatCount(r.orders) },
    { label: 'Meeting → Walk-in %', get: r => formatPct(r.meetings ? (r.walkins / r.meetings) * 100 : 0) },
    { label: 'Walk-in → Order %', get: r => formatPct(r.walkins ? (r.orders / r.walkins) * 100 : 0) },
    { label: 'Meeting → Order %', get: r => formatPct(r.meetings ? (r.orders / r.meetings) * 100 : 0) },
  ];

  renderSummaryTable('conversionContainer', columns, rows, rows.length ? total : null,
    'No meetings for the current filters');
}

// -----------------------------------------------------------------------
// Today's Meetings
// -----------------------------------------------------------------------
function statusBadgeHtml(status) {
  const map = {
    upcoming: ['badge-neutral', 'Upcoming'],
    today: ['badge-accent', 'Today'],
    visited: ['badge-good', 'Visited'],
    not_visited: ['badge-critical', 'Not Visited'],
  };
  const [cls, label] = map[status] || ['badge-neutral', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function calledBadgeHtml(calledByStore) {
  return calledByStore
    ? '<span class="badge badge-good">Called</span>'
    : '<span class="badge badge-critical">Not Called</span>';
}

function storeLabelOf(storeKey) {
  const s = lastData.stores.find(x => x.key === storeKey);
  return s ? s.label : storeKey;
}

function renderTodaysMeetings(allFilteredMeetings) {
  const todays = allFilteredMeetings.filter(m => m.visitDateKey === lastData.today)
    .slice().sort((a, b) => new Date(a.dateTimeIso || 0) - new Date(b.dateTimeIso || 0));

  document.getElementById('todaysMeetingsMeta').textContent = `${formatCount(todays.length)} meeting(s) fixed for today`;

  const columns = [
    { label: 'Meeting Date/Time', get: r => formatDateTime(r.dateTimeIso) },
    { label: 'Store', get: r => storeLabelOf(r.storeKey) },
    { label: 'Agent', get: r => r.agent },
    { label: 'Customer', get: r => r.customerName || '—' },
    { label: 'Called by Store', get: r => calledBadgeHtml(r.calledByStore), isHtml: true },
    { label: 'Status', get: r => statusBadgeHtml(r.status), isHtml: true },
  ];

  renderSummaryTable('todaysMeetingsContainer', columns, todays, null,
    'No meetings fixed for today under the current filters', 'table-wrap--scroll-y');
}

// -----------------------------------------------------------------------
// All Meetings (sortable, searchable, exportable)
// -----------------------------------------------------------------------
const ALL_MEETINGS_COLUMNS = [
  { label: 'Raised Date', key: 'dateKey' },
  { label: 'Visit Date', key: 'visitDateKey' },
  { label: 'Store', key: 'storeLabel' },
  { label: 'City', key: 'city' },
  { label: 'Agent', key: 'agent' },
  { label: 'Customer', key: 'customerName' },
  { label: 'Called by Store', key: 'calledByStore' },
  { label: 'Status', key: 'status' },
  { label: 'Walk-in Date', key: 'walkinDateKey' },
  { label: 'Order', key: 'orderWon' },
  { label: 'Order Date', key: 'orderDateKey' },
];

let meetingSort = { key: 'dateKey', dir: 'desc' };

function compareRows(a, b, key) {
  const va = a[key];
  const vb = b[key];
  if (va == null && vb == null) return 0;
  if (va == null) return -1;
  if (vb == null) return 1;
  if (typeof va === 'boolean' && typeof vb === 'boolean') return (va === vb) ? 0 : (va ? 1 : -1);
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).toLowerCase().localeCompare(String(vb).toLowerCase());
}

function applyMeetingSort(rows) {
  const dir = meetingSort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => dir * compareRows(a, b, meetingSort.key));
}

function buildMeetingRowEl(r) {
  const tr = document.createElement('tr');
  tr.appendChild(cell(formatDateOnly(r.dateKey)));
  tr.appendChild(cell(formatDateOnly(r.visitDateKey)));
  tr.appendChild(cell(storeLabelOf(r.storeKey)));
  tr.appendChild(cell(r.city));
  tr.appendChild(cell(r.agent));
  tr.appendChild(cell(r.customerName || '—', r.customerName ? null : 'cell-muted'));
  tr.appendChild(cell(calledBadgeHtml(r.calledByStore), null, true, r.calledByStore ? 'Called' : 'Not Called'));
  tr.appendChild(cell(statusBadgeHtml(r.status), null, true));
  tr.appendChild(cell(r.walkinDateKey ? formatDateOnly(r.walkinDateKey) : '—', r.walkinDateKey ? null : 'cell-muted'));
  tr.appendChild(cell(r.orderWon ? formatAmount(r.orderAmount) : '—', r.orderWon ? 'cell-won' : 'cell-muted'));
  tr.appendChild(cell(r.orderDateKey ? formatDateOnly(r.orderDateKey) : '—', r.orderDateKey ? null : 'cell-muted'));
  return tr;
}

function renderAllMeetings(rows) {
  const container = document.getElementById('allMeetingsContainer');
  container.innerHTML = '';

  // storeLabel is derived here (not stored on the row) purely so it's
  // sortable/searchable by the same key the column header uses.
  const withLabel = rows.map(r => ({ ...r, storeLabel: storeLabelOf(r.storeKey) }));
  const sorted = applyMeetingSort(withLabel);

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap table-wrap--scroll-y table-wrap--spaced';
  const table = document.createElement('table');
  table.className = 'report-table';
  table.id = 'allMeetingsTable';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ALL_MEETINGS_COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.className = 'sortable-th';
    th.dataset.sortKey = col.key;
    th.textContent = col.label;

    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    if (meetingSort.key === col.key) arrow.textContent = meetingSort.dir === 'asc' ? '▲' : '▼';
    th.appendChild(arrow);

    th.addEventListener('click', () => {
      meetingSort = meetingSort.key === col.key
        ? { key: col.key, dir: meetingSort.dir === 'asc' ? 'desc' : 'asc' }
        : { key: col.key, dir: 'desc' };
      render();
    });

    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!sorted.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = ALL_MEETINGS_COLUMNS.length;
    td.className = 'cell-muted';
    td.style.textAlign = 'center';
    td.textContent = 'No meetings for the current filters';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    sorted.forEach(r => tbody.appendChild(buildMeetingRowEl(r)));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'export-btn';
  exportBtn.dataset.exportTable = 'allMeetingsTable';
  exportBtn.dataset.exportFilename = 'meetings';
  exportBtn.innerHTML = '&#8595; Export CSV';
  container.appendChild(exportBtn);
}

// -----------------------------------------------------------------------
// Data notes (Logic box)
// -----------------------------------------------------------------------
function renderDataNotes() {
  const list = document.getElementById('dataNotesList');
  list.innerHTML = '';
  (lastData.meta.dataNotes || []).forEach(note => {
    const li = document.createElement('li');
    li.textContent = note;
    list.appendChild(li);
  });
}

// -----------------------------------------------------------------------
// CSV export (same pattern as old-gold.js)
// -----------------------------------------------------------------------
function csvEscape(text) {
  const s = String(text ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tableToCSV(table) {
  const lines = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = Array.from(tr.children).map(td => csvEscape(
      td.dataset.raw !== undefined ? td.dataset.raw : td.textContent.trim()
    ));
    lines.push(cells.join(','));
  });
  return lines.join('\r\n');
}

function downloadCSV(filename, csvContent) {
  const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.export-btn');
  if (!btn) return;
  const table = document.getElementById(btn.dataset.exportTable);
  if (!table) return;
  downloadCSV(btn.dataset.exportFilename, tableToCSV(table));
});

// -----------------------------------------------------------------------
// Render orchestration
// -----------------------------------------------------------------------
// The search box only narrows the "All Meetings" detail table (same
// convention as old-gold.js's table search) — the KPI cards and every
// summary table above it always reflect the full Date/Store/Agent/City/
// Status-filtered picture, regardless of what's typed.
function render() {
  if (!lastData) return;
  const filteredMeetings = applyMeetingFilters(lastData.meetings);
  const todayMeetings = applyMeetingFilters(lastData.meetings, { skipDate: true });
  const filteredDeals = applyDealFilters(lastData.deals);

  renderKpis(filteredMeetings, filteredDeals, todayMeetings);
  renderCityDeals(filteredDeals);
  renderStoreMeetings(filteredMeetings);
  renderConversion(filteredMeetings);
  renderTodaysMeetings(todayMeetings);
  renderAllMeetings(applyMeetingSearch(filteredMeetings));
}

// 'YYYY-MM-DD' + a day offset, without touching the calendar-day boundary a
// timezone-aware Date object would introduce.
function addDaysToDateKey(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

const storeMs = setupMultiselect({ toggleId: 'storeToggle', panelId: 'storePanel', allLabel: 'All stores', onChange: v => { filters.store = v; } });
const agentMs = setupMultiselect({ toggleId: 'agentToggle', panelId: 'agentPanel', allLabel: 'All agents', onChange: v => { filters.agent = v; } });
const cityMs = setupMultiselect({ toggleId: 'cityToggle', panelId: 'cityPanel', allLabel: 'All cities', onChange: v => { filters.city = v; } });
const statusMs = setupMultiselect({ toggleId: 'statusToggle', panelId: 'statusPanel', allLabel: 'All statuses', onChange: v => { filters.status = v; } });

function setupFilterOptions() {
  storeMs.setValues(lastData.stores);
  agentMs.setValues(lastData.agents);
  cityMs.setValues(lastData.cities);
  statusMs.setValues(lastData.statuses);
}

document.getElementById('applyFilters').addEventListener('click', () => {
  filters.dateFrom = document.getElementById('dateFrom').value || null;
  filters.dateTo = document.getElementById('dateTo').value || null;
  render();
});

document.getElementById('meetingSearch').addEventListener('input', e => {
  searchTerm = e.target.value;
  render();
});

// Only applied once, on first load — a manual Refresh click shouldn't stomp
// on a date range the person has since chosen via Apply.
let defaultDateRangeApplied = false;

async function loadData(forceRefresh) {
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.disabled = true;
  showLoading(lastData ? 'Refreshing…' : 'Loading meeting dashboard — Deals is pulled live from Zoho, so a cold load can take up to 30 seconds…');
  try {
    const res = await fetch(`/api/meeting-dashboard${forceRefresh ? '?refresh=true' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);

    lastData = data;
    setupFilterOptions();
    renderDataNotes();

    if (!defaultDateRangeApplied) {
      defaultDateRangeApplied = true;
      const yesterday = addDaysToDateKey(data.today, -1);
      filters.dateFrom = yesterday;
      filters.dateTo = yesterday;
      document.getElementById('dateFrom').value = yesterday;
      document.getElementById('dateTo').value = yesterday;
    }

    render();
    showStatus(null);

    document.getElementById('updatedAt').textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString('en-IN');
  } catch (err) {
    showStatus(err.message || 'Failed to load meeting dashboard data');
  } finally {
    refreshBtn.disabled = false;
  }
}

document.getElementById('refreshBtn').addEventListener('click', () => loadData(true));

document.querySelectorAll('.page-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.page-tab-btn').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.page-panel').forEach(p => p.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.getElementById(btn.dataset.panel).classList.add('is-active');
  });
});

loadData(false);
