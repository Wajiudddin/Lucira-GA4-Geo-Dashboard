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
  const tip = i => { const g = gs[i], p = gs[i - 1]; return [`Orders: ${int(g.o)}`, `Customers: ${int(g.c)}`, `Pieces: ${int(g.pcs)}`, `AOV: ${moneyX(g.aov)}`, `Growth vs prev ${lv}: ${p ? gTxt(growth(g.sales, p.sales)) : 'n/a'}`]; };
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
function lineCards(ids) {
  const { gs, P, lv } = drawTrend();
  // AOV trend: one series, always monthly over every month in the data window — independent of the date filter
  // and of the Month/Week/Day drill (other filters still apply).
  const am = group(S.fNoDate.filter(r => r.month), r => r.month).sort((x, y) => x.key < y.key ? -1 : 1);
  mk(ids.aov, { type: 'line', data: { labels: am.map(g => monthLabel(g.key)), datasets: [{ label: 'Average Order Value', data: am.map(g => g.o ? g.aov : null), borderColor: P[3], backgroundColor: P[3], spanGaps: true, tension: .25, pointRadius: 4 }] },
    options: { scales: { y: { ticks: axisMoney } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `AOV: ${moneyX(c.parsed.y)}`, afterLabel: c => { const g = am[c.dataIndex]; return [`Net sales: ${moneyX(g.sales)}`, `Orders: ${int(g.o)}`]; } } } } } });
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
    options: { indexAxis: o.vertical ? 'x' : 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => isM ? moneyX(c.parsed[o.vertical ? 'y' : 'x']) : metric === 'discPct' ? pct(c.parsed[o.vertical ? 'y' : 'x']) : int(c.parsed[o.vertical ? 'y' : 'x']), afterLabel: c => { const g = sel[c.dataIndex]; return [`Sales: ${moneyX(g.sales)} (${pct(g.share)})`, `Orders: ${int(g.o)} · Pieces: ${int(g.pcs)} · Customers: ${int(g.c)}`, `AOV: ${moneyX(g.aov)}`]; } } } },
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
    ['Sales', `${moneyX(t.sales)} net sales from ${int(t.o)} orders (${int(t.pcs)} pieces). AOV ${moneyX(t.aov)}; average selling price ${moneyX(t.asp)}.`],
    ['Customer', `${int(t.c)} unique customers. ${int(t.nc)} New (${pct(t.newPct)}) and ${int(t.rc)} Repeat (${pct(t.repPct)}) by line-level customer_type; repeat customers generated ${pct(div(t.repSales, t.sales) * 100)} of sales.`],
    ['Product', `${ig.slice(0, 3).map(g => `${g.key} ${pct(g.share)}`).join(', ')} of sales by category. Top 10 SKUs = ${pct(div(sumBy(sk.slice(0, 10), g => g.sales), t.sales) * 100)} of sales across ${int(sk.length)} SKUs.`],
    ['Channel', ch.map(g => `${g.key} ${pct(g.share)}`).join(' · ') + ' of net sales.'],
    ['Jewellery', `Metal: ${me.slice(0, 3).map(g => `${g.key} ${pct(g.share)}`).join(', ')}. Karat: ${ka.slice(0, 3).map(g => `${g.key} ${pct(g.share)}`).join(', ')}. ${dT.lines ? `${int(dT.lines)} lines carry diamonds (${wt(dT.dWt)} total; ${moneyX(dT.dAmt)} diamond value).` : ''}`],
    ['Commercial', `Largest price band by sales: ${pr[0].key} (${pct(pr[0].share)}).`],
    ['Data Quality', `${pct(completeness(rows, r => r.city))} of lines have city/state; ${int(rows.filter(r => r.net === 0).length)} lines have zero net sale.`],
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
    grid('g3', chartCard('ov_ch', 'Channel Contribution', 'Share of net sales by channel', 280), chartCard('ov_cat', 'Category Contribution', 'Net sales by item group', 280), chartCard('ov_cust', 'Customer Mix', 'Net sales by customer type', 280)),
    ''),
  draw() {
    const t = total(S.f); document.getElementById('execBox').innerHTML = exec();
    const K = (l, v, d, tone) => kpi(l, v, d, tone);
    document.getElementById('kpiBox').innerHTML = `
      <h4 class="kh">Sales</h4><div class="kpis">${K('Total Net Sales', money(t.sales), 'SUM(net_sale). Exact: ' + moneyE(t.sales), 'hero')}${sorted(group(S.f, r => r.k_ful)).map(g => K(fulLabel(g.key) + ' Sales', money(g.sales), 'SUM(net_sale) where Fullfillment = ' + g.key + ' · ' + pct(g.share) + ' of net sales · ' + int(g.o) + ' orders · ' + int(g.pcs) + ' pieces. Exact: ' + moneyE(g.sales))).join('')}</div>
      <h4 class="kh">Volume</h4><div class="kpis">${K('Orders', int(t.o), 'COUNT DISTINCT document_no')}${K('Pieces', int(t.pcs), 'SUM(pieces)')}${K('Unique Customers', int(t.c), 'COUNT DISTINCT party_id')}</div>
      <h4 class="kh">Customer</h4><div class="kpis">${K('New Customers', int(t.nc), 'Distinct party_id with ≥1 line where customer_type = New')}${K('Repeat Customers', int(t.rc), 'Distinct party_id with ≥1 line where customer_type = Repeat')}${K('New Customer %', pct(t.newPct), 'New Customers ÷ Unique Customers')}${K('Repeat Customer %', pct(t.repPct), 'Repeat Customers ÷ Unique Customers. New% + Repeat% can exceed 100% because a customer can have both New and Repeat lines (' + int([...t._n].filter(x => t._r.has(x)).length) + ' do).')}</div>
      <h4 class="kh">Commercial</h4><div class="kpis">${K('Average Order Value', money(t.aov), 'Net Sales ÷ distinct orders. Exact: ' + moneyE(t.aov))}${K('Avg Selling Price', money(t.asp), 'Net Sales ÷ Pieces (zero-value lines included). Exact: ' + moneyE(t.asp))}</div>`;
    trendChart('tr1', 'tr1c');
    const ch = group(S.f, r => r.k_chan); hbar('ov_ch', sorted(ch), 'sales');
    hbar('ov_cat', sorted(group(S.f, r => r.k_ig)), 'sales', { n: 10 });
    shareDoughnut('ov_cust', group(S.f, r => r.k_ctype));
  }
};

