/* Sales Analytics — pages. Uses helpers from sales-analytics-core.js */
'use strict';

const TREND = { level: 'month', scope: null };
const sorted = gs => [...gs].sort(bySales);
const top1 = gs => sorted(gs)[0];
const fmtKey = (level, k) => level === 'month' ? monthLabel(k) : level === 'week' ? 'Wk ' + shortDate(k) : shortDate(k);
const rowsOf = fn => S.f.filter(fn);
const dataRange = rows => { let a = null, b = null; rows.forEach(r => { if (!r.date) return; if (!a || r.date < a) a = r.date; if (!b || r.date > b) b = r.date; }); return [a, b]; };
const completeness = (rows, fn) => div(rows.filter(r => fn(r) != null && fn(r) !== '').length, rows.length) * 100;
const list = (...c) => c.join('');

// ------------------------------------------------------------------ trend helpers
function trendMonths() { return [...new Set(S.fNoDate.filter(r => r.month).map(r => r.month))].sort(); }
// Sales Trend ignores the date filter (it uses every month in the data window; other filters still apply).
// Week / Day views show the weeks / days of the month chosen in the picker (default: latest month).
function trendGroups() {
  const months = trendMonths();
  const sel = TREND.scope && months.includes(TREND.scope) ? TREND.scope : months[months.length - 1];
  TREND.sel = sel;
  let rs = S.fNoDate.filter(r => r.date);
  if (TREND.level !== 'month') rs = rs.filter(r => r.month === sel);
  const key = TREND.level === 'month' ? r => r.month : TREND.level === 'week' ? r => r.week : r => r.date;
  let gs = group(rs, key).sort((a, b) => a.key < b.key ? -1 : 1);
  if (TREND.level === 'day' && gs.length) {
    const m = new Map(gs.map(g => [g.key, g])), out = [];
    for (let d = gs[0].key; d <= gs[gs.length - 1].key; d = addDays(d, 1)) out.push(m.get(d) || finalize(newG(d)));
    gs = out;
  }
  return gs;
}
function drawTrend(id, ctlId, metrics) {
  const gs = trendGroups(), lv = TREND.level, P = PAL();
  const ctl = document.getElementById(ctlId);
  if (ctl) {
    const months = trendMonths();
    ctl.innerHTML = ['month', 'week', 'day'].map(l => `<button class="seg ${lv === l ? 'on' : ''}" data-l="${l}">${l[0].toUpperCase() + l.slice(1)}</button>`).join('') +
      (lv !== 'month' ? `<label class="scope">Month: <select class="msel" data-m>${months.map(m => `<option value="${m}" ${m === TREND.sel ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}</select></label><span class="scope">${lv === 'week' ? 'Weeks' : 'Days'} of the selected month</span>` : '<span class="scope">Click a bar to open that month’s weeks; click a week to see the month’s days</span>');
    ctl.onclick = e => { const b = e.target.closest('[data-l]'); if (b) { TREND.level = b.dataset.l; renderPage(); } };
    ctl.onchange = e => { if (e.target.dataset.m !== undefined) { TREND.scope = e.target.value; renderPage(); } };
  }
  const tip = i => { const g = gs[i], p = gs[i - 1]; return [`Orders: ${int(g.o)}`, `Customers: ${int(g.c)}`, `Pieces: ${int(g.pcs)}`, `Avg invoice value: ${moneyX(g.aov)}`, `Growth vs prev ${lv}: ${p ? gTxt(growth(g.sales, p.sales)) : 'n/a'}`]; };
  return { gs, P, tip, lv };
}
function trendChart(id, ctlId) {
  const { gs, P, tip, lv } = drawTrend(id, ctlId);
  mk(id, { data: { labels: gs.map(g => fmtKey(lv, g.key)), datasets: [
    { type: 'bar', label: 'Net Sales', data: gs.map(g => g.sales), backgroundColor: P[0], yAxisID: 'y', order: 2 },
    { type: 'line', label: 'Orders', data: gs.map(g => g.o), borderColor: P[1], backgroundColor: P[1], yAxisID: 'y1', tension: .25, pointRadius: gs.length > 40 ? 0 : 3, order: 1 },
    { type: 'line', label: 'Pieces', data: gs.map(g => g.pcs), borderColor: P[2], backgroundColor: P[2], yAxisID: 'y1', tension: .25, pointRadius: gs.length > 40 ? 0 : 3, borderDash: [5, 4], order: 1 }] },
    options: { interaction: { mode: 'index', intersect: false }, onClick: (e, els) => { if (!els.length) return; const k = gs[els[0].index].key; if (lv === 'month') { TREND.level = 'week'; TREND.scope = k; renderPage(); } else if (lv === 'week') { TREND.level = 'day'; renderPage(); } },
      scales: { y: { ticks: axisMoney, title: { display: true, text: 'Net Sales (₹)' } }, y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Orders / Pieces' } } },
      plugins: { tooltip: { callbacks: { label: c => c.dataset.label === 'Net Sales' ? `Net Sales: ${moneyX(c.parsed.y)}` : `${c.dataset.label}: ${int(c.parsed.y)}`, afterBody: it => tip(it[0].dataIndex) } } } } });
}
let AOV_VIEW = 'avg';
function lineCards(ids) {
  drawTrend();
  drawAovChart(ids.aov);
}
// Monthly series over every month in the data window — independent of the date filter and of the Month/Week/Day drill (other filters still apply).
// View buttons: average values (invoice value + selling price) or the raw net sales / orders / pieces per month.
function drawAovChart(id) {
  const host = document.getElementById(id); if (!host) return;
  let ctl = document.getElementById(id + '_ctl');
  if (!ctl) { ctl = document.createElement('div'); ctl.id = id + '_ctl'; ctl.className = 'segs'; host.parentElement.parentElement.insertBefore(ctl, host.parentElement); }
  const defs = [['avg', 'Avg values'], ['sales', 'Net sales'], ['o', 'Orders'], ['pcs', 'Pieces']];
  ctl.innerHTML = defs.map(([k, l]) => `<button class="seg ${AOV_VIEW === k ? 'on' : ''}" data-k="${k}" type="button">${l}</button>`).join('');
  ctl.onclick = e => { const b = e.target.closest('[data-k]'); if (b) { AOV_VIEW = b.dataset.k; drawAovChart(id); } };
  const P = PAL(), am = group(S.fNoDate.filter(r => r.month), r => r.month).sort((x, y) => x.key < y.key ? -1 : 1), v = AOV_VIEW;
  const ds = v === 'avg'
    ? [{ label: 'Average Invoice Value', data: am.map(g => g.o ? g.aov : null), borderColor: P[3], backgroundColor: P[3], spanGaps: true, tension: .25, pointRadius: 4 },
       { label: 'Average Selling Price', data: am.map(g => g.pcs ? g.asp : null), borderColor: P[0], backgroundColor: P[0], spanGaps: true, tension: .25, pointRadius: 4 }]
    : [{ label: defs.find(d => d[0] === v)[1], data: am.map(g => v === 'sales' ? g.sales : v === 'o' ? g.o : g.pcs), borderColor: P[0], backgroundColor: P[0], tension: .25, pointRadius: 4 }];
  const money_ = v === 'avg' || v === 'sales', f = money_ ? moneyX : int;
  mk(id, { type: 'line', data: { labels: am.map(g => monthLabel(g.key)), datasets: ds },
    options: { scales: { y: { ticks: money_ ? axisMoney : {} } }, plugins: { legend: { display: ds.length > 1 }, tooltip: { mode: 'index', intersect: false, callbacks: { label: c => `${c.dataset.label}: ${f(c.parsed.y)}`, afterBody: it => { const g = am[it[0].dataIndex]; return [`Net sales: ${moneyX(g.sales)}`, `Orders: ${int(g.o)} · Pieces: ${int(g.pcs)}`]; } } } } } });
}
// Type-wise chart: switchable between net sales, orders and pieces (redraws only this chart, so the page keeps its scroll position).
let TYPE_METRIC = 'sales';
function drawTypeChart() {
  const ctl = document.getElementById('ty_ctl'); if (!ctl) return;
  const defs = [['sales', 'Net sales'], ['o', 'Orders'], ['pcs', 'Pieces']];
  ctl.innerHTML = defs.map(([k, l]) => `<button class="seg ${TYPE_METRIC === k ? 'on' : ''}" data-k="${k}" type="button">${l}</button>`).join('');
  ctl.onclick = e => { const b = e.target.closest('[data-k]'); if (b) { TYPE_METRIC = b.dataset.k; drawTypeChart(); } };
  const m = TYPE_METRIC, gs = group(S.f, r => r.k_type).sort((a, b) => (m === 'sales' ? b.sales - a.sales : m === 'o' ? b.o - a.o : b.pcs - a.pcs));
  hbar('ty_c', gs, m, { n: 12, label: defs.find(d => d[0] === m)[1] });
}
let DOW_METRIC = 'sales';
function drawDowChart(dwo) {
  if (dwo) drawDowChart.rows = dwo; else dwo = drawDowChart.rows;
  const ctl = document.getElementById('dow_ctl'); if (!ctl || !dwo) return;
  const defs = [['sales', 'Net sales'], ['o', 'Orders'], ['pcs', 'Pieces']];
  ctl.innerHTML = defs.map(([k, l]) => `<button class="seg ${DOW_METRIC === k ? 'on' : ''}" data-k="${k}" type="button">${l}</button>`).join('');
  ctl.onclick = e => { const b = e.target.closest('[data-k]'); if (b) { DOW_METRIC = b.dataset.k; drawDowChart(); } };
  hbar('dow', dwo, DOW_METRIC, { vertical: true, label: defs.find(d => d[0] === DOW_METRIC)[1] });
}
// Horizontal bar chart with Net sales / Orders / Pieces buttons (redraws only this chart; the choice is remembered per chart).
const METRIC_VIEW = {};
function metricHbar(id, rows, keyFn, o = {}) {
  const host = document.getElementById(id); if (!host) return;
  const defs = [['sales', 'Net sales'], ['o', 'Orders'], ['pcs', 'Pieces']], m = METRIC_VIEW[id] || 'sales';
  let ctl = document.getElementById(id + '_ctl');
  if (!ctl) { ctl = document.createElement('div'); ctl.id = id + '_ctl'; ctl.className = 'segs'; host.parentElement.parentElement.insertBefore(ctl, host.parentElement); }
  ctl.innerHTML = defs.map(([k, l]) => `<button class="seg ${m === k ? 'on' : ''}" data-k="${k}" type="button">${l}</button>`).join('');
  ctl.onclick = e => { const b = e.target.closest('[data-k]'); if (b) { METRIC_VIEW[id] = b.dataset.k; metricHbar(id, rows, keyFn, o); } };
  const gs = group(rows, keyFn).sort((a, b) => m === 'sales' ? b.sales - a.sales : m === 'o' ? b.o - a.o : b.pcs - a.pcs);
  hbar(id, gs, m, Object.assign({}, o, { label: defs.find(d => d[0] === m)[1] }));
}
function stackedByMonth(id, rows, keyFn, n, metric = 'sales') {
  const P = PAL(), months = [...new Set(rows.filter(r => r.month).map(r => r.month))].sort();
  const keys = groupTop(rows, keyFn, n).sort(bySales).map(g => g.key);
  const tk = new Set(keys.filter(k => k !== 'Other'));
  const gs = group(rows.filter(r => r.month), r => { const k = keyFn(r); return (tk.has(k) ? k : 'Other') + '\u0001' + r.month; });
  const mp = new Map(gs.map(g => [g.key, g]));
  mk(id, { type: 'bar', data: { labels: months.map(monthLabel), datasets: keys.map((k, i) => ({ label: k, data: months.map(m => { const g = mp.get(k + '\u0001' + m); return g ? (metric === 'sales' ? g.sales : metric === 'c' ? g.c : metric === 'o' ? g.o : g.aov) : 0; }), backgroundColor: P[i % 8] })) },
    options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: metric === 'sales' ? axisMoney : {} } }, plugins: { tooltip: { mode: 'index', intersect: false, callbacks: { label: c => `${c.dataset.label}: ${metric === 'sales' ? moneyX(c.parsed.y) : int(c.parsed.y)}` } } } } });
}
function hbar(id, gs, metric, o = {}) {
  const P = PAL(), pos = gs.filter(g => g.sales > 0), sel = (o.n ? pos.slice(0, o.n) : pos); // zero-net-sale groups are not charted
  const val = g => metric === 'sales' ? g.sales : metric === 'aov' ? g.aov : metric === 'o' ? g.o : metric === 'pcs' ? g.pcs : metric === 'discPct' ? g.discPct : metric === 'c' ? g.c : g[metric];
  const isM = metric === 'sales' || metric === 'aov';
  mk(id, { type: 'bar', data: { labels: sel.map(g => g.key), datasets: [{ label: o.label || metric, data: sel.map(val), backgroundColor: o.colors ? sel.map((g, i) => o.colors[i % o.colors.length]) : P[0] }] },
    options: { indexAxis: o.vertical ? 'x' : 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => isM ? moneyX(c.parsed[o.vertical ? 'y' : 'x']) : metric === 'discPct' ? pct(c.parsed[o.vertical ? 'y' : 'x']) : int(c.parsed[o.vertical ? 'y' : 'x']), afterLabel: c => { const g = sel[c.dataIndex]; return [`Sales: ${moneyX(g.sales)} (${pct(g.share)})`, `Orders: ${int(g.o)} · Pieces: ${int(g.pcs)} · Customers: ${int(g.c)}`, `Avg invoice value: ${moneyX(g.aov)}`]; } } } },
      scales: { [o.vertical ? 'y' : 'x']: { ticks: isM ? axisMoney : (metric === 'discPct' ? { callback: v => v + '%' } : {}) }, [o.vertical ? 'x' : 'y']: { ticks: { autoSkip: false, font: { size: 10 } } } } } });
}
function shareDoughnut(id, gs, n = 8) {
  const P = PAL(), s = sorted(gs), head = s.slice(0, n), rest = s.slice(n), other = sumBy(rest, g => g.sales);
  const labels = head.map(g => g.key).concat(other ? ['Other'] : []), data = head.map(g => g.sales).concat(other ? [other] : []);
  mk(id, { type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: labels.map((l, i) => P[i % 8]), borderWidth: 1 }] }, options: { cutout: '58%', plugins: { legend: { position: 'right' }, tooltip: { callbacks: { label: c => `${c.label}: ${moneyX(c.parsed)} (${pct(c.parsed / sumBy(data, x => x) * 100)})` } } } } });
}

// ------------------------------------------------------------------ Observations engine
function observations(rows = S.f) {
  const t = total(rows); if (!t.lines) return [];
  const o = [], ch = sorted(group(rows, r => r.k_chan)), ig = sorted(group(rows, r => r.k_ig)), ty = sorted(group(rows, r => r.k_type));
  o.push(`${ch[0].key} was the largest channel: ${moneyX(ch[0].sales)} (${pct(ch[0].share)} of net sales) from ${int(ch[0].o)} orders (${pct(div(ch[0].o, t.o) * 100)} of orders).`);
  if (ig[0]) o.push(`${ig[0].key} generated ${moneyX(ig[0].sales)}, ${pct(ig[0].share)} of net sales; the top type was ${ty[0].key} at ${pct(ty[0].share)}.`);
  const sk = sorted(group(rows, r => r.k_sku)), n10 = sumBy(sk.slice(0, 10), g => g.sales), n50 = sumBy(sk.slice(0, 50), g => g.sales);
  o.push(`Sales concentration: top 10 SKUs = ${pct(div(n10, t.sales) * 100)} and top 50 SKUs = ${pct(div(n50, t.sales) * 100)} of net sales across ${int(sk.length)} SKUs.`);
  o.push(`New customers generated ${moneyX(t.newSales)} (${pct(div(t.newSales, t.sales) * 100)} of sales) and repeat customers ${moneyX(t.repSales)} (${pct(div(t.repSales, t.sales) * 100)}).`);
  const pr = group(rows, r => r.k_price), pS = top1(pr), pO = [...pr].sort((a, b) => b.o - a.o)[0];
  o.push(`The ${pS.key} price band carried the most sales (${moneyX(pS.sales)}, ${pct(pS.share)}); the ${pO.key} band had the most orders (${int(pO.o)}, ${pct(div(pO.o, t.o) * 100)}).`);
  const me = top1(group(rows, r => r.k_metal)), ka = sorted(group(rows, r => r.k_karat));
  o.push(`${me.key} accounted for ${pct(me.share)} of sales. By karat, ${ka[0].key} led with ${pct(ka[0].share)}${ka[1] ? ` followed by ${ka[1].key} at ${pct(ka[1].share)}` : ''}.`);
  const db = group(rows.filter(r => r.dband), r => r.dband);
  if (db.length) { const d = top1(db); o.push(`Among lines with a diamond weight band (${pct(completeness(rows, r => r.dband))} of lines), "${d.key}" led with ${moneyX(d.sales)}.`); }
  const co = sorted(group(rows, r => r.k_co)); o.push(`${co[0].key} was the largest store/company with ${pct(co[0].share)} of sales; the smallest (${co[co.length - 1].key}) had ${pct(co[co.length - 1].share)}.`);
  const z = rows.filter(r => r.net === 0); if (z.length) o.push(`${int(z.length)} lines (${pct(div(z.length, rows.length) * 100)}) have net_sale = 0; they add ${int(sumBy(z, r => r.pcs))} pieces but no revenue.`);
  o.push(`Data limits: city/state/country are populated for ${pct(completeness(rows, r => r.city))} of lines; diamond weight band for ${pct(completeness(rows, r => r.dband))}.`);
  return o;
}
function exec(rows = S.f) {
  const t = total(rows); if (!t.lines) return '<p class="empty">No data for the current filters.</p>';
  const ch = sorted(group(rows, r => r.k_chan)), ig = sorted(group(rows, r => r.k_ig)), sk = sorted(group(rows, r => r.k_sku));
  const me = sorted(group(rows, r => r.k_metal)), ka = sorted(group(rows, r => r.k_karat)), pr = sorted(group(rows, r => r.k_price));
  const dRows = rows.filter(r => r.dWt > 0), dT = total(dRows);
  const blocks = [
    ['Sales', `${moneyX(t.sales)} net sales from ${int(t.o)} orders (${int(t.pcs)} pieces). Average invoice value ${moneyX(t.aov)}; average selling price ${moneyX(t.asp)}.`],
    ['Customer', `${int(t.c)} unique customers. ${int(t.nc)} New (${pct(t.newPct)}) and ${int(t.rc)} Repeat (${pct(t.repPct)}) by line-level customer_type; repeat customers generated ${pct(div(t.repSales, t.sales) * 100)} of sales.`],
    ['Product', `${ig.slice(0, 3).map(g => `${g.key} ${pct(g.share)}`).join(', ')} of sales by category. Top 10 SKUs = ${pct(div(sumBy(sk.slice(0, 10), g => g.sales), t.sales) * 100)} of sales across ${int(sk.length)} SKUs.`],
    ['Channel', ch.map(g => `${g.key} ${pct(g.share)}`).join(' · ') + ' of net sales.'],
    ['Jewellery', `Metal: ${me.slice(0, 3).map(g => `${g.key} ${pct(g.share)}`).join(', ')}. Karat: ${ka.slice(0, 3).map(g => `${g.key} ${pct(g.share)}`).join(', ')}. ${dT.lines ? `${int(dT.lines)} lines carry diamonds (${wt(dT.dWt)} total; ${moneyX(dT.dAmt)} diamond value).` : ''}`],
    ['Commercial', `Largest price band by sales: ${pr[0].key} (${pct(pr[0].share)}).`],
  ];
  return blocks.map(([h, x]) => `<div class="ex"><b>${h}</b><span>${x}</span></div>`).join('');
}

// ================================================================== PAGES
const P = {};
const fulLabel = k => k === NP ? k : k.split('_').map(w => ['rts', 'mto', 'tah'].includes(w.toLowerCase()) ? w.toUpperCase() : w).join(' ');

// ---------------------------------------------------------------- P1 Executive Overview
const P1 = {
  html: () => list(
    card('Executive Summary', 'Auto-generated; every statement is a calculated metric.', `<div id="execBox" class="exec"></div>`, 'wide'),
    '<div id="kpiBox"></div>',
    grid('g1', card('Sales Trend', 'Net sales (bars) with orders and pieces (lines). Not affected by the date filter. Week and Day views show the month you pick.', `<div id="tr1c" class="segs"></div><div class="chart-box" style="height:340px"><canvas id="tr1"></canvas></div>`)),
    ''),
  draw() {
    const t = total(S.f), oiK = total(S.f.filter(r => r.oi)), stK = total(S.f.filter(r => r.k_chan === 'Store')); document.getElementById('execBox').innerHTML = exec();
    const K = (l, v, d, tone) => kpi(l, v, d, tone);
    document.getElementById('kpiBox').innerHTML = `
      <h4 class="kh">Sales</h4><div class="kpis">${K('Total Net Sales', money(t.sales), 'SUM(net_sale). Exact: ' + moneyE(t.sales), 'hero')}${sorted(group(S.f, r => r.k_ful)).map(g => K(fulLabel(g.key) + ' Sales', money(g.sales), 'SUM(net_sale) where Fullfillment = ' + g.key + ' · ' + pct(g.share) + ' of net sales · ' + int(g.o) + ' orders · ' + int(g.pcs) + ' pieces. Exact: ' + moneyE(g.sales))).join('')}</div>
      <h4 class="kh">Volume</h4><div class="kpis">${K('Orders', int(t.o), 'COUNT DISTINCT document_no')}${K('Pieces', int(t.pcs), 'SUM(pieces)')}${K('Unique Customers', int(t.c), 'COUNT DISTINCT party_id')}${K('Online-Influenced Customers', int(oiK.c), pct(div(oiK.c, stK.c) * 100) + ' of ' + int(stK.c) + ' store customers had a website visit / signup (Zoho deal or Shopify subscriber) before buying in store')}</div>
      <h4 class="kh">Customer</h4><div class="kpis">${K('New Customers', int(t.nc), 'Customers whose most recent purchase is tagged New (a customer is either New or Repeat, never both)')}${K('Repeat Customers', int(t.rc), 'Customers whose most recent purchase is tagged Repeat (never also counted in New)')}${K('New Customer %', pct(t.newPct), 'New Customers ÷ Unique Customers')}${K('Repeat Customer %', pct(t.repPct), 'Repeat Customers ÷ Unique Customers. New % + Repeat % = 100% — each customer is New or Repeat by their most recent purchase')}</div>
      <h4 class="kh">Commercial</h4><div class="kpis">${K('Average Invoice Value', money(t.aov), 'Net Sales ÷ distinct orders. Exact: ' + moneyE(t.aov))}${K('Avg Selling Price', money(t.asp), 'Net Sales ÷ Pieces (zero-value lines included). Exact: ' + moneyE(t.asp))}</div>`;
    trendChart('tr1', 'tr1c');
  }
};

// ---------------------------------------------------------------- P2 Sales & Channel
const P2 = {
  html: () => list(
    grid('g2', chartCard('tr_aov', 'Monthly Trend — Average Values, Sales, Orders & Pieces', 'Avg values: invoice value = net sales ÷ orders, selling price = net sales ÷ pieces · by month · not affected by the date filter', 280), card('Type-wise Sales', 'Net sales by product type (Rings, Earrings, Necklaces …) — follows the filters', '<div id="ty_ctl" class="segs"></div><div class="chart-box" style="height:280px"><canvas id="ty_c"></canvas></div>')),
    grid('g2', card('Day-of-Week Sales', 'Weekday totals over the selected period', '<div id="dow_ctl" class="segs"></div><div class="chart-box" style="height:260px"><canvas id="dow"></canvas></div>'), tableCard('t_dow', 'Day-of-Week Detail', '')),
    '<h2 class="sh">Channel Analysis</h2>',
        grid('g1', tableCard('t_ch', 'Channel Comparison', 'Sales %, Order % and Customer % use the total of the filtered data as denominator')),
    grid('g2', chartCard('ch_tr', 'Channel Sales Trend', 'Monthly net sales stacked by channel', 300), tableCard('t_chc', 'Channel × Customer Type', 'New vs repeat customers within each channel')),
    '<h2 class="sh">Store-wise Analysis</h2>',
    grid('g1', chartCard('st_nr', 'New vs Repeat Sales by Store', 'Net sales split by customer type on each line', 280)),
    grid('g1', tableCard('t_st', 'Store Detail', 'Sales, volume, customers and new vs repeat for every store')),
    grid('g1', card('Store × Fulfillment', 'How each store’s sales split across fulfillment types (RTS, MTO, Online MTO …)', '<div id="h_cs"></div>')),
    ''),
  draw() {
    lineCards({ aov: 'tr_aov' }); drawTypeChart();
    // monthly growth drivers
    const all = S.all.filter(r => r.date), [mn, mx] = dataRange(all);
    const gs = group(S.f.filter(r => r.month), r => r.month).sort((a, b) => a.key < b.key ? -1 : 1);
    gs.forEach((g, i) => { const p = gs[i - 1]; g.dS = p ? g.sales - p.sales : null; g.gr = p ? growth(g.sales, p.sales) : null; g.partial = (g.key === mn.slice(0, 7) && mn.slice(8) !== '01') || (g.key === mx.slice(0, 7) && addDays(mx, 1).slice(0, 7) === g.key); });
    const dw = group(S.f.filter(r => r.dow != null), r => DOW[r.dow]); const dwo = DOW.map(d => dw.find(g => g.key === d) || finalize(newG(d)));
    drawDowChart(dwo); dimTable('t_dow', S.f.filter(r => r.dow != null), r => DOW[r.dow], 'Day', { order: DOW, cols: [C.key('Day'), C.sales, C.share, C.orders, C.pcs, C.aov], noFoot: true, search: false });
    const ch = sorted(group(S.f, r => r.k_chan)); const tt = total(S.f);
    
    tbl('t_ch', { name: 'channel', search: false, pageSize: 12, sort: 'Net Sales', cols: [C.key('Channel'), C.sales, C.share, C.orders, { h: 'Order %', f: g => pct(div(g.o, tt.o) * 100), v: g => g.o / (tt.o || 1), cls: 'num' }, C.pcs, C.cust, { h: 'Customer %', f: g => pct(div(g.c, tt.c) * 100), v: g => g.c / (tt.c || 1), cls: 'num' }, C.aov, C.asp, C.discPct, C.newC, C.repC], rows: ch });
    stackedByMonth('ch_tr', S.f, r => r.k_chan, 6);
    dimTable('t_chc', S.f, r => r.k_chan, 'Channel', { cols: [C.key('Channel'), C.newC, C.repC, { h: 'New sales', f: g => moneyX(g.newSales), v: g => g.newSales, cls: 'num' }, { h: 'Repeat sales', f: g => moneyX(g.repSales), v: g => g.repSales, cls: 'num' }, { h: 'Repeat sales %', f: g => pct(div(g.repSales, g.sales) * 100), v: g => div(g.repSales, g.sales), cls: 'num' }], noFoot: true, search: false });
    const fu = group(S.f, r => r.k_co);
    const P_ = PAL(), stS = sorted(fu);
    mk('st_nr', { type: 'bar', data: { labels: stS.map(g => g.key), datasets: [{ label: 'New customers', data: stS.map(g => g.newSales), backgroundColor: P_[0] }, { label: 'Repeat customers', data: stS.map(g => g.repSales), backgroundColor: P_[1] }] }, options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: axisMoney } }, plugins: { tooltip: { mode: 'index', intersect: false, callbacks: { label: c => `${c.dataset.label}: ${moneyX(c.parsed.y)}` } } } } });
    dimTable('t_st', S.f, r => r.k_co, 'Store', { cols: [C.key('Store'), C.sales, C.share, C.orders, C.pcs, C.cust, C.aov, C.asp, C.newC, C.repC, C.newPct, C.repPct,
      { h: 'New sales', f: g => moneyX(g.newSales), v: g => g.newSales, cls: 'num' }, { h: 'Repeat sales', f: g => moneyX(g.repSales), v: g => g.repSales, cls: 'num' }, { h: 'Repeat sales %', f: g => pct(div(g.repSales, g.sales) * 100), v: g => div(g.repSales, g.sales), cls: 'num' }], search: false });
    heat('h_cs', S.f, r => r.k_co, r => r.k_ful, { corner: 'Store ↓ / Fulfillment →' });
    const f0 = sorted(fu)[0], d0 = ch[0];
    return ([ch.length ? `${d0.key} contributed ${pct(d0.share)} of net sales and ${pct(div(d0.o, tt.o) * 100)} of orders.` : '', f0 ? `${f0.key} was the largest store with ${pct(f0.share)} of net sales (${moneyX(f0.sales)}).` : '', gs.length > 1 ? `Latest month in view (${monthLabel(gs[gs.length - 1].key)}${gs[gs.length - 1].partial ? ', partial' : ''}) net sales ${moneyX(gs[gs.length - 1].sales)}, ${gTxt(gs[gs.length - 1].gr)} vs prior month.` : '']);
  }
};

// Executive Overview + Sales & Channel merged into one page (each item appears once).
P.p1 = {
  html: () => P1.html() + P2.html() + insight('ins1'),
  draw() { P1.draw(); const more = P2.draw(); setInsight('ins1', observations().slice(0, 6).concat(more)); }
};

// ---------------------------------------------------------------- P3 Product performance
const PROD_LEVELS = [{ name: 'Item Group', key: r => r.k_ig }, { name: 'Type', key: r => r.k_type }, { name: 'Sub-category 1', key: r => r.k_sub1 }, { name: 'Sub-category 2', key: r => r.k_sub2 }, { name: 'Style', key: r => r.k_style + (r.styleName ? ' · ' + r.styleName : '') }, { name: 'SKU', key: r => r.k_sku }];
function skuGroups(rows) {
  const info = new Map(); rows.forEach(r => { if (!info.has(r.k_sku)) info.set(r.k_sku, r); });
  const gs = group(rows, r => r.k_sku); gs.forEach(g => { g.r = info.get(g.key); }); return gs;
}
P.p3 = {
  html: () => list(
    grid('g1', chartCard('pd_type', 'Sales by Product Type (top 12)', '', 260)),
    grid('g1', card('Product Hierarchy Drill-down', 'Item Group → Type → Sub-category 1 → Sub-category 2 → Style → SKU', '<div id="pd_dr"></div>')),
    grid('g1', tableCard('t_sku', 'SKU Performance Table', 'Search, sort, page, choose columns, export. Diamond weight = SUM(diamond_weight).')),
    '<h2 class="sh">Collection & Vendor</h2>',
    grid('g2', tableCard('t_coll', 'Collection', ''), tableCard('t_vend', 'Vendor', 'No cost data — vendors are not ranked on profitability')),
    insight('ins3')),
  draw() {
    const rows = S.f, t = total(rows);
    metricHbar('pd_type', rows, r => r.k_type, { n: 12 });
    drill('pd_dr', PROD_LEVELS, rows, { root: 'All categories' });
    const sg = skuGroups(rows).filter(g => g.sales > 0);
    const P_ = PAL();
    tbl('t_sku', { name: 'sku_performance', colSelect: true, pageSize: 15, sort: 'Net Sales', rows: sg, cols: [{ h: 'SKU', f: g => g.key, cls: 'lead' }, { h: 'Product', f: g => g.r.title || '—' }, { h: 'Style', f: g => g.r.k_style, hidden: true }, { h: 'Category', f: g => g.r.k_ig + ' › ' + g.r.k_type }, C.sales, C.orders, C.pcs, C.cust, C.aov, C.asp, C.disc, { h: 'Diamond Wt', f: g => wt(g.dWt), v: g => g.dWt, cls: 'num' }, { h: 'Metal', f: g => g.r.k_metal }, { h: 'Karat', f: g => g.r.k_karat }, { h: 'Vendor', f: g => g.r.k_vendor }] });
    // Pareto
    const s = sorted(sg), top = s.slice(0, 30); let cum = 0; const cumS = top.map(g => (cum += g.sales, div(cum, t.sales) * 100));
    const stSorted = sorted(group(rows, r => r.k_style)), cs = n => pct(div(sumBy(s.slice(0, n), g => g.sales), t.sales) * 100), ss = n => pct(div(sumBy(stSorted.slice(0, n), g => g.sales), t.sales) * 100);
    const needFor = p => { let c = 0; for (let i = 0; i < s.length; i++) { c += s[i].sales; if (c >= t.sales * p) return i + 1; } return s.length; };
    dimTable('t_coll', rows, r => r.k_coll, 'Collection', { cols: [C.key('Collection'), C.sales, C.share, C.orders, C.pcs, C.cust, C.aov] });
    document.getElementById('t_coll').insertAdjacentHTML('afterbegin', `<p class="note">Collection populated on ${pct(completeness(rows, r => r.coll))} of lines; “${NP}” is missing data, not a real collection.</p>`);
    const vg = dimTable('t_vend', rows, r => r.k_vendor, 'Vendor', { cols: [C.key('Vendor'), C.sales, C.share, C.orders, C.pcs, C.skus, C.asp, { h: 'Diamond sales', f: g => moneyX(g.dAmt), v: g => g.dAmt, cls: 'num' }, { h: 'Metal sales', f: g => moneyX(g.mAmt), v: g => g.mAmt, cls: 'num' }, { h: 'Categories', f: g => new Set(rows.filter(r => r.k_vendor === g.key).map(r => r.k_ig)).size, v: g => new Set(rows.filter(r => r.k_vendor === g.key).map(r => r.k_ig)).size, cls: 'num' }] });
    const ty = sorted(group(rows, r => r.k_type));
    setInsight('ins3', [ty[0] ? `Top product type ${ty[0].key} = ${pct(ty[0].share)} of net sales.` : '', `Top 10 SKUs = ${cs(10)} and top 50 = ${cs(50)} of net sales (${int(s.length)} SKUs).`]);
  }
};

// ---------------------------------------------------------------- P4 Customer analytics
const firstLast = (() => { let m = null; return () => { if (m) return m; m = new Map(); S.all.forEach(r => { if (r.party == null || !r.date) return; const x = m.get(r.party) || { f: r.date, l: r.date }; if (r.date < x.f) x.f = r.date; if (r.date > x.l) x.l = r.date; m.set(r.party, x); }); return m; }; })();
P.p4 = {
  html: () => list(
    '<h2 class="sh">New vs Repeat customers by channel</h2>',
    '<div id="ch_kpi"></div>',
    grid('g1', tableCard('t_chnr', 'New vs Repeat by channel', 'Each customer is New or Repeat within the channel (by their most recent purchase there). Store and Online are separate; online-influenced store customers are in the next section.')),
    '<h2 class="sh">Online-influenced store customers</h2>',
    '<div id="oi_kpi"></div>',
    grid('g2', tableCard('t_nr', 'New vs Repeat', 'By the customer_type recorded on each sales line'), chartCard('nr_tr', 'New vs Repeat Sales by Month', '', 280)),
    grid('g1', chartCard('nr_c', 'Customers per Month — New vs Repeat', '', 260)),
    grid('g1', tableCard('t_cust', 'Customer Table (controlled detail)', 'Customer ID shown by default; the name column is hidden until chosen under “Columns”. Returns = sale-return documents (PSR) for that customer, by return date within the selected date range, on the same basis as net sales; other filters (channel, category, etc.) do not apply to returns. First/last purchase use the full dataset.')),
    '<h2 class="sh">What Do They Buy?</h2>',
    grid('g2', card('Customer Type × Price Range', '', '<div id="h2"></div>'), card('Customer Type × Karat', '', '<div id="h4"></div>')),
    grid('g1', card('Customer Type × Channel', '', '<div id="h5"></div>')),
    insight('ins4')),
  draw() {
    const rows = S.f, t = total(rows);
    const chG = group(rows.filter(r => r.ctype), r => r.k_chan), chM = new Map(chG.map(g => [g.key, g]));
    const chK = (name, g) => [kpi(name + ' — New customers', int(g ? g.nc : 0), g ? pct(g.newPct) + ' of ' + int(g.c) + ' customers · ' + money(g.newSales) + ' sales' : 'No sales'), kpi(name + ' — Repeat customers', int(g ? g.rc : 0), g ? pct(g.repPct) + ' of ' + int(g.c) + ' customers · ' + money(g.repSales) + ' sales' : 'No sales')].join('');
    document.getElementById('ch_kpi').innerHTML = `<div class="kpis">${chK('Store', chM.get('Store'))}${chK('Online', chM.get('Online'))}</div>`;
    const chT = total(rows.filter(r => r.ctype)); chT.share = 100; // grand total is calculated on all lines (not the sum of rows), so customers are de-duplicated across channels
    tbl('t_chnr', { name: 'new_repeat_by_channel', search: false, sort: 'Net Sales', rows: chG, foot: (rs, cols) => `<tr class="tot">${cols.map((c, i) => `<td class="${c.cls || ''}">${i === 0 ? 'Grand total' : esc(c.f(chT))}</td>`).join('')}</tr>`, cols: [C.key('Channel'), C.sales, C.share, C.orders, C.cust, C.newC, C.repC, C.newPct, C.repPct, { h: 'New sales', f: g => moneyX(g.newSales), v: g => g.newSales, cls: 'num' }, { h: 'Repeat sales', f: g => moneyX(g.repSales), v: g => g.repSales, cls: 'num' }, { h: 'Repeat sales %', f: g => pct(div(g.repSales, g.sales) * 100), v: g => div(g.repSales, g.sales) * 100, cls: 'num' }] });
    const stRows = rows.filter(r => r.k_chan === 'Store'), stT = total(stRows), oiRows = stRows.filter(r => r.oi), oiT = total(oiRows);
    const oiC = oiT.c, soC = stT.c - oiC, soSales = stT.sales - oiT.sales, soO = stT.o - oiT.o; // a customer is online-influenced if ANY of their store purchases followed an online touch, so the two customer counts add up to all store customers
    document.getElementById('oi_kpi').innerHTML = `<div class="kpis">${kpi('Store customers', int(stT.c), 'Distinct customers with a store purchase')}${kpi('Online-influenced store customers', int(oiC), pct(div(oiC, stT.c) * 100) + ' of store customers had a website visit / signup (Zoho deal or Shopify subscriber) before buying in store', 'hero')}${kpi('Store-only customers', int(soC), 'Store customers with no online touch before any of their store purchases')}${kpi('Online-influenced store sales', money(oiT.sales), pct(div(oiT.sales, stT.sales) * 100) + ' of store net sales · ' + int(oiT.o) + ' orders')}</div>`;
    const ng = group(rows.filter(r => r.ctype), r => r.k_ctype);
    tbl('t_nr', { name: 'new_vs_repeat', search: false, rows: ng, sort: 'Net Sales', cols: [C.key('Customer type'), C.sales, C.share, C.orders, C.cust, C.pcs, C.aov, C.asp] });
    stackedByMonth('nr_tr', rows, r => r.k_ctype, 3);
    const P_ = PAL(), months = [...new Set(rows.filter(r => r.month).map(r => r.month))].sort(), mg = new Map(group(rows.filter(r => r.month), r => r.month).map(g => [g.key, g]));
    mk('nr_c', { type: 'bar', data: { labels: months.map(monthLabel), datasets: [{ label: 'New', data: months.map(m => mg.get(m)?.nc || 0), backgroundColor: P_[5] }, { label: 'Repeat', data: months.map(m => mg.get(m)?.rc || 0), backgroundColor: P_[1] }] }, options: { plugins: { tooltip: { mode: 'index', intersect: false } } } });
    const cg = group(rows.filter(r => r.party != null), r => r.k_cust); const fl = firstLast(); const names = new Map(); rows.forEach(r => { if (r.pname && !names.has(r.k_cust)) names.set(r.k_cust, r.pname); });
    const sales = cg.map(g => g.sales).sort((a, b) => a - b), p90 = sales[Math.floor(sales.length * .9)] || 0;
    const ret = new Map(); (S.returns || []).forEach(x => { if ((S.date.from && x.date < S.date.from) || (S.date.to && x.date > S.date.to)) return; const k = String(x.party); const e = ret.get(k) || { pcs: 0, net: 0 }; e.pcs += x.pcs; e.net += x.net; ret.set(k, e); });
    cg.forEach(g => { const e = ret.get(g.key) || { pcs: 0, net: 0 }; g.retPcs = e.pcs; g.retNet = e.net; });
    const oiCust = new Set(rows.filter(r => r.oi && r.party != null).map(r => String(r.party)));
    cg.forEach(g => { g.type = g.rc ? 'Repeat' : g.nc ? 'New' : '—'; g.seg = g.sales >= p90 && g.sales > 0 ? 'High-value (top 10% by sales)' : g.o >= 3 ? 'Frequent (3+ orders)' : g.o === 1 ? 'One-time' : 'Repeat buyer (2 orders)'; g.fl = fl.get(+g.key) || {}; });
    tbl('t_cust', { name: 'customers', colSelect: true, pageSize: 12, sort: 'Net Sales', rows: cg, cols: [{ h: 'Customer ID', f: g => `<a class="cid" data-id="${esc(g.key)}" title="Open full customer profile">${esc(g.key)}</a>`, v: g => g.key, html: true, cls: 'lead' }, { h: 'Name', f: g => names.get(g.key) || '—', hidden: true }, { h: 'Type', f: g => g.type }, { h: 'Online-influenced', f: g => oiCust.has(g.key) ? 'Yes' : 'No' }, { h: 'Segment', f: g => g.seg }, C.orders, C.pcs, C.sales, C.aov, { h: 'Returned Pieces', f: g => int(g.retPcs), v: g => g.retPcs, cls: 'num' }, { h: 'Returned Net Amount', f: g => g.retNet ? moneyX(g.retNet) : '—', v: g => g.retNet, cls: 'num' }, { h: 'First purchase', f: g => g.fl.f || '—', cls: 'num' }, { h: 'Last purchase', f: g => g.fl.l || '—', cls: 'num' }] });
    const ct = r => r.ctype ? r.k_ctype : null;
    heat('h2', rows, ct, r => r.k_price, { colOrder: PRICE_ORDER, corner: 'Type ↓ / Price →', maxCols: 10 });
    heat('h4', rows, ct, r => r.k_karat, { corner: 'Type ↓ / Karat →' }); heat('h5', rows, ct, r => r.k_chan, { corner: 'Type ↓ / Channel →' });
    const rs = total(rows.filter(r => r.ctype === 'Repeat')), ns = total(rows.filter(r => r.ctype === 'New'));
    const one = cg.filter(g => g.o === 1).length, multi = cg.filter(g => g.o >= 2).length;
    setInsight('ins4', [`Repeat customers generated ${moneyX(t.repSales)} (${pct(div(t.repSales, t.sales) * 100)} of net sales) across ${int(t.ro)} orders; new customers ${moneyX(t.newSales)} (${pct(div(t.newSales, t.sales) * 100)}) across ${int(t.no)} orders.`, `${int(one)} of ${int(cg.length)} customers (${pct(div(one, cg.length) * 100)}) placed exactly one order in this view; ${int(multi)} placed 2+.`, `High-value threshold (top 10% of customers) = ${moneyX(p90)} net sales; ${int(cg.filter(g => g.seg.startsWith('High')).length)} customers meet it.`]);
  }
};
const cgMap = arr => { if (!arr._m) arr._m = new Map(arr.map(g => [g.key, g])); return arr._m; };

// ---------------------------------------------------------------- P5 Jewellery
P.p5 = {
  html: () => list(
    grid('g1', card('Jewellery Drill-down', 'Metal → Metal Color → Karat → Product Type → SKU', '<div id="jw_dr"></div>')),
    '<h2 class="sh">Metal</h2>',
    grid('g2', chartCard('mt_c', 'Sales by Metal & Color', '', 260), tableCard('t_mt', 'Metal', '')),
    grid('g1', card('Metal × Channel', '', '<div id="mh1"></div>')),
    '<h2 class="sh">Karat</h2>',
    grid('g2', chartCard('ka_c', 'Sales by Karat', '', 260), tableCard('t_ka', 'Karat', 'Includes 995/999/95 purity values as recorded in karat_name')),
    grid('g2', card('Karat × Category', '', '<div id="kh1"></div>'), card('Karat × Channel', '', '<div id="kh2"></div>')),
    grid('g1', card('Karat × Price Range', '', '<div id="kh3"></div>')),
    '<h2 class="sh">Diamond</h2>',
    grid('g2', chartCard('db_c', 'Sales by Diamond Weight Band', 'Lines with no band are shown separately as “Not populated”', 280), tableCard('t_db', 'Diamond Weight Band', '')),
    grid('g3', tableCard('t_sol', 'Solitaire vs Non-solitaire', ''), tableCard('t_ds', 'Diamond Setting', ''), tableCard('t_dsh', 'Diamond Shape', '')),
    insight('ins5')),
  draw() {
    const rows = S.f, t = total(rows);
    drill('jw_dr', [{ name: 'Metal', key: r => r.k_metal }, { name: 'Metal Color', key: r => r.k_mcolor }, { name: 'Karat', key: r => r.k_karat }, { name: 'Product Type', key: r => r.k_type }, { name: 'SKU', key: r => r.k_sku }], rows, { root: 'All metals' });
    hbar('mt_c', sorted(group(rows, r => r.k_metal + ' · ' + r.k_mcolor)), 'sales', { n: 12 });
    dimTable('t_mt', rows, r => r.k_metal, 'Metal', { search: false });
    heat('mh1', rows, r => r.k_metal, r => r.k_chan, {});
    metricHbar('ka_c', rows, r => r.k_karat);
    dimTable('t_ka', rows, r => r.k_karat, 'Karat', { cols: [C.key('Karat'), C.sales, C.share, C.pcs, C.orders, C.cust, C.asp], search: false });
    heat('kh1', rows, r => r.k_karat, r => r.k_ig, {}); heat('kh2', rows, r => r.k_karat, r => r.k_chan, {}); heat('kh3', rows, r => r.k_karat, r => r.k_price, { colOrder: PRICE_ORDER });
    const dr = rows.filter(r => r.dWt > 0), dT = total(dr);
    const bandO = rows.map(r => r.k_dband).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => (parseFloat(a) || (a === NP ? 99 : 98)) - (parseFloat(b) || (b === NP ? 99 : 98)));
    const dbg = bandO.map(k => group(rows, r => r.k_dband === k ? k : null)[0]).filter(Boolean);
    hbar('db_c', dbg, 'sales', { colors: dbg.map(g => g.key === NP ? css('--muted') : PAL()[0]) });
    tbl('t_db', { name: 'diamond_band', search: false, rows: dbg, pageSize: 12, cols: [C.key('Weight band'), C.sales, C.share, C.orders, C.pcs, C.asp, { h: 'Diamond ct', f: g => wt(g.dWt), v: g => g.dWt, cls: 'num' }] });
    dimTable('t_sol', rows, r => r.k_sol, 'Solitaire', { cols: [C.key('Type'), C.sales, C.share, C.orders, C.pcs, C.asp], search: false });
    dimTable('t_ds', rows, r => r.k_dset, 'Setting', { cols: [C.key('Setting'), C.sales, C.share, C.orders, C.pcs], search: false });
    dimTable('t_dsh', rows, r => r.k_dshape, 'Shape', { cols: [C.key('Shape'), C.sales, C.share, C.orders, C.pcs], search: false });
    const me = sorted(group(rows, r => r.k_metal)), ka = sorted(group(rows, r => r.k_karat)), k18 = ka.find(g => g.key === '18KT'), k14 = ka.find(g => g.key === '14KT');
    const sol = group(rows, r => r.k_sol).find(g => g.key === 'Solitaire');
    setInsight('ins5', [me[0] ? `${me[0].key} contributed ${pct(me[0].share)} of net sales (${moneyX(me[0].sales)}).` : '', ka[0] ? `${ka[0].key} led karat with ${pct(ka[0].share)} of net sales${k18 && ka[0] !== k18 ? `; 18KT = ${pct(k18.share)}` : ''}${k14 && ka[0] !== k14 ? `; 14KT = ${pct(k14.share)}` : ''}.` : '', dT.lines ? `Diamond lines: ${int(dT.lines)} (${pct(div(dT.lines, t.lines) * 100)} of lines) carrying ${wt(dT.dWt)}.` : '', sol ? `Solitaire lines contributed ${moneyX(sol.sales)} (${pct(sol.share)} of net sales) from ${int(sol.pcs)} pieces.` : '', `Diamond weight band is missing on ${pct(100 - completeness(rows, r => r.dband))} of lines.`]);
  }
};

// ---------------------------------------------------------------- P6 Pricing & discount
P.p6 = {
  html: () => list(
    grid('g2', chartCard('pr_c', 'Sales vs Orders by Price Band', 'Bars = net sales, line = % of orders', 300), tableCard('t_pr', 'Price Range', 'Bands are the source Price_Range values')),
    grid('g2', card('Price Range × Category', '', '<div id="ph1"></div>'), card('Price Range × Channel', '', '<div id="ph2"></div>'), card('Price Range × Customer Type', '', '<div id="ph3"></div>'), card('Price Range × Metal', '', '<div id="ph4"></div>')),
    grid('g1', card('Price Range × Karat', '', '<div id="ph5"></div>')),
    insight('ins6')),
  draw() {
    const rows = S.f, t = total(rows), P_ = PAL();
    const pg = orderBy(group(rows, r => r.k_price), PRICE_ORDER);
    mk('pr_c', { data: { labels: pg.map(g => g.key), datasets: [{ type: 'bar', label: 'Net Sales', data: pg.map(g => g.sales), backgroundColor: P_[0], yAxisID: 'y' }, { type: 'line', label: '% of orders', data: pg.map(g => div(g.o, t.o) * 100), borderColor: P_[1], backgroundColor: P_[1], yAxisID: 'y1' }] }, options: { scales: { y: { ticks: axisMoney }, y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: v => v + '%' } } }, plugins: { tooltip: { callbacks: { label: c => c.dataset.label === 'Net Sales' ? moneyX(c.parsed.y) : pct(c.parsed.y), afterBody: it => { const g = pg[it[0].dataIndex]; return [`Orders ${int(g.o)} · Pieces ${int(g.pcs)} · AOV ${moneyX(g.aov)}`]; } } } } } });
    dimTable('t_pr', rows, r => r.k_price, 'Price range', { order: PRICE_ORDER, cols: [C.key('Price range'), C.sales, C.share, C.orders, { h: 'Order %', f: g => pct(div(g.o, t.o) * 100), v: g => g.o, cls: 'num' }, C.pcs, C.cust, C.aov], search: false });
    heat('ph1', rows, r => r.k_price, r => r.k_ig, { rowOrder: PRICE_ORDER }); heat('ph2', rows, r => r.k_price, r => r.k_chan, { rowOrder: PRICE_ORDER }); heat('ph3', rows.filter(r => r.ctype), r => r.k_price, r => r.k_ctype, { rowOrder: PRICE_ORDER }); heat('ph4', rows, r => r.k_price, r => r.k_metal, { rowOrder: PRICE_ORDER }); heat('ph5', rows, r => r.k_price, r => r.k_karat, { rowOrder: PRICE_ORDER });
    const pS = top1(pg), pO = [...pg].sort((a, b) => b.o - a.o)[0];
    setInsight('ins6', [pS ? `The ${pS.key} band carried ${pct(pS.share)} of net sales; the ${pO.key} band carried ${pct(div(pO.o, t.o) * 100)} of orders.` : '']);
  }
};

// ---------------------------------------------------------------- P7 Geography & Store
P.p7 = {
  html: () => list(
    grid('g2', chartCard('st_c', 'Sales by State (populated only)', '', 280), tableCard('t_state', 'State', '')),
    grid('g2', chartCard('ci_c', 'Top 15 Cities (populated only)', CITY_MERGE_NOTE, 320), tableCard('t_city', 'City', CITY_MERGE_NOTE)),
    '<h2 class="sh">Company / Store</h2>',
    grid('g3', chartCard('co_s', 'Store Sales Comparison', '', 280), chartCard('co_a', 'Store Average Invoice Value', 'Net sales ÷ distinct orders', 280), chartCard('co_o', 'Store Order Volume', 'Distinct orders', 280)),
    grid('g1', chartCard('co_t', 'Store Sales Trend', 'Monthly net sales stacked by store', 280)),
    grid('g1', chartCard('co_ct', 'Store Customer Trend', 'Distinct customers per month by store', 280)),
    grid('g1', tableCard('t_co', 'Company / Store Performance', 'company_code is the store identifier; city is not used as a store proxy')),
    grid('g1', card('Drill-down: Company → City → Customer → Order → SKU', 'Rows with no city appear as “Not populated”', '<div id="co_dr"></div>')),
    grid('g1', card('Drill-down: State → City → Store', '', '<div id="geo_dr"></div>')),
    insight('ins7')),
  draw() {
    const rows = S.f, t = total(rows);
    const gr = rows.filter(r => r.state), cr = rows.filter(r => r.city);
    hbar('st_c', sorted(group(gr, r => r.state)), 'sales', { n: 12 }); dimTable('t_state', gr, r => r.state, 'State', { search: false });
    hbar('ci_c', sorted(group(cr, r => r.city)), 'sales', { n: 15 }); dimTable('t_city', cr, r => r.city, 'City', { cols: [C.key('City'), C.sales, C.share, C.orders, C.cust, C.aov] });
    const co = sorted(group(rows, r => r.k_co));
    hbar('co_s', co, 'sales'); hbar('co_a', [...co].sort((a, b) => b.aov - a.aov), 'aov'); hbar('co_o', [...co].sort((a, b) => b.o - a.o), 'o');
    stackedByMonth('co_t', rows, r => r.k_co, 8);
    const P_ = PAL(), months = [...new Set(rows.filter(r => r.month).map(r => r.month))].sort(), cm = new Map(group(rows.filter(r => r.month), r => r.k_co + '\u0001' + r.month).map(g => [g.key, g]));
    mk('co_ct', { type: 'line', data: { labels: months.map(monthLabel), datasets: co.slice(0, 8).map((g, i) => ({ label: g.key, data: months.map(m => cm.get(g.key + '\u0001' + m)?.c || 0), borderColor: P_[i % 8], backgroundColor: P_[i % 8], tension: .2 })) }, options: { plugins: { tooltip: { mode: 'index', intersect: false } } } });
    tbl('t_co', { name: 'company_store', search: false, sort: 'Net Sales', rows: co, cols: [C.key('Company'), C.sales, C.share, C.orders, C.pcs, C.cust, C.aov, C.newC, C.repC, C.newPct, C.repPct, C.discPct] });
    drill('co_dr', [{ name: 'Company', key: r => r.k_co }, { name: 'City', key: r => r.k_city || (r.k_city = nz(r.city)) }, { name: 'Customer', key: r => r.k_cust }, { name: 'Order', key: r => r.doc || NP }, { name: 'SKU', key: r => r.k_sku }], rows, { root: 'All companies' });
    drill('geo_dr', [{ name: 'State', key: r => nz(r.state) }, { name: 'City', key: r => nz(r.city) }, { name: 'Store', key: r => r.k_co }], rows, { root: 'All states' });
    const cs = sorted(group(gr, r => r.state)), cc = sorted(group(cr, r => r.city));
    setInsight('ins7', [`Only ${pct(completeness(rows, r => r.city))} of lines carry a city, so geography reflects ${pct(div(total(cr).sales, t.sales) * 100)} of net sales; the remainder is unlocated, not a real place.`, cs[0] ? `Among located sales, ${cs[0].key} contributes ${pct(div(cs[0].sales, total(gr).sales) * 100)} (${moneyX(cs[0].sales)}).` : '', cc[0] ? `Top city: ${cc[0].key} with ${moneyX(cc[0].sales)} from ${int(cc[0].o)} orders and ${int(cc[0].c)} customers.` : '', co[0] ? `${co[0].key} is the largest store (${pct(co[0].share)} of sales, ${int(co[0].o)} orders).` : '', `Hypothesis: the “${NP}” geography is likely concentrated in store-channel sales where the address is not captured — verify against the Channel split before relying on it.`]);
  }
};

// ---------------------------------------------------------------- P8 Data quality & detail
function dqChecks() {
  const A = S.all, N = A.length, nets = A.map(r => r.net).filter(x => x > 0).sort((a, b) => a - b), q = p => nets[Math.floor(p * nets.length)] || 0, iqr = q(.75) - q(.25), fence = q(.75) + 3 * iqr;
  const keyCount = new Map(); A.forEach(r => { const k = (r.doc || '') + '|' + (r.line || ''); keyCount.set(k, (keyCount.get(k) || 0) + 1); });
  const rowSig = new Map(); A.forEach(r => { const { _i, ...rest } = r; const k = JSON.stringify(Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('k_') && !['month', 'week', 'dow', 'gross'].includes(k)))); rowSig.set(k, (rowSig.get(k) || 0) + 1); });
  const rowDup = new Set([...rowSig.entries()].filter(([, c]) => c > 1).map(([k]) => k));
  // inconsistent spellings: same normalised text, different raw values
  const incons = []; ['chan', 'ful', 'co', 'ig', 'type', 'sub1', 'sub2', 'metal', 'mcolor', 'karat', 'vendor', 'coll', 'city', 'state'].forEach(f => { const m = new Map(); A.forEach(r => { const v = r[f]; if (v == null) return; const n = String(v).toLowerCase().replace(/[^a-z0-9]/g, ''); if (!m.has(n)) m.set(n, new Set()); m.get(n).add(v); }); m.forEach((set, n) => { if (set.size > 1) incons.push({ f, vals: [...set] }); }); });
  const inconsRows = new Set(); incons.forEach(x => A.forEach(r => { if (x.vals.includes(r[x.f])) inconsRows.add(r._i); }));
  const C_ = [
    ['Missing transaction date', r => !r.date], ['Missing SKU', r => !r.sku], ['Missing product category (item group / type)', r => !r.ig || !r.type], ['Missing customer ID (party_id)', r => r.party == null],
    ['Missing city', r => !r.city], ['Missing state', r => !r.state], ['Zero-value sales (net_sale = 0)', r => r.net === 0], ['Negative sales (net_sale < 0)', r => r.net < 0],
    [`Extremely high value (net_sale > ${moneyX(fence)} = Q3 + 3×IQR of positive lines)`, r => r.net > fence], ['Missing price range', r => !r.price], ['Missing karat', r => !r.karat], ['Missing metal', r => !r.metal],
    ['Duplicate document + item-line combination', r => keyCount.get((r.doc || '') + '|' + (r.line || '')) > 1], ['Missing document number', r => !r.doc],
    ['Invalid numeric (pieces ≤ 0, negative discount, or discount > gross)', r => r.pcs <= 0 || r.disc < 0 || r.adisc < 0 || !isFinite(r.net)],
    ['Positive pieces with zero net sale', r => r.net === 0 && r.pcs > 0], ['Missing customer_type', r => !r.ctype], ['Missing diamond weight band', r => !r.dband], ['Missing collection', r => !r.coll],
    ['Inconsistent category spelling (case / punctuation variants)', r => inconsRows.has(r._i)],
  ];
  const out = C_.map(([label, fn]) => { const hits = A.filter(fn); return { label, n: hits.length, p: div(hits.length, N) * 100, ex: hits.slice(0, 3) }; });
  const dupRows = A.filter(r => { const { _i, ...rest } = r; return rowDup.has(JSON.stringify(Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('k_') && !['month', 'week', 'dow', 'gross'].includes(k))))); });
  out.splice(13, 0, { label: 'Fully duplicate rows (all source fields identical)', n: dupRows.length, p: div(dupRows.length, N) * 100, ex: dupRows.slice(0, 3) });
  return { out, incons };
}
const FIELDS = [['date', 'Transaction_Date'], ['chan', 'Channel'], ['ful', 'Fullfillment'], ['co', 'company_code'], ['party', 'party_id'], ['ctype', 'customer_type'], ['ageing', 'egeing'], ['city', 'city_name'], ['state', 'state_name'], ['country', 'country_name'], ['ig', 'item_group_name'], ['type', 'type_name'], ['sub1', 'PF_sub_category_1'], ['sub2', 'PF_sub_category_2'], ['sku', 'Full_sku'], ['style', 'style_code'], ['title', 'Product_Title'], ['metal', 'metal_name'], ['mcolor', 'metal_color_name'], ['karat', 'karat_name'], ['vendor', 'Vendor'], ['sol', 'Is_Solitaire'], ['dset', 'Diamond_Setting'], ['dshape', 'Diamond_1_shape'], ['gset', 'Gemstone_Setting'], ['gshape', 'Gemstone_1_Shape'], ['dband', 'Diamond_Weight_Band'], ['price', 'Price_Range'], ['best', 'bestseller'], ['coll', 'collection_name'], ['dWt', 'diamond_weight'], ['dAmt', 'diamond_amount']];
P.p8 = {
  html: () => list(
    grid('g1', card('Data Quality & Exceptions', 'Computed on the full dataset (not affected by the filters). No record is removed anywhere in this report; the only optional exclusion is the “Exclude zero-value lines” switch.', '<div id="dq_t"></div>')),
    grid('g2', tableCard('dq_f', 'Field Completeness', 'Share of lines with a value'), card('Grain & Filters Applied', '', '<div id="dq_g"></div>')),
    grid('g1', tableCard('t_det', 'Transaction-level Detail', 'One row per sales line for the current filters. Search, sort, choose columns, export. Email, mobile and address are not loaded.')),
    grid('g1', card('Calculation Definitions', '', `<table class="t"><thead><tr><th>Metric</th><th>Formula</th></tr></thead><tbody>
      <tr><td class="lead">Net Sales</td><td>SUM(net_sale). Not assumed to be gross revenue or margin.</td></tr><tr style="display:none"><td class="lead">Gross / Base Sales</td><td>SUM(net_sale + discount + additional_discount) — assumes net_sale is post-discount (component amounts sum to ≈ net_sale, not net_sale + discount).</td></tr>
      <tr><td class="lead">Orders / Customers / SKUs</td><td>COUNT DISTINCT document_no / party_id / Full_sku. Sales Lines = COUNT(*).</td></tr><tr><td class="lead">Pieces</td><td>SUM(pieces)</td></tr>
      <tr><td class="lead">Sales % / Order % / Customer %</td><td>group value ÷ total of the same metric in the filtered data</td></tr>
      <tr><td class="lead">New / Repeat Customer %</td><td>distinct party_id with a New (Repeat) line ÷ distinct customers; customer_type is read per line so a customer can appear in both</td></tr>
      <tr><td class="lead">Profit / margin</td><td>Not calculated — no cost field exists in marketing_sale.</td></tr></tbody></table>`)),
    grid('g1', card('Key Business Observations', 'Each observation carries its metric; computed from the current filters.', '<ul id="obs"></ul>')),
    insight('ins8')),
  draw() {
    const { out, incons } = dqChecks(), N = S.all.length;
    document.getElementById('dq_t').innerHTML = `<div class="tbl-wrap"><table class="t"><thead><tr><th>Check</th><th class="num">Lines</th><th class="num">% of lines</th><th>Example records (document · line · SKU · net sale)</th></tr></thead><tbody>${out.map(x => `<tr class="${x.n ? 'flag' : ''}"><td class="lead">${esc(x.label)}</td><td class="num strong">${int(x.n)}</td><td class="num">${pct(x.p)}</td><td class="small">${x.n ? x.ex.map(r => `${esc(r.doc || '∅')} · ${esc(String(r.line || '∅').slice(-6))} · ${esc(r.sku || '∅')} · ${moneyX(r.net)}`).join('<br>') : '✓ none'}</td></tr>`).join('')}</tbody></table></div>${incons.length ? `<p class="note">Spelling variants found: ${incons.map(x => `${x.f}: ${x.vals.map(esc).join(' / ')}`).join('; ')}</p>` : ''}<p class="note">Placeholders treated as missing: collection_name “NA” on ${int(PLACEHOLDERS.coll)} lines and PF_sub_category_2 “0” on ${int(PLACEHOLDERS.sub2)} lines.</p><p class="note">Known raw values kept as-is: the channel is spelled “Managment_sale” in the source; bestseller has values “Bestseller”, “0” and NULL.</p>`;
    tbl('dq_f', { name: 'completeness', search: false, pageSize: 12, sort: 'Populated %', rows: FIELDS.map(([k, n]) => ({ n, p: completeness(S.all, r => r[k]) })), cols: [{ h: 'Field', f: x => x.n, cls: 'lead' }, { h: 'Populated %', f: x => pct(x.p), v: x => x.p, cls: 'num' }, { h: 'Null %', f: x => pct(100 - x.p), v: x => 100 - x.p, cls: 'num' }] });
    document.getElementById('dq_g').innerHTML = `<p><b>Grain:</b> one row per sales item line (${int(N)} lines in table, ${int(new Set(S.all.map(r => r.doc)).size)} distinct documents, ${int(new Set(S.all.map(r => r.party)).size)} customers). Rows are never counted as orders or customers.</p><p><b>Filtered view:</b> ${int(S.f.length)} of ${int(N)} lines.</p><p><b>Active filters:</b> ${filterSummary().map(esc).join('; ') || 'none'}.</p><p><b>Source:</b> lucirajewelry-prod.ds_imputed_reporting.marketing_sale · loaded ${S.generatedAt ? new Date(S.generatedAt).toLocaleString('en-IN') : ''}. Primary date: Transaction_Date.</p>`;
    tbl('t_det', { name: 'transactions', colSelect: true, pageSize: 15, sort: 'Date', rows: S.f, cols: [{ h: 'Date', f: r => r.date || '—', cls: 'lead' }, { h: 'Document No', f: r => r.doc || '—' }, { h: 'Customer', f: r => r.party == null ? NP : `<a class="cid" data-id="${r.party}" title="Open full customer profile">${r.party}</a>`, v: r => r.k_cust, html: true }, { h: 'Channel', f: r => r.k_chan }, { h: 'Store', f: r => r.k_co }, { h: 'Product', f: r => r.title || r.styleName || '—' }, { h: 'SKU', f: r => r.k_sku }, { h: 'Category', f: r => r.k_ig + ' › ' + r.k_type }, { h: 'Pieces', f: r => int(r.pcs), v: r => r.pcs, cls: 'num' }, { h: 'Net Sales', f: r => moneyX(r.net), v: r => r.net, cls: 'num strong' }, { h: 'Discount', f: r => moneyX(r.disc + r.adisc), v: r => r.disc + r.adisc, cls: 'num' }, { h: 'Customer Type', f: r => r.k_ctype, hidden: true }, { h: 'Metal', f: r => r.k_metal, hidden: true }, { h: 'Karat', f: r => r.k_karat, hidden: true }, { h: 'Price Range', f: r => r.k_price, hidden: true }, { h: 'Vendor', f: r => r.k_vendor, hidden: true }] });
    setInsight('ins8', [`${int(out.filter(x => x.n).length)} of ${int(out.length)} checks flag at least one line.`, ...out.filter(x => x.p >= 5).map(x => `${x.label}: ${int(x.n)} lines (${pct(x.p)}).`)]);
    document.getElementById('obs').innerHTML = observations().map(o => `<li>${o}</li>`).join('') || '<li>No data for the current filters.</li>';
  }
};

// ================================================================== P9 Compare (period vs period)
// Independent of the global date filter (it compares two periods of its own); every other global filter still applies.
const CMP_PRESETS = [['today', 'Today', 'Yesterday'], ['week', 'Current week', 'Last week'], ['month', 'Current month', 'Last month'], ['quarter', 'Current quarter', 'Last quarter'], ['year', 'Current year', 'Last year'], ['half', 'Current half-year', 'Last half-year'], ['custom', 'Period A', 'Period B']];
// Physical stores: where the sale happened (customer address is mostly blank on store sales, so it can't be used for region/city).
// Online / HO sales have no store location and keep the customer's state / city from the order.
const STORE_GEO = { BO1: ['Maharashtra', 'Mumbai'], CS1: ['Maharashtra', 'Mumbai'], FCS: ['Maharashtra', 'Mumbai'], PN1: ['Maharashtra', 'Pune'], PV1: ['Delhi', 'Delhi'], LPN: ['Delhi', 'Delhi'], N18: ['Delhi', 'Noida'] };
const cmpState_ = r => STORE_GEO[r.co] ? STORE_GEO[r.co][0] : nz(r.state);
const cmpCity_ = r => STORE_GEO[r.co] ? STORE_GEO[r.co][1] : nz(r.city);
const CMP_DIMS = [
  { id: 'store', title: 'Store to store', label: 'Store', key: r => r.k_co },
  { id: 'reg', title: 'Region wise (state of the store; online orders use the customer’s state)', label: 'Region', key: cmpState_ },
  { id: 'city', title: 'City wise', label: 'City', key: cmpCity_ },
  { id: 'cat', title: 'Category wise', label: 'Category', key: r => r.k_ig },
  { id: 'kar', title: 'Karat wise', label: 'Karat', key: r => r.k_karat },
  { id: 'vend', title: 'Vendor wise', label: 'Vendor', key: r => r.k_vendor },
];
const CMP = { preset: 'month', A: null, B: null, like: false, dm: {} }; // dm = per-chart metric (sales / orders / pcs)
function cmpRanges(k, today) {
  const d = new Date(today + 'T00:00:00Z'), y = d.getUTCFullYear(), m = d.getUTCMonth();
  const iso = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
  if (k === 'today') return [[today, today], [addDays(today, -1), addDays(today, -1)]];
  if (k === 'week') { const w = isoWeekStart(today); return [[w, today], [addDays(w, -7), addDays(w, -1)]]; } // weeks start Monday
  if (k === 'month') return [[iso(y, m, 1), today], [iso(y, m - 1, 1), iso(y, m, 0)]];
  if (k === 'quarter') { const q = Math.floor(m / 3) * 3; return [[iso(y, q, 1), today], [iso(y, q - 3, 1), iso(y, q, 0)]]; } // calendar quarters
  if (k === 'year') return [[iso(y, 0, 1), today], [iso(y - 1, 0, 1), iso(y, 0, 0)]];
  const h = m < 6 ? 0 : 6; return [[iso(y, h, 1), today], [iso(y, h - 6, 1), iso(y, h, 0)]]; // calendar half-years (Jan–Jun, Jul–Dec)
}
function cmpState() {
  if (CMP.preset !== 'custom') { const [a, b] = cmpRanges(CMP.preset, istToday()); CMP.A = a; CMP.B = b; }
  else if (!CMP.A || !CMP.B) { const [a, b] = cmpRanges('month', istToday()); CMP.A = CMP.A || a; CMP.B = CMP.B || b; }
  const A = CMP.A.slice(), B = CMP.B.slice();
  if (CMP.like) { const lim = addDays(B[0], daysBetween(A[0], A[1])); if (lim < B[1]) B[1] = lim; } // same number of elapsed days
  const pr = CMP_PRESETS.find(x => x[0] === CMP.preset);
  return { A, B, la: pr[1], lb: pr[2] };
}
const inRange = (rows, [f, t]) => rows.filter(r => r.date && r.date >= f && r.date <= t);
function cmpRerender() { const y = window.scrollY; Object.keys(CH).forEach(k => { CH[k].destroy(); delete CH[k]; }); document.getElementById('pageBody').innerHTML = P.p9.html(); P.p9.draw(); window.scrollTo(0, y); }
function cmpSetPreset(v) { CMP.preset = v; if (v === 'custom') { CMP.A = CMP.A || cmpRanges('month', istToday())[0]; CMP.B = CMP.B || cmpRanges('month', istToday())[1]; } cmpRerender(); }
function cmpSetDate(w, i, v) { if (!v) return; CMP[w] = CMP[w].slice(); CMP[w][i] = v; CMP.preset = 'custom'; cmpRerender(); }
function cmpSetLike(v) { CMP.like = v; cmpRerender(); }
P.p9 = {
  html: () => {
    const c = cmpState();
    const dt = (w, i, v) => `<input type="date" value="${v}" onchange="cmpSetDate('${w}',${i},this.value)">`;
    return list(
      card('Compare periods', 'Pick a ready-made comparison or edit the dates of either period. “Current” periods run up to today (IST); “Last” periods are the full previous period. Quarters and half-years are calendar-based. The global date filter does not apply here; the other global filters do.',
        `<div class="frow">
          <label class="tf"><span>Comparison</span><select onchange="cmpSetPreset(this.value)">${CMP_PRESETS.map(([k, a, b]) => `<option value="${k}"${CMP.preset === k ? ' selected' : ''}>${k === 'custom' ? 'Custom dates' : a + ' vs ' + b}</option>`).join('')}</select></label>
          <label class="tf"><span>${esc(c.la)} — from</span>${dt('A', 0, CMP.A[0])}</label><label class="tf"><span>to</span>${dt('A', 1, CMP.A[1])}</label>
          <label class="tf"><span>${esc(c.lb)} — from</span>${dt('B', 0, CMP.B[0])}</label><label class="tf"><span>to</span>${dt('B', 1, CMP.B[1])}</label>
          <label class="chk"><input type="checkbox" ${CMP.like ? 'checked' : ''} onchange="cmpSetLike(this.checked)"> Same elapsed days (like-for-like)</label>
        </div><p class="note" id="cmp_note"></p>`),
      '<h2 class="sh">Summary</h2>', '<div id="cmp_kpi"></div>',
      ...CMP_DIMS.flatMap(d => [`<h2 class="sh">${d.title}</h2>`, grid('g1', chartCard('cmp_' + d.id + '_c', d.label + ' comparison', '', 300)), grid('g1', tableCard('cmp_' + d.id + '_t', d.label + ' — period comparison', ''))]));
  },
  draw() {
    const c = cmpState(), base = S.fNoDate, rA = inRange(base, c.A), rB = inRange(base, c.B), P_ = PAL();
    const nm = r => `${r[0]} → ${r[1]}`, la = c.la, lb = c.lb;
    document.getElementById('cmp_note').textContent = `${la}: ${nm(c.A)} (${int(rA.length)} lines) · ${lb}: ${nm(c.B)} (${int(rB.length)} lines)${CMP.like ? ' · B shortened to the same number of days as A' : ''}`;
    const tA = total(rA), tB = total(rB), up = (a, b) => { const g = growth(a, b); return g == null ? 'n/a' : gTxt(g); };
    document.getElementById('cmp_kpi').innerHTML = `<div class="kpis">${[['Net Sales', tA.sales, tB.sales, money], ['Orders', tA.o, tB.o, int], ['Pieces', tA.pcs, tB.pcs, int], ['Customers', tA.c, tB.c, int], ['Avg Invoice Value', tA.aov, tB.aov, money], ['Avg Selling Price', tA.asp, tB.asp, money]]
      .map(([l, a, b, f]) => kpi(l, `${f(a)} <small style="font-weight:500">${up(a, b)}</small>`, `${la} ${f(a)} vs ${lb} ${f(b)}`, a >= b ? 'pos' : 'neg')).join('')}</div>`;
    const CMP_M = [['sales', 'Net sales'], ['orders', 'Orders'], ['pcs', 'Pieces']];
    const dims = CMP_DIMS.map(d => [d.id, d.key, d.label]);
    dims.forEach(([id, keyFn, label]) => {
      const ga = new Map(group(rA, keyFn).map(g => [g.key, g])), gb = new Map(group(rB, keyFn).map(g => [g.key, g]));
      const rows = [...new Set([...ga.keys(), ...gb.keys()])].map(k => ({ key: k, a: ga.get(k) || finalize(newG(k)), b: gb.get(k) || finalize(newG(k)) })).filter(x => x.a.sales || x.b.sales);
      const drawCmpChart = () => {
        const M = CMP.dm[id] || 'sales', mv = g => M === 'sales' ? g.sales : M === 'orders' ? g.o : g.pcs, mf = M === 'sales' ? money : int;
        const cv = document.getElementById('cmp_' + id + '_c'); if (!cv) return;
        cv.parentElement.style.height = '360px';
        let ctl = document.getElementById('cmp_' + id + '_ctl');
        if (!ctl) { ctl = document.createElement('div'); ctl.id = 'cmp_' + id + '_ctl'; ctl.className = 'segs'; cv.parentElement.parentElement.insertBefore(ctl, cv.parentElement); }
        ctl.innerHTML = CMP_M.map(([k, l]) => `<button class="seg ${M === k ? 'on' : ''}" data-k="${k}" type="button">${l}</button>`).join('');
        ctl.onclick = e => { const bt = e.target.closest('[data-k]'); if (bt) { CMP.dm[id] = bt.dataset.k; drawCmpChart(); } };
        const best = [...rows].sort((x, y) => Math.max(mv(y.a), mv(y.b)) - Math.max(mv(x.a), mv(x.b))).slice(0, id === 'store' || id === 'city' ? 15 : 12);
        mk('cmp_' + id + '_c', { type: 'bar', data: { labels: best.map(x => x.key), datasets: [{ label: la, data: best.map(x => mv(x.a)), backgroundColor: P_[0] }, { label: lb, data: best.map(x => mv(x.b)), backgroundColor: P_[1] }] },
          options: { scales: { x: { ticks: { maxRotation: 40, autoSkip: false } }, y: { ticks: { callback: v => mf(v) } } }, plugins: { tooltip: { callbacks: { label: ct => `${ct.dataset.label}: ${mf(ct.parsed.y)}` } } } } });
      };
      drawCmpChart();
      const dcol = (h, f, v) => ({ h, f, v, cls: 'num' });
      const chg = (h, fa, fb) => ({ h, f: x => { const g = growth(fa(x), fb(x)); return g == null ? 'n/a' : gTxt(g); }, v: x => { const g = growth(fa(x), fb(x)); return g == null ? -1e9 : g; }, cls: 'num' });
      const abs = (h, fa, fb) => ({ h, f: x => { const d = fa(x) - fb(x); return (d >= 0 ? '+' : '') + money(d); }, v: x => fa(x) - fb(x), cls: 'num' });
      tbl('cmp_' + id + '_t', { name: `cmp_${id}_${la}_${lb}`, pageSize: 15, search: rows.length > 15, sort: `Net Sales · ${la}`, rows,
        cols: [{ h: label, f: x => x.key, cls: 'lead' },
          dcol(`Net Sales · ${la}`, x => money(x.a.sales), x => x.a.sales), dcol(`Net Sales · ${lb}`, x => money(x.b.sales), x => x.b.sales), abs('Net Sales Δ', x => x.a.sales, x => x.b.sales), chg('Net Sales Δ %', x => x.a.sales, x => x.b.sales),
          dcol(`Orders · ${la}`, x => int(x.a.o), x => x.a.o), dcol(`Orders · ${lb}`, x => int(x.b.o), x => x.b.o), chg('Orders Δ %', x => x.a.o, x => x.b.o),
          dcol(`Pieces · ${la}`, x => int(x.a.pcs), x => x.a.pcs), dcol(`Pieces · ${lb}`, x => int(x.b.pcs), x => x.b.pcs), chg('Pieces Δ %', x => x.a.pcs, x => x.b.pcs),
          dcol(`Sales % · ${la}`, x => pct(x.a.share), x => x.a.share), dcol(`Sales % · ${lb}`, x => pct(x.b.share), x => x.b.share)] });
    });
  }
};

// Data Quality & Detail tab removed from the dashboard (its page code is no longer reachable).
delete P.p8;

// ================================================================== P10 Logic (how the dashboard works, in plain words)
const LOGIC = [
  ['Where the data comes from', [
    'One BigQuery table: <b>marketing_sale</b>. One row = one sales line (one item on one invoice).',
    'Covers <b>1 Oct 2025 → today</b>. The page re-checks for new data every 60 seconds (green dot = live).',
    'Everything on every tab is calculated from these same lines, so numbers always match each other.']],
  ['Main numbers', [
    '<b>Net Sales</b> = sum of net_sale (sale amount after discounts, tax not included in the base).',
    '<b>Orders</b> = distinct invoice numbers. <b>Pieces</b> = sum of pieces. <b>Customers</b> = distinct customer IDs.',
    '<b>Avg Invoice Value</b> = Net Sales ÷ Orders. <b>Avg Selling Price</b> = Net Sales ÷ Pieces.',
    '<b>Discount %</b> = (discount + additional discount) ÷ (net sales + discounts).']],
  ['Filters', [
    'Filters at the top apply to <b>every tab</b>: dates, channel, store, category, karat, vendor, SKU, etc. Empty = all.',
    'Date buttons: Today, Yesterday, This month, Last week, Last month. Default = <b>this month</b>.',
    'Weeks start on <b>Monday</b>. All dates are India time (IST).',
    'Trend charts ignore the date filter (they always show every month) but follow all other filters.']],
  ['New vs Repeat customers', [
    'Each line is tagged New or Repeat in the data.',
    'A customer is <b>either New or Repeat, never both</b>: it follows their <b>most recent purchase</b>. If that purchase is Repeat, they are not counted as New.  Online-influenced is <b>not</b> a third type: a New or a Repeat customer can also be online-influenced, so it is shown as an extra split on top of New / Repeat.',
    'Repeat sales % = sales on Repeat lines ÷ total sales.',
    '<b>Online-influenced store customer</b>: a customer with a <b>store</b> purchase who, (matched by mobile / email) already had an online touch on or before that purchase date: a website-activity deal in <b>Zoho CRM</b> (product view, add to cart, signup, login) <b>or</b> a <b>Shopify</b> customer with email <b>subscribed</b> (signup date = account created date). WhatsApp-only / ad-click deals are not counted.']],
  ['Charts & percentages', [
    'Labels on bars and slices are a <b>% share</b>: pie = share of whole; stacked bar = share of that column; single bar / line = share of that series total.',
    'Averages (invoice value, selling price) get no % label.',
    'Items with zero sales are left out. Under 2% share, no label is shown.',
    'Net sales / Orders / Pieces buttons switch only that chart.']],
  ['Tables', [
    '<b>Sales %</b> = that row ÷ total of all rows listed.',
    'Distinct counts (orders, customers) are <b>not added</b> across rows, so the Total row shows the true unique count.',
    'Click a column to sort. Export CSV downloads what you see.']],
  ['Compare tab', [
    'Compares <b>Period A vs Period B</b>: pick a ready pair or type your own dates. The global date filter is not used here.',
    '“Current” period runs <b>from its start to today</b>; “Last” is the <b>full</b> previous period. Tick “same elapsed days” for a fair like-for-like.',
    'Quarters and half-years are calendar based (Jan–Mar, Jan–Jun …).',
    'Change % = (A − B) ÷ B. Shows n/a if B is zero.']],
  ['Store, Region & City', [
    'Customer address is mostly blank on store sales, so in Compare <b>Region and City come from the store</b>: Borivali / Chembur = Maharashtra·Mumbai, Pune = Maharashtra·Pune, Lajpat Nagar / Paschim Vihar = Delhi, Noida = Delhi·Noida.',
    'Online (HO) sales have no store, so they use the customer’s own state / city; if blank, they show “Not populated”.',
    'On the Geography tab, nearby areas are merged into one city (all Delhi areas → Delhi, Mumbai Suburban → Mumbai, Bangalore Urban → Bengaluru, etc.).']],
  ['Good to know', [
    'Heatmap shading = share of that row’s total (darker = bigger share).',
    '“Not populated” means the data has no value there — it is not a real category.',
    'Karat includes 995 / 999 purity values exactly as recorded in the data.',
    'Diamond weight = sum of diamond_weight (carats).']],
];
P.p10 = {
  html: () => `<div class="logic">${grid('g2', ...LOGIC.map(([h, items]) => card(h, '', `<ul>${items.map(x => `<li>${x}</li>`).join('')}</ul>`)))}</div>`,
  draw() {}
};

// ================================================================== P11 Sale Dump
// Every loaded marketing_sale column, one row per sales line, raw values exactly as in BigQuery (no rounding / no
// placeholder relabelling). Global filters apply; Export CSV exports ALL filtered rows, not just the visible page.
const DUMP_COLS = [['date', 'Transaction_Date'], ['doc', 'document_no'], ['line', 'item_line_no'], ['chan', 'Channel'], ['ful', 'Fullfillment'], ['co', 'company_code'],
  ['party', 'party_id'], ['pname', 'party_name'], ['ctype', 'customer_type'], ['ageing', 'ageing'], ['city', 'city_name'], ['state', 'state_name'], ['country', 'country_name'],
  ['ig', 'item_group_name'], ['type', 'type_name'], ['sub1', 'PF_sub_category_1'], ['sub2', 'PF_sub_category_2'], ['sku', 'Full_sku'], ['half', 'half_sku'],
  ['style', 'style_code'], ['styleName', 'style_name'], ['title', 'Product_Title'], ['metal', 'metal_name'], ['mcolor', 'metal_color_name'], ['karat', 'karat_name'],
  ['vendor', 'Vendor'], ['sol', 'Is_Solitaire'], ['dset', 'Diamond_Setting'], ['dshape', 'Diamond_1_shape'], ['gset', 'Gemstone_Setting'], ['gshape', 'Gemstone_1_Shape'],
  ['dband', 'Diamond_Weight_Band'], ['price', 'Price_Range'], ['best', 'bestseller'], ['coll', 'collection_name'], ['oi', 'Online_influenced'], ['pcs', 'pieces'], ['net', 'net_sale'], ['tax', 'tax_amount'],
  ['disc', 'discount'], ['adisc', 'additional_discount'], ['wt', 'net_weight'], ['mAmt', 'metal_amount'], ['dAmt', 'diamond_amount'], ['dWt', 'diamond_weight'], ['dPcs', 'diamond_pieces'],
  ['csAmt', 'color_stone_amount'], ['csWt', 'color_stone_weight'], ['csPcs', 'color_stone_pieces'], ['sAmt', 'stone_amount'], ['sWt', 'stone_weight'], ['sPcs', 'stone_pieces'], ['oAmt', 'other_amount']];
const DUMP_NUM = new Set(['party', 'ageing', 'pcs', 'net', 'tax', 'disc', 'adisc', 'wt', 'mAmt', 'dAmt', 'dWt', 'dPcs', 'csAmt', 'csWt', 'csPcs', 'sAmt', 'sWt', 'sPcs', 'oAmt']);
const dumpRaw = (r, k) => k === 'city' ? (r.cityRaw ?? r.city ?? '') : k === 'oi' ? r.k_oi : (r[k] ?? '');
P.p11 = {
  html: () => {
    const t = total(S.f);
    return list(
      `<div class="kpis">${kpi('Sales lines', int(S.f.length), 'Rows in the dump for the current filters')}${kpi('Documents', int(t.o), 'Distinct document_no')}${kpi('Net sale', money(t.sales), 'SUM(net_sale)')}${kpi('Pieces', int(t.pcs), 'SUM(pieces)')}</div>`,
      grid('g1', tableCard('t_dump', 'Sale Dump — all sales lines', `Every column loaded from ds_imputed_reporting.marketing_sale (${DUMP_COLS.length} columns), raw values as stored. Global filters apply. Search, sort, hide columns under “Columns”; Export CSV downloads all filtered rows. Email, mobile and address are not loaded.`)),
      grid('g1', tableCard('t_dump_ret', 'Sale Return Dump (PSR documents)', 'Return lines from ornaverse_erp_administration.return_items, by return document date within the selected date range. Other filters do not apply to returns.')));
  },
  draw() {
    tbl('t_dump', { name: 'sale_dump', colSelect: true, pageSize: 50, sort: 'Transaction_Date', rows: S.f,
      cols: DUMP_COLS.map(([k, h]) => DUMP_NUM.has(k) ? { h, f: r => dumpRaw(r, k), v: r => r[k] ?? 0, cls: 'num' } : { h, f: r => dumpRaw(r, k), cls: k === 'date' ? 'lead' : '' }) });
    const rets = (S.returns || []).filter(x => !((S.date.from && x.date < S.date.from) || (S.date.to && x.date > S.date.to)));
    tbl('t_dump_ret', { name: 'sale_return_dump', pageSize: 25, sort: 'Return date', rows: rets, cols: [
      { h: 'Return date', f: x => x.date || '', cls: 'lead' }, { h: 'Return document_no', f: x => x.doc || '' }, { h: 'party_id', f: x => x.party ?? '', v: x => x.party || 0, cls: 'num' },
      { h: 'sku', f: x => x.sku || '' }, { h: 'pieces', f: x => x.pcs, v: x => x.pcs, cls: 'num' }, { h: 'net_amount', f: x => x.net, v: x => x.net, cls: 'num' },
      { h: 'Original invoice document_no', f: x => x.origDoc || '' }, { h: 'Original item_line_no', f: x => x.origLine || '' }] });
  }
};

// ================================================================== P12 Spend vs Revenue
// Ad spend (Google + Meta from ads_spend_live_city_daily, Criteo from advertiser_119792_report) against REAL net sales from marketing_sale.
// Follows the global date range only (spend can't be split by karat / category), so the other global filters do not apply here.
const AD = { rows: null, err: null, loading: false, grain: null };
const AD_PLAT = [['google', 'Google Ads'], ['meta', 'Meta Ads'], ['criteo', 'Criteo']];
async function adLoad(force) {
  if (AD.loading) return; AD.loading = true;
  try {
    const res = await fetch('/api/ad-spend' + (force ? '?refresh=true' : '')); const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.statusText);
    AD.rows = d.rows; AD.err = null; AD.at = d.generatedAt;
  } catch (e) { AD.err = e.message; }
  finally { AD.loading = false; if (S.page === 'p12') adRerender(); }
}
function adRerender() { const y = window.scrollY; Object.keys(CH).forEach(k => { CH[k].destroy(); delete CH[k]; }); document.getElementById('pageBody').innerHTML = P.p12.html(); P.p12.draw(); window.scrollTo(0, y); }
function adSetGrain(g) { AD.grain = g; adRerender(); }
function adRange() { const mn = S.all.reduce((m, r) => (r.date && (!m || r.date < m) ? r.date : m), null); return [S.date.from || mn || '2025-10-01', S.date.to || S.maxDate || istToday()]; }
P.p12 = {
  html: () => {
    if (!AD.rows) return card('Spend vs Revenue', '', AD.err ? `<p class="warn">Could not load ad spend: ${esc(AD.err)}</p>` : '<p class="empty">Loading ad spend…</p>');
    const [f, t] = adRange(), span = daysBetween(f, t) + 1, g = AD.grain || (span <= 62 ? 'day' : span <= 200 ? 'week' : 'month');
    const seg = ['day', 'week', 'month'].map(k => `<button class="seg ${g === k ? 'on' : ''}" type="button" onclick="adSetGrain('${k}')">${k[0].toUpperCase() + k.slice(1)}</button>`).join('');
    return list(
      card('Ad spend vs net revenue', `Period ${f} → ${t} (follows the global date filter; other filters don't apply to ad spend). Spend = Google Ads + Meta Ads + Criteo. Revenue = real net sales from the sales table, not the ad platforms' own reported conversions. ROAS = net revenue ÷ ad spend.`, `<div class="segs">${seg}</div><div id="ad_kpi"></div>`),
      '<h2 class="sh">Spend vs revenue over time</h2>',
      grid('g1', chartCard('ad_c', 'Ad spend by platform (bars) and net revenue (line)', '', 340)),
      grid('g1', chartCard('ad_roas', 'ROAS — net revenue ÷ ad spend', '', 260)),
      grid('g1', tableCard('t_adp', 'By period', 'Spend by platform, net revenue and return')),
      '<h2 class="sh">By platform</h2>',
      grid('g1', tableCard('t_adpl', 'Platform summary', 'Impressions and clicks as reported by each platform (Criteo impressions = displays)')));
  },
  draw() {
    if (!AD.rows) { if (!AD.loading) adLoad(); return; }
    const [f, t] = adRange(), span = daysBetween(f, t) + 1, grain = AD.grain || (span <= 62 ? 'day' : span <= 200 ? 'week' : 'month');
    const P_ = PAL(), inR = d => d >= f && d <= t;
    const spend = AD.rows.filter(r => inR(r.d)), rev = S.all.filter(r => r.date && inR(r.date));
    const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const spT = sum(spend, 'sp'), revT = sum(rev, 'net');
    const x = v => (isFinite(v) ? v.toFixed(2) + 'x' : '—'), K = (l, v, d, tone) => kpi(l, v, d, tone);
    // Spend tab shows lakh / crore with 2 decimals (₹1.15 L) so the cards reconcile with the source data at a glance.
    const money2 = n => { if (n == null || isNaN(n)) return '—'; const a = Math.abs(n), sg = n < 0 ? '-' : '', f2 = v => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return a >= 1e7 ? `${sg}₹${f2(a / 1e7)} cr` : a >= 1e5 ? `${sg}₹${f2(a / 1e5)} L` : a >= 1e3 ? `${sg}₹${(a / 1e3).toLocaleString('en-IN', { maximumFractionDigits: 1 })} k` : `${sg}₹${Math.round(a)}`; };
    const plat = p => sum(spend.filter(r => r.p === p), 'sp');
    document.getElementById('ad_kpi').innerHTML = `
      <h4 class="kh">Overall</h4><div class="kpis">${K('Total ad spend', money2(spT), 'Google + Meta + Criteo. Exact: ' + moneyE(spT), 'hero')}${K('Net revenue', money2(revT), 'All channels, net sales. Exact: ' + moneyE(revT))}${K('ROAS', x(div(revT, spT)), 'Net revenue ÷ total ad spend')}${K('Ad spend % of revenue', pct(div(spT, revT) * 100), 'Total ad spend ÷ net revenue')}</div>
      <h4 class="kh">By platform</h4><div class="kpis">${AD_PLAT.map(([p, l]) => K(l, money2(plat(p)), pct(div(plat(p), spT) * 100) + ' of total spend · exact ' + moneyE(plat(p)))).join('')}</div>`;
    const key = d => grain === 'day' ? d : grain === 'week' ? isoWeekStart(d) : d.slice(0, 7);
    const lab = k => grain === 'day' ? shortDate(k) : grain === 'week' ? 'Wk ' + shortDate(k) : monthLabel(k);
    const per = new Map(), get = k => { let o = per.get(k); if (!o) { o = { key: k, google: 0, meta: 0, criteo: 0, spend: 0, rev: 0 }; per.set(k, o); } return o; };
    spend.forEach(r => { const o = get(key(r.d)); o[r.p] = (o[r.p] || 0) + r.sp; o.spend += r.sp; });
    rev.forEach(r => { get(key(r.date)).rev += r.net; });
    const ps = [...per.values()].sort((a, b) => a.key < b.key ? -1 : 1);
    mk('ad_c', { data: { labels: ps.map(o => lab(o.key)), datasets: [
        ...AD_PLAT.map(([p, l], i) => ({ type: 'bar', label: l, data: ps.map(o => o[p]), backgroundColor: P_[i], stack: 'sp', yAxisID: 'y', order: 2 })),
        { type: 'line', label: 'Net revenue', data: ps.map(o => o.rev), borderColor: P_[3], backgroundColor: P_[3], yAxisID: 'y1', tension: .25, pointRadius: ps.length > 40 ? 0 : 3, order: 1 }] },
      options: { interaction: { mode: 'index', intersect: false }, scales: { x: { stacked: true, ticks: { maxRotation: 45, autoSkip: true } }, y: { stacked: true, ticks: axisMoney, title: { display: true, text: 'Ad spend (₹)' } }, y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: axisMoney, title: { display: true, text: 'Net revenue (₹)' } } },
        plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${moneyX(c.parsed.y)}` } } } } });
    mk('ad_roas', { type: 'line', data: { labels: ps.map(o => lab(o.key)), datasets: [{ label: 'ROAS', data: ps.map(o => o.spend ? o.rev / o.spend : null), borderColor: P_[0], backgroundColor: P_[0], spanGaps: true, tension: .25, pointRadius: ps.length > 40 ? 0 : 3 }] },
      options: { scales: { y: { ticks: { callback: v => v + 'x' } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => 'ROAS: ' + x(c.parsed.y), afterLabel: c => { const o = ps[c.dataIndex]; return [`Net revenue: ${moneyX(o.rev)}`, `Ad spend: ${moneyX(o.spend)}`]; } } } } } });
    const num = (h, f2, v) => ({ h, f: f2, v, cls: 'num' }), tot = { key: 'Total', google: plat('google'), meta: plat('meta'), criteo: plat('criteo'), spend: spT, rev: revT };
    tbl('t_adp', { name: 'ad_by_period_' + grain, pageSize: 15, sort: 'Period', dir: -1, rows: [...ps].reverse(),
      cols: [{ h: 'Period', f: o => lab(o.key), v: o => o.key, cls: 'lead' }, num('Google Ads', o => moneyE(o.google), o => o.google), num('Meta Ads', o => moneyE(o.meta), o => o.meta), num('Criteo', o => moneyE(o.criteo), o => o.criteo), num('Total spend', o => moneyE(o.spend), o => o.spend), num('Net revenue', o => money(o.rev), o => o.rev), num('ROAS', o => x(div(o.rev, o.spend)), o => div(o.rev, o.spend)), num('Spend % of revenue', o => pct(div(o.spend, o.rev) * 100), o => div(o.spend, o.rev) * 100)],
      foot: (rs, cols) => `<tr class="tot">${cols.map((c, i) => `<td class="${c.cls || ''}">${i === 0 ? 'Total' : esc(c.f(tot))}</td>`).join('')}</tr>` });
    const pl = AD_PLAT.map(([p, l]) => { const rs = spend.filter(r => r.p === p); return { name: l, sp: sum(rs, 'sp'), im: sum(rs, 'im'), cl: sum(rs, 'cl') }; });
    const plT = { name: 'Total', sp: sum(pl, 'sp'), im: sum(pl, 'im'), cl: sum(pl, 'cl') };
    tbl('t_adpl', { name: 'ad_platform', search: false, pageSize: 10, sort: 'Spend', rows: pl,
      cols: [{ h: 'Platform', f: o => o.name, cls: 'lead' }, num('Spend', o => moneyE(o.sp), o => o.sp), num('Share of spend', o => pct(div(o.sp, plT.sp) * 100), o => o.sp), num('Impressions', o => int(o.im), o => o.im), num('Clicks', o => int(o.cl), o => o.cl), num('CTR', o => pct(div(o.cl, o.im) * 100), o => div(o.cl, o.im)), num('Cost per click', o => moneyX(div(o.sp, o.cl)), o => div(o.sp, o.cl)), num('Cost per 1,000 impressions', o => moneyX(div(o.sp, o.im) * 1000), o => div(o.sp, o.im))],
      foot: (rs, cols) => `<tr class="tot">${cols.map((c, i) => `<td class="${c.cls || ''}">${i === 0 ? 'Total' : esc(c.f(plT))}</td>`).join('')}</tr>` });
  }
};

