function formatCount(n) {
  return new Intl.NumberFormat('en-IN').format(n || 0);
}
function formatAmount(n) {
  if (!n) return '—';
  return '₹' + new Intl.NumberFormat('en-IN', { notation: 'compact', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function formatDateOnly(value) {
  if (!value) return '—';
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

function showStatus(message) {
  const bar = document.getElementById('statusBar');
  if (!message) { bar.hidden = true; bar.textContent = ''; return; }
  bar.hidden = false;
  bar.textContent = `⚠ ${message}`;
}

function cell(html, className, isHtml, rawValue) {
  const td = document.createElement('td');
  if (className) td.className = className;
  if (isHtml) td.innerHTML = html; else td.textContent = html;
  if (rawValue !== undefined && rawValue !== null) td.dataset.raw = rawValue;
  return td;
}

function csvEscape(text) {
  const s = String(text ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function tableToCSV(table) {
  const lines = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = Array.from(tr.children).map(td => csvEscape(td.dataset.raw !== undefined ? td.dataset.raw : td.textContent.trim()));
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
  const btn = e.target.closest('.export-link');
  if (!btn) return;
  const table = document.getElementById(btn.dataset.exportTable);
  if (!table) return;
  downloadCSV(btn.dataset.exportFilename, tableToCSV(table));
});

// -----------------------------------------------------------------------
// Pill multiselect (Store / Category / Collection / Price Band filters)
// -----------------------------------------------------------------------
function setupMultiselect({ toggleId, panelId, allLabel, onChange }) {
  const toggle = document.getElementById(toggleId);
  const panel = document.getElementById(panelId);
  let values = [];
  let selected = [];

  function updateToggleLabel() {
    const chev = ' <span class="chev">&#9662;</span>';
    if (!selected.length) toggle.innerHTML = allLabel + chev;
    else if (selected.length === 1) toggle.innerHTML = selected[0] + chev;
    else toggle.innerHTML = `${selected.length} ${allLabel.toLowerCase()}s` + chev;
    toggle.classList.toggle('is-active', selected.length > 0);
  }

  function renderPanel() {
    panel.innerHTML = '';
    const allRow = document.createElement('label');
    allRow.className = 'filter-pill-option filter-pill-option--all';
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
    allRow.appendChild(document.createTextNode('All ' + allLabel));
    panel.appendChild(allRow);

    values.forEach(v => {
      const row = document.createElement('label');
      row.className = 'filter-pill-option';
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
    document.querySelectorAll('.filter-pill-panel').forEach(p => { p.hidden = true; });
    panel.hidden = !willOpen;
  });
  document.addEventListener('click', e => {
    if (!panel.hidden && !toggle.contains(e.target) && !panel.contains(e.target)) panel.hidden = true;
  });

  updateToggleLabel();

  return {
    // Dropping the option list also prunes any currently-selected value that
    // no longer exists in it (e.g. switching Category to "Rings" removes
    // bracelet sizes from the Size list — a bracelet size left selected from
    // before would otherwise silently filter everything out).
    setValues(newValues) {
      values = newValues;
      const validSet = new Set(newValues);
      selected = selected.filter(s => validSet.has(s));
      updateToggleLabel();
      renderPanel();
    },
    reset() { selected = []; updateToggleLabel(); renderPanel(); },
    getSelected() { return selected; },
  };
}

// -----------------------------------------------------------------------
// Chart primitives — plain inline SVG
// -----------------------------------------------------------------------
const WALKIN_COLOR = '#5b8def';
const SCAN_COLOR = '#B89B5E';
const SALE_COLOR = '#667A68';

function renderTrendLineChart(container, { title, subtitle, labels, values, formatter, total }) {
  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';

  const fmt = formatter || formatCount;
  card.innerHTML = `<div class="card-header"><div><div class="card-title">${title}</div><div class="card-subtitle">${subtitle}</div></div></div>`;

  if (!labels.length || !values.some(v => v > 0)) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = 'No data for the current range/filters';
    card.appendChild(empty);
    container.appendChild(card);
    return;
  }

  const width = 420, height = 160;
  const padding = { top: 10, right: 8, bottom: 22, left: 8 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const maxValue = Math.max(...values, 1);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);

  for (let i = 0; i <= 2; i++) {
    const y = padding.top + (plotH / 2) * i;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', padding.left); line.setAttribute('x2', width - padding.right);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('class', 'chart-gridline');
    svg.appendChild(line);
  }

  const xStep = labels.length > 1 ? plotW / (labels.length - 1) : 0;
  const coords = values.map((v, i) => ({ x: padding.left + i * xStep, y: padding.top + plotH - (v / maxValue) * plotH, v }));

  const areaPts = [`${coords[0].x},${padding.top + plotH}`, ...coords.map(c => `${c.x},${c.y}`), `${coords[coords.length - 1].x},${padding.top + plotH}`].join(' ');
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  area.setAttribute('points', areaPts);
  area.setAttribute('fill', 'url(#goldFade)');
  svg.appendChild(area);

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `<linearGradient id="goldFade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#B89B5E" stop-opacity="0.16"/>
    <stop offset="100%" stop-color="#B89B5E" stop-opacity="0"/>
  </linearGradient>`;
  svg.insertBefore(defs, svg.firstChild);

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#B89B5E');
  path.setAttribute('stroke-width', 2);
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);

  coords.forEach((c, i) => {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', c.x); dot.setAttribute('cy', c.y); dot.setAttribute('r', 2.5);
    dot.setAttribute('fill', '#FFFFFF'); dot.setAttribute('stroke', '#B89B5E'); dot.setAttribute('stroke-width', 1.5);
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    t.textContent = `${labels[i]}: ${fmt(c.v)}`;
    dot.appendChild(t);
    svg.appendChild(dot);
  });

  [0, labels.length - 1].forEach(i => {
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', coords[i].x);
    label.setAttribute('y', height - 4);
    label.setAttribute('text-anchor', i === 0 ? 'start' : 'end');
    label.setAttribute('class', 'chart-axis-label');
    label.textContent = labels[i];
    svg.appendChild(label);
  });

  const totalLabel = document.createElement('div');
  totalLabel.style.cssText = 'font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:2px;';
  totalLabel.textContent = 'Total (current filters)';
  const totalEl = document.createElement('div');
  totalEl.style.cssText = 'font-size:28px;font-weight:650;color:var(--text-primary);letter-spacing:-0.01em;';
  totalEl.textContent = fmt(total != null ? total : values.reduce((s, v) => s + v, 0));
  const latestEl = document.createElement('div');
  latestEl.style.cssText = 'font-size:12px;color:var(--text-secondary);margin:2px 0 8px;';
  latestEl.textContent = `Last week: ${fmt(values[values.length - 1])}`;

  card.appendChild(totalLabel);
  card.appendChild(totalEl);
  card.appendChild(latestEl);
  card.appendChild(svg);
  container.appendChild(card);
}

function renderBarList(containerId, items, { getLabel, getMetric, formatValue }) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<div class="chart-empty">No data for the current filters</div>';
    return;
  }
  const max = Math.max(...items.map(getMetric), 1);
  items.forEach(item => {
    const metric = getMetric(item);
    const row = document.createElement('div');
    row.className = 'bar-list-row';
    row.innerHTML = `
      <div class="bar-list-label">${getLabel(item)}</div>
      <div class="bar-list-track"><div class="bar-list-fill" style="width:${Math.max((metric / max) * 100, metric ? 2 : 0)}%"></div></div>
      <div class="bar-list-value">${formatValue(item)}</div>
    `;
    container.appendChild(row);
  });
}

// -----------------------------------------------------------------------
// Generic sortable/searchable item table
// -----------------------------------------------------------------------
function makeItemTable({ containerId, columns, searchFields, exportFilename, tableId }) {
  let sort = { key: columns[0].key, dir: 'asc' };
  let searchTerm = '';

  function compareRows(a, b, key) {
    const va = a[key];
    const vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return -1;
    if (vb == null) return 1;
    if (typeof va === 'number' && typeof vb === 'number') return va - vb;
    return String(va).toLowerCase().localeCompare(String(vb).toLowerCase());
  }

  function applySearch(rows) {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(r => searchFields.map(f => r[f]).filter(Boolean).join(' ').toLowerCase().includes(term));
  }

  function applySort(rows) {
    if (!sort.key) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => dir * compareRows(a, b, sort.key));
  }

  function render(rows) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    const countLine = document.createElement('div');
    countLine.className = 'table-count-line';
    container.appendChild(countLine);

    const wrap = document.createElement('div');
    wrap.className = 'table-shell';
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    const table = document.createElement('table');
    table.className = 'grid';
    table.id = tableId;

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    columns.forEach((col, i) => {
      const th = document.createElement('th');
      if (i === 0) th.classList.add('sticky-col');
      th.dataset.sortKey = col.key;
      th.textContent = col.label;

      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      if (sort.key === col.key) arrow.textContent = sort.dir === 'asc' ? '▲' : '▼';
      th.appendChild(arrow);

      th.addEventListener('click', () => {
        if (sort.key === col.key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        else sort = { key: col.key, dir: 'asc' };
        render(rows);
      });

      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const sortedRows = applySort(applySearch(rows));
    countLine.textContent = sortedRows.length === rows.length
      ? `Showing ${sortedRows.length.toLocaleString('en-IN')} product${sortedRows.length === 1 ? '' : 's'}`
      : `Showing ${sortedRows.length.toLocaleString('en-IN')} of ${rows.length.toLocaleString('en-IN')} products`;

    const tbody = document.createElement('tbody');
    if (!sortedRows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = columns.length;
      td.className = 'muted';
      td.style.textAlign = 'center';
      td.textContent = 'No items for the current filters';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      sortedRows.forEach(r => {
        const tr = document.createElement('tr');
        columns.forEach((col, i) => {
          const classes = [col.className ? col.className(r) : null, i === 0 ? 'sticky-col' : null].filter(Boolean).join(' ') || null;
          tr.appendChild(cell(col.render(r), classes, !!col.isHtml, col.raw ? col.raw(r) : undefined));
        });
        tbody.appendChild(tr);
      });
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);
    container.appendChild(wrap);

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'export-link';
    exportBtn.dataset.exportTable = tableId;
    exportBtn.dataset.exportFilename = exportFilename;
    exportBtn.textContent = 'Export CSV ↓';
    container.appendChild(exportBtn);
  }

  return {
    render,
    setSearchTerm(term) { searchTerm = term; },
  };
}

function renderSummaryTable(containerId, rows) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  container.className = 'bar-list';
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (!rows.length) {
    container.innerHTML = '<div class="chart-empty">No items</div>';
    return;
  }
  rows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'bar-list-row';
    row.title = `${((total ? (r.count / total) * 100 : 0)).toFixed(1)}% of total · ${formatAmount(r.value)}`;
    const max = Math.max(...rows.map(x => x.count), 1);
    row.innerHTML = `
      <div class="bar-list-label">${r.key}</div>
      <div class="bar-list-track"><div class="bar-list-fill" style="width:${Math.max((r.count / max) * 100, r.count ? 2 : 0)}%"></div></div>
      <div class="bar-list-value">${formatCount(r.count)}</div>
    `;
    container.appendChild(row);
  });
}

