function formatCount(n) {
  return new Intl.NumberFormat('en-IN').format(n || 0);
}

function formatDateOnly(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
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

function cell(html, className, isHtml) {
  const td = document.createElement('td');
  if (className) td.className = className;
  if (isHtml) td.innerHTML = html;
  else td.textContent = html;
  return td;
}

// -----------------------------------------------------------------------
// Reusable checkbox multiselect (same pattern as app.js / agent-performance.js)
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
    setSelected(newSelected) { selected = newSelected; updateToggleLabel(); renderPanel(); },
  };
}

// -----------------------------------------------------------------------
// Chart primitives — plain inline SVG, no external dependency.
// Thin marks, 4px rounded bar ends, muted gridlines, direct value labels,
// native <title> tooltip on hover (relief for the WARN-contrast palette slots).
// -----------------------------------------------------------------------
let openInfoPopover = null;
document.addEventListener('click', e => {
  if (openInfoPopover && !openInfoPopover.contains(e.target) && !e.target.classList.contains('chart-info-btn')) {
    openInfoPopover.hidden = true;
    openInfoPopover = null;
  }
});

// Small "i" button in the card's top-right corner — click toggles a popover
// explaining what the chart shows / how it's computed. Only one open at a time.
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

function renderBarChart(container, { title, data, emptyMessage, description }) {
  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'chart-card';
  addChartHeader(card, title, description);

  if (!data.length || data.every(d => !d.value)) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = emptyMessage || 'No data for the current filters';
    card.appendChild(empty);
    container.appendChild(card);
    return;
  }

  const width = 460;
  const rowHeight = 26;
  const barHeight = 16;
  const labelWidth = 96;
  const maxValue = Math.max(...data.map(d => d.value), 1);
  const plotWidth = width - labelWidth - 50;
  const height = data.length * rowHeight + 10;

  const wrap = document.createElement('div');
  wrap.className = 'chart-svg-wrap';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);

  data.forEach((d, i) => {
    const y = i * rowHeight + 5;
    const barW = Math.max((d.value / maxValue) * plotWidth, d.value > 0 ? 3 : 0);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', labelWidth - 8);
    label.setAttribute('y', y + barHeight / 2 + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'chart-bar-label');
    label.textContent = d.label;
    svg.appendChild(label);

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', labelWidth);
    rect.setAttribute('y', y);
    rect.setAttribute('width', barW);
    rect.setAttribute('height', barHeight);
    rect.setAttribute('rx', 4);
    rect.setAttribute('fill', d.color || 'var(--accent)');
    rect.setAttribute('class', 'chart-bar-rect');
    const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    titleEl.textContent = `${d.label}: ${formatCount(d.value)}`;
    rect.appendChild(titleEl);
    svg.appendChild(rect);

    const value = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    value.setAttribute('x', labelWidth + barW + 6);
    value.setAttribute('y', y + barHeight / 2 + 4);
    value.setAttribute('class', 'chart-bar-value');
    value.textContent = formatCount(d.value);
    svg.appendChild(value);
  });

  wrap.appendChild(svg);
  card.appendChild(wrap);
  container.appendChild(card);
}

