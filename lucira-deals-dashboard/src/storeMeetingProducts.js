// Product view of the scheduled meetings: which products (from the Zoho deal) each meeting is about, their attributes
// (category, karat, SKU, variant, price band, size, style, shape) and whether they are in stock at the meeting's own store.
//
// Sources (BigQuery):
//   zoho_crm.deal_products                 - the products added on each deal (product code and/or product name)
//   ds_imputed_reporting.Live_inventory    - live stock, one row per piece, with its location (store)
//   ds_imputed_reporting.marketing_sale    - sold products: attributes, product title and price range for products that are not in stock
// A product is matched FIRST by its SKU code, THEN by its style (the design code inside the SKU), THEN by its exact product title.
// A product that cannot be matched stays visible as "Not matched" so nothing is hidden.

const STOCK_QUERY = `
  SELECT Full_sku, half_code, type_name, karat_name, item_size_name, Diamond_1_shape, Gemstone_1_Shape, Shopify_price,
         metal_color_name, Store_name, location_name, IFNULL(pieces, 1) AS pieces
  FROM \`lucirajewelry-prod.ds_imputed_reporting.Live_inventory\`
  WHERE Full_sku IS NOT NULL AND TRIM(Full_sku) != ''`;
const SALES_QUERY = `
  SELECT Full_sku, ANY_VALUE(half_sku) AS half_sku, ANY_VALUE(type_name) AS type_name, ANY_VALUE(karat_name) AS karat_name,
         ANY_VALUE(Diamond_1_shape) AS d_shape, ANY_VALUE(Gemstone_1_Shape) AS g_shape, ANY_VALUE(Product_Title) AS title,
         ANY_VALUE(Price_Range) AS price_range, ANY_VALUE(metal_color_name) AS metal_color
  FROM \`lucirajewelry-prod.ds_imputed_reporting.marketing_sale\`
  WHERE Full_sku IS NOT NULL AND TRIM(Full_sku) != ''
  GROUP BY Full_sku`;
// Many deal_products rows carry only the Zoho product id, so the name / code / price come from the Zoho products copy.
const DEAL_PRODUCTS_QUERY = `
  SELECT dp.deal_id, COALESCE(NULLIF(dp.product_code, ''), NULLIF(pr.product_code, '')) AS product_code,
         COALESCE(NULLIF(dp.product_name, ''), NULLIF(pr.product_name, '')) AS product_name,
         SAFE_CAST(NULLIF(pr.unit_amount, '') AS FLOAT64) AS unit_amount, COALESCE(NULLIF(pr.products_category, ''), NULLIF(pr.product_category, '')) AS product_category
  FROM \`lucirajewelry-prod.zoho_crm.deal_products\` dp
  LEFT JOIN (SELECT * FROM \`lucirajewelry-prod.zoho_crm.zoho_products_src\` QUALIFY ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY loaded_at DESC) = 1) pr
    ON REPLACE(CAST(pr.record_id AS STRING), 'zcrm_', '') = CAST(dp.product_id AS STRING)`;

const up = s => String(s || '').trim().toUpperCase();
const isLJ = code => /^LJ-/.test(code);
// style = the design code inside a SKU: LJ-R00155-14YGLGD-12 -> R00155 ; non-LJ codes are their own style
const styleOf = code => { const c = up(code); if (!c) return ''; return isLJ(c) ? (c.split('-')[1] || c) : c; };
const variantOf = code => { const c = up(code); return isLJ(c) ? (c.split('-')[2] || '') : ''; };          // 14YGLGD
const sizeOf = code => { const c = up(code); if (!isLJ(c)) return ''; const t = c.split('-')[3]; return t && /^[0-9.]+$/.test(t) ? t : ''; };
const normTitle = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Stock locations that cannot be sold from: they never count as "available".
const NOT_SELLABLE = /^(market place|repair|vendor return|certificate pending|melting stock|campaign|lost intransit)$/i;
function stockStoreKey(storeName, location) {
  const sn = String(storeName || ''), loc = String(location || '');
  if (NOT_SELLABLE.test(loc.trim())) return null;
  if (/\(pune\)/i.test(sn) || /pune jm road/i.test(loc) || /pune coco/i.test(sn)) return 'pune';
  if (/\(lajpat\)/i.test(sn) || /^lajpat nagar$/i.test(loc.trim())) return 'lajpatNagar';
  if (/\(borivali\)/i.test(sn) || /skycity borivali/i.test(loc)) return 'borivali';
  if (/\(paschim\)/i.test(sn)) return 'paschimVihar';
  if (/\(noida\)/i.test(sn) || /wave noida/i.test(loc)) return 'noida';
  if (/malleshwaram/i.test(loc)) return 'malleshwaram';
  if (/chembur/i.test(loc)) return 'chembur';
  return 'headOffice';                       // company stock held centrally (Finish Goods)
}