// ================================================================== shell
const TITLES = { p1: ['Executive Overview & Sales', 'KPIs, trend, channel, fulfillment and customer mix'], p3: ['Product Performance', 'Category, SKU, style, concentration, bestseller and trend'], p4: ['Customer Analytics', 'New vs repeat, customer value and buying behaviour'], p5: ['Jewellery Analytics', 'Metal, karat and diamond'], p6: ['Pricing', 'Price bands and price × attribute breakdowns'], p7: ['Geography & Store', 'State, city and company/store'], p8: ['Data Quality & Detail', 'Exceptions, definitions, transaction detail and observations'], p9: ['Compare', 'Period vs period — store, category and karat'], p10: ['Logic', 'How every number on this dashboard is worked out'], p11: ['Sale Dump', 'Every sales line with every column — searchable, sortable, exportable'] , p12: ['Spend vs Revenue', 'Google, Meta and Criteo ad spend against net revenue'] };
function renderPage() {
  Object.keys(CH).forEach(k => { CH[k].destroy(); delete CH[k]; });
  const pg = P[S.page], el = document.getElementById('pageBody');
  document.getElementById('pageTitle').textContent = TITLES[S.page][0]; document.getElementById('pageSub').textContent = TITLES[S.page][1];
  const bits = filterSummary();
  document.getElementById('scope').innerHTML = `<b>${int(S.f.length)}</b> of ${int(S.all.length)} lines · ${int(total(S.f).o)} orders${bits.length ? ' · ' + bits.map(esc).join(' · ') : ''}`;
  if (!S.f.length && S.page !== 'p8' && S.page !== 'p9' && S.page !== 'p10' && S.page !== 'p11' && S.page !== 'p12') { el.innerHTML = '<div class="card"><p class="empty">No sales lines match the current filters.</p></div>'; return; }
  const y = window.scrollY, newPage = renderPage.last !== S.page; renderPage.last = S.page;
  el.innerHTML = pg.html(); pg.draw();
  window.scrollTo({ top: newPage ? 0 : y }); // only jump to the top when switching tabs; filters / chart controls keep your place
}
function onFilterChange() { refilter(); TREND.level = 'month'; TREND.scope = null; renderPage(); }
const LIVE_MS = 60 * 1000;
let loading = false;
function setLive(state, msg) {
  const el = document.getElementById('updated'); if (!el) return;
  el.innerHTML = `<span class="live-dot ${state}"></span>${msg}`;
}
// Fetches the latest data. First call (initial) sets the default view; later calls refresh in place and keep filters / page / scroll.
async function loadData(opts = {}) {
  if (loading) return; loading = true;
  const initial = !S.all.length, y = window.scrollY, btn = document.getElementById('refreshBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
  try {
    const res = await fetch('/api/sales-analytics' + (opts.force ? '?refresh=true' : '')); const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.statusText);
    if (!initial && d.generatedAt === S.generatedAt && !opts.force) { S.checkedAt = new Date(); updateStamp(); return; }
    const prevMax = S.maxDate;
    S.generatedAt = d.generatedAt; S.returns = d.returns || []; PLACEHOLDERS.coll = 0; PLACEHOLDERS.sub2 = 0; S.all = prepare(d.rows);
    const [mn, mx] = dataRange(S.all); S.maxDate = mx;
    if (initial) { const [pf, pt] = presetRange('month', mx); DEFAULT_DATE.from = pf; DEFAULT_DATE.to = pt; S.date = { from: pf, to: pt }; S.preset = 'month'; }
    else if (S.date.to === prevMax || S.date.to < mx && S.preset) { // viewer was on "up to latest" — follow the new latest date
      if (S.preset) { const [pf, pt] = presetRange(S.preset, mx); S.date = { from: pf, to: pt }; } else S.date.to = mx;
    }
    refilter();
    ['dateFrom', 'dateTo'].forEach(id => { const e = document.getElementById(id); e.min = mn; e.max = mx; e.value = S.date[id === 'dateFrom' ? 'from' : 'to']; });
    buildFilterUI(); markPreset(); S.range = [mn, mx]; S.checkedAt = new Date(); updateStamp();
    renderPage(); if (!initial) window.scrollTo({ top: y });
  } catch (e) {
    if (initial) document.getElementById('pageBody').innerHTML = `<div class="card"><p class="warn">Could not load sales data: ${esc(e.message)}</p></div>`;
    else setLive('err', 'Live update failed — retrying · last data ' + new Date(S.generatedAt).toLocaleTimeString('en-IN', { timeStyle: 'short' }));
  } finally { loading = false; if (btn) { btn.disabled = false; btn.textContent = 'Refresh data'; } }
}
function updateStamp() {
  const [mn, mx] = S.range || ['', ''];
  setLive('ok', 'Live · data as of ' + new Date(S.generatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) + ` · ${mn} → ${mx}`);
}
function init() {
  loadData();
  setInterval(() => { if (!document.hidden) loadData(); }, LIVE_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadData(); });
}
document.addEventListener('DOMContentLoaded', () => {
  const setNav = open => { document.body.classList.toggle('nav-open', open); document.getElementById('menuBtn').setAttribute('aria-expanded', open); };
  document.getElementById('menuBtn').onclick = () => setNav(!document.body.classList.contains('nav-open'));
  document.getElementById('scrim').onclick = () => setNav(false);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setNav(false); });
  document.getElementById('nav').addEventListener('click', e => { if (e.target.closest('[data-p]')) setNav(false); });
  const go = id => { id = { p2: 'p1' }[id] || id; if (!P[id]) return; S.page = id; document.querySelectorAll('#nav button').forEach(x => x.classList.toggle('on', x.dataset.p === id)); TREND.level = 'month'; TREND.scope = null; if (S.all.length) renderPage(); };
  document.getElementById('nav').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) { location.hash = b.dataset.p; } });
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  go(location.hash.slice(1));
  document.getElementById('dateFrom').onchange = e => { S.date.from = e.target.value; S.preset = null; markPreset(); onFilterChange(); };
  document.getElementById('dateTo').onchange = e => { S.date.to = e.target.value; S.preset = null; markPreset(); onFilterChange(); };
  document.getElementById('presets').onclick = e => { const b = e.target.closest('button[data-p]'); if (b) applyPreset(b.dataset.p); };
  document.getElementById('resetBtn').onclick = resetFilters;
  document.getElementById('refreshBtn').onclick = () => loadData({ force: true });
  init();
});


