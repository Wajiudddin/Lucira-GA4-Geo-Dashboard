function formatCount(n) {
  return new Intl.NumberFormat('en-IN').format(n || 0);
}

function formatAmount(n) {
  if (!n) return '₹0';
  return '₹' + new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function formatPct(n) {
  return n == null ? '—' : `${n.toFixed(1)}%`;
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

// exportValue lets a cell show a compact display string (e.g. "₹2K") while
// CSV export still gets the plain number underneath, so exported totals/sums
// work in Excel instead of exporting the abbreviated text.
function cell(html, className, isHtml, exportValue) {
  const td = document.createElement('td');
  if (className) td.className = className;
  if (isHtml) td.innerHTML = html;
  else td.textContent = html;
  if (exportValue !== undefined) td.dataset.exportValue = exportValue == null ? '' : exportValue;
  return td;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function sumBy(rows, fn) {
  return round2(rows.reduce((s, r) => s + (fn(r) || 0), 0));
}

function groupBy(rows, keyFn) {
  const map = new Map();
  rows.forEach(r => {
    const key = keyFn(r);
    if (key == null) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  });
  return map;
}

// -----------------------------------------------------------------------
// Reusable checkbox multiselect (same pattern as old-gold.js / refill-management.js)
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
// State
// -----------------------------------------------------------------------
let allEnrollments = [];
let allInstallments = [];
let lastData = null;
const filters = { company: [], status: [], maturity: [], dateFrom: null, dateTo: null };
let enrollmentSort = { key: 'created', dir: 'desc' };

const STATUS_ORDER = ['Active', 'Cancelled', 'Matured', 'Redeemed'];
const STATUS_COLOR = { Active: 'var(--good)', Cancelled: 'var(--critical)', Matured: 'var(--series-4)', Redeemed: 'var(--series-3)' };

function applyFilters(rows) {
  return rows.filter(r => {
    if (filters.company.length && !filters.company.includes(r.companyName)) return false;
    if (filters.status.length && !filters.status.includes(r.status)) return false;
    if (filters.maturity.length && !filters.maturity.includes(r.maturityKey)) return false;
    if (filters.dateFrom && r.creationDate && r.creationDate < filters.dateFrom) return false;
    if (filters.dateTo && r.creationDate && r.creationDate > filters.dateTo) return false;
    return true;
  });
}

function renderKpis(enrollments, installments) {
  const committed = sumBy(enrollments, e => e.totalAmount);
  // total_amount = (monthly_amount x tenure) + scheme_bonus_value — the
  // customer only ever pays the principal; the bonus month is funded by the
  // scheme itself. Broken out here so "Total Committed" isn't read as
  // entirely customer-owed money.
  const committedPrincipal = sumBy(enrollments, e => e.monthlyAmount * (e.tenure || 0));
  const committedBonus = sumBy(enrollments, e => e.schemeBonusValue);
  const collected = sumBy(enrollments, e => e.paymentTillNow);
  const collectionRate = committed > 0 ? round2((collected / committed) * 100) : null;
  const activeRows = enrollments.filter(e => e.status === 'Active');

  const overdueInstallments = installments.filter(i => i.isOverdue);
  const overdueAmount = sumBy(overdueInstallments, i => i.monthAmount);

  const kpis = [
    { label: 'Total Enrollments', value: formatCount(enrollments.length) },
    { label: 'Active (In Progress)', value: formatCount(activeRows.length) },
    { label: 'Cancelled', value: formatCount(enrollments.filter(e => e.status === 'Cancelled').length) },
    { label: 'Matured', value: formatCount(enrollments.filter(e => e.status === 'Matured').length) },
    { label: 'Redeemed', value: formatCount(enrollments.filter(e => e.status === 'Redeemed').length) },
    { label: 'Total Committed', value: formatAmount(committed) },
    { label: 'Committed — Customer Principal', value: formatAmount(committedPrincipal) },
    { label: 'Committed — Scheme Bonus', value: formatAmount(committedBonus) },
    { label: 'Total Collected', value: formatAmount(collected) },
    { label: 'Collection Rate', value: formatPct(collectionRate) },
    { label: 'Overdue Installments', value: formatCount(overdueInstallments.length) },
    { label: 'Overdue Amount', value: formatAmount(overdueAmount) },
  ];
  const grid = document.getElementById('kpiGrid');
  grid.innerHTML = '';
  kpis.forEach(k => {
    const card = document.createElement('div');
    card.className = 'kpi-card';
    card.innerHTML = `<div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div>`;
    grid.appendChild(card);
  });
}

let currentMonthStoreFilter = [];
let currentMonthSearchTerm = '';
let currentMonthSort = { key: 'dueDate', dir: 'asc' };

const CURRENT_MONTH_COLUMNS = [
  { key: 'id', label: 'Enrollment ID', get: i => String(i.schemeEnrollmentId), sort: i => i.schemeEnrollmentId },
  { key: 'code', label: 'Enrollment Code', get: i => i.enrollmentCode || '—', sort: i => i.enrollmentCode || '' },
  { key: 'customer', label: 'Customer', get: i => i.customerName, sort: i => i.customerName || '' },
  { key: 'mobile', label: 'Mobile', get: i => i.customerMobile || '—', sort: i => i.customerMobile || '' },
  { key: 'company', label: 'Company', get: i => i.companyName, sort: i => i.companyName || '' },
  { key: 'salesPerson', label: 'Sales Person', get: i => i.salesPerson || '—', sort: i => i.salesPerson || '' },
  { key: 'dueDate', label: 'Due Date', get: i => formatDateOnly(i.dueDate), sort: i => i.dueDate || '', exportValue: i => i.dueDate || '' },
  { key: 'monthAmount', label: 'Amount', get: i => formatAmount(i.monthAmount), sort: i => i.monthAmount, exportValue: i => i.monthAmount },
  { key: 'paidOnDate', label: 'Paid Date', get: i => formatDateOnly(i.paidOnDate), sort: i => i.paidOnDate || '', exportValue: i => i.paidOnDate || '' },
  { key: 'overdueDays', label: 'Days Overdue', get: i => (i.overdueDays == null ? '—' : formatCount(i.overdueDays)), sort: i => (i.overdueDays == null ? -1 : i.overdueDays), exportValue: i => (i.overdueDays == null ? '' : i.overdueDays) },
  {
    key: 'status', label: 'Status',
    get: i => (i.paymentMade ? 'Paid' : (i.isOverdue ? 'Overdue' : 'Pending')),
    sort: i => (i.paymentMade ? 2 : (i.isOverdue ? 0 : 1)),
    className: i => (i.isOverdue ? 'ageing-red' : null),
  },
];

function applyCurrentMonthSort(rows) {
  const col = CURRENT_MONTH_COLUMNS.find(c => c.key === currentMonthSort.key);
  if (!col) return rows;
  const dir = currentMonthSort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = col.sort(a);
    const bv = col.sort(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

// Independent of the header Filters panel by design — this section is meant
// to answer "what's due this month, across all (or one) store" regardless of
// whatever company/status/date filters are set elsewhere on the page.
// Cancelled schemes are excluded — a dead scheme's installment isn't really
// "due".
function renderCurrentMonthDue(installments) {
  const currentMonth = lastData.asOfDate.slice(0, 7);
  const term = currentMonthSearchTerm.trim().toLowerCase();
  const monthRows = installments.filter(i => i.dueMonth === currentMonth && !i.isCancelledScheme);
  const storeFiltered = currentMonthStoreFilter.length
    ? monthRows.filter(i => currentMonthStoreFilter.includes(i.companyName))
    : monthRows;
  const rows = term
    ? storeFiltered.filter(i => `${i.customerName || ''} ${i.customerMobile || ''} ${i.companyName || ''} ${i.schemeEnrollmentId} ${i.enrollmentCode || ''}`.toLowerCase().includes(term))
    : storeFiltered;

  document.getElementById('currentMonthMeta').textContent = `${formatCount(rows.length)} installment${rows.length === 1 ? '' : 's'} due in ${currentMonth}`;

  const sorted = applyCurrentMonthSort(rows);

  const thead = document.getElementById('currentMonthTableHead');
  thead.innerHTML = '';
  const headRow = document.createElement('tr');
  CURRENT_MONTH_COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.className = 'sortable-th';
    th.dataset.sortKey = col.key;
    th.textContent = col.label;

    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    if (currentMonthSort.key === col.key) arrow.textContent = currentMonthSort.dir === 'asc' ? '▲' : '▼';
    th.appendChild(arrow);

    th.addEventListener('click', () => {
      if (currentMonthSort.key === col.key) {
        currentMonthSort.dir = currentMonthSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        currentMonthSort = { key: col.key, dir: 'asc' };
      }
      render();
    });

    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tbody = document.getElementById('currentMonthBody');
  tbody.innerHTML = '';
  if (!sorted.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = CURRENT_MONTH_COLUMNS.length;
    td.className = 'cell-muted';
    td.style.textAlign = 'center';
    td.textContent = 'No installments due this month for the current filters';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  sorted.forEach(i => {
    const tr = document.createElement('tr');
    CURRENT_MONTH_COLUMNS.forEach(col => tr.appendChild(cell(col.get(i), col.className && col.className(i), false, col.exportValue && col.exportValue(i))));
    tbody.appendChild(tr);
  });
}

let overdueSearchTerm = '';
let overdueSort = { key: 'overdueAmount', dir: 'desc' };

const OVERDUE_COLUMNS = [
  { key: 'id', label: 'Enrollment ID', get: e => String(e.schemeEnrollmentId), sort: e => e.schemeEnrollmentId },
  { key: 'code', label: 'Enrollment Code', get: e => e.enrollmentCode || '—', sort: e => e.enrollmentCode || '' },
  { key: 'customer', label: 'Customer', get: e => e.customerName, sort: e => e.customerName || '' },
  { key: 'mobile', label: 'Mobile', get: e => e.customerMobile || '—', sort: e => e.customerMobile || '' },
  { key: 'company', label: 'Company', get: e => e.companyName, sort: e => e.companyName || '' },
  { key: 'overdueCount', label: 'Overdue Installments', get: e => formatCount(e.overdueCount), sort: e => e.overdueCount, exportValue: e => e.overdueCount },
  { key: 'overdueAmount', label: 'Overdue Amount', get: e => formatAmount(e.overdueAmount), sort: e => e.overdueAmount, className: () => 'ageing-red', exportValue: e => e.overdueAmount },
  { key: 'oldestOverdueDueDate', label: 'Oldest Due Date', get: e => formatDateOnly(e.oldestOverdueDueDate), sort: e => e.oldestOverdueDueDate || '', exportValue: e => e.oldestOverdueDueDate || '' },
  { key: 'lastPaidDate', label: 'Last Paid Date', get: e => formatDateOnly(e.lastPaidDate), sort: e => e.lastPaidDate || '', exportValue: e => e.lastPaidDate || '' },
  { key: 'maxOverdueDays', label: 'Max Days Overdue', get: e => formatCount(e.maxOverdueDays), sort: e => e.maxOverdueDays, exportValue: e => e.maxOverdueDays },
  { key: 'status', label: 'Status', get: e => e.status, sort: e => e.status || '' },
];

function applyOverdueSort(rows) {
  const col = OVERDUE_COLUMNS.find(c => c.key === overdueSort.key);
  if (!col) return rows;
  const dir = overdueSort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = col.sort(a);
    const bv = col.sort(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function renderOverdueTable(enrollments) {
  const term = overdueSearchTerm.trim().toLowerCase();
  const matched = enrollments
    .filter(e => e.overdueAmount > 0)
    .filter(e => !term || `${e.customerName || ''} ${e.customerMobile || ''} ${e.companyName || ''} ${e.schemeEnrollmentId} ${e.enrollmentCode || ''}`.toLowerCase().includes(term));

  const totalOverdue = enrollments.filter(e => e.overdueAmount > 0).length;
  document.getElementById('overdueMeta').textContent = term
    ? `${matched.length} of ${totalOverdue} enrollment${totalOverdue === 1 ? '' : 's'} with overdue installments`
    : `${matched.length} enrollment${matched.length === 1 ? '' : 's'} with overdue installments`;

  const rows = applyOverdueSort(matched);

  const thead = document.getElementById('overdueTableHead');
  thead.innerHTML = '';
  const headRow = document.createElement('tr');
  OVERDUE_COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.className = 'sortable-th';
    th.dataset.sortKey = col.key;
    th.textContent = col.label;

    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    if (overdueSort.key === col.key) arrow.textContent = overdueSort.dir === 'asc' ? '▲' : '▼';
    th.appendChild(arrow);

    th.addEventListener('click', () => {
      if (overdueSort.key === col.key) {
        overdueSort.dir = overdueSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        overdueSort = { key: col.key, dir: 'asc' };
      }
      render();
    });

    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tbody = document.getElementById('overdueBody');
  tbody.innerHTML = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = OVERDUE_COLUMNS.length;
    td.className = 'cell-muted';
    td.style.textAlign = 'center';
    td.textContent = 'No overdue installments for the current filters';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  rows.forEach(e => {
    const tr = document.createElement('tr');
    OVERDUE_COLUMNS.forEach(col => tr.appendChild(cell(col.get(e), col.className && col.className(e), false, col.exportValue && col.exportValue(e))));
    tbody.appendChild(tr);
  });
}

function buildSummaryTable(container, { groupKey, columns, rows, emptyMessage }) {
  container.innerHTML = '';
  const groups = groupBy(rows, groupKey);
  const keys = [...groups.keys()].sort((a, b) => sumBy(groups.get(b), r => r.totalAmount) - sumBy(groups.get(a), r => r.totalAmount));

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap table-wrap--spaced';
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
  if (!keys.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length;
    td.className = 'cell-muted';
    td.style.textAlign = 'center';
    td.textContent = emptyMessage || 'No data for the current filters';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    keys.forEach(key => {
      const groupRows = groups.get(key);
      const tr = document.createElement('tr');
      columns.forEach(col => tr.appendChild(cell(col.get(key, groupRows), col.className && col.className(key, groupRows))));
      tbody.appendChild(tr);
    });

    const totalTr = document.createElement('tr');
    totalTr.className = 'row-total';
    columns.forEach(col => totalTr.appendChild(cell(col.get('Total', rows), col.className && col.className('Total', rows))));
    tbody.appendChild(totalTr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function renderCompanySummary(enrollments) {
  const committedOf = rows => sumBy(rows, e => e.totalAmount);
  const collectedOf = rows => sumBy(rows, e => e.paymentTillNow);
  const rateOf = rows => (committedOf(rows) > 0 ? round2((collectedOf(rows) / committedOf(rows)) * 100) : null);

  buildSummaryTable(document.getElementById('companySummaryContainer'), {
    groupKey: e => e.companyName,
    rows: enrollments,
    emptyMessage: 'No enrollments for the current filters',
    columns: [
      { label: 'Company', get: (name) => name },
      { label: 'Enrollments', get: (name, rows) => formatCount(rows.length) },
      { label: 'Active', get: (name, rows) => formatCount(rows.filter(r => r.status === 'Active').length) },
      { label: 'Cancelled', get: (name, rows) => formatCount(rows.filter(r => r.status === 'Cancelled').length) },
      { label: 'Committed', get: (name, rows) => formatAmount(committedOf(rows)) },
      { label: 'Collected', get: (name, rows) => formatAmount(collectedOf(rows)) },
      { label: 'Collection %', get: (name, rows) => formatPct(rateOf(rows)) },
      { label: 'Overdue Amount', get: (name, rows) => formatAmount(sumBy(rows, r => r.overdueAmount)), className: (name, rows) => (sumBy(rows, r => r.overdueAmount) > 0 ? 'ageing-red' : null) },
    ],
  });
}

const ENROLLMENT_COLUMNS = [
  { key: 'id', label: 'ID', get: r => String(r.schemeEnrollmentId), sort: r => r.schemeEnrollmentId },
  { key: 'code', label: 'Enrollment Code', get: r => r.enrollmentCode || '—', sort: r => r.enrollmentCode || '' },
  { key: 'customer', label: 'Customer', get: r => r.customerName, sort: r => r.customerName || '' },
  { key: 'mobile', label: 'Mobile', get: r => r.customerMobile || '—', sort: r => r.customerMobile || '' },
  { key: 'company', label: 'Company', get: r => r.companyName, sort: r => r.companyName || '' },
  { key: 'monthlyAmount', label: 'Monthly Amount', get: r => formatAmount(r.monthlyAmount), sort: r => r.monthlyAmount, exportValue: r => r.monthlyAmount },
  { key: 'totalAmount', label: 'Total Committed', get: r => formatAmount(r.totalAmount), sort: r => r.totalAmount, exportValue: r => r.totalAmount },
  { key: 'collected', label: 'Collected', get: r => formatAmount(r.paymentTillNow), sort: r => r.paymentTillNow, exportValue: r => r.paymentTillNow },
  { key: 'collectionRate', label: 'Collection %', get: r => formatPct(r.collectionRatePct), sort: r => (r.collectionRatePct == null ? -1 : r.collectionRatePct), exportValue: r => r.collectionRatePct },
  { key: 'bonus', label: 'Bonus', get: r => formatAmount(r.schemeBonusValue), sort: r => r.schemeBonusValue, exportValue: r => r.schemeBonusValue },
  { key: 'status', label: 'Status', get: r => r.status, sort: r => r.status, className: r => (r.status === 'Cancelled' ? 'ageing-red' : null) },
  { key: 'nextDue', label: 'Next Due', get: r => (r.nextDueDate ? `${formatDateOnly(r.nextDueDate)} (${formatAmount(r.nextDueAmount)})` : '—'), sort: r => r.nextDueDate || '' },
  { key: 'overdueAmount', label: 'Overdue Amount', get: r => formatAmount(r.overdueAmount), sort: r => r.overdueAmount, className: r => (r.overdueAmount > 0 ? 'ageing-red' : null), exportValue: r => r.overdueAmount },
  { key: 'overdueCount', label: 'Overdue Count', get: r => formatCount(r.overdueCount), sort: r => r.overdueCount, exportValue: r => r.overdueCount },
  { key: 'created', label: 'Enrolled On', get: r => formatDateOnly(r.creationDate), sort: r => r.creationDate || '' },
  { key: 'maturity', label: 'Maturity', get: r => r.maturityKey || '—', sort: r => r.maturityKey || '' },
];

function applySort(rows) {
  const col = ENROLLMENT_COLUMNS.find(c => c.key === enrollmentSort.key);
  if (!col) return rows;
  const dir = enrollmentSort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = col.sort(a);
    const bv = col.sort(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function renderEnrollmentTable(enrollments) {
  const container = document.getElementById('enrollmentTableContainer');
  container.innerHTML = '';

  document.getElementById('detailMeta').textContent = `${formatCount(enrollments.length)} enrollments`;

  const sorted = applySort(enrollments);

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap table-wrap--scroll-y table-wrap--spaced';
  const table = document.createElement('table');
  table.className = 'report-table';
  table.id = 'enrollmentTable';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ENROLLMENT_COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.className = 'sortable-th';
    th.dataset.sortKey = col.key;
    th.textContent = col.label;

    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    if (enrollmentSort.key === col.key) arrow.textContent = enrollmentSort.dir === 'asc' ? '▲' : '▼';
    th.appendChild(arrow);

    th.addEventListener('click', () => {
      if (enrollmentSort.key === col.key) {
        enrollmentSort.dir = enrollmentSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        enrollmentSort = { key: col.key, dir: 'asc' };
      }
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
    td.colSpan = ENROLLMENT_COLUMNS.length;
    td.className = 'cell-muted';
    td.style.textAlign = 'center';
    td.textContent = 'No enrollments for the current filters';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    sorted.forEach(r => {
      const tr = document.createElement('tr');
      ENROLLMENT_COLUMNS.forEach(col => tr.appendChild(cell(col.get(r), col.className && col.className(r), false, col.exportValue && col.exportValue(r))));
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'export-btn';
  exportBtn.dataset.exportTable = 'enrollmentTable';
  exportBtn.dataset.exportFilename = 'scheme-enrollment-detail';
  exportBtn.innerHTML = '&#8595; Export CSV';
  container.appendChild(exportBtn);
}

function render() {
  if (!lastData) return;
  const filteredEnrollments = applyFilters(allEnrollments);
  const idSet = new Set(filteredEnrollments.map(e => e.schemeEnrollmentId));
  const filteredInstallments = allInstallments.filter(i => idSet.has(i.schemeEnrollmentId));

  renderKpis(filteredEnrollments, filteredInstallments);
  renderCurrentMonthDue(allInstallments);
  renderOverdueTable(filteredEnrollments);
  renderCompanySummary(filteredEnrollments);
  renderEnrollmentTable(filteredEnrollments);
}

function setupFilterOptions() {
  const companies = [...new Set(allEnrollments.map(e => e.companyName))].sort();
  const maturities = [...new Set(allEnrollments.map(e => e.maturityKey).filter(Boolean))].sort();
  companyMs.setValues(companies);
  statusMs.setValues(STATUS_ORDER.filter(s => allEnrollments.some(e => e.status === s)));
  maturityMs.setValues(maturities);
  currentMonthStoreMs.setValues(companies);
}

const companyMs = setupMultiselect({ toggleId: 'companyToggle', panelId: 'companyPanel', allLabel: 'All companies', onChange: v => { filters.company = v; render(); } });
const statusMs = setupMultiselect({ toggleId: 'statusToggle', panelId: 'statusPanel', allLabel: 'All statuses', onChange: v => { filters.status = v; render(); } });
const maturityMs = setupMultiselect({ toggleId: 'maturityToggle', panelId: 'maturityPanel', allLabel: 'All maturities', onChange: v => { filters.maturity = v; render(); } });
const currentMonthStoreMs = setupMultiselect({ toggleId: 'currentMonthStoreToggle', panelId: 'currentMonthStorePanel', allLabel: 'All stores', onChange: v => { currentMonthStoreFilter = v; render(); } });

document.getElementById('overdueSearch').addEventListener('input', e => {
  overdueSearchTerm = e.target.value;
  render();
});

document.getElementById('currentMonthSearch').addEventListener('input', e => {
  currentMonthSearchTerm = e.target.value;
  render();
});

async function loadData(forceRefresh) {
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.disabled = true;
  showStatus(null);
  try {
    const res = await fetch(`/api/scheme-dashboard${forceRefresh ? '?refresh=true' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);

    lastData = data;
    allEnrollments = data.enrollments;
    allInstallments = data.installments;
    setupFilterOptions();
    render();

    document.getElementById('updatedAt').textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString('en-IN');
  } catch (err) {
    showStatus(err.message || 'Failed to load scheme dashboard data');
  } finally {
    refreshBtn.disabled = false;
  }
}

document.getElementById('refreshBtn').addEventListener('click', () => loadData(true));

function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

const DATE_QUICK_RANGES = {
  today: asOf => [asOf, asOf],
  yesterday: asOf => [shiftDate(asOf, -1), shiftDate(asOf, -1)],
  last7: asOf => [shiftDate(asOf, -6), asOf],
  last30: asOf => [shiftDate(asOf, -29), asOf],
  all: () => [null, null],
};

const dateQuickbarCustom = document.getElementById('dateQuickbarCustom');
document.querySelectorAll('#dateQuickbar .option-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#dateQuickbar .option-btn').forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');

    const range = btn.dataset.range;
    if (range === 'custom') {
      dateQuickbarCustom.hidden = false;
      return;
    }
    dateQuickbarCustom.hidden = true;
    const asOf = lastData ? lastData.asOfDate : new Date().toISOString().slice(0, 10);
    const [from, to] = DATE_QUICK_RANGES[range](asOf);
    filters.dateFrom = from;
    filters.dateTo = to;
    render();
  });
});

document.getElementById('quickDateApply').addEventListener('click', () => {
  filters.dateFrom = document.getElementById('quickDateFrom').value || null;
  filters.dateTo = document.getElementById('quickDateTo').value || null;
  render();
});

const filtersToggle = document.getElementById('filtersToggle');
const filtersPanel = document.getElementById('filtersPanel');
filtersToggle.addEventListener('click', () => { filtersPanel.hidden = !filtersPanel.hidden; });
document.addEventListener('click', e => {
  if (!filtersPanel.hidden && !filtersToggle.contains(e.target) && !filtersPanel.contains(e.target)) {
    filtersPanel.hidden = true;
  }
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
    const cells = Array.from(tr.children).map(td => csvEscape(
      td.dataset.exportValue !== undefined ? td.dataset.exportValue : td.textContent.trim()
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

loadData(false);