function renderLineChart(container, { title, points, emptyMessage, description }) {
  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'chart-card';
  addChartHeader(card, title, description);

  if (!points.length) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = emptyMessage || 'No data for the current filters';
    card.appendChild(empty);
    container.appendChild(card);
    return;
  }

  const width = 640;
  const height = 180;
  const padding = { top: 10, right: 12, bottom: 24, left: 40 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const maxValue = Math.max(...points.map(p => p.value), 1);

  const wrap = document.createElement('div');
  wrap.className = 'chart-svg-wrap';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);

  // gridlines (3 horizontal)
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

  const xStep = points.length > 1 ? plotW / (points.length - 1) : 0;
  const coords = points.map((p, i) => ({
    x: padding.left + i * xStep,
    y: padding.top + plotH - (p.value / maxValue) * plotH,
    ...p,
  }));

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--accent)');
  path.setAttribute('stroke-width', 2);
  svg.appendChild(path);

  // sparse x labels (first, middle, last) to avoid clutter
  [0, Math.floor(coords.length / 2), coords.length - 1].forEach(i => {
    if (i < 0 || i >= coords.length) return;
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', coords[i].x);
    label.setAttribute('y', height - 6);
    label.setAttribute('text-anchor', i === 0 ? 'start' : i === coords.length - 1 ? 'end' : 'middle');
    label.setAttribute('class', 'chart-bar-label');
    label.textContent = coords[i].date;
    svg.appendChild(label);
  });

  coords.forEach(c => {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', c.x);
    dot.setAttribute('cy', c.y);
    dot.setAttribute('r', 3);
    dot.setAttribute('fill', 'var(--accent)');
    dot.setAttribute('class', 'chart-line-dot');
    const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    titleEl.textContent = `${c.date}: ${formatCount(c.value)}`;
    dot.appendChild(titleEl);
    svg.appendChild(dot);
  });

  wrap.appendChild(svg);
  card.appendChild(wrap);
  container.appendChild(card);
}

// -----------------------------------------------------------------------
// State
// -----------------------------------------------------------------------
let allRows = [];
let lastData = null;
let searchTerm = '';
let lastFilteredRows = [];
const filters = { store: [], ho: [], po: [], peer: [], transfer: [], metal: [] };

// Sales window — the backend fetches full sales history (see refillService.js),
// so "Last 90 Days" vs "Overall" is applied here by filtering on lastSold,
// rather than re-querying. Defaults to 90 days.
let salesWindow = '90d';

// Rows whose stock was already sent to the store after the last sale (see
// refillService.js). Hidden from the list, KPIs and charts unless ticked.
let showInTransit = false;
function withinSalesWindow(row) {
  if (salesWindow !== '90d') return true;
  if (!row.lastSold) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  return new Date(row.lastSold) >= cutoff;
}

// A KPI-card drill-down — separate from `filters` above so clicking a card
// only narrows the table below it, without changing what any KPI card
// (including the one clicked) itself displays.
let drill = null; // { type: 'ho'|'po'|'peer'|'transfer', value, label }

function drillMatches(row) {
  if (!drill) return true;
  if (drill.type === 'ho') return hoStatus(row) === drill.value;
  if (drill.type === 'po') return row.poStatus === drill.value;
  if (drill.type === 'peer') return peerStatus(row) === drill.value;
  if (drill.type === 'transfer') return (row.transferStatus || 'NONE') === drill.value;
  if (drill.type === 'sent') return !!row.inTransit;
  return true;
}

// HO (Head Office/warehouse) is intentionally excluded — it's not a retail
// store and has no refill list of its own; see refillService.js. HWI (backed
// by company_code FCS on the backend, relabeled "HWI" for display) is
// included like any other store.
const STORE_COLOR = { LPN: 'var(--series-2)', N18: 'var(--series-3)', PV1: 'var(--series-4)', PN1: 'var(--series-5)', BO1: 'var(--series-6)', HWI: 'var(--series-1)' };
const STORE_ORDER = ['LPN', 'N18', 'PV1', 'PN1', 'BO1', 'HWI'];

function hoStatus(row) { return row.hoOnHand > 0 ? 'HO AVAILABLE' : 'HO NOT AVAILABLE'; }
function peerStatus(row) { return row.peerHasRedFlag ? 'OLD STOCK' : (row.availableAtPeerStores ? 'AVAILABLE' : 'NONE'); }