// Price band from a price, in the same style as the marketing_sale Price_Range ("20K - 30K").
function bandOfPrice(p) {
  const n = Number(p);
  if (!n || Number.isNaN(n)) return null;
  const edges = [10000, 20000, 30000, 40000, 50000, 75000, 100000];
  const k = v => `${v / 1000}K`;
  if (n < edges[0]) return `0 - ${k(edges[0])}`;
  for (let i = 0; i < edges.length - 1; i++) if (n < edges[i + 1]) return `${k(edges[i])} - ${k(edges[i + 1])}`;
  return `${k(edges[edges.length - 1])}+`;
}

async function loadProductData(bigquery) {
  const [[stockRows], [salesRows], [dpRows]] = await Promise.all([
    bigquery.query({ query: STOCK_QUERY }), bigquery.query({ query: SALES_QUERY }), bigquery.query({ query: DEAL_PRODUCTS_QUERY }),
  ]);
  const bySku = new Map(), byStyle = new Map(), byTitle = new Map();      // attribute catalogs
  const stockSkuStore = new Map(), stockStyleStore = new Map();           // `${key}|${store}` -> pieces
  const stockSkuAll = new Map(), stockStyleAll = new Map();
  const bump = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
  const shapeOf = (a, b) => [a, b].map(x => String(x || '').trim()).find(x => x && x.toUpperCase() !== 'NA') || null;

  const setAttrs = (sku, a) => {
    const cur = bySku.get(sku) || {};
    const merged = { ...cur };
    Object.keys(a).forEach(k => { if (a[k] != null && a[k] !== '' && (merged[k] == null || merged[k] === '')) merged[k] = a[k]; });
    bySku.set(sku, merged);
    const st = styleOf(sku);
    if (st) { const sc = byStyle.get(st) || {}; const sm = { ...sc }; Object.keys(a).forEach(k => { if (['sku', 'size', 'variant'].includes(k)) return; if (a[k] != null && a[k] !== '' && (sm[k] == null || sm[k] === '')) sm[k] = a[k]; }); sm.style = st; byStyle.set(st, sm); }
  };
  for (const r of stockRows) {
    const sku = up(r.Full_sku);
    const key = stockStoreKey(r.Store_name, r.location_name);
    const pcs = Number(r.pieces) || 1;
    if (key) { bump(stockSkuStore, `${sku}|${key}`, pcs); bump(stockStyleStore, `${styleOf(sku)}|${key}`, pcs); bump(stockSkuAll, sku, pcs); bump(stockStyleAll, styleOf(sku), pcs); }
    setAttrs(sku, {
      category: r.type_name || null, karat: r.karat_name || null, size: (r.item_size_name || '').trim() || null,
      shape: shapeOf(r.Diamond_1_shape, r.Gemstone_1_Shape), priceBand: bandOfPrice(r.Shopify_price), price: Number(r.Shopify_price) || null,
      metalColor: r.metal_color_name || null,
    });
  }
  for (const r of salesRows) {
    const sku = up(r.Full_sku);
    setAttrs(sku, {
      category: r.type_name || null, karat: r.karat_name || null, shape: shapeOf(r.d_shape, r.g_shape),
      priceBand: (r.price_range || '').trim() || null, metalColor: r.metal_color || null, title: r.title || null,
    });
    if (r.title) {
      const t = normTitle(r.title);
      if (t && !byTitle.has(t)) byTitle.set(t, styleOf(sku));
      const st = styleOf(sku);
      if (st && byStyle.has(st) && !byStyle.get(st).title) byStyle.get(st).title = r.title;
    }
  }
  const dealProducts = new Map();
  for (const r of dpRows) {
    const code = up(r.product_code), name = String(r.product_name || '').trim();
    if (!code && !name) continue;
    if (!dealProducts.has(r.deal_id)) dealProducts.set(r.deal_id, []);
    const list = dealProducts.get(r.deal_id);
    if (!list.some(p => p.code === code && p.name === name)) list.push({ code, name, price: Number(r.unit_amount) || null, category: r.product_category || null });
  }
  return { bySku, byStyle, byTitle, stockSkuStore, stockStyleStore, stockSkuAll, stockStyleAll, dealProducts, loadedAt: Date.now() };
}