function renderRankedList(containerId, rows) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  container.className = 'ranked-list';
  if (!rows.length) {
    container.innerHTML = '<div class="chart-empty">No items</div>';
    return;
  }
  const total = rows.reduce((s, r) => s + r.count, 0);
  let display = rows;
  if (rows.length > 6) {
    const top = rows.slice(0, 5);
    const rest = rows.slice(5);
    const others = { key: 'Others', count: rest.reduce((s, r) => s + r.count, 0), value: rest.reduce((s, r) => s + r.value, 0) };
    display = [...top, others];
  }
  display.forEach((r, i) => {
    const pct = total ? Math.round((r.count / total) * 1000) / 10 : 0;
    const row = document.createElement('div');
    row.className = 'ranked-row';
    row.title = `${formatCount(r.count)} items · ${formatAmount(r.value)}`;
    row.innerHTML = `
      <div class="ranked-index">${String(i + 1).padStart(2, '0')}</div>
      <div class="ranked-main">
        <div class="ranked-label-row"><span class="ranked-label">${r.key}</span><span class="ranked-pct">${pct}%</span></div>
        <div class="ranked-track"><div class="ranked-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="ranked-value">${formatCount(r.count)}</div>
    `;
    container.appendChild(row);
  });
}

function summarizeItemsBy(items, keyFn, keyOrder) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item) || 'Unknown';
    if (!map.has(key)) map.set(key, { key, count: 0, value: 0 });
    const entry = map.get(key);
    entry.count += 1;
    entry.value += item.price || item.inventoryValue || 0;
  }
  const rows = [...map.values()].map(r => ({ ...r, value: round2(r.value) }));
  if (!keyOrder) return rows.sort((a, b) => b.count - a.count);
  return rows.sort((a, b) => keyOrder.indexOf(a.key) - keyOrder.indexOf(b.key));
}

