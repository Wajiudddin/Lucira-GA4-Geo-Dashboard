function formatCount(n) {
  return new Intl.NumberFormat('en-IN').format(n || 0);
}

function formatPct(n) {
  return `${(n || 0).toFixed(1)}%`;
}

function formatDisplayDate(dayKey) {
  return new Date(`${dayKey}T00:00:00+05:30`).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function formatHHMMSSFromSeconds(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatAmount(n) {
  if (!n) return '—';
  return '₹' + new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
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

let state = {
  dateField: 'Created_Time',
  range: 'yesterday',
  customStart: null,
  customEnd: null,
  agents: [],
};

let lastReportData = null;

// Reusable checkbox multi-select: an "All" row plus one row per value, a toggle
// button summarizing the current selection, and outside-click / re-open close.
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
    setValues(newValues) {
      values = newValues;
      renderPanel();
    },
  };
}

const agentMultiselect = setupMultiselect({
  toggleId: 'agentToggle',
  panelId: 'agentPanel',
  allLabel: 'All agents',
  onChange: selected => {
    state.agents = selected;
  },
});

async function loadMeta() {
  try {
    const res = await fetch('/api/meta');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load filter options');
    agentMultiselect.setValues(data.agents || []);
  } catch (err) {
    showStatus(err.message || 'Failed to load filter options');
  }
}

function cell(text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function renderEmptyRow(tbody, message, colSpan) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colSpan;
  td.className = 'cell-muted';
  td.style.textAlign = 'center';
  td.textContent = message;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function sumCol(rows, key) {
  return rows.reduce((sum, r) => sum + (r[key] || 0), 0);
}

// col: { key, label (th innerHTML), render(row)->text, total(rows)->text,
// className(row)->class|null, classNameTotal(rows)->class|null }. Only `key`
// and `label` are required — everything else defaults to a plain count/sum.
function renderTable({ theadId, tbodyId, metaId, metaLabel, metaKey, cols, rows }) {
  const thead = document.getElementById(theadId);
  const tbody = document.getElementById(tbodyId);
  thead.innerHTML = '';
  tbody.innerHTML = '';

  const headRow = document.createElement('tr');
  headRow.appendChild((() => { const th = document.createElement('th'); th.textContent = 'Owner'; return th; })());
  cols.forEach(c => {
    const th = document.createElement('th');
    th.innerHTML = c.label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  document.getElementById(metaId).textContent = `${metaLabel}: ${formatCount(sumCol(rows, metaKey))}`;

  if (!rows.length) {
    renderEmptyRow(tbody, 'No data in this range', cols.length + 1);
    return;
  }

  rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.appendChild(cell(row.agent));
    cols.forEach(c => {
      const text = c.render ? c.render(row) : formatCount(row[c.key]);
      const cls = c.className ? c.className(row) : null;
      tr.appendChild(cell(text, cls));
    });
    tbody.appendChild(tr);
  });

  const totalRow = document.createElement('tr');
  totalRow.className = 'row-total';
  totalRow.appendChild(cell('Grand Total'));
  cols.forEach(c => {
    const text = c.total ? c.total(rows) : formatCount(sumCol(rows, c.key));
    const cls = c.classNameTotal ? c.classNameTotal(rows) : null;
    totalRow.appendChild(cell(text, cls));
  });
  tbody.appendChild(totalRow);
}

const DEALS_COLS = [
  { key: 'totalDeals', label: 'Total deals' },
  { key: 'calledCount', label: 'Calls on deals' },
  {
    key: 'under15MinCount', label: 'Calls &lt;15min<br><span class="th-sub">of total deals</span>',
    render: row => formatPct(row.totalDeals ? (row.under15MinCount / row.totalDeals) * 100 : 0),
    total: rows => {
      const totalDeals = sumCol(rows, 'totalDeals');
      const under15 = sumCol(rows, 'under15MinCount');
      return formatPct(totalDeals ? (under15 / totalDeals) * 100 : 0);
    },
  },
  { key: 'dueCount', label: 'Due task<br><span class="th-sub">due date &le; today, not completed, deal open</span>' },
  {
    key: 'overdueCount', label: 'Overdue task<br><span class="th-sub">due date &lt; today, not completed, deal open</span>',
    className: row => row.overdueCount ? 'cell-lost' : null,
    classNameTotal: rows => sumCol(rows, 'overdueCount') ? 'cell-lost' : null,
  },
  { key: 'workingHourCount', label: 'Working hours<br><span class="th-sub">10am&ndash;9pm, deal created</span>' },
  { key: 'workingHourCalledCount', label: 'Working hours<br><span class="th-sub">called (call compulsory)</span>' },
  { key: 'nonWorkingHourCount', label: 'Non-working hours<br><span class="th-sub">9pm&ndash;10am, deal created</span>' },
  { key: 'workStatusOpenCount', label: 'Work status: Open<br><span class="th-sub">not closed, never called</span>' },
  { key: 'workStatusWipCount', label: 'Work status: WIP<br><span class="th-sub">not closed, has been called</span>' },
  { key: 'workStatusClosedCount', label: 'Work status: Closed<br><span class="th-sub">Closed Won/Lost</span>' },
  { key: 'attempt1Count', label: 'No of attempt<br><span class="th-sub">1</span>' },
  { key: 'attempt2Count', label: 'No of attempt<br><span class="th-sub">2</span>' },
  { key: 'attempt3Count', label: 'No of attempt<br><span class="th-sub">3</span>' },
  { key: 'attempt4PlusCount', label: 'No of attempt<br><span class="th-sub">4 and above</span>' },
];

const DEAL_CALL_STATUS_COLS = [
  { key: 'dealAssignCount', label: 'Deal assign' },
  {
    key: 'dialedCount', label: 'Call dialed',
    render: row => formatCount(row.connectedCount + row.notConnectedCount),
    total: rows => formatCount(sumCol(rows, 'connectedCount') + sumCol(rows, 'notConnectedCount')),
  },
  { key: 'calledButOpenCount', label: 'Called but status open' },
  {
    key: 'undialedCount', label: 'Undialed',
    className: row => row.undialedCount ? 'cell-lost' : null,
    classNameTotal: rows => sumCol(rows, 'undialedCount') ? 'cell-lost' : null,
  },
  { key: 'taskWithoutCallCount', label: 'Task created<br><span class="th-sub">without call</span>' },
];

const CALLS_COLS = [
  { key: 'totalDealsAssigned', label: 'Total deals<br><span class="th-sub">assigned</span>' },
  { key: 'totalCalls', label: 'Total calls' },
  {
    key: 'totalDurationSeconds', label: 'Talk time<br><span class="th-sub">total, hh:mm:ss</span>',
    render: row => row.talkTimeFormatted || '00:00:00',
    total: rows => formatHHMMSSFromSeconds(sumCol(rows, 'totalDurationSeconds')),
  },
  { key: 'over30sCount', label: 'Calls &ge;30s' },
  {
    key: 'callPct', label: 'Call %<br><span class="th-sub">&ge;30s of total</span>',
    render: row => formatPct(row.totalCalls ? (row.over30sCount / row.totalCalls) * 100 : 0),
    total: rows => {
      const totalCalls = sumCol(rows, 'totalCalls');
      const connected = sumCol(rows, 'over30sCount');
      return formatPct(totalCalls ? (connected / totalCalls) * 100 : 0);
    },
  },
];

const CLOSED_LOST_COLS = [
  { key: 'closedCount', label: 'Closed count' },
  {
    key: 'connectedCount', label: 'Connected<br><span class="th-sub">&ge;30s call happened</span>',
    className: row => row.connectedCount ? 'cell-won' : null,
    classNameTotal: rows => sumCol(rows, 'connectedCount') ? 'cell-won' : null,
  },
  { key: 'calledNotConnectedCount', label: 'Called, not connected<br><span class="th-sub">no call &ge;30s</span>' },
  {
    key: 'noCallCount', label: 'Closed without any call',
    className: row => row.noCallCount ? 'cell-lost' : null,
    classNameTotal: rows => sumCol(rows, 'noCallCount') ? 'cell-lost' : null,
  },
];

const TASKS_COLS = [
  { key: 'totalTasks', label: 'Created task' },
  {
    key: 'calledCount', label: 'Called<br><span class="th-sub">linked deal has a call</span>',
    className: row => row.calledCount ? 'cell-won' : null,
    classNameTotal: rows => sumCol(rows, 'calledCount') ? 'cell-won' : null,
  },
  {
    key: 'notCalledCount', label: 'Not called',
    className: row => row.notCalledCount ? 'cell-lost' : null,
    classNameTotal: rows => sumCol(rows, 'notCalledCount') ? 'cell-lost' : null,
  },
];

function renderDealsTable(rows) {
  renderTable({
    theadId: 'dealsTableHead', tbodyId: 'dealsTableBody', metaId: 'dealsMeta',
    metaLabel: 'Total deals', metaKey: 'totalDeals', cols: DEALS_COLS, rows,
  });
}

function renderDealCallStatusTable(rows) {
  renderTable({
    theadId: 'dealCallStatusTableHead', tbodyId: 'dealCallStatusTableBody', metaId: 'dealCallStatusMeta',
    metaLabel: 'Deal assign', metaKey: 'dealAssignCount', cols: DEAL_CALL_STATUS_COLS, rows,
  });
  document.getElementById('dealCallStatusMeta').textContent += ' · WhatsApp-triggered deals excluded';
}

const WORK_STATUS_CLASS = { Closed: 'cell-won', WIP: null, Open: 'cell-muted' };

let lastDealStatusDump = null;
let dealStatusDumpSort = { key: null, dir: 'asc' };

function renderDealStatusDumpTable(dealStatusDump) {
  lastDealStatusDump = dealStatusDump;
  document.getElementById('dealStatusDumpSearch').value = '';
  dealStatusDumpSort = { key: null, dir: 'asc' };
  updateSortArrows();
  applyDealStatusDumpView();

  const metaEl = document.getElementById('dealStatusDumpMeta');
  metaEl.textContent = dealStatusDump.truncated
    ? `Showing most recent ${formatCount(dealStatusDump.dump.length)} of ${formatCount(dealStatusDump.total)} deals`
    : `${formatCount(dealStatusDump.total)} deals`;
}

function compareDealStatusDumpRows(a, b, key) {
  let va = a[key];
  let vb = b[key];
  if (key === 'called') { va = va ? 1 : 0; vb = vb ? 1 : 0; }
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  va = (va ?? '').toString().toLowerCase();
  vb = (vb ?? '').toString().toLowerCase();
  return va.localeCompare(vb);
}

function applyDealStatusDumpView() {
  if (!lastDealStatusDump) return;
  const term = document.getElementById('dealStatusDumpSearch').value.trim().toLowerCase();
  let rows = term
    ? lastDealStatusDump.dump.filter(d => [d.owner, d.mobile, d.stage, d.triggerEvent, d.workStatus, d.called ? 'Yes' : 'No']
        .some(v => v && String(v).toLowerCase().includes(term)))
    : lastDealStatusDump.dump.slice();

  if (dealStatusDumpSort.key) {
    const dir = dealStatusDumpSort.dir === 'asc' ? 1 : -1;
    rows = rows.slice().sort((a, b) => dir * compareDealStatusDumpRows(a, b, dealStatusDumpSort.key));
  }

  renderDealStatusDumpRows(rows);
}

function updateSortArrows() {
  document.querySelectorAll('#dealStatusDumpTable .sortable-th').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    arrow.textContent = th.dataset.sortKey === dealStatusDumpSort.key
      ? (dealStatusDumpSort.dir === 'asc' ? '▲' : '▼')
      : '';
  });
}