function applyFilters(rows, opts) {
  const term = searchTerm.trim().toLowerCase();
  const includeInTransit = (opts && opts.includeInTransit) || showInTransit;
  return rows.filter(r => {
    if (!withinSalesWindow(r)) return false;
    if (r.inTransit && !includeInTransit) return false;
    if (filters.store.length && !filters.store.includes(r.store)) return false;
    if (filters.ho.length && !filters.ho.includes(hoStatus(r))) return false;
    if (filters.po.length && !filters.po.includes(r.poStatus)) return false;
    if (filters.peer.length && !filters.peer.includes(peerStatus(r))) return false;
    if (filters.transfer.length && !filters.transfer.includes(r.transferStatus || 'NONE')) return false;
    if (filters.metal.length && !filters.metal.includes(r.metal)) return false;
    if (term) {
      const haystack = `${r.sku} ${r.style} ${r.styleName || ''} ${r.store}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

// KPI cards for a single filterable dimension (HO/PO/Peer/Transfer status)
// are clickable — clicking one sets `drill` and re-renders ONLY the table
// below (not the KPI row or charts), so the drill-down never changes what
// any KPI card — including the one just clicked — itself displays.
function renderKpis(data, filteredRows) {
  const kpis = [
    { label: 'Total Refill SKUs', value: filteredRows.length },
    { label: 'Total Refill Qty', value: filteredRows.reduce((s, r) => s + r.reorderQty, 0) },
    { label: 'HO Available', value: filteredRows.filter(r => r.hoOnHand > 0).length, onClick: () => applyDrill({ type: 'ho', value: 'HO AVAILABLE', label: 'HO Available' }) },
    { label: 'HO Not Available', value: filteredRows.filter(r => r.hoOnHand === 0).length, onClick: () => applyDrill({ type: 'ho', value: 'HO NOT AVAILABLE', label: 'HO Not Available' }) },
    { label: 'Valid PO', value: filteredRows.filter(r => r.poStatus === 'VALID').length, onClick: () => applyDrill({ type: 'po', value: 'VALID', label: 'Valid PO' }) },
    { label: 'No Valid PO', value: filteredRows.filter(r => r.poStatus === 'NO VALID PO').length, onClick: () => applyDrill({ type: 'po', value: 'NO VALID PO', label: 'No Valid PO' }) },
    { label: 'Old Peer Stock >180d', value: filteredRows.filter(r => r.peerHasRedFlag).length, onClick: () => applyDrill({ type: 'peer', value: 'OLD STOCK', label: 'Old Peer Stock >180d' }) },
    { label: 'Transfer Candidates', value: filteredRows.filter(r => r.transferStatus === 'TRANSFER CANDIDATE').length, onClick: () => applyDrill({ type: 'transfer', value: 'TRANSFER CANDIDATE', label: 'Transfer Candidates' }) },
    {
      label: 'Sent To Store, Not In Stock Yet',
      value: applyFilters(allRows, { includeInTransit: true }).filter(r => r.inTransit).length,
      onClick: () => {
        showInTransit = true;
        const box = document.getElementById('showInTransit');
        if (box) box.checked = true;
        render();
        applyDrill({ type: 'sent', value: 'IN TRANSIT', label: 'Sent to store, not in stock yet' });
      },
    },
    { label: 'RTS Refill SKUs', value: filteredRows.length },
    { label: 'PDP Views', value: filteredRows.reduce((s, r) => s + (r.pdpViews || 0), 0) },
  ];
  const grid = document.getElementById('kpiGrid');
  grid.innerHTML = '';
  kpis.forEach(k => {
    const card = document.createElement('div');
    card.className = k.onClick ? 'kpi-card kpi-card--clickable' : 'kpi-card';
    card.innerHTML = `<div class="kpi-label">${k.label}</div><div class="kpi-value">${formatCount(k.value)}</div>`;
    if (k.onClick) {
      card.addEventListener('click', k.onClick);
    }
    grid.appendChild(card);
  });
}

function applyDrill(next) {
  drill = next;
  renderRefillTable(lastFilteredRows);
  scrollToRefillTable();
}

function clearDrill() {
  drill = null;
  renderRefillTable(lastFilteredRows);
}

function scrollToRefillTable() {
  document.getElementById('refillTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderCharts(rows) {
  const grid = document.getElementById('chartsGrid');
  grid.innerHTML = '';
  const sections = [
    document.createElement('div'), document.createElement('div'), document.createElement('div'),
    document.createElement('div'), document.createElement('div'), document.createElement('div'),
  ];
  sections.forEach(s => grid.appendChild(s));

  const byStore = STORE_ORDER.map(code => ({
    label: code, value: rows.filter(r => r.store === code).length, color: STORE_COLOR[code],
  }));
  renderBarChart(sections[0], {
    title: 'Refill SKUs by Store', data: byStore,
    description: 'Count of exact SKU + store combinations currently eligible for refill: sold at that store at least once (full sales history), and 0 units on hand there now.',
  });

  renderBarChart(sections[1], {
    title: 'Refill SKUs by Sales Cycle',
    data: [
      { label: 'Below 180', value: rows.filter(r => r.salesCycle === 'Below 180').length, color: 'var(--accent)' },
      { label: 'Above 180', value: rows.filter(r => r.salesCycle === 'Above 180').length, color: 'var(--text-muted)' },
    ],
    description: 'Ageing Days (Last Sold Date − the transfer that brought the stock into that store) split at the 180-day mark — how long the stock sat before it finally sold. Rows with no qualifying transfer record are excluded from this chart.',
  });

  renderBarChart(sections[2], {
    title: 'HO Available vs HO Not Available',
    data: [
      { label: 'Available', value: rows.filter(r => r.hoOnHand > 0).length, color: 'var(--accent)' },
      { label: 'Not Available', value: rows.filter(r => r.hoOnHand === 0).length, color: 'var(--text-muted)' },
    ],
    description: 'Whether Head Office (company_code = HO) currently holds any stock of the exact SKU that’s out of stock at the selling store.',
  });

  renderBarChart(sections[3], {
    title: 'Valid PO vs No Valid PO',
    data: [
      { label: 'Valid PO', value: rows.filter(r => r.poStatus === 'VALID').length, color: 'var(--accent)' },
      { label: 'No Valid PO', value: rows.filter(r => r.poStatus === 'NO VALID PO').length, color: 'var(--text-muted)' },
    ],
    description: 'A PO counts as Valid only when its Raised Date is after the exact SKU’s Last Sold Date. PO validity is checked at the SKU level only — no table links a PO to a specific store.',
  });

  const oldPeerByStore = STORE_ORDER.map(code => ({
    label: code, value: rows.filter(r => r.store === code && r.peerHasRedFlag).length, color: STORE_COLOR[code],
  }));
  renderBarChart(sections[4], {
    title: 'Old Peer Stock >180 Days by Store', data: oldPeerByStore,
    description: 'For each refill row, checks every other store (excluding HO and HWI Ventures) for a unit of the exact SKU whose oldest unit has been sitting for more than 180 days.',
  });

  const buckets = [
    { label: '0–30d', test: d => d != null && d <= 30 },
    { label: '31–90d', test: d => d != null && d > 30 && d <= 90 },
    { label: '91–180d', test: d => d != null && d > 90 && d <= 180 },
    { label: '>180d', test: d => d != null && d > 180 },
  ];
  renderBarChart(sections[5], {
    title: 'Ageing Distribution',
    data: buckets.map(b => ({ label: b.label, value: rows.filter(r => b.test(r.ageingDays)).length, color: 'var(--accent)' })),
    description: 'Distribution of Ageing Days (Last Sold Date − transfer-in date) across the refill list — how long stock sat before it sold. Rows with no qualifying transfer record are excluded from every bucket.',
  });
}

function peerCellHtml(row) {
  if (!row.peerEntries || !row.peerEntries.length) return '—';
  return row.peerEntries.map(e => {
    const ageing = e.ageingDays != null ? e.ageingDays : '—';
    const ageingHtml = e.isRedFlag ? `<span class="ageing-red">${ageing}</span>` : ageing;
    return `${e.store}-${e.qty}(${ageingHtml})`;
  }).join(', ');
}

function poStatusBadge(status) {
  return status === 'VALID'
    ? '<span class="badge badge-accent">VALID PO</span>'
    : '<span class="badge badge-neutral">NO VALID PO</span>';
}

const REFILL_TABLE_COLUMNS = [
  { label: 'Store', key: 'store' },
  { label: 'SKU', key: 'sku' },
  { label: 'Image', key: 'imageUrl', sortable: false },
  { label: 'Style', key: 'style' },
  { label: 'Size', key: 'size' },
  { label: 'Metal', key: 'metal' },
  { label: 'Transfer Date', key: 'transferDate' },
  { label: 'Sent To Store', key: 'sentDate' },
  { label: 'Last Sold', key: 'lastSold' },
  { label: 'Lifetime Sale', key: 'lifetimeSkuSales' },
  { label: 'Ageing (days)', key: 'ageingDays' },
  { label: 'Store Stock', key: 'currentStoreStock' },
  { label: 'HO On Hand', key: 'hoOnHand' },
  { label: 'Fulfillment', key: 'fulfillment' },
  { label: 'PO No', key: 'poNo' },
  { label: 'PO Date', key: 'poDate' },
  { label: 'PO Status', key: 'poStatus' },
  { label: 'Available At Peer Stores', key: 'availableAtPeerStores' },
  { label: 'PDP Views', key: 'pdpViews' },
  { label: 'ATC', key: 'atc' },
  { label: 'ATC Ratio', key: 'atcRatio' },
];

let refillSort = { key: null, dir: 'asc' };

function compareRefillRows(a, b, key) {
  const va = a[key];
  const vb = b[key];
  if (va == null && vb == null) return 0;
  if (va == null) return -1;
  if (vb == null) return 1;
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).toLowerCase().localeCompare(String(vb).toLowerCase());
}

function applyRefillSort(rows) {
  if (!refillSort.key) return rows;
  const dir = refillSort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => dir * compareRefillRows(a, b, refillSort.key));
}

function imageCellHtml(row) {
  if (!row.imageUrl || !/^https:\/\//i.test(row.imageUrl)) return '—';
  const safeUrl = row.imageUrl.replace(/"/g, '&quot;');
  return `<img src="${safeUrl}" alt="" class="refill-thumb" loading="lazy" />`;
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// "IN TRANSIT 3 Oct 2026" + the transfer document and unit count underneath.
function sentCellHtml(r) {
  if (!r.inTransit) return '—';
  return `<span class="badge badge-accent">IN TRANSIT</span> ${escapeText(formatDateOnly(r.sentDate))}` +
    `<br><span class="th-sub">${escapeText(r.sentDoc || '')} · ${r.sentUnits} unit${r.sentUnits === 1 ? '' : 's'}</span>`;
}

function buildRefillRow(r) {
  const tr = document.createElement('tr');
  tr.appendChild(cell(r.store));
  tr.appendChild(cell(r.sku));
  tr.appendChild(cell(imageCellHtml(r), 'cell-image', true));
  tr.appendChild(cell(r.style));
  tr.appendChild(cell(r.size || '—', r.size ? null : 'cell-muted'));
  tr.appendChild(cell(r.metal));
  tr.appendChild(cell(r.transferDate ? formatDateOnly(r.transferDate) : '—', r.transferDate ? null : 'cell-muted'));
  tr.appendChild(cell(sentCellHtml(r), r.inTransit ? null : 'cell-muted', true));
  tr.appendChild(cell(formatDateOnly(r.lastSold)));
  tr.appendChild(cell(formatCount(r.lifetimeSkuSales)));
  tr.appendChild(cell(r.ageingDays != null ? formatCount(r.ageingDays) : '—', r.ageingDays != null ? null : 'cell-muted'));
  tr.appendChild(cell(formatCount(r.currentStoreStock)));
  tr.appendChild(cell(formatCount(r.hoOnHand)));
  tr.appendChild(cell(r.fulfillment));
  tr.appendChild(cell(r.poNo || '—', r.poNo ? null : 'cell-muted'));
  tr.appendChild(cell(r.poDate ? formatDateOnly(r.poDate) : '—', r.poDate ? null : 'cell-muted'));
  tr.appendChild(cell(poStatusBadge(r.poStatus), null, true));
  tr.appendChild(cell(peerCellHtml(r), null, true));
  tr.appendChild(cell(formatCount(r.pdpViews)));
  tr.appendChild(cell(formatCount(r.atc)));
  const atcRatioGreen = r.atcRatio != null && r.atcRatio >= 2.5;
  tr.appendChild(cell(
    r.atcRatio == null ? '—' : `${r.atcRatio}%`,
    atcRatioGreen ? 'atc-ratio-green' : (r.atcRatio == null ? 'cell-muted' : null)
  ));
  return tr;
}

// A single combined table across every store, with its own Store filter
// above it (independent of the global Store filter in the top filters bar) —
// rows still carry a Store column, so a reader can distinguish stores without
// needing separate per-store tables.
let refillStoreFilter = [];

function renderRefillTable(rows) {
  const storeFiltered = refillStoreFilter.length ? rows.filter(r => refillStoreFilter.includes(r.store)) : rows;
  const drillFiltered = drill ? storeFiltered.filter(drillMatches) : storeFiltered;
  const sortedRows = applyRefillSort(drillFiltered);

  const meta = document.getElementById('refillTableMeta');
  meta.textContent = `${formatCount(sortedRows.length)} SKU${sortedRows.length === 1 ? '' : 's'}`;

  const badge = document.getElementById('refillDrillBadge');
  if (drill) {
    badge.innerHTML = '';
    badge.appendChild(document.createTextNode(`· Filtered by ${drill.label} `));
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'drill-clear-btn';
    clearBtn.textContent = '✕ clear';
    clearBtn.addEventListener('click', clearDrill);
    badge.appendChild(clearBtn);
  } else {
    badge.innerHTML = '';
  }

  const thead = document.getElementById('refillTableHead');
  thead.innerHTML = '';
  const headRow = document.createElement('tr');
  REFILL_TABLE_COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label;

    if (col.sortable !== false) {
      th.className = 'sortable-th';
      th.dataset.sortKey = col.key;

      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      if (refillSort.key === col.key) arrow.textContent = refillSort.dir === 'asc' ? '▲' : '▼';
      th.appendChild(arrow);

      th.addEventListener('click', () => {
        if (refillSort.key === col.key) {
          refillSort.dir = refillSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          refillSort = { key: col.key, dir: 'asc' };
        }
        render();
      });
    }

    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tbody = document.getElementById('refillTableBody');
  tbody.innerHTML = '';
  if (!sortedRows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = REFILL_TABLE_COLUMNS.length;
    td.className = 'cell-muted';
    td.style.textAlign = 'center';
    td.textContent = 'No refill-required SKUs under the current filters';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    sortedRows.forEach(r => tbody.appendChild(buildRefillRow(r)));
  }
}

function render() {
  if (!lastData) return;
  const filtered = applyFilters(allRows);
  lastFilteredRows = filtered;
  renderKpis(lastData, filtered);
  renderCharts(filtered);
  renderRefillTable(filtered);
}

function setupFilterOptions() {
  const stores = STORE_ORDER;
  const hoStates = ['HO AVAILABLE', 'HO NOT AVAILABLE'];
  const poStates = ['VALID', 'NO VALID PO'];
  const peerStates = ['OLD STOCK', 'AVAILABLE', 'NONE'];
  const transferStates = ['TRANSFER CANDIDATE', 'REVIEW', 'NO SALES HISTORY', 'NONE'];
  const metals = [...new Set(allRows.map(r => r.metal).filter(Boolean))].sort();

  storeMs.setValues(stores);
  hoMs.setValues(hoStates);
  poMs.setValues(poStates);
  peerMs.setValues(peerStates);
  transferMs.setValues(transferStates);
  metalMs.setValues(metals);
  refillStoreMs.setValues(stores);
}

const storeMs = setupMultiselect({ toggleId: 'storeToggle', panelId: 'storePanel', allLabel: 'All stores', onChange: v => { filters.store = v; } });
const hoMs = setupMultiselect({ toggleId: 'hoToggle', panelId: 'hoPanel', allLabel: 'All', onChange: v => { filters.ho = v; } });
const poMs = setupMultiselect({ toggleId: 'poToggle', panelId: 'poPanel', allLabel: 'All', onChange: v => { filters.po = v; } });
const peerMs = setupMultiselect({ toggleId: 'peerToggle', panelId: 'peerPanel', allLabel: 'All', onChange: v => { filters.peer = v; } });
const transferMs = setupMultiselect({ toggleId: 'transferToggle', panelId: 'transferPanel', allLabel: 'All', onChange: v => { filters.transfer = v; } });
const metalMs = setupMultiselect({ toggleId: 'metalToggle', panelId: 'metalPanel', allLabel: 'All metals', onChange: v => { filters.metal = v; } });
const refillStoreMs = setupMultiselect({ toggleId: 'refillStoreToggle', panelId: 'refillStorePanel', allLabel: 'All stores', onChange: v => { refillStoreFilter = v; render(); } });

const inTransitBox = document.getElementById('showInTransit');
if (inTransitBox) {
  inTransitBox.addEventListener('change', () => {
    showInTransit = inTransitBox.checked;
    if (!showInTransit && drill && drill.type === 'sent') drill = null;
    render();
  });
}

document.querySelectorAll('#windowToggle .option-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    salesWindow = btn.dataset.window;
    document.querySelectorAll('#windowToggle .option-btn').forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    render();
  });
});

async function loadData(forceRefresh) {
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.disabled = true;
  showStatus(null);
  try {
    const res = await fetch(`/api/refill-management${forceRefresh ? '?refresh=true' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);

    lastData = data;
    allRows = data.rows;
    setupFilterOptions();
    render();

    const banner = document.getElementById('dataQualityBanner');
    if (data.dataQualityNotes && data.dataQualityNotes.length) {
      banner.hidden = false;
      banner.innerHTML = '<strong>Data quality note:</strong> ' + data.dataQualityNotes.join('<br>');
    } else {
      banner.hidden = true;
    }

    document.getElementById('updatedAt').textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString('en-IN');
  } catch (err) {
    showStatus(err.message || 'Failed to load refill data');
  } finally {
    refreshBtn.disabled = false;
  }
}

document.getElementById('refreshBtn').addEventListener('click', () => loadData(true));
document.getElementById('applyFilters').addEventListener('click', () => {
  render();
});

document.getElementById('tableSearch').addEventListener('input', e => {
  searchTerm = e.target.value;
  render();
});

document.querySelectorAll('.page-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.page-tab-btn').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.page-panel').forEach(p => p.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.getElementById(btn.dataset.panel).classList.add('is-active');
  });
});

function csvEscape(text) {
  const s = String(text ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tableToCSV(table) {
  const lines = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = Array.from(tr.children).map(td => csvEscape(td.textContent.trim()));
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

// Delegated (not per-button) — the per-store refill tables and their export
// buttons are (re)created dynamically on every render(), so listeners
// attached at load time would miss them.
document.addEventListener('click', e => {
  const btn = e.target.closest('.export-btn');
  if (!btn) return;
  const table = document.getElementById(btn.dataset.exportTable);
  if (!table) return;
  downloadCSV(btn.dataset.exportFilename, tableToCSV(table));
});

loadData(false);
