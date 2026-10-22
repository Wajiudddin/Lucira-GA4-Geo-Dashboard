(function () {
  var els = {
    updatedAtText: document.getElementById('updatedAtText'),
    refreshBtn: document.getElementById('refreshBtn'),
    statusBar: document.getElementById('statusBar'),
    freshnessBanner: document.getElementById('freshnessBanner'),
    controlsWrap: document.getElementById('controlsWrap'),
    storeMultiSelect: document.getElementById('storeMultiSelect'),
    storeMultiSelectTrigger: document.getElementById('storeMultiSelectTrigger'),
    storeMultiSelectPanel: document.getElementById('storeMultiSelectPanel'),
    periodToggle: document.getElementById('periodToggle'),
    periodDates: document.getElementById('periodDates'),
    skeleton: document.getElementById('skeletonWrap'),
    content: document.getElementById('content'),
    mainNav: document.getElementById('mainNav'),
    dashboardTab: document.getElementById('dashboardTab'),
    logicTab: document.getElementById('logicTab'),
  };

  var PERIOD_KEYS = ['yesterday', 'lastWeek', 'lastMonth'];

  // Headline KPI cards — a curated subset of the 25 metrics (all 25 remain
  // in the Full Metric Comparison table below). Order matches the two rows
  // in the design brief: acquisition first, then CRM/ops.
  var KPI_METRIC_KEYS = [
    'citySessions', 'paidSessions', 'retargetingSessions', 'communicationSessions',
    'meetingsRaised', 'walkins', 'orders', 'callsDialed',
  ];

  var COMPARISON_METRIC_OPTIONS = [
    { key: 'citySessions', label: 'Sessions' },
    { key: 'walkins', label: 'Walk-ins' },
    { key: 'orders', label: 'Orders' },
    { key: 'meetingsRaised', label: 'Meetings' },
    { key: 'callsDialed', label: 'Calls' },
    { key: 'inventory', label: 'Inventory' },
    { key: 'spend', label: 'Spend' },
  ];

  var CALL_BREAKDOWN_METRICS = [
    { key: 'callsDialed', label: 'Dialed' },
    { key: 'callsConnected', label: 'Connected' },
    { key: 'callsConnected30s', label: 'Connected 30s+' },
  ];

  // Minimal inline line icons (24x24, currentColor) — kept deliberately
  // small/monochrome per the "subtle, not colorful" design brief.
  var ICONS = {
    activity: '<path d="M3 12h4l2 7 4-14 2 7h6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    megaphone: '<path d="M3 11v2a2 2 0 002 2h1l3 5V4L6 9H5a2 2 0 00-2 2z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M11 6.5l6-3v17l-6-3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/>',
    repeat: '<path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    message: '<path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M16 3v4M8 3v4M3 10h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    users: '<path d="M17 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="7" r="4" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    bag: '<path d="M6 8h12l1 13H5L6 8z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M9 8V6a3 3 0 016 0v2" stroke="currentColor" stroke-width="1.8" fill="none"/>',
    phone: '<path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.3 1.8.6 2.7a2 2 0 01-.5 2.1L8 9.7a16 16 0 006 6l1.2-1.2a2 2 0 012.1-.5c.9.3 1.8.5 2.7.6a2 2 0 011.7 2.1z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/>',
  };
  var KPI_ICON_BY_METRIC = {
    citySessions: 'activity', paidSessions: 'megaphone', retargetingSessions: 'repeat',
    communicationSessions: 'message', meetingsRaised: 'calendar', walkins: 'users',
    orders: 'bag', callsDialed: 'phone',
  };
  function iconSvg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  var state = {
    data: null,
    // null means "every store" (equivalent to the old 'all' sentinel) —
    // becomes a real array of store keys as soon as the user picks a subset
    // via the checkbox dropdown. Never allowed to become an empty array (see
    // toggleStoreSelection) so currentStoreEntry() never has to guess.
    selectedStores: null,
    storeMultiSelectOpen: false,
    activePeriod: 'yesterday',
    comparisonMetric: 'citySessions',
    loading: false,
    sort: { col: null, dir: -1 },          // Store Comparison table
    vsort: { col: 'section', dir: 1 },     // Dashboard tab's metric-by-period table
    view: 'dashboard',                     // 'dashboard' | 'compare'
    customRange: null,                     // { from, to } once a custom range has been applied
    customOpen: false,                     // whether the From/To panel is showing
    totalsData: null,                      // Store Comparison tab's own data: adds Today, real totals (no averages)
    totalsLoading: false,
    totalsFailed: false,
    forceTotals: false,
    // Each tab keeps its own filters (period, custom range, store selection). The active tab's
    // live values sit in state.activePeriod / customRange / customOpen / selectedStores above;
    // the other tab's are parked here and swapped in when you switch tabs.
    viewState: {
      dashboard: { activePeriod: 'yesterday', customRange: null, customOpen: false, selectedStores: null, totalsData: null, totalsFailed: false },
      compare: { activePeriod: 'yesterday', customRange: null, customOpen: false, selectedStores: null, totalsData: null, totalsFailed: false },
      city: { activePeriod: 'yesterday', customRange: null, customOpen: false, selectedStores: null, totalsData: null, totalsFailed: false },
    },
  };
  // The custom range that belongs to a tab, whether or not it is the active one.
  function viewRange(view) { return state.view === view ? state.customRange : state.viewState[view].customRange; }

  // --- Formatting -----------------------------------------------------
  var inrFormatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  var intFormatter = new Intl.NumberFormat('en-IN');
  var compactFormatter = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });

  function fmtInt(n) {
    if (n === null || n === undefined) return '—';
    return intFormatter.format(Math.round(n));
  }
  function fmtCompact(n) {
    if (n === null || n === undefined) return '—';
    return compactFormatter.format(n);
  }
  function fmtCurrency(n) {
    if (n === null || n === undefined) return '—';
    return inrFormatter.format(n);
  }
  function fmtRating(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toFixed(1);
  }
  function fmtDuration(totalSeconds) {
    if (totalSeconds === null || totalSeconds === undefined) return '—';
    var s = Math.round(totalSeconds);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
    if (m > 0) return m + 'm ' + sec + 's';
    return sec + 's';
  }
  // Whole numbers stay whole; fractions show one decimal (small per-day averages).
  function fmtSmart(n) {
    if (n === null || n === undefined) return '—';
    return Number.isInteger(n) ? intFormatter.format(n) : Number(n).toFixed(1);
  }
  var inr1Formatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 1, minimumFractionDigits: 1 });
  function fmtCurrency1(n) {
    if (n === null || n === undefined) return '—';
    return inr1Formatter.format(n);
  }
  function fmtPercent(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toFixed(1) + '%';
  }
  function fmtDecimal(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toFixed(2);
  }
  function fmtByFormat(fmt, n) {
    if (fmt === 'decimal') return fmtDecimal(n);
    if (fmt === 'smart') return fmtSmart(n);
    if (fmt === 'percent') return fmtPercent(n);
    if (fmt === 'currency1') return fmtCurrency1(n);
    if (fmt === 'currency') return fmtCurrency(n);
    if (fmt === 'duration') return fmtDuration(n);
    if (fmt === 'rating') return fmtRating(n);
    return fmtInt(n);
  }
  function pctChange(current, base) {
    if (current === null || current === undefined || base === null || base === undefined) return null;
    if (!base) return null; // avoid divide-by-zero -> Infinity/NaN
    return ((current - base) / base) * 100;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // --- Data access ------------------------------------------------------
  // state.selectedStores === null means "untouched, defaults to every
  // store" (the initial state). Once the user interacts with the checkbox
  // panel it becomes a real array — which CAN be empty (every store
  // unchecked), distinct from null, so that case renders "no store selected"
  // instead of silently falling back to All Stores.
  function selectedStoreKeys() {
    var d = state.data;
    if (!d) return [];
    if (state.selectedStores === null) return d.stores.map(function (s) { return s.key; });
    return state.selectedStores;
  }

  function currentStoreEntry() {
    var d = state.data;
    if (!d) return null;
    var keys = selectedStoreKeys();
    if (keys.length === 0) return null;
    if (keys.length === d.stores.length) return d.allStores;
    if (keys.length === 1) return d.stores.find(function (s) { return s.key === keys[0]; }) || d.allStores;
    return buildAggregateStore(keys);
  }

  // Combines an arbitrary subset (2+, but not all) of selected stores into
  // one virtual "store" with the same {displayName, metrics, ...} shape
  // every renderer already consumes via currentStoreEntry() — so nothing
  // downstream needs to know this isn't a real store from the API.
  //
  // Most metrics are a straight sum across the selected stores. GA4 metrics
  // (City/Paid/Retargeting/Communication Sessions) are the one exception:
  // stores that share a ga4CityGroup (Borivali/Chembur; Paschim Vihar/Lajpat
  // Nagar) report the exact same city-wide number on each of them, so naively
  // summing would double-count that city — each unique ga4CityGroup among the
  // selection is counted once instead, mirroring how the backend's "All
  // Stores" aggregate already avoids this.
  var GA4_METRIC_KEYS = ['citySessions', 'paidSessions', 'retargetingSessions', 'communicationSessions'];
  function sumMetric(selected, key, dedupeByGa4Group) {
    var sums = {};
    PERIOD_KEYS.forEach(function (p) { sums[p] = 0; });
    var seenGroups = {};
    var any = false;
    selected.forEach(function (s) {
      if (dedupeByGa4Group) {
        if (seenGroups[s.ga4CityGroup]) return;
        seenGroups[s.ga4CityGroup] = true;
      }
      var m = s.metrics[key];
      if (!m || m.unavailable) return;
      any = true;
      PERIOD_KEYS.forEach(function (p) { sums[p] += (m[p] || 0); });
    });
    if (!any) return { yesterday: null, lastWeek: null, lastMonth: null, unavailable: true };
    return sums;
  }
  function ratioMetricClient(numMetric, denomMetric) {
    if ((numMetric && numMetric.unavailable) || (denomMetric && denomMetric.unavailable)) {
      return { yesterday: null, lastWeek: null, lastMonth: null, unavailable: true };
    }
    var out = {};
    PERIOD_KEYS.forEach(function (p) {
      var num = numMetric ? numMetric[p] : null;
      var den = denomMetric ? denomMetric[p] : null;
      out[p] = (num == null || den == null || !den) ? null : Math.round((num / den) * 100) / 100;
    });
    return out;
  }
  function buildAggregateStore(keys) {
    var d = state.data;
    var selected = d.stores.filter(function (s) { return keys.indexOf(s.key) !== -1; });
    var metrics = {};
    d.metricDefs.forEach(function (def) {
      if (def.pending) { metrics[def.key] = { yesterday: null, lastWeek: null, lastMonth: null, pending: true }; return; }
      if (def.key === 'costPerSession' || def.key === 'costPerDeal' || def.key === 'costPerAppointment' ||
          def.key === 'newAtv' || def.key === 'repeatAtv' || def.key === 'scansPerVisitor' || def.key === 'marginPerSqft' || def.key === 'onlineInfluencedPct' || def.key === 'revenuePerStaff') return; // after the loop
      // Per-store GA4 figures are now an even split of the city total, so a
      // plain sum across the selection is correct (no group de-duplication).
      metrics[def.key] = sumMetric(selected, def.key, false);
    });
    metrics.costPerSession = ratioMetricClient(metrics.spend, metrics.citySessions);
    metrics.costPerDeal = ratioMetricClient(metrics.spend, metrics.deals);
    metrics.costPerAppointment = ratioMetricClient(metrics.spend, metrics.meetingsRaised);
    // Per-day averages share one day-count, so revenue/orders of the averages
    // equals revenue/orders of the totals — safe to divide the summed figures.
    metrics.newAtv = ratioMetricClient(metrics.newRevenue, metrics.newOrders);
    metrics.repeatAtv = ratioMetricClient(metrics.repeatRevenue, metrics.repeatOrders);
    metrics.scansPerVisitor = ratioMetricClient(metrics.scans, metrics.walkins);
    // Revenue per staff for a selection: the selected stores' revenue over THEIR headcount
    // (a store with no revenue data is left out of both sides, as on the All Stores row).
    var staffStores = selected.filter(function (s) { var m = s.metrics.revenue; return m && !m.unavailable && s.staff; });
    var staffTotal = staffStores.reduce(function (a, s) { return a + s.staff; }, 0);
    if (!staffTotal) {
      metrics.revenuePerStaff = { yesterday: null, lastWeek: null, lastMonth: null, unavailable: true };
    } else {
      metrics.revenuePerStaff = {};
      PERIOD_KEYS.forEach(function (p) {
        var tot = staffStores.reduce(function (a, s) { return a + (s.metrics.revenue[p] || 0); }, 0);
        metrics.revenuePerStaff[p] = Math.round((tot / staffTotal) * 100) / 100;
      });
    }
    // Share of orders that were online influenced, for the selected stores (a ratio of the
    // summed figures, same basis as the other counts).
    metrics.onlineInfluencedPct = (function () {
      var n = metrics.onlineInfluenced, o = metrics.orders;
      if ((n && n.unavailable) || (o && o.unavailable)) return { yesterday: null, lastWeek: null, lastMonth: null, unavailable: true };
      var out = {};
      PERIOD_KEYS.forEach(function (p) {
        var a = n ? n[p] : null, b = o ? o[p] : null;
        out[p] = (a == null || b == null || !b) ? null : Math.round((a / b) * 1000) / 10;
      });
      return out;
    })();
    // Margin per sq ft for a selection: the selected stores' margin over THEIR floor area
    // (a store with no margin data is left out of both sides, as on the All Stores row).
    var areaStores = selected.filter(function (s) { var m = s.metrics.margin; return m && !m.unavailable && s.areaSqFt; });
    var area = areaStores.reduce(function (a, s) { return a + s.areaSqFt; }, 0);
    if (!area) {
      metrics.marginPerSqft = { yesterday: null, lastWeek: null, lastMonth: null, unavailable: true };
    } else {
      metrics.marginPerSqft = {};
      PERIOD_KEYS.forEach(function (p) {
        var tot = areaStores.reduce(function (a, s) { return a + (s.metrics.margin[p] || 0); }, 0);
        metrics.marginPerSqft[p] = Math.round((tot / area) * 100) / 100;
      });
    }
    return {
      key: '__selection__',
      displayName: selected.length + ' Stores Selected',
      shortCode: null,
      accent: '#8a7a52',
      citySharedLabel: null,
      metrics: metrics,
    };
  }

  function metricDef(key) {
    return state.data.metricDefs.find(function (m) { return m.key === key; });
  }

  function exportFilenameForSelection() {
    var d = state.data;
    var keys = selectedStoreKeys();
    if (keys.length === 0) return 'no-stores';
    if (keys.length === d.stores.length) return 'all-stores';
    if (keys.length === 1) return keys[0];
    return keys.join('-');
  }

  function setStatus(msg, isError) {
    if (!msg) { els.statusBar.hidden = true; els.statusBar.textContent = ''; return; }
    els.statusBar.hidden = false;
    els.statusBar.textContent = msg;
    els.statusBar.style.color = isError ? 'var(--critical)' : 'var(--text-secondary)';
  }

  // --- Rendering: controls ------------------------------------------------
  function renderControls() {
    var d = state.data;
    if (!d) return;
    els.controlsWrap.hidden = false;

    renderStoreMultiSelect();

    // The Store Comparison tab also has Today, and reads its periods from its own (totals) data.
    var cmp = state.view === 'compare';
    var useTotals = state.view !== 'dashboard';
    var p = (useTotals && state.totalsData) ? state.totalsData.periods : d.periods;
    // The City Wise tab covers every store, so it has no store filter.
    if (els.storeMultiSelect && els.storeMultiSelect.closest) {
      var storeCtl = els.storeMultiSelect.closest('.sp-control');
      if (storeCtl) storeCtl.style.display = state.view === 'city' ? 'none' : '';
    }
    // Yesterday / Last Week / Last Month, plus a Custom button that is always there.
    els.periodToggle.innerHTML = (cmp ? ['today', 'yesterday', 'lastWeek', 'lastMonth', 'custom'] : ['yesterday', 'lastWeek', 'lastMonth', 'custom']).map(function (k) {
      var active = state.activePeriod === k;
      var label = k === 'custom' ? 'Custom' : (p[k] ? p[k].label : (k === 'today' ? 'Today' : k));
      return '<button type="button" class="sp-segmented-btn' + (active ? ' is-active' : '') +
        '" data-period="' + k + '" role="tab" aria-selected="' + active + '">' + label + '</button>';
    }).join('');
    Array.prototype.forEach.call(els.periodToggle.querySelectorAll('[data-period]'), function (btn) {
      btn.addEventListener('click', function () {
        var k = btn.getAttribute('data-period');
        if (k === 'custom') {
          // Opens the From/To panel; the Custom view itself shows once a range has been applied.
          state.customOpen = !state.customOpen || !state.customRange;
          if (state.customRange) state.activePeriod = 'custom';
        } else {
          state.activePeriod = k;
          state.customOpen = false;
        }
        renderControls();
        renderContent();
      });
    });
    renderCustomPanel();

    els.periodDates.innerHTML = PERIOD_KEYS.filter(function (k) { return p[k]; }).map(function (k) {
      return '<div class="sp-period-chip"><span class="sp-period-chip-label">' + p[k].label + '</span>' +
        '<span class="sp-period-chip-range">' + p[k].displayRange + '</span></div>';
    }).join('');
  }

  // --- Custom date range ---------------------------------------------------
  function addDaysKey(key, delta) {
    var parts = key.split('-').map(Number);
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]) + delta * 86400000).toISOString().slice(0, 10);
  }
  // The Store Comparison and City Wise tabs reach back to the start of the data (up to 400 days).
  var DATA_START = '2025-09-13';
  function rangeLimits() { return state.view === 'dashboard' ? { back: 120, span: 92 } : { back: null, span: 3650 }; }
  function renderCustomPanel() {
    var box = document.getElementById('customRange');
    if (!box) return;
    box.hidden = !state.customOpen;
    if (!state.customOpen || !state.data) return;
    var yesterday = state.data.periods.yesterday.start;       // latest selectable day
    var earliest = rangeLimits().back == null ? DATA_START : addDaysKey(state.data.today || yesterday, -rangeLimits().back);
    var cur = state.customRange || { from: addDaysKey(yesterday, -6), to: yesterday, basis: 'total' };
    var basis = cur.basis === 'avg' ? 'avg' : 'total';
    box.innerHTML =
      '<label class="sp-control-label">Custom range</label>' +
      '<div class="sp-custom-inputs">' +
        '<input type="date" id="customFrom" min="' + earliest + '" max="' + yesterday + '" value="' + cur.from + '" aria-label="From date" />' +
        '<span class="sp-custom-to">to</span>' +
        '<input type="date" id="customTo" min="' + earliest + '" max="' + yesterday + '" value="' + cur.to + '" aria-label="To date" />' +
        (state.view !== 'dashboard' ? '' : '<select id="customBasis" aria-label="Show totals or per-day averages">' +
          '<option value="total"' + (basis === 'total' ? ' selected' : '') + '>Totals for the range</option>' +
          '<option value="avg"' + (basis === 'avg' ? ' selected' : '') + '>Per-day average</option>' +
        '</select>') +
        '<button type="button" class="sp-custom-btn sp-custom-btn--apply" id="customApply">Apply</button>' +
        (state.customRange ? '<button type="button" class="sp-custom-btn" id="customClear">Clear</button>' : '') +
      '</div>' +
      '<div class="sp-custom-hint" id="customHint">' + (state.view === 'dashboard'
        ? 'Up to 92 days, ending yesterday. Totals add up every day in the range; per-day average matches how Last Week and Last Month are shown.'
        : 'Any range from 13 Sep 2025 (the start of the data) to yesterday. Shows totals for the whole range.') + '</div>';
    document.getElementById('customApply').addEventListener('click', applyCustomRange);
    var clr = document.getElementById('customClear');
    if (clr) clr.addEventListener('click', clearCustomRange);
  }
  function showCustomError(msg) {
    var hint = document.getElementById('customHint');
    if (!hint) return;
    hint.textContent = msg;
    hint.classList.add('is-error');
  }
  function applyCustomRange() {
    var from = document.getElementById('customFrom').value;
    var to = document.getElementById('customTo').value;
    var basisEl = document.getElementById('customBasis');
    var basis = basisEl && basisEl.value === 'avg' ? 'avg' : 'total';
    if (!from || !to) return showCustomError('Pick both a From and a To date.');
    if (from > to) return showCustomError('The From date must be on or before the To date.');
    var span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    if (span > rangeLimits().span) return showCustomError('A custom range can be at most ' + rangeLimits().span + ' days long.');
    if (state.view !== 'dashboard') {
      // This tab loads its own data; the other tabs' ranges and data are untouched.
      state.customRange = { from: from, to: to, basis: 'total' };
      state.activePeriod = 'custom';
      state.customOpen = false;
      state.totalsData = null; state.totalsFailed = false;
      setStatus(null);
      renderControls();
      renderContent();
      return;
    }
    var btn = document.getElementById('customApply');
    btn.disabled = true; btn.textContent = 'Loading…';
    setStatus('Loading ' + from + ' to ' + to + '…');
    fetch('/api/store-performance?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to) + '&basis=' + basis)
      .then(function (res) {
        if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || ('HTTP ' + res.status)); });
        return res.json();
      })
      .then(function (data) {
        state.customRange = { from: from, to: to, basis: basis };
        state.data = data;
        state.totalsData = null; state.totalsFailed = false;
        syncPeriodKeys(data);
        state.activePeriod = 'custom';
        state.customOpen = false;
        setStatus(null);
        renderFreshnessBanner();
        renderControls();
        renderContent();
        els.updatedAtText.textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      })
      .catch(function (err) {
        setStatus(null);
        var b = document.getElementById('customApply');
        if (b) { b.disabled = false; b.textContent = 'Apply'; }
        showCustomError(err && err.message ? err.message : 'Could not load that range. Try again.');
      });
  }
  function clearCustomRange() {
    state.customRange = null;
    state.customOpen = false;
    if (state.activePeriod === 'custom') state.activePeriod = 'yesterday';
    if (state.view !== 'dashboard') {
      state.totalsData = null; state.totalsFailed = false;
      renderControls();
      renderContent();
      return;
    }
    load(false);
  }
  // PERIOD_KEYS follows whichever periods the loaded data actually has.
  function syncPeriodKeys(data) {
    PERIOD_KEYS.length = 0;
    ['today', 'yesterday', 'lastWeek', 'lastMonth', 'custom'].forEach(function (k) {
      if (data && data.periods && data.periods[k]) PERIOD_KEYS.push(k);
    });
  }

  function storeMultiSelectTriggerLabel() {
    var d = state.data;
    var keys = selectedStoreKeys();
    if (keys.length === 0) return 'No Stores Selected';
    if (keys.length === d.stores.length) return 'All Stores';
    if (keys.length === 1) {
      var only = d.stores.find(function (s) { return s.key === keys[0]; });
      return only ? only.displayName : 'All Stores';
    }
    return keys.length + ' Stores Selected';
  }

  // The selection can go all the way to empty (every store unchecked) —
  // currentStoreEntry() returns null in that case and renderContent() shows
  // the existing "no data available" empty state, same as any other
  // no-store situation.
  function toggleStoreSelection(key) {
    var current = selectedStoreKeys().slice();
    var i = current.indexOf(key);
    if (i === -1) current.push(key);
    else current.splice(i, 1);
    state.selectedStores = current;
    renderControls();
    renderContent();
  }
  // "All Stores" is a toggle: selects everything unless everything is
  // already selected, in which case it deselects everything in one click.
  function toggleAllStores() {
    var d = state.data;
    var keys = selectedStoreKeys();
    state.selectedStores = (keys.length === d.stores.length) ? [] : null;
    renderControls();
    renderContent();
  }

  function renderStoreMultiSelect() {
    var d = state.data;
    var keys = selectedStoreKeys();
    var allSelected = keys.length === d.stores.length;

    els.storeMultiSelectTrigger.textContent = storeMultiSelectTriggerLabel();
    els.storeMultiSelectTrigger.setAttribute('aria-expanded', String(state.storeMultiSelectOpen));
    els.storeMultiSelectPanel.hidden = !state.storeMultiSelectOpen;

    els.storeMultiSelectPanel.innerHTML = (
      '<label class="sp-multiselect-option sp-multiselect-option--all">' +
        '<input type="checkbox" id="storeOptAll"' + (allSelected ? ' checked' : '') + '>All Stores</label>' +
      d.stores.map(function (s) {
        var checked = keys.indexOf(s.key) !== -1;
        return '<label class="sp-multiselect-option"><input type="checkbox" data-store-key="' + s.key + '"' +
          (checked ? ' checked' : '') + '>' + escapeHtml(s.displayName) + '</label>';
      }).join('')
    );

    document.getElementById('storeOptAll').addEventListener('change', toggleAllStores);
    Array.prototype.forEach.call(els.storeMultiSelectPanel.querySelectorAll('[data-store-key]'), function (cb) {
      cb.addEventListener('change', function () { toggleStoreSelection(cb.getAttribute('data-store-key')); });
    });
  }

  function renderFreshnessBanner() {
    var d = state.data;
    if (!d) { els.freshnessBanner.hidden = true; return; }
    var parts = [];
    if (d.dataFreshness.ga4.inflated && d.dataFreshness.ga4.inflationNote) {
      parts.push('<span class="fb-stale"><strong>Traffic metrics:</strong> ' + d.dataFreshness.ga4.inflationNote + '</span>');
    }
    if (d.dataFreshness.ga4.stale && d.dataFreshness.ga4.note) {
      parts.push('<span class="fb-stale">' + d.dataFreshness.ga4.note + '</span>');
    }
    if (d.dataFreshness.meetings.unmappedCount) {
      parts.push('<span>' + d.dataFreshness.meetings.unmappedCount + ' meeting(s) in this window have a blank Venue — counted in All Stores only, not in any single store\'s Meetings Raised.</span>');
    }
    if (d.dataFreshness.failedSources && d.dataFreshness.failedSources.length) {
      parts.push('<span class="fb-stale">Data unavailable right now for: ' + d.dataFreshness.failedSources.join(', ') + '. The rest of the dashboard is unaffected — try Refresh shortly.</span>');
    }
    if (!parts.length) { els.freshnessBanner.hidden = true; return; }
    els.freshnessBanner.hidden = false;
    els.freshnessBanner.innerHTML = parts.join('');
  }

  // GA4 uses its own "Yesterday" (today-2, one day earlier than every other
  // metric's today-1 — see dateWindows.js/storePerformanceService.js). This
  // surfaces which date a GA4 period actually reflects, whenever it differs
  // from the header's date.
  function ga4DateNote(periodKey) {
    var d = state.data;
    if (periodKey !== 'yesterday' || !d.ga4Periods) return '';
    if (d.ga4Periods.yesterday.start === d.periods.yesterday.start) return '';
    return 'As of ' + d.ga4Periods.yesterday.displayRange;
  }
  // GA4's source (the linked BigQuery export) is a table-per-day; this
  // surfaces whether a given period's day-tables are actually all present,
  // so a gap is reported rather than silently treated as a complete total.
  function ga4CoverageFor(periodKey) {
    var cov = state.data.dataFreshness.ga4.coverage;
    return cov ? cov[periodKey] : null;
  }
  function ga4CoverageNote(periodKey) {
    var cov = ga4CoverageFor(periodKey);
    if (!cov || cov.coveredDays >= cov.expectedDays) return '';
    if (cov.coveredDays === 0) return 'No data available for this period';
    return 'Only ' + cov.coveredDays + ' of ' + cov.expectedDays + ' days available';
  }

  // --- Rendering: KPI cards ------------------------------------------------
  function kpiCardHtml(def, m) {
    var icon = KPI_ICON_BY_METRIC[def.key];
    var iconHtml = icon ? '<span class="sp-kpi-icon">' + iconSvg(icon) + '</span>' : '';
    var store = currentStoreEntry();
    var sharedBadge = (def.section === 'traffic' && store && store.citySharedLabel)
      ? '<span class="sp-badge" title="' + escapeHtml(store.citySharedLabel) + '">50/50 city split</span>' : '';

    if (def.pending || (m && m.unavailable)) {
      return (
        '<div class="sp-kpi-card">' +
          '<div class="sp-kpi-top"><span class="sp-kpi-title">' + def.label + '</span>' + iconHtml + '</div>' +
          '<div class="sp-kpi-value sp-kpi-value--pending">' + (def.pending ? 'Logic / Data Source Pending' : 'Data unavailable') + '</div>' +
          '<div class="sp-kpi-note">' + (def.pending ? (def.pendingReason || '') : 'Try Refresh shortly.') + '</div>' +
        '</div>'
      );
    }

    var current = m[state.activePeriod];
    var isTraffic = def.section === 'traffic';
    var notes = [];
    if (def.dataNote) notes.push(def.dataNote);
    if (isTraffic && ga4DateNote(state.activePeriod)) notes.push(ga4DateNote(state.activePeriod));
    if (isTraffic && ga4CoverageNote(state.activePeriod)) notes.push(ga4CoverageNote(state.activePeriod));
    var dateNote = notes.length ? '<div class="sp-kpi-note">' + notes.join(' ') + '</div>' : '';

    return (
      '<div class="sp-kpi-card">' +
        '<div class="sp-kpi-top"><span class="sp-kpi-title">' + def.label + sharedBadge + '</span>' + iconHtml + '</div>' +
        '<div class="sp-kpi-value">' + fmtByFormat(def.format, current) + '</div>' +
        dateNote +
      '</div>'
    );
  }

  function renderKpiSection() {
    var store = currentStoreEntry();
    var row1 = KPI_METRIC_KEYS.slice(0, 4);
    var row2 = KPI_METRIC_KEYS.slice(4, 8);
    function rowHtml(keys) {
      return '<div class="sp-kpi-grid">' + keys.map(function (k) {
        return kpiCardHtml(metricDef(k), store.metrics[k]);
      }).join('') + '</div>';
    }
    return (
      '<section class="sp-section">' +
        '<div class="sp-section-head">' +
          '<h2 class="sp-section-title">Store Performance</h2>' +
          '<p class="sp-section-desc">' + escapeHtml(store.displayName) + ' &mdash; ' + state.data.periods[state.activePeriod].label +
          ' (' + state.data.periods[state.activePeriod].displayRange + ')</p>' +
        '</div>' +
        rowHtml(row1) + rowHtml(row2) +
      '</section>'
    );
  }

  // --- Rendering: bar-list charts ------------------------------------------------
  function barListHtml(rows, formatFn) {
    if (!rows.length) return '<div class="sp-barlist-empty">No data available.</div>';
    var max = Math.max.apply(null, rows.map(function (r) { return r.value || 0; }).concat([0]));
    return '<div class="sp-barlist">' + rows.map(function (r) {
      var pct = max > 0 ? Math.max((r.value || 0) / max * 100, r.value ? 2 : 0) : 0;
      return (
        '<div class="sp-barlist-row">' +
          '<span class="sp-barlist-label" title="' + escapeHtml(r.label) + '">' + escapeHtml(r.label) + '</span>' +
          '<span class="sp-barlist-track"><span class="sp-barlist-fill" style="width:' + pct + '%;' + (r.color ? 'background:' + r.color + ';' : '') + '"></span></span>' +
          '<span class="sp-barlist-value">' + (r.value === null || r.value === undefined ? '—' : formatFn(r.value)) + '</span>' +
        '</div>'
      );
    }).join('') + '</div>';
  }

  function renderStoreComparisonCard() {
    var d = state.data;
    var def = metricDef(state.comparisonMetric);
    var p = state.activePeriod;
    var rows;
    var bodyHtml;
    if (def.pending) {
      bodyHtml = '<div class="sp-barlist-empty">' + def.label + ' has no verified data source yet (Logic / Data Source Pending).</div>';
    } else {
      rows = d.stores.map(function (s) {
        var m = s.metrics[def.key];
        return { label: s.displayName, value: (m && m.unavailable) ? null : m[p], color: s.accent };
      }).sort(function (a, b) { return (b.value || 0) - (a.value || 0); });
      bodyHtml = barListHtml(rows, function (v) { return fmtByFormat(def.format, v); });
    }
    var options = COMPARISON_METRIC_OPTIONS.map(function (o) {
      return '<option value="' + o.key + '"' + (o.key === state.comparisonMetric ? ' selected' : '') + '>' + o.label + '</option>';
    }).join('');
    return (
      '<div class="sp-chart-card">' +
        '<div class="sp-chart-card-head">' +
          '<div><h3 class="sp-chart-card-title">Store Comparison</h3>' +
          '<p class="sp-chart-card-subtitle">' + d.periods[p].label + ' &middot; all ' + d.stores.length + ' stores</p></div>' +
          '<select id="comparisonMetricSelect" class="sp-chart-select">' + options + '</select>' +
        '</div>' +
        bodyHtml +
      '</div>'
    );
  }

  function renderCallBreakdownCard() {
    var d = state.data;
    var store = currentStoreEntry();
    var p = state.activePeriod;
    var callsFailed = CALL_BREAKDOWN_METRICS.some(function (o) {
      var m = store.metrics[o.key];
      return m && m.unavailable;
    });
    var bodyHtml;
    if (callsFailed) {
      bodyHtml = '<div class="sp-barlist-empty">Data unavailable right now — try Refresh shortly.</div>';
    } else {
      var rows = CALL_BREAKDOWN_METRICS.map(function (o) {
        var m = store.metrics[o.key];
        return { label: o.label, value: m[p] };
      });
      bodyHtml = barListHtml(rows, fmtInt);
    }
    return (
      '<div class="sp-chart-card">' +
        '<div class="sp-chart-card-head">' +
          '<div><h3 class="sp-chart-card-title">Call Performance</h3>' +
          '<p class="sp-chart-card-subtitle">' + escapeHtml(store.displayName) + ' &middot; ' + d.periods[p].label + '</p></div>' +
        '</div>' +
        bodyHtml +
      '</div>'
    );
  }

  function renderChartsSection() {
    return (
      '<section class="sp-section">' +
        '<div class="sp-section-head">' +
          '<h2 class="sp-section-title">Performance Breakdown</h2>' +
          '<p class="sp-section-desc">Compare stores side by side and see how outbound calls convert to connections.</p>' +
        '</div>' +
        '<div class="sp-chart-row">' + renderStoreComparisonCard() + renderCallBreakdownCard() + '</div>' +
      '</section>'
    );
  }

  function bindChartControls() {
    var sel = document.getElementById('comparisonMetricSelect');
    if (sel) {
      sel.addEventListener('change', function () {
        state.comparisonMetric = sel.value;
        renderContent();
      });
    }
  }

  // --- Rendering: comparison table ------------------------------------------------
  function tableRows() {
    var d = state.data;
    var store = currentStoreEntry();
    return d.metricDefs.map(function (def) {
      var m = store.metrics[def.key];
      return { def: def, m: m };
    });
  }

  function bindStaffCountControls() {
    Array.prototype.forEach.call(document.querySelectorAll('.sp-staff-input'), bindStaffInput);
  }

  // One input per store row; a full redraw on save is safe.
  function bindStaffInput(input) {
    var status = input.parentElement.querySelector('.sp-staff-status');
    var saved = false;
    function save() {
      if (saved) return; // avoid a duplicate save from both blur and Enter
      var storeKey = input.getAttribute('data-store');
      var count = input.value === '' ? NaN : Number(input.value);
      if (!Number.isInteger(count) || count < 0) {
        status.textContent = 'Enter a whole number, 0 or higher.';
        return;
      }
      saved = true;
      input.disabled = true;
      status.textContent = 'Saving…';
      fetch('/api/store-performance/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeKey: storeKey, count: count }),
      })
        .then(function (res) {
          if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || ('HTTP ' + res.status)); });
          return res.json();
        })
        .then(function () {
          var d = state.data;
          var storeEntry = d.stores.filter(function (s) { return s.key === storeKey; })[0];
          if (storeEntry) {
            storeEntry.metrics.staffCount = { yesterday: count, lastWeek: count, lastMonth: count, snapshot: true };
          }
          var total = d.stores.reduce(function (sum, s) {
            var m = s.metrics.staffCount;
            return sum + ((m && m.yesterday != null) ? m.yesterday : 0);
          }, 0);
          var anySet = d.stores.some(function (s) { return s.metrics.staffCount && s.metrics.staffCount.yesterday != null; });
          d.allStores.metrics.staffCount = { yesterday: anySet ? total : null, lastWeek: anySet ? total : null, lastMonth: anySet ? total : null, snapshot: true };
          renderContent();
        })
        .catch(function (err) {
          saved = false;
          input.disabled = false;
          status.textContent = 'Save failed: ' + err.message;
        });
    }
    input.addEventListener('blur', save);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
  }

  // --- Dashboard tab: the ORIGINAL metric-by-period table --------------------------------
  // Metrics down the side, Yesterday / Last Week / Last Month across, for the store(s)
  // picked in the Store filter. Limited to the metrics this table had before the
  // Store Comparison grid existed — anything added since lives in the Store Comparison tab.
  var VERTICAL_METRIC_KEYS = [
    'citySessions', 'paidSessions', 'retargetingSessions', 'communicationSessions',
    'deals', 'meetingsRaised', 'walkinsFromMeetings', 'walkins', 'orders', 'revenue',
    'callsDialed', 'callsConnected', 'callsConnected30s', 'talktimeSeconds',
    'gmbStrength', 'googleReviews', 'googleRating', 'storeDirectionClicks', 'storeIncomingCalls',
    'inventory', 'staffCount',
    'spend', 'costPerSession', 'costPerDeal', 'costPerAppointment',
  ];
  function verticalRows() {
    var store = currentStoreEntry();
    return state.data.metricDefs
      .filter(function (def) { return VERTICAL_METRIC_KEYS.indexOf(def.key) !== -1; })
      .map(function (def) { return { def: def, m: store.metrics[def.key] }; });
  }

  function sortedVerticalRows(rows) {
    var col = state.vsort.col, dir = state.vsort.dir;
    var copy = rows.slice();
    copy.sort(function (a, b) {
      if (col === 'metric') {
        return a.def.label.localeCompare(b.def.label) * dir;
      }
      var av = a.m[col], bv = b.m[col];
      var aNull = av === null || av === undefined;
      var bNull = bv === null || bv === undefined;
      if (aNull && bNull) return 0;
      if (aNull) return 1; // pending/null always sorts last
      if (bNull) return -1;
      return (av - bv) * dir;
    });
    return copy;
  }

  function renderVerticalTable() {
    var d = state.data;
    if (!d) return '';
    var p = d.periods;
    var store = currentStoreEntry();
    var rows = sortedVerticalRows(verticalRows());
    var head = '<tr>' +
      '<th data-sort="metric">Metric</th>' +
      '<th data-sort="yesterday">Yesterday<span class="sp-th-sub">' + p.yesterday.displayRange + '</span></th>' +
      '<th data-sort="lastWeek">Last Week<span class="sp-th-sub">' + p.lastWeek.displayRange + '</span></th>' +
      '<th data-sort="lastMonth">Last Month<span class="sp-th-sub">' + p.lastMonth.displayRange + '</span></th>' +
      (p.custom ? '<th data-sort="custom">Custom<span class="sp-th-sub">' + p.custom.displayRange + '</span></th>' : '') +
      '</tr>';
    var nCols = p.custom ? 4 : 3;
    var body = rows.map(function (r) {
      var def = r.def, m = r.m;
      var isSingleStore = store && store.key !== 'all' && store.key !== '__selection__';
      if (def.editable && isSingleStore) {
        // Only a single selected store is unambiguous for editing — "All
        // Stores"/multi-select falls through to the normal read-only total
        // below instead of one input per store.
        var current = m && m.yesterday != null ? m.yesterday : '';
        var cell =
          '<div class="sp-staff-edit">' +
            '<input type="number" min="0" step="1" class="sp-staff-input" ' +
              'value="' + escapeHtml(String(current)) + '" placeholder="Not entered" data-store="' + escapeHtml(store.key) + '" />' +
            '<span class="sp-staff-status"></span>' +
          '</div>';
        return '<tr>' +
          '<td data-label="Metric">' + def.label + (def.dataNote ? '<span class="sp-badge" title="' + escapeHtml(def.dataNote) + '">data note</span>' : '') + '</td>' +
          '<td data-label="Yesterday" colspan="' + nCols + '">' + cell + '</td>' +
          '</tr>';
      }
      if (def.pending) {
        return '<tr class="sp-row-pending">' +
          '<td data-label="Metric">' + def.label + '</td>' +
          '<td data-label="Yesterday" colspan="' + nCols + '" class="sp-pending-cell">Logic / Data Source Pending</td>' +
          '</tr>';
      }
      if (m && m.unavailable) {
        return '<tr class="sp-row-pending">' +
          '<td data-label="Metric">' + def.label + '</td>' +
          '<td data-label="Yesterday" colspan="' + nCols + '" class="sp-pending-cell">Data unavailable</td>' +
          '</tr>';
      }
      function cellHtml(periodKey, value) {
        var notes = def.section === 'traffic' ? [ga4DateNote(periodKey), ga4CoverageNote(periodKey)].filter(Boolean) : [];
        return fmtByFormat(def.format, value) + (notes.length ? '<span class="sp-th-sub">' + notes.join(' ') + '</span>' : '');
      }
      var badgeText = def.section === 'traffic' ? 'not GA4-comparable' : 'data note';
      var metricLabel = def.label + (def.dataNote ? '<span class="sp-badge" title="' + escapeHtml(def.dataNote) + '">' + badgeText + '</span>' : '');
      return '<tr>' +
        '<td data-label="Metric">' + metricLabel + '</td>' +
        '<td data-label="Yesterday">' + cellHtml('yesterday', m.yesterday) + '</td>' +
        '<td data-label="Last Week">' + cellHtml('lastWeek', m.lastWeek) + '</td>' +
        '<td data-label="Last Month">' + cellHtml('lastMonth', m.lastMonth) + '</td>' +
        (p.custom ? '<td data-label="Custom">' + cellHtml('custom', m.custom) + '</td>' : '') +
        '</tr>';
    }).join('');
    return (
      '<section class="sp-section">' +
        '<div class="sp-section-head">' +
          '<h2 class="sp-section-title">Full Metric Comparison</h2>' +
          '<p class="sp-section-desc">All ' + rows.length + ' tracked metrics for the selected store(s). Click a column header to sort.</p>' +
        '</div>' +
        '<div class="table-wrap">' +
          '<table class="report-table sp-stack" id="metricTable">' +
            '<thead>' + head + '</thead>' +
            '<tbody>' + body + '</tbody>' +
          '</table>' +
        '</div>' +
        '<button class="export-btn" data-export-table="metricTable" data-export-filename="' + exportFilenameForSelection() + '-metrics">&#8595; Export CSV</button>' +
      '</section>'
    );
  }

  function bindVerticalSort() {
    var table = document.getElementById('metricTable');
    if (!table) return;
    Array.prototype.forEach.call(table.querySelectorAll('th[data-sort]'), function (th) {
      th.addEventListener('click', function () {
        var col = th.getAttribute('data-sort');
        if (state.vsort.col === col) state.vsort.dir *= -1;
        else state.vsort = { col: col, dir: 1 };
        renderContent();
      });
    });
  }

  // Stores down the side, metrics across the top, for the active period — so
  // stores can be compared side by side. Clicking a metric header ranks the
  // stores by it (first click high-to-low, click again to reverse).
  function sortStoreRows(storeRows) {
    var col = state.sort.col, dir = state.sort.dir;
    if (!col) return storeRows;
    var p = state.activePeriod;
    return storeRows.slice().sort(function (a, b) {
      var am = a.metrics[col], bm = b.metrics[col];
      var av = am && !am.unavailable && !am.pending ? am[p] : null;
      var bv = bm && !bm.unavailable && !bm.pending ? bm[p] : null;
      var aNull = av === null || av === undefined;
      var bNull = bv === null || bv === undefined;
      if (aNull && bNull) return 0;
      if (aNull) return 1; // missing values always sort last
      if (bNull) return -1;
      return (av - bv) * dir * -1; // dir -1 = high to low
    });
  }

  function pivotCellHtml(def, store, isTotalRow, drillStores) {
    var m = store.metrics[def.key];
    var p = state.activePeriod;
    if (def.pending) return '<td class="sp-pending-cell" title="Logic / data source pending">Pending</td>';
    if (!m || m.unavailable) return '<td class="sp-pending-cell" title="Data unavailable">N/A</td>';
    if (def.editable && !isTotalRow) {
      var current = m.yesterday != null ? m.yesterday : '';
      return '<td><div class="sp-staff-edit">' +
        '<input type="number" min="0" step="1" class="sp-staff-input" value="' + escapeHtml(String(current)) +
        '" placeholder="Not entered" data-store="' + escapeHtml(store.key) + '" />' +
        '<span class="sp-staff-status"></span></div></td>';
    }
    // Orders opens the bills behind the number, in a new tab.
    if (def.key === 'orders' && drillStores) {
      return '<td><a class="sp-drill" href="/store-orders.html?stores=' + encodeURIComponent(drillStores) +
        '&period=' + p + (p === 'custom' && state.customRange ? '&from=' + state.customRange.from + '&to=' + state.customRange.to : '') +
        '" target="_blank" rel="noopener" title="See the bills behind this number">' +
        fmtByFormat(def.format, m[p]) + '</a></td>';
    }
    return '<td>' + fmtByFormat(def.format, m[p]) + '</td>';
  }

  // The Store Comparison tab counts made-to-order pieces only once billed, at the RTS bill amount
  // (server sends these as compareMetrics). Its order and revenue columns read from those; the
  // Dashboard tab keeps using the normal metrics. Falls back to the normal figures if absent.
  function withCompareMetrics(d) {
    if (!d || !d.allStores || !d.allStores.compareMetrics) return d;
    function merged(s) { return Object.assign({}, s, { metrics: Object.assign({}, s.metrics, s.compareMetrics || {}) }); }
    return Object.assign({}, d, { stores: d.stores.map(merged), allStores: merged(d.allStores) });
  }
  function renderTable() {
    var original = state.data;
    if (!original) return '';
    state.data = withCompareMetrics(state.totalsData || original);
    try { return renderTableInner(); } finally { state.data = original; }
  }
  // The Store Comparison tab's columns, in order. 'virtual' ones are worked out here from other
  // metrics (and the store's fixed area); the rest are metrics from the API.
  var COMPARE_COLUMNS = [
    { key: 'inventory', label: 'Inventory' },
    { key: 'areaSqFt', label: 'Sq Ft', virtual: true, format: 'int', dataNote: 'Store floor area in square feet (fixed). All Stores is the total.' },
    { key: 'staffCount', label: 'Number of Staff' },
    { key: 'walkins', label: 'Walkins' },
    { key: 'newWalkins', label: 'New Walkins' },
    { key: 'repeatWalkins', label: 'Repeat Walkins' },
    { key: 'meetingsRaised', label: 'Meetings Raised' },
    { key: 'customers', label: 'Customers', virtual: true, format: 'int', dataNote: 'New Customers + Repeat Customers: different customers who bought.' },
    { key: 'newBuyers', label: 'New Customers' },
    { key: 'repeatBuyers', label: 'Repeat Customers' },
    { key: 'orders', label: 'Orders' },
    { key: 'onlineInfluenced', label: 'Online Influenced Orders' },
    { key: 'salesQty', label: 'Qty' },
    { key: 'salesAmount', label: 'Revenue', dataNote: 'Sales Amount: the POS invoice amount after discount, for the sold items that have a purchase cost record.' },
    { key: 'purchaseAmount', label: 'Purchase Cost' },
    { key: 'margin', label: 'Margin' },
    { key: 'marginPct', label: 'Margin %', virtual: true, format: 'percent', dataNote: 'Margin / Sales Amount of the same items.' },
    { key: 'atv', label: 'ATV', virtual: true, format: 'currency', dataNote: 'Revenue (Sales Amount) / Orders.' },
    { key: 'newSalesAmount', label: 'New Revenue', dataNote: 'Sales Amount from first-time customers.' },
    { key: 'repeatSalesAmount', label: 'Repeat Revenue', dataNote: 'Sales Amount from returning customers.' },
    { key: 'newAtvSA', label: 'New ATV', virtual: true, format: 'currency', dataNote: 'New Revenue (Sales Amount) / New Orders.' },
    { key: 'repeatAtvSA', label: 'Repeat ATV', virtual: true, format: 'currency', dataNote: 'Repeat Revenue (Sales Amount) / Repeat Orders.' },
    { key: 'revenuePerStaffSA', label: 'Revenue Per Staff', virtual: true, format: 'currency', dataNote: 'Revenue (Sales Amount) / Number of Staff.' },
    { key: 'marginPerSqft', label: 'Margin / Sq Ft' },
    { key: 'scans', label: 'Scans' },
    { key: 'scansPerVisitor', label: 'Scans Per Walkin' },
    { key: 'googleRating', label: 'Google Rating' },
    { key: 'googleReviews', label: 'Reviews' },
  ];
  function compareDefs(d) {
    return COMPARE_COLUMNS.map(function (c) {
      var base = c.virtual ? { format: c.format } : (d.metricDefs.find(function (m) { return m.key === c.key; }) || { format: 'int' });
      return { key: c.key, label: c.label, format: base.format, dataNote: c.dataNote || base.dataNote };
    });
  }
  function unavailableMetric() { return { unavailable: true }; }
  function perPeriod(fn) { var o = {}; PERIOD_KEYS.forEach(function (p) { o[p] = fn(p); }); return o; }
  function usable(m) { return m && !m.unavailable && !m.pending; }
  // Adds the worked-out columns to a store row (also used for the All Stores / selection rows).
  function addVirtuals(entry) {
    var d = state.data, m = entry.metrics, v = {};
    var area = entry.areaSqFt;
    if (entry.key === 'all') area = d.stores.reduce(function (a, s) { return a + (s.areaSqFt || 0); }, 0);
    else if (entry.key === '__selection__') {
      var keys = selectedStoreKeys();
      area = d.stores.filter(function (s) { return keys.indexOf(s.key) !== -1; }).reduce(function (a, s) { return a + (s.areaSqFt || 0); }, 0);
    }
    v.areaSqFt = area ? perPeriod(function () { return area; }) : unavailableMetric();
    v.customers = (usable(m.newBuyers) && usable(m.repeatBuyers))
      ? perPeriod(function (p) { return (m.newBuyers[p] || 0) + (m.repeatBuyers[p] || 0); }) : unavailableMetric();
    // Revenue-based columns on this tab all use Sales Amount.
    function saRatio(numM, denM) {
      return (usable(numM) && usable(denM))
        ? perPeriod(function (p) { return denM[p] ? Math.round((numM[p] / denM[p]) * 100) / 100 : null; }) : unavailableMetric();
    }
    v.atv = saRatio(m.salesAmount, m.orders);
    v.newAtvSA = saRatio(m.newSalesAmount, m.newOrders);
    v.repeatAtvSA = saRatio(m.repeatSalesAmount, m.repeatOrders);
    var staff = entry.staff;
    if (entry.key === 'all' || entry.key === '__selection__') {
      var selKeys = entry.key === 'all' ? null : selectedStoreKeys();
      staff = d.stores.filter(function (s) { return (!selKeys || selKeys.indexOf(s.key) !== -1) && s.staff && usable(s.metrics.salesAmount); })
        .reduce(function (a, s) { return a + s.staff; }, 0);
    }
    v.revenuePerStaffSA = (staff && usable(m.salesAmount))
      ? perPeriod(function (p) { return Math.round((m.salesAmount[p] / staff) * 100) / 100; }) : unavailableMetric();
    v.marginPct = (usable(m.margin) && usable(m.salesAmount))
      ? perPeriod(function (p) { return m.salesAmount[p] ? Math.round((m.margin[p] / m.salesAmount[p]) * 1000) / 10 : null; }) : unavailableMetric();
    return Object.assign({}, entry, { metrics: Object.assign({}, m, v) });
  }
  function renderTableInner() {
    var d = state.data;
    if (!d) return '';
    var p = state.activePeriod;
    var period = d.periods[p];
    var keys = selectedStoreKeys();
    var storeRows = sortStoreRows(d.stores.filter(function (s) { return keys.indexOf(s.key) !== -1; }).map(addVirtuals));
    var totalEntry = null;
    if (keys.length === d.stores.length) totalEntry = addVirtuals(d.allStores);
    else if (keys.length > 1) totalEntry = addVirtuals(buildAggregateStore(keys));

    var allDefs = compareDefs(d);
    var headRow = '<tr><th class="sp-pivot-corner">Store</th>' + allDefs.map(function (def) {
      var arrow = state.sort.col === def.key ? (state.sort.dir === -1 ? ' &#9660;' : ' &#9650;') : '';
      return '<th data-sort="' + def.key + '"' + (def.dataNote ? ' title="' + escapeHtml(def.dataNote) + '"' : '') + '>' +
        escapeHtml(def.label) + arrow + '</th>';
    }).join('') + '</tr>';

    function bodyRow(store, isTotalRow) {
      var drill = isTotalRow ? (keys.length === d.stores.length ? 'all' : keys.join(',')) : store.key;
      return '<tr' + (isTotalRow ? ' class="row-total"' : '') + '><td class="sp-pivot-store">' + escapeHtml(store.displayName) + '</td>' +
        allDefs.map(function (def) { return pivotCellHtml(def, store, isTotalRow, drill); }).join('') + '</tr>';
    }
    var body = storeRows.map(function (s) { return bodyRow(s, false); }).join('') +
      (totalEntry ? bodyRow(totalEntry, true) : '');

    return (
      '<section class="sp-section">' +
        '<div class="sp-section-head">' +
          '<h2 class="sp-section-title">Full Metric Comparison</h2>' +
          '<p class="sp-section-desc">Stores down, metrics across &mdash; ' + escapeHtml(period.label) + ' (' + escapeHtml(period.displayRange) +
          ') &mdash; totals for the whole period, not averages. Click a metric header to rank stores.' +
            (d.allStores.compareMetrics ? ' Orders and revenue count a made-to-order (MTO) piece only once it is billed, at its final RTS bill amount.' : '') + '</p>' +
        '</div>' +
        '<div class="table-wrap sp-pivot-wrap">' +
          '<table class="report-table sp-pivot" id="fullTable">' +
            '<thead>' + headRow + '</thead>' +
            '<tbody>' + body + '</tbody>' +
          '</table>' +
        '</div>' +
        '<button class="export-btn" data-export-table="fullTable" data-export-filename="' + exportFilenameForSelection() + '-metrics-' + p + '">&#8595; Export CSV</button>' +
      '</section>'
    );
  }

  // City Wise tab: each city is the sum of its stores. Mumbai = Borivali + Chembur; Delhi = Paschim
  // Vihar + Lajpat Nagar + Noida; Pune and Bangalore (Malleshwaram) are single stores. Website
  // sessions are already split between the stores of a city, so they add back up to the city total.
  var CITY_ROWS = [
    { name: 'Mumbai', keys: ['borivali', 'chembur'] },
    { name: 'Pune', keys: ['pune'] },
    { name: 'Delhi', keys: ['paschimVihar', 'lajpatNagar', 'noida'] },
    { name: 'Bangalore', keys: ['malleshwaram'] },
  ];
  function renderCityTable() {
    var d = state.totalsData;
    if (!d) return '';
    var p = state.activePeriod;
    var period = d.periods[p];
    if (!period) return '';
    function def(key) { return d.metricDefs.find(function (m) { return m.key === key; }) || { format: 'int' }; }
    // City total of one metric; null (shown N/A) if any of its stores has no data for it.
    // 'lenient' skips stores with no data for it (Malleshwaram has no walk-in records) and only
    // gives null when none of the stores has any.
    function sumFor(keys, metric, lenient) {
      var total = 0, any = false;
      for (var i = 0; i < keys.length; i++) {
        var s = d.stores.find(function (x) { return x.key === keys[i]; });
        var m = s && s.metrics[metric];
        if (!m || m.unavailable || m.pending) { if (lenient) continue; return null; }
        total += m[p] || 0; any = true;
      }
      return (lenient && !any) ? null : total;
    }
    function ratio(n, dn) { return (n == null || dn == null || !dn) ? null : Math.round((n / dn) * 100) / 100; }
    function figures(keys) {
      var f = { stores: keys.length, sessions: sumFor(keys, 'citySessions'), deals: sumFor(keys, 'deals'),
        meetings: sumFor(keys, 'meetingsRaised'), spend: sumFor(keys, 'spend'),
        visited: sumFor(keys, 'meetingsShown'), converted: sumFor(keys, 'meetingsConverted') };
      f.cps = ratio(f.spend, f.sessions); f.cpd = ratio(f.spend, f.deals); f.cpa = ratio(f.spend, f.meetings);
      return f;
    }
    var rows = CITY_ROWS.map(function (c) { return { name: c.name, f: figures(c.keys) }; });
    var allKeys = [].concat.apply([], CITY_ROWS.map(function (c) { return c.keys; }));
    var totalRow = { name: 'All Cities', f: figures(allKeys), total: true };
    var gp = d.ga4Periods && d.ga4Periods[p];
    var sessionNote = (p === 'yesterday' && gp) ? '<span class="sp-th-sub">As of ' + escapeHtml(gp.displayRange) + '</span>' : '';
    function cell(fmt, v) { return v == null ? '<td class="sp-pending-cell" title="Data unavailable">N/A</td>' : '<td>' + fmtByFormat(fmt, v) + '</td>'; }
    var head = '<tr><th class="sp-pivot-corner">City</th><th>Stores</th><th>City Sessions' + sessionNote + '</th><th>City Deals</th>' +
      '<th>Meetings Raised</th>' +
      '<th title="Meetings raised in the period where the customer visited the store. From 22 Sep 2026 this is the Show mark the store team sets in Zoho CRM Meetings; for earlier meetings it is a store visit (customer_walkin) by the same phone number after the meeting was raised.">Visited From Meetings</th>' +
      '<th title="Meetings raised in the period that turned into an order. From 22 Sep 2026 this is the Converted mark the store team sets in Zoho CRM Meetings; for earlier meetings it is a visitor who then placed a store bill (marketing_sale). Shown with the share of Meetings Raised.">Order Conversion</th><th>Spend</th><th>Cost Per Session</th><th>Cost Per Deal</th><th>Cost Per Appointment</th></tr>';
    var body = rows.concat([totalRow]).map(function (r) {
      var f = r.f;
      return '<tr' + (r.total ? ' class="row-total"' : '') + '><td class="sp-pivot-store">' + escapeHtml(r.name) + '</td>' +
        '<td>' + f.stores + '</td>' + cell('int', f.sessions) + cell('int', f.deals) + cell('int', f.meetings) + cell('int', f.visited) +
        (f.converted == null ? '<td class="sp-pending-cell" title="Data unavailable">N/A</td>'
          : '<td>' + fmtByFormat('int', f.converted) + (f.meetings ? ' (' + Math.round((f.converted / f.meetings) * 100) + '%)' : '') + '</td>') +
        cell(def('spend').format, f.spend) + cell(def('costPerSession').format, f.cps) + cell(def('costPerDeal').format, f.cpd) +
        cell(def('costPerAppointment').format, f.cpa) + '</tr>';
    }).join('');
    return (
      '<section class="sp-section">' +
        '<div class="sp-section-head">' +
          '<h2 class="sp-section-title">City Wise</h2>' +
          '<p class="sp-section-desc">' + escapeHtml(period.label) + ' (' + escapeHtml(period.displayRange) + ') &mdash; totals for the whole period, not averages. ' +
          'Delhi includes Noida. Spend is only the ad spend that names a store or city, so the cost figures are lower-bound estimates. ' +
          'Meetings with a blank Venue are not in any city. Visited From Meetings and Order Conversion count the meetings raised in the period. From 22 Sep 2026 they use the Show and Converted marks the store team sets in Zoho CRM; for meetings before that they use the phone number: a store visit after the meeting is Visited, and a bill by that visitor is Converted.</p>' +
        '</div>' +
        '<div class="table-wrap sp-pivot-wrap">' +
          '<table class="report-table sp-pivot" id="cityTable"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' +
        '</div>' +
        '<button class="export-btn" data-export-table="cityTable" data-export-filename="city-wise-' + p + '">&#8595; Export CSV</button>' +
      '</section>'
    );
  }

  function bindTableSort() {
    var table = document.getElementById('fullTable');
    if (!table) return;
    Array.prototype.forEach.call(table.querySelectorAll('th[data-sort]'), function (th) {
      th.addEventListener('click', function () {
        var col = th.getAttribute('data-sort');
        if (state.sort.col === col) state.sort.dir *= -1;
        else state.sort = { col: col, dir: -1 };
        renderContent();
      });
    });
  }

  function bindExportButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-export-table]'), function (btn) {
      btn.onclick = function () {
        var table = document.getElementById(btn.getAttribute('data-export-table'));
        if (!table) return;
        var rows = Array.prototype.map.call(table.querySelectorAll('tr:not(.sp-group-row)'), function (tr) {
          return Array.prototype.map.call(tr.querySelectorAll('th,td'), function (cell) {
            var text = cell.textContent.replace(/\s+/g, ' ').trim().replace(/"/g, '""');
            return '"' + text + '"';
          }).join(',');
        });
        var blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (btn.getAttribute('data-export-filename') || 'export') + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };
    });
  }

  function renderContent() {
    var d = state.data;
    if (!d) { els.content.innerHTML = ''; return; }
    var store = state.view === 'city' ? true : currentStoreEntry();
    if (!store) {
      els.content.innerHTML =
        '<div class="sp-empty">' +
          '<p class="sp-empty-title">No store selected</p>' +
          '<p class="sp-empty-desc">Check at least one store in the Store dropdown to see data.</p>' +
        '</div>';
      return;
    }
    if (state.view === 'compare' || state.view === 'city') {
      // Store Comparison / City Wise tabs: tables from their own totals data.
      if (!state.totalsData) {
        els.content.innerHTML = state.totalsFailed
          ? '<div class="sp-empty"><p class="sp-empty-title">Unable to load this tab</p><p class="sp-empty-desc">Press Refresh to try again.</p></div>'
          : '<div class="sp-empty"><p class="sp-empty-title">Loading&hellip;</p><p class="sp-empty-desc">Getting the full-period totals.</p></div>';
        if (!state.totalsFailed) fetchTotals(false);
        return;
      }
      syncPeriodKeys(state.totalsData);
      if (!state.totalsData.periods[state.activePeriod]) { state.activePeriod = 'yesterday'; renderControls(); }
      if (state.view === 'city') {
        els.content.innerHTML = renderCityTable();
      } else {
        els.content.innerHTML = renderTable();
        bindTableSort();
      }
    } else {
      // Dashboard tab: KPI cards, charts, and the original metric-by-period table.
      syncPeriodKeys(d);
      els.content.innerHTML = renderKpiSection() + renderChartsSection() + renderVerticalTable();
      bindChartControls();
      bindVerticalSort();
    }
    bindExportButtons();
    bindStaffCountControls();
  }

  function showSkeleton(show) {
    els.skeleton.hidden = !show;
    els.content.hidden = show;
    els.controlsWrap.hidden = show || !state.data;
  }

  // Store Comparison tab data: same payload, but with Today added and real totals for every period.
  function fetchTotals(force) {
    if (state.totalsLoading) return;
    state.totalsLoading = true;
    var qs = ['totals=1'];
    if (force || state.forceTotals) qs.push('refresh=true');
    state.forceTotals = false;
    var forView = state.view;             // the tab this data is for, even if you switch tabs meanwhile
    var cr = state.customRange;
    if (cr) qs.push('from=' + encodeURIComponent(cr.from), 'to=' + encodeURIComponent(cr.to));
    function put(data, failed) {
      var slot = forView === state.view ? state : state.viewState[forView];
      slot.totalsData = data; slot.totalsFailed = failed;
    }
    fetch('/api/store-performance?' + qs.join('&'))
      .then(function (res) {
        if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || ('HTTP ' + res.status)); });
        return res.json();
      })
      .then(function (data) { put(data, false); })
      .catch(function () { put(null, true); })
      .then(function () {
        state.totalsLoading = false;
        if (state.view !== 'dashboard') { renderControls(); renderContent(); }
      });
  }

  function load(forceRefresh) {
    if (state.loading) return;
    state.loading = true;
    showSkeleton(!state.data);
    setStatus(state.data ? 'Refreshing…' : null);
    els.refreshBtn.disabled = true;

    var qs = [];
    if (forceRefresh) qs.push('refresh=true');
    var dr = viewRange('dashboard');
    if (dr) qs.push('from=' + encodeURIComponent(dr.from), 'to=' + encodeURIComponent(dr.to), 'basis=' + (dr.basis === 'avg' ? 'avg' : 'total'));
    fetch('/api/store-performance' + (qs.length ? '?' + qs.join('&') : ''))
      .then(function (res) {
        if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || ('HTTP ' + res.status)); });
        return res.json();
      })
      .then(function (data) {
        state.data = data;
        state.totalsData = null; state.totalsFailed = false; state.forceTotals = !!forceRefresh;
        Object.keys(state.viewState).forEach(function (v) { state.viewState[v].totalsData = null; state.viewState[v].totalsFailed = false; });
        syncPeriodKeys(data);
        if (state.view === 'dashboard' && state.activePeriod === 'custom' && !data.periods.custom) state.activePeriod = 'yesterday';
        setStatus(null);
        showSkeleton(false);
        renderFreshnessBanner();
        renderControls();
        renderContent();
        els.updatedAtText.textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      })
      .catch(function () {
        showSkeleton(false);
        setStatus(null);
        els.content.innerHTML =
          '<div class="sp-empty">' +
            '<p class="sp-empty-title">Unable to load data</p>' +
            '<p class="sp-empty-desc">Please refresh the dashboard or try again.</p>' +
          '</div>';
      })
      .finally(function () {
        state.loading = false;
        els.refreshBtn.disabled = false;
      });
  }

  els.refreshBtn.addEventListener('click', function () { load(true); });

  els.storeMultiSelectTrigger.addEventListener('click', function (e) {
    e.stopPropagation();
    state.storeMultiSelectOpen = !state.storeMultiSelectOpen;
    renderControls();
  });
  els.storeMultiSelectPanel.addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function () {
    if (!state.storeMultiSelectOpen) return;
    state.storeMultiSelectOpen = false;
    renderControls();
  });

  // Dashboard/Logic are two panels on this same page, toggled client-side —
  // one URL, no navigation, nothing re-fetched.
  els.mainNav.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-tab]');
    if (!btn) return;
    var tab = btn.getAttribute('data-tab');
    Array.prototype.forEach.call(els.mainNav.querySelectorAll('[data-tab]'), function (b) {
      b.classList.toggle('is-active', b === btn);
    });
    if (tab !== 'logic') {
      var next = tab === 'compare' ? 'compare' : (tab === 'city' ? 'city' : 'dashboard');
      if (next !== state.view) {
        state.viewState[state.view] = { activePeriod: state.activePeriod, customRange: state.customRange, customOpen: state.customOpen, selectedStores: state.selectedStores, totalsData: state.totalsData, totalsFailed: state.totalsFailed };
        var f = state.viewState[next];
        state.activePeriod = f.activePeriod; state.customRange = f.customRange; state.customOpen = f.customOpen; state.selectedStores = f.selectedStores;
        state.totalsData = f.totalsData; state.totalsFailed = f.totalsFailed;
        state.storeMultiSelectOpen = false;
        state.view = next;
      }
      if (state.data) renderControls();
      renderContent();
    }
    els.dashboardTab.hidden = tab === 'logic';
    els.logicTab.hidden = tab !== 'logic';
  });

  // --- Orders pop-up -------------------------------------------------------
  // Clicking an Orders number opens the bill list in a pop-up over the dashboard
  // (the same page as store-orders.html, shown in embed mode). Ctrl/Cmd/Shift or
  // middle click still opens the full page in a new tab.
  var ordersModal = null;
  function closeOrdersModal() {
    if (!ordersModal) return;
    ordersModal.remove();
    ordersModal = null;
    document.body.classList.remove('sp-modal-open');
    document.removeEventListener('keydown', onModalKey);
  }
  function onModalKey(e) { if (e.key === 'Escape') closeOrdersModal(); }
  function openOrdersModal(href, title) {
    closeOrdersModal();
    var sep = href.indexOf('?') === -1 ? '?' : '&';
    var wrap = document.createElement('div');
    wrap.className = 'sp-modal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', title || 'Order details');
    wrap.innerHTML =
      '<div class="sp-modal-card">' +
        '<div class="sp-modal-bar">' +
          '<span class="sp-modal-title">' + escapeHtml(title || 'Order details') + '</span>' +
          '<a class="sp-modal-full" href="' + escapeHtml(href) + '" target="_blank" rel="noopener">Open full page &#8599;</a>' +
          '<button type="button" class="sp-modal-x" aria-label="Close">&times;</button>' +
        '</div>' +
        '<iframe class="sp-modal-frame" title="Order details" src="' + escapeHtml(href + sep + 'embed=1') + '"></iframe>' +
      '</div>';
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap || e.target.closest('.sp-modal-x')) closeOrdersModal();
    });
    (document.querySelector('.sp-root') || document.body).appendChild(wrap);
    document.body.classList.add('sp-modal-open');
    document.addEventListener('keydown', onModalKey);
    ordersModal = wrap;
    var x = wrap.querySelector('.sp-modal-x');
    if (x) x.focus();
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a.sp-drill') : null;
    if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // let the browser open a new tab
    e.preventDefault();
    var row = a.closest('tr');
    var storeName = row && row.querySelector('.sp-pivot-store') ? row.querySelector('.sp-pivot-store').textContent : '';
    var periodSrc = (state.view === 'compare' && state.totalsData) ? state.totalsData : state.data;
    var period = periodSrc && periodSrc.periods ? periodSrc.periods[state.activePeriod] : null;
    openOrdersModal(a.getAttribute('href'), 'Orders' + (storeName ? ' \u2014 ' + storeName : '') + (period ? ' \u00B7 ' + period.label : ''));
  });

  load(false);
})();
