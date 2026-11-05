/* Zoho Deal Intelligence — views. Every render reads DI.filtered(), so the date preset,
   counting mode and every advanced / click filter flow into all KPIs, charts and tables. */
'use strict';
(function(){
var DI = window.DI, F = DI.F, $ = function(id){ return document.getElementById(id); };
var TABS = [
  {k:'overview', l:'Overview'},
  {k:'Buyer', l:'Buyers', cat:true}, {k:'Subscriber', l:'Subscribers', cat:true},
  {k:'Visitor', l:'Visitors', cat:true}, {k:'CTWA', l:'CTWA', cat:true},
  {k:'detail', l:'Detailed Deals'}, {k:'dq', l:'Data Quality'}, {k:'docs', l:'Documentation'}
];
var tab = 'overview';
try { tab = localStorage.getItem('di.tab') || 'overview'; } catch(e){}
if (!TABS.some(function(t){ return t.k === tab; })) tab = 'overview';
var catGroup = {}, trendGran = 'day';

/* ---------------------------------------------------------------- helpers */
function card(title, body, opt){ opt = opt || {};
  return '<div class="card"' + (opt.id ? ' id="' + opt.id + '"' : '') + '><h3>' + title + (opt.hint ? ' <span class="hint">' + opt.hint + '</span>' : '') +
         (opt.rt ? '<span class="rt">' + opt.rt + '</span>' : '') + '</h3>' + body + '</div>'; }
function toggle(k, v){ F[k] = (F[k].length === 1 && F[k][0] === v) ? [] : [v]; rerender(); }
function days(r){ var out = [], d = r[0]; while (d <= r[1] && out.length < 800){ out.push(d); d = DI.addDays(d, 1); } return out; }
function bucket(date, g){ if (g === 'month') return date.slice(0, 7);
  if (g === 'week'){ var dow = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7; return DI.addDays(date, -dow); } return date; }
function buckets(r, g){ var seen = {}, out = []; days(r).forEach(function(d){ var b = bucket(d, g); if (!seen[b]){ seen[b] = 1; out.push(b); } }); return out; }
function hours(){ var h = []; for (var i = 0; i < 24; i++) h.push((i < 10 ? '0' : '') + i); return h; }
function fmtBucket(b, g){ if (g === 'hour') return b + ':00'; return g === 'month' ? new Date(b + '-01T00:00:00Z').toLocaleDateString('en-GB', {month:'short', year:'numeric', timeZone:'UTC'}) : (g === 'week' ? 'Wk ' + DI.fmtShort(b) : DI.fmtShort(b)); }
function deltaHtml(cur, prev){
  if (prev == null) return '';
  var d = cur - prev, cls = d > 0 ? 'up' : d < 0 ? 'down' : '';
  return '<span class="delta ' + cls + '" title="Previous period ' + DI.esc(DI.fmtDate(DI._prevRange[0])) + ' – ' + DI.esc(DI.fmtDate(DI._prevRange[1])) + ': ' + DI.n(prev) + '">' +
         (d ? DI.n(Math.abs(d)) : 'no change') + ' vs prev</span>';
}
function median(a){ if (!a.length) return null; a = a.slice().sort(function(x, y){ return x - y; }); var m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function modeNote(){
  return 'Each card applies its own rule: <b>Buyers + Non-Buyers = Total</b> and <b>CTWA + Subscribers + Visitors = Total</b>. A deal is counted in one card of each pair (e.g. a WhatsApp deal from an existing customer is both CTWA and Buyer).';
}

/* ---------------------------------------------------------------- KPIs */
function kpis(rows){
  var t = DI.total(rows), p = DI.total(DI._prev);
  var cards = [{k:'Total', l:'Total Deals', v:t.n, pv:p.n, col:'--c-total'}].concat(DI.CATS.map(function(c){
    return {k:c.k, l:c.k === 'Non-Buyer' ? 'Non-Buyers' : c.k + (c.k === 'CTWA' ? '' : 's'), v:t[c.k], pv:p[c.k], col:c.col, pct:true}; }));
  return '<div class="kpis">' + cards.map(function(c){
    return '<div class="kpi" style="--kc:var(' + c.col + ')"><div class="lbl"><span class="sw" style="background:var(' + c.col + ')"></span>' + c.l + '</div>' +
      '<div class="val">' + DI.n(c.v) + '</div><div class="row">' + (c.pct ? '<span class="pct">' + DI.p(c.v, t.n) + '</span><span>of deals</span>' : '<span>distinct Deal IDs</span>') + '</div>' +
      '<div class="row">' + deltaHtml(c.v, c.pv) + '</div></div>'; }).join('') + '</div>';
}

/* ---------------------------------------------------------------- overview */
function overview(rows){
  var r = DI.range(), t = DI.total(rows);
  var h = kpis(rows) + '<div class="note">' + modeNote() + '</div>';
  h += '<div class="grid g3">' +
    card('Deal trend', '<div id="chTrend"></div>', {rt:'<div class="seg small" id="granSeg"><button data-g="day">Day</button><button data-g="week">Week</button><button data-g="month">Month</button></div>'}) +
    card('Category comparison', '<div id="chCats"></div><div class="sub" style="margin:10px 0 0">Share of ' + DI.n(t.n) + ' deals in range.</div>') + '</div><div style="height:14px"></div>';
  h += '<div class="grid g2">' +
    card('Buyer vs Non-Buyer', '<div id="chBuyer"></div>', {hint:'first Marketing Sale vs deal date'}) +
    card('CTWA vs Subscriber vs Visitor', '<div id="chSrc"></div>', {hint:'Deal Trigger Event'}) + '</div><div style="height:14px"></div>';
  h += card('Date-wise analysis', '<div id="tDate"></div>', {hint:'IST calendar day'});
  h += '<div class="grid g3">' + card('Agent-wise performance', '<div id="tAgent"></div>', {hint:'click a row to filter the whole dashboard'}) +
       card('Deals by agent', '<div id="chAgent"></div>') + '</div><div style="height:14px"></div>';
  h += '<div class="grid g2">' + card('City-wise analysis', '<div id="tCity"></div>', {hint:'Address - City · click to filter'}) +
       card('Postal-code analysis', '<div id="tPin"></div>', {hint:'Address - Zip · click to filter'}) + '</div><div style="height:14px"></div>';
  h += '<div class="grid g3">' + card('Probability Score analysis', '<div id="tBand"></div>', {hint:'Zoho Probability_Score (%) · click a score to filter'}) +
       card('Deals by probability score', '<div id="chBand"></div>') + '</div>';
  $('main').innerHTML = h;

  // trend
  var seg = $('granSeg'); seg.querySelectorAll('button').forEach(function(b){ b.classList.toggle('on', b.dataset.g === trendGran);
    b.onclick = function(){ trendGran = b.dataset.g; overview(DI.filtered()); }; });
  var single = r[0] === r[1], gran = single ? 'hour' : trendGran;
  if (single) seg.style.display = 'none';
  var bk = single ? hours() : buckets(r, gran), idx = {}; bk.forEach(function(b, i){ idx[b] = i; });
  var ser = [{name:'Total Deals', color:DI.color('--c-total'), values:bk.map(function(){ return 0; })}].concat(DI.CATS.map(function(c){
    return {name:c.k, color:DI.color(c.col), values:bk.map(function(){ return 0; })}; }));
  rows.forEach(function(d){ var i = idx[single ? d.created.slice(11, 13) : bucket(d.date, gran)]; if (i == null) return; ser[0].values[i]++;
    DI.CATS.forEach(function(c, k){ if (DI.inCat(d, c.k)) ser[k + 1].values[i]++; }); });
  DI.lineChart($('chTrend'), bk, ser, {area:true, fmtX:function(b){ return fmtBucket(b, gran); }, fmtTip:function(b){ return fmtBucket(b, gran); }});
  if (single) $('chTrend').insertAdjacentHTML('beforeend', '<div class="sub" style="margin:6px 0 0">Single day selected — deals by hour of creation (IST).</div>');

  DI.hbars($('chCats'), DI.CATS.map(function(c){ return {label:c.k, value:t[c.k], color:DI.color(c.col), text:DI.n(t[c.k]) + ' · ' + DI.p(t[c.k], t.n),
    tip:DI.tipRows(c.k, [{l:'Deals', v:DI.n(t[c.k])}, {l:'% of total', v:DI.p(t[c.k], t.n)}])}; }), {lw:90});

  var reasons = ['Sale before deal', 'First sale on deal date', 'First sale after deal', 'No matching sale'], rc = {};
  rows.forEach(function(d){ rc[d.reason] = (rc[d.reason] || 0) + 1; });
  DI.donut($('chBuyer'), [{label:'Buyer (sale before deal)', value:rows.filter(function(d){ return d.b; }).length, color:DI.color('--c-buyer')},
    {label:'Non-Buyer', value:rows.filter(function(d){ return !d.b; }).length, color:DI.color('--c-nonbuyer')}]);
  $('chBuyer').insertAdjacentHTML('beforeend', '<div class="sub" style="margin:12px 0 0">Non-Buyer breakdown: ' + reasons.slice(1).map(function(k){ return DI.esc(k) + ' <b>' + DI.n(rc[k] || 0) + '</b>'; }).join(' · ') + '</div>');
  DI.donut($('chSrc'), ['CTWA', 'Subscriber', 'Visitor'].map(function(k){ return {label:k, value:t[k], color:DI.catColor(k)}; }));

  // date table (every day in range, zero days included)
  var dg = {}; DI.group(rows, function(d){ return d.date; }).forEach(function(a){ dg[a.key] = a; });
  var drows = days(r).map(function(d){ var a = dg[d] || DI.blank(); a.key = d; return a; });
  DI.table($('tDate'), {id:'date', rows:drows, sort:'key', cols:[{k:'key', l:'Date', fmt:function(a){ return a.key ? DI.esc(DI.fmtDate(a.key)) : 'Total'; }}]
    .concat(DI.catCols({noProb:true})), total:Object.assign(t, {key:''}), search:false, pageSize:31, resetPage:true});
  groupTable('tAgent', 'agent', rows, 'Agent', 'agent', t);
  var ag = DI.group(rows, function(d){ return d.agent; }).sort(function(a, b){ return b.n - a.n; }).slice(0, 12);
  DI.hbars($('chAgent'), ag.map(function(a){ return {label:a.key, value:a.n, color:DI.color('--c-total'), click:function(){ toggle('agent', a.key); },
    tip:DI.tipRows(a.key, [{l:'Deals', v:DI.n(a.n)}].concat(DI.CATS.map(function(c){ return {l:c.k, c:DI.color(c.col), v:DI.n(a[c.k])}; })))}; }), {lw:120});
  groupTable('tCity', 'city', rows, 'City', 'city', t);
  pinTable('tPin', rows);
  // Probability Score by its actual Zoho value (60 / 70 / 80 / 90 / 100 always listed; 0 and Not captured when present)
  var sg = {};
  DI.group(rows, function(d){ return d.prob == null ? 'NC' : String(d.prob); }).forEach(function(a){ sg[a.key] = a; });
  var scores = ['60', '70', '80', '90', '100'];
  Object.keys(sg).forEach(function(k){ if (scores.indexOf(k) < 0 && k !== 'NC') scores.push(k); });
  scores.sort(function(a, b){ return +a - +b; }); if (sg.NC) scores.push('NC');
  var slabel = function(k){ return k === 'NC' ? 'Not captured' : k + '%'; };
  var srows = scores.map(function(k){ var a = sg[k] || DI.blank(); a.key = k; return a; });
  var isSel = function(k){ return k === 'NC' ? F.band.length === 1 && F.band[0] === 'Not captured' : (F.pmin !== '' && +F.pmin === +k && +F.pmax === +k); };
  var pickScore = function(k){
    if (isSel(k)){ F.pmin = F.pmax = ''; F.band = []; }
    else if (k === 'NC'){ F.pmin = F.pmax = ''; F.band = ['Not captured']; }
    else { F.band = []; F.pmin = F.pmax = k; }
    rerender();
  };
  DI.table($('tBand'), {id:'score', rows:srows, sort:'key', desc:false, search:false, total:Object.assign({}, t, {key:'Total'}),
    cols:[{k:'key', l:'Probability Score', v:function(a){ return a.key === 'NC' ? 999 : a.key === 'Total' ? 1000 : +a.key; },
           fmt:function(a){ return a.key === 'Total' ? 'Total' : '<b>' + DI.esc(slabel(a.key)) + '</b>'; }},
          DI.catCols({noProb:true})[0],
          {k:'share', l:'% of Deals', num:true, v:function(a){ return DI.pv(a.n, t.n); }, fmt:function(a){ return DI.p(a.n, t.n); }}]
      .concat(DI.catCols({noProb:true}).slice(1, 6))
      .concat([{k:'Buyer%', l:'Buyer %', num:true, v:function(a){ return DI.pv(a.Buyer, a.n); }, fmt:function(a){ return DI.p(a.Buyer, a.n); }},
               {k:'CTWA%', l:'CTWA %', num:true, v:function(a){ return DI.pv(a.CTWA, a.n); }, fmt:function(a){ return DI.p(a.CTWA, a.n); }}]),
    click:function(a){ pickScore(a.key); }, sel:function(a){ return isSel(a.key); }});
  DI.vbars($('chBand'), srows.filter(function(a){ return a.key !== 'NC' || a.n; }).map(function(a){ return {label:slabel(a.key), key:a.key, vals:[{name:'Total', color:DI.color('--c-total'), value:a.n}]
    .concat(DI.CATS.filter(function(c){ return c.k !== 'Non-Buyer'; }).map(function(c){ return {name:c.k, color:DI.color(c.col), value:a[c.k]}; }))}; }), {click:function(g){ pickScore(g.key); }});
}
function groupTable(elId, field, rows, label, fkey, tot){
  DI.table($(elId), {id:elId, rows:DI.group(rows, function(d){ return d[field]; }), sort:'n', resetPage:true,
    cols:[{k:'key', l:label}].concat(DI.catCols()), total:Object.assign({}, tot, {key:'Total'}),
    click:function(a){ toggle(fkey, a.key); }, sel:function(a){ return F[fkey].indexOf(a.key) >= 0; }});
}
function pinTable(elId, rows){
  var g = DI.group(rows, function(d){ return d.pin; }), cityOf = {};
  rows.forEach(function(d){ var m = cityOf[d.pin] || (cityOf[d.pin] = {}); m[d.city] = (m[d.city] || 0) + 1; });
  g.forEach(function(a){ var m = cityOf[a.key]; a.city = Object.keys(m).sort(function(x, y){ return m[y] - m[x]; })[0]; });
  DI.table($(elId), {id:elId, rows:g, sort:'n', resetPage:true,
    cols:[{k:'key', l:'Postal Code'}, {k:'city', l:'City'}].concat(DI.catCols({noPct:true})),
    click:function(a){ toggle('pin', a.key); }, sel:function(a){ return F.pin.indexOf(a.key) >= 0; }});
}

/* ---------------------------------------------------------------- category tabs */
var GROUPS = [['date', 'Date'], ['agent', 'Agent'], ['city', 'Address - City'], ['pin', 'Postal Code'], ['prob', 'Probability Score']];
function catTab(cat, rows){
  var t = DI.total(rows), sel = rows.filter(function(d){ return DI.inCat(d, cat); });
  var probs = sel.filter(function(d){ return d.prob != null; }).map(function(d){ return d.prob; });
  var avgp = probs.length ? probs.reduce(function(a, b){ return a + b; }, 0) / probs.length : null;
  var col = DI.CATS.find(function(c){ return c.k === cat; }).col;
  var DEF = {Buyer:'First Marketing Sale date strictly <b>before</b> the deal\'s IST created date (mobile → email → name fallback).',
    Subscriber:'Deal Trigger Event contains neither <b>nitro</b> nor <b>whatsapp</b> (productview, signup, pdp_store, atc, chat, blank, …).',
    Visitor:'Deal Trigger Event contains <b>nitro</b> (NitroProductView, NitroAddToCart, …).',
    CTWA:'Deal Trigger Event contains <b>whatsapp</b> (WhatsApp, Whatsapp Chat, …).'};
  var extra = [];
  if (cat === 'Buyer'){
    var dd = sel.map(function(d){ return d.days; }).filter(function(v){ return v != null; });
    extra.push(['Median days since first sale', DI.n(median(dd))]);
    var mm = {}; sel.forEach(function(d){ mm[d.match] = (mm[d.match] || 0) + 1; });
    extra.push(['Matched by', Object.keys(mm).map(function(k){ return DI.esc(k) + ' ' + DI.n(mm[k]); }).join(' · ') || '—']);
  } else {
    var tg = {}; sel.forEach(function(d){ var k = d.trig; tg[k] = (tg[k] || 0) + 1; });
    extra.push(['Trigger values', Object.keys(tg).sort(function(a, b){ return tg[b] - tg[a]; }).slice(0, 4).map(function(k){ return DI.esc(k) + ' ' + DI.n(tg[k]); }).join(' · ') || '—']);
  }
  var h = '<div class="h2">' + DI.esc(TABS.find(function(x){ return x.k === cat; }).l) + '</div><div class="sub">' + DEF[cat] + '</div>';
  h += '<div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">' +
    [['Total Deals', DI.n(t.n), '--c-total'], [cat + ' Deals', DI.n(sel.length), col], [cat + ' %', DI.p(sel.length, t.n), col],
     ['Avg Probability (' + cat + ')', avgp == null ? '—' : avgp.toFixed(1) + '%', col]].map(function(k){
      return '<div class="kpi" style="--kc:var(' + k[2] + ')"><div class="lbl">' + DI.esc(k[0]) + '</div><div class="val">' + k[1] + '</div></div>'; }).join('') +
    extra.map(function(e){ return '<div class="kpi" style="--kc:var(' + col + ')"><div class="lbl">' + DI.esc(e[0]) + '</div><div class="row" style="margin-top:10px;font-size:12.5px">' + e[1] + '</div></div>'; }).join('') + '</div>';
  var g = catGroup[cat] || 'date';
  h += card(cat + ' by ' + GROUPS.find(function(x){ return x[0] === g; })[1].toLowerCase(), '<div id="cTrend"></div><div id="cGroup" style="margin-top:12px"></div>',
    {rt:'<div class="seg small" id="grpSeg">' + GROUPS.map(function(x){ return '<button data-g="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>'});
  h += card(cat + ' deals — detail', '<div id="cDetail"></div>', {hint:DI.n(sel.length) + ' deals'});
  $('main').innerHTML = h;
  $('grpSeg').querySelectorAll('button').forEach(function(b){ b.classList.toggle('on', b.dataset.g === g); b.onclick = function(){ catGroup[cat] = b.dataset.g; render(); }; });

  var keyFn = {date:function(d){ return d.date; }, agent:function(d){ return d.agent; }, city:function(d){ return d.city; }, pin:function(d){ return d.pin; },
               prob:function(d){ return d.prob == null ? 'Not captured' : d.prob; }}[g];
  var m = {};
  rows.forEach(function(d){ var k = keyFn(d), a = m[k] || (m[k] = {key:k, n:0, c:0, ps:0, pn:0});
    a.n++; if (DI.inCat(d, cat)){ a.c++; if (d.prob != null){ a.ps += d.prob; a.pn++; } } });
  if (g === 'date') days(DI.range()).forEach(function(d){ if (!m[d]) m[d] = {key:d, n:0, c:0, ps:0, pn:0}; });
  var grows = Object.keys(m).map(function(k){ return m[k]; });
  var fk = {agent:'agent', city:'city', pin:'pin'}[g];
  if (g === 'date'){
    var ds = days(DI.range()), one = ds.length === 1, xs = one ? hours() : ds, tv = xs.map(function(){ return 0; }), cv = tv.slice(), xi = {};
    xs.forEach(function(x, i){ xi[x] = i; });
    rows.forEach(function(d){ var i = xi[one ? d.created.slice(11, 13) : d.date]; if (i == null) return; tv[i]++; if (DI.inCat(d, cat)) cv[i]++; });
    DI.lineChart($('cTrend'), xs, [{name:'Total Deals', color:DI.color('--c-total'), values:tv}, {name:cat + ' Deals', color:DI.color(col), values:cv}],
      {h:200, fmtX:one ? function(h){ return h + ':00'; } : DI.fmtShort, fmtTip:one ? function(h){ return h + ':00 IST'; } : DI.fmtDate});
  }
  DI.table($('cGroup'), {id:'cg_' + cat + '_' + g, rows:grows, sort:g === 'date' ? 'key' : (g === 'prob' ? 'key' : 'c'), desc:g !== 'prob', resetPage:true,
    cols:[{k:'key', l:GROUPS.find(function(x){ return x[0] === g; })[1], v:function(a){ return a.key; },
           fmt:function(a){ return g === 'date' ? DI.esc(DI.fmtDate(a.key)) : g === 'prob' && a.key !== 'Not captured' ? a.key + '%' : DI.esc(a.key); }},
      {k:'n', l:'Total Deals', num:true, fmt:function(a){ return DI.n(a.n); }},
      {k:'c', l:cat + ' Deals', num:true, fmt:function(a){ return DI.n(a.c); }},
      {k:'pc', l:cat + ' %', num:true, v:function(a){ return DI.pv(a.c, a.n); }, fmt:function(a){ return DI.p(a.c, a.n); }},
      {k:'ap', l:'Avg Probability', num:true, v:function(a){ return a.pn ? a.ps / a.pn : null; }, fmt:function(a){ return a.pn ? (a.ps / a.pn).toFixed(1) + '%' : '<span class="muted">—</span>'; }}],
    total:{key:'Total', n:t.n, c:sel.length, ps:probs.reduce(function(a, b){ return a + b; }, 0), pn:probs.length},
    click:fk ? function(a){ toggle(fk, a.key); } : null, sel:fk ? function(a){ return F[fk].indexOf(a.key) >= 0; } : null});
  dealTable($('cDetail'), sel, 'cd_' + cat, cat === 'Buyer');
}

/* ---------------------------------------------------------------- detail */
function dealTable(el, rows, id, buyerFirst){
  var cols = [
    {k:'id', l:'Deal ID', fmt:function(d){ return '<span class="tnum">' + DI.esc(d.id) + '</span>'; }},
    {k:'created', l:'Deal Created (IST)', fmt:function(d){ return DI.esc(DI.fmtDate(d.date)) + ' <span class="muted">' + DI.esc(d.created.slice(11)) + '</span>'; }},
    {k:'name', l:'Customer Name'}, {k:'mobile', l:'Mobile'}, {k:'email', l:'Email'}, {k:'agent', l:'Agent'}, {k:'stage', l:'Deal Stage'},
    {k:'ls', l:'Lead Source'}, {k:'trig', l:'Deal Trigger Event'},
    {k:'b', l:'Buyer / Non-Buyer', v:function(d){ return d.b ? 'Buyer' : 'Non-Buyer'; }, fmt:function(d){ return d.b ? 'Buyer' : '<span class="muted">Non-Buyer</span>'; }},
    {k:'minSale', l:'Minimum Sale Date', fmt:function(d){ return d.minSale ? DI.esc(DI.fmtDate(d.minSale)) : '<span class="muted">—</span>'; }},
    {k:'days', l:'Days Since Prev. Sale', num:true, fmt:function(d){ return d.days == null ? '<span class="muted">—</span>' : DI.n(d.days); }},
    {k:'match', l:'Sale Match'}, {k:'reason', l:'Buyer Reason'},
    {k:'city', l:'Address - City', fmt:function(d){ return DI.esc(d.city) + (d.citySrc === 'Contact' ? ' <span class="muted" title="From the linked Contact\'s mailing address">(contact)</span>' : ''); }},
    {k:'pin', l:'Postal Code', fmt:function(d){ return DI.esc(d.pin) + (d.pinSrc === 'Contact' ? ' <span class="muted" title="From the linked Contact\'s mailing address">(contact)</span>' : ''); }},
    {k:'prob', l:'Probability Score', num:true, fmt:function(d){ return d.prob == null ? '<span class="muted">—</span>' : d.prob + '%'; }},
    {k:'rules', l:'Rules Matched'}
  ];
  if (buyerFirst){ var pick = ['created', 'id', 'name', 'mobile', 'email', 'agent', 'city', 'pin', 'prob', 'minSale', 'days', 'stage', 'ls', 'match'];
    cols = pick.map(function(k){ return cols.find(function(c){ return c.k === k; }); }); cols[12] = Object.assign({}, cols[12], {l:'Deal Source'}); cols[13] = Object.assign({}, cols[13], {l:'Matched By'}); }
  DI.table(el, {id:id, rows:rows, cols:cols, sort:'created', pageSize:50, resetPage:true, maxH:640});
}
function detail(rows){
  $('main').innerHTML = '<div class="h2">Detailed Deals</div><div class="sub">Every deal in the current date range and filters — one row per Deal ID. Search, sort, page, or export to CSV.</div>' +
    card('Deals', '<div id="tDeals"></div>', {hint:DI.n(rows.length) + ' deals'});
  dealTable($('tDeals'), rows, 'deals', false);
}

/* ---------------------------------------------------------------- data quality */
function trigRule(a){ var k = a.key.toLowerCase(); return k.indexOf('nitro') >= 0 ? 'Visitor' : k.indexOf('whatsapp') >= 0 ? 'CTWA' : 'Subscriber'; }
function dq(rows){
  var M = DI.META, ids = {}, dupe = 0;
  rows.forEach(function(d){ if (ids[d.id]) dupe++; ids[d.id] = 1; });
  var cnt = function(fn){ return rows.filter(fn).length; }, n = rows.length;
  var items = [
    ['Rows in range / distinct Deal IDs', DI.n(n) + ' / ' + DI.n(Object.keys(ids).length), dupe ? dupe + ' duplicate rows' : 'no duplicates'],
    ['Blank / invalid mobile', DI.n(cnt(function(d){ return !/^[6-9]\d{9}$/.test(d.mobile); })), 'not usable for sale matching'],
    ['Blank / placeholder email', DI.n(cnt(function(d){ return !d.email || /^\+?\d+@/.test(d.email.toLowerCase()) || /@lucirajewelry\.com$/i.test(d.email); })), 'digits@… and @lucirajewelry.com are ignored'],
    ['Blank customer name', DI.n(cnt(function(d){ return !d.name; })), ''],
    ['Blank city', DI.n(cnt(function(d){ return d.city === '(Not captured)'; })), DI.n(cnt(function(d){ return d.citySrc === 'Contact'; })) + ' filled from Contact mailing city'],
    ['Blank postal code', DI.n(cnt(function(d){ return d.pin === '(Not captured)'; })), DI.n(cnt(function(d){ return d.pinSrc === 'Contact'; })) + ' filled from Contact mailing zip'],
    ['Probability Score not captured', DI.n(cnt(function(d){ return d.prob == null; })), DI.p(cnt(function(d){ return d.prob == null; }), n) + ' of deals'],
    ['Same mobile + same day (repeat deals)', '', 'whole table: ' + DI.n((M.same_mobile_same_day || {}).dup_groups) + ' groups, ' + DI.n((M.same_mobile_same_day || {}).extra_deals) + ' extra deals — each counted (distinct Deal IDs)'],
    ['Marketing Sale rows / invoices / customers', DI.n((M.sales || {}).sale_rows) + ' / ' + DI.n((M.sales || {}).invoices) + ' / ' + DI.n((M.sales || {}).customers), 'reduced to ONE minimum sale date per mobile / email before joining'],
    ['Marketing Sale placeholder emails', DI.n((M.sales || {}).placeholder_email), 'excluded from email matching']
  ];
  var rules = DI.group(rows, function(d){ return d.rules; }).sort(function(a, b){ return b.n - a.n; });
  var tg = DI.group(rows, function(d){ return d.trig; });
  var ls = DI.group(rows, function(d){ return d.ls; });
  $('main').innerHTML = '<div class="h2">Data Quality</div><div class="sub">Checks for the current date range and filters (whole-table figures where noted). Source: Zoho CDC synced ' + DI.esc(fmtTs(M.zoho_synced_at)) + '; Marketing Sale through ' + DI.esc(DI.fmtDate(M.sales_through)) + '.</div>' +
    card('Completeness & duplication', '<div class="tbl-wrap"><table><thead><tr><th>Check</th><th class="num">Value</th><th>Note</th></tr></thead><tbody>' +
      items.map(function(i){ return '<tr><td>' + i[0] + '</td><td class="num">' + i[1] + '</td><td class="muted">' + DI.esc(i[2]) + '</td></tr>'; }).join('') + '</tbody></table></div>') +
    '<div class="grid g2">' + card('Classification overlaps', '<div class="sub">Every rule combination the deals meet, so overlaps (e.g. CTWA + Buyer) are visible.</div><div id="tRules"></div>') +
    card('Trigger event → rule', '<div id="tTrig"></div>') + '</div><div style="height:14px"></div>' +
    card('Lead Source (reference only — not used for CTWA)', '<div id="tLs"></div>');
  DI.table($('tRules'), {id:'rules', rows:rules, sort:'n', search:false, cols:[{k:'key', l:'Rules matched'}, {k:'n', l:'Deals', num:true, fmt:function(a){ return DI.n(a.n); }}]});
  DI.table($('tTrig'), {id:'trig', rows:tg, sort:'n', cols:[{k:'key', l:'Deal Trigger Event (raw)'}, {k:'n', l:'Deals', num:true, fmt:function(a){ return DI.n(a.n); }},
    {k:'r', l:'Rule', v:trigRule, fmt:function(a){ return DI.tag(trigRule(a)); }}]});
  DI.table($('tLs'), {id:'ls', rows:ls, sort:'n', cols:[{k:'key', l:'Lead Source (raw)'}, {k:'n', l:'Deals', num:true, fmt:function(a){ return DI.n(a.n); }},
  ]});
}

/* ---------------------------------------------------------------- docs */
function docs(){
  $('main').innerHTML = '<div class="card doc">' +
  '<div class="h2">Documentation &amp; Definitions</div>' +
  '<h4>Buyer</h4><p>Customer whose <b>minimum Marketing Sale date is strictly earlier</b> than the deal\'s created date (IST). A first sale on the same day as the deal, a first sale after the deal, or no matching sale at all are all <b>Non-Buyer</b>.</p>' +
  '<pre>IF Minimum Sale Date &lt; Deal Created Date THEN Buyer ELSE Non-Buyer\nDays Since Previous Sale = Deal Created Date − Minimum Sale Date   (Buyers only)</pre>' +
  '<h4>Non-Buyer</h4><p>No previous sale, or the minimum sale date is on/after the deal created date. The Buyer tab and Overview split Non-Buyers into "First sale on deal date", "First sale after deal" and "No matching sale".</p>' +
  '<h4>Subscriber</h4><p>Deal Trigger Event contains <b>neither</b> <code>nitro</code> <b>nor</b> <code>whatsapp</code> (case-insensitive) — e.g. productview, signup, pdp_store, atc, Website Chat, ChatInitiated/Transcript, payment. A blank trigger counts as Subscriber.</p><pre>Subscriber = LOWER(Deal_Trigger_Event) NOT LIKE &#39;%nitro%&#39; AND NOT LIKE &#39;%whatsapp%&#39;</pre>' +
  '<h4>Visitor</h4><p>Deal Trigger Event contains <code>nitro</code> (any casing — NitroProductView, NitroAddToCart, NitroproductView, 12thjuly_nitro).</p><pre>Visitor = LOWER(Deal_Trigger_Event) LIKE &#39;%nitro%&#39;</pre>' +
  '<h4>CTWA</h4><p>Deal Trigger Event contains <code>whatsapp</code> (case-insensitive) — WhatsApp, Whatsapp Chat. Lead Source is no longer used for CTWA (the earlier Lead Source contains chat rule was retired on 3 Oct 2026).</p><pre>CTWA = LOWER(Deal_Trigger_Event) LIKE &#39;%whatsapp%&#39;</pre><p>CTWA, Subscriber and Visitor are mutually exclusive and together cover every deal; Buyer / Non-Buyer is a separate axis.</p>' +
  '<h4>How categories are counted</h4><p>Each category is counted by its own rule, independently. <b>Buyers + Non-Buyers = Total</b> and <b>CTWA + Subscribers + Visitors = Total</b>; every deal sits in one card of each pair (e.g. a WhatsApp deal from an existing customer counts as both CTWA and Buyer). Data Quality → Classification overlaps lists every rule combination.</p>' +
  '<h4>Customer matching (deal → Marketing Sale)</h4><ul>' +
  '<li><b>Mobile</b> (primary): digits only; <code>91XXXXXXXXXX</code>, <code>0XXXXXXXXXX</code>, <code>091…</code> reduced to 10 digits; valid only if it starts 6–9 and is not one repeated digit. Deal Mobile, else the linked Contact\'s Mobile.</li>' +
  '<li><b>Email</b>: trimmed, lower-case. Placeholder addresses are ignored on both sides: an all-digit local part (<code>9876543210@gmail.com</code>, mobile-derived) and any <code>@lucirajewelry.com</code> store mailbox.</li>' +
  '<li><b>Name fallback</b>: only when the deal has no usable mobile and no usable email; lower-case letters, honorifics (Mr/Mrs/Ms/Dr/Shri/Smt) removed, at least two words, and the name must belong to exactly one sale customer.</li>' +
  '<li>Minimum Sale Date = the earliest <code>Transaction_Date</code> across every identifier that matched. Marketing Sale is reduced to one minimum date per identifier <b>before</b> joining, so multiple invoices/lines never duplicate a deal.</li></ul>' +
  '<h4>Date &amp; timezone</h4><p>Zoho Created_Time is stored in UTC and converted to <b>Asia/Kolkata</b> before taking the date, so a deal created at 00:30 IST falls on the correct Indian day. Marketing Sale uses its own <code>Transaction_Date</code> (calendar date). Presets are computed on the IST calendar; "This Week" starts Monday.</p>' +
  '<h4>KPI calculation</h4><p>All counts are <code>COUNT(DISTINCT Deal_ID)</code> (the table holds one row per deal; the browser also de-duplicates by id). Percentages = category deals ÷ total deals in the same filters × 100. Average Probability uses only deals where Probability Score is captured. KPI comparison = the same metric over the equal-length period immediately before the selected range.</p>' +
  '<h4>Fields</h4><ul><li><b>Address - City</b>: Deal Address_City (live CDC → Sep-2026 address backfill → legacy export), else the linked Contact\'s Mailing_City (marked "(contact)").</li>' +
  '<li><b>Postal Code</b>: same order using Address_Zip_Postal_Code / Mailing_Zip; only a valid 6-digit code is kept.</li>' +
  '<li><b>Probability Score</b>: Zoho <code>Probability_Score</code> (not the stage <code>Probability</code>). Bands 0–20, 21–40, 41–60, 61–80, 81–100, Not captured. The original score is never overwritten.</li>' +
  '<li><b>Agent</b>: Deal Owner. <b>Customer Name</b>: deal Contact name, else Contact Full_Name, else Deal Name.</li></ul>' +
  '<h4>Pipeline</h4><p>BigQuery table <code>zoho_crm.zoho_deal_intelligence</code> (1 row per deal, raw + derived fields side by side) is rebuilt by the Zoho sync every 30 minutes from <code>zoho_crm.cdc_deals</code>, <code>cdc_contacts</code> and <code>ds_imputed_reporting.marketing_sale</code>. Validation view: <code>zoho_crm.zoho_deal_intelligence_validation_v</code>. Last build: ' + DI.esc(fmtTs(DI.META.built_at)) + '.</p></div>';
}

/* ---------------------------------------------------------------- shell */
function fmtTs(s){ if (!s) return '—'; var d = new Date(s); return d.toLocaleString('en-GB', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kolkata'}) + ' IST'; }
function renderTabs(){
  $('tabs').innerHTML = TABS.map(function(t){ return '<a data-t="' + t.k + '" class="' + (t.k === tab ? 'on' : '') + '">' +
    (t.cat ? '<span class="sw" style="background:var(' + DI.CATS.find(function(c){ return c.k === t.k; }).col + ')"></span>' : '') + t.l + '</a>'; }).join('');
  $('tabs').querySelectorAll('a').forEach(function(a){ a.onclick = function(){ tab = a.dataset.t; try { localStorage.setItem('di.tab', tab); } catch(e){} renderTabs(); render(); }; });
}
function renderBar(){
  $('presetSeg').innerHTML = DI.PRESETS.map(function(p){ return '<button data-p="' + p[0] + '" class="' + (F.preset === p[0] ? 'on' : '') + '">' + p[1] + '</button>'; }).join('');
  $('presetSeg').querySelectorAll('button').forEach(function(b){ b.onclick = function(){
    F.preset = b.dataset.p; if (F.preset === 'custom' && !F.from){ var r = DI.range(); F.from = r[0]; F.to = r[1]; } rerender(); }; });
  $('customBox').style.display = F.preset === 'custom' ? '' : 'none';
  var r = DI.range(); $('dFrom').value = r[0]; $('dTo').value = r[1];
  var chips = [];
  DI.FILTER_DEFS.forEach(function(f){ if (F[f[0]].length) chips.push([f[1], F[f[0]].length > 2 ? F[f[0]].length + ' selected' : F[f[0]].join(', '), function(){ F[f[0]] = []; }]); });
  if (F.buyer) chips.push(['Buyer status', F.buyer, function(){ F.buyer = ''; }]);
  if (F.pmin !== '' || F.pmax !== '') chips.push(['Probability Score', F.pmin !== '' && F.pmin === F.pmax ? F.pmin + '%' : (F.pmin || 0) + '–' + (F.pmax || 100) + '%', function(){ F.pmin = F.pmax = ''; }]);
  $('chips').innerHTML = chips.map(function(c, i){ return '<span class="chip"><b>' + DI.esc(c[0]) + ':</b> ' + DI.esc(c[1]) + ' <button data-c="' + i + '" title="Remove">×</button></span>'; }).join('') +
    (chips.length > 1 ? '<button class="btn sm" id="clearAll">Clear all</button>' : '');
  $('chips').querySelectorAll('[data-c]').forEach(function(b){ b.onclick = function(){ chips[+b.dataset.c][2](); rerender(); }; });
  if ($('clearAll')) $('clearAll').onclick = clearAll;
  var ac = DI.activeCount(); $('fCount').textContent = ac ? '(' + ac + ')' : '';
  $('hdrRange').innerHTML = '<b>' + DI.esc(DI.rangeLabel()) + '</b>';
  $('hdrFresh').innerHTML = '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#5fd38d;margin-right:6px;vertical-align:middle"></span>Live · Zoho synced ' + DI.esc(fmtTs(DI.META.zoho_synced_at)) +
    (DI.loadedAt ? ' · checked ' + DI.loadedAt.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kolkata'}) : '');
}
function render(){
  if (!DI.ROWS.length) return;
  var rows = DI.filtered();
  if (tab === 'overview') overview(rows);
  else if (tab === 'detail') detail(rows);
  else if (tab === 'dq') dq(rows);
  else if (tab === 'docs') docs();
  else catTab(tab, rows);
}
function rerender(){ renderBar(); render(); }
function clearAll(){ DI.FILTER_DEFS.forEach(function(f){ F[f[0]] = []; }); F.buyer = ''; F.pmin = F.pmax = ''; rerender(); }

/* ---------------------------------------------------------------- drawer */
var draft = null;
function openDrawer(){
  draft = JSON.parse(JSON.stringify(F));
  var base = DI.ROWS.filter(function(d){ var r = DI.range(); return d.date >= r[0] && d.date <= r[1]; });
  var counts = function(k){ var m = {}; base.forEach(function(d){ m[d[k]] = (m[d[k]] || 0) + 1; }); DI.ROWS.forEach(function(d){ if (!(d[k] in m)) m[d[k]] = 0; }); return m; };
  var h = '';
  DI.FILTER_DEFS.forEach(function(f){
    var m = counts(f[0]), keys = Object.keys(m).sort(function(a, b){ return m[b] - m[a] || a.localeCompare(b); });
    if (f[0] === 'band') keys = ['0-20%', '21-40%', '41-60%', '61-80%', '81-100%', 'Not captured'];
    h += '<div class="fg"><label class="t">' + f[1] + '</label><div class="ms" data-f="' + f[0] + '">' + (keys.length > 10 ? '<input type="search" placeholder="Find…" data-find>' : '') +
      keys.slice(0, 400).map(function(k){ return '<label><input type="checkbox" value="' + DI.esc(k) + '"' + (draft[f[0]].indexOf(k) >= 0 ? ' checked' : '') + '>' + DI.esc(k) + '<span class="n">' + DI.n(m[k] || 0) + '</span></label>'; }).join('') + '</div></div>';
    if (f[0] === 'trig') h += '<div class="fg"><label class="t">Buyer / Non-Buyer</label><select id="fBuyer"><option value="">All</option><option' + (draft.buyer === 'Buyer' ? ' selected' : '') + '>Buyer</option><option' + (draft.buyer === 'Non-Buyer' ? ' selected' : '') + '>Non-Buyer</option></select></div>';
  });
  h += '<div class="fg"><label class="t">Probability Score (%)</label><input type="number" id="fPmin" min="0" max="100" placeholder="min" style="width:90px" value="' + DI.esc(draft.pmin) + '"> – <input type="number" id="fPmax" min="0" max="100" placeholder="max" style="width:90px" value="' + DI.esc(draft.pmax) + '"><div class="sub" style="margin:6px 0 0">Setting a range excludes deals without a score.</div></div>';
  h += '<div class="sub">Counts beside each value = deals in the selected date range.</div>';
  $('drawerBody').innerHTML = h;
  $('drawerBody').querySelectorAll('[data-find]').forEach(function(inp){ inp.oninput = function(){ var q = inp.value.toLowerCase();
    inp.parentNode.querySelectorAll('label').forEach(function(l){ l.style.display = l.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none'; }); }; });
  $('drawer').classList.add('open'); $('scrim').classList.add('open');
}
function closeDrawer(){ $('drawer').classList.remove('open'); $('scrim').classList.remove('open'); }
function applyDrawer(){
  $('drawerBody').querySelectorAll('.ms').forEach(function(ms){ F[ms.dataset.f] = Array.prototype.map.call(ms.querySelectorAll('input[type=checkbox]:checked'), function(c){ return c.value; }); });
  F.buyer = $('fBuyer').value; F.pmin = $('fPmin').value; F.pmax = $('fPmax').value;
  closeDrawer(); rerender();
}

/* ---------------------------------------------------------------- boot */
function boot(){
  try { var th = localStorage.getItem('di.theme'); if (th) document.documentElement.dataset.theme = th; } catch(e){}
  $('btnTheme').onclick = function(){ var dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark'; try { localStorage.setItem('di.theme', document.documentElement.dataset.theme); } catch(e){} render(); };
  $('btnFilters').onclick = openDrawer; $('dClose').onclick = closeDrawer; $('scrim').onclick = closeDrawer;
  $('dApply').onclick = applyDrawer; $('dClear').onclick = function(){ closeDrawer(); clearAll(); };
  $('dFrom').onchange = function(){ F.preset = 'custom'; F.from = $('dFrom').value; if (F.to < F.from) F.to = F.from; rerender(); };
  $('dTo').onchange = function(){ F.preset = 'custom'; F.to = $('dTo').value; if (F.from > F.to) F.from = F.to; rerender(); };
  $('btnReload').onclick = function(){ load(false); };
  document.addEventListener('visibilitychange', function(){ if (!document.hidden && DI.loadedAt && Date.now() - DI.loadedAt > LIVE_MS) load(true); });
  var rt; window.addEventListener('resize', function(){ clearTimeout(rt); rt = setTimeout(render, 200); });
  renderTabs(); renderBar(); load();
}
// Live: the API rebuilds the table whenever Zoho has synced newer deals, so every open is current.
// While the page stays open it re-checks every 5 minutes, keeping the current tab and filters.
var LIVE_MS = 5 * 60 * 1000, liveTimer = null;
function load(silent){
  if (!silent) $('hdrFresh').textContent = 'Loading…';
  clearTimeout(liveTimer);
  DI.load().then(function(){ DI.loadedAt = new Date(); renderBar(); render(); liveTimer = setTimeout(function(){ load(true); }, LIVE_MS); })
    .catch(function(e){ liveTimer = setTimeout(function(){ load(true); }, LIVE_MS); if (silent && DI.ROWS.length) return; $('hdrFresh').textContent = 'Load failed';
      $('main').innerHTML = '<div class="note"><b>Could not load deal data.</b> ' + DI.esc(e.message) + '</div>'; });
}
window.DIV = {render:render, rerender:rerender, toggle:toggle, setTab:function(t){ tab = t; renderTabs(); render(); }};
boot();
})();
