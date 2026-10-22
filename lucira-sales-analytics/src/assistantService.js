require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5';
const MAX_ROWS_IN_CONTEXT = 400; // whole current refill list comfortably fits

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to your .env file to enable the AI assistant.');
  }
  if (!client) client = new Anthropic();
  return client;
}

function buildSystemPrompt(dashboardData) {
  const rows = dashboardData.rows.slice(0, MAX_ROWS_IN_CONTEXT).map(r => ({
    store: r.store, sku: r.sku, style: r.style, size: r.size, metal: r.metal,
    lastSold: r.lastSold, ageingDays: r.ageingDays, salesCycle: r.salesCycle,
    hoOnHand: r.hoOnHand, poStatus: r.poStatus, poNo: r.poNo,
    availableAtNetwork: r.availableAtNetwork, availableAtPeerStores: r.availableAtPeerStores,
    lifetimeSales: r.lifetimeSales, transferStatus: r.transferStatus,
    pdpViews: r.pdpViews, atc: r.atc, atcRatio: r.atcRatio,
  }));

  const kpis = {
    totalRefillSkus: dashboardData.rows.length,
    hoAvailable: dashboardData.rows.filter(r => r.hoOnHand > 0).length,
    hoNotAvailable: dashboardData.rows.filter(r => r.hoOnHand === 0).length,
    validPo: dashboardData.rows.filter(r => r.poStatus === 'VALID').length,
    noValidPo: dashboardData.rows.filter(r => r.poStatus === 'NO VALID PO').length,
    oldPeerStock180: dashboardData.rows.filter(r => r.peerHasRedFlag).length,
    transferCandidates: dashboardData.rows.filter(r => r.transferStatus === 'TRANSFER CANDIDATE').length,
    totalPdpViews: dashboardData.rows.reduce((s, r) => s + (r.pdpViews || 0), 0),
  };

  return `You are the AI assistant embedded in Lucira Jewelry's "Jewelry Refill Management" dashboard. You answer questions from store operations staff about the current refill list — which exact SKUs need restocking at which stores, why, and what to do about it.

REFILL LOGIC (how this list was built — refer to this when explaining "why" a row is here):
1. A SKU is only listed if it sold at that exact store at least once, ever (full sales history, no date cutoff) AND currently has 0 stock there.
2. Exact match is SKU + Size + Metal/Variant (the "sku" field already encodes all of this).
3. Store sales are based on Billing Company (company_code), not Location.
3b. Gold Coin, Silver Coin (type_name), and Silver jewelry (item_group_name or metal_name) are excluded from every sales figure in this list — most 925-silver+diamond pieces are miscategorized under item_group_name "Diamond Jewellery", so metal_name is the reliable signal.
3c. Customize-order styles are excluded entirely, regardless of type_name: half_sku prefixes COR (Ring), COE (Earring), COP/COPD (Pendant), COB (Bracelet/Bangle), COC (Chain/Mangalsutra Chain), CNP (Nose Pin), CTN (Tanmaniya), CNK (Necklace) — these are made-to-order, not real stock.
4. Reorder quantity is always 1.
5. Ageing = Last Sold Date − Transfer Date (the transfer that brought that stock into the selling store). Sales Cycle is "Below 180" (<=180 days) or "Above 180" (>180 days); unknown when no qualifying transfer record exists.
6. PO validity is SKU-level only (no store link exists in the source data) — valid only when PO Raised Date > Last Sold Date.
7. "Available At Network" = other locations (incl. HO) holding >=2 units. Single-unit locations are excluded.
8. "Available At Peer Stores" excludes HO, HWI Ventures, and the selling store itself, format "Name-Qty(AgeingDays)" e.g. "Borivali-1(254)" (city/area name, not the store code); ageing >180 days is a red flag (shown as store-qty-ageing triplets in the data below, with a redFlag note). Matched at style level (any size/metal variant of the same style), not exact SKU.
9. Lifetime Sales (Store+Style, all sizes/metals combined, all-time) is only meaningful when a peer has a red-flagged (>180 day) stock; null otherwise. 1-2 = low-but-real demand (shown green in the UI). 0 = no history. >2 = demand exists, investigate why stock isn't moving.
10. Transfer Candidate requires a red-flagged peer with >=2 units AND lifetime sales of 1-2 for that peer's style.
11. Store code HWI (company_code FCS on the backend) is a normal store in this list like any other; CS1 is the only remaining known data gap (sells but has no stock records in the source inventory table, so it's excluded from this list rather than assumed to be zero-stock).

CURRENT SNAPSHOT (as of ${dashboardData.generatedAt}):
KPIs: ${JSON.stringify(kpis)}

FULL REFILL LIST (${rows.length} of ${dashboardData.rows.length} rows${dashboardData.rows.length > MAX_ROWS_IN_CONTEXT ? ', truncated' : ''}), one row per exact SKU/store combination currently needing refill:
${JSON.stringify(rows)}

Answer concisely and reference specific stores/SKUs/numbers from the data above rather than speaking in generalities. If asked something the data above can't answer (e.g. it requires information outside these 3 tables), say so plainly rather than guessing.`;
}

async function chat({ message, history, dashboardData }) {
  const anthropic = getClient();
  const messages = [
    ...(history || []).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystemPrompt(dashboardData),
    messages,
  });

  if (response.stop_reason === 'refusal') {
    return { reply: "I can't help with that request.", refused: true };
  }

  const textBlock = response.content.find(b => b.type === 'text');
  return { reply: textBlock ? textBlock.text : '' };
}

module.exports = { chat };
