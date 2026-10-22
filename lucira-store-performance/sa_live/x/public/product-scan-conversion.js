// -----------------------------------------------------------------------
// Product Scan & Conversion Dashboard
//
// All filtering/aggregation happens here in the browser: the server sends
// one flattened, already-joined payload (walkins / scanEvents / sales /
// products) once, and every KPI / chart / table below is recomputed from
// that payload whenever a filter changes — no extra BigQuery round trips.
//
// Classification (see the "Logic" panel at the bottom for the full writeup):
//   scanned && sold      -> SCANNED_AND_SOLD
//   scanned && !sold     -> SCANNED_NOT_SOLD
//   !scanned (inventory) -> NOT_SCANNED
// -----------------------------------------------------------------------

function formatCount(n) {
  return new Intl.NumberFormat('en-IN').format(n || 0);
}
function formatAmount(n) {
  if (!n) return '—';
  return '₹' + new Intl.NumberFormat('en-IN', { notation: 'compact', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function formatPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${round1(n)}%`;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function formatDateOnly(value) {
  if (!value) return '—';
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
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
  if (isHtml) td.innerHTML = html;
  else td.textContent = html;
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
    if (!panel.hidden && !toggle.contains(e.target) && !panel.contains(e.target)) panel.hidden = true;
  });

  return {
    setValues(newValues) { values = newValues; renderPanel(); },
    getSelected() { return selected; },
    setSelected(newSelected) { selected = newSelected; updateToggleLabel(); renderPanel(); },
  };
}

// -----------------------------------------------------------------------
// Chart primitives — plain inline SVG (same pattern as scan-dashboard.js)
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

const WALKIN_COLOR = '#5b8def';
const SCAN_COLOR = '#d4af37';
const SALE_COLOR = '#3fb27f';
const RISK_COLOR = '#c9564f';

function emptyCard(container, title, description) {
  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'chart-card';
  addChartHeader(card, title, description);
  const empty = document.createElement('div');
  empty.className = 'chart-empty';
  empty.textContent = 'No data for the current filters';
  card.appendChild(empty);
  container.appendChild(card);
  return card;
}

function renderMultiLineChart(container, { title, description, labels, series, valueFormatter }) {
  const fmt = valueFormatter || formatCount;
  const activeSeries = series.filter(s => s.values.some(v => v > 0));
  if (!labels.length || !activeSeries.length) { emptyCard(container, title, description); return; }

  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'chart-card';
  addChartHeader(card, title, description);
  card.appendChild(buildLegend(activeSeries.map(s => ({ label: s.name, color: s.color }))));

  const width = 640, height = 180;
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
    line.setAttribute('x1', padding.left); line.setAttribute('x2', width - padding.right);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
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
      dot.setAttribute('cx', c.x); dot.setAttribute('cy', c.y); dot.setAttribute('r', 3);
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

function renderBarChart(container, { title, description, rows, valueFormatter, color }) {
  const fmt = valueFormatter || formatCount;
  if (!rows.length || rows.every(r => !r.value)) { emptyCard(container, title, description); return; }

  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'chart-card';
  addChartHeader(card, title, description);

  const width = 460, rowHeight = 26, barHeight = 16, labelWidth = 120;
  const maxValue = Math.max(...rows.map(r => r.value), 1);
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
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', labelWidth - 8);
    label.setAttribute('y', y + barHeight / 2 + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'chart-bar-label');
    label.textContent = r.label;
    svg.appendChild(label);

    const segW = Math.max((r.value / maxValue) * plotWidth, r.value ? 3 : 0);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', labelWidth); rect.setAttribute('y', y);
    rect.setAttribute('width', segW); rect.setAttribute('height', barHeight);
    rect.setAttribute('rx', 3);
    rect.setAttribute('fill', color || WALKIN_COLOR);
    const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    titleEl.textContent = `${r.label}: ${fmt(r.value)}`;
    rect.appendChild(titleEl);
    svg.appendChild(rect);

    const value = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    value.setAttribute('x', labelWidth + segW + 6);
    value.setAttribute('y', y + barHeight / 2 + 4);
    value.setAttribute('class', 'chart-bar-value');
    value.textContent = fmt(r.value);
    svg.appendChild(value);
  });

  wrap.appendChild(svg);
  card.appendChild(wrap);
  container.appendChild(card);
}

// -----------------------------------------------------------------------
// Generic sortable/searchable item table
// -----------------------------------------------------------------------
function makeItemTable({ containerId, columns, searchFields, exportFilename, tableId, defaultSort }) {
  let sort = defaultSort || { key: columns[0].key, dir: 'asc' };
  let searchTerm = '';

  function compareRows(a, b, key) {
    const va = a[key], vb = b[key];
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
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap table-wrap--scroll-y table-wrap--spaced';
    const table = document.createElement('table');
    table.className = 'report-table';
    table.id = tableId;

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    columns.forEach(col => {
      const th = document.createElement('th');
      th.className = 'sortable-th';
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
    const tbody = document.createElement('tbody');
    if (!sortedRows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = columns.length;
      td.className = 'cell-muted';
      td.style.textAlign = 'center';
      td.textContent = 'No items for the current filters';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      sortedRows.forEach(r => {
        const tr = document.createElement('tr');
        columns.forEach(col => tr.appendChild(cell(col.render(r), col.className ? col.className(r) : null, !!col.isHtml, col.raw ? col.raw(r) : undefined)));
        tbody.appendChild(tr);
      });
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);

    const meta = document.createElement('div');
    meta.className = 'th-sub';
    meta.style.margin = '4px 0 8px';
    meta.textContent = `${formatCount(sortedRows.length)} of ${formatCount(rows.length)} rows`;
    container.insertBefore(meta, wrap);

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'export-btn';
    exportBtn.dataset.exportTable = tableId;
    exportBtn.dataset.exportFilename = exportFilename;
    exportBtn.innerHTML = '&#8595; Export CSV';
    container.appendChild(exportBtn);
  }

  return { render, setSearchTerm(term) { searchTerm = term; } };
}

function renderCrossTabTable(containerId, rows, { keyLabel, infoTexts }) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap table-wrap--spaced';
  const table = document.createElement('table');
  table.className = 'report-table';

  const headers = [keyLabel, 'Inventory', 'Scanned', 'Sold', 'Scan Not Sold', 'Not Scanned', 'Scan Rate', 'Scan-to-Sale %'];
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach(h => { const th = document.createElement('th'); th.textContent = h; headRow.appendChild(th); });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = headers.length; td.className = 'cell-muted'; td.style.textAlign = 'center';
    td.textContent = 'No data for the current filters';
    tr.appendChild(td); tbody.appendChild(tr);
  } else {
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.appendChild(cell(r.key));
      tr.appendChild(cell(formatCount(r.inventory), null, false, r.inventory));
      tr.appendChild(cell(formatCount(r.scanned), null, false, r.scanned));
      tr.appendChild(cell(formatCount(r.sold), null, false, r.sold));
      tr.appendChild(cell(formatCount(r.scanNotSold), null, false, r.scanNotSold));
      tr.appendChild(cell(formatCount(r.notScanned), null, false, r.notScanned));
      tr.appendChild(cell(formatPct(r.scanRatePct), null, false, r.scanRatePct));
      tr.appendChild(cell(formatPct(r.scanToSalePct), null, false, r.scanToSalePct));
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  if (infoTexts) {
    const note = document.createElement('p');
    note.className = 'th-sub';
    note.style.margin = '6px 0 0';
    note.textContent = infoTexts;
    container.appendChild(note);
  }
  container.appendChild(wrap);
}

// -----------------------------------------------------------------------
// State
// -----------------------------------------------------------------------
let RAW = null;
let DEFAULT_RANGE = { start: null, end: null };
const FILTERS = { start: null, end: null, stores: [], categories: [], priceBands: [], metals: [], sizes: [], sku: '' };

let ms = {};
let notScannedTable, scannedNotSoldTable;

function hasProductFilterActive() {
  return !!(FILTERS.categories.length || FILTERS.priceBands.length || FILTERS.metals.length || FILTERS.sizes.length || FILTERS.sku.trim());
}
function inDateRange(dateStr) {
  const isFullRange = FILTERS.start === DEFAULT_RANGE.start && FILTERS.end === DEFAULT_RANGE.end;
  if (!dateStr) return isFullRange;
  return dateStr >= FILTERS.start && dateStr <= FILTERS.end;
}
function storeMatch(store) { return !FILTERS.stores.length || FILTERS.stores.includes(store); }
function categoryMatch(v) { return !FILTERS.categories.length || (v != null && FILTERS.categories.includes(v)); }
function priceBandMatch(v) { return !FILTERS.priceBands.length || (v != null && FILTERS.priceBands.includes(v)); }
function metalMatch(v) { return !FILTERS.metals.length || (v != null && FILTERS.metals.includes(v)); }
function sizeMatch(v) { return !FILTERS.sizes.length || (v != null && FILTERS.sizes.includes(v)); }
function skuMatch(r) {
  const term = FILTERS.sku.trim().toLowerCase();
  if (!term) return true;
  return [r.itemCode, r.fullSku, r.itemName].some(v => v && v.toLowerCase().includes(term));
}

function filterWalkins() {
  return RAW.walkins.filter(w => inDateRange(w.date) && storeMatch(w.store));
}
function filterScanEvents() {
  return RAW.scanEvents.filter(s => {
    if (!inDateRange(s.date) || !storeMatch(s.store)) return false;
    if (s.matchedInInventory) {
      return categoryMatch(s.category) && priceBandMatch(s.priceBand) && metalMatch(s.metal) && sizeMatch(s.size) && skuMatch(s);
    }
    return !hasProductFilterActive();
  });
}
function filterSales() {
  return RAW.sales.filter(s =>
    inDateRange(s.date) && storeMatch(s.store) && categoryMatch(s.category) &&
    priceBandMatch(s.priceBand) && metalMatch(s.metal) && sizeMatch(s.size) && skuMatch(s)
  );
}
function filterProducts() {
  return RAW.products.filter(p =>
    storeMatch(p.store) && categoryMatch(p.category) && priceBandMatch(p.priceBand) &&
    metalMatch(p.metal) && sizeMatch(p.size) && skuMatch(p)
  );
}

function uniqueWalkinKey(w, i) { return w.phone || `__row_${i}`; }

function groupBy(items, keyFn) {
  const map = new Map();
  items.forEach(item => {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return map;
}

// -----------------------------------------------------------------------
// Compute everything from the current filter state
// -----------------------------------------------------------------------
function computeAll() {
  const walkins = filterWalkins();
  const scanEvents = filterScanEvents();
  const sales = filterSales();
  const products = filterProducts();

  const scannedItemIds = new Set(scanEvents.map(s => s.itemId));
  const soldFullSkus = new Set(sales.map(s => s.fullSku));

  const classified = products.map(p => {
    const scanned = scannedItemIds.has(p.itemId);
    const sold = !!(p.fullSku && soldFullSkus.has(p.fullSku));
    const status = !scanned ? 'NOT_SCANNED' : (sold ? 'SCANNED_AND_SOLD' : 'SCANNED_NOT_SOLD');
    return { ...p, scanned, sold, status };
  });

  const scanStatsByItemId = new Map();
  scanEvents.forEach(s => {
    if (!scanStatsByItemId.has(s.itemId)) {
      scanStatsByItemId.set(s.itemId, { scanCount: 0, firstScanDate: s.date, lastScanDate: s.date, stores: new Set(), matched: s.matchedInInventory, sample: s });
    }
    const st = scanStatsByItemId.get(s.itemId);
    st.scanCount += 1;
    if (s.date && (!st.firstScanDate || s.date < st.firstScanDate)) st.firstScanDate = s.date;
    if (s.date && (!st.lastScanDate || s.date > st.lastScanDate)) st.lastScanDate = s.date;
    if (s.store) st.stores.add(s.store);
  });

  // Orphan scanned items: item_id scanned but with no current Live_inventory row.
  const orphanRows = [];
  scanStatsByItemId.forEach((st, itemId) => {
    if (!st.matched) {
      orphanRows.push({
        itemId, itemCode: null, fullSku: null, itemName: null, category: 'Unknown',
        price: null, priceBand: 'Unknown', store: st.sample.store,
        scanCount: st.scanCount, firstScanDate: st.firstScanDate, lastScanDate: st.lastScanDate,
        scannedStores: [...st.stores].sort(), matchedInInventory: false,
      });
    }
  });

  const scannedAndSold = classified.filter(p => p.status === 'SCANNED_AND_SOLD');
  const scannedNotSold = classified.filter(p => p.status === 'SCANNED_NOT_SOLD');
  const notScanned = classified.filter(p => p.status === 'NOT_SCANNED');

  const scannedNotSoldRows = [
    ...scannedNotSold.map(p => {
      const st = scanStatsByItemId.get(p.itemId);
      return {
        itemId: p.itemId, itemCode: p.itemCode, fullSku: p.fullSku, itemName: p.itemName,
        category: p.category, metal: p.metal, size: p.size, price: p.price, priceBand: p.priceBand,
        store: p.store, scanCount: st ? st.scanCount : 0, firstScanDate: st ? st.firstScanDate : null,
        lastScanDate: st ? st.lastScanDate : null, scannedStores: st ? [...st.stores].sort() : [],
        matchedInInventory: true,
      };
    }),
    ...orphanRows,
  ];

  const totalWalkins = new Set(walkins.map(uniqueWalkinKey)).size;
  const walkinVisits = walkins.length;
  const totalScanEvents = scanEvents.length;
  const uniqueProductsScanned = scannedItemIds.size;
  const productsSold = new Set(sales.map(s => s.fullSku)).size;
  const scanRatePct = totalWalkins ? (totalScanEvents / totalWalkins) * 100 : 0;
  const scanToSalePct = uniqueProductsScanned ? (scannedAndSold.length / uniqueProductsScanned) * 100 : 0;
  const scannedNotSoldCount = scannedNotSoldRows.length;
  const scanButNotSalePct = uniqueProductsScanned ? (scannedNotSoldCount / uniqueProductsScanned) * 100 : 0;
  const notScannedCount = notScanned.length;
  const oldestUnscanned = notScanned.reduce((max, p) => (p.ageDays != null && (!max || p.ageDays > max.ageDays)) ? p : max, null);
  const inventoryValueUnscanned = round1(notScanned.reduce((s, p) => s + (p.inventoryValue || 0), 0));
  const scanNotSoldTotalScanEvents = scannedNotSoldRows.reduce((s, r) => s + r.scanCount, 0);

  return {
    walkins, scanEvents, sales, products, classified,
    scannedAndSold, scannedNotSold, notScanned, scannedNotSoldRows,
    kpis: {
      totalWalkins, walkinVisits, totalScanEvents, uniqueProductsScanned, productsSold,
      scanRatePct, scanToSalePct, scannedNotSoldCount, scanButNotSalePct, notScannedCount,
      oldestUnscanned, inventoryValueUnscanned, scanNotSoldTotalScanEvents,
      scannedAndSoldCount: scannedAndSold.length,
    },
  };
}

// -----------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------
function renderKpis(data) {
  const k = data.kpis;
  const groups = [
    { title: 'Customer / Store Activity', cards: [
      { label: 'Total Walk-ins', value: formatCount(k.totalWalkins), hint: `${formatCount(k.walkinVisits)} visit events` },
      { label: 'Customers Scanned', value: 'Not available', hint: 'No shared customer key between Walk-in and Scan data' },
      { label: 'Scan Rate', value: formatPct(k.scanRatePct), hint: 'Scan events ÷ Walk-ins' },
    ] },
    { title: 'Product Activity', cards: [
      { label: 'Total Scan Events', value: formatCount(k.totalScanEvents) },
      { label: 'Unique Products Scanned', value: formatCount(k.uniqueProductsScanned) },
      { label: 'Products Sold', value: formatCount(k.productsSold) },
      { label: 'Scan-to-Sale %', value: formatPct(k.scanToSalePct) },
    ] },
    { title: 'Opportunity', cards: [
      { label: 'Scanned but Not Sold', value: formatCount(k.scannedNotSoldCount) },
      { label: 'Not Scanned Products', value: formatCount(k.notScannedCount) },
      { label: 'Oldest Unscanned Product', value: k.oldestUnscanned ? `${formatCount(k.oldestUnscanned.ageDays)} days` : '—', hint: k.oldestUnscanned ? (k.oldestUnscanned.itemCode || k.oldestUnscanned.fullSku || '') : '' },
      { label: 'Inventory Value (Unscanned)', value: formatAmount(k.inventoryValueUnscanned) },
    ] },
  ];

  const root = document.getElementById('kpiSections');
  root.innerHTML = '';
  groups.forEach(g => {
    const section = document.createElement('div');
    section.className = 'kpi-group';
    const title = document.createElement('div');
    title.className = 'kpi-group-title';
    title.textContent = g.title;
    section.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'kpi-grid';
    g.cards.forEach(c => {
      const card = document.createElement('div');
      card.className = 'kpi-card';
      card.innerHTML = `<div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div>` +
        (c.hint ? `<div class="kpi-hint">${c.hint}</div>` : '');
      grid.appendChild(card);
    });
    section.appendChild(grid);
    root.appendChild(section);
  });
}

function renderFunnel(data) {
  const k = data.kpis;
  const container = document.getElementById('funnelContainer');
  container.innerHTML = '';

  const stages = [
    { label: 'Walk-ins', value: k.totalWalkins, sub: `${formatCount(k.walkinVisits)} visits`, color: WALKIN_COLOR },
    { label: 'Products Scanned', value: k.uniqueProductsScanned, sub: `${formatCount(k.totalScanEvents)} scan events`, color: SCAN_COLOR },
    { label: 'Scanned Products Sold', value: k.scannedAndSoldCount, sub: `of ${formatCount(k.uniqueProductsScanned)} scanned`, color: SALE_COLOR },
  ];
  const arrows = [
    { label: 'Scan Rate', pct: k.scanRatePct, desc: 'Scan events ÷ Walk-ins × 100' },
    { label: 'Scan-to-Sale', pct: k.scanToSalePct, desc: 'Scanned & sold products ÷ Scanned products × 100' },
  ];

  const row = document.createElement('div');
  row.className = 'funnel-row';
  stages.forEach((s, i) => {
    const box = document.createElement('div');
    box.className = 'funnel-box';
    box.style.borderColor = s.color;
    box.innerHTML = `<div class="funnel-box-value">${formatCount(s.value)}</div><div class="funnel-box-label">${s.label}</div><div class="funnel-box-sub">${s.sub}</div>`;
    row.appendChild(box);
    if (i < stages.length - 1) {
      const arrow = document.createElement('div');
      arrow.className = 'funnel-arrow';
      arrow.innerHTML = `<div class="funnel-arrow-pct">${formatPct(arrows[i].pct)}</div><div class="funnel-arrow-line">&rarr;</div><div class="funnel-arrow-label">${arrows[i].label}</div>`;
      arrow.title = arrows[i].desc;
      row.appendChild(arrow);
    }
  });
  container.appendChild(row);
}

function renderTrend(data) {
  const byDate = groupBy(data.walkins, w => w.date || 'Unknown');
  const scanByDate = groupBy(data.scanEvents, s => s.date || 'Unknown');
  const saleByDate = groupBy(data.sales, s => s.date || 'Unknown');
  const dates = [...new Set([...byDate.keys(), ...scanByDate.keys(), ...saleByDate.keys()])]
    .filter(d => d !== 'Unknown').sort();

  const soldFullSkus = new Set(data.sales.map(s => s.fullSku));

  renderMultiLineChart(document.getElementById('trendCountsChart'), {
    title: 'Walk-ins / Scans / Sales — Daily Trend',
    description: 'Daily count of unique walk-in customers, scan events, and sale line items, for the current filters.',
    labels: dates,
    series: [
      { name: 'Walk-ins', color: WALKIN_COLOR, values: dates.map(d => new Set((byDate.get(d) || []).map(uniqueWalkinKey)).size) },
      { name: 'Scans', color: SCAN_COLOR, values: dates.map(d => (scanByDate.get(d) || []).length) },
      { name: 'Sales', color: SALE_COLOR, values: dates.map(d => (saleByDate.get(d) || []).length) },
    ],
  });

  const scanToSaleByDate = dates.map(d => {
    const dayScans = scanByDate.get(d) || [];
    const scannedIds = new Set(dayScans.map(s => s.itemId));
    if (!scannedIds.size) return 0;
    const soldOfThoseIds = dayScans.filter(s => s.fullSku && soldFullSkus.has(s.fullSku)).map(s => s.itemId);
    return (new Set(soldOfThoseIds).size / scannedIds.size) * 100;
  });
  renderMultiLineChart(document.getElementById('trendConversionChart'), {
    title: 'Scan-to-Sale % — Daily Trend',
    description: 'Of the products scanned that day, the % that eventually sold (any time, not necessarily same-day) — based on the current filters.',
    labels: dates,
    series: [{ name: 'Scan-to-Sale %', color: SALE_COLOR, values: scanToSaleByDate }],
    valueFormatter: formatPct,
  });
}

function buildCrossTab(data, keyField, keyOrder) {
  const products = data.products;
  const classified = data.classified;
  const sales = data.sales;
  const keys = keyOrder || [...new Set(products.map(p => p[keyField]))].sort();

  return keys.map(key => {
    const invItems = products.filter(p => p[keyField] === key);
    const classItems = classified.filter(p => p[keyField] === key);
    const scannedCount = classItems.filter(p => p.scanned).length;
    const soldCount = new Set(sales.filter(s => s[keyField] === key).map(s => s.fullSku)).size;
    const scanNotSoldCount = classItems.filter(p => p.status === 'SCANNED_NOT_SOLD').length;
    const notScannedCount = classItems.filter(p => p.status === 'NOT_SCANNED').length;
    const scannedAndSoldCount = classItems.filter(p => p.status === 'SCANNED_AND_SOLD').length;
    return {
      key,
      inventory: invItems.length,
      scanned: scannedCount,
      sold: soldCount,
      scanNotSold: scanNotSoldCount,
      notScanned: notScannedCount,
      scanRatePct: invItems.length ? (scannedCount / invItems.length) * 100 : 0,
      scanToSalePct: scannedCount ? (scannedAndSoldCount / scannedCount) * 100 : 0,
    };
  }).filter(r => r.inventory || r.scanned || r.sold);
}

function renderPriceBandSection(data) {
  const rows = buildCrossTab(data, 'priceBand', RAW.priceBandOrder.filter(b => b !== 'Unknown').concat('Unknown'));
  renderCrossTabTable('priceBandTableContainer', rows, {
    keyLabel: 'Price Band',
    infoTexts: 'Scan Rate = Scanned ÷ Inventory (share of that band ever scanned). Scan-to-Sale % = Scanned & Sold ÷ Scanned.',
  });

  const grid = document.getElementById('priceBandChartsGrid');
  grid.innerHTML = '';
  const sections = Array.from({ length: 4 }, () => document.createElement('div'));
  sections.forEach(s => grid.appendChild(s));

  renderBarChart(sections[0], { title: 'Scans by Price Band', rows: rows.map(r => ({ label: r.key, value: r.scanned })), color: SCAN_COLOR });
  renderBarChart(sections[1], { title: 'Sales by Price Band', rows: rows.map(r => ({ label: r.key, value: r.sold })), color: SALE_COLOR });
  renderBarChart(sections[2], { title: 'Scan-to-Sale % by Price Band', rows: rows.map(r => ({ label: r.key, value: round1(r.scanToSalePct) })), valueFormatter: formatPct, color: SALE_COLOR });
  renderBarChart(sections[3], { title: 'Not Scanned by Price Band', rows: rows.map(r => ({ label: r.key, value: r.notScanned })), color: RISK_COLOR });
}

function renderCategorySection(data) {
  const rows = buildCrossTab(data, 'category');
  renderCrossTabTable('categoryTableContainer', rows, {
    keyLabel: 'Category',
    infoTexts: 'Scan Rate = Scanned ÷ Inventory (share of that category ever scanned). Scan-to-Sale % = Scanned & Sold ÷ Scanned.',
  });

  const grid = document.getElementById('categoryChartsGrid');
  grid.innerHTML = '';
  const sections = Array.from({ length: 5 }, () => document.createElement('div'));
  sections.forEach(s => grid.appendChild(s));

  renderBarChart(sections[0], { title: 'Scans by Category', rows: rows.map(r => ({ label: r.key, value: r.scanned })), color: SCAN_COLOR });
  renderBarChart(sections[1], { title: 'Sales by Category', rows: rows.map(r => ({ label: r.key, value: r.sold })), color: SALE_COLOR });
  renderBarChart(sections[2], { title: 'Scanned but Not Sold, by Category', rows: rows.map(r => ({ label: r.key, value: r.scanNotSold })), color: RISK_COLOR });
  renderBarChart(sections[3], { title: 'Not Scanned by Category', rows: rows.map(r => ({ label: r.key, value: r.notScanned })), color: RISK_COLOR });
  renderBarChart(sections[4], { title: 'Scan-to-Sale % by Category', rows: rows.map(r => ({ label: r.key, value: round1(r.scanToSalePct) })), valueFormatter: formatPct, color: SALE_COLOR });
}

function renderAgeingSection(data) {
  const notScanned = data.notScanned;
  const container = document.getElementById('ageingKpiGrid');
  container.innerHTML = '';
  const qty = notScanned.reduce((s, p) => s + (p.piecesOnHand || 0), 0);
  const value = notScanned.reduce((s, p) => s + (p.inventoryValue || 0), 0);
  const withAge = notScanned.filter(p => p.ageDays != null);
  const avgAge = withAge.length ? Math.round(withAge.reduce((s, p) => s + p.ageDays, 0) / withAge.length) : null;
  const maxAge = withAge.length ? Math.max(...withAge.map(p => p.ageDays)) : null;

  [
    { label: 'Unscanned SKUs', value: formatCount(notScanned.length) },
    { label: 'Inventory Qty', value: formatCount(qty) },
    { label: 'Inventory Value', value: formatAmount(value) },
    { label: 'Average Age', value: avgAge != null ? `${avgAge} days` : '—' },
    { label: 'Maximum Age', value: maxAge != null ? `${maxAge} days` : '—' },
  ].forEach(k => {
    const card = document.createElement('div');
    card.className = 'kpi-card';
    card.innerHTML = `<div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div>`;
    container.appendChild(card);
  });

  const byBand = RAW.ageBandOrder.map(band => {
    const items = notScanned.filter(p => p.ageBand === band);
    return { label: band, value: items.length, invValue: items.reduce((s, p) => s + (p.inventoryValue || 0), 0) };
  });
  renderBarChart(document.getElementById('ageingDistChart'), {
    title: 'Ageing Distribution — Not Scanned Products',
    description: 'Count of unscanned SKUs by how long they have been in stock (days since document_date on Live_inventory).',
    rows: byBand,
    color: RISK_COLOR,
  });

  const topOldest = [...withAge].sort((a, b) => b.ageDays - a.ageDays).slice(0, 10);
  const tbody = document.getElementById('topOldestBody');
  tbody.innerHTML = '';
  if (!topOldest.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7; td.className = 'cell-muted'; td.style.textAlign = 'center';
    td.textContent = 'No unscanned products for the current filters';
    tr.appendChild(td); tbody.appendChild(tr);
  } else {
    topOldest.forEach(p => {
      const tr = document.createElement('tr');
      tr.appendChild(cell(p.itemCode || p.fullSku || '—'));
      tr.appendChild(cell(p.itemName || '—'));
      tr.appendChild(cell(p.category));
      tr.appendChild(cell(p.price != null ? formatAmount(p.price) : '—', null, false, p.price));
      tr.appendChild(cell(p.priceBand));
      tr.appendChild(cell(`${p.ageDays} days`, 'ageing-red', false, p.ageDays));
      tr.appendChild(cell(p.store || '—'));
      tbody.appendChild(tr);
    });
  }
}

const NOT_SCANNED_COLUMNS = [
  { key: 'itemCode', label: 'SKU', render: r => r.itemCode || r.fullSku || '—' },
  { key: 'itemName', label: 'Product', render: r => r.itemName || '—' },
  { key: 'category', label: 'Category', render: r => r.category },
  { key: 'price', label: 'Price', render: r => r.price != null ? formatAmount(r.price) : '—', raw: r => r.price },
  { key: 'priceBand', label: 'Price Band', render: r => r.priceBand },
  { key: 'ageDays', label: 'Age', render: r => r.ageDays != null ? `${formatCount(r.ageDays)} days` : '—', raw: r => r.ageDays, className: r => (r.ageDays != null && r.ageDays > 180 ? 'ageing-red' : null) },
  { key: 'piecesOnHand', label: 'Stock Qty', render: r => formatCount(r.piecesOnHand), raw: r => r.piecesOnHand },
  { key: 'store', label: 'Store', render: r => r.store || '—' },
];
const SCANNED_NOT_SOLD_COLUMNS = [
  { key: 'itemCode', label: 'SKU', render: r => r.itemCode || r.fullSku || '—' },
  { key: 'itemName', label: 'Product', render: r => r.itemName || '—' },
  { key: 'category', label: 'Category', render: r => r.category },
  { key: 'price', label: 'Price', render: r => r.price != null ? formatAmount(r.price) : '—', raw: r => r.price },
  { key: 'priceBand', label: 'Price Band', render: r => r.priceBand },
  { key: 'scanCount', label: 'Scan Count', render: r => formatCount(r.scanCount), raw: r => r.scanCount },
  { key: 'lastScanDate', label: 'Last Scan Date', render: r => formatDateOnly(r.lastScanDate) },
  { key: 'store', label: 'Store', render: r => (r.scannedStores && r.scannedStores.length ? r.scannedStores.join(', ') : (r.store || '—')) },
];

function renderTables(data) {
  const scannedNotSoldRoot = document.getElementById('scannedNotSoldKpiGrid');
  scannedNotSoldRoot.innerHTML = '';
  [
    { label: 'Scanned Products', value: formatCount(data.kpis.uniqueProductsScanned) },
    { label: 'Scanned but Not Sold', value: formatCount(data.kpis.scannedNotSoldCount) },
    { label: 'Scan-but-not-sale %', value: formatPct(data.kpis.scanButNotSalePct) },
    { label: 'Total Scan Events (Unsold)', value: formatCount(data.kpis.scanNotSoldTotalScanEvents) },
  ].forEach(k => {
    const card = document.createElement('div');
    card.className = 'kpi-card';
    card.innerHTML = `<div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div>`;
    scannedNotSoldRoot.appendChild(card);
  });

  notScannedTable.render(data.notScanned.slice().sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0)));
  scannedNotSoldTable.render(data.scannedNotSoldRows.slice().sort((a, b) => b.scanCount - a.scanCount));
}

function renderAll() {
  if (!RAW) return;
  const data = computeAll();
  renderKpis(data);
  renderFunnel(data);
  renderTrend(data);
  renderPriceBandSection(data);
  renderCategorySection(data);
  renderAgeingSection(data);
  renderTables(data);
}

// -----------------------------------------------------------------------
// Filter wiring
// -----------------------------------------------------------------------
const FILTER_ALL_LABELS = { store: 'All stores', category: 'All categories', priceBand: 'All price bands', metal: 'All metals', size: 'All sizes' };

function setupFilters() {
  ['store', 'category', 'priceBand', 'metal', 'size'].forEach(key => {
    ms[key] = setupMultiselect({
      toggleId: `${key}Toggle`, panelId: `${key}Panel`, allLabel: FILTER_ALL_LABELS[key],
      onChange: selected => {
        FILTERS[key === 'priceBand' ? 'priceBands' : key + 's'] = selected;
        renderAll();
      },
    });
  });

  document.getElementById('startDate').addEventListener('change', e => { FILTERS.start = e.target.value || DEFAULT_RANGE.start; renderAll(); });
  document.getElementById('endDate').addEventListener('change', e => { FILTERS.end = e.target.value || DEFAULT_RANGE.end; renderAll(); });

  let skuTimer = null;
  document.getElementById('skuSearch').addEventListener('input', e => {
    clearTimeout(skuTimer);
    skuTimer = setTimeout(() => { FILTERS.sku = e.target.value; renderAll(); }, 200);
  });

  document.getElementById('resetFilters').addEventListener('click', () => {
    FILTERS.start = DEFAULT_RANGE.start;
    FILTERS.end = DEFAULT_RANGE.end;
    FILTERS.stores = []; FILTERS.categories = []; FILTERS.priceBands = []; FILTERS.metals = []; FILTERS.sizes = []; FILTERS.sku = '';
    document.getElementById('startDate').value = DEFAULT_RANGE.start;
    document.getElementById('endDate').value = DEFAULT_RANGE.end;
    document.getElementById('skuSearch').value = '';
    Object.values(ms).forEach(m => m.setSelected([]));
    renderAll();
  });

  document.getElementById('notScannedSearch').addEventListener('input', e => {
    if (!RAW) return;
    notScannedTable.setSearchTerm(e.target.value);
    renderTables(computeAll());
  });
  document.getElementById('scannedNotSoldSearch').addEventListener('input', e => {
    if (!RAW) return;
    scannedNotSoldTable.setSearchTerm(e.target.value);
    renderTables(computeAll());
  });
}

async function loadData(forceRefresh) {
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.disabled = true;
  showStatus(null);
  try {
    const res = await fetch(`/api/product-scan-conversion${forceRefresh ? '?refresh=true' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);

    RAW = data;
    DEFAULT_RANGE = { start: data.filterOptions.dateMin, end: data.filterOptions.dateMax };
    FILTERS.start = DEFAULT_RANGE.start;
    FILTERS.end = DEFAULT_RANGE.end;

    document.getElementById('startDate').min = DEFAULT_RANGE.start;
    document.getElementById('startDate').max = DEFAULT_RANGE.end;
    document.getElementById('startDate').value = DEFAULT_RANGE.start;
    document.getElementById('endDate').min = DEFAULT_RANGE.start;
    document.getElementById('endDate').max = DEFAULT_RANGE.end;
    document.getElementById('endDate').value = DEFAULT_RANGE.end;

    ms.store.setValues(data.filterOptions.stores);
    ms.category.setValues(data.filterOptions.categories);
    ms.priceBand.setValues(data.filterOptions.priceBands);
    ms.metal.setValues(data.filterOptions.metals);
    ms.size.setValues(data.filterOptions.sizes);

    notScannedTable = makeItemTable({
      containerId: 'notScannedTableContainer', columns: NOT_SCANNED_COLUMNS,
      searchFields: ['itemCode', 'fullSku', 'itemName', 'category', 'store'],
      exportFilename: 'not-scanned-products', tableId: 'notScannedTable',
      defaultSort: { key: 'ageDays', dir: 'desc' },
    });
    scannedNotSoldTable = makeItemTable({
      containerId: 'scannedNotSoldTableContainer', columns: SCANNED_NOT_SOLD_COLUMNS,
      searchFields: ['itemCode', 'fullSku', 'itemName', 'category', 'store'],
      exportFilename: 'scanned-but-not-sold', tableId: 'scannedNotSoldTable',
      defaultSort: { key: 'scanCount', dir: 'desc' },
    });

    renderAll();
    document.getElementById('updatedAt').textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString('en-IN');
  } catch (err) {
    showStatus(err.message || 'Failed to load dashboard data');
  } finally {
    refreshBtn.disabled = false;
  }
}

document.getElementById('refreshBtn').addEventListener('click', () => loadData(true));
setupFilters();
loadData(false);
