// Business rules for the Store Meeting & Conversion Analytics dashboard.
// Everything a manager might want to change lives here, not in the service.

const RULES = {
  timezone: 'Asia/Kolkata',
  // Calendar week used for "Scheduled This Week": Monday 00:00 -> Sunday 23:59:59.999 IST.
  weekStartsOn: 'monday',

  // How a "Show" (customer visited the store) is decided.
  //   'crm_first'   : Zoho Events.Show_Status when set; otherwise walk-in match.
  //   'walkin_only' : ignore Show_Status, use store_customer.walkin_data only.
  //   'crm_only'    : only Show_Status; everything else is "unverifiable".
  showSource: 'crm_only',
  // Same idea for a "Conversion" (order generated).
  //   'crm_first'   : Events.Conversion_Status when set; otherwise a store sale
  //                   (marketing_sale, Channel='Store') by the same mobile on/after the visit day.
  conversionSource: 'crm_only',

  // Deals are pulled live from Zoho (the BigQuery export lags ~30 days).
  dealsSource: 'zoho_live',

  // Calls come from BigQuery lucira_zoho_Calls; that table only holds calls up to its last sync, so
  // newer calls are topped up from live Zoho Calls. Set false to use the BigQuery table alone.
  callsLiveTopUp: true,
  // Only outbound calls are follow-ups.
  followUpCallTypes: ['Outbound'],

  // Rates. Numerator / denominator are named so the formulas are visible in tooltips.
  showRate: { numerator: 'showMeetings', denominator: 'meetingsRaised' },
  conversionRate: { numerator: 'convertedCustomers', denominator: 'showCustomers' },

  // Ambiguous localities. true => counted inside the market, false => Non-City.
  ambiguous: {
    naviMumbaiAsMumbai: false,   // Navi Mumbai is a separate city from Mumbai/Thane
    gautamBuddhaNagarAsNoida: true, // district that contains Noida + Greater Noida
    bangaloreRuralAsBangalore: true, // "all Bangalore locations"
  },
};

const MARKETS = ['Bangalore', 'Mumbai', 'Delhi', 'Noida', 'Pune'];

// Which store owns a deal. Delhi is split by zone (business table), Noida/Pune/
// Bangalore have a single store. Mumbai has two stores (Borivali, Chembur): their
// deals are split 50/50 by the service, so storeKey is null here.
// Delhi areas not in the table (New Delhi, North East, South East, plain "Delhi")
// also stay unassigned rather than guessed.
const DELHI_ZONE_TO_STORE = {
  'central delhi': 'lajpatNagar',
  'south delhi': 'lajpatNagar',
  'south west delhi': 'lajpatNagar',
  'north delhi': 'paschimVihar',
  'north west delhi': 'paschimVihar',
  'west delhi': 'paschimVihar',
  'east delhi': 'noida',
};
const MARKET_SINGLE_STORE = { Noida: 'noida', Pune: 'pune', Bangalore: 'malleshwaram' };
// Stores whose deals are assigned directly (everything except the shared Mumbai pair).
// Mumbai deals are split 50/50 between the two Mumbai stores (see splitMumbaiDeals in the service).
const MUMBAI_SPLIT_STORES = ['borivali', 'chembur'];
const DIRECT_DEAL_STORES = ['lajpatNagar', 'paschimVihar', 'noida', 'pune', 'malleshwaram', ...MUMBAI_SPLIT_STORES];

function storeForDeal(market, city) {
  if (market === 'Delhi') return DELHI_ZONE_TO_STORE[String(city || '').trim().toLowerCase().replace(/[\s-]+/g, ' ')] || null;
  return MARKET_SINGLE_STORE[market] || null;
}

// Returns { market, category, reason, storeKey }.
// category: 'store_city' | 'non_city' | 'unknown'. Blank/placeholder city is
// 'unknown' (never silently Non-City).
function classifyCity(cityRaw, stateRaw) {
  const res = classifyCityBase(cityRaw, stateRaw);
  return { ...res, storeKey: res.market ? storeForDeal(res.market, cityRaw) : null };
}

function classifyCityBase(cityRaw, stateRaw) {
  const city = String(cityRaw == null ? '' : cityRaw).trim().toLowerCase().replace(/\s+/g, ' ');
  const state = String(stateRaw == null ? '' : stateRaw).trim().toLowerCase();
  if (!city || city === 'unknown city' || city === 'unknown' || city === 'na' || city === 'n/a' || city === '-') {
    return { market: null, category: 'unknown', reason: 'city blank/placeholder' };
  }
  const is = (market, reason) => ({ market, category: 'store_city', reason });

  if (/\bnavi mumbai\b/.test(city)) {
    return RULES.ambiguous.naviMumbaiAsMumbai ? is('Mumbai', 'navi mumbai (ambiguous)') : { market: null, category: 'non_city', reason: 'navi mumbai (ambiguous, excluded)' };
  }
  if (/\b(mumbai|bombay|thane)\b/.test(city) || /^mumbai (suburban|city)$/.test(city)) return is('Mumbai', 'mumbai/thane');
  if (/\b(bengaluru|bangalore|bengalooru)\b/.test(city)) {
    if (/rural/.test(city) && !RULES.ambiguous.bangaloreRuralAsBangalore) return { market: null, category: 'non_city', reason: 'bangalore rural (excluded)' };
    return is('Bangalore', /rural/.test(city) ? 'bangalore rural (ambiguous)' : 'bangalore');
  }
  if (/\bdelhi\b/.test(city) || /\bncr\b/.test(city) && state === 'delhi') return is('Delhi', 'delhi area');
  if (/\b(greater noida|noida)\b/.test(city)) return is('Noida', 'noida/greater noida');
  if (city === 'gautam buddha nagar' || city === 'gautam budh nagar') {
    return RULES.ambiguous.gautamBuddhaNagarAsNoida ? is('Noida', 'gautam buddha nagar district (ambiguous)') : { market: null, category: 'non_city', reason: 'gautam buddha nagar (excluded)' };
  }
  if (/\bpune\b/.test(city)) return is('Pune', 'pune');
  return { market: null, category: 'non_city', reason: 'other city' };
}

// Zoho Events.Store_Name picklist -> store key used across the app.
const STORE_NAME_TO_KEY = {
  'Borivali Store': 'borivali',
  'Chembur Store': 'chembur',
  'Lajpat Nagar Store': 'lajpatNagar',
  'Malleshwaram Store': 'malleshwaram',
  'Noida Store': 'noida',
  'Paschim Vihar Store': 'paschimVihar',
  'Pune Store': 'pune',
  'Head Office': 'headOffice',
};

module.exports = { RULES, MARKETS, classifyCity, STORE_NAME_TO_KEY, DIRECT_DEAL_STORES, DELHI_ZONE_TO_STORE, MUMBAI_SPLIT_STORES };
