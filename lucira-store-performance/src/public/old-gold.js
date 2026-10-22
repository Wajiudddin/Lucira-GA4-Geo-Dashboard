function formatCount(n) {
  return new Intl.NumberFormat('en-IN').format(n || 0);
}

function formatAmount(n) {
  if (!n) return '—';
  return '₹' + new Intl.NumberFormat('en-IN', { notation: 'compact', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function formatWeight(n) {
  return `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n || 0)} g`;
}

function formatDateOnly(value) {
  if (!value) return '—';
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function showStatus(message) {
  const bar = document.getElementById('statusBar');
  if (!message) {
    bar.hidden = true;
    bar.textContent = '';
    return;
  }
  bar.hidden = false;
  bar.textContent = `⚠ ${message}`;
}

// rawValue, when given, is what CSV export reads instead of the cell's
// displayed text — so a screen value like "₹67K" or "1,234" (compact/grouped
// for readability) exports as the plain number underneath (67000, 1234).
function cell(html, className, isHtml, rawValue) {
  const td = document.createElement('td');
  if (className) td.className = className;
  if (isHtml) td.innerHTML = html;
  else td.textContent = html;
  if (rawValue !== undefined && rawValue !== null) td.dataset.raw = rawValue;
  return td;
}

// -----------------------------------------------------------------------
// Reusable checkbox multiselect (same pattern as refill-management.js)
// -----------------------------------------------------------------------
function setupMultiselect({ toggleId, panelId, allLabel, onChange }) {
  const toggle = document.getElementById(toggleId);
  const panel = document.getElementById(panelId);
  let values = [];
  let selected = [];

  function updateToggleLabel() {
    if (!selected.length) toggle.textContent = allLabel;
    else if (selected.length === 1) toggle.textContent = selected[0];
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
      row.appendChild(document.createTextNode(v));
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
    setValues(newValues) { values = newValues; renderPanel(); },
    getSelected() { return selected; },
  };
}

// -----------------------------------------------------------------------
// Chart primitives — plain inline SVG (same pattern as refill-management.js)
// -----------------------------------------------------------------------
let openInfoPopover = null;
document.addEventListener('click', e => {
  if (openInfoPopover && !openInfoPopover.contains(e.target) && !e.target.classList.contains('chart-info-btn')) {
    openInfoPopover.hidden = true;
    openInfoPopover = null;
  }
});

function addChartHeader(card, title, description) {
  const header = document.createElement('div');
  header.className = 'chart-card-header';
  const h = document.createElement('h3');
  h.className = 'chart-title';
  h.textContent = title;
  header.appendChild(h);

  if (description) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chart-info-btn';
    btn.textContent = 'i';
    btn.setAttribute('aria-label', `About: ${title}`);

    const popover = document.createElement('div');
    popover.className = 'chart-info-popover';
    popover.textContent = description;
    popover.hidden = true;

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = popover.hidden;
      if (openInfoPopover && openInfoPopover !== popover) openInfoPopover.hidden = true;
      popover.hidden = !willOpen;
      openInfoPopover = willOpen ? popover : null;
    });

    header.appendChild(btn);
    header.appendChild(popover);
  }
  card.appendChild(header);
}

// Gold/Silver are always drawn in these fixed colors (not the per-store
// palette) so a metal reads the same way in every chart on the page.
const GOLD_COLOR = '#d4af37';
const SILVER_COLOR = '#9aa3af';
const OTHER_COLOR = 'var(--text-muted)';

function buildLegend(items) {
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  items.forEach(it => {
    const item = document.createElement('span');
    item.className = 'chart-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'chart-legend-swatch';
    swatch.style.background = it.color;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(it.label));
    legend.appendChild(item);
  });
  return legend;
}

