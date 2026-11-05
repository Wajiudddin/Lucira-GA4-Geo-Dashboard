/* Zoho Deal Intelligence — core: data, filters, aggregation, table & chart components.
   Data: /api/deal-intel (BigQuery zoho_crm.zoho_deal_intelligence, 1 row per deal).
   Every number on the page is computed here from the filtered deal list, so all KPIs,
   charts and tables always respond to the same global date + advanced filters. */
'use strict';
var DI = window.DI = {};
var API = new URLSearchParams(location.search).get('api') || '/api/deal-intel';

/* ---------------------------------------------------------------- categories */
DI.CATS = [
  {k:'Buyer',      key:'b',  col:'--c-buyer'},
  {k:'Non-Buyer',  key:'nb', col:'--c-nonbuyer'},
  {k:'Subscriber', key:'s',  col:'--c-sub'},
  {k:'Visitor',    key:'v',  col:'--c-vis'},
  {k:'CTWA',       key:'c',  col:'--c-ctwa'}
];
DI.color = function(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); };
DI.catColor = function(k){ var c = DI.CATS.find(function(x){return x.k===k;}); return DI.color(c ? c.col : '--c-total'); };

/* ---------------------------------------------------------------- state */
DI.F = {preset:'yesterday', from:'', to:'', mode:'flags',
        agent:[], stage:[], ls:[], trig:[], cat:[], buyer:'', city:[], pin:[], band:[], pmin:'', pmax:''};
DI.ROWS = []; DI.META = {};

/* ---------------------------------------------------------------- utils */
DI.esc = function(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); };
DI.n = function(v){ return v==null||isNaN(v) ? '—' : Math.round(v).toLocaleString('en-IN'); };
DI.p = function(num, den){ return den ? (num*100/den).toFixed(1)+'%' : '—'; };
DI.pv = function(num, den){ return den ? num*100/den : null; };
DI.f1 = function(v){ return v==null||isNaN(v) ? '—' : (+v).toFixed(1); };
DI.istToday = function(){ var d = new Date(Date.now() + 330*60000); return d.toISOString().slice(0,10); };
DI.addDays = function(s, k){ var d = new Date(s+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+k); return d.toISOString().slice(0,10); };
DI.dayDiff = function(a, b){ return Math.round((Date.parse(b+'T00:00:00Z') - Date.parse(a+'T00:00:00Z'))/864e5); };
DI.fmtDate = function(s){ if(!s) return '—'; var d = new Date(s.slice(0,10)+'T00:00:00Z');
  return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}); };