// -----------------------------------------------------------------------
// Global filter state
// -----------------------------------------------------------------------
const filterState = {
  dateFrom: null,
  dateTo: null,
  stores: [],
  categories: [],
  collections: [],
  priceBands: [],
  sizes: [],
  sku: '',
};

function inDateRange(dateStr) {
  if (!filterState.dateFrom && !filterState.dateTo) return true;
  if (!dateStr) return false;
  if (filterState.dateFrom && dateStr < filterState.dateFrom) return false;
  if (filterState.dateTo && dateStr > filterState.dateTo) return false;
  return true;
}
function matchStore(store) { return !filterState.stores.length || filterState.stores.includes(store); }
function matchCategory(category) { return !filterState.categories.length || filterState.categories.includes(category); }
function matchCollection(collection) { return !filterState.collections.length || filterState.collections.includes(collection); }
function matchPriceBand(priceBand) { return !filterState.priceBands.length || filterState.priceBands.includes(priceBand); }
function matchSize(size) { return !filterState.sizes.length || filterState.sizes.includes(size); }
function matchSku(row) {
  const term = filterState.sku.trim().toLowerCase();
  if (!term) return true;
  return [row.itemCode, row.fullSku, row.itemName].filter(Boolean).join(' ').toLowerCase().includes(term);
}

// Walk-ins carry no product reference, so only Date + Store apply to them.
function filterWalkins(walkins) {
  return walkins.filter(w => matchStore(w.store) && inDateRange(w.date));
}
function filterScanEvents(scanEvents) {
  return scanEvents.filter(s =>
    matchStore(s.store) && inDateRange(s.date) &&
    matchCategory(s.category) && matchCollection(s.collection) && matchPriceBand(s.priceBand) && matchSize(s.size) && matchSku(s)
  );
}
// Never Scanned has no scan date to filter by (that's the point — it has
// never been scanned), so Date does not apply here; ageing already conveys
// the time dimension for this list.
function filterNotScanned(items) {
  return items.filter(i =>
    matchStore(i.store) &&
    matchCategory(i.category) && matchCollection(i.collection) && matchPriceBand(i.priceBand) && matchSize(i.size) && matchSku(i)
  );
}

// -----------------------------------------------------------------------
// Aggregation (all computed from the currently-filtered arrays)
// -----------------------------------------------------------------------

// Dedup matched sales by item_line_no — a physical unit scanned 5 times and
// sold once must contribute its sale value/quantity exactly once, not 5x.
function uniqueSales(scanEvents) {
  const map = new Map();
  for (const e of scanEvents) {
    if (e.sold && e.itemLineNo && !map.has(e.itemLineNo)) map.set(e.itemLineNo, e.sale);
  }
  return [...map.values()];
}

function computeKpis(walkins, scanEvents, notScannedItems) {
  const uniqueItemIds = new Set(scanEvents.map(s => s.itemId));
  const soldItemIds = new Set(scanEvents.filter(s => s.sold).map(s => s.itemId));
  const sales = uniqueSales(scanEvents);
  const neverScannedValue = notScannedItems.reduce((s, i) => s + (i.inventoryValue || 0), 0);

  return {
    totalWalkins: walkins.length,
    uniqueWalkinPhones: new Set(walkins.map(w => w.phone).filter(Boolean)).size,
    totalScanEvents: scanEvents.length,
    uniqueProductsScanned: uniqueItemIds.size,
    scannedAndSoldItems: soldItemIds.size,
    scannedButNotSoldItems: uniqueItemIds.size - soldItemIds.size,
    salesValueFromScanned: round2(sales.reduce((s, x) => s + x.netSale, 0)),
    salesQtyFromScanned: sales.reduce((s, x) => s + x.pieces, 0),
    neverScannedItems: notScannedItems.length,
    neverScannedValue: round2(neverScannedValue),
    scanToSaleConversionPct: uniqueItemIds.size ? round2((soldItemIds.size / uniqueItemIds.size) * 100) : 0,
  };
}

function buildStoreFunnel(walkins, scanEvents) {
  const stores = new Set([...walkins.map(w => w.store), ...scanEvents.map(s => s.store)].filter(Boolean));
  return [...stores].sort().map(store => {
    const w = walkins.filter(x => x.store === store);
    const s = scanEvents.filter(x => x.store === store);
    const uniqueItemIds = new Set(s.map(x => x.itemId));
    const soldItemIds = new Set(s.filter(x => x.sold).map(x => x.itemId));
    const sales = uniqueSales(s);
    return {
      store,
      walkins: w.length,
      uniqueWalkinPhones: new Set(w.map(x => x.phone).filter(Boolean)).size,
      scanEvents: s.length,
      uniqueProductsScanned: uniqueItemIds.size,
      productsSold: soldItemIds.size,
      revenue: round2(sales.reduce((sum, x) => sum + x.netSale, 0)),
    };
  });
}

function weekStartOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay();
  const diffFromMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diffFromMonday);
  return d.toISOString().slice(0, 10);
}

function buildWeeklyTrend(walkins, scanEvents) {
  const sales = uniqueSales(scanEvents);
  const weeks = new Set([
    ...walkins.map(w => w.date && weekStartOf(w.date)),
    ...scanEvents.map(s => s.date && weekStartOf(s.date)),
    ...sales.map(s => s.date && weekStartOf(s.date)),
  ].filter(Boolean));

  return [...weeks].sort().map(weekStart => {
    const weekSales = sales.filter(s => s.date && weekStartOf(s.date) === weekStart);
    return {
      weekStart,
      walkins: walkins.filter(w => w.date && weekStartOf(w.date) === weekStart).length,
      scans: scanEvents.filter(s => s.date && weekStartOf(s.date) === weekStart).length,
      sales: weekSales.length,
      revenue: round2(weekSales.reduce((sum, s) => sum + s.netSale, 0)),
    };
  });
}

function todayISODate() { return new Date().toISOString().slice(0, 10); }

function completedWeeks(weeklyTrend, today) {
  return weeklyTrend.filter(w => {
    const weekEnd = new Date(`${w.weekStart}T00:00:00Z`);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    return weekEnd.toISOString().slice(0, 10) <= today;
  });
}
function weekOverWeekPct(weeklyTrend, today, key) {
  const weeks = completedWeeks(weeklyTrend, today);
  if (weeks.length < 2) return null;
  const curr = weeks[weeks.length - 1][key];
  const prev = weeks[weeks.length - 2][key];
  if (!prev) return null;
  return round2(((curr - prev) / prev) * 100);
}