function renderDealStatusDumpRows(rows) {
  const tbody = document.getElementById('dealStatusDumpBody');
  tbody.innerHTML = '';

  if (!rows.length) {
    renderEmptyRow(tbody, 'No deals match', 8);
    return;
  }

  rows.forEach(d => {
    const tr = document.createElement('tr');
    tr.appendChild(cell(d.owner || '—'));
    tr.appendChild(cell(d.mobile || '—'));
    tr.appendChild(cell(d.stage || '—'));
    tr.appendChild(cell(d.triggerEvent || '—'));
    tr.appendChild(cell(d.workStatus, WORK_STATUS_CLASS[d.workStatus] || null));
    tr.appendChild(cell(d.called ? 'Yes' : 'No', d.called ? 'cell-won' : 'cell-lost'));
    tr.appendChild(cell(formatCount(d.callCount)));
    tr.appendChild(cell(formatCount(d.activityCount)));
    tbody.appendChild(tr);
  });
}

document.getElementById('dealStatusDumpSearch').addEventListener('input', applyDealStatusDumpView);

document.querySelectorAll('#dealStatusDumpTable .sortable-th').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sortKey;
    if (dealStatusDumpSort.key === key) {
      dealStatusDumpSort.dir = dealStatusDumpSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      dealStatusDumpSort = { key, dir: 'asc' };
    }
    updateSortArrows();
    applyDealStatusDumpView();
  });
});

