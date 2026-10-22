(function () {
  var params = new URLSearchParams(window.location.search);
  // Shown inside the dashboard's pop-up: drop the page chrome (the pop-up has its own title bar).
  if (params.get('embed')) document.documentElement.classList.add('so-embed');
  var storesParam = params.get('stores') || 'all';
  var periodParam = params.get('period') || 'yesterday';

  var els = {
    subtitle: document.getElementById('soSubtitle'),
    status: document.getElementById('soStatus'),
    kpis: document.getElementById('soKpis'),
    section: document.getElementById('soTableSection'),
    countNote: document.getElementById('soCountNote'),
    filter: document.getElementById('soFilter'),
    head: document.getElementById('soHead'),
    body: document.getElementById('soBody'),
    exportBtn: document.getElementById('soExport'),
    empty: document.getElementById('soEmpty'),
  };

  var inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  var num = new Intl.NumberFormat('en-IN');
  function money(n) { return n === null || n === undefined ? '—' : inr.format(n); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // A piece's own Sales / Purchase / Margin figure. If the piece is missing on one side
  // (no purchase invoice line yet, say) the figure that does exist is shown muted, because
  // it is not part of the bill total or of the dashboard's Margin (those need both sides).
  function pieceAmount(item, value) {
    if (value === null || value === undefined) return '—';
    return item.matched
      ? money(value)
      : '<span class="so-unmatched" title="Not counted in the bill total: this piece has no line in the other ERP table">' + money(value) + '</span>';
  }

  // scope 'bill': one cell spanning all the bill's piece rows.
  // scope 'piece': one cell per piece (piece) plus a bill-total row for multi-piece bills (total).
  // get() is the bill-level value used for sorting.
  var COLUMNS = [
    { key: 'billedAt', label: 'Billed', scope: 'bill', get: function (o) { return o.date + ' ' + (o.billedAt || ''); }, cell: function (o) { return esc(o.billedAt || o.date); } },
    { key: 'documentNo', label: 'Bill no', scope: 'bill', get: function (o) { return o.documentNo; }, cell: function (o) {
      return '<strong>' + esc(o.documentNo) + '</strong>' +
        (o.freeItems ? '<span class="sp-th-sub" title="Items with a net sale of ₹0 are not counted anywhere on the dashboard">' + o.freeItems + ' free item' + (o.freeItems === 1 ? '' : 's') + ' not counted</span>' : ''); } },
    { key: 'store', label: 'Store', scope: 'bill', get: function (o) { return o.store; }, cell: function (o) { return esc(o.store); } },
    { key: 'customerType', label: 'New / Repeat', scope: 'bill', get: function (o) { return o.customerType; }, cell: function (o) {
      return o.customerType ? '<span class="so-pill so-pill--' + esc(o.customerType.toLowerCase()) + '">' + esc(o.customerType) + '</span>' : '—'; } },
    { key: 'fulfilment', label: 'Status', scope: 'bill', get: function (o) { return o.fulfilment; }, cell: function (o) {
      return o.cancelled ? '<span class="so-pill so-pill--cancel" title="This bill is counted in Orders even though it is cancelled">' + esc(o.fulfilment) + '</span>' : esc(o.fulfilment || '—'); } },

    { key: 'lineNos', label: 'Item line no', scope: 'piece', get: function (o) { return o.items.map(function (i) { return i.lineNo; }).filter(Boolean).join(', '); },
      piece: function (o, i) {
        return esc(i.lineNo || '—') +
          (i.purchaseLine ? '<span class="sp-th-sub" title="This piece was bought under another item line number: the purchase cost is from line ' + esc(i.purchaseLine) + '">stock line ' + esc(i.purchaseLine) + '</span>' : '');
      }, total: function () { return ''; } },
    { key: 'items', label: 'Items', scope: 'piece', get: function (o) { return o.items.map(function (i) { return i.sku + ' ' + i.title; }).join('; '); },
      piece: function (o, i) {
        return '<div class="so-items">' + esc(i.title || i.sku) + (i.title && i.sku ? ' <span class="so-sku">' + esc(i.sku) + '</span>' : '') +
          (i.pieces > 1 ? ' &times;' + i.pieces : '') + '</div>';
      },
      total: function () { return 'Bill total'; } },
    { key: 'pieces', label: 'Pieces', scope: 'piece', numeric: true, get: function (o) { return o.pieces; },
      piece: function (o, i) { return num.format(i.pieces); }, total: function (o) { return num.format(o.pieces); } },
    { key: 'netSale', label: 'Net Sale', scope: 'piece', numeric: true, get: function (o) { return o.netSale; },
      piece: function (o, i) { return money(i.netSale) + (i.netSale === 0 ? '<span class="sp-th-sub">₹0 item</span>' : ''); },
      total: function (o) { return money(o.netSale); } },
    { key: 'salesAmount', label: 'Sales Amount', scope: 'piece', numeric: true, get: function (o) { return o.salesAmount; },
      piece: function (o, i) { return pieceAmount(i, i.salesAmount); }, total: function (o) { return money(o.salesAmount); } },
    { key: 'purchaseAmount', label: 'Purchase Amount', scope: 'piece', numeric: true, get: function (o) { return o.purchaseAmount; },
      piece: function (o, i) { return pieceAmount(i, i.purchaseAmount); }, total: function (o) { return money(o.purchaseAmount); } },
    { key: 'purchaseDoc', label: 'Purchase doc (GRN / APU)', scope: 'piece', get: function (o) { return o.items.map(function (i) { return i.purchaseDoc; }).filter(Boolean).join(', '); },
      piece: function (o, i) { return i.purchaseDoc ? '<span class="so-sku">' + esc(i.purchaseDoc) + '</span>' : '—'; }, total: function () { return ''; } },
    { key: 'margin', label: 'Margin', scope: 'piece', numeric: true, get: function (o) { return o.margin; },
      piece: function (o, i) { return pieceAmount(i, i.margin); }, total: function (o) { return money(o.margin); } },
  ];
  var BILL_COLS = COLUMNS.filter(function (c) { return c.scope === 'bill'; });
  var PIECE_COLS = COLUMNS.filter(function (c) { return c.scope === 'piece'; });

  var state = { data: null, sort: { key: 'billedAt', dir: -1 }, filter: '' };

  function visibleOrders() {
    var f = state.filter.trim().toLowerCase();
    var list = state.data.orders.filter(function (o) {
      if (!f) return true;
      var hay = [o.documentNo, o.store, o.customerType, o.fulfilment]
        .concat(o.items.map(function (i) { return i.lineNo + ' ' + (i.purchaseLine || '') + ' ' + i.sku + ' ' + i.title + ' ' + (i.purchaseDoc || ''); })).join(' ').toLowerCase();
      return hay.indexOf(f) !== -1;
    });
    var col = COLUMNS.filter(function (c) { return c.key === state.sort.key; })[0];
    var dir = state.sort.dir;
    return list.slice().sort(function (a, b) {
      var av = col.get(a), bv = col.get(b);
      var an = av === null || av === undefined || av === '', bn = bv === null || bv === undefined || bv === '';
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      if (col.numeric) return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  function renderKpis(t) {
    var cards = [
      ['Bills', num.format(t.orders)],
      ['Net Sale', money(t.netSale)],
      ['Pieces', num.format(t.pieces)],
      ['New / Repeat', num.format(t.newOrders) + ' / ' + num.format(t.repeatOrders)],
    ];
    if (t.cancelledOrders) cards.push(['Cancelled (still counted)', num.format(t.cancelledOrders)]);
    if (t.zeroValueOrders) cards.push(['₹0 bills (not counted)', num.format(t.zeroValueOrders)]);
    els.kpis.innerHTML = cards.map(function (c) {
      return '<div class="sp-kpi-card"><div class="sp-kpi-top"><span class="sp-kpi-title">' + esc(c[0]) + '</span></div>' +
        '<div class="sp-kpi-value">' + esc(c[1]) + '</div></div>';
    }).join('');
    els.kpis.hidden = false;
  }

  // One group of rows per bill: a row for each piece (with its own line number and amounts),
  // then a "Bill total" row when the bill has more than one piece. The bill-level cells span
  // the whole group.
  function billRowsHtml(o, billIndex) {
    var items = o.items.length ? o.items : [{ lineNo: '', sku: '', title: '', pieces: o.pieces, netSale: o.netSale, salesAmount: o.salesAmount, purchaseAmount: o.purchaseAmount, purchaseDoc: '', margin: o.margin, matched: true }];
    var multi = items.length > 1;
    var span = items.length + (multi ? 1 : 0);
    var base = (o.cancelled ? ' so-row-cancelled' : '') + (billIndex % 2 ? ' so-bill-alt' : '');
    var html = '';
    items.forEach(function (item, idx) {
      html += '<tr class="so-piece' + base + (idx === 0 ? ' so-bill-start' : '') + '">';
      if (idx === 0) {
        BILL_COLS.forEach(function (c) { html += '<td rowspan="' + span + '">' + c.cell(o) + '</td>'; });
      }
      PIECE_COLS.forEach(function (c) { html += '<td' + (c.numeric ? ' class="so-num"' : '') + '>' + c.piece(o, item) + '</td>'; });
      html += '</tr>';
    });
    if (multi) {
      html += '<tr class="so-total' + base + '">';
      PIECE_COLS.forEach(function (c) { html += '<td' + (c.numeric ? ' class="so-num"' : '') + '>' + c.total(o) + '</td>'; });
      html += '</tr>';
    }
    return html;
  }

  function renderTable() {
    var rows = visibleOrders();
    els.head.innerHTML = '<tr>' + COLUMNS.map(function (c) {
      var arrow = state.sort.key === c.key ? (state.sort.dir === -1 ? ' &#9660;' : ' &#9650;') : '';
      return '<th data-sort="' + c.key + '"' + (c.numeric ? ' class="so-num"' : '') + '>' + c.label + arrow + '</th>';
    }).join('') + '</tr>';
    els.body.innerHTML = rows.map(billRowsHtml).join('');
    els.countNote.textContent = rows.length === state.data.orders.length
      ? state.data.orders.length + ' bills · click a column heading to sort'
      : rows.length + ' of ' + state.data.orders.length + ' bills match your search';
    Array.prototype.forEach.call(els.head.querySelectorAll('th[data-sort]'), function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sort');
        if (state.sort.key === k) state.sort.dir *= -1; else state.sort = { key: k, dir: -1 };
        renderTable();
      });
    });
  }

  // CSV: one line per piece, with the bill's details repeated on each line.
  function exportCsv() {
    var rows = visibleOrders();
    var header = ['Billed', 'Bill no', 'Store', 'New / Repeat', 'Status', 'Item line no', 'Purchase item line no', 'Item', 'SKU', 'Pieces', 'Net Sale', 'Sales Amount', 'Purchase Amount', 'Purchase doc (GRN / APU)', 'Margin', 'Counted in bill total'];
    var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var lines = [header.map(q).join(',')];
    rows.forEach(function (o) {
      o.items.forEach(function (i) {
        lines.push([
          o.billedAt || o.date, o.documentNo, o.store, o.customerType, o.fulfilment,
          i.lineNo, i.purchaseLine || i.lineNo, i.title, i.sku, i.pieces, i.netSale, i.salesAmount, i.purchaseAmount, i.purchaseDoc || '', i.margin, i.matched ? 'Yes' : 'No',
        ].map(q).join(','));
      });
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'orders-' + state.data.period.key + '-' + (storesParam === 'all' ? 'all-stores' : storesParam.replace(/,/g, '-')) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function showError(msg) {
    els.subtitle.textContent = '';
    els.status.hidden = false;
    els.status.textContent = msg;
    els.status.style.color = 'var(--critical)';
  }

  els.filter.addEventListener('input', function () { state.filter = els.filter.value; renderTable(); });
  els.exportBtn.addEventListener('click', exportCsv);

  var rangeQs = (periodParam === 'custom' && params.get('from') && params.get('to'))
    ? '&from=' + encodeURIComponent(params.get('from')) + '&to=' + encodeURIComponent(params.get('to')) : '';
  fetch('/api/store-performance/orders?stores=' + encodeURIComponent(storesParam) + '&period=' + encodeURIComponent(periodParam) + rangeQs)
    .then(function (res) {
      if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || ('HTTP ' + res.status)); });
      return res.json();
    })
    .then(function (data) {
      state.data = data;
      var names = data.stores.map(function (s) { return s.displayName; });
      var who = storesParam === 'all' ? 'All Stores' : (names.length ? names.join(', ') : 'No store');
      els.subtitle.textContent = who + ' — ' + data.period.label + ' (' + data.period.displayRange + ')';
      document.title = 'Order Details — ' + who;
      if (!data.orders.length) { els.empty.hidden = false; return; }
      renderKpis(data.totals);
      els.section.hidden = false;
      renderTable();
    })
    .catch(function (err) { showError(err && err.message ? err.message : 'Unable to load order details.'); });
})();