// Item-level rollup of scan events — one row per item_id, with its total
// scan count and its sale outcome derived from the DISTINCT set of matched
// item_line_no's (not per scan event, so repeat scans of a sold item don't
// multiply its sale value/quantity). Grouped by (item, STORE) — not item
// alone — so an item scanned at more than one store shows as its own row per
// store, each with that store's own scan count/first-last-scanned/sold
// status, instead of one combined row listing multiple stores.
function buildItemLevelScanStats(scanEvents) {
  const map = new Map();
  for (const e of scanEvents) {
    const key = `${e.itemId}::${e.storeCode || ''}`;
    if (!map.has(key)) {
      map.set(key, {
        itemId: e.itemId, itemCode: e.itemCode, itemName: e.itemName, category: e.category,
        collection: e.collection, priceBand: e.priceBand, price: e.price, metal: e.metal, size: e.size,
        storeCode: e.storeCode, store: e.store,
        scanCount: 0, firstScanDate: null, lastScanDate: null, matchedLineNos: new Map(),
      });
    }
    const st = map.get(key);
    st.scanCount += 1;
    if (e.date && (!st.firstScanDate || e.date < st.firstScanDate)) st.firstScanDate = e.date;
    if (e.date && (!st.lastScanDate || e.date > st.lastScanDate)) st.lastScanDate = e.date;
    if (e.sold && e.itemLineNo && !st.matchedLineNos.has(e.itemLineNo)) st.matchedLineNos.set(e.itemLineNo, e.sale);
  }

  return [...map.values()].map(st => {
    const sales = [...st.matchedLineNos.values()];
    const saleValue = round2(sales.reduce((s, x) => s + x.netSale, 0));
    const saleQty = sales.reduce((s, x) => s + x.pieces, 0);
    const saleDates = sales.map(s => s.date).filter(Boolean).sort();
    return {
      itemId: st.itemId,
      itemCode: st.itemCode,
      itemName: st.itemName,
      category: st.category,
      collection: st.collection,
      priceBand: st.priceBand,
      price: st.price,
      metal: st.metal,
      size: st.size,
      storeCode: st.storeCode,
      store: st.store,
      scanCount: st.scanCount,
      firstScanDate: st.firstScanDate,
      lastScanDate: st.lastScanDate,
      sold: st.matchedLineNos.size > 0,
      saleQty,
      saleValue,
      lastSaleDate: saleDates.length ? saleDates[saleDates.length - 1] : null,
      conversionPct: st.scanCount ? round2((saleQty / st.scanCount) * 100) : 0,
    };
  });
}

// Groups by resolvedPartyId — the scan's own party_id, or (when the scan
// itself has none) the party_id of the sale it matched via item_line_no.
// marketing_sale.party_id is 100% filled, so this recovers a customer
// identity for scans the raw scan row alone can't attribute; it never
// guesses at a scan with no verified item_line_no match.
function buildCustomerAnalysis(scanEvents, partyNames) {
  const map = new Map();
  for (const e of scanEvents) {
    const pid = e.resolvedPartyId;
    if (!pid) continue;
    if (!map.has(pid)) map.set(pid, { partyId: pid, scanEventCount: 0, stores: new Set(), viaMatchedSale: 0, viaMatchedSaleEvents: 0, scannedItemIds: new Set(), soldItemIds: new Set() });
    const c = map.get(pid);
    c.scanEventCount += 1;
    if (e.store) c.stores.add(e.store);
    if (e.partyIdSource === 'sale') c.viaMatchedSaleEvents += 1;
    c.scannedItemIds.add(e.itemId);
    // Same definition as the Overview KPI's "Scanned & Sold": distinct
    // products (item_id), not raw pieces or scan events — just restricted to
    // this customer's attributed scans, so it's always <= the Overview total.
    if (e.sold) c.soldItemIds.add(e.itemId);
  }
  return [...map.values()].map(c => {
    const scanned = c.scannedItemIds.size;
    const purchased = c.soldItemIds.size;
    return {
      partyId: c.partyId,
      name: partyNames[c.partyId] || `Customer #${c.partyId}`,
      scanned,
      purchased,
      notPurchased: scanned - purchased,
      conversionPct: scanned ? round2((purchased / scanned) * 100) : 0,
      productsSold: purchased,
      stores: [...c.stores].sort().join(', '),
      identitySource: c.viaMatchedSaleEvents === c.scanEventCount ? 'Matched sale only' : (c.viaMatchedSaleEvents > 0 ? 'Scan + matched sale' : 'Scan party_id'),
    };
  }).sort((a, b) => b.scanned - a.scanned);
}

// -----------------------------------------------------------------------
// Overview
// -----------------------------------------------------------------------
function renderKpis(kpis, kpiTrends) {
  const container = document.getElementById('kpiGrid');
  container.innerHTML = '';
  function trendHtml(pct) {
    if (pct == null) return '';
    const dir = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
    const arrow = dir === 'up' ? '↗' : dir === 'down' ? '↘' : '→';
    return `<div class="kpi-trend is-${dir}">${arrow} ${Math.abs(pct).toFixed(1)}% vs last week</div>`;
  }
  const cards = [
    { label: 'Total Walk-ins', value: formatCount(kpis.totalWalkins), trend: kpiTrends.walkins },
    { label: 'Unique Visitors', value: formatCount(kpis.uniqueWalkinPhones) },
    { label: 'Total Scan Events', value: formatCount(kpis.totalScanEvents), trend: kpiTrends.scans },
    { label: 'Unique Products Scanned', value: formatCount(kpis.uniqueProductsScanned) },
    { label: 'Scanned & Sold', value: formatCount(kpis.scannedAndSoldItems) },
    { label: 'Scan → Sale Conversion', value: `${kpis.scanToSaleConversionPct}%`, gold: true },
    { label: 'Sales Value (Scanned)', value: formatAmount(kpis.salesValueFromScanned), trend: kpiTrends.revenue },
    { label: 'Scanned but Not Sold', value: formatCount(kpis.scannedButNotSoldItems) },
    { label: 'Never Scanned Products', value: formatCount(kpis.neverScannedItems) },
    { label: 'Never Scanned Inventory Value', value: formatAmount(kpis.neverScannedValue) },
  ];
  cards.forEach(k => {
    const card = document.createElement('div');
    card.className = 'kpi-card';
    card.innerHTML = `
      <div class="kpi-card-top">
        <div class="kpi-label">${k.label}</div>
        <svg class="kpi-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 17 12 7l3 5 5-9"/></svg>
      </div>
      <div class="kpi-value${k.gold ? ' is-gold' : ''}">${k.value}</div>
      ${k.trend != null ? trendHtml(k.trend) : ''}
    `;
    container.appendChild(card);
  });
}