// One bar per row, split into a Gold segment + a Silver segment (+ an Other
// segment when present) so both metals stay visible side by side instead of
// gold (the vast majority of volume) burying silver in a single-color bar.
// Non-zero segments get a minimum pixel width so a small silver count still
// shows up rather than rendering as an invisible sliver.
function renderStackedBarChart(container, { title, description, rows, valueFormatter }) {
  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'chart-card';
  addChartHeader(card, title, description);

  const fmt = valueFormatter || formatCount;
  const hasOther = rows.some(r => r.other > 0);

  card.appendChild(buildLegend([
    { label: 'Gold', color: GOLD_COLOR },
    { label: 'Silver', color: SILVER_COLOR },
    ...(hasOther ? [{ label: 'Other', color: OTHER_COLOR }] : []),
  ]));

  if (!rows.length || rows.every(r => !(r.gold + r.silver + r.other))) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = 'No data for the current filters';
    card.appendChild(empty);
    container.appendChild(card);
    return;
  }

  const width = 460;
  const rowHeight = 26;
  const barHeight = 16;
  const labelWidth = 110;
  const maxTotal = Math.max(...rows.map(r => r.gold + r.silver + r.other), 1);
  const plotWidth = width - labelWidth - 60;
  const height = rows.length * rowHeight + 10;

  const wrap = document.createElement('div');
  wrap.className = 'chart-svg-wrap';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);

  rows.forEach((r, i) => {
    const y = i * rowHeight + 5;
    const total = r.gold + r.silver + r.other;

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', labelWidth - 8);
    label.setAttribute('y', y + barHeight / 2 + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'chart-bar-label');
    label.textContent = r.label;
    svg.appendChild(label);

    let x = labelWidth;
    [
      { value: r.gold, color: GOLD_COLOR, name: 'Gold' },
      { value: r.silver, color: SILVER_COLOR, name: 'Silver' },
      { value: r.other, color: OTHER_COLOR, name: 'Other' },
    ].forEach(seg => {
      if (!seg.value) return;
      const segW = Math.max((seg.value / maxTotal) * plotWidth, 3);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', segW);
      rect.setAttribute('height', barHeight);
      rect.setAttribute('rx', 3);
      rect.setAttribute('fill', seg.color);
      const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      titleEl.textContent = `${r.label} ${seg.name}: ${fmt(seg.value)}`;
      rect.appendChild(titleEl);
      svg.appendChild(rect);
      x += segW;
    });

    const value = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    value.setAttribute('x', x + 6);
    value.setAttribute('y', y + barHeight / 2 + 4);
    value.setAttribute('class', 'chart-bar-value');
    value.textContent = fmt(total);
    svg.appendChild(value);
  });

  wrap.appendChild(svg);
  card.appendChild(wrap);
  container.appendChild(card);
}

// Two lines (Gold + Silver) on a shared scale, plus an Other line only when
// there's any Other volume in the current filter.
function renderMultiLineChart(container, { title, description, labels, series, valueFormatter }) {
  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'chart-card';
  addChartHeader(card, title, description);

  const fmt = valueFormatter || formatCount;
  const activeSeries = series.filter(s => s.values.some(v => v > 0));

  card.appendChild(buildLegend(activeSeries.map(s => ({ label: s.name, color: s.color }))));

  if (!labels.length || !activeSeries.length) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = 'No data for the current filters';
    card.appendChild(empty);
    container.appendChild(card);
    return;
  }

  const width = 640;
  const height = 180;
  const padding = { top: 10, right: 12, bottom: 24, left: 40 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const maxValue = Math.max(...activeSeries.flatMap(s => s.values), 1);

  const wrap = document.createElement('div');
  wrap.className = 'chart-svg-wrap';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);

  for (let i = 0; i <= 2; i++) {
    const y = padding.top + (plotH / 2) * i;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', padding.left);
    line.setAttribute('x2', width - padding.right);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('class', 'chart-gridline');
    svg.appendChild(line);
  }

  const xStep = labels.length > 1 ? plotW / (labels.length - 1) : 0;

  activeSeries.forEach(s => {
    const coords = s.values.map((v, i) => ({
      x: padding.left + i * xStep,
      y: padding.top + plotH - (v / maxValue) * plotH,
      value: v,
    }));

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' '));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', s.color);
    path.setAttribute('stroke-width', 2);
    svg.appendChild(path);

    coords.forEach((c, i) => {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', c.x);
      dot.setAttribute('cy', c.y);
      dot.setAttribute('r', 3);
      dot.setAttribute('fill', s.color);
      const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      titleEl.textContent = `${s.name} · ${labels[i]}: ${fmt(c.value)}`;
      dot.appendChild(titleEl);
      svg.appendChild(dot);
    });
  });

  [0, Math.floor(labels.length / 2), labels.length - 1].forEach(i => {
    if (i < 0 || i >= labels.length) return;
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', padding.left + i * xStep);
    label.setAttribute('y', height - 6);
    label.setAttribute('text-anchor', i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle');
    label.setAttribute('class', 'chart-bar-label');
    label.textContent = labels[i];
    svg.appendChild(label);
  });

  wrap.appendChild(svg);
  card.appendChild(wrap);
  container.appendChild(card);
}

// -----------------------------------------------------------------------
// State
// -----------------------------------------------------------------------
let allItems = [];
let lastData = null;
let searchTerm = '';
const filters = { store: [], month: [], dateFrom: null, dateTo: null };
let storeOrder = [];
let hasOtherMetal = false;

function applyFilters(rows) {
  return rows.filter(r => {
    if (filters.store.length && !filters.store.includes(r.storeCode)) return false;
    if (filters.month.length && !filters.month.includes(r.month)) return false;
    if (filters.dateFrom && r.date && r.date < filters.dateFrom) return false;
    if (filters.dateTo && r.date && r.date > filters.dateTo) return false;
    return true;
  });
}