// One product of one meeting -> its attributes and stock status at the meeting's store.
function resolveProduct(P, product, storeKey) {
  const code = product.code, name = product.name;
  let sku = code || null, style = styleOf(code) || null, matchedBy = null, attrs = null;
  if (code && P.bySku.has(code)) { attrs = P.bySku.get(code); matchedBy = 'SKU'; }
  else if (style && P.byStyle.has(style)) { attrs = P.byStyle.get(style); matchedBy = 'Style'; }
  else if (name && P.byTitle.has(normTitle(name))) { style = P.byTitle.get(normTitle(name)); attrs = P.byStyle.get(style) || null; matchedBy = 'Product name'; sku = null; }
  const line = {
    productName: name || (attrs && attrs.title) || code || '',
    sku: sku || '', style: style || '', matchedBy: matchedBy || 'Not matched',
    category: (attrs && attrs.category) || product.category || null, karat: attrs && attrs.karat || null,
    shape: attrs && attrs.shape || null, priceBand: (attrs && attrs.priceBand) || bandOfPrice(product.price) || null,
    price: (attrs && attrs.price) || product.price || null,
    variant: code ? variantOf(code) || null : null, size: code ? sizeOf(code) || (attrs && attrs.size) || null : (attrs && attrs.size) || null,
  };
  if (!matchedBy) { line.stockAtStore = null; line.stockElsewhere = null; line.status = 'Unknown'; return line; }
  // stock: by the exact SKU when the product has one, otherwise by its style (any variant)
  const useSku = matchedBy === 'SKU';
  const keyOf = useSku ? code : style;
  const here = (useSku ? P.stockSkuStore : P.stockStyleStore).get(`${keyOf}|${storeKey}`) || 0;
  const all = (useSku ? P.stockSkuAll : P.stockStyleAll).get(keyOf) || 0;
  line.stockAtStore = here; line.stockElsewhere = Math.max(0, all - here);
  line.status = here > 0 ? 'In stock' : all > here ? 'Other stores only' : 'Out of stock';
  line.stockBasis = useSku ? 'SKU' : 'Style (any variant)';
  return line;
}

const GROUPS = [
  { key: 'category', label: 'Category', field: 'category' },
  { key: 'karat', label: 'Karat', field: 'karat' },
  { key: 'sku', label: 'SKU', field: 'sku' },
  { key: 'variant', label: 'Variant', field: 'variant' },
  { key: 'priceBand', label: 'Price band', field: 'priceBand' },
  { key: 'size', label: 'Size', field: 'size' },
  { key: 'style', label: 'Style', field: 'style' },
  { key: 'shape', label: 'Shape', field: 'shape' },
];

// meetings: [{ id, customer, mobile, dealId, store, storeKey, agent, fromMs }]
function productTables(P, meetings, dealById) {
  if (!P) return null;
  const lines = [];
  let withProducts = 0;
  meetings.forEach(m => {
    let prods = (m.dealId && P.dealProducts.get(m.dealId)) || [];
    let source = 'Deal product';
    if (!prods.length) {                     // the deal has no product of its own: use the product the customer last viewed
      const d = m.dealId && dealById ? dealById.get(m.dealId) : null;
      if (d && d.latestProduct) { prods = [d.latestProduct]; source = 'Last viewed product'; }
    }
    if (prods.length) withProducts += 1;
    prods.forEach(p => {
      const l = resolveProduct(P, p, m.storeKey);
      lines.push({ ...l, productSource: source, meetingId: m.id, customer: m.customer, mobile: m.mobile || null, store: m.store, storeKey: m.storeKey, agent: m.agent, fromMs: m.fromMs });
    });
  });
  const tables = {};
  GROUPS.forEach(g => {
    const by = new Map();
    lines.forEach(l => {
      const label = (l[g.field] == null || l[g.field] === '') ? 'Unknown / not matched' : String(l[g.field]);
      if (!by.has(label)) by.set(label, { label, meetings: new Set(), products: 0, inStock: 0, otherOnly: 0, out: 0, unknown: 0, pieces: new Map() });
      const r = by.get(label);
      r.meetings.add(l.meetingId); r.products += 1;
      if (l.status === 'In stock') { r.inStock += 1; const k = `${l.sku || l.style}|${l.storeKey}`; r.pieces.set(k, l.stockAtStore); }
      else if (l.status === 'Other stores only') r.otherOnly += 1;
      else if (l.status === 'Out of stock') r.out += 1;
      else r.unknown += 1;
    });
    tables[g.key] = [...by.values()].map(r => {
      const known = r.inStock + r.otherOnly + r.out;
      return {
        label: r.label, meetings: r.meetings.size, products: r.products, inStock: r.inStock, otherOnly: r.otherOnly, out: r.out, unknown: r.unknown,
        pieces: [...r.pieces.values()].reduce((s, n) => s + n, 0),
        availability: known ? Math.round((r.inStock / known) * 1000) / 10 : null,
        status: !known ? 'Unknown' : r.inStock === known ? 'In stock' : r.inStock > 0 ? 'Partly in stock' : r.otherOnly > 0 ? 'Other stores only' : 'Out of stock',
      };
    }).sort((a, b) => b.products - a.products || a.label.localeCompare(b.label));
  });
  const summary = {
    meetings: meetings.length, meetingsWithProducts: withProducts, productLines: lines.length,
    inStock: lines.filter(l => l.status === 'In stock').length, otherOnly: lines.filter(l => l.status === 'Other stores only').length,
    out: lines.filter(l => l.status === 'Out of stock').length, unknown: lines.filter(l => l.status === 'Unknown').length,
  };
  return { summary, tables, lines };
}

module.exports = { loadProductData, productTables, resolveProduct, stockStoreKey, bandOfPrice, styleOf, variantOf, sizeOf, normTitle };