function renderFunnel(kpis) {
  const row = document.getElementById('funnelRow');
  row.innerHTML = '';
  const scannedPct = kpis.totalWalkins ? Math.round((kpis.uniqueProductsScanned / kpis.totalWalkins) * 1000) / 10 : 0;
  const soldPct = kpis.scanToSaleConversionPct;
  const stages = [
    { label: 'Walk-ins', value: formatCount(kpis.totalWalkins), sub: null, gold: false },
    { label: 'Scan Events', value: formatCount(kpis.totalScanEvents), sub: `<span class="pct">${formatCount(kpis.uniqueProductsScanned)}</span> unique products`, gold: false },
    { label: 'Scanned & Sold', value: formatCount(kpis.scannedAndSoldItems), sub: `<span class="pct">${soldPct}%</span> conversion`, gold: true },
  ];
  stages.forEach((s, i) => {
    if (i > 0) {
      const connector = document.createElement('div');
      connector.className = 'funnel-connector';
      connector.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6l6 6-6 6"/></svg>';
      row.appendChild(connector);
    }
    const stage = document.createElement('div');
    stage.className = 'funnel-stage';
    stage.innerHTML = `
      <div class="funnel-stage-label">${s.label}</div>
      <div class="funnel-stage-value${s.gold ? ' is-gold' : ''}">${s.value}</div>
      ${s.sub ? `<div class="funnel-stage-sub">${s.sub}</div>` : ''}
    `;
    row.appendChild(stage);
  });
  void scannedPct;
}

function renderFunnelTable(rows) {
  const tbody = document.getElementById('funnelBody');
  tbody.innerHTML = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'muted';
    td.style.textAlign = 'center';
    td.textContent = 'No data for the current filters';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.appendChild(cell(r.store, 'sticky-col'));
    tr.appendChild(cell(formatCount(r.walkins), null, false, r.walkins));
    tr.appendChild(cell(formatCount(r.uniqueWalkinPhones), null, false, r.uniqueWalkinPhones));
    tr.appendChild(cell(formatCount(r.scanEvents), null, false, r.scanEvents));
    tr.appendChild(cell(formatCount(r.uniqueProductsScanned), null, false, r.uniqueProductsScanned));
    tr.appendChild(cell(formatCount(r.productsSold), null, false, r.productsSold));
    tr.appendChild(cell(formatAmount(r.revenue), null, false, r.revenue));
    tbody.appendChild(tr);
  });

  const totalTr = document.createElement('tr');
  totalTr.style.fontWeight = '600';
  const sum = key => rows.reduce((s, r) => s + r[key], 0);
  totalTr.appendChild(cell('TOTAL', 'sticky-col'));
  totalTr.appendChild(cell(formatCount(sum('walkins')), null, false, sum('walkins')));
  totalTr.appendChild(cell(formatCount(sum('uniqueWalkinPhones')), null, false, sum('uniqueWalkinPhones')));
  totalTr.appendChild(cell(formatCount(sum('scanEvents')), null, false, sum('scanEvents')));
  totalTr.appendChild(cell(formatCount(sum('uniqueProductsScanned')), null, false, sum('uniqueProductsScanned')));
  totalTr.appendChild(cell(formatCount(sum('productsSold')), null, false, sum('productsSold')));
  totalTr.appendChild(cell(formatAmount(sum('revenue')), null, false, sum('revenue')));
  tbody.appendChild(totalTr);
}