// Scoped to the transactions table only — typing here narrows just that
// table, not the scorecards/charts/store summary above it, which stay as
// the full (Store/Month/Date-filtered) picture regardless of what's typed.
function applyTableSearch(rows) {
  const term = searchTerm.trim().toLowerCase();
  if (!term) return rows;
  return rows.filter(r => {
    // Every visible column, so the search box matches whatever's on screen
    // regardless of case.
    const haystack = [
      r.itemName, r.storeCode, r.store, r.customer, r.customerMobile,
      r.documentNo, r.location, r.transferStatus, metalTypeDisplay(r.itemName),
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(term);
  });
}

// Metal type comes from item_name ("URD GOLD" / "URD Silver" / occasional
// finished-piece names) — classified by keyword since there's no dedicated
// metal column on these rows.
function metalTypeOf(itemName) {
  const name = (itemName || '').toLowerCase();
  if (name.includes('gold')) return 'Gold';
  if (name.includes('silver')) return 'Silver';
  return 'Other';
}

// A separate scorecard row per metal (Gold, Silver, Other only when present)
// instead of one combined row. This is the only place these numbers show up
// now — the Metal Summary table was dropped as a duplicate of this section.
function renderKpis(filteredRows) {
  const container = document.getElementById('kpiGrid');
  container.innerHTML = '';

  const metals = ['Gold', 'Silver', ...(hasOtherMetal ? ['Other'] : [])];

  metals.forEach(metal => {
    const stats = metalStats(filteredRows.filter(r => metalTypeOf(r.itemName) === metal));

    const heading = document.createElement('h3');
    heading.className = 'table-heading';
    heading.textContent = metal;
    container.appendChild(heading);

    const kpis = [
      { label: 'URD Transactions', value: formatCount(stats.transactions) },
      { label: 'Items Purchased', value: formatCount(stats.items) },
      { label: 'Unique Customers', value: formatCount(stats.customers) },
      { label: 'Gross Weight', value: formatWeight(stats.grossWeight) },
      { label: 'Net Weight', value: formatWeight(stats.netWeight) },
      { label: 'Pure Weight', value: formatWeight(stats.pureWeight) },
      { label: 'Total Amount Paid', value: formatAmount(stats.amount) },
      { label: 'Avg Rate / g (pure)', value: stats.avgRate != null ? formatAmount(stats.avgRate) : '—' },
      { label: 'Transferred to HO', value: formatCount(stats.transferredToHO) },
      { label: 'Pending Transfer to HO', value: formatCount(stats.pendingToHO) },
    ];

    const grid = document.createElement('div');
    grid.className = 'kpi-grid';
    kpis.forEach(k => {
      const card = document.createElement('div');
      card.className = 'kpi-card';
      card.innerHTML = `<div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div>`;
      grid.appendChild(card);
    });
    container.appendChild(grid);
  });
}

function metalStats(rowsForMetal) {
  const pureWeight = round2(rowsForMetal.reduce((s, r) => s + r.pureWeight, 0));
  const amount = round2(rowsForMetal.reduce((s, r) => s + r.netAmount, 0));
  return {
    transactions: new Set(rowsForMetal.map(r => r.documentNo)).size,
    items: rowsForMetal.length,
    customers: new Set(rowsForMetal.map(r => r.customer).filter(Boolean)).size,
    grossWeight: round2(rowsForMetal.reduce((s, r) => s + r.grossWeight, 0)),
    netWeight: round2(rowsForMetal.reduce((s, r) => s + r.netWeight, 0)),
    pureWeight,
    amount,
    avgRate: pureWeight > 0 ? amount / pureWeight : null,
    transferredToHO: rowsForMetal.filter(r => r.transferStatus === 'Transferred').length,
    pendingToHO: rowsForMetal.filter(r => r.transferStatus === 'Pending').length,
    transferredWeight: round2(rowsForMetal.filter(r => r.transferStatus === 'Transferred').reduce((s, r) => s + r.netWeight, 0)),
    pendingWeight: round2(rowsForMetal.filter(r => r.transferStatus === 'Pending').reduce((s, r) => s + r.netWeight, 0)),
  };
}

// Splits a set of rows into Gold / Silver / Other totals using the given
// value accessor (e.g. netWeight, netAmount).
function metalSplit(rowsForBucket, valueFn) {
  const totals = { gold: 0, silver: 0, other: 0 };
  rowsForBucket.forEach(r => {
    const key = metalTypeOf(r.itemName).toLowerCase();
    totals[key] += valueFn(r);
  });
  return { gold: round2(totals.gold), silver: round2(totals.silver), other: round2(totals.other) };
}

function renderCharts(rows) {
  const grid = document.getElementById('chartsGrid');
  grid.innerHTML = '';
  const sections = Array.from({ length: 4 }, () => document.createElement('div'));
  sections.forEach(s => grid.appendChild(s));

  const netWeightByStore = storeOrder.map(code => ({
    label: code,
    ...metalSplit(rows.filter(r => r.storeCode === code), r => r.netWeight),
  }));
  renderStackedBarChart(sections[0], {
    title: 'Net Weight by Store (g)', rows: netWeightByStore,
    description: 'Total net weight of old gold purchased under URD transactions at each store, split by Gold vs Silver.',
    valueFormatter: formatWeight,
  });

  const amountByStore = storeOrder.map(code => ({
    label: code,
    ...metalSplit(rows.filter(r => r.storeCode === code), r => r.netAmount),
  }));
  renderStackedBarChart(sections[1], {
    title: 'Amount Paid by Store', rows: amountByStore,
    description: 'Total amount paid out for old gold purchased under URD transactions at each store, split by Gold vs Silver.',
    valueFormatter: formatAmount,
  });

  const months = [...new Set(rows.map(r => r.month))].sort();
  const weightByMonth = months.map(m => metalSplit(rows.filter(r => r.month === m), r => r.netWeight));
  renderMultiLineChart(sections[2], {
    title: 'Net Weight Trend (by Month)', labels: months,
    series: [
      { name: 'Gold', color: GOLD_COLOR, values: weightByMonth.map(m => m.gold) },
      { name: 'Silver', color: SILVER_COLOR, values: weightByMonth.map(m => m.silver) },
      { name: 'Other', color: OTHER_COLOR, values: weightByMonth.map(m => m.other) },
    ],
    description: 'Net weight of URD old-gold purchases per month, across all stores, split by Gold vs Silver.',
    valueFormatter: formatWeight,
  });

  const amountByMonth = months.map(m => metalSplit(rows.filter(r => r.month === m), r => r.netAmount));
  renderMultiLineChart(sections[3], {
    title: 'Amount Paid Trend (by Month)', labels: months,
    series: [
      { name: 'Gold', color: GOLD_COLOR, values: amountByMonth.map(m => m.gold) },
      { name: 'Silver', color: SILVER_COLOR, values: amountByMonth.map(m => m.silver) },
      { name: 'Other', color: OTHER_COLOR, values: amountByMonth.map(m => m.other) },
    ],
    description: 'Amount paid for URD old-gold purchases per month, across all stores, split by Gold vs Silver.',
    valueFormatter: formatAmount,
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

const STORE_SUMMARY_COLUMNS = [
  { label: 'Store', get: (store, s) => store },
  { label: 'Total Weight (g)', get: (store, s) => formatCount(s.netWeight) },
  { label: 'Transfer Weight (g)', get: (store, s) => formatCount(s.transferredWeight) },
  {
    label: 'Pending Weight (g)',
    get: (store, s) => formatCount(s.pendingWeight),
    className: (store, s) => (s.pendingWeight > 0 ? 'ageing-red' : null),
  },
];

// One table per metal (Gold, Silver, Other only when present), each broken
// out by store instead of aggregated across the whole business — plus a
// Total row per table.
function renderStoreSummaryTables(rows) {
  const container = document.getElementById('storeSummaryContainer');
  container.innerHTML = '';

  const metals = ['Gold', 'Silver', ...(hasOtherMetal ? ['Other'] : [])];

  metals.forEach(metal => {
    const metalRows = rows.filter(r => metalTypeOf(r.itemName) === metal);
    const storesForMetal = [...new Set(metalRows.map(r => r.storeCode))].sort();

    const heading = document.createElement('h3');
    heading.className = 'table-heading';
    heading.textContent = `${metal} — Store Summary`;
    container.appendChild(heading);

    const wrap = document.createElement('div');
    wrap.className = 'table-wrap table-wrap--spaced';
    const table = document.createElement('table');
    table.className = 'report-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    STORE_SUMMARY_COLUMNS.forEach(col => {
      const th = document.createElement('th');
      th.textContent = col.label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    if (!storesForMetal.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = STORE_SUMMARY_COLUMNS.length;
      td.className = 'cell-muted';
      td.style.textAlign = 'center';
      td.textContent = `No ${metal.toLowerCase()} URD purchases for the current filters`;
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      storesForMetal.forEach(store => {
        const stats = metalStats(metalRows.filter(r => r.storeCode === store));
        const tr = document.createElement('tr');
        STORE_SUMMARY_COLUMNS.forEach(col => tr.appendChild(cell(col.get(store, stats), col.className && col.className(store, stats))));
        tbody.appendChild(tr);
      });

      const totalStats = metalStats(metalRows);
      const totalTr = document.createElement('tr');
      totalTr.className = 'row-total';
      STORE_SUMMARY_COLUMNS.forEach(col => totalTr.appendChild(cell(col.get('Total', totalStats), col.className && col.className('Total', totalStats))));
      tbody.appendChild(totalTr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
  });
}

const OLD_GOLD_COLUMNS = [
  { label: 'Document No', key: 'documentNo' },
  { label: 'Date', key: 'date' },
  { label: 'Transfer Date', key: 'transferDate' },
  { label: 'Store', key: 'storeCode' },
  { label: 'Customer', key: 'customer' },
  { label: 'Mobile', key: 'customerMobile' },
  { label: 'Location', key: 'location' },
  { label: 'Gross Wt (g)', key: 'grossWeight' },
  { label: 'Net Wt (g)', key: 'netWeight' },
  { label: 'Purity (%)', key: 'purity' },
  { label: 'Pure Wt (g)', key: 'pureWeight' },
  { label: 'Net Amount', key: 'netAmount' },
  { label: 'Same Day Gold Rate', key: 'receivedRate' },
  { label: 'Today Gold Rate', key: 'todayRate' },
  { label: 'Received Amount', key: 'receivedValue' },
  { label: 'Today Amount', key: 'todayValue' },
  { label: 'Transfer to HO', key: 'transferStatus' },
  { label: 'Days to Transfer', key: 'daysToTransfer' },
  { label: 'Metal Type', key: 'itemName' },
];

let oldGoldSort = { key: 'date', dir: 'desc' };

function compareRows(a, b, key) {
  const va = a[key];
  const vb = b[key];
  if (va == null && vb == null) return 0;
  if (va == null) return -1;
  if (vb == null) return 1;
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).toLowerCase().localeCompare(String(vb).toLowerCase());
}

function applySort(rows) {
  if (!oldGoldSort.key) return rows;
  const dir = oldGoldSort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => dir * compareRows(a, b, oldGoldSort.key));
}

// The store -> HO transfer match (done server-side in oldGoldService.js, by
// store + exact net weight + purity + date order — there's no direct
// transaction link between a purchase and its later transfer) leaves every
// item in one of three states: already transferred, still Pending at the
// store, or N/A for purchases made directly at HO (which never need a
// transfer to itself).
function transferBadgeHtml(r) {
  if (r.transferStatus === 'Transferred') {
    return '<span class="badge badge-good">Transferred</span>';
  }
  if (r.transferStatus === 'N/A') {
    return '<span class="cell-muted">N/A</span>';
  }
  return '<span class="badge badge-critical">Pending</span>';
}

// "Gold"/"Silver" for the two real metals; for the rare row that's neither
// (e.g. a finished piece mis-filed under a URD document), show its actual
// item name instead of a vague "Other" bucket label.
function metalTypeDisplay(itemName) {
  const t = metalTypeOf(itemName);
  return t === 'Other' ? (itemName || '—') : t;
}

// Today Gold Rate gets an arrow against Same Day Gold Rate — green up when
// the market has moved up since this piece was bought, red down when it's
// fallen, nothing when there's no prior rate to compare or the rate is
// unchanged.
function todayRateArrowHtml(r) {
  if (r.todayRate == null) return '—';
  const rateText = formatAmount(r.todayRate);
  if (r.receivedRate == null || r.todayRate === r.receivedRate) return rateText;
  const arrow = r.todayRate > r.receivedRate
    ? '<span style="color:var(--good)">&#9650;</span>'
    : '<span style="color:var(--critical)">&#9660;</span>';
  return `${rateText} ${arrow}`;
}

function buildRow(r) {
  const tr = document.createElement('tr');
  tr.appendChild(cell(r.documentNo));
  tr.appendChild(cell(formatDateOnly(r.date)));
  tr.appendChild(cell(r.transferDate ? formatDateOnly(r.transferDate) : '—', r.transferDate ? null : 'cell-muted'));
  tr.appendChild(cell(r.storeCode));
  tr.appendChild(cell(r.customer || '—', r.customer ? null : 'cell-muted'));
  tr.appendChild(cell(r.customerMobile || '—', r.customerMobile ? null : 'cell-muted'));
  tr.appendChild(cell(r.location || '—', r.location ? null : 'cell-muted'));
  tr.appendChild(cell(formatCount(r.grossWeight), null, false, r.grossWeight));
  tr.appendChild(cell(formatCount(r.netWeight), null, false, r.netWeight));
  tr.appendChild(cell(r.purity ? `${formatCount(round2(r.purity * 100))}%` : '—', r.purity ? null : 'cell-muted', false, r.purity ? round2(r.purity * 100) : ''));
  tr.appendChild(cell(formatCount(r.pureWeight), null, false, r.pureWeight));
  tr.appendChild(cell(formatAmount(r.netAmount), null, false, r.netAmount));
  tr.appendChild(cell(r.receivedRate != null ? formatAmount(r.receivedRate) : '—', r.receivedRate != null ? null : 'cell-muted', false, r.receivedRate));
  tr.appendChild(cell(todayRateArrowHtml(r), r.todayRate != null ? null : 'cell-muted', true, r.todayRate));
  tr.appendChild(cell(r.receivedValue != null ? formatAmount(r.receivedValue) : '—', r.receivedValue != null ? null : 'cell-muted', false, r.receivedValue));
  tr.appendChild(cell(r.todayValue != null ? formatAmount(r.todayValue) : '—', r.todayValue != null ? null : 'cell-muted', false, r.todayValue));
  tr.appendChild(cell(transferBadgeHtml(r), null, true));
  tr.appendChild(cell(r.daysToTransfer != null ? formatCount(r.daysToTransfer) : '—', r.daysToTransfer != null ? null : 'cell-muted', false, r.daysToTransfer));
  tr.appendChild(cell(metalTypeDisplay(r.itemName)));
  return tr;
}

// Sums the weight/amount columns across every row currently shown — Rate,
// Purity, and the transfer-status columns don't have a meaningful sum, so
// those cells stay blank.
function buildOldGoldGrandTotalRow(rows) {
  const grossWeight = round2(rows.reduce((s, r) => s + r.grossWeight, 0));
  const netWeight = round2(rows.reduce((s, r) => s + r.netWeight, 0));
  const pureWeight = round2(rows.reduce((s, r) => s + r.pureWeight, 0));
  const netAmount = round2(rows.reduce((s, r) => s + r.netAmount, 0));
  const receivedValue = round2(rows.reduce((s, r) => s + (r.receivedValue || 0), 0));
  const todayValue = round2(rows.reduce((s, r) => s + (r.todayValue || 0), 0));

  const tr = document.createElement('tr');
  tr.className = 'row-total';
  tr.appendChild(cell('GRAND TOTAL'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell(formatCount(grossWeight), null, false, grossWeight));
  tr.appendChild(cell(formatCount(netWeight), null, false, netWeight));
  tr.appendChild(cell('—'));
  tr.appendChild(cell(formatCount(pureWeight), null, false, pureWeight));
  tr.appendChild(cell(formatAmount(netAmount), null, false, netAmount));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell(formatAmount(receivedValue), null, false, receivedValue));
  tr.appendChild(cell(formatAmount(todayValue), null, false, todayValue));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  return tr;
}

// One combined table for every URD item — Gold, Silver, and anything else —
// with Metal Type as its own sortable/exportable column instead of splitting
// into a separate table per metal.
function renderMetalTables(rows) {
  const container = document.getElementById('oldGoldTablesContainer');
  container.innerHTML = '';

  const sortedRows = applySort(rows);

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap table-wrap--scroll-y table-wrap--spaced';
  const table = document.createElement('table');
  table.className = 'report-table';
  table.id = 'oldGoldTable';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  OLD_GOLD_COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.className = 'sortable-th';
    th.dataset.sortKey = col.key;
    th.textContent = col.label;

    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    if (oldGoldSort.key === col.key) arrow.textContent = oldGoldSort.dir === 'asc' ? '▲' : '▼';
    th.appendChild(arrow);

    th.addEventListener('click', () => {
      if (oldGoldSort.key === col.key) {
        oldGoldSort.dir = oldGoldSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        oldGoldSort = { key: col.key, dir: 'asc' };
      }
      render();
    });

    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!sortedRows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = OLD_GOLD_COLUMNS.length;
    td.className = 'cell-muted';
    td.style.textAlign = 'center';
    td.textContent = 'No URD old-gold transactions for the current filters';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    sortedRows.forEach(r => tbody.appendChild(buildRow(r)));
    tbody.appendChild(buildOldGoldGrandTotalRow(sortedRows));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'export-btn';
  exportBtn.dataset.exportTable = 'oldGoldTable';
  exportBtn.dataset.exportFilename = 'old-gold-urd-transactions';
  exportBtn.innerHTML = '&#8595; Export CSV';
  container.appendChild(exportBtn);
}

function render() {
  if (!lastData) return;
  const filtered = applyFilters(allItems);
  renderKpis(filtered);
  renderCharts(filtered);
  renderStoreSummaryTables(filtered);
  renderMetalTables(applyTableSearch(filtered));
}

function setupFilterOptions() {
  storeOrder = [...new Set(allItems.map(r => r.storeCode))].sort();
  const months = [...new Set(allItems.map(r => r.month))].sort();
  hasOtherMetal = allItems.some(r => metalTypeOf(r.itemName) === 'Other');
  storeMs.setValues(storeOrder);
  monthMs.setValues(months);
}

const storeMs = setupMultiselect({ toggleId: 'storeToggle', panelId: 'storePanel', allLabel: 'All stores', onChange: v => { filters.store = v; } });
const monthMs = setupMultiselect({ toggleId: 'monthToggle', panelId: 'monthPanel', allLabel: 'All months', onChange: v => { filters.month = v; } });

// -----------------------------------------------------------------------
// Exchange & Buy Back — a separate, unfiltered tab. These are finished
// jewelry pieces, not old gold, so there's no Metal Type or Transfer to HO
// concept here; metalStats() is reused purely as a generic rollup (its
// transfer-related fields just come back 0/empty and are unused below).
// No Gold/Silver split either — checked the data, every one of these items
// is gold/diamond jewelry (purity values sit at standard gold karats, no
// "Silver" mentions anywhere), so a metal split would just show Silver at
// zero everywhere.
let exchangeBuybackItems = [];
let exchangeBuybackSearchTerm = '';

function applyExchangeBuybackSearch(items) {
  const term = exchangeBuybackSearchTerm.trim().toLowerCase();
  if (!term) return items;
  return items.filter(r => {
    const haystack = [
      r.documentNo, r.storeCode, r.store, r.customer, r.customerMobile,
      r.sku, r.itemName, r.type,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(term);
  });
}

function renderExchangeBuybackKpis(items) {
  const container = document.getElementById('exchangeBuybackKpiGrid');
  container.innerHTML = '';

  ['Exchange', 'Buy Back'].forEach(type => {
    const stats = metalStats(items.filter(i => i.type === type));

    const heading = document.createElement('h3');
    heading.className = 'table-heading';
    heading.textContent = type;
    container.appendChild(heading);

    const kpis = [
      { label: 'Transactions', value: formatCount(stats.transactions) },
      { label: 'Items', value: formatCount(stats.items) },
      { label: 'Unique Customers', value: formatCount(stats.customers) },
      { label: 'Gross Weight', value: formatWeight(stats.grossWeight) },
      { label: 'Net Weight', value: formatWeight(stats.netWeight) },
      { label: 'Pure Weight', value: formatWeight(stats.pureWeight) },
      { label: 'Amount Paid', value: formatAmount(stats.amount) },
    ];

    const grid = document.createElement('div');
    grid.className = 'kpi-grid';
    kpis.forEach(k => {
      const card = document.createElement('div');
      card.className = 'kpi-card';
      card.innerHTML = `<div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div>`;
      grid.appendChild(card);
    });
    container.appendChild(grid);
  });
}

const EXCHANGE_BUYBACK_STORE_COLUMNS = [
  { label: 'Store', get: (store, s) => store },
  { label: 'Transactions', get: (store, s) => formatCount(s.transactions) },
  { label: 'Items', get: (store, s) => formatCount(s.items) },
  { label: 'Net Weight (g)', get: (store, s) => formatCount(s.netWeight) },
  { label: 'Amount Paid', get: (store, s) => formatAmount(s.amount) },
];

function renderExchangeBuybackStoreSummary(items) {
  const container = document.getElementById('exchangeBuybackStoreContainer');
  container.innerHTML = '';

  ['Exchange', 'Buy Back'].forEach(type => {
    const typeRows = items.filter(i => i.type === type);
    const stores = [...new Set(typeRows.map(r => r.storeCode))].sort();

    const heading = document.createElement('h3');
    heading.className = 'table-heading';
    heading.textContent = `${type} — Store Summary`;
    container.appendChild(heading);

    const wrap = document.createElement('div');
    wrap.className = 'table-wrap table-wrap--spaced';
    const table = document.createElement('table');
    table.className = 'report-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    EXCHANGE_BUYBACK_STORE_COLUMNS.forEach(col => {
      const th = document.createElement('th');
      th.textContent = col.label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    if (!stores.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = EXCHANGE_BUYBACK_STORE_COLUMNS.length;
      td.className = 'cell-muted';
      td.style.textAlign = 'center';
      td.textContent = `No ${type.toLowerCase()} transactions`;
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      stores.forEach(store => {
        const stats = metalStats(typeRows.filter(r => r.storeCode === store));
        const tr = document.createElement('tr');
        EXCHANGE_BUYBACK_STORE_COLUMNS.forEach(col => tr.appendChild(cell(col.get(store, stats))));
        tbody.appendChild(tr);
      });

      const totalStats = metalStats(typeRows);
      const totalTr = document.createElement('tr');
      totalTr.className = 'row-total';
      EXCHANGE_BUYBACK_STORE_COLUMNS.forEach(col => totalTr.appendChild(cell(col.get('Total', totalStats))));
      tbody.appendChild(totalTr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
  });
}

const EXCHANGE_BUYBACK_COLUMNS = [
  { label: 'Document No', key: 'documentNo' },
  { label: 'Date', key: 'date' },
  { label: 'Store', key: 'storeCode' },
  { label: 'Customer', key: 'customer' },
  { label: 'Mobile', key: 'customerMobile' },
  { label: 'SKU', key: 'sku' },
  { label: 'Item Name', key: 'itemName' },
  { label: 'Gross Wt (g)', key: 'grossWeight' },
  { label: 'Net Wt (g)', key: 'netWeight' },
  { label: 'Purity (%)', key: 'purity' },
  { label: 'Pure Wt (g)', key: 'pureWeight' },
  { label: 'Net Amount', key: 'netAmount' },
  { label: 'Type', key: 'type' },
];

let exchangeBuybackSort = { key: 'date', dir: 'desc' };

function compareExchangeBuybackRows(a, b, key) {
  const va = a[key];
  const vb = b[key];
  if (va == null && vb == null) return 0;
  if (va == null) return -1;
  if (vb == null) return 1;
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).toLowerCase().localeCompare(String(vb).toLowerCase());
}

function applyExchangeBuybackSort(rows) {
  if (!exchangeBuybackSort.key) return rows;
  const dir = exchangeBuybackSort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => dir * compareExchangeBuybackRows(a, b, exchangeBuybackSort.key));
}

function buildExchangeBuybackRow(r) {
  const tr = document.createElement('tr');
  tr.appendChild(cell(r.documentNo));
  tr.appendChild(cell(formatDateOnly(r.date)));
  tr.appendChild(cell(r.storeCode));
  tr.appendChild(cell(r.customer || '—', r.customer ? null : 'cell-muted'));
  tr.appendChild(cell(r.customerMobile || '—', r.customerMobile ? null : 'cell-muted'));
  tr.appendChild(cell(r.sku || '—', r.sku ? null : 'cell-muted'));
  tr.appendChild(cell(r.itemName || '—', r.itemName ? null : 'cell-muted'));
  tr.appendChild(cell(formatCount(r.grossWeight), null, false, r.grossWeight));
  tr.appendChild(cell(formatCount(r.netWeight), null, false, r.netWeight));
  tr.appendChild(cell(r.purity ? `${formatCount(round2(r.purity * 100))}%` : '—', r.purity ? null : 'cell-muted', false, r.purity ? round2(r.purity * 100) : ''));
  tr.appendChild(cell(formatCount(r.pureWeight), null, false, r.pureWeight));
  tr.appendChild(cell(formatAmount(r.netAmount), null, false, r.netAmount));
  tr.appendChild(cell(r.type));
  return tr;
}

// Sums the weight/amount columns across every row currently shown — Purity
// doesn't have a meaningful sum, so that cell stays blank.
function buildExchangeBuybackGrandTotalRow(rows) {
  const grossWeight = round2(rows.reduce((s, r) => s + r.grossWeight, 0));
  const netWeight = round2(rows.reduce((s, r) => s + r.netWeight, 0));
  const pureWeight = round2(rows.reduce((s, r) => s + r.pureWeight, 0));
  const netAmount = round2(rows.reduce((s, r) => s + r.netAmount, 0));

  const tr = document.createElement('tr');
  tr.className = 'row-total';
  tr.appendChild(cell('GRAND TOTAL'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell('—'));
  tr.appendChild(cell(formatCount(grossWeight), null, false, grossWeight));
  tr.appendChild(cell(formatCount(netWeight), null, false, netWeight));
  tr.appendChild(cell('—'));
  tr.appendChild(cell(formatCount(pureWeight), null, false, pureWeight));
  tr.appendChild(cell(formatAmount(netAmount), null, false, netAmount));
  tr.appendChild(cell('—'));
  return tr;
}

function renderExchangeBuybackTable(items) {
  const container = document.getElementById('exchangeBuybackTableContainer');
  container.innerHTML = '';

  const sortedRows = applyExchangeBuybackSort(applyExchangeBuybackSearch(items));

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap table-wrap--scroll-y table-wrap--spaced';
  const table = document.createElement('table');
  table.className = 'report-table';
  table.id = 'exchangeBuybackTable';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  EXCHANGE_BUYBACK_COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.className = 'sortable-th';
    th.dataset.sortKey = col.key;
    th.textContent = col.label;

    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    if (exchangeBuybackSort.key === col.key) arrow.textContent = exchangeBuybackSort.dir === 'asc' ? '▲' : '▼';
    th.appendChild(arrow);

    th.addEventListener('click', () => {
      if (exchangeBuybackSort.key === col.key) {
        exchangeBuybackSort.dir = exchangeBuybackSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        exchangeBuybackSort = { key: col.key, dir: 'asc' };
      }
      renderExchangeBuybackTable(exchangeBuybackItems);
    });

    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!sortedRows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = EXCHANGE_BUYBACK_COLUMNS.length;
    td.className = 'cell-muted';
    td.style.textAlign = 'center';
    td.textContent = 'No exchange or buy back transactions';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    sortedRows.forEach(r => tbody.appendChild(buildExchangeBuybackRow(r)));
    tbody.appendChild(buildExchangeBuybackGrandTotalRow(sortedRows));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'export-btn';
  exportBtn.dataset.exportTable = 'exchangeBuybackTable';
  exportBtn.dataset.exportFilename = 'exchange-buyback-transactions';
  exportBtn.innerHTML = '&#8595; Export CSV';
  container.appendChild(exportBtn);
}

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

async function loadExchangeBuyback(forceRefresh) {
  try {
    const res = await fetch(`/api/old-gold-exchange-buyback${forceRefresh ? '?refresh=true' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);

    exchangeBuybackItems = data.items;
    renderExchangeBuybackKpis(exchangeBuybackItems);
    renderExchangeBuybackStoreSummary(exchangeBuybackItems);
    renderExchangeBuybackTable(exchangeBuybackItems);
  } catch (err) {
    showStatus(err.message || 'Failed to load exchange/buy back data');
  }
}

async function loadData(forceRefresh) {
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.disabled = true;
  showStatus(null);
  try {
    const res = await fetch(`/api/old-gold${forceRefresh ? '?refresh=true' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);

    lastData = data;
    allItems = data.items;
    setupFilterOptions();
    render();

    document.getElementById('updatedAt').textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString('en-IN');
  } catch (err) {
    showStatus(err.message || 'Failed to load old gold data');
  } finally {
    refreshBtn.disabled = false;
  }
}

document.getElementById('refreshBtn').addEventListener('click', () => {
  loadData(true);
  loadExchangeBuyback(true);
});
document.getElementById('applyFilters').addEventListener('click', () => {
  filters.dateFrom = document.getElementById('dateFrom').value || null;
  filters.dateTo = document.getElementById('dateTo').value || null;
  render();
});

document.getElementById('tableSearch').addEventListener('input', e => {
  searchTerm = e.target.value;
  render();
});

document.getElementById('exchangeBuybackTableSearch').addEventListener('input', e => {
  exchangeBuybackSearchTerm = e.target.value;
  renderExchangeBuybackTable(exchangeBuybackItems);
});

document.querySelectorAll('.page-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.page-tab-btn').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.page-panel').forEach(p => p.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.getElementById(btn.dataset.panel).classList.add('is-active');
  });
});

loadData(false);
loadExchangeBuyback(false);