function renderCallsTable(rows) {
  renderTable({
    theadId: 'callsTableHead', tbodyId: 'callsTableBody', metaId: 'callsMeta',
    metaLabel: 'Total calls', metaKey: 'totalCalls', cols: CALLS_COLS, rows,
  });
}

function renderClosedLostTable(rows) {
  renderTable({
    theadId: 'closedLostTableHead', tbodyId: 'closedLostTableBody', metaId: 'closedLostMeta',
    metaLabel: 'Total Closed Lost', metaKey: 'closedCount', cols: CLOSED_LOST_COLS, rows,
  });
  document.getElementById('closedLostMeta').textContent += ' · WhatsApp-triggered deals excluded';
}

function renderTasksTable(rows) {
  renderTable({
    theadId: 'tasksTableHead', tbodyId: 'tasksTableBody', metaId: 'tasksMeta',
    metaLabel: 'Total tasks', metaKey: 'totalTasks', cols: TASKS_COLS, rows,
  });
}

function renderDumpTable(dealsDump) {
  const tbody = document.getElementById('dumpBody');
  tbody.innerHTML = '';

  const metaEl = document.getElementById('dumpMeta');
  const metaText = dealsDump.truncated
    ? `Showing most recent ${formatCount(dealsDump.dump.length)} of ${formatCount(dealsDump.total)} deals`
    : `${formatCount(dealsDump.total)} deals`;
  metaEl.textContent = metaText;
  document.getElementById('dumpDetailMeta').textContent = `Total deals: ${formatCount(dealsDump.total)}`;

  if (!dealsDump.dump.length) {
    renderEmptyRow(tbody, 'No deals in this range', 18);
    return;
  }

  dealsDump.dump.forEach(d => {
    const tr = document.createElement('tr');
    tr.appendChild(cell(formatDateTime(d.createdTime)));
    tr.appendChild(cell(formatDateTime(d.modifiedTime)));
    tr.appendChild(cell(d.stage || '—'));
    tr.appendChild(cell(d.probability != null ? `${d.probability}%` : '—'));
    tr.appendChild(cell(d.qualified ? 'Yes' : 'No', d.qualified ? 'cell-won' : 'cell-muted'));
    tr.appendChild(cell(formatAmount(d.amount)));
    tr.appendChild(cell(d.mobile || '—'));
    tr.appendChild(cell(d.owner || '—'));
    tr.appendChild(cell(d.triggerEvent || '—'));
    tr.appendChild(cell(d.whatsApp ? 'Yes' : 'No', d.whatsApp ? 'cell-lost' : 'cell-muted'));
    const isSameDayCall = d.firstCallTime && d.createdTime.slice(0, 10) === d.firstCallTime.slice(0, 10);
    tr.appendChild(cell(isSameDayCall ? formatDateTime(d.firstCallTime) : '—', isSameDayCall ? null : 'cell-muted'));
    tr.appendChild(cell(d.callType || '—'));
    tr.appendChild(cell(d.callDurationSeconds != null ? formatCount(d.callDurationSeconds) : '—'));
    tr.appendChild(cell(d.callConnected == null ? '—' : (d.callConnected ? 'Yes' : 'No'), d.callConnected ? 'cell-won' : 'cell-muted'));
    tr.appendChild(cell(isSameDayCall ? d.callDiffFormatted : '—', isSameDayCall ? null : 'cell-muted'));
    tr.appendChild(cell(formatCount(d.callCount)));
    tr.appendChild(cell(d.taskCreatedTime ? formatDateTime(d.taskCreatedTime) : '—', d.taskCreatedTime ? null : 'cell-muted'));
    tr.appendChild(cell(formatCount(d.taskCount)));
    tbody.appendChild(tr);
  });
}