let trendWeeksToShow = 0;
function renderOverviewCharts(weeklyTrend, storeFunnel) {
  const grid = document.getElementById('trendChartsGrid');
  grid.innerHTML = '';
  const slice = trendWeeksToShow ? weeklyTrend.slice(-trendWeeksToShow) : weeklyTrend;
  const labels = slice.map(d => d.weekStart);
  const sum = key => weeklyTrend.reduce((s, d) => s + d[key], 0);

  const sections = Array.from({ length: 3 }, () => document.createElement('div'));
  sections.forEach(s => grid.appendChild(s));

  renderTrendLineChart(sections[0], { title: 'Walk-ins', subtitle: 'Weekly, current filters', labels, values: slice.map(d => d.walkins), total: sum('walkins') });
  renderTrendLineChart(sections[1], { title: 'Scan Events', subtitle: 'Total scan count, current filters', labels, values: slice.map(d => d.scans), total: sum('scans') });
  renderTrendLineChart(sections[2], { title: 'Sales Value', subtitle: 'Weekly, scanned & sold products', labels, values: slice.map(d => d.revenue), formatter: formatAmount, total: sum('revenue') });

  renderBarList('scansByStoreChart', [...storeFunnel].sort((a, b) => b.scanEvents - a.scanEvents), {
    getLabel: r => r.store, getMetric: r => r.scanEvents, formatValue: r => formatCount(r.scanEvents),
  });
  renderBarList('revenueByStoreChart', [...storeFunnel].sort((a, b) => b.revenue - a.revenue), {
    getLabel: r => r.store, getMetric: r => r.revenue, formatValue: r => formatAmount(r.revenue),
  });
}
document.getElementById('trendRangeControl').addEventListener('click', e => {
  const btn = e.target.closest('.segmented-btn');
  if (!btn || !lastData) return;
  document.querySelectorAll('#trendRangeControl .segmented-btn').forEach(b => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  trendWeeksToShow = Number(btn.dataset.weeks);
  renderAll(lastData);
});

// -----------------------------------------------------------------------
// Scanned & Sold / Attention Required / Never Scanned tables
// -----------------------------------------------------------------------
const SCANNED_SOLD_COLUMNS = [
  { key: 'itemCode', label: 'SKU', render: r => r.itemCode || '—' },
  { key: 'itemName', label: 'Product', render: r => r.itemName || '—' },
  { key: 'category', label: 'Category', render: r => r.category },
  { key: 'collection', label: 'Collection', render: r => r.collection || '—' },
  { key: 'store', label: 'Store Scanned', render: r => r.store || '—' },
  { key: 'priceBand', label: 'Price Band', render: r => r.priceBand },
  { key: 'scanCount', label: 'Scan Count', render: r => formatCount(r.scanCount), raw: r => r.scanCount },
  { key: 'saleQty', label: 'Items Sold', render: r => formatCount(r.saleQty), raw: r => r.saleQty },
  { key: 'saleValue', label: 'Sales Value', render: r => formatAmount(r.saleValue), raw: r => r.saleValue },
  { key: 'lastSaleDate', label: 'Last Sale', render: r => formatDateOnly(r.lastSaleDate) },
];

const SCANNED_NOT_SOLD_COLUMNS = [
  { key: 'itemCode', label: 'SKU', render: r => r.itemCode || '—' },
  { key: 'itemName', label: 'Product', render: r => r.itemName || '—' },
  { key: 'category', label: 'Category', render: r => r.category },
  { key: 'collection', label: 'Collection', render: r => r.collection || '—' },
  { key: 'store', label: 'Scanned At', render: r => r.store || '—' },
  { key: 'price', label: 'Price', render: r => r.price != null ? formatAmount(r.price) : '—', raw: r => r.price },
  { key: 'priceBand', label: 'Price Band', render: r => r.priceBand },
  { key: 'scanCount', label: 'Scans', render: r => formatCount(r.scanCount), raw: r => r.scanCount },
  { key: 'firstScanDate', label: 'First Scanned', render: r => formatDateOnly(r.firstScanDate) },
  { key: 'lastScanDate', label: 'Last Scanned', render: r => formatDateOnly(r.lastScanDate) },
];

const NOT_SCANNED_COLUMNS = [
  { key: 'itemCode', label: 'Item Code', render: r => r.itemCode || '—' },
  { key: 'itemName', label: 'Item Name', render: r => r.itemName || '—' },
  { key: 'category', label: 'Category', render: r => r.category },
  { key: 'collection', label: 'Collection', render: r => r.collection || '—' },
  { key: 'store', label: 'Store', render: r => r.store || '—' },
  { key: 'documentNo', label: 'Document No', render: r => r.documentNo || '—' },
  { key: 'piecesOnHand', label: 'Qty on Hand', render: r => formatCount(r.piecesOnHand), raw: r => r.piecesOnHand },
  { key: 'inventoryValue', label: 'Inventory Value', render: r => r.inventoryValue != null ? formatAmount(r.inventoryValue) : '—', raw: r => r.inventoryValue },
  { key: 'ageingDays', label: 'Ageing (days)', render: r => r.ageingDays != null ? formatCount(r.ageingDays) : '—', raw: r => r.ageingDays },
];

const CUSTOMER_COLUMNS = [
  { key: 'name', label: 'Customer', render: r => r.name },
  { key: 'partyId', label: 'Party ID', render: r => r.partyId },
  { key: 'scanned', label: 'Products Scanned', render: r => formatCount(r.scanned), raw: r => r.scanned },
  { key: 'purchased', label: 'Purchased', render: r => formatCount(r.purchased), raw: r => r.purchased },
  { key: 'notPurchased', label: 'Not Purchased', render: r => formatCount(r.notPurchased), raw: r => r.notPurchased },
  { key: 'conversionPct', label: 'Conversion %', render: r => `${r.conversionPct}%`, raw: r => r.conversionPct },
  { key: 'productsSold', label: 'Products Sold', render: r => formatCount(r.productsSold), raw: r => r.productsSold },
  { key: 'stores', label: 'Store(s)', render: r => r.stores || '—' },
];

const scannedSoldTable = makeItemTable({
  containerId: 'scannedSoldTableContainer', columns: SCANNED_SOLD_COLUMNS,
  searchFields: ['itemCode', 'itemName', 'category', 'collection'], exportFilename: 'scanned-and-sold', tableId: 'scannedSoldTable',
});
const scannedNotSoldTable = makeItemTable({
  containerId: 'scannedNotSoldTableContainer', columns: SCANNED_NOT_SOLD_COLUMNS,
  searchFields: ['itemCode', 'itemName', 'category', 'collection'], exportFilename: 'scanned-but-not-sold', tableId: 'scannedNotSoldTable',
});
const notScannedTable = makeItemTable({
  containerId: 'notScannedTableContainer', columns: NOT_SCANNED_COLUMNS,
  searchFields: ['itemCode', 'fullSku', 'itemName', 'category', 'collection', 'store'], exportFilename: 'items-never-scanned', tableId: 'notScannedTable',
});
const customerTable = makeItemTable({
  containerId: 'customerTableContainer', columns: CUSTOMER_COLUMNS,
  searchFields: ['name', 'partyId'], exportFilename: 'customer-analysis', tableId: 'customerTable',
});

function kpiCard(label, value, gold) {
  const card = document.createElement('div');
  card.className = 'kpi-card';
  card.innerHTML = `<div class="kpi-label">${label}</div><div class="kpi-value${gold ? ' is-gold' : ''}">${value}</div>`;
  return card;
}

// Rolls the (item, store) rows back up to one row per item, for items sold
// at more than one store — each store's own scan count/qty/value summed
// once, so nothing here double-counts a store's sale.
function renderMultiStoreSoldTable(items) {
  const tbody = document.getElementById('multiStoreSoldBody');
  tbody.innerHTML = '';
  const byItem = new Map();
  for (const i of items) {
    if (!byItem.has(i.itemId)) byItem.set(i.itemId, []);
    byItem.get(i.itemId).push(i);
  }
  const multiStore = [...byItem.values()].filter(rows => rows.length > 1);
  if (!multiStore.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'muted';
    td.style.textAlign = 'center';
    td.textContent = 'No products sold at more than one store for the current filters';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  multiStore
    .sort((a, b) => b.length - a.length)
    .forEach(rows => {
      const first = rows[0];
      const tr = document.createElement('tr');
      tr.appendChild(cell(first.itemCode || '—', 'sticky-col'));
      tr.appendChild(cell(first.itemName || '—'));
      tr.appendChild(cell(first.category || 'Unknown'));
      tr.appendChild(cell(rows.map(r => r.store).filter(Boolean).join(', ')));
      tr.appendChild(cell(formatCount(rows.reduce((s, r) => s + r.scanCount, 0))));
      tr.appendChild(cell(formatCount(rows.reduce((s, r) => s + r.saleQty, 0))));
      tr.appendChild(cell(formatAmount(round2(rows.reduce((s, r) => s + r.saleValue, 0)))));
      tbody.appendChild(tr);
    });
}

function renderScannedSoldTab(itemStats) {
  const items = itemStats.filter(i => i.sold);
  const uniqueProducts = new Set(items.map(i => i.itemId)).size;
  const container = document.getElementById('scannedSoldKpiGrid');
  container.innerHTML = '';
  container.appendChild(kpiCard('Unique Products Sold', formatCount(uniqueProducts)));
  container.appendChild(kpiCard('Total Sales Value', formatAmount(round2(items.reduce((s, i) => s + i.saleValue, 0))), true));
  container.appendChild(kpiCard('Items Sold (Qty)', formatCount(items.reduce((s, i) => s + i.saleQty, 0))));
  container.appendChild(kpiCard('Total Scan Events', formatCount(items.reduce((s, i) => s + i.scanCount, 0))));

  renderSummaryTable('scannedSoldStoreContainer', summarizeItemsBy(items, i => i.store));
  renderRankedList('scannedSoldCategoryContainer', summarizeItemsBy(items, i => i.category));
  renderSummaryTable('scannedSoldPriceBandContainer', summarizeItemsBy(items, i => i.priceBand, lastData.priceBandOrder));

  renderMultiStoreSoldTable(items);
  scannedSoldTable.render(items);
}

function renderTopScannedNotSoldTable(items, limit) {
  const tbody = document.getElementById('scannedNotSoldTopBody');
  tbody.innerHTML = '';
  const top = [...items].sort((a, b) => b.scanCount - a.scanCount).slice(0, limit || 10);
  if (!top.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'muted';
    td.style.textAlign = 'center';
    td.textContent = 'No items for the current filters';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  top.forEach((item, i) => {
    const tr = document.createElement('tr');
    tr.appendChild(cell(String(i + 1), 'sticky-col'));
    tr.appendChild(cell(item.itemCode || '—'));
    tr.appendChild(cell(item.itemName || '—'));
    tr.appendChild(cell(item.category || 'Unknown'));
    tr.appendChild(cell(item.store || '—'));
    tr.appendChild(cell(formatCount(item.scanCount), null, false, item.scanCount));
    tbody.appendChild(tr);
  });
}

function renderScannedNotSoldTab(itemStats) {
  const items = itemStats.filter(i => !i.sold);
  const uniqueProducts = new Set(items.map(i => i.itemId)).size;
  const container = document.getElementById('scannedNotSoldKpiGrid');
  container.innerHTML = '';
  const totalValue = items.reduce((s, i) => s + (i.price || 0), 0);
  container.appendChild(kpiCard('Unique Products Scanned but Unsold', formatCount(uniqueProducts)));
  const rowsCard = kpiCard('Store-level Rows', formatCount(items.length));
  const rowsNote = document.createElement('div');
  rowsNote.className = 'kpi-trend is-flat';
  rowsNote.textContent = items.length !== uniqueProducts ? `${formatCount(items.length - uniqueProducts)} product(s) unsold at more than 1 store` : 'One row per product, no multi-store overlap';
  rowsCard.appendChild(rowsNote);
  container.appendChild(rowsCard);
  container.appendChild(kpiCard('Total Value', formatAmount(round2(totalValue)), true));
  container.appendChild(kpiCard('Total Scan Events', formatCount(items.reduce((s, i) => s + i.scanCount, 0))));

  renderTopScannedNotSoldTable(items, 10);

  renderSummaryTable('scannedNotSoldStoreContainer', summarizeItemsBy(items, i => i.store));
  renderRankedList('scannedNotSoldCategoryContainer', summarizeItemsBy(items, i => i.category));
  renderSummaryTable('scannedNotSoldPriceBandContainer', summarizeItemsBy(items, i => i.priceBand, lastData.priceBandOrder));

  scannedNotSoldTable.render(items);
}

function renderNotScannedTab(items) {
  const container = document.getElementById('notScannedKpiGrid');
  container.innerHTML = '';
  const totalValue = items.reduce((s, i) => s + (i.inventoryValue || 0), 0);
  container.appendChild(kpiCard('Never-scanned Items', formatCount(items.length)));
  container.appendChild(kpiCard('Total Inventory Value', formatAmount(round2(totalValue)), true));

  renderSummaryTable('notScannedStoreContainer', summarizeItemsBy(items, i => i.store));
  renderRankedList('notScannedCategoryContainer', summarizeItemsBy(items, i => i.category));
  renderSummaryTable('notScannedPriceBandContainer', summarizeItemsBy(items, i => i.priceBand, lastData.priceBandOrder));

  notScannedTable.render(items);
}

function renderCustomerTab(scanEvents, partyNames) {
  const allCustomers = buildCustomerAnalysis(scanEvents, partyNames);
  // Only customers with at least one purchase are shown — an identified
  // customer who scanned but never bought anything is excluded from this
  // view entirely (table + KPI cards below), by request.
  const customers = allCustomers.filter(c => c.purchased > 0);

  const container = document.getElementById('customerKpiGrid');
  container.innerHTML = '';
  container.appendChild(kpiCard('Customers Identified', formatCount(customers.length)));
  const purchasingPartyIds = new Set(customers.map(c => c.partyId));
  const attributedScanEvents = scanEvents.filter(s => purchasingPartyIds.has(s.resolvedPartyId)).length;
  container.appendChild(kpiCard('Attributed Scan Events', formatCount(attributedScanEvents)));
  const attributedUniqueProductsSold = new Set(scanEvents.filter(s => s.resolvedPartyId && s.sold).map(s => s.itemId)).size;
  container.appendChild(kpiCard('Products Sold', formatCount(attributedUniqueProductsSold), true));
  const avgConv = customers.length ? round2(customers.reduce((s, c) => s + c.conversionPct, 0) / customers.length) : 0;
  const directOnly = customers.filter(c => c.identitySource !== 'Matched sale only');
  const avgConvDirect = directOnly.length ? round2(directOnly.reduce((s, c) => s + c.conversionPct, 0) / directOnly.length) : 0;
  const avgConvCard = kpiCard('Avg. Conversion % (skewed by matched-sale-only rows)', `${avgConv}%`);
  const directNote = document.createElement('div');
  directNote.className = 'kpi-trend is-flat';
  directNote.textContent = `${avgConvDirect}% among customers with their own scan-level party_id`;
  avgConvCard.appendChild(directNote);
  container.appendChild(avgConvCard);

  customerTable.render(customers);
}

// -----------------------------------------------------------------------
// Filter wiring
// -----------------------------------------------------------------------
// Size options depend on which categories are selected — ring sizes only
// make sense once you've picked Rings, bracelet sizes only for Bracelets,
// etc. With no category selected, every size across every category is
// offered (unchanged from before).
function sizesForCategories(categories) {
  if (!lastData) return [];
  if (!categories.length) return lastData.filterOptions.sizes;
  const catSet = new Set(categories);
  return [...new Set([
    ...lastData.raw.scanEvents.filter(s => catSet.has(s.category)).map(s => s.size),
    ...lastData.raw.notScannedItems.filter(i => catSet.has(i.category)).map(i => i.size),
  ])].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

const storeMs = setupMultiselect({ toggleId: 'storeToggle', panelId: 'storePanel', allLabel: 'Store', onChange: v => { filterState.stores = v; if (lastData) renderAll(lastData); } });
const categoryMs = setupMultiselect({
  toggleId: 'categoryToggle', panelId: 'categoryPanel', allLabel: 'Category',
  onChange: v => {
    filterState.categories = v;
    sizeMs.setValues(sizesForCategories(v));
    filterState.sizes = sizeMs.getSelected();
    if (lastData) renderAll(lastData);
  },
});
const collectionMs = setupMultiselect({ toggleId: 'collectionToggle', panelId: 'collectionPanel', allLabel: 'Collection', onChange: v => { filterState.collections = v; if (lastData) renderAll(lastData); } });
const priceBandMs = setupMultiselect({ toggleId: 'priceBandToggle', panelId: 'priceBandPanel', allLabel: 'Price Band', onChange: v => { filterState.priceBands = v; if (lastData) renderAll(lastData); } });
const sizeMs = setupMultiselect({ toggleId: 'sizeToggle', panelId: 'sizePanel', allLabel: 'Size', onChange: v => { filterState.sizes = v; if (lastData) renderAll(lastData); } });

document.getElementById('dateFromInput').addEventListener('change', e => { filterState.dateFrom = e.target.value || null; if (lastData) renderAll(lastData); });
document.getElementById('dateToInput').addEventListener('change', e => { filterState.dateTo = e.target.value || null; if (lastData) renderAll(lastData); });
document.getElementById('skuSearchInput').addEventListener('input', e => { filterState.sku = e.target.value; if (lastData) renderAll(lastData); });

document.getElementById('globalResetFilters').addEventListener('click', () => {
  filterState.dateFrom = null; filterState.dateTo = null;
  filterState.stores = []; filterState.categories = []; filterState.collections = []; filterState.priceBands = []; filterState.sizes = [];
  filterState.sku = '';
  document.getElementById('dateFromInput').value = '';
  document.getElementById('dateToInput').value = '';
  document.getElementById('skuSearchInput').value = '';
  storeMs.reset(); categoryMs.reset(); collectionMs.reset(); priceBandMs.reset(); sizeMs.reset();
  if (lastData) renderAll(lastData);
});

// Per-table local search (narrows a table's own rows only — does not affect
// KPIs/charts, which follow the global filter bar above).
document.getElementById('scannedSoldSearch').addEventListener('input', e => {
  scannedSoldTable.setSearchTerm(e.target.value);
  if (lastData) renderScannedSoldTab(buildItemLevelScanStats(filterScanEvents(lastData.raw.scanEvents)));
});
document.getElementById('scannedNotSoldSearch').addEventListener('input', e => {
  scannedNotSoldTable.setSearchTerm(e.target.value);
  if (lastData) renderScannedNotSoldTab(buildItemLevelScanStats(filterScanEvents(lastData.raw.scanEvents)));
});
document.getElementById('notScannedSearch').addEventListener('input', e => {
  notScannedTable.setSearchTerm(e.target.value);
  if (lastData) renderNotScannedTab(filterNotScanned(lastData.raw.notScannedItems));
});
document.getElementById('customerSearch').addEventListener('input', e => {
  customerTable.setSearchTerm(e.target.value);
  if (lastData) renderCustomerTab(filterScanEvents(lastData.raw.scanEvents), lastData.partyNames);
});

// -----------------------------------------------------------------------
// Sidebar navigation + mobile toggle
// -----------------------------------------------------------------------
document.querySelectorAll('.sidebar-link').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-link').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.getElementById(btn.dataset.panel).classList.add('is-active');
    document.getElementById('sidebar').classList.remove('is-open');
  });
});
document.getElementById('sidebarToggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('is-open');
});