DI.fmtShort = function(s){ var d = new Date(s+'T00:00:00Z'); return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',timeZone:'UTC'}); };

DI.PRESETS = [['yesterday','Yesterday'],['today','Today'],['last7','Last 7 Days'],['week','This Week'],
              ['last30','Last 30 Days'],['month','This Month'],['custom','Custom']];
DI.range = function(){
  var t = DI.istToday(), F = DI.F;
  switch(F.preset){
    case 'today':  return [t, t];
    case 'yesterday': var y = DI.addDays(t,-1); return [y, y];
    case 'last7':  return [DI.addDays(t,-6), t];
    case 'last30': return [DI.addDays(t,-29), t];
    case 'week':   var dow = (new Date(t+'T00:00:00Z').getUTCDay()+6)%7; return [DI.addDays(t,-dow), t];   // Monday start
    case 'month':  return [t.slice(0,8)+'01', t];
    default: return [F.from || DI.addDays(t,-1), F.to || F.from || DI.addDays(t,-1)];
  }
};
DI.rangeLabel = function(){ var r = DI.range(); var lbl = (DI.PRESETS.find(function(p){return p[0]===DI.F.preset;})||[])[1];
  return (lbl && DI.F.preset!=='custom' ? lbl+' · ' : '') + (r[0]===r[1] ? DI.fmtDate(r[0]) : DI.fmtDate(r[0])+' – '+DI.fmtDate(r[1])); };

/* ---------------------------------------------------------------- load */
DI.load = function(){
  return fetch(API, {cache:'no-store', headers:{'Accept':'application/json'}})
    .then(function(r){ return r.json().then(function(j){ if(!r.ok || j.error) throw new Error(j.error || ('HTTP '+r.status)); return j; }); })
    .then(function(j){
      var C = {}; j.cols.forEach(function(c,i){ C[c] = i; });
      DI.META = j.meta || {};
      DI.ROWS = j.rows.map(function(r){
        var prob = r[C.probability_score];
        return {
          id:r[C.deal_id], created:r[C.created], date:(r[C.created]||'').slice(0,10),
          name:r[C.customer_name]||'', mobile:r[C.mobile]||'', email:r[C.email]||'',
          agent:r[C.agent]||'(No owner)', stage:r[C.deal_stage]||'(blank)', ls:r[C.lead_source]||'(blank)',
          trig:r[C.deal_trigger_event]||'(blank)', city:r[C.address_city]||'(Not captured)', citySrc:r[C.city_source]||'',
          pin:r[C.postal_code]||'(Not captured)', pinSrc:r[C.postal_source]||'',
          prob:(prob==null ? null : +prob), band:r[C.probability_band]||'Not captured',
          minSale:r[C.minimum_sale_date]||'', days:r[C.days_since_previous_sale], match:r[C.sale_match_method]||'None',
          reason:r[C.buyer_reason]||'', b:!!r[C.buyer_flag], s:!!r[C.subscriber_flag], v:!!r[C.visitor_flag],
          c:!!r[C.ctwa_flag], cat:r[C.deal_category]||'Other / Unclassified', rules:r[C.matched_rules]||''
        };
      });
      DI._fkey = null;
    });
};

/* ---------------------------------------------------------------- filtering */
DI.FILTER_DEFS = [
  ['agent','Agent / Deal Owner'],['stage','Deal Stage'],['ls','Lead Source'],['trig','Deal Trigger Event'],
  ['city','Address - City'],['pin','Postal Code'],['band','Probability Band']
];
DI.passNonDate = function(d){
  var F = DI.F;
  for (var i = 0; i < DI.FILTER_DEFS.length; i++){
    var k = DI.FILTER_DEFS[i][0], fk = k==='cat' ? 'cat' : k;
    if (F[k].length && F[k].indexOf(d[fk]) < 0) return false;
  }
  if (F.buyer === 'Buyer' && !d.b) return false;
  if (F.buyer === 'Non-Buyer' && d.b) return false;
  if (F.pmin !== '' || F.pmax !== ''){
    if (d.prob == null) return false;
    if (F.pmin !== '' && d.prob < +F.pmin) return false;
    if (F.pmax !== '' && d.prob > +F.pmax) return false;
  }
  return true;
};
DI.filtered = function(){
  var r = DI.range(), key = JSON.stringify([DI.F, r, DI.ROWS.length]);
  if (DI._fkey === key) return DI._f;
  var nd = DI.ROWS.filter(DI.passNonDate);
  DI._nondate = nd;
  DI._f = nd.filter(function(d){ return d.date >= r[0] && d.date <= r[1]; });
  // equal-length previous period, for KPI comparison
  var len = DI.dayDiff(r[0], r[1]) + 1, p1 = DI.addDays(r[0], -len), p0 = DI.addDays(r[0], -1);
  DI._prev = nd.filter(function(d){ return d.date >= p1 && d.date <= p0; });
  DI._prevRange = [p1, p0];
  DI._fkey = key;
  return DI._f;
};
DI.activeCount = function(){ var F = DI.F, n = 0;
  DI.FILTER_DEFS.forEach(function(f){ if (F[f[0]].length) n++; });
  if (F.buyer) n++; if (F.pmin !== '' || F.pmax !== '') n++; return n; };

/* ---------------------------------------------------------------- aggregation */
// Each category applies its own rule independently: Buyer + Non-Buyer = Total and
// CTWA + Subscriber + Visitor = Total; a deal can sit in one card of each pair.
DI.inCat = function(d, k){
  switch(k){ case 'Buyer': return d.b; case 'Non-Buyer': return !d.b; case 'Subscriber': return d.s;
             case 'Visitor': return d.v; case 'CTWA': return d.c; }
  return false;
};
DI.blank = function(){ return {n:0, Buyer:0, 'Non-Buyer':0, Subscriber:0, Visitor:0, CTWA:0, ps:0, pn:0, ids:{}}; };
DI.add = function(a, d){
  if (a.ids[d.id]) return;            // COUNT(DISTINCT deal_id)
  a.ids[d.id] = 1; a.n++;
  for (var i = 0; i < DI.CATS.length; i++) if (DI.inCat(d, DI.CATS[i].k)) a[DI.CATS[i].k]++;
  if (d.prob != null){ a.ps += d.prob; a.pn++; }
};
DI.total = function(rows){ var a = DI.blank(); rows.forEach(function(d){ DI.add(a, d); }); return a; };
DI.group = function(rows, keyFn){
  var m = {};
  rows.forEach(function(d){ var k = keyFn(d); (m[k] || (m[k] = DI.blank())).key = k; DI.add(m[k], d); });
  return Object.keys(m).map(function(k){ return m[k]; });
};
DI.avgP = function(a){ return a.pn ? a.ps / a.pn : null; };

/* ---------------------------------------------------------------- table component */
// spec: {id, cols:[{k,l,num,fmt(row)->html,v(row)->sort value}], rows, sort, desc, page, search, click(row), sel(row), total(row), csv}
DI.T = {};
DI.table = function(el, spec){
  var st = DI.T[spec.id] || (DI.T[spec.id] = {sort:spec.sort, desc:spec.desc !== false, page:0, q:''});
  if (spec.resetPage) st.page = 0;
  var val = function(c, r){ return c.v ? c.v(r) : r[c.k]; };
  var rows = spec.rows;
  if (st.q){
    var q = st.q.toLowerCase();
    rows = rows.filter(function(r){ return spec.cols.some(function(c){ var v = val(c, r); return v != null && String(v).toLowerCase().indexOf(q) >= 0; }); });
  }
  var sc = spec.cols.find(function(c){ return c.k === st.sort; });
  if (sc){
    rows = rows.slice().sort(function(a, b){
      var x = val(sc, a), y = val(sc, b);
      if (x == null || x === '') return 1; if (y == null || y === '') return -1;
      var r = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y));
      return st.desc ? -r : r;
    });
  }
  var ps = spec.pageSize || 25, pages = Math.max(1, Math.ceil(rows.length / ps));
  if (st.page >= pages) st.page = pages - 1;
  var view = rows.slice(st.page * ps, st.page * ps + ps);
  var h = '<div class="tbar">' + (spec.search === false ? '' :
          '<input type="search" placeholder="Search…" value="' + DI.esc(st.q) + '" data-q>') +
          '<span class="cnt">' + DI.n(rows.length) + ' rows</span><span class="spacer" style="flex:1"></span>' +
          '<button class="btn sm" data-csv>⤓ CSV</button></div>';
  h += '<div class="tbl-wrap" style="' + (spec.maxH ? 'max-height:' + spec.maxH + 'px' : '') + '"><table><thead><tr>';
  spec.cols.forEach(function(c){
    h += '<th class="' + (c.num ? 'num' : '') + '" data-k="' + c.k + '" title="' + DI.esc(c.title || 'Sort') + '">' + DI.esc(c.l) +
         (st.sort === c.k ? '<span class="ar">' + (st.desc ? '▼' : '▲') + '</span>' : '') + '</th>';
  });
  h += '</tr></thead><tbody>';
  if (!view.length) h += '<tr><td colspan="' + spec.cols.length + '" class="muted" style="text-align:center;padding:22px">No deals match the current filters.</td></tr>';
  view.forEach(function(r, i){
    h += '<tr data-i="' + i + '" class="' + (spec.click ? 'click ' : '') + (spec.sel && spec.sel(r) ? 'sel' : '') + '">';
    spec.cols.forEach(function(c){ h += '<td class="' + (c.num ? 'num' : '') + '">' + (c.fmt ? c.fmt(r) : DI.esc(r[c.k])) + '</td>'; });
    h += '</tr>';
  });
  if (spec.total){ var t = spec.total; h += '<tr class="tot">';
    spec.cols.forEach(function(c){ h += '<td class="' + (c.num ? 'num' : '') + '">' + (c.fmt ? c.fmt(t) : DI.esc(t[c.k])) + '</td>'; }); h += '</tr>'; }
  h += '</tbody></table></div>';
  if (pages > 1) h += '<div class="pager">Page ' + (st.page + 1) + ' of ' + pages +
    ' <button class="btn sm" data-pg="-1"' + (st.page ? '' : ' disabled') + '>‹ Prev</button>' +
    '<button class="btn sm" data-pg="1"' + (st.page < pages - 1 ? '' : ' disabled') + '>Next ›</button></div>';
  el.innerHTML = h;
  var again = function(){ var s2 = Object.assign({}, spec); s2.resetPage = false; DI.table(el, s2); };
  el.querySelectorAll('th').forEach(function(th){ th.onclick = function(){
    var k = th.dataset.k; if (st.sort === k) st.desc = !st.desc; else { st.sort = k; st.desc = true; } again(); }; });
  var qi = el.querySelector('[data-q]');
  if (qi) qi.oninput = function(){ st.q = qi.value; st.page = 0; again(); var n = el.querySelector('[data-q]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
  el.querySelectorAll('[data-pg]').forEach(function(b){ b.onclick = function(){ st.page += +b.dataset.pg; again(); }; });
  if (spec.click) el.querySelectorAll('tbody tr[data-i]').forEach(function(tr){ tr.onclick = function(){ spec.click(view[+tr.dataset.i]); }; });
  el.querySelector('[data-csv]').onclick = function(){
    var cols = spec.csv || spec.cols.map(function(c){ return {l:c.l, v:function(r){ return c.csvV ? c.csvV(r) : val(c, r); }}; });
    var lines = [cols.map(function(c){ return '"' + c.l + '"'; }).join(',')];
    rows.forEach(function(r){ lines.push(cols.map(function(c){ var v = c.v(r); return v == null ? '' : '"' + String(v).replace(/"/g, '""') + '"'; }).join(',')); });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], {type:'text/csv'}));
    a.download = (spec.id || 'deals') + '_' + DI.range().join('_') + '.csv'; a.click();
  };
};

/* standard category columns for any aggregate row */
DI.catCols = function(opt){
  opt = opt || {};
  var cols = [{k:'n', l:'Total Deals', num:true, fmt:function(a){ return DI.n(a.n); }}];
  DI.CATS.forEach(function(c){ cols.push({k:c.k, l:c.k === 'Non-Buyer' ? 'Non-Buyers' : c.k + (c.k === 'CTWA' ? '' : 's'), num:true,
    fmt:function(a){ return DI.n(a[c.k]); }, v:function(a){ return a[c.k]; }}); });
  if (!opt.noPct) ['Buyer','Subscriber','Visitor','CTWA'].forEach(function(k){ cols.push({k:k + '%', l:k + ' %', num:true,
    v:function(a){ return DI.pv(a[k], a.n); }, fmt:function(a){ return DI.p(a[k], a.n); }}); });
  if (!opt.noProb) cols.push({k:'avgp', l:'Avg Probability', num:true, v:DI.avgP, fmt:function(a){ var v = DI.avgP(a); return v == null ? '<span class="muted">—</span>' : v.toFixed(1) + '%'; }});
  return cols;
};
DI.tag = function(k){ return '<span class="tag"><span class="sw" style="background:' + DI.catColor(k) + '"></span>' + DI.esc(k) + '</span>'; };

/* ---------------------------------------------------------------- tooltip */
DI.tip = function(html, ev){
  var t = document.getElementById('tip'); if (!html){ t.style.display = 'none'; return; }
  t.innerHTML = html; t.style.display = 'block';
  var x = ev.pageX + 14, y = ev.pageY + 14, w = t.offsetWidth;
  if (x + w > window.scrollX + document.documentElement.clientWidth - 8) x = ev.pageX - w - 14;
  t.style.left = x + 'px'; t.style.top = y + 'px';
};
DI.tipRows = function(title, items){
  return '<div class="tt">' + DI.esc(title) + '</div>' + items.map(function(i){
    return '<div class="tr"><span>' + (i.c ? '<span class="sw" style="background:' + i.c + '"></span>' : '') + DI.esc(i.l) + '</span><b class="tnum">' + i.v + '</b></div>'; }).join('');
};

/* ---------------------------------------------------------------- charts */
// Multi-series line chart, one y-axis, crosshair + tooltip. series:[{name,color,values[]}]
DI.lineChart = function(el, labels, series, opt){
  opt = opt || {};
  var W = Math.max(320, el.clientWidth || 600), H = opt.h || 240, L = 44, R = 14, T = 12, B = 28;
  var hidden = el._hidden || (el._hidden = {});
  var vis = series.filter(function(s){ return !hidden[s.name]; });
  var max = 1; vis.forEach(function(s){ s.values.forEach(function(v){ if (v > max) max = v; }); });
  var step = Math.pow(10, Math.floor(Math.log10(max))); var nice = Math.ceil(max / step) * step; if (nice / step <= 2) step /= 2; nice = Math.ceil(max / step) * step;
  var x = function(i){ return L + (labels.length < 2 ? (W - L - R) / 2 : i * (W - L - R) / (labels.length - 1)); };
  var y = function(v){ return T + (H - T - B) * (1 - v / nice); };
  var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" height="' + H + '">';
  for (var g = 0; g <= nice; g += step){ s += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g) + '" y2="' + y(g) + '"/><text x="' + (L - 6) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + DI.n(g) + '</text>'; }
  var every = Math.max(1, Math.ceil(labels.length / Math.floor((W - L - R) / 62)));
  labels.forEach(function(l, i){ if (i % every === 0 || i === labels.length - 1) s += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + DI.esc(opt.fmtX ? opt.fmtX(l) : l) + '</text>'; });
  vis.forEach(function(se){
    var d = se.values.map(function(v, i){ return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join('');
    if (opt.area && se === vis[0]) s += '<path d="' + d + 'L' + x(labels.length - 1) + ' ' + y(0) + 'L' + x(0) + ' ' + y(0) + 'Z" fill="' + se.color + '" opacity=".08"/>';
    s += '<path d="' + d + '" fill="none" stroke="' + se.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    if (labels.length <= 31) se.values.forEach(function(v, i){ s += '<circle cx="' + x(i) + '" cy="' + y(v) + '" r="3" fill="' + se.color + '" stroke="var(--surface)" stroke-width="1.5"/>'; });
  });
  s += '<line id="xh" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--muted)" stroke-dasharray="3 3" style="display:none"/>';
  s += '<rect x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent" data-hit/></svg>';
  var leg = '<div class="legend">' + series.map(function(se){ return '<span data-s="' + DI.esc(se.name) + '" class="' + (hidden[se.name] ? 'off' : '') + '"><span class="sw" style="background:' + se.color + '"></span>' + DI.esc(se.name) + '</span>'; }).join('') + '</div>';
  el.innerHTML = leg + '<div class="chart">' + s + '</div>';
  el.querySelectorAll('.legend [data-s]').forEach(function(sp){ sp.onclick = function(){ hidden[sp.dataset.s] = !hidden[sp.dataset.s]; DI.lineChart(el, labels, series, opt); }; });
  var hit = el.querySelector('[data-hit]'), xh = el.querySelector('#xh'), svg = el.querySelector('svg');
  hit.onmousemove = function(ev){
    var rc = svg.getBoundingClientRect(), px = (ev.clientX - rc.left) * W / rc.width;
    var i = labels.length < 2 ? 0 : Math.round((px - L) / ((W - L - R) / (labels.length - 1))); i = Math.max(0, Math.min(labels.length - 1, i));
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.style.display = '';
    DI.tip(DI.tipRows(opt.fmtTip ? opt.fmtTip(labels[i]) : labels[i], vis.map(function(se){ return {l:se.name, c:se.color, v:DI.n(se.values[i])}; })), ev);
  };
  hit.onmouseleave = function(){ xh.style.display = 'none'; DI.tip(null); };
};

// Horizontal bars. items:[{label,value,color,tip,click}]
DI.hbars = function(el, items, opt){
  opt = opt || {};
  var max = Math.max.apply(null, items.map(function(i){ return i.value; }).concat([1]));
  el.innerHTML = '<div class="chart">' + items.map(function(it, k){
    var w = Math.max(it.value ? 0.6 : 0, it.value * 100 / max);
    return '<div data-k="' + k + '" style="display:grid;grid-template-columns:' + (opt.lw || 130) + 'px 1fr auto;gap:10px;align-items:center;padding:4px 0;' + (it.click ? 'cursor:pointer' : '') + '">' +
      '<div style="font-size:12.5px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + DI.esc(it.label) + '">' + DI.esc(it.label) + '</div>' +
      '<div style="height:14px;background:var(--surface-3);border-radius:0 4px 4px 0"><div style="height:14px;width:' + w + '%;background:' + it.color + ';border-radius:0 4px 4px 0"></div></div>' +
      '<div class="tnum" style="text-align:right;font-size:12.5px;font-weight:600">' + (it.text || DI.n(it.value)) + '</div></div>';
  }).join('') + '</div>';
  el.querySelectorAll('[data-k]').forEach(function(r){ var it = items[+r.dataset.k];
    r.onmousemove = function(ev){ if (it.tip) DI.tip(it.tip, ev); }; r.onmouseleave = function(){ DI.tip(null); };
    if (it.click) r.onclick = it.click; });
};

// Donut with centre total + legend. items:[{label,value,color}]
DI.donut = function(el, items, centre){
  var tot = items.reduce(function(s, i){ return s + i.value; }, 0), R = 70, r = 46, cx = 90, cy = 90, a0 = -Math.PI / 2;
  var s = '<svg viewBox="0 0 180 180" style="width:180px;height:180px;flex:0 0 180px">';
  if (!tot) s += '<circle cx="90" cy="90" r="58" fill="none" stroke="var(--surface-3)" stroke-width="24"/>';
  items.forEach(function(it, k){
    if (!it.value) return;
    var a1 = a0 + 2 * Math.PI * it.value / tot - (it.value === tot ? 0.0001 : 0), lg = a1 - a0 > Math.PI ? 1 : 0;
    var p = function(rad, a){ return (cx + rad * Math.cos(a)).toFixed(2) + ' ' + (cy + rad * Math.sin(a)).toFixed(2); };
    s += '<path data-k="' + k + '" d="M' + p(R, a0) + 'A' + R + ' ' + R + ' 0 ' + lg + ' 1 ' + p(R, a1) + 'L' + p(r, a1) + 'A' + r + ' ' + r + ' 0 ' + lg + ' 0 ' + p(r, a0) + 'Z" fill="' + it.color + '" stroke="var(--surface)" stroke-width="2"/>';
    a0 = a1;
  });
  s += '<text x="90" y="88" text-anchor="middle" style="font-size:22px;font-weight:700;fill:var(--ink);font-family:Georgia,serif">' + DI.n(tot) + '</text>' +
       '<text x="90" y="106" text-anchor="middle" style="font-size:10.5px;fill:var(--muted)">' + DI.esc(centre || 'deals') + '</text></svg>';
  var leg = '<div style="display:flex;flex-direction:column;gap:8px;font-size:12.5px;min-width:0">' + items.map(function(it){
    return '<div style="display:flex;gap:8px;align-items:center"><span class="sw" style="background:' + it.color + '"></span><span style="color:var(--ink-2)">' + DI.esc(it.label) +
      '</span><b class="tnum" style="margin-left:auto;padding-left:12px">' + DI.n(it.value) + '</b><span class="muted tnum" style="width:48px;text-align:right">' + DI.p(it.value, tot) + '</span></div>'; }).join('') + '</div>';
  el.innerHTML = '<div style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">' + s + leg + '</div>';
  el.querySelectorAll('path[data-k]').forEach(function(pth){ var it = items[+pth.dataset.k];
    pth.onmousemove = function(ev){ DI.tip(DI.tipRows(it.label, [{l:'Deals', v:DI.n(it.value)}, {l:'Share', v:DI.p(it.value, tot)}]), ev); };
    pth.onmouseleave = function(){ DI.tip(null); }; });
};

// Vertical grouped bars by band. groups:[{label, vals:[{name,color,value}]}]
DI.vbars = function(el, groups, opt){
  opt = opt || {};
  var W = Math.max(320, el.clientWidth || 500), H = opt.h || 220, L = 40, R = 10, T = 10, B = 28;
  var max = 1; groups.forEach(function(g){ g.vals.forEach(function(v){ if (v.value > max) max = v.value; }); });
  var gw = (W - L - R) / groups.length, nb = groups[0] ? groups[0].vals.length : 1, bw = Math.min(26, (gw - 16) / nb - 2);
  var y = function(v){ return T + (H - T - B) * (1 - v / max); };
  var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" height="' + H + '">';
  [0, .5, 1].forEach(function(f){ s += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(max * f) + '" y2="' + y(max * f) + '"/><text x="' + (L - 6) + '" y="' + (y(max * f) + 4) + '" text-anchor="end">' + DI.n(max * f) + '</text>'; });
  groups.forEach(function(g, gi){
    var x0 = L + gi * gw + (gw - nb * (bw + 2)) / 2;
    g.vals.forEach(function(v, vi){ var h = (H - T - B) - (y(v.value) - T);
      s += '<rect data-g="' + gi + '" x="' + (x0 + vi * (bw + 2)) + '" y="' + y(v.value) + '" width="' + bw + '" height="' + Math.max(0, h) + '" rx="3" fill="' + v.color + '"/>'; });
    s += '<text x="' + (L + gi * gw + gw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + DI.esc(g.label) + '</text>';
  });
  s += '</svg>';
  var leg = groups[0] ? '<div class="legend">' + groups[0].vals.map(function(v){ return '<span><span class="sw" style="background:' + v.color + '"></span>' + DI.esc(v.name) + '</span>'; }).join('') + '</div>' : '';
  el.innerHTML = leg + '<div class="chart">' + s + '</div>';
  el.querySelectorAll('rect[data-g]').forEach(function(rc){ var g = groups[+rc.dataset.g];
    rc.onmousemove = function(ev){ DI.tip(DI.tipRows(g.label, g.vals.map(function(v){ return {l:v.name, c:v.color, v:DI.n(v.value)}; })), ev); };
    rc.onmouseleave = function(){ DI.tip(null); };
    if (opt.click) { rc.style.cursor = 'pointer'; rc.onclick = function(){ opt.click(g); }; } });
};
