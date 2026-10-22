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
    sort: { col: 'section', dir: 1 },
  };

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
  function fmtByFormat(fmt, n) {
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
    var sums = { yesterday: 0, lastWeek: 0, lastMonth: 0 };
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
      if (def.key === 'costPerSession' || def.key === 'costPerDeal' || def.key === 'costPerAppointment') return; // after the loop
      metrics[def.key] = sumMetric(selected, def.key, GA4_METRIC_KEYS.indexOf(def.key) !== -1);
    });
    metrics.costPerSession = ratioMetricClient(metrics.spend, metrics.citySessions);
    metrics.costPerDeal = ratioMetricClient(metrics.spend, metrics.deals);
    metrics.costPerAppointment = ratioMetricClient(metrics.spend, metrics.meetingsRaised);
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

    var p = d.periods;
    els.periodToggle.innerHTML = PERIOD_KEYS.map(function (k) {
      var active = state.activePeriod === k;
      return '<button type="button" class="sp-segmented-btn' + (active ? ' is-active' : '') +
        '" data-period="' + k + '" role="tab" aria-selected="' + active + '">' + p[k].label + '</button>';
    }).join('');
    Array.prototype.forEach.call(els.periodToggle.querySelectorAll('[data-period]'), function (btn) {
      btn.addEventListener('click', function () {
        state.activePeriod = btn.getAttribute('data-period');
        renderControls();
        renderContent();
      });
    });

    els.periodDates.innerHTML = PERIOD_KEYS.map(function (k) {
      return '<div class="sp-period-chip"><span class="sp-period-chip-label">' + p[k].label + '</span>' +
        '<span class="sp-period-chip-range">' + p[k].displayRange + '</span></div>';
    }).join('');
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
      parts.push('<span>' + d.dataFreshness.meetings.unmappedCount + ' meeting(s) in this window could not be matched to a store (free-text Venue field) — excluded from Meetings Raised.</span>');
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
      ? '<span class="sp-badge" title="' + escapeHtml(store.citySharedLabel) + '">Shared city figure</span>' : '';

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
    // Editing only ever shows one input (single-store view), so a full
    // redraw on save is always safe here.
    var input = document.querySelector('.sp-staff-input');
    if (!input) return;
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

  function sortedRows(rows) {
    var col = state.sort.col, dir = state.sort.dir;
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

  function renderTable() {
    var d = state.data;
    if (!d) return '';
    var p = d.periods;
    var store = currentStoreEntry();
    var rows = sortedRows(tableRows());
    var head = '<tr>' +
      '<th data-sort="metric">Metric</th>' +
      '<th data-sort="yesterday">Yesterday<span class="sp-th-sub">' + p.yesterday.displayRange + '</span></th>' +
      '<th data-sort="lastWeek">Last Week<span class="sp-th-sub">' + p.lastWeek.displayRange + '</span></th>' +
      '<th data-sort="lastMonth">Last Month<span class="sp-th-sub">' + p.lastMonth.displayRange + '</span></th>' +
      '</tr>';
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
          '<td data-label="Yesterday" colspan="3">' + cell + '</td>' +
          '</tr>';
      }
      if (def.pending) {
        return '<tr class="sp-row-pending">' +
          '<td data-label="Metric">' + def.label + '</td>' +
          '<td data-label="Yesterday" colspan="3" class="sp-pending-cell">Logic / Data Source Pending</td>' +
          '</tr>';
      }
      if (m && m.unavailable) {
        return '<tr class="sp-row-pending">' +
          '<td data-label="Metric">' + def.label + '</td>' +
          '<td data-label="Yesterday" colspan="3" class="sp-pending-cell">Data unavailable</td>' +
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
        '</tr>';
    }).join('');
    return (
      '<section class="sp-section">' +
        '<div class="sp-section-head">' +
          '<h2 class="sp-section-title">Full Metric Comparison</h2>' +
          '<p class="sp-section-desc">All 25 tracked metrics, every store. Click a column header to sort.</p>' +
        '</div>' +
        '<div class="table-wrap">' +
          '<table class="report-table sp-stack" id="fullTable">' +
            '<thead>' + head + '</thead>' +
            '<tbody>' + body + '</tbody>' +
          '</table>' +
        '</div>' +
        '<button class="export-btn" data-export-table="fullTable" data-export-filename="' + exportFilenameForSelection() + '-metrics">&#8595; Export CSV</button>' +
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
        else state.sort = { col: col, dir: 1 };
        renderContent();
      });
    });
  }

  function bindExportButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-export-table]'), function (btn) {
      btn.onclick = function () {
        var table = document.getElementById(btn.getAttribute('data-export-table'));
        if (!table) return;
        var rows = Array.prototype.map.call(table.querySelectorAll('tr'), function (tr) {
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
    var store = currentStoreEntry();
    if (!store) {
      els.content.innerHTML =
        '<div class="sp-empty">' +
          '<p class="sp-empty-title">No store selected</p>' +
          '<p class="sp-empty-desc">Check at least one store in the Store dropdown to see data.</p>' +
        '</div>';
      return;
    }
    els.content.innerHTML = renderKpiSection() + renderChartsSection() + renderTable();
    bindChartControls();
    bindTableSort();
    bindExportButtons();
    bindStaffCountControls();
  }

  function showSkeleton(show) {
    els.skeleton.hidden = !show;
    els.content.hidden = show;
    els.controlsWrap.hidden = show || !state.data;
  }

  function load(forceRefresh) {
    if (state.loading) return;
    state.loading = true;
    showSkeleton(!state.data);
    setStatus(state.data ? 'Refreshing…' : null);
    els.refreshBtn.disabled = true;

    fetch('/api/store-performance' + (forceRefresh ? '?refresh=true' : ''))
      .then(function (res) {
        if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || ('HTTP ' + res.status)); });
        return res.json();
      })
      .then(function (data) {
        state.data = data;
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
    els.dashboardTab.hidden = tab !== 'dashboard';
    els.logicTab.hidden = tab !== 'logic';
  });

  load(false);
})();