// -----------------------------------------------------------------------
// Load + wire up
// -----------------------------------------------------------------------
let lastData = null;

function renderAll(data) {
  const walkins = filterWalkins(data.raw.walkins);
  const scanEvents = filterScanEvents(data.raw.scanEvents);
  const notScannedItems = filterNotScanned(data.raw.notScannedItems);

  const kpis = computeKpis(walkins, scanEvents, notScannedItems);
  const storeFunnel = buildStoreFunnel(walkins, scanEvents);
  const weeklyTrend = buildWeeklyTrend(walkins, scanEvents);
  const today = todayISODate();
  const kpiTrends = {
    walkins: weekOverWeekPct(weeklyTrend, today, 'walkins'),
    scans: weekOverWeekPct(weeklyTrend, today, 'scans'),
    revenue: weekOverWeekPct(weeklyTrend, today, 'revenue'),
  };

  renderKpis(kpis, kpiTrends);
  renderFunnel(kpis);
  renderOverviewCharts(weeklyTrend, storeFunnel);
  renderFunnelTable(storeFunnel);

  const itemStats = buildItemLevelScanStats(scanEvents);
  renderScannedSoldTab(itemStats);
  renderScannedNotSoldTab(itemStats);
  renderNotScannedTab(notScannedItems);
  renderCustomerTab(scanEvents, data.partyNames);
}

async function loadData(forceRefresh) {
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.disabled = true;
  showStatus(null);
  try {
    const res = await fetch(`/api/scan-dashboard${forceRefresh ? '?refresh=true' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);

    lastData = data;
    storeMs.setValues(data.filterOptions.stores);
    categoryMs.setValues(data.filterOptions.categories);
    collectionMs.setValues(data.filterOptions.collections);
    priceBandMs.setValues(data.filterOptions.priceBands);
    sizeMs.setValues(data.filterOptions.sizes);

    renderAll(data);
    document.getElementById('updatedAt').textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString('en-IN');
  } catch (err) {
    showStatus(err.message || 'Failed to load scan dashboard data');
  } finally {
    refreshBtn.disabled = false;
  }
}

document.getElementById('refreshBtn').addEventListener('click', () => loadData(true));

loadData(false);