// ---------------------------------------------------------------- P2 Sales & Channel
const P2 = {
  html: () => list(
    grid('g2', chartCard('tr_aov', 'Average Order Value (AOV) Trend', 'Net sales ÷ distinct orders, by month · not affected by the date filter', 280), chartCard('ty_c', 'Type-wise Sales', 'Net sales by product type (Rings, Earrings, Necklaces …) — follows the filters', 280)),
    grid('g2', chartCard('dow', 'Day-of-Week Sales', 'Net sales by weekday (sum over the selected period)', 260), tableCard('t_dow', 'Day-of-Week Detail', '')),
    '<h2 class="sh">Channel Analysis</h2>',
        grid('g1', tableCard('t_ch', 'Channel Comparison', 'Sales %, Order % and Customer % use the total of the filtered data as denominator')),
    grid('g2', chartCard('ch_tr', 'Channel Sales Trend', 'Monthly net sales stacked by channel', 300), tableCard('t_chc', 'Channel × Customer Type', 'New vs repeat customers within each channel')),
    '<h2 class="sh">Store-wise Analysis</h2>',
    grid('g2', chartCard('st_share', 'Store Mix', 'Share of net sales by store (company_code)', 280), chartCard('st_nr', 'New vs Repeat Sales by Store', 'Net sales split by customer type on each line', 280)),
    grid('g1', tableCard('t_st', 'Store Detail', 'Sales, volume, customers and new vs repeat for every store')),
    grid('g1', card('Store × Fulfillment', 'How each store’s sales split across fulfillment types (RTS, MTO, Online MTO …)', '<div id="h_cs"></div>')),
    ''),
  draw() {
    lineCards({ aov: 'tr_aov' }); hbar('ty_c', sorted(group(S.f, r => r.k_type)), 'sales', { n: 12 });
    // monthly growth drivers
    const all = S.all.filter(r => r.date), [mn, mx] = dataRange(all);
    const gs = group(S.f.filter(r => r.month), r => r.month).sort((a, b) => a.key < b.key ? -1 : 1);
    gs.forEach((g, i) => { const p = gs[i - 1]; g.dS = p ? g.sales - p.sales : null; g.gr = p ? growth(g.sales, p.sales) : null; g.partial = (g.key === mn.slice(0, 7) && mn.slice(8) !== '01') || (g.key === mx.slice(0, 7) && addDays(mx, 1).slice(0, 7) === g.key); });
    const dw = group(S.f.filter(r => r.dow != null), r => DOW[r.dow]); const dwo = DOW.map(d => dw.find(g => g.key === d) || finalize(newG(d)));
    hbar('dow', dwo, 'sales', { vertical: true }); dimTable('t_dow', S.f.filter(r => r.dow != null), r => DOW[r.dow], 'Day', { order: DOW, cols: [C.key('Day'), C.sales, C.share, C.orders, C.pcs, C.aov], noFoot: true, search: false });
    const ch = sorted(group(S.f, r => r.k_chan)); const tt = total(S.f);
    
    tbl('t_ch', { name: 'channel', search: false, pageSize: 12, sort: 'Net Sales', cols: [C.key('Channel'), C.sales, C.share, C.orders, { h: 'Order %', f: g => pct(div(g.o, tt.o) * 100), v: g => g.o / (tt.o || 1), cls: 'num' }, C.pcs, C.cust, { h: 'Customer %', f: g => pct(div(g.c, tt.c) * 100), v: g => g.c / (tt.c || 1), cls: 'num' }, C.aov, C.asp, C.discPct, C.newC, C.repC], rows: ch });
    stackedByMonth('ch_tr', S.f, r => r.k_chan, 6);
    dimTable('t_chc', S.f, r => r.k_chan, 'Channel', { cols: [C.key('Channel'), C.newC, C.repC, { h: 'New sales', f: g => moneyX(g.newSales), v: g => g.newSales, cls: 'num' }, { h: 'Repeat sales', f: g => moneyX(g.repSales), v: g => g.repSales, cls: 'num' }, { h: 'Repeat sales %', f: g => pct(div(g.repSales, g.sales) * 100), v: g => div(g.repSales, g.sales), cls: 'num' }], noFoot: true, search: false });
    const fu = group(S.f, r => r.k_co); shareDoughnut('st_share', fu);
    const P_ = PAL(), stS = sorted(fu);
    mk('st_nr', { type: 'bar', data: { labels: stS.map(g => g.key), datasets: [{ label: 'New customers', data: stS.map(g => g.newSales), backgroundColor: P_[0] }, { label: 'Repeat customers', data: stS.map(g => g.repSales), backgroundColor: P_[1] }] }, options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: axisMoney } }, plugins: { tooltip: { mode: 'index', intersect: false, callbacks: { label: c => `${c.dataset.label}: ${moneyX(c.parsed.y)}` } } } } });
    dimTable('t_st', S.f, r => r.k_co, 'Store', { cols: [C.key('Store'), C.sales, C.share, C.orders, C.pcs, C.cust, C.aov, C.newC, C.repC, C.newPct, C.repPct,
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
    grid('g2', chartCard('pd_ig', 'Sales by Category (Item Group)', '', 260), chartCard('pd_type', 'Sales by Product Type (top 12)', '', 260)),
    grid('g1', card('Product Hierarchy Drill-down', 'Item Group → Type → Sub-category 1 → Sub-category 2 → Style → SKU', '<div id="pd_dr"></div>')),
    grid('g1', card('Performance Leaders — kept separate', 'A revenue leader is not automatically a volume leader or a frequency leader.', `<div class="grid g2"><div><h5>Revenue leaders (net sales)</h5><div id="ld_rev"></div></div><div><h5>Unit-volume leaders (pieces)</h5><div id="ld_pcs"></div></div><div><h5>Order-frequency leaders (distinct orders)</h5><div id="ld_ord"></div></div></div>`)),
    grid('g1', tableCard('t_sku', 'SKU Performance Table', 'Search, sort, page, choose columns, export. Diamond weight = SUM(diamond_weight).')),
    '<h2 class="sh">Concentration</h2>',
    grid('g2', chartCard('par', 'Pareto — Top 30 SKUs', 'Bars = net sales per SKU; line = cumulative % of total net sales', 320), card('Concentration Summary', '', '<div id="conc"></div>')),
    '<h2 class="sh">Bestseller flag, Collection & Vendor</h2>',
    grid('g2', tableCard('t_best', 'Bestseller Flag vs Observed Sales', 'Flag as recorded in the data — not a computed ranking'), card('Flag vs Observed Rank', '', '<div id="bestchk"></div>')),
    grid('g2', tableCard('t_coll', 'Collection', ''), tableCard('t_vend', 'Vendor', 'No cost data — vendors are not ranked on profitability')),
    '<h2 class="sh">Product Trend (time-series evidence only)</h2>',
    grid('g1', tableCard('t_ptr', 'Style Activity Trend', 'Needs ≥ 6 sold pieces and ≥ 3 active months to be classified; else “Insufficient data”. Compares pieces in the last 3 months of the period vs the 3 months before it (±25% band = Steady).')),
    insight('ins3')),
  draw() {
    const rows = S.f, t = total(rows);
    hbar('pd_ig', sorted(group(rows, r => r.k_ig)), 'sales', { n: 12 }); hbar('pd_type', sorted(group(rows, r => r.k_type)), 'sales', { n: 12 });
    drill('pd_dr', PROD_LEVELS, rows, { root: 'All categories' });
    const sg = skuGroups(rows).filter(g => g.sales > 0), small = [{ h: 'SKU', f: g => g.key, cls: 'lead' }, { h: 'Product', f: g => g.r.title || g.r.styleName || '—' }, C.sales, C.pcs, C.orders, C.asp];
    tbl('ld_rev', { name: 'ld_rev', cols: small, rows: sorted(sg).slice(0, 10), search: false, pageSize: 10, sort: 'Net Sales' });
    tbl('ld_pcs', { name: 'ld_pcs', cols: small, rows: [...sg].sort((a, b) => b.pcs - a.pcs).slice(0, 10), search: false, pageSize: 10, sort: 'Pieces' });
    tbl('ld_ord', { name: 'ld_ord', cols: small, rows: [...sg].sort((a, b) => b.o - a.o).slice(0, 10), search: false, pageSize: 10, sort: 'Orders' });
    const P_ = PAL();
    tbl('t_sku', { name: 'sku_performance', colSelect: true, pageSize: 15, sort: 'Net Sales', rows: sg, cols: [{ h: 'SKU', f: g => g.key, cls: 'lead' }, { h: 'Product', f: g => g.r.title || '—' }, { h: 'Style', f: g => g.r.k_style, hidden: true }, { h: 'Category', f: g => g.r.k_ig + ' › ' + g.r.k_type }, C.sales, C.orders, C.pcs, C.cust, C.aov, C.asp, C.disc, { h: 'Diamond Wt', f: g => wt(g.dWt), v: g => g.dWt, cls: 'num' }, { h: 'Metal', f: g => g.r.k_metal }, { h: 'Karat', f: g => g.r.k_karat }, { h: 'Vendor', f: g => g.r.k_vendor }] });
    // Pareto
    const s = sorted(sg), top = s.slice(0, 30); let cum = 0; const cumS = top.map(g => (cum += g.sales, div(cum, t.sales) * 100));
    mk('par', { data: { labels: top.map((g, i) => i + 1), datasets: [{ type: 'bar', label: 'Net Sales', data: top.map(g => g.sales), backgroundColor: P_[0], yAxisID: 'y' }, { type: 'line', label: 'Cumulative %', data: cumS, borderColor: P_[1], backgroundColor: P_[1], yAxisID: 'y1', tension: .2 }] }, options: { scales: { x: { title: { display: true, text: 'SKU rank by net sales' } }, y: { ticks: axisMoney }, y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { callback: v => v + '%' } } }, plugins: { tooltip: { callbacks: { title: it => 'Rank ' + it[0].label + ' · ' + top[it[0].dataIndex].key, label: c => c.dataset.label === 'Net Sales' ? moneyX(c.parsed.y) : pct(c.parsed.y) } } } } });
    const stSorted = sorted(group(rows, r => r.k_style)), cs = n => pct(div(sumBy(s.slice(0, n), g => g.sales), t.sales) * 100), ss = n => pct(div(sumBy(stSorted.slice(0, n), g => g.sales), t.sales) * 100);
    const needFor = p => { let c = 0; for (let i = 0; i < s.length; i++) { c += s[i].sales; if (c >= t.sales * p) return i + 1; } return s.length; };
    document.getElementById('conc').innerHTML = `<table class="t"><thead><tr><th>Slice</th><th class="num">Share of net sales</th></tr></thead><tbody>${[['Top 10 SKUs', cs(10)], ['Top 20 SKUs', cs(20)], ['Top 50 SKUs', cs(50)], ['Long tail (all SKUs after rank 50)', pct(100 - parseFloat(cs(50)))], ['Top 10 styles', ss(10)], ['Top 20 styles', ss(20)]].map(([a, b]) => `<tr><td class="lead">${a}</td><td class="num strong">${b}</td></tr>`).join('')}</tbody></table>
      <p class="note">${int(needFor(.5))} SKUs make up 50% of sales and ${int(needFor(.8))} make up 80%, out of ${int(s.length)} SKUs (${int(stSorted.length)} styles).</p>`;
    const bg = dimTable('t_best', rows, r => r.k_best, 'Bestseller flag', { cols: [C.key('Bestseller flag'), C.sales, C.share, C.orders, C.pcs, C.aov, C.asp, C.skus], search: false });
    const tag = new Set(sg.filter(g => g.r.k_best === 'Bestseller-tagged').map(g => g.key)), top50 = new Set(s.slice(0, 50).map(g => g.key));
    const inTop = [...tag].filter(k => top50.has(k)).length, topTag = [...top50].filter(k => tag.has(k)).length;
    document.getElementById('bestchk').innerHTML = `<p>${int(tag.size)} SKUs carry the Bestseller tag; <b>${int(inTop)}</b> of them are in the top 50 SKUs by net sales.</p><p>Of the top 50 SKUs by net sales, <b>${int(topTag)}</b> carry the tag and ${int(50 - topTag > s.length ? s.length - topTag : 50 - topTag)} do not.</p><p class="note">A low overlap means the flag is not derived from these sales; it is shown as recorded and never used to rank products here.</p>`;
    dimTable('t_coll', rows, r => r.k_coll, 'Collection', { cols: [C.key('Collection'), C.sales, C.share, C.orders, C.pcs, C.cust, C.aov] });
    document.getElementById('t_coll').insertAdjacentHTML('afterbegin', `<p class="note">Collection populated on ${pct(completeness(rows, r => r.coll))} of lines; “${NP}” is missing data, not a real collection.</p>`);
    const vg = dimTable('t_vend', rows, r => r.k_vendor, 'Vendor', { cols: [C.key('Vendor'), C.sales, C.share, C.orders, C.pcs, C.skus, C.asp, { h: 'Diamond sales', f: g => moneyX(g.dAmt), v: g => g.dAmt, cls: 'num' }, { h: 'Metal sales', f: g => moneyX(g.mAmt), v: g => g.mAmt, cls: 'num' }, { h: 'Categories', f: g => new Set(rows.filter(r => r.k_vendor === g.key).map(r => r.k_ig)).size, v: g => new Set(rows.filter(r => r.k_vendor === g.key).map(r => r.k_ig)).size, cls: 'num' }] });
    // product trend
    const months = [...new Set(rows.filter(r => r.month).map(r => r.month))].sort(), last3 = months.slice(-3), prev3 = months.slice(-6, -3);
    const st = group(rows.filter(r => r.month && r.style), r => r.style).map(g => {
      const rs = rows.filter(r => r.style === g.key); const byM = new Map(); rs.forEach(r => byM.set(r.month, (byM.get(r.month) || 0) + r.pcs));
      const l = sumBy(last3, m => byM.get(m)), p = sumBy(prev3, m => byM.get(m)), active = byM.size;
      let verdict = 'Insufficient data'; if (g.pcs >= 6 && active >= 3 && prev3.length) { verdict = l > p * 1.25 ? 'Increasing' : l < p * .75 ? 'Declining' : 'Steady'; }
      g.l = l; g.p = p; g.active = active; g.verdict = verdict; g.name = rs[0].styleName || ''; g.series = months.slice(-6).map(m => `${monthLabel(m)}:${byM.get(m) || 0}`).join('  '); return g; });
    tbl('t_ptr', { name: 'product_trend', pageSize: 10, sort: 'Net Sales', rows: st, cols: [{ h: 'Style', f: g => g.key, cls: 'lead' }, { h: 'Name', f: g => g.name }, C.sales, C.pcs, { h: 'Active months', f: g => g.active, v: g => g.active, cls: 'num' }, { h: 'Pieces last 3 mo', f: g => int(g.l), v: g => g.l, cls: 'num' }, { h: 'Pieces prior 3 mo', f: g => int(g.p), v: g => g.p, cls: 'num' }, { h: 'Verdict', f: g => g.verdict }, { h: 'Monthly pieces (last 6)', f: g => g.series, cls: 'small' }] });
    const cnt = v => st.filter(g => g.verdict === v).length;
    const ig = sorted(group(rows, r => r.k_ig)), ty = sorted(group(rows, r => r.k_type));
    setInsight('ins3', [ig[0] ? `${ig[0].key} = ${pct(ig[0].share)} of net sales; top type ${ty[0].key} = ${pct(ty[0].share)}.` : '', `Top 10 SKUs = ${cs(10)} and top 50 = ${cs(50)} of net sales (${int(s.length)} SKUs).`, s[0] ? `Revenue leader: ${s[0].key} (${moneyX(s[0].sales)}). Unit leader: ${[...sg].sort((a, b) => b.pcs - a.pcs)[0].key} (${int(Math.max(...sg.map(g => g.pcs)))} pcs). Most-ordered: ${[...sg].sort((a, b) => b.o - a.o)[0].key} (${int(Math.max(...sg.map(g => g.o)))} orders).` : '', `Style trend (last 3 vs prior 3 months): ${cnt('Increasing')} increasing, ${cnt('Declining')} declining, ${cnt('Steady')} steady, ${cnt('Insufficient data')} with insufficient data.`, `Bestseller-tagged lines carry ${pct(div(total(rows.filter(r => r.k_best === 'Bestseller-tagged')).sales, t.sales) * 100)} of net sales; ${int(inTop)} of ${int(tag.size)} tagged SKUs are in the top 50.`]);
  }
};

