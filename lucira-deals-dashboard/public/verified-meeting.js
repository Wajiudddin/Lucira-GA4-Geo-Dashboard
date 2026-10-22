function formatCount(n) {
  return new Intl.NumberFormat('en-IN').format(n || 0);
}

function formatAmount(n) {
  if (!n) return '₹0';
  return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
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

// Same threshold as the rest of the app's good/critical badges (ageing-red
// etc.) — half or better reads as on-track, below that as a problem.
function verificationBadgeHtml(pct) {
  const cls = pct >= 50 ? 'badge-good' : 'badge-critical';
  return `<span class="badge ${cls}">${pct.toFixed(1)}%</span>`;
}

const COLUMNS = [
  { label: 'Agent', key: 'agent' },
  { label: 'Meetings Raised', key: 'meetingsRaised' },
  { label: 'Verified', key: 'verified' },
  { label: 'No Visit', key: 'noVisit' },
  { label: 'Upcoming', key: 'upcoming' },
  { label: 'Verification %', key: 'verificationPct' },
  { label: 'Verified → Deal', key: 'verifiedToDeal' },
  { label: 'Revenue', key: 'revenue' },
];

let sort = { key: 'meetingsRaised', dir: 'desc' };

function compareRows(a, b, key) {
  const va = a[key];
  const vb = b[key];
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).toLowerCase().localeCompare(String(vb).toLowerCase());
}

function applySort(rows) {
  const dir = sort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => dir * compareRows(a, b, sort.key));
}

function buildRow(r) {
  const tr = document.createElement('tr');
  tr.appendChild(cell(r.agent));
  tr.appendChild(cell(formatCount(r.meetingsRaised)));
  tr.appendChild(cell(formatCount(r.verified)));
  tr.appendChild(cell(formatCount(r.noVisit)));
  tr.appendChild(cell(formatCount(r.upcoming)));
  tr.appendChild(cell(verificationBadgeHtml(r.verificationPct), null, true));
  tr.appendChild(cell(formatCount(r.verifiedToDeal)));
  tr.appendChild(cell(formatAmount(r.revenue)));
  return tr;
}

function buildGrandTotalRow(rows) {
  const totals = rows.reduce((acc, r) => ({
    meetingsRaised: acc.meetingsRaised + r.meetingsRaised,
    verified: acc.verified + r.verified,
    noVisit: acc.noVisit + r.noVisit,
    upcoming: acc.upcoming + r.upcoming,
    verifiedToDeal: acc.verifiedToDeal + r.verifiedToDeal,
    revenue: acc.revenue + r.revenue,
  }), { meetingsRaised: 0, verified: 0, noVisit: 0, upcoming: 0, verifiedToDeal: 0, revenue: 0 });
  const pct = totals.meetingsRaised > 0 ? Math.round((totals.verified / totals.meetingsRaised) * 1000) / 10 : 0;

  const tr = document.createElement('tr');
  tr.className = 'row-total';
  tr.appendChild(cell('GRAND TOTAL'));
  tr.appendChild(cell(formatCount(totals.meetingsRaised)));
  tr.appendChild(cell(formatCount(totals.verified)));
  tr.appendChild(cell(formatCount(totals.noVisit)));
  tr.appendChild(cell(formatCount(totals.upcoming)));
  tr.appendChild(cell(verificationBadgeHtml(pct), null, true));
  tr.appendChild(cell(formatCount(totals.verifiedToDeal)));
  tr.appendChild(cell(formatAmount(totals.revenue)));
  return tr;
}

function renderTable(rows) {
  const container = document.getElementById('verifiedMeetingTableContainer');
  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap table-wrap--spaced';
  const table = document.createElement('table');
  table.className = 'report-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.className = 'sortable-th';
    th.dataset.sortKey = col.key;
    th.textContent = col.label;

    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    if (sort.key === col.key) arrow.textContent = sort.dir === 'asc' ? '▲' : '▼';
    th.appendChild(arrow);

    th.addEventListener('click', () => {
      sort = sort.key === col.key ? { key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: col.key, dir: 'desc' };
      renderTable(rows);
    });

    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = COLUMNS.length;
    td.className = 'cell-muted';
    td.style.textAlign = 'center';
    td.textContent = 'No meetings on record';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    applySort(rows).forEach(r => tbody.appendChild(buildRow(r)));
    tbody.appendChild(buildGrandTotalRow(rows));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

async function loadData(forceRefresh) {
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.disabled = true;
  showStatus(null);
  try {
    const res = await fetch(`/api/verified-meeting${forceRefresh ? '?refresh=true' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);

    renderTable(data.rows);
    document.getElementById('updatedAt').textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString('en-IN');
  } catch (err) {
    showStatus(err.message || 'Failed to load verified meeting data');
  } finally {
    refreshBtn.disabled = false;
  }
}

document.getElementById('refreshBtn').addEventListener('click', () => loadData(true));

loadData(false);