function renderFilterMeta(data) {
  const el = document.getElementById('filterMeta');
  const startLabel = formatDisplayDate(data.rangeStart.slice(0, 10));
  const endLabel = formatDisplayDate(data.rangeEnd.slice(0, 10));
  el.textContent =
    `${startLabel} – ${endLabel}\n` +
    `${formatCount(data.dealCount)} deals in range\n` +
    `${formatCount(data.callCount)} calls in range\n` +
    `${formatCount(data.taskCount)} tasks in range`;
  el.style.whiteSpace = 'pre-line';
}

async function loadReport(forceRefresh) {
  const refreshBtn = document.getElementById('refreshBtn');
  const applyBtn = document.getElementById('applyFilters');
  refreshBtn.disabled = true;
  applyBtn.disabled = true;
  applyBtn.textContent = 'Applying…';
  showStatus(null);
  try {
    const params = new URLSearchParams({
      dateField: state.dateField,
      range: state.range,
    });
    if (forceRefresh) params.set('refresh', 'true');
    if (state.range === 'custom' && state.customStart && state.customEnd) {
      params.set('start', state.customStart);
      params.set('end', state.customEnd);
    }
    if (state.agents.length) params.set('agent', state.agents.join(','));

    const res = await fetch(`/api/agent-performance?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);

    lastReportData = data;
    renderDealsTable(data.dealsRows);
    renderDealCallStatusTable(data.dealCallStatusRows);
    renderDealStatusDumpTable(data.dealStatusDump);
    renderCallsTable(data.callsRows);
    renderClosedLostTable(data.closedLostRows);
    renderTasksTable(data.tasksRows);
    renderDumpTable(data.dealsDump);
    renderFilterMeta(data);
    document.getElementById('updatedAt').textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString('en-IN');
    if (data.tasksUnavailable) {
      showStatus('Task counts unavailable — the Zoho refresh token is missing the Tasks module scope (ZohoCRM.modules.tasks.READ). All other columns are live.');
    }
  } catch (err) {
    showStatus(err.message || 'Failed to load report');
  } finally {
    refreshBtn.disabled = false;
    applyBtn.disabled = false;
    applyBtn.textContent = 'Apply';
  }
}

const customForm = document.getElementById('customRangeForm');
const customStartInput = document.getElementById('customStart');
const customEndInput = document.getElementById('customEnd');

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === state.dateField) return;
    document.querySelector('.tab-btn.is-active').classList.remove('is-active');
    document.querySelector('.tab-btn.is-active')?.setAttribute('aria-selected', 'false');
    btn.classList.add('is-active');
    btn.setAttribute('aria-selected', 'true');
    state.dateField = btn.dataset.tab;
  });
});

document.querySelectorAll('.option-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const range = btn.dataset.range;

    if (range === 'custom') {
      customForm.hidden = false;
      if (!customEndInput.value) {
        const today = new Date();
        const past = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        customEndInput.value = today.toISOString().slice(0, 10);
        customStartInput.value = past.toISOString().slice(0, 10);
      }
      document.querySelector('.option-btn.is-active')?.classList.remove('is-active');
      btn.classList.add('is-active');
      return;
    }

    customForm.hidden = true;
    if (range === state.range) return;
    document.querySelector('.option-btn.is-active')?.classList.remove('is-active');
    btn.classList.add('is-active');
    state.range = range;
  });
});

document.getElementById('refreshBtn').addEventListener('click', () => loadReport(true));

document.getElementById('applyFilters').addEventListener('click', () => {
  if (state.range === 'custom') {
    if (!customStartInput.value || !customEndInput.value) return;
    state.customStart = customStartInput.value;
    state.customEnd = customEndInput.value;
  }
  loadReport(false);
  document.getElementById('filtersPanel').hidden = true;
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

document.querySelectorAll('.export-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const table = document.getElementById(btn.dataset.exportTable);
    if (!table) return;
    const dateLabel = (state.range === 'custom' && state.customStart && state.customEnd)
      ? `${state.customStart}_to_${state.customEnd}`
      : state.range;
    downloadCSV(`${btn.dataset.exportFilename}_${dateLabel}`, tableToCSV(table));
  });
});

const filtersToggle = document.getElementById('filtersToggle');
const filtersPanel = document.getElementById('filtersPanel');

filtersToggle.addEventListener('click', () => {
  filtersPanel.hidden = !filtersPanel.hidden;
});

document.addEventListener('click', e => {
  if (!filtersPanel.hidden && !filtersToggle.contains(e.target) && !filtersPanel.contains(e.target)) {
    filtersPanel.hidden = true;
  }
});

loadMeta();
loadReport(false);