// ================================================================== customer profile (opens only on click)
let CUST_IDX = null;
function custIndex() {
  if (CUST_IDX) return CUST_IDX;
  CUST_IDX = new Map();
  S.all.forEach(r => { if (r.party == null) return; const k = String(r.party); if (!CUST_IDX.has(k)) CUST_IDX.set(k, []); CUST_IDX.get(k).push(r); });
  return CUST_IDX;
}
function closeCustomer() { const m = document.getElementById('custModal'); if (m) m.remove(); document.body.classList.remove('modal-open'); }
function openCustomer(id) {
  closeCustomer();
  const rows = (custIndex().get(String(id)) || []).slice().sort((a, b) => (a.date || '') < (b.date || '') ? 1 : -1);
  const rets = (S.returns || []).filter(x => String(x.party) === String(id)).sort((a, b) => a.date < b.date ? 1 : -1);
  if (!rows.length && !rets.length) return;
  const t = total(rows), retPcs = sumBy(rets, x => x.pcs), retNet = sumBy(rets, x => x.net);
  const first = rows.length ? rows[rows.length - 1] : {}, name = (rows.find(r => r.pname) || {}).pname || '—';
  const loc = [(rows.find(r => r.city) || {}).city, (rows.find(r => r.state) || {}).state].filter(Boolean).join(', ') || NP;
  const types = [...new Set(rows.map(r => r.ctype).filter(Boolean))].join(' + ') || '—';
  const byLine = new Map(S.all.map(r => [(r.doc || '') + '|' + (r.line || ''), r]));
  const orders = group(rows, r => r.doc || NP), ordInfo = new Map(rows.map(r => [r.doc || NP, r]));
  const kp = (l, v) => `<div class="kpi"><span class="kpi-l">${l}</span><span class="kpi-v">${v}</span></div>`;
  const m = document.createElement('div'); m.id = 'custModal'; m.className = 'modal';
  m.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">
    <button class="modal-x" aria-label="Close">✕</button>
    <h2>Customer ${esc(id)} · ${esc(name)}</h2>
    <p class="note">${esc(types)} customer · ${esc(loc)} · all activity in the dataset window (not affected by the dashboard filters)</p>
    <div class="kpis">${kp('Orders', int(t.o))}${kp('Pieces bought', int(t.pcs))}${kp('Net sales', money(t.sales))}${kp('Returned pieces', int(retPcs))}${kp('Returned net amount', money(retNet))}${kp('Net after returns', money(t.sales - retNet))}${kp('First purchase', esc(first.date || '—'))}${kp('Last purchase', esc((rows[0] || {}).date || '—'))}</div>
    <h3>Orders</h3><div id="cm_ord"></div>
    <h3>Items purchased</h3><div id="cm_items"></div>
    <h3>Returns</h3><div id="cm_ret"></div></div>`;
  document.body.appendChild(m); document.body.classList.add('modal-open');
  m.addEventListener('click', e => { if (e.target === m || e.target.closest('.modal-x')) closeCustomer(); });
  tbl('cm_ord', { name: 'customer_' + id + '_orders', search: false, pageSize: 8, sort: 'Date', rows: orders, cols: [
    { h: 'Order', f: g => g.key, cls: 'lead' }, { h: 'Date', f: g => g.first || '—', v: g => g.first || '' }, { h: 'Channel', f: g => ordInfo.get(g.key).k_chan }, { h: 'Store', f: g => ordInfo.get(g.key).k_co },
    { h: 'Items', f: g => int(g.lines), v: g => g.lines, cls: 'num' }, C.pcs, C.sales] });
  tbl('cm_items', { name: 'customer_' + id + '_items', colSelect: true, pageSize: 10, sort: 'Date', rows, cols: [
    { h: 'Date', f: r => r.date || '—', cls: 'lead' }, { h: 'Order', f: r => r.doc || '—' }, { h: 'Channel', f: r => r.k_chan }, { h: 'Store', f: r => r.k_co }, { h: 'Product', f: r => r.title || r.styleName || '—' }, { h: 'SKU', f: r => r.k_sku },
    { h: 'Category', f: r => r.k_ig + ' › ' + r.k_type }, { h: 'Metal', f: r => r.k_metal }, { h: 'Karat', f: r => r.k_karat }, { h: 'Price Range', f: r => r.k_price, hidden: true }, { h: 'Fulfillment', f: r => r.k_ful, hidden: true },
    { h: 'Diamond Wt', f: r => r.dWt ? wt(r.dWt) : '—', v: r => r.dWt || 0, cls: 'num', hidden: true }, { h: 'Pieces', f: r => int(r.pcs), v: r => r.pcs, cls: 'num' }, { h: 'Net Sales', f: r => moneyX(r.net), v: r => r.net, cls: 'num strong' }, { h: 'Customer Type', f: r => r.k_ctype, hidden: true }] });
  tbl('cm_ret', { name: 'customer_' + id + '_returns', search: false, pageSize: 6, sort: 'Return date', rows: rets, cols: [
    { h: 'Return document', f: x => x.doc, cls: 'lead' }, { h: 'Return date', f: x => x.date }, { h: 'Original order', f: x => x.origDoc || '—' },
    { h: 'Product', f: x => { const o = byLine.get((x.origDoc || '') + '|' + (x.origLine || '')); return o ? (o.title || o.styleName || '—') : '—'; } },
    { h: 'Item code', f: x => x.sku || '—' }, { h: 'Pieces', f: x => int(x.pcs), v: x => x.pcs, cls: 'num' }, { h: 'Net amount', f: x => moneyX(x.net), v: x => x.net, cls: 'num strong' }] });
  if (!rets.length) document.getElementById('cm_ret').insertAdjacentHTML('afterbegin', '<p class="note">No returns recorded for this customer.</p>');
}
document.addEventListener('click', e => { const a = e.target.closest('a.cid'); if (a) { e.preventDefault(); openCustomer(a.dataset.id); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCustomer(); });
