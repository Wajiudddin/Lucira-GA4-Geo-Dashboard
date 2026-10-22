(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var form = $('#filters');
  var data = null;
  var filtersBuilt = false;
  var startVersion = null, versionChanged = false;   // version of the dashboard this page was loaded with

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var nf = new Intl.NumberFormat('en-IN');
  function num(n) { return n == null ? '—' : nf.format(n); }
  function pctText(n) { return n == null ? '—' : n.toFixed(1) + '%'; }
  var dtf = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  var df = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  function dt(ms) { return ms ? dtf.format(new Date(ms)) : '—'; }
  function dOnly(ms) { return ms ? df.format(new Date(ms)) : '—'; }

  var VISIT_LABEL = { show: 'Show', no_show: 'No show', upcoming: 'Upcoming', pending: 'Today / pending', unverifiable: 'Unverifiable' };
  var CONV_LABEL = { converted: 'Converted', not_converted: 'Not converted', 'n/a': 'n/a' };
  var CAT_LABEL = { store_city: 'Store City', non_city: 'Non-City', unknown: 'Unknown' };
  var SRC_LABEL = { crm: 'Zoho field', walkin: 'Walk-in match', walkin_inferred: 'No walk-in found', sales: 'Store sale match', sales_inferred: 'No sale found' };

  // ---- filters ----------------------------------------------------------
  function readFilters() {
    var f = {};
    new FormData(form).forEach(function (v, k) { if (v) f[k] = v; });
    return f;
  }
  // One date range drives every date-based filter the API has: deal created,
  // meeting raised date (and the scheduled period). "Scheduled This Week" always stays the current week.
  function qs(extra) {
    var f = Object.assign(readFilters(), extra || {});
    ['From', 'To'].forEach(function (s) {
      if (f['date' + s]) { f['deal' + s] = f['raised' + s] = f['period' + s] = f['date' + s]; delete f['date' + s]; }
    });
    return Object.keys(f).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(f[k]); }).join('&');
  }
  // ---- checkbox multi-selects (replace the plain <select> filters) ----------
  // Each filter becomes a button + checkbox panel; the chosen values live in a hidden input as a
  // comma-separated list, which is what the API expects (e.g. agent=A,B,C). Nothing ticked = All.
  var MS = {};
  function initMultiselects() {
    form.querySelectorAll('select').forEach(function (sel) {
      var name = sel.name, lab = sel.closest('label'), title = lab.firstChild.textContent.trim();
      var wrap = document.createElement('div');
      wrap.className = 'sm-f';
      wrap.innerHTML = '<span class="sm-fl">' + esc(title) + '</span><div class="sm-ms"><button type="button" class="sm-ms-btn" aria-haspopup="true" aria-expanded="false"></button><div class="sm-ms-panel" hidden></div><input type="hidden" name="' + name + '"></div>';
      lab.replaceWith(wrap);
      var box = wrap.querySelector('.sm-ms');
      var st = MS[name] = { name: name, title: title, allLabel: 'All', options: [], selected: new Set(), box: box, btn: box.querySelector('.sm-ms-btn'), panel: box.querySelector('.sm-ms-panel'), input: box.querySelector('input') };
      st.btn.addEventListener('click', function () {
        var open = st.panel.hidden;
        closeAllMs();
        st.panel.hidden = !open;
        st.btn.setAttribute('aria-expanded', String(open));
      });
      st.panel.addEventListener('change', function (e) {
        var cb = e.target;
        if (!cb.matches('input[type=checkbox]')) return;
        if (cb.checked) st.selected.add(cb.value); else st.selected.delete(cb.value);
        msSync(name, true);
      });
      st.panel.addEventListener('click', function (e) {
        if (e.target.getAttribute('data-act') === 'clear') { st.selected.clear(); msSync(name); }
      });
      st.panel.addEventListener('input', function (e) {
        if (!e.target.matches('.sm-ms-search')) return;
        var n = e.target.value.toLowerCase();
        st.panel.querySelectorAll('.sm-ms-opt').forEach(function (o) { o.hidden = o.textContent.toLowerCase().indexOf(n) < 0; });
      });
      msSync(name);
    });
  }
  function closeAllMs() {
    Object.keys(MS).forEach(function (k) { MS[k].panel.hidden = true; MS[k].btn.setAttribute('aria-expanded', 'false'); });
  }
  function msLabel(name, v) {
    var o = MS[name].options.filter(function (x) { return x.v === v; })[0];
    return o ? o.l : v;
  }
  function msSync(name, keepPanel) {
    var st = MS[name], vals = Array.from(st.selected);
    st.input.value = vals.join(',');
    st.btn.textContent = !vals.length ? st.allLabel : vals.length === 1 ? msLabel(name, vals[0]) : vals.length + ' selected';
    st.btn.classList.toggle('is-set', vals.length > 0);
    st.panel.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = st.selected.has(cb.value); });
  }
  function fillSelect(name, options, allLabel) {
    var st = MS[name];
    st.options = options;
    st.allLabel = allLabel;
    // drop selections that no longer exist
    Array.from(st.selected).forEach(function (v) { if (!options.some(function (o) { return o.v === v; })) st.selected.delete(v); });
    st.panel.innerHTML =
      (options.length > 8 ? '<input type="search" class="sm-ms-search" placeholder="Search…" aria-label="Search ' + esc(st.title) + '">' : '') +
      '<button type="button" class="sm-ms-clear" data-act="clear">Clear (show all)</button>' +
      options.map(function (o) { return '<label class="sm-ms-opt"><input type="checkbox" value="' + esc(o.v) + '"> <span>' + esc(o.l) + '</span></label>'; }).join('');
    msSync(name);
  }
  document.addEventListener('click', function (e) { if (!e.target.closest('.sm-ms')) closeAllMs(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAllMs(); });

  function fillFilterOptions(o) {
    fillSelect('market', o.markets.map(function (m) { return { v: m, l: m }; }), 'All cities');
    fillSelect('store', o.stores.map(function (s) { return { v: s.key, l: s.label }; }), 'All stores');
    fillSelect('agent', o.agents.map(function (a) { return { v: a, l: a }; }), 'All agents');
    fillSelect('meetingStatus', o.meetingStatuses.map(function (s) { return { v: s, l: s }; }), 'All statuses');
    fillSelect('visit', o.visits.map(function (v) { return { v: v, l: VISIT_LABEL[v] }; }), 'All outcomes');
    fillSelect('conversion', o.conversions.map(function (v) { return { v: v, l: CONV_LABEL[v] }; }), 'All');
  }
  function renderChips() {
    var f = readFilters(), box = $('#chips'), keys = Object.keys(f);
    box.hidden = !keys.length;
    box.innerHTML = keys.map(function (k) {
      var el = form.elements[k], label, name;
      if (MS[k]) { name = MS[k].title; label = Array.from(MS[k].selected).map(function (v) { return msLabel(k, v); }).join(', '); }
      else { label = f[k]; name = el.getAttribute('aria-label') || k; }
      return '<span class="sm-chip">' + esc(name + ': ' + label) + '<button type="button" data-clear="' + esc(k) + '" aria-label="Clear ' + esc(name) + '">×</button></span>';
    }).join('');
  }
  function setFilter(name, value) {
    if (MS[name]) { MS[name].selected = new Set(value ? [value] : []); msSync(name); }
    else form.elements[name].value = value;
    load(false);
  }

  initMultiselects();

  // Name of the selected Date period, used on the Scheduled / Shows / Converted / rate cards and their lists.
  function periodLabel() {
    var map = { today: 'Today', yesterday: 'Yesterday', lastWeek: 'Last Week', lastMonth: 'Last Month' };
    if (map[presetActive]) return map[presetActive];
    var s = data && data.kpis && data.kpis.sched;
    if (s && s.from) { var short = function (k) { return new Date(k + 'T12:00:00+05:30').toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }); };
      return s.from === s.to ? short(s.from) : short(s.from) + ' → ' + short(s.to); }
    return 'All Dates';
  }

  // ---- date presets (IST calendar days) -------------------------------------
  var presetActive = '';
  function istToday() { return new Date(Date.now() + 5.5 * 3600e3); }          // UTC fields = IST fields
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function shift(d, n) { return new Date(d.getTime() + n * 86400000); }
  function presetRange(p) {
    var t = istToday(), y = t.getUTCFullYear(), m = t.getUTCMonth();
    if (p === 'today') return [ymd(t), ymd(t)];
    if (p === 'yesterday') return [ymd(shift(t, -1)), ymd(shift(t, -1))];
    if (p === 'lastWeek') { var mon = shift(t, -((t.getUTCDay() + 6) % 7) - 7); return [ymd(mon), ymd(shift(mon, 6))]; } // previous Mon–Sun
    if (p === 'lastMonth') return [ymd(new Date(Date.UTC(y, m - 1, 1))), ymd(new Date(Date.UTC(y, m, 0)))];
    return null;
  }
  function setPreset(p) {
    presetActive = p === presetActive ? '' : p;          // click the active one again to clear
    var custom = presetActive === 'custom', r = presetRange(presetActive);
    $('#customDates').hidden = !custom;
    if (r) { form.elements.dateFrom.value = r[0]; form.elements.dateTo.value = r[1]; }
    else if (!custom) { form.elements.dateFrom.value = ''; form.elements.dateTo.value = ''; }
    document.querySelectorAll('#datePresets .option-btn').forEach(function (b) { b.classList.toggle('is-active', b.dataset.preset === presetActive); });
    if (!custom) load(false);                            // custom waits for Apply
  }

  // ---- loading ----------------------------------------------------------
  function showStatus(msg) {
    var b = $('#statusBar');
    b.hidden = !msg; b.textContent = msg || '';
  }
  async function load(refresh) {
    renderChips();
    showStatus('');
    var first = !data;
    $('#loading').hidden = !first && !refresh;
    if (first || refresh) {
      $('#loadingText').textContent = first
        ? 'Building the dataset from live Zoho + BigQuery. The first load takes about 2 minutes…'
        : 'Refreshing from live sources (about 2 minutes)…';
    }
    if (first) $('#content').hidden = true;
    try {
      var url = '/api/store-meeting-analytics?' + qs({ refresh: refresh ? 'true' : '', weekFrom: weekState.from, weekTo: weekState.to });
      var res = await fetch(url);
      var body = await res.json();
      if (!res.ok) throw new Error(body.detail || body.error || ('HTTP ' + res.status));
      data = body;
      if (!startVersion) startVersion = body.version || null;
      else if (body.version && body.version !== startVersion) versionChanged = true;
      if (!filtersBuilt) { fillFilterOptions(data.filterOptions); filtersBuilt = true; }
      render();
    } catch (err) {
      showStatus('Could not load data: ' + err.message + (data ? ' — showing the last successful data.' : ''));
    } finally {
      $('#loading').hidden = true;
      if (data) $('#content').hidden = false;
    }
  }

  // ---- render -----------------------------------------------------------
  function render() {
    $('#updatedAt').textContent = 'Last refreshed: ' + dt(new Date(data.generatedAt).getTime()) + (data.refreshing ? ' (refreshing…)' : '') + (data.callsLiveAt ? ' · Calls live as of ' + new Date(data.callsLiveAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '') + (data.version ? ' · version ' + data.version : '');
    renderNotice();
    renderKpis();
    renderCharts();
    renderWeekTable();
    renderPerformance();
    renderMeetingDump();
    renderLogic();
  }

  function renderNotice() {
    var m = data.meta, notes = [];
    if (m.meetingsSource === 'bigquery_cdc') notes.push('Meetings are read from the BigQuery Zoho sync (cdc_meetings) because the configured Zoho token lacks the Events scope (ZohoCRM.modules.events.READ).');
    var cm = m.callsMeta;
    if (cm && cm.bigqueryLastCallMs) notes.push('Follow-up calls come from the BigQuery table lucira_zoho_Calls (rebuilt nightly, latest call ' + dt(cm.bigqueryLastCallMs) + '). Calls made after that are added live from Zoho (' + num(cm.liveTopUpAdded) + ' for these meetings).');
    if (data.lastError) notes.push('Last background refresh failed: ' + data.lastError);
    if (versionChanged) notes.unshift('A newer version of this dashboard has been published. Press Ctrl+F5 to reload the page so you see the latest columns and fixes.');
    var n = $('#notice');
    n.hidden = !notes.length;
    n.innerHTML = notes.map(esc).join('<br>');
  }

  // "Aug 50 · Sep 60": how many of these meetings were RAISED in each month (India time), oldest month first.
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function raisedByMonthText(list) {
    var counts = {}, unknown = 0;
    (list || []).forEach(function (m) {
      if (!m.raisedMs) { unknown += 1; return; }
      var d = new Date(m.raisedMs + 5.5 * 3600e3), k = d.getUTCFullYear() * 100 + d.getUTCMonth();
      counts[k] = (counts[k] || 0) + 1;
    });
    var keys = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
    var years = {}; keys.forEach(function (k) { years[Math.floor(k / 100)] = true; });
    var showYear = Object.keys(years).length > 1;                       // add the year only when the months span years
    var parts = keys.map(function (k) { return MONTH_NAMES[k % 100] + (showYear ? ' ' + Math.floor(k / 100) : '') + ' ' + num(counts[k]); });
    if (unknown) parts.push('Unknown ' + num(unknown));
    return parts.join(' · ');
  }
  function kpiCard(label, value, tip, sub) {
    return '<div class="kpi-card" title="' + esc(tip) + '"><div class="kpi-label">' + esc(label) + '</div><div class="kpi-value">' + value + '</div>' + (sub ? '<span class="kpi-sub">' + esc(sub).replace(/\n/g, '<br>') + '</span>' : '') + '</div>';
  }
  function renderKpis() {
    var k = data.kpis, w = data.week, t = k.sched, pl = periodLabel();
    var dpct = function (n) { return k.totalDeals ? (n / k.totalDeals * 100).toFixed(1) + '% of deals' : ''; };
    $('#kpiGrid').innerHTML = [
      kpiCard('Total Deals', num(k.totalDeals), 'Unique Zoho deals matching the Deal-created, owner and city filters.'),
      kpiCard('Store City Deals', num(k.storeCityDeals), 'Deals in Bangalore, Mumbai/Thane, Delhi, Noida/Greater Noida or Pune.', dpct(k.storeCityDeals)),
      kpiCard('Non-City Deals', num(k.nonCityDeals), 'Deals with a known city outside the five store markets. Blank city is NOT counted here.', dpct(k.nonCityDeals) + (k.unknownDeals ? ' · ' + num(k.unknownDeals) + ' unknown (no city)' : '')),
      kpiCard('Unknown / Unmapped Deals', num((k.unknownDeals || 0) + (k.unmappedDeals || 0)), 'Unknown = the deal has no city in Zoho. Unmapped = a store-city deal that could not be given a store (for example Delhi with no zone). Both are counted together.', dpct((k.unknownDeals || 0) + (k.unmappedDeals || 0)) + ' · ' + num(k.unknownDeals || 0) + ' unknown · ' + num(k.unmappedDeals || 0) + ' unmapped'),
      kpiCard('Meetings Raised', num(k.meetingsRaised), 'Unique Zoho meetings (Events) created in the selected range.'),
      kpiCard('Scheduled ' + pl, num(t.meetings), 'Meetings whose From (scheduled) date is in the selected Date period (' + pl + '), India time. The store, agent and other filters still apply. The line under the number shows in which month these meetings were raised.', (t.upcoming ? num(t.upcoming) + ' still to come · ' + num(t.passed) + ' time passed' : 'all time passed') + (t.meetings ? '\nRaised in: ' + raisedByMonthText(data.schedMeetings) : '')),
      kpiCard('Customer Shows', num(t.showCustomers), 'Unique customers who visited the store ' + pl + ' (counted on the day they came, even if the meeting was scheduled for another day). The line under the number shows in which month these Show meetings were raised.', num(t.showMeetings) + ' show meetings · ' + num(t.meetings) + ' scheduled ' + pl + (t.showMeetings ? '\nRaised in: ' + raisedByMonthText(data.visitedMeetings || []) : '')),
      kpiCard('Converted Customers', num(t.convertedCustomers), 'Unique customers who visited and bought ' + pl + ' (counted on the day of the sale, or the visit day when the conversion is only marked in Zoho). Orders matched in sales data: ' + num(t.convertedOrders), num(t.convertedOrders) + ' orders matched · visited/bought ' + pl),
      kpiCard('Follow-up Calls', num(t.followUpCalls), 'All calls dialed to the customers of the meetings scheduled ' + pl + ': the Follow-up Calls (from the exact raised time to the end of the scheduled date) PLUS the Calls after the scheduled date. Every dialed call counts, whether or not the customer picked up. It does not depend on any date filter.', num(t.followUpOnly) + ' follow-up + ' + num(t.afterOnly) + ' after scheduled date · ' + num(t.meetingsWithFollowUp) + ' meetings called · ' + num(t.meetingsZeroFollowUp) + ' not called'),
      kpiCard('Total Calls Done', num(k.allCalls.count), 'Every outbound call dialed in the selected Date period (' + pl + '), to any customer or deal, whether or not it was picked up. It is NOT limited to meetings.', num(k.allCalls.connected) + ' connected (30 s+) · ' + num(k.allCalls.count - k.allCalls.connected) + ' not connected'),
      kpiCard('Total Talk Time', hms(k.allCalls.seconds), 'Total duration (hh:mm:ss) of all outbound calls dialed in the selected Date period (' + pl + '). Calls that were not picked up add 0.', k.allCalls.count ? 'avg ' + hms(Math.round(k.allCalls.seconds / k.allCalls.count)) + ' per call' : ''),
      kpiCard('Show Rate', pctText(t.showRate), 'Show meetings (counted on the visit day) ÷ meetings scheduled ' + pl + ' = ' + t.showMeetings + ' ÷ ' + t.meetings, t.showMeetings + ' ÷ ' + t.meetings + ' scheduled ' + pl),
      kpiCard('Conversion Rate', pctText(t.conversionRate), 'Customers converted ÷ customers who visited, both counted on the day of the visit/sale ' + pl + ' = ' + t.convertedCustomers + ' ÷ ' + t.showCustomers, t.convertedCustomers + ' ÷ ' + t.showCustomers + ' (scheduled ' + pl + ')'),
    ].map(function (html, i) {
      if (!KPI_KEYS[i]) return html;
      return html.replace('<div class="kpi-card"', '<div class="kpi-card kpi-card--clickable" role="button" tabindex="0" data-kpi="' + KPI_KEYS[i] + '"');
    }).join('');
  }

  // ---- charts -----------------------------------------------------------
  function card(title, info, body) {
    return '<div class="chart-card"><div class="chart-card-header"><h3 class="chart-title">' + esc(title) + '</h3></div><div class="sm-chart-body" title="' + esc(info) + '">' + body + '</div></div>';
  }
  function hbars(rows, series, filterName) {
    if (!rows.length) return '<div class="sm-empty">No data for the selected filters</div>';
    var max = Math.max.apply(null, rows.map(function (r) { return Math.max.apply(null, series.map(function (s) { return r[s.k] || 0; })); })) || 1;
    var single = series.length === 1;
    return rows.map(function (r) {
      var bars = series.map(function (s) { return '<div class="sm-bar ' + s.c + (single ? ' single' : '') + '" style="width:' + ((r[s.k] || 0) / max * 100) + '%"></div>'; }).join('');
      var vals = series.map(function (s) { return num(r[s.k] || 0); }).join(' / ');
      var tip = r.label + ': ' + series.map(function (s) { return s.l + ' ' + num(r[s.k] || 0); }).join(', ');
      return '<div class="sm-bar-row' + (filterName ? ' clickable' : '') + '"' + (filterName ? ' data-filter="' + filterName + '" data-value="' + esc(r.key == null ? r.label : r.key) + '"' : '') + ' title="' + esc(tip) + '"><span class="lbl">' + esc(r.label) + '</span><div class="sm-bar-track">' + bars + '</div><span class="val">' + vals + '</span></div>';
    }).join('') + (single ? '' : '<div class="sm-legend">' + series.map(function (s) { return '<span><i class="' + s.c + '"></i>' + esc(s.l) + '</span>'; }).join('') + '</div>');
  }
  function donut(rows) {
    var total = rows.reduce(function (s, r) { return s + r.value; }, 0);
    if (!total) return '<div class="sm-empty">No deals for the selected filters</div>';
    var colors = ['var(--accent)', '#d4af37', 'var(--text-muted)'], a0 = -Math.PI / 2, paths = '';
    rows.forEach(function (r, i) {
      if (!r.value) return;
      var a1 = a0 + (r.value / total) * Math.PI * 2 - 0.0001, big = a1 - a0 > Math.PI ? 1 : 0;
      var p = function (a, rad) { return (60 + rad * Math.cos(a)).toFixed(2) + ' ' + (60 + rad * Math.sin(a)).toFixed(2); };
      paths += '<path fill="' + colors[i] + '" d="M ' + p(a0, 52) + ' A 52 52 0 ' + big + ' 1 ' + p(a1, 52) + ' L ' + p(a1, 32) + ' A 32 32 0 ' + big + ' 0 ' + p(a0, 32) + ' Z"><title>' + esc(r.label + ': ' + num(r.value) + ' (' + (r.value / total * 100).toFixed(1) + '%)') + '</title></path>';
      a0 = a1 + 0.0001;
    });
    return '<div class="sm-donut-wrap"><svg viewBox="0 0 120 120" width="150" height="150" role="img" aria-label="Store city vs non-city deals">' + paths + '<text x="60" y="64" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">' + num(total) + '</text></svg><div class="sm-legend" style="flex-direction:column;gap:6px">' +
      rows.map(function (r, i) { return '<span><i style="background:' + colors[i] + '"></i>' + esc(r.label) + ' — ' + num(r.value) + ' (' + (r.value / total * 100).toFixed(1) + '%)</span>'; }).join('') + '</div></div>';
  }
  // Number of calls a meeting got = Follow-up Calls + Calls after scheduled date.
  var CALL_BUCKET_MAX = 6;                                          // the last bar is "6 or more"
  function meetingCallTotal(m) { return (m.followUp.total || 0) + (m.followUp.after || 0); }
  function callBucketKey(m) { return Math.min(meetingCallTotal(m), CALL_BUCKET_MAX); }
  function callBucketLabel(k) { return k >= CALL_BUCKET_MAX ? CALL_BUCKET_MAX + ' or more calls' : k + (k === 1 ? ' call' : ' calls'); }
  function callBucketRows() {
    var counts = [];
    for (var k = 0; k <= CALL_BUCKET_MAX; k++) counts.push(0);
    (data.schedMeetings || []).forEach(function (m) { counts[callBucketKey(m)] += 1; });
    return counts.map(function (n, k) { return { key: String(k), label: callBucketLabel(k), meetings: n }; })
      .filter(function (r) { return Number(r.key) < 5 || r.meetings > 0; });   // 0-4 calls always shown; 5 and 6+ only when there are meetings
  }
  // Click a bar: list the meetings that got that many calls.
  // Scheduled meetings of the Date period, grouped by store.
  function schedStoreRows() {
    var by = {};
    (data.schedMeetings || []).forEach(function (m) { var k = m.storeKey || 'unmapped'; if (!by[k]) by[k] = { key: k, label: m.store || 'Unmapped', meetings: 0 }; by[k].meetings += 1; });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.meetings - a.meetings; });
  }
  function openSchedStore(key) {
    var pl = periodLabel(), rows = (data.schedMeetings || []).filter(function (m) { return (m.storeKey || 'unmapped') === key; });
    openRowList('Scheduled ' + pl + ' — ' + (rows[0] && rows[0].store ? rows[0].store : 'Unmapped'), rows.length + ' meetings scheduled ' + pl + ' for this store.',
      rows, meetingCols(), { name: 'scheduled-' + key, sort: 'fromMs', dir: 1, pageSize: 15, empty: 'No meetings.' }, 'store', 'agent');
  }
  function openCallsBucket(keyStr) {
    var k = Number(keyStr), pl = periodLabel();
    var rows = (data.schedMeetings || []).filter(function (m) { return callBucketKey(m) === k; });
    openRowList('Meetings with ' + callBucketLabel(k) + ' — Scheduled ' + pl,
      'Scheduled meetings (' + pl + ') that got ' + callBucketLabel(k) + ' in total (Follow-up Calls + Calls after scheduled date).',
      rows, meetingCols(), { name: 'meetings-with-' + k + '-calls', sort: 'fromMs', dir: 1, pageSize: 15, empty: 'No meetings in this group.' }, 'store', 'agent');
  }

  // Scheduled meetings connected / not connected (the Date period, like the Follow-up Calls card). A meeting's calls are
  // its Follow-up Calls + Calls after scheduled date. CONNECTED = at least one of them lasted CONNECTED_SECONDS or more;
  // NOT CONNECTED = it was called, but no call got that long; NO CALL MADE = no call at all (the same meetings as the
  // "0 calls" bar of the chart above).
  var CONNECTED_SECONDS = 30;
  function meetingGroups() {
    var meetings = data.schedMeetings || [], calls = data.schedCalls || [], n = {}, best = {};
    meetings.forEach(function (m) { n[m.id] = 0; best[m.id] = 0; });
    calls.forEach(function (c) {
      if (!(c.meetingId in n)) return;
      n[c.meetingId] += 1;
      best[c.meetingId] = Math.max(best[c.meetingId], c.durationSec || 0);
    });
    var groups = { connected: [], not: [], none: [] };
    meetings.forEach(function (m) { (best[m.id] >= CONNECTED_SECONDS ? groups.connected : n[m.id] ? groups.not : groups.none).push(m); });
    return groups;
  }
  var CONN_LABEL = { connected: 'Connected', not: 'Not connected', none: 'No call made' };
  function connectionRows() {
    var g = meetingGroups();
    return ['connected', 'not', 'none'].map(function (key) { return { key: key, label: CONN_LABEL[key], meetings: g[key].length }; });
  }
  // Click a bar: list the meetings in that group.
  function openConnBucket(key) {
    var rows = meetingGroups()[key], pl = periodLabel();
    var rule = { connected: 'at least one call of ' + CONNECTED_SECONDS + ' seconds or more',
      not: 'called, but no call reached ' + CONNECTED_SECONDS + ' seconds', none: 'no call was made' }[key];
    openRowList('Meetings — ' + CONN_LABEL[key] + ' — Scheduled ' + pl,
      num(rows.length) + ' scheduled meetings (' + rule + ').',
      rows, meetingCols(), { name: 'meetings-' + key, sort: 'fromMs', dir: 1, pageSize: 15, empty: 'No meetings in this group.' }, 'store', 'agent');
  }

  function renderCharts() {
    var c = data.charts;
    var funnelMax = c.funnel[0].value || 1;
    var funnel = '<div class="sm-funnel">' + c.funnel.map(function (f, i) {
      var p = i ? (c.funnel[i - 1].value ? ' · ' + (f.value / c.funnel[i - 1].value * 100).toFixed(1) + '% of previous' : '') : '';
      return '<div class="sm-bar-row" title="' + esc(f.label + ': ' + f.value + p) + '"><span class="lbl">' + esc(f.label) + '</span><div class="sm-bar-track"><div class="sm-bar sm-c' + (i + 1) + '" style="width:' + (f.value / funnelMax * 100) + '%"></div></div><span class="val">' + num(f.value) + '</span></div>';
    }).join('') + '</div>';
    // Scheduled meetings (the Date period, like the Follow-up Calls card) grouped by how many calls each got:
    // Follow-up Calls (raised → end of scheduled day) + Calls after scheduled date.
    var callRows = callBucketRows();
    var callsChartTotal = (data.schedMeetings || []).length;
    var connRows = connectionRows();
    var connTotal = connRows.reduce(function (s, r) { return s + r.meetings; }, 0);
    $('#chartsGrid').innerHTML = [
      card('Store City vs Non-City Deals', 'Share of deals in the five store cities, in other known cities, and with no city recorded.', donut(c.dealCategory)),
      card('Meeting Funnel', 'Raised → Show → Converted customers.', funnel),
      card('Meetings Raised by Store', 'Click a store to filter.', hbars(c.byStore, [{ k: 'raised', l: 'Raised', c: 'sm-c1' }], 'store')),
      card('Scheduled Meetings by Store — ' + periodLabel() + ' (' + num((data.schedMeetings || []).length) + ' meetings)', 'Meetings whose scheduled date is in the selected Date period, per store. Click a store to list its meetings.', hbars(schedStoreRows(), [{ k: 'meetings', l: 'Scheduled', c: 'sm-c1' }], 'schedStore')),
      card('Scheduled Meetings by Number of Calls — ' + periodLabel() + ' (' + num(callsChartTotal) + ' meetings)', 'How many scheduled meetings got 0, 1, 2, 3 ... calls. Each meeting counts Follow-up Calls (raised → end of scheduled day) + Calls after scheduled date. Click a bar to list those meetings.', callsChartTotal ? hbars(callRows, [{ k: 'meetings', l: 'Meetings', c: 'sm-c1' }], 'callsBucket') : '<div class="sm-empty">No scheduled meetings in this period</div>'),
      card('Scheduled Meetings — Connected vs Not Connected — ' + periodLabel() + ' (' + num(connTotal) + ' meetings)', 'The meetings scheduled in this period, using each meeting\'s own calls: Follow-up Calls (raised → end of scheduled day) + Calls after scheduled date. Connected = at least one of its calls lasted ' + CONNECTED_SECONDS + ' seconds or more. Not connected = called, but no call reached ' + CONNECTED_SECONDS + ' seconds (including calls that were not picked up). No call made = no call at all (same as the 0 calls bar above). Click a bar to list the meetings.', connTotal ? hbars(connRows, [{ k: 'meetings', l: 'Meetings', c: 'sm-c3' }], 'connBucket') : '<div class="sm-empty">No scheduled meetings in this period</div>'),
    ].join('');
  }

  // ---- "Deals Scheduled" table: its own date filter (scheduled / From date) ----
  // The Scheduled Meetings section opens on Yesterday (its own period buttons can change it).
  function weekDefaultState() { var r = presetRange('yesterday'); return { preset: 'yesterday', from: r[0], to: r[1] }; }
  var weekState = weekDefaultState();
  var WEEK_LABEL = { thisWeek: 'This Week', today: 'Today', yesterday: 'Yesterday', lastWeek: 'Last Week', lastMonth: 'Last Month', custom: 'Custom' };
  var dayFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  function weekdayOf(dateKey) { return dayFmt.format(new Date(dateKey + 'T12:00:00+05:30')); }
  function syncWeekUI() {
    document.querySelectorAll('#weekPresets .option-btn').forEach(function (b) { b.classList.toggle('is-active', b.dataset.wp === weekState.preset); });
    $('#weekCustom').hidden = weekState.preset !== 'custom';
  }
  function setWeekPreset(p) {
    weekState.preset = p;
    if (p === 'thisWeek') { weekState.from = ''; weekState.to = ''; }
    else if (p !== 'custom') { var r = presetRange(p); weekState.from = r[0]; weekState.to = r[1]; }
    syncWeekUI();
    if (p !== 'custom') loadWeekTable();            // custom waits for Apply
  }
  function loadWeekTable() {
    $('#weekStoreTable').innerHTML = '<div class="sm-empty">Loading…</div>';
    $('#weekAgentTable').innerHTML = '';
    fetch('/api/store-meeting-analytics?' + qs({ weekOnly: '1', weekFrom: weekState.from, weekTo: weekState.to }))
      .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.detail || b.error || r.status); return b; }); })
      .then(function (b) { data.weekTable = b.weekTable; data.productView = b.productView; renderWeekTable(); })
      .catch(function (err) { $('#weekStoreTable').innerHTML = '<div class="sm-empty">Could not load: ' + esc(err.message) + '</div>'; });
  }
  // Full list of the meetings scheduled in the period chosen on the Deals Scheduled table.
  function renderWeekDump(w, range) {
    var rows = w.meetings || [];
    var label = w.isCurrentWeek && weekState.preset === 'thisWeek' ? 'This Week' : WEEK_LABEL[weekState.preset];
    $('#weekDumpHeading').textContent = 'Scheduled Meetings — ' + label + ' (' + range + ') — ' + num(rows.length);
    makeTable($('#weekDump'), {
      name: 'scheduled-meetings-' + w.from + (w.to !== w.from ? '-to-' + w.to : ''), sort: 'fromMs', dir: 1, pageSize: 25, rows: rows,
      columns: meetingCols(), empty: 'No meetings are scheduled in this period for the selected filters.',
    });
  }

  function schedColumns(firstLabel) {
    return [
      { k: 'label', label: firstLabel },
      { k: 'meetings', label: 'Scheduled', num: 1, tip: 'Meetings whose scheduled (From) date is in the selected period' },
      { k: 'shows', label: 'Show', num: 1, tip: 'Meetings where the customer visited' },
      { k: 'converted', label: 'Conversion', num: 1, tip: 'Unique customers who visited and bought' },
      { k: 'followUp', label: 'Follow-up Calls (raised → end of scheduled day)', num: 1 },
      { k: 'after', label: 'Calls after scheduled date', num: 1 },
    ];
  }
  function schedFooter(totals) {
    return function () {
      return '<tr class="row-total"><td><b>Total</b></td><td class="num"><b>' + num(totals.meetings) + '</b></td><td class="num">' + num(totals.shows) + '</td><td class="num">' + num(totals.converted) + '</td><td class="num">' + num(totals.followUp) + '</td><td class="num">' + num(totals.after) + '</td></tr>';
    };
  }
  function renderWeekTable() {
    var w = data.weekTable;
    var range = w.from === w.to ? w.from : w.from + ' → ' + w.to;
    var label = w.isCurrentWeek && weekState.preset === 'thisWeek' ? 'This Week' : WEEK_LABEL[weekState.preset];
    $('#weekHeading').textContent = 'Scheduled Meetings — ' + label + ' (' + range + ')';
    renderWeekDump(w, range);
    renderProducts(range, label);
    var empty = 'No meetings are scheduled in this period for the selected filters.';
    $('#weekStoreHeading').textContent = 'Store-wise Schedule — ' + label;
    $('#weekAgentHeading').textContent = 'Agent-wise Schedule — ' + label;
    makeTable($('#weekStoreTable'), { name: 'schedule-by-store', columns: schedColumns('Store'), rows: w.storeRows || [], sort: 'meetings', dir: -1, paginate: false, search: false, empty: empty, footer: schedFooter(w.totals || {}) });
    makeTable($('#weekAgentTable'), { name: 'schedule-by-agent', columns: schedColumns('Agent'), rows: w.agentRows || [], sort: 'meetings', dir: -1, pageSize: 15, empty: empty, footer: schedFooter(w.totals || {}) });
  }

  // ---- Product tables for the scheduled meetings (same period as the Scheduled Meetings section) ----
  var PRODUCT_TABLES = [
    ['category', 'Category-wise'], ['karat', 'Karat-wise'], ['sku', 'SKU-wise'], ['variant', 'Variant-wise'],
    ['priceBand', 'Price band-wise'], ['size', 'Size-wise'], ['style', 'Style-wise'], ['shape', 'Shape-wise'],
  ];
  function stockBadge(st) {
    var cls = st === 'In stock' ? 'badge-good' : st === 'Out of stock' ? 'badge-critical' : st === 'Unknown' ? 'badge-neutral' : 'amber';
    return badge(st, cls);
  }
  function renderProducts(range, label) {
    var host = $('#productSection'), v = data.productView;
    if (!host) return;
    if (!v) { host.innerHTML = '<div class="sm-empty">Product data is not available' + (data.productsError ? ': ' + esc(data.productsError) : '') + '.</div>'; return; }
    var sm = v.summary;
    host.innerHTML =
      '<h2 class="table-heading sm-gap">Products of Scheduled Meetings — ' + esc(label) + ' (' + esc(range) + ')</h2>' +
      '<p class="th-sub sm-hint">The products on the deal of each scheduled meeting (if the deal has none, the product the customer last viewed), with stock at the meeting’s own store. ' +
      num(sm.meetingsWithProducts) + ' of ' + num(sm.meetings) + ' meetings have a product · ' + num(sm.productLines) + ' product lines: ' +
      num(sm.inStock) + ' in stock at the store · ' + num(sm.otherOnly) + ' only at other stores · ' + num(sm.out) + ' out of stock · ' + num(sm.unknown) + ' not matched to the catalogue.</p>' +
      PRODUCT_TABLES.map(function (t) { return '<h3 class="table-heading sm-gap">' + esc(t[1]) + ' meetings — ' + esc(label) + '</h3><div id="prodTbl_' + t[0] + '"></div>'; }).join('') +
      '<h3 class="table-heading sm-gap">Meeting-wise product list (advanced) — ' + esc(label) + ' — ' + num(v.lines.length) + '</h3><div id="prodTbl_lines"></div>';
    PRODUCT_TABLES.forEach(function (t) {
      var first = t[1].replace('-wise', '');
      makeTable($('#prodTbl_' + t[0]), {
        name: 'products-' + t[0], sort: 'products', dir: -1, pageSize: 15, search: false, rows: v.tables[t[0]] || [], empty: 'No products for the meetings in this period.',
        columns: [
          { k: 'label', label: first },
          { k: 'meetings', label: 'Meetings', num: 1 }, { k: 'products', label: 'Products', num: 1, tip: 'Product lines on these meetings (a product on two meetings counts twice)' },
          { k: 'inStock', label: 'In stock at store', num: 1, tip: 'Product lines with at least one piece at the meeting’s own store' },
          { k: 'otherOnly', label: 'Other stores only', num: 1, tip: 'Not at the meeting’s store, but available at another store or Head Office' },
          { k: 'out', label: 'Out of stock', num: 1 }, { k: 'unknown', label: 'Not matched', num: 1, tip: 'The product could not be matched to the catalogue, so its stock is unknown' },
          { k: 'pieces', label: 'Pieces at store', num: 1, tip: 'Pieces in stock at the meeting stores (each store and SKU counted once)' },
          { k: 'availability', label: 'Availability', num: 1, html: function (r) { return r.availability == null ? '—' : r.availability + '%'; }, tip: 'In stock at store ÷ products that could be matched' },
          { k: 'status', label: 'Inventory', html: function (r) { return stockBadge(r.status); } },
        ],
      });
    });
    makeTable($('#prodTbl_lines'), {
      name: 'meeting-products-' + (data.weekTable ? data.weekTable.from : ''), sort: 'fromMs', dir: 1, pageSize: 25, rows: v.lines, empty: 'No products for the meetings in this period.',
      columns: [
        { k: 'customer', label: 'Customer' }, { k: 'mobile', label: 'Mobile', val: function (r) { return r.mobile || ''; } },
        { k: 'store', label: 'Store' }, { k: 'agent', label: 'Agent' },
        { k: 'fromMs', label: 'Scheduled (From)', html: function (r) { return esc(dt(r.fromMs)); }, csv: function (r) { return dt(r.fromMs); } },
        { k: 'productName', label: 'Product' }, { k: 'sku', label: 'SKU', val: function (r) { return r.sku || ''; } }, { k: 'style', label: 'Style', val: function (r) { return r.style || ''; } },
        { k: 'category', label: 'Category', val: function (r) { return r.category || ''; } }, { k: 'karat', label: 'Karat', val: function (r) { return r.karat || ''; } },
        { k: 'variant', label: 'Variant', val: function (r) { return r.variant || ''; } }, { k: 'size', label: 'Size', val: function (r) { return r.size || ''; } },
        { k: 'shape', label: 'Shape', val: function (r) { return r.shape || ''; } }, { k: 'priceBand', label: 'Price band', val: function (r) { return r.priceBand || ''; } },
        { k: 'price', label: 'Price', num: 1, val: function (r) { return r.price || ''; }, html: function (r) { return r.price ? esc(inr(r.price)) : '—'; } },
        { k: 'stockAtStore', label: 'Stock at store', num: 1, val: function (r) { return r.stockAtStore == null ? '' : r.stockAtStore; }, html: function (r) { return r.stockAtStore == null ? '—' : num(r.stockAtStore); } },
        { k: 'stockElsewhere', label: 'Stock at other stores', num: 1, val: function (r) { return r.stockElsewhere == null ? '' : r.stockElsewhere; }, html: function (r) { return r.stockElsewhere == null ? '—' : num(r.stockElsewhere); } },
        { k: 'status', label: 'Inventory', html: function (r) { return stockBadge(r.status); } },
        { k: 'matchedBy', label: 'Matched by' }, { k: 'productSource', label: 'Product from' },
      ],
    });
  }
  function badge(text, cls) { return '<span class="badge ' + (cls || 'badge-neutral') + '">' + esc(text) + '</span>'; }

  // ---- generic table ----------------------------------------------------
  function makeTable(el, opt) {
    var st = { sort: opt.sort || null, dir: opt.dir || -1, page: 0, q: '' };
    var size = opt.pageSize || 15;
    function sortVal(r, col) { return col.val ? col.val(r) : r[col.k]; }
    function view() {
      var rows = opt.rows.slice();
      if (st.q) { var n = st.q.toLowerCase(); rows = rows.filter(function (r) { return opt.columns.some(function (c) { return String(c.val ? c.val(r) : r[c.k] == null ? '' : (c.val ? c.val(r) : r[c.k])).toLowerCase().indexOf(n) >= 0; }); }); }
      if (st.sort) {
        var col = opt.columns.filter(function (c) { return c.k === st.sort; })[0];
        rows.sort(function (a, b) {
          var x = sortVal(a, col), y = sortVal(b, col);
          if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
          return (x < y ? -1 : x > y ? 1 : 0) * st.dir;
        });
      }
      return rows;
    }
    function draw() {
      var rows = view(), pages = Math.max(1, Math.ceil(rows.length / size));
      if (st.page >= pages) st.page = pages - 1;
      var slice = opt.paginate === false ? rows : rows.slice(st.page * size, st.page * size + size);
      var head = opt.columns.map(function (c) {
        return '<th class="' + (c.num ? 'num' : '') + '" data-k="' + c.k + '"' + (c.tip ? ' title="' + esc(c.tip) + '"' : '') + '>' + esc(c.label) + (st.sort === c.k ? (st.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
      }).join('');
      var body = slice.map(function (r, i) {
        var tr = '<tr' + (opt.expand ? ' class="sm-expand-row" data-i="' + i + '"' : '') + '>' + opt.columns.map(function (c) {
          return '<td class="' + (c.num ? 'num' : '') + '">' + (c.html ? c.html(r) : esc(c.val ? c.val(r) : r[c.k] == null ? '—' : r[c.k])) + '</td>';
        }).join('') + '</tr>';
        if (opt.expand && r.__open) tr += opt.expand(r, opt.columns.length);
        return tr;
      }).join('');
      el.innerHTML =
        '<div class="sm-tools">' + (opt.search === false ? '' : '<input class="table-search" type="search" placeholder="Search…" value="' + esc(st.q) + '" aria-label="Search table" />') +
        '<button type="button" class="export-btn" data-csv>Export CSV</button><span class="th-sub">' + num(rows.length) + ' rows</span></div>' +
        (rows.length ? '<div class="table-wrap sm-table-scroll"><table class="report-table sm-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody>' + (opt.footer ? '<tfoot>' + opt.footer(rows) + '</tfoot>' : '') + '</table></div>' : '<div class="sm-empty">' + esc(opt.empty || 'No rows match the selected filters.') + '</div>') +
        (opt.paginate === false || pages < 2 ? '' : '<div class="sm-pager"><button type="button" class="export-btn" data-pg="-1"' + (st.page === 0 ? ' disabled' : '') + '>Prev</button>Page ' + (st.page + 1) + ' / ' + pages + '<button type="button" class="export-btn" data-pg="1"' + (st.page >= pages - 1 ? ' disabled' : '') + '>Next</button></div>');
      var s = el.querySelector('.table-search');
      if (s) s.addEventListener('input', function () { st.q = s.value; st.page = 0; var pos = s.selectionStart; draw(); var n = el.querySelector('.table-search'); n.focus(); n.setSelectionRange(pos, pos); });
      el.querySelectorAll('th[data-k]').forEach(function (th) { th.addEventListener('click', function () { st.dir = st.sort === th.dataset.k ? -st.dir : -1; st.sort = th.dataset.k; draw(); }); });
      el.querySelectorAll('[data-pg]').forEach(function (b) { b.addEventListener('click', function () { st.page += Number(b.dataset.pg); draw(); }); });
      el.querySelector('[data-csv]').addEventListener('click', function () { exportCsv(opt.name, opt.columns, view()); });
      if (opt.expand) el.querySelectorAll('tr.sm-expand-row').forEach(function (tr) { tr.addEventListener('click', function () { var r = slice[Number(tr.dataset.i)]; r.__open = !r.__open; draw(); }); });
    }
    draw();
  }
  function exportCsv(name, columns, rows) {
    var cell = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [columns.map(function (c) { return cell(c.label); }).join(',')].concat(rows.map(function (r) {
      return columns.map(function (c) { return cell(c.csv ? c.csv(r) : c.val ? c.val(r) : r[c.k]); }).join(',');
    }));
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = name + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click(); URL.revokeObjectURL(a.href);
  }

  // ---- performance tables ----------------------------------------------
  function rate(n, d, r) { return '<span class="sm-rate" title="' + n + ' ÷ ' + d + '">' + pctText(r) + '</span>'; }
  function perfColumns(kind) {
    var cols = [{ k: 'label', label: kind === 'agent' ? 'Agent' : 'Store' }];
    if (kind === 'store') cols.push({ k: 'market', label: 'City market' });
    var dealLbl = kind === 'agent' ? 'Deals assigned' : 'Deals';
    cols = cols.concat([
      { k: 'totalDeals', label: dealLbl, num: 1, tip: kind === 'store' ? 'Deals assigned to this store by city / Delhi zone. Mumbai deals are split 50/50 between Borivali and Chembur.' : 'Deals owned by this agent' },
      { k: 'storeCityDeals', label: 'City Deals', num: 1 }, { k: 'nonCityDeals', label: 'Non-City Deals', num: 1 },
      { k: 'meetingsRaised', label: 'Meetings Raised', num: 1 },
      { k: 'scheduledTillDate', label: 'Scheduled Till Date', num: 1, tip: 'Of the meetings raised, how many have their scheduled date today or earlier. Show Rate is calculated on these.' },
      { k: 'showMeetings', label: 'Show', num: 1 },
      { k: 'convertedCustomers', label: 'Conversion', num: 1, tip: 'Unique converted customers' },
      { k: 'scheduledThisWeek', label: 'Scheduled This Week', num: 1 }, { k: 'followUpCalls', label: 'Follow-up Calls (raised → end of scheduled day)', num: 1, tip: 'Calls dialed from the exact time each meeting was raised until the end of its scheduled date' },
      { k: 'afterCalls', label: 'Calls after scheduled date', num: 1, tip: 'Calls dialed after the end of the scheduled date (for example when the customer did not come). Separate from Follow-up Calls.' },
      { k: 'avgFollowUpPerMeeting', label: 'Avg Follow-ups / Meeting', num: 1, html: function (r) { return r.avgFollowUpPerMeeting == null ? '—' : r.avgFollowUpPerMeeting.toFixed(2); } },
      { k: 'showRate', label: 'Show Rate', num: 1, html: function (r) { return rate(r.showMeetings, r.scheduledTillDate, r.showRate); } },
      { k: 'conversionRate', label: 'Conversion Rate', num: 1, html: function (r) { return rate(r.convertedCustomers, r.showCustomers, r.conversionRate); } },
    ]);
    if (kind === 'store') cols = cols.filter(function (c) { return c.k !== 'totalDeals' && c.k !== 'nonCityDeals' && c.k !== 'scheduledThisWeek'; });
    if (kind === 'agent') cols = cols.filter(function (c) { return c.k !== 'scheduledThisWeek' && c.k !== 'nonCityDeals'; });
    if (kind === 'storeAgent') cols = cols.filter(function (c) { return c.k !== 'storeCityDeals' && c.k !== 'nonCityDeals' && c.k !== 'totalDeals'; });
    if (kind === 'agent') {
      // expansion shows the agent's rows per store
    }
    return cols;
  }
  function renderPerformance() {
    makeTable($('#storeTable'), { name: 'store-performance', columns: perfColumns('store'), rows: data.storeRows, sort: 'meetingsRaised', paginate: false, search: false,
      footer: function (rows) {
        var t = data.kpis;
        return '<tr class="row-total"><td><b>Total</b></td><td></td><td class="num">' + num(t.storeCityDeals) + '</td><td class="num">' + num(t.meetingsRaised) + '</td><td class="num">' + num(t.scheduledTillDate) + '</td><td class="num">' + num(t.showMeetings) + '</td><td class="num">' + num(t.convertedCustomers) + '</td><td class="num">' + num(t.followUpCalls) + '</td><td class="num">' + num(t.afterCalls) + '</td><td class="num">' + (t.avgFollowUpPerMeeting == null ? '—' : t.avgFollowUpPerMeeting.toFixed(2)) + '</td><td class="num">' + pctText(t.showRate) + '</td><td class="num">' + pctText(t.conversionRate) + '</td></tr>';
      } });
    var agentRows = data.agentRows.map(function (r) { return Object.assign({}, r); });
    makeTable($('#agentTable'), { name: 'agent-performance', columns: perfColumns('agent'), rows: agentRows, sort: 'meetingsRaised', pageSize: 15,
      expand: function (r, span) {
        var kids = data.storeAgentRows.filter(function (x) { return x.agent === r.key; });
        if (!kids.length) return '<tr class="sm-child"><td colspan="' + span + '">No meetings in the selected range.</td></tr>';
        return kids.map(function (k) { return '<tr class="sm-child"><td colspan="2">↳ ' + esc(k.store) + '</td><td></td><td class="num">' + num(k.meetingsRaised) + '</td><td class="num">' + num(k.scheduledTillDate) + '</td><td class="num">' + num(k.showMeetings) + '</td><td class="num">' + num(k.convertedCustomers) + '</td><td class="num">' + num(k.followUpCalls) + '</td><td class="num">' + num(k.afterCalls) + '</td><td class="num">' + (k.avgFollowUpPerMeeting == null ? '—' : k.avgFollowUpPerMeeting.toFixed(2)) + '</td><td class="num">' + pctText(k.showRate) + '</td><td class="num">' + pctText(k.conversionRate) + '</td></tr>'; }).join('');
      } });
  }

  function simpleTable(head, rows) {
    return '<div class="table-wrap sm-table-scroll"><table class="report-table sm-table sm-logic-table"><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td>' + (i === 0 ? '<b>' + esc(c) + '</b>' : esc(c)) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  // seconds -> hh:mm:ss (hours can exceed 24, e.g. 27:05:09)
  function hms(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function meetingCols() {
    return [
        { k: 'id', label: 'Meeting ID' }, { k: 'customer', label: 'Customer' },
        { k: 'mobile', label: 'Mobile', tip: 'Customer mobile number (from the meeting, else the linked deal)', val: function (r) { return r.mobile || ''; }, html: function (r) { return r.mobile ? esc(r.mobile) : '—'; } },
        { k: 'dealId', label: 'Deal ID' },
        { k: 'agent', label: 'Agent' }, { k: 'store', label: 'Store' },
        { k: 'raisedMs', label: 'Raised on', html: function (r) { return esc(dt(r.raisedMs)); }, csv: function (r) { return dt(r.raisedMs); } },
        { k: 'fromMs', label: 'Scheduled (From)', html: function (r) { return esc(dt(r.fromMs)); }, csv: function (r) { return dt(r.fromMs); } },
        { k: 'meetingType', label: 'Type' }, { k: 'meetingStatus', label: 'Meeting status' },
        { k: 'visitStatus', label: 'Visit status', val: function (r) { return VISIT_LABEL[r.visitStatus] + (r.visitSource ? ' (' + SRC_LABEL[r.visitSource] + ')' : ''); },
          html: function (r) { var c = r.visitStatus === 'show' ? 'badge-good' : r.visitStatus === 'no_show' ? 'badge-critical' : r.visitStatus === 'unverifiable' ? 'amber' : 'badge-neutral'; return '<span title="' + esc(r.visitSource ? SRC_LABEL[r.visitSource] : '') + '">' + badge(VISIT_LABEL[r.visitStatus], c) + '</span>'; } },
        { k: 'visitMs', label: 'Visit date', html: function (r) { return esc(r.visitMs ? (r.visitPrecision === 'date' ? dOnly(r.visitMs) : dt(r.visitMs)) : '—'); }, csv: function (r) { return r.visitMs ? dt(r.visitMs) : ''; } },
        { k: 'conversionStatus', label: 'Conversion', val: function (r) { return CONV_LABEL[r.conversionStatus] + (r.conversionSource ? ' (' + SRC_LABEL[r.conversionSource] + ')' : ''); },
          html: function (r) { return '<span title="' + esc(r.conversionSource ? SRC_LABEL[r.conversionSource] : '') + '">' + badge(CONV_LABEL[r.conversionStatus], r.conversionStatus === 'converted' ? 'badge-good' : 'badge-neutral') + '</span>'; } },
        { k: 'order', label: 'Order', val: function (r) { return r.order ? r.order.documentNo + ' · ' + r.order.date : r.conversionStatus === 'converted' ? 'Marked in Zoho (no order doc matched)' : ''; } },
        { k: 'revenue', label: 'Revenue (₹)', num: 1, tip: 'Net sale amount of the matched store order. Blank when no order was matched.',
          val: function (r) { return r.order ? Math.round(r.order.amount) : null; },
          html: function (r) { return r.order ? '₹' + nf.format(Math.round(r.order.amount)) : '—'; },
          csv: function (r) { return r.order ? Math.round(r.order.amount) : ''; } },
        { k: 'fu', label: 'Follow-up Calls (raised → end of scheduled day)', num: 1, val: function (r) { return r.followUp.total; },
          html: function (r) { return '<span title="' + (r.followUp.total ? 'Dialed on ' + r.followUp.days + ' different day(s)' : 'No call dialed') + (r.followUp.total < 3 ? ' (below 3 follow-up calls)' : '') + '"' + (r.followUp.total < 3 ? ' class="sm-low"' : '') + '>' + num(r.followUp.total) + '</span>'; } },
        { k: 'fuAfter', label: 'Calls after scheduled date', num: 1, tip: 'Calls dialed after the END of the meeting scheduled date, for example when the customer did not come on the day. Not part of Follow-up Calls.',
          val: function (r) { return r.followUp.after || 0; },
          html: function (r) { return '<span title="' + (r.followUp.after ? 'Dialed after the scheduled date had ended' : 'No call after the scheduled date') + '">' + num(r.followUp.after || 0) + '</span>'; } },
        { k: 'callSeconds', label: 'Total call duration (hh:mm:ss)', num: 1, tip: 'Total talk time of all the calls counted for this meeting: Follow-up Calls plus Calls after scheduled date. Calls that were not picked up add 0.',
          val: function (r) { return (r.followUp.seconds || 0) + (r.followUp.afterSeconds || 0); },
          html: function (r) { return hms((r.followUp.seconds || 0) + (r.followUp.afterSeconds || 0)); },
          csv: function (r) { return hms((r.followUp.seconds || 0) + (r.followUp.afterSeconds || 0)); } },
      ];
  }

  function renderMeetingDump() {
    $('#meetingHeading').textContent = 'Meetings Raised — Details (' + num(data.meetings.length) + ')';
    makeTable($('#meetingTable'), {
      name: 'meetings-raised', sort: 'raisedMs', dir: -1, pageSize: 25, rows: data.meetings,
      empty: 'No meetings were raised in the selected period.',
      columns: meetingCols(),
    });
  }

  function renderLogic() {
    var r = data.rules, m = data.meta;
    var live = m.meetingsSource === 'zoho_api';
    var sources = [
      ['Deals', 'Zoho CRM — Deals (live)', 'Owner, created date, city, mobile, email, probability score', 'Live (saved up to 15 minutes).', 'A deal gets a store from its city (see "Which store").'],
      ['Meetings', live ? 'Zoho CRM — Events (live)' : 'BigQuery — zoho_crm.cdc_meetings (copy of Zoho meetings)', 'Raised time, scheduled (From) time, agent, store, Show and Conversion status, deal, mobile', live ? 'Live.' : 'Through the day. Can be a little behind Zoho.', live ? '—' : 'The app cannot read Zoho meetings directly yet (Events permission missing).'],
      ['Show / Converted days', 'Saved Zoho history list (config/meetingMarkDates.json)', 'The day Show and Converted were set in Zoho, plus their status, for the meetings that were Show when the list was made', 'A snapshot, not live.', 'A meeting not in the list uses the BigQuery copy and its last edited day.'],
      ['Calls', 'BigQuery — Lucira_Prod.lucira_zoho_Calls + live Zoho calls for the last few hours', 'Outbound calls: number dialed, time, duration, caller, deal, contact', 'Rebuilt every night; newer calls read live.', 'Calls made outside Zoho cannot be counted.'],
      ['Orders', 'BigQuery — ds_imputed_reporting.marketing_sale', 'Mobile, email, sale date, net sale, channel (Store / Online)', 'Through the day.', 'Used for Revenue and for the deal breakdown. It never decides Show or Converted.'],
    ];
    var dateRules = [
      ['Deal cards', 'Deal created date', 'Top Date filter'],
      ['Meetings Raised', 'Date the meeting was raised', 'Top Date filter'],
      ['Scheduled', 'Meeting scheduled (From) date', 'Top Date filter'],
      ['Customer Shows', 'Day Show was set in Zoho', 'Top Date filter'],
      ['Converted Customers', 'Day Converted was set in Zoho', 'Top Date filter'],
      ['Follow-up Calls card and call charts', 'Meetings scheduled in the period', 'Top Date filter (the calls themselves ignore dates)'],
      ['Store and Agent Performance tables', 'Date the meeting was raised', 'Top Date filter'],
      ['Store-wise / Agent-wise Schedule', 'Meeting scheduled date', 'Its own date buttons (default Yesterday)'],
    ];
    var metrics = [
      ['Total / Store City / Non-City Deals', 'Unique Zoho deals (by deal ID) created in the period. Store City = Bangalore, Mumbai, Delhi, Noida, Pune. Non-City = any other known city. Every deals card opens a list with the six breakdown tiles.'],
      ['Unknown / Unmapped Deals', 'One card, two kinds of deals added together: Unknown = no city in Zoho; Unmapped = a store-city deal that could not be given a store (for example Delhi with no zone). The line under the number shows the split.'],
      ['Deal breakdown (click a deals card)', 'Above the deals list, six clickable tiles. Click a tile to list only those deals; click again to go back. Each deal is counted once.'],
      ['– Meeting raised', 'The deal has a Zoho meeting linked to it, or a meeting with the same mobile (then the list says "mapped by mobile").'],
      ['– Online order', 'The customer has an Online sale in marketing_sale. Found by mobile first; if none, by email. Never by name.'],
      ['– Call dialed / Connected / Not called', 'Call dialed = any outbound call log of the customer in Zoho, found by mobile first, then deal, contact or same-mobile deal, at any date. Connected = a call of 30 seconds or more. Not called = no call log at all.'],
      ['– Store order, no meeting', 'No meeting was raised, but the customer has a Store sale (mobile first, then email).'],
      ['– Deals list columns', 'Mobile, Probability % (Zoho score), Meetings raised (with ‘mapped by mobile’ and the deal the meeting is on), online and store orders with revenue (with ‘mapped by email’ and the email), calls, call status. Search ignores capital letters and also searches mobile. Export CSV adds ‘Meeting matched by’ and ‘Orders matched by’.'],
      ['Meetings Raised', 'Meetings created in the period. The line below shows the raised months (for example Aug 50, Sep 60).'],
      ['Scheduled', 'Meetings whose scheduled date is in the period, and how many are still to come.'],
      ['Customer Shows', 'Meetings marked Show in Zoho, counted on the day the Show was set (not the scheduled day). No Show or no mark is not a Show. Walk-ins are not used.'],
      ['Converted Customers', 'Shows marked Converted in Zoho, counted on the day Converted was set. One customer is counted once.'],
      ['Revenue', 'Net sale of the customer’s store sale, found by mobile: the latest store sale on or before the Converted day (up to 60 days earlier), else the first one after. Blank if none.'],
      ['Show Rate / Conversion Rate', 'Show Rate = Shows ÷ meetings scheduled in the period. Conversion Rate = Converted ÷ Shows in the period. Show Rate can pass 100% on busy visit days.'],
      ['Live calls', 'Calls update by themselves: the page re-reads the newest Zoho calls every 30 seconds (the line at the top shows "Calls live as of"). Meetings, deals and sales are refreshed every 15 minutes.'],
      ['Total Calls Done / Total Talk Time', 'Every outbound call dialed in the selected Date period (any customer or deal, not only meetings), and the total talk time (hh:mm:ss). Calls not picked up add 0 to the talk time. Connected = 30 seconds or more. These cards follow the top Date and Agent filters.'],
      ['Follow-up Calls', 'Calls from the exact raised time to the end of the scheduled day. The card adds them to "Calls after scheduled date" (calls after that day ends). Every dialed call counts.'],
      ['Deal and meeting charts', 'Store City vs Non-City: share of deals (Unknown / Unmapped shown together). Meeting Funnel: Raised → Shows → Converted. Meetings Raised by Store: meetings raised per store, click a store to filter. These follow the top Date filter.'],
      ['Products of Scheduled Meetings', 'Eight tables (category, karat, SKU, variant, price band, size, style, shape) plus a meeting-wise product list, for the meetings scheduled in the period of the Scheduled Meetings section. Products = the products on the meeting’s deal; if the deal has none, the product the customer last viewed. A product is matched to the catalogue by SKU first, then by style, then by exact product name; otherwise it shows as ‘Not matched’. Inventory = live pieces at the meeting’s own store: In stock, Other stores only (incl. Head Office), Out of stock, or Unknown. Many deals have no product in Zoho, so the counts only cover meetings that have one.'],
      ['Scheduled Meetings by Store (chart)', 'Meetings scheduled in the period (same meetings as the Scheduled card), counted per store. Click a store to list them.'],
      ['Call charts', 'Meetings by number of calls (a bar shows only if a meeting has that count). Connected = a meeting with a call of 30 seconds or more; Not connected = called but none reached 30 seconds; No call = none.'],
      ['Store and Agent tables', 'For meetings raised in the period: Scheduled Till Date (scheduled today or earlier), Shows, Conversions, calls, Show Rate = Shows ÷ Scheduled Till Date.'],
      ['Schedule tables and lists', 'Store-wise and Agent-wise schedule use their own dates. Every card and list opens with Export CSV and Store / Agent filters.'],
    ];
    var callSteps = [
      ['1', 'Mobile first', 'A call belongs to a meeting when its dialed number (or the number at the end of the subject) is the customer’s mobile.'],
      ['2', 'Then other ways', 'Only if the mobile finds nothing: same contact, same deal, the deal’s mobile, or a number in the contact name.'],
      ['3', 'Window', 'Follow-up = after the raised time and before the end of the scheduled day. After that day = "Call after scheduled date".'],
      ['4', 'One call, one meeting', 'A call counts for one meeting only (follow-up beats after-schedule). Later calls go to the customer’s newest meeting, so an older meeting can show no call.'],
    ];
    var storeSteps = [
      ['Deal', 'Delhi by zone (Central, South, South West → Lajpat Nagar; North, North West, West → Paschim Vihar; East → Noida), Noida, Pune, Bangalore → Malleshwaram. Mumbai splits 50/50 between Borivali and Chembur. No usable city = unassigned.'],
      ['Meeting', 'The Store Name on the Zoho meeting; if empty, worked out from owner and venue.'],
    ];
    var notes = [
      'Show and Converted follow what agents mark in Zoho. No mark = "Unverifiable".',
      'Days are the days the agent set the status in Zoho, not necessarily the customer’s visit day.',
      'New Show / Converted marks may take time to appear because the meeting copy can be behind Zoho.',
      'Everything is matched by mobile number first. Names are never used.',
      'All times are India time (IST).',
    ];
    $('#logicBody').innerHTML =
      '<div class="logic-box"><h2 class="logic-box-title">DATA SOURCES</h2>' +
      simpleTable(['Data', 'Where from', 'What we use', 'How fresh', 'Good to know'], sources) + '</div>' +
      '<div class="logic-box sm-gap"><h2 class="logic-box-title">WHICH DATE EACH NUMBER USES</h2>' +
      simpleTable(['Number', 'Date used', 'Controlled by'], dateRules) + '</div>' +
      '<div class="logic-box sm-gap"><h2 class="logic-box-title">WHAT EACH NUMBER MEANS</h2>' +
      simpleTable(['Number', 'In simple words'], metrics) + '</div>' +
      '<div class="logic-box sm-gap"><h2 class="logic-box-title">HOW A CALL IS MATCHED TO A MEETING</h2>' +
      simpleTable(['Step', 'Rule', 'In simple words'], callSteps) + '</div>' +
      '<div class="logic-box sm-gap"><h2 class="logic-box-title">WHICH STORE</h2>' +
      simpleTable(['What', 'Rule'], storeSteps) + '</div>' +
      '<div class="logic-box sm-gap"><h2 class="logic-box-title">GOOD TO KNOW</h2><ul class="logic-list">' +
      notes.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>';
  }

  // ---- KPI pop-up lists -------------------------------------------------------
  var KPI_KEYS = ['deals', 'cityDeals', 'nonCityDeals', 'unknownDeals', 'meetings', 'sched', 'shows', 'converted', 'calls', '', '', 'showRate', 'convRate'];
  var KPI_DEALS = { deals: '', cityDeals: 'store_city', nonCityDeals: 'non_city', unknownDeals: 'unknown_unmapped' };
  function openModal(title, sub) {
    $('#kpiModalTitle').textContent = title;
    $('#kpiModalSub').textContent = sub || '';
    $('#kpiModal').hidden = false;
    document.body.classList.add('sm-modal-open');
    $('#kpiModalClose').focus();
  }
  function closeModal() {
    $('#kpiModal').hidden = true;
    document.body.classList.remove('sm-modal-open');
  }
  function callCols() {
    return [
      { k: 'customer', label: 'Customer' }, { k: 'meetingId', label: 'Meeting ID' }, { k: 'dealId', label: 'Deal ID' },
      { k: 'agent', label: 'Called by' }, { k: 'store', label: 'Store' },
      { k: 'tsMs', label: 'Call time', html: function (r) { return esc(dt(r.tsMs)); }, csv: function (r) { return dt(r.tsMs); } },
      { k: 'durationSec', label: 'Duration (s)', num: 1 },
      { k: 'kind', label: 'Call type', val: function (r) { return r.kind === 'after' ? 'After scheduled date' : 'Follow-up'; },
        html: function (r) { return badge(r.kind === 'after' ? 'After scheduled date' : 'Follow-up', r.kind === 'after' ? 'amber' : 'badge-good'); } },
    ];
  }
  // Small checkbox multi-select used inside the pop-up (same look as the main filters).
  function msControl(host, title, options, onChange) {
    var sel = new Set(), box = document.createElement('div');
    box.className = 'sm-f';
    box.innerHTML = '<span class="sm-fl">' + esc(title) + '</span><div class="sm-ms"><button type="button" class="sm-ms-btn"></button><div class="sm-ms-panel" hidden>' +
      (options.length > 8 ? '<input type="search" class="sm-ms-search" placeholder="Search…" aria-label="Search ' + esc(title) + '">' : '') +
      '<button type="button" class="sm-ms-clear" data-act="clear">Clear (show all)</button>' +
      options.map(function (o) { return '<label class="sm-ms-opt"><input type="checkbox" value="' + esc(o.v) + '"> <span>' + esc(o.l) + '</span></label>'; }).join('') + '</div></div>';
    host.appendChild(box);
    var btn = box.querySelector('.sm-ms-btn'), panel = box.querySelector('.sm-ms-panel');
    function label(v) { var o = options.filter(function (x) { return x.v === v; })[0]; return o ? o.l : v; }
    function sync() {
      var vals = Array.from(sel);
      btn.textContent = !vals.length ? 'All' : vals.length === 1 ? label(vals[0]) : vals.length + ' selected';
      btn.classList.toggle('is-set', vals.length > 0);
      panel.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = sel.has(cb.value); });
    }
    btn.addEventListener('click', function () {
      var open = panel.hidden;
      document.querySelectorAll('.sm-modal .sm-ms-panel').forEach(function (p) { p.hidden = true; });
      panel.hidden = !open;
    });
    panel.addEventListener('change', function (e) {
      if (!e.target.matches('input[type=checkbox]')) return;
      if (e.target.checked) sel.add(e.target.value); else sel.delete(e.target.value);
      sync(); onChange(Array.from(sel));
    });
    panel.addEventListener('click', function (e) {
      if (e.target.getAttribute('data-act') === 'clear') { sel.clear(); sync(); onChange([]); }
    });
    panel.addEventListener('input', function (e) {
      if (!e.target.matches('.sm-ms-search')) return;
      var n = e.target.value.toLowerCase();
      panel.querySelectorAll('.sm-ms-opt').forEach(function (o) { o.hidden = o.textContent.toLowerCase().indexOf(n) < 0; });
    });
    sync();
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.sm-ms')) document.querySelectorAll('.sm-modal .sm-ms-panel').forEach(function (p) { p.hidden = true; });
  });
  function uniqueOptions(rows, field) {
    var seen = {};
    rows.forEach(function (r) { if (r[field]) seen[r[field]] = true; });
    return Object.keys(seen).sort(function (x, y) { return x.localeCompare(y); }).map(function (v) { return { v: v, l: v }; });
  }

  // Pop-up list for meetings / calls: Store + Agent filters on top, search / sort / paging / CSV in the table.
  function openRowList(title, sub, rows, columns, tableOpts, storeField, agentField) {
    openModal(title, num(rows.length) + ' rows. ' + sub);
    var body = $('#kpiModalBody');
    body.innerHTML = '<div class="sm-modal-filters"></div><div class="sm-modal-table"></div>';
    var fHost = body.querySelector('.sm-modal-filters'), tHost = body.querySelector('.sm-modal-table');
    var stores = [], agents = [];
    function draw() {
      var out = rows.filter(function (r) {
        return (!stores.length || stores.indexOf(r[storeField]) >= 0) && (!agents.length || agents.indexOf(r[agentField]) >= 0);
      });
      $('#kpiModalSub').textContent = num(out.length) + (out.length === rows.length ? '' : ' of ' + num(rows.length)) + ' rows. ' + sub;
      makeTable(tHost, Object.assign({ rows: out, columns: columns }, tableOpts));
    }
    msControl(fHost, 'Store', uniqueOptions(rows, storeField), function (v) { stores = v; draw(); });
    msControl(fHost, agentField === 'agent' && columns.some(function (c) { return c.label === 'Called by'; }) ? 'Called by' : 'Agent', uniqueOptions(rows, agentField), function (v) { agents = v; draw(); });
    draw();
  }

  // Total revenue of a list of meetings: each matched order document is counted once.
  function revenueOf(rows) {
    var seen = {}, total = 0;
    rows.forEach(function (r) { if (r.order && !seen[r.order.documentNo]) { seen[r.order.documentNo] = true; total += r.order.amount; } });
    return total;
  }
  function inr(n) { return '₹' + nf.format(Math.round(n)); }

  function openKpi(key) {
    if (Object.prototype.hasOwnProperty.call(KPI_DEALS, key)) { openDeals(key); return; }
    var k = data.kpis, t = k.sched, pl = periodLabel(), shows = data.visitedMeetings || [], convs = data.convertedMeetings || [];
    if (key === 'calls') {
      openRowList('Follow-up Calls — Scheduled ' + pl, num(t.followUpOnly) + ' follow-up calls (raised → end of the scheduled date) + ' + num(t.afterOnly) + ' calls after the scheduled date, for the meetings scheduled ' + pl + ' (' + num(t.meetingsWithFollowUp) + ' meetings called, ' + num(t.meetingsZeroFollowUp) + ' not called).', data.schedCalls, callCols(),
        { name: 'follow-up-calls', sort: 'tsMs', dir: -1, pageSize: 15, empty: 'No follow-up calls for the meetings scheduled in this period.' }, 'store', 'agent');
      return;
    }
    var cfg = {
      meetings: ['Meetings Raised', data.meetings, 'meetings-raised', 'Every meeting raised in the selected period.'],
      shows: ['Customer Shows — ' + pl, shows, 'customer-shows', num(t.showMeetings) + ' meetings had a Show ' + pl + ' (' + num(t.showCustomers) + ' unique customers), counted on the day the customer visited.'],
      converted: ['Converted Customers — ' + pl, convs, 'converted-customers', 'Visited and bought ' + pl + ': ' + num(t.convertedCustomers) + ' unique customers. Total revenue: ' + inr(revenueOf(convs)) + '.'],
      sched: ['Scheduled ' + pl, data.schedMeetings, 'scheduled-' + pl.toLowerCase().replace(/[^a-z0-9]+/g, '-'), 'Meetings whose From (scheduled) date is in the selected Date period (' + pl + ').'],
      week: ['Scheduled This Week', data.weekMeetings, 'scheduled-this-week', 'Meetings whose From date is ' + data.week.startKey + ' to ' + data.week.endKey + ' (ignores the Date filter).'],
      showRate: ['Show Rate — ' + pl, shows, 'show-rate', num(t.showMeetings) + ' show meetings ' + pl + ' ÷ ' + num(t.meetings) + ' meetings scheduled ' + pl + '.'],
      convRate: ['Conversion Rate — ' + pl, shows, 'conversion-rate', num(t.convertedCustomers) + ' customers converted ÷ ' + num(t.showCustomers) + ' customers who visited ' + pl + '. See the Conversion column.'],
    };
    var c = cfg[key];
    if (!c) return;
    openRowList(c[0], c[3], c[1], meetingCols(),
      { name: c[2], sort: (key === 'week' || key === 'sched') ? 'fromMs' : 'raisedMs', dir: (key === 'week' || key === 'sched') ? 1 : -1, pageSize: 15, empty: 'Nothing to show for the selected filters.' }, 'store', 'agent');
  }

  // Deal pop-up: server-side paging/search, Store + Agent filters, CSV export of ALL matching deals.
  function openDeals(key) {
    var titles = { deals: 'Total Deals', cityDeals: 'Store City Deals', nonCityDeals: 'Non-City Deals', unknownDeals: 'Unknown / Unmapped Deals' };
    var cat = KPI_DEALS[key], st = { page: 0, search: '', store: [], agent: [], group: '' }, body = $('#kpiModalBody');
    openModal(titles[key], 'Loading…');
    body.innerHTML = '<div class="sm-modal-filters"></div><div class="sm-modal-table"></div>';
    var fHost = body.querySelector('.sm-modal-filters'), tHost = body.querySelector('.sm-modal-table');
    function storeName(k) {
      var s = data.filterOptions.stores.filter(function (x) { return x.key === k; })[0];
      return s ? s.label : 'Unassigned';
    }
    var cols = [
      { label: 'Deal ID', val: function (r) { return r.id; } }, { label: 'Deal', val: function (r) { return r.name || ''; } }, { label: 'Mobile', val: function (r) { return r.mobile || ''; } },
      { label: 'Owner', val: function (r) { return r.agent; } }, { label: 'Created', val: function (r) { return r.createdDateKey || ''; } },
      { label: 'City', val: function (r) { return r.cityRaw || ''; } }, { label: 'Probability %', val: function (r) { return r.probability == null ? '' : String(r.probability) + '%'; } },
      { label: 'Category', val: function (r) { return CAT_LABEL[r.category]; } },
      { label: 'Meetings raised', val: function (r) { return String(r.meetingsRaised || 0); } },
      { label: 'Online orders', val: function (r) { return String(r.onlineOrders || 0); } }, { label: 'Online revenue', val: function (r) { return r.onlineRevenue ? String(r.onlineRevenue) : ''; } },
      { label: 'Store orders', val: function (r) { return String(r.storeOrders || 0); } }, { label: 'Store revenue', val: function (r) { return r.storeRevenue ? String(r.storeRevenue) : ''; } },
      { label: 'Meeting matched by', val: function (r) { return r.meetingMatchedBy === 'mobile' ? 'Mobile (meeting is on deal ' + ((r.meetingOtherDeals || []).join(', ') || 'another deal') + ')' : r.meetingMatchedBy === 'deal' ? 'Deal' : ''; } },
      { label: 'Orders matched by', val: function (r) { return r.orderMatchedBy === 'email' ? 'Email (' + (r.email || '') + ')' : r.orderMatchedBy === 'mobile' ? 'Mobile' : ''; } },
      { label: 'Calls dialed', val: function (r) { return String(r.callsDialed || 0); } },
      { label: 'Calls ≥ 30 s', val: function (r) { return String(r.connectedCalls || 0); } },
      { label: 'Call status', val: function (r) { return !r.callsDialed ? 'Not called' : r.connectedCalls ? 'Connected' : 'Called, not connected'; } },
    ];
    var GROUP_LABEL = { meeting: 'Meeting raised', online: 'Online order', called: 'Call dialed', connected: 'Connected (30 s+)', notcalled: 'Not called', storeorder: 'Store order, no meeting' };
    function breakdownHtml(b) {
      function tile(n, label, tip, g) { return '<div class="sm-bd-tile sm-bd-click' + (st.group === g ? ' is-active' : '') + '" role="button" tabindex="0" data-group="' + g + '" title="' + esc(tip + ' — click to list these deals') + '"><div class="sm-bd-n">' + num(n) + '</div><div class="sm-bd-l">' + esc(label) + '</div><div class="sm-bd-p">' + (b.total ? (Math.round(n / b.total * 1000) / 10) + '% of deals' : '') + '</div></div>'; }
      return '<div class="sm-bd"><div class="sm-bd-head">Breakdown of these ' + num(b.total) + ' unique deals (each deal is counted once, by deal ID)</div><div class="sm-bd-grid">' +
        tile(b.meetingRaised, 'Meeting raised', 'Deals with at least one meeting raised: linked to the deal or with the same mobile number (' + num(b.meetingsCount) + ' meetings in total)', 'meeting') +
        tile(b.onlineOrder, 'Online order', 'Deals whose customer (mobile number first, then e-mail) has an online order in marketing_sale on or after the deal was created', 'online') +
        tile(b.callDialed, 'Call dialed', 'Deals whose customer has at least one outbound call log in Zoho (mobile number first, then deal, contact, same-mobile deal or contact name)', 'called') +
        tile(b.connected, 'Connected (30 s+)', 'Deals called where at least one call lasted 30 seconds or more', 'connected') +
        tile(b.notCalled, 'Not called', 'Deals whose customer has no call log in Zoho in any way (not by mobile, deal or contact)', 'notcalled') +
        tile(b.storeOrderNoMeeting, 'Store order, no meeting', 'No meeting raised, but the customer (mobile number first, then e-mail) bought from a store: Store sale in marketing_sale on or after the deal was created', 'storeorder') +
        '</div>' + (st.group ? '<div class="sm-bd-note">Showing only: <b>' + esc(GROUP_LABEL[st.group]) + '</b> <button type="button" class="export-btn" data-group="">Show all deals</button></div>' : '') + '</div>';
    }
    function params(extra) {
      return qs(Object.assign({ dealsOnly: '1', dealCategoryDrill: cat, dealStore: st.store.join(','), dealAgent: st.agent.join(','), dealGroup: st.group }, extra));
    }
    function getJson(url) {
      return fetch(url).then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.detail || b.error || r.status); return b; }); });
    }
    msControl(fHost, 'Store', data.filterOptions.stores.map(function (s) { return { v: s.key, l: s.label }; }).concat([{ v: '__none', l: 'Unassigned' }]), function (v) { st.store = v; st.page = 0; draw(); });
    msControl(fHost, 'Owner (agent)', data.filterOptions.agents.map(function (a) { return { v: a, l: a }; }), function (v) { st.agent = v; st.page = 0; draw(); });
    function draw() {
      tHost.innerHTML = '<div class="sm-empty">Loading…</div>';
      getJson('/api/store-meeting-analytics?' + params({ dealPage: st.page, dealSearch: st.search })).then(function (b) {
        var d = b.dealDrill, pages = Math.max(1, Math.ceil(d.total / d.size));
        $('#kpiModalSub').textContent = num(d.total) + ' deals' + (st.group ? ' — ' + GROUP_LABEL[st.group] : '') + (st.search ? ' matching "' + st.search + '"' : '') + '. Date filter = deal created date.';
        tHost.innerHTML = breakdownHtml(d.breakdown) +
          '<div class="sm-tools"><input class="table-search" id="kpiDealSearch" type="search" placeholder="Search name, mobile, city, owner, id… (not case sensitive)" value="' + esc(st.search) + '" aria-label="Search deals">' +
          '<button type="button" class="export-btn" id="kpiDealExport">Export CSV (all ' + num(d.total) + ')</button></div>' +
          (d.rows.length ? '<div class="table-wrap sm-table-scroll"><table class="report-table sm-table"><thead><tr>' + cols.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
            d.rows.map(function (r) {
              return '<tr>' + cols.map(function (c) {
                if (c.label === 'Category') return '<td>' + badge(CAT_LABEL[r.category], r.category === 'store_city' ? 'badge-good' : r.category === 'unknown' ? 'amber' : 'badge-neutral') + '</td>';
                if (c.label === 'Meetings raised' && r.meetingMatchedBy === 'mobile') return '<td>' + esc(c.val(r)) + '<div class="sm-by-email">mapped by mobile<br>meeting is on deal ' + esc((r.meetingOtherDeals || []).join(', ') || 'another deal') + '</div></td>';
                if ((c.label === 'Online orders' || c.label === 'Store orders') && r.orderMatchedBy === 'email' && c.val(r) !== '0') return '<td>' + esc(c.val(r)) + '<div class="sm-by-email">mapped by email<br>' + esc(r.email || '') + '</div></td>';
                return '<td>' + esc(c.val(r) || '—') + '</td>';
              }).join('') + '</tr>';
            }).join('') + '</tbody></table></div>' : '<div class="sm-empty">No deals match.</div>') +
          '<div class="sm-pager"><button type="button" class="export-btn" id="kpiDealPrev"' + (d.page === 0 ? ' disabled' : '') + '>Prev</button>Page ' + (d.page + 1) + ' / ' + pages + '<button type="button" class="export-btn" id="kpiDealNext"' + (d.page >= pages - 1 ? ' disabled' : '') + '>Next</button></div>';
        tHost.querySelectorAll('[data-group]').forEach(function (el) {
          function pick() { var g = el.getAttribute('data-group'); st.group = st.group === g ? '' : g; st.page = 0; draw(); }
          el.addEventListener('click', pick);
          el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        });
        var s = $('#kpiDealSearch');
        s.addEventListener('keydown', function (e) { if (e.key === 'Enter') { clearTimeout(st.timer); st.search = s.value.trim(); st.page = 0; st.focusSearch = true; draw(); } });
        s.addEventListener('input', function () { clearTimeout(st.timer); st.timer = setTimeout(function () { st.search = s.value.trim(); st.page = 0; st.focusSearch = true; draw(); }, 400); });
        if (st.focusSearch) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
        $('#kpiDealPrev').addEventListener('click', function () { st.page -= 1; draw(); });
        $('#kpiDealNext').addEventListener('click', function () { st.page += 1; draw(); });
        $('#kpiDealExport').addEventListener('click', function () {
          var btn = $('#kpiDealExport'), old = btn.textContent;
          btn.disabled = true; btn.textContent = 'Preparing…';
          getJson('/api/store-meeting-analytics?' + params({ dealPage: 0, dealSearch: st.search, dealSize: 100000 }))
            .then(function (all) { exportCsv('deals-' + key + (st.group ? '-' + st.group : ''), cols, all.dealDrill.rows); })
            .catch(function (err) { alert('Export failed: ' + err.message); })
            .then(function () { btn.disabled = false; btn.textContent = old; });
        });
      }).catch(function (err) { tHost.innerHTML = '<div class="sm-empty">Could not load deals: ' + esc(err.message) + '</div>'; });
    }
    draw();
  }

  // ---- events -----------------------------------------------------------
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = form.elements.dateFrom, t = form.elements.dateTo;
    if (f.value && !t.value) t.value = f.value;
    if (t.value && !f.value) f.value = t.value;
    if (f.value && t.value && f.value > t.value) { var x = f.value; f.value = t.value; t.value = x; }
    load(false);
  });
  $('#resetFilters').addEventListener('click', function () { weekState = weekDefaultState(); syncWeekUI(); form.reset(); Object.keys(MS).forEach(function (k) { MS[k].selected.clear(); msSync(k); }); presetActive = ''; $('#customDates').hidden = true; document.querySelectorAll('#datePresets .option-btn').forEach(function (b) { b.classList.remove('is-active'); }); setPreset('yesterday'); });
  $('#datePresets').addEventListener('click', function (e) { var p = e.target.dataset && e.target.dataset.preset; if (p) setPreset(p); });
  $('#kpiGrid').addEventListener('click', function (e) {
    var card = e.target.closest('[data-kpi]');
    if (card) openKpi(card.dataset.kpi);
  });
  $('#kpiGrid').addEventListener('keydown', function (e) {
    var card = e.target.closest('[data-kpi]');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openKpi(card.dataset.kpi); }
  });
  $('#kpiModalClose').addEventListener('click', closeModal);
  $('#kpiModal').addEventListener('click', function (e) { if (e.target === $('#kpiModal')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#kpiModal').hidden) closeModal(); });
  $('#weekPresets').addEventListener('click', function (e) { var p = e.target.dataset && e.target.dataset.wp; if (p) setWeekPreset(p); });
  $('#weekApply').addEventListener('click', function () {
    var f = $('#weekFrom').value, t = $('#weekTo').value || f;
    if (!f) { alert('Pick a From date.'); return; }
    weekState.from = f; weekState.to = t;
    loadWeekTable();
  });
  $('#refreshBtn').addEventListener('click', function () { load(true); });
  $('#chips').addEventListener('click', function (e) {
    var k = e.target.getAttribute && e.target.getAttribute('data-clear');
    if (k === 'dateFrom' || k === 'dateTo') { presetActive = 'x'; setPreset('x'); return; }
    if (k) setFilter(k, '');
  });
  $('#chartsGrid').addEventListener('click', function (e) {
    var t = e.target.closest('[data-filter]');
    if (!t) return;
    if (t.dataset.filter === 'schedStore') openSchedStore(t.dataset.value);
    else if (t.dataset.filter === 'callsBucket') openCallsBucket(t.dataset.value);
    else if (t.dataset.filter === 'connBucket') openConnBucket(t.dataset.value);
    else setFilter(t.dataset.filter, t.dataset.value);
  });
  document.querySelectorAll('.page-tab-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.page-tab-btn').forEach(function (x) { x.classList.toggle('is-active', x === b); });
      document.querySelectorAll('.page-panel').forEach(function (p) { p.classList.toggle('is-active', p.id === b.dataset.panel); });
    });
  });

  // Live calls: re-read the numbers every 30 seconds while the page is open and nothing is being typed or browsed in a pop-up.
  var liveBusy = false;
  setInterval(function () {
    var ae = document.activeElement, typing = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
    if (document.hidden || liveBusy || !data || !$('#kpiModal').hidden || typing) return;
    liveBusy = true;
    var sig = function (d) { return JSON.stringify([d.kpis.allCalls, d.kpis.sched.followUpCalls, d.kpis.sched.meetingsZeroFollowUp, d.kpis.sched.meetingsWithFollowUp, d.kpis.followUpCalls, d.meetings.length, d.version]); };
    fetch('/api/store-meeting-analytics?' + qs({ refresh: '', weekFrom: weekState.from, weekTo: weekState.to }))
      .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || r.status); return b; }); })
      .then(function (body) {
        var changed = sig(body) !== sig(data);
        if (body.version && startVersion && body.version !== startVersion) versionChanged = true;
        data = body;
        if (changed) render(); else $('#updatedAt').textContent = $('#updatedAt').textContent.replace(/ · Calls live as of [0-9:]+/, '') .replace(/( · version|$)/, ' · Calls live as of ' + new Date(data.callsLiveAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '$1');
      })
      .catch(function () {})
      .then(function () { liveBusy = false; });
  }, 30000);

  syncWeekUI();            // highlight the Scheduled Meetings default (Yesterday)
  setPreset('yesterday'); // default view: yesterday
})();