// ---------------------------------------------------------------- P4 Customer analytics
const firstLast = (() => { let m = null; return () => { if (m) return m; m = new Map(); S.all.forEach(r => { if (r.party == null || !r.date) return; const x = m.get(r.party) || { f: r.date, l: r.date }; if (r.date < x.f) x.f = r.date; if (r.date > x.l) x.l = r.date; m.set(r.party, x); }); return m; }; })();
P.p4 = {
  html: () => list(
    grid('g2', tableCard('t_nr', 'New vs Repeat', 'By the customer_type recorded on each sales line'), chartCard('nr_tr', 'New vs Repeat Sales by Month', '', 280)),
    grid('g1', chartCard('nr_c', 'Customers per Month — New vs Repeat', '', 260)),
    grid('g1', tableCard('t_cust', 'Customer Table (controlled detail)', 'Customer ID shown by default; the name column is hidden until chosen under “Columns”. Returns = sale-return documents (PSR) for that customer, by return date within the selected date range, on the same basis as net sales; other filters (channel, category, etc.) do not apply to returns. First/last purchase use the full dataset.')),
    '<h2 class="sh">What Do They Buy?</h2>',
    grid('g2', card('Customer Type × Category', '', '<div id="h1"></div>'), card('Customer Type × Price Range', '', '<div id="h2"></div>'), card('Customer Type × Metal', '', '<div id="h3"></div>'), card('Customer Type × Karat', '', '<div id="h4"></div>')),
    grid('g1', card('Customer Type × Channel', '', '<div id="h5"></div>')),
    grid('g1', tableCard('t_rcat', 'Repeat-customer Participation by Category', 'Repeat sales % = sales on Repeat lines ÷ category sales')),
    insight('ins4')),
  draw() {
    const rows = S.f, t = total(rows);
    const ng = group(rows.filter(r => r.ctype), r => r.k_ctype);
    tbl('t_nr', { name: 'new_vs_repeat', search: false, rows: ng, sort: 'Net Sales', cols: [C.key('Customer type'), C.sales, C.share, C.orders, C.cust, C.pcs, C.aov, C.asp] });
    stackedByMonth('nr_tr', rows, r => r.k_ctype, 3);
    const P_ = PAL(), months = [...new Set(rows.filter(r => r.month).map(r => r.month))].sort(), mg = new Map(group(rows.filter(r => r.month), r => r.month).map(g => [g.key, g]));
    mk('nr_c', { type: 'bar', data: { labels: months.map(monthLabel), datasets: [{ label: 'New', data: months.map(m => mg.get(m)?.nc || 0), backgroundColor: P_[5] }, { label: 'Repeat', data: months.map(m => mg.get(m)?.rc || 0), backgroundColor: P_[1] }] }, options: { plugins: { tooltip: { mode: 'index', intersect: false } } } });
    const cg = group(rows.filter(r => r.party != null), r => r.k_cust); const fl = firstLast(); const names = new Map(); rows.forEach(r => { if (r.pname && !names.has(r.k_cust)) names.set(r.k_cust, r.pname); });
    const sales = cg.map(g => g.sales).sort((a, b) => a - b), p90 = sales[Math.floor(sales.length * .9)] || 0;
    const ret = new Map(); (S.returns || []).forEach(x => { if ((S.date.from && x.date < S.date.from) || (S.date.to && x.date > S.date.to)) return; const k = String(x.party); const e = ret.get(k) || { pcs: 0, net: 0 }; e.pcs += x.pcs; e.net += x.net; ret.set(k, e); });
    cg.forEach(g => { const e = ret.get(g.key) || { pcs: 0, net: 0 }; g.retPcs = e.pcs; g.retNet = e.net; });
    cg.forEach(g => { g.type = g.nc && g.rc ? 'New + Repeat' : g.nc ? 'New' : g.rc ? 'Repeat' : '—'; g.seg = g.sales >= p90 && g.sales > 0 ? 'High-value (top 10% by sales)' : g.o >= 3 ? 'Frequent (3+ orders)' : g.o === 1 ? 'One-time' : 'Repeat buyer (2 orders)'; g.fl = fl.get(+g.key) || {}; });
    tbl('t_cust', { name: 'customers', colSelect: true, pageSize: 12, sort: 'Net Sales', rows: cg, cols: [{ h: 'Customer ID', f: g => `<a class="cid" data-id="${esc(g.key)}" title="Open full customer profile">${esc(g.key)}</a>`, v: g => g.key, html: true, cls: 'lead' }, { h: 'Name', f: g => names.get(g.key) || '—', hidden: true }, { h: 'Type', f: g => g.type }, { h: 'Segment', f: g => g.seg }, C.orders, C.pcs, C.sales, C.aov, { h: 'Returned Pieces', f: g => int(g.retPcs), v: g => g.retPcs, cls: 'num' }, { h: 'Returned Net Amount', f: g => g.retNet ? moneyX(g.retNet) : '—', v: g => g.retNet, cls: 'num' }, { h: 'First purchase', f: g => g.fl.f || '—', cls: 'num' }, { h: 'Last purchase', f: g => g.fl.l || '—', cls: 'num' }] });
    const ct = r => r.ctype ? r.k_ctype : null;
    heat('h1', rows, ct, r => r.k_ig, { corner: 'Type ↓ / Category →', maxCols: 7 }); heat('h2', rows, ct, r => r.k_price, { colOrder: PRICE_ORDER, corner: 'Type ↓ / Price →', maxCols: 10 });
    heat('h3', rows, ct, r => r.k_metal, { corner: 'Type ↓ / Metal →' }); heat('h4', rows, ct, r => r.k_karat, { corner: 'Type ↓ / Karat →' }); heat('h5', rows, ct, r => r.k_chan, { corner: 'Type ↓ / Channel →' });
    tbl('t_rcat', { name: 'repeat_by_category', search: false, sort: 'Net Sales', pageSize: 8, rows: sorted(group(rows, r => r.k_ig)), cols: [C.key('Category'), C.sales, C.repC, C.newC, { h: 'Repeat sales %', f: g => pct(div(g.repSales, g.sales) * 100), v: g => div(g.repSales, g.sales), cls: 'num' }, { h: 'Repeat avg ticket', f: g => moneyX(g.repAov), v: g => g.repAov, cls: 'num' }, { h: 'New avg ticket', f: g => moneyX(g.newAov), v: g => g.newAov, cls: 'num' }] });
    const rs = total(rows.filter(r => r.ctype === 'Repeat')), ns = total(rows.filter(r => r.ctype === 'New'));
    const one = cg.filter(g => g.o === 1).length, multi = cg.filter(g => g.o >= 2).length;
    setInsight('ins4', [`Repeat customers generated ${moneyX(t.repSales)} (${pct(div(t.repSales, t.sales) * 100)} of net sales) across ${int(t.ro)} orders; new customers ${moneyX(t.newSales)} (${pct(div(t.newSales, t.sales) * 100)}) across ${int(t.no)} orders.`, `${int(one)} of ${int(cg.length)} customers (${pct(div(one, cg.length) * 100)}) placed exactly one order in this view; ${int(multi)} placed 2+.`, `High-value threshold (top 10% of customers) = ${moneyX(p90)} net sales; ${int(cg.filter(g => g.seg.startsWith('High')).length)} customers meet it.`, `${int([...t._n].filter(x => t._r.has(x)).length)} customers have both New and Repeat lines in the period (their first purchase and later purchases are both in view).`]);
  }
};
const cgMap = arr => { if (!arr._m) arr._m = new Map(arr.map(g => [g.key, g])); return arr._m; };

// ---------------------------------------------------------------- P5 Jewellery
P.p5 = {
  html: () => list(
    grid('g1', card('Jewellery Drill-down', 'Metal → Metal Color → Karat → Product Type → SKU', '<div id="jw_dr"></div>')),
    '<h2 class="sh">Metal</h2>',
    grid('g2', chartCard('mt_c', 'Sales by Metal & Color', '', 260), tableCard('t_mt', 'Metal', '')),
    grid('g2', card('Metal × Channel', '', '<div id="mh1"></div>'), card('Metal × Category', '', '<div id="mh2"></div>'), card('Metal × Price Range', '', '<div id="mh3"></div>'), card('Metal × Customer Type', '', '<div id="mh4"></div>')),
    '<h2 class="sh">Karat</h2>',
    grid('g2', chartCard('ka_c', 'Sales by Karat', '', 260), tableCard('t_ka', 'Karat', 'Includes 995/999/95 purity values as recorded in karat_name')),
    grid('g2', card('Karat × Category', '', '<div id="kh1"></div>'), card('Karat × Channel', '', '<div id="kh2"></div>')),
    grid('g1', card('Karat × Price Range', '', '<div id="kh3"></div>')),
    '<h2 class="sh">Diamond</h2>',
    '<div id="dkpi"></div>',
    grid('g2', chartCard('db_c', 'Sales by Diamond Weight Band', 'Lines with no band are shown separately as “Not populated”', 280), tableCard('t_db', 'Diamond Weight Band', '')),
    grid('g3', tableCard('t_sol', 'Solitaire vs Non-solitaire', ''), tableCard('t_ds', 'Diamond Setting', ''), tableCard('t_dsh', 'Diamond Shape', '')),
    insight('ins5')),
  draw() {
    const rows = S.f, t = total(rows);
    drill('jw_dr', [{ name: 'Metal', key: r => r.k_metal }, { name: 'Metal Color', key: r => r.k_mcolor }, { name: 'Karat', key: r => r.k_karat }, { name: 'Product Type', key: r => r.k_type }, { name: 'SKU', key: r => r.k_sku }], rows, { root: 'All metals' });
    hbar('mt_c', sorted(group(rows, r => r.k_metal + ' · ' + r.k_mcolor)), 'sales', { n: 12 });
    dimTable('t_mt', rows, r => r.k_metal, 'Metal', { search: false });
    heat('mh1', rows, r => r.k_metal, r => r.k_chan, {}); heat('mh2', rows, r => r.k_metal, r => r.k_ig, {}); heat('mh3', rows, r => r.k_metal, r => r.k_price, { colOrder: PRICE_ORDER }); heat('mh4', rows.filter(r => r.ctype), r => r.k_metal, r => r.k_ctype, {});
    hbar('ka_c', sorted(group(rows, r => r.k_karat)), 'sales');
    dimTable('t_ka', rows, r => r.k_karat, 'Karat', { cols: [C.key('Karat'), C.sales, C.share, C.pcs, C.orders, C.cust, C.asp], search: false });
    heat('kh1', rows, r => r.k_karat, r => r.k_ig, {}); heat('kh2', rows, r => r.k_karat, r => r.k_chan, {}); heat('kh3', rows, r => r.k_karat, r => r.k_price, { colOrder: PRICE_ORDER });
    const dr = rows.filter(r => r.dWt > 0), dT = total(dr);
    document.getElementById('dkpi').innerHTML = `<div class="kpis">${kpi('Lines with diamonds', int(dT.lines), pct(div(dT.lines, t.lines) * 100) + ' of lines have diamond_weight > 0')}${kpi('Total diamond weight', wt(dT.dWt), 'SUM(diamond_weight)')}${kpi('Diamond pieces', int(dT.dPcs), 'SUM(diamond_pieces) — individual stones')}${kpi('Avg weight / diamond piece', dT.dPcs ? (dT.dWt / dT.dPcs).toFixed(3) + ' ct' : '—', 'Diamond weight ÷ diamond pieces')}${kpi('Avg diamond weight / jewellery piece', dT.pcs ? wt(dT.dWt / dT.pcs) : '—', 'Diamond weight ÷ jewellery pieces sold (lines with diamonds)')}${kpi('Diamond value', money(dT.dAmt), 'SUM(diamond_amount). Exact: ' + moneyE(dT.dAmt) + ' = ' + pct(div(dT.dAmt, t.sales) * 100) + ' of net sales')}</div>`;
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
    grid('g3', chartCard('co_s', 'Store Sales Comparison', '', 280), chartCard('co_a', 'Store AOV', 'Net sales ÷ distinct orders', 280), chartCard('co_o', 'Store Order Volume', 'Distinct orders', 280)),
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

// ================================================================== shell
const TITLES = { p1: ['Executive Overview & Sales', 'KPIs, trend, channel, fulfillment and customer mix'], p3: ['Product Performance', 'Category, SKU, style, concentration, bestseller and trend'], p4: ['Customer Analytics', 'New vs repeat, customer value and buying behaviour'], p5: ['Jewellery Analytics', 'Metal, karat and diamond'], p6: ['Pricing', 'Price bands and price × attribute breakdowns'], p7: ['Geography & Store', 'State, city and company/store'], p8: ['Data Quality & Detail', 'Exceptions, definitions, transaction detail and observations'] };
function renderPage() {
  Object.keys(CH).forEach(k => { CH[k].destroy(); delete CH[k]; });
  const pg = P[S.page], el = document.getElementById('pageBody');
  document.getElementById('pageTitle').textContent = TITLES[S.page][0]; document.getElementById('pageSub').textContent = TITLES[S.page][1];
  const bits = filterSummary();
  document.getElementById('scope').innerHTML = `<b>${int(S.f.length)}</b> of ${int(S.all.length)} lines · ${int(total(S.f).o)} orders${bits.length ? ' · ' + bits.map(esc).join(' · ') : ''}`;
  if (!S.f.length && S.page !== 'p8') { el.innerHTML = '<div class="card"><p class="empty">No sales lines match the current filters.</p></div>'; return; }
  el.innerHTML = pg.html(); pg.draw(); window.scrollTo({ top: 0 });
}
function onFilterChange() { refilter(); TREND.level = 'month'; TREND.scope = null; renderPage(); }
async function init() {
  try {
    const res = await fetch('/api/sales-analytics' + (location.search.includes('refresh') ? '?refresh=true' : '')); const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.statusText);
    S.generatedAt = d.generatedAt; S.returns = d.returns || []; S.all = prepare(d.rows); refilter();
    const [mn, mx] = dataRange(S.all); ['dateFrom', 'dateTo'].forEach(id => { const e = document.getElementById(id); e.min = mn; e.max = mx; e.value = DEFAULT_DATE[id === 'dateFrom' ? 'from' : 'to']; });
    buildFilterUI();
    document.getElementById('updated').textContent = 'Data as of ' + new Date(d.generatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) + ` · ${mn} → ${mx}`;
    renderPage();
  } catch (e) { document.getElementById('pageBody').innerHTML = `<div class="card"><p class="warn">Could not load sales data: ${esc(e.message)}</p></div>`; }
}
document.addEventListener('DOMContentLoaded', () => {
  const go = id => { id = { p2: 'p1' }[id] || id; if (!P[id]) return; S.page = id; document.querySelectorAll('#nav button').forEach(x => x.classList.toggle('on', x.dataset.p === id)); TREND.level = 'month'; TREND.scope = null; if (S.all.length) renderPage(); };
  document.getElementById('nav').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) { location.hash = b.dataset.p; } });
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  go(location.hash.slice(1));
  document.getElementById('dateFrom').onchange = e => { S.date.from = e.target.value; onFilterChange(); };
  document.getElementById('dateTo').onchange = e => { S.date.to = e.target.value; onFilterChange(); };
  document.getElementById('noZero').onchange = e => { S.noZero = e.target.checked; onFilterChange(); };
  document.getElementById('hmMetric').onchange = e => { S.hm = e.target.value; renderPage(); };
  document.getElementById('resetBtn').onclick = resetFilters;
  document.getElementById('refreshBtn').onclick = () => { location.search = '?refresh=true'; };
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
