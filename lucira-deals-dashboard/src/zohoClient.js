require('dotenv').config();

const accessTokenCache = { token: null, expiresAt: 0 };

function apiBase() {
  const domain = process.env.ZOHO_DOMAIN || 'zoho.com';
  const tld = domain.replace(/^zoho\./, '');
  return `https://www.zohoapis.${tld}`;
}

async function getAccessToken() {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt - 60000) {
    return accessTokenCache.token;
  }
  const domain = process.env.ZOHO_DOMAIN || 'zoho.com';
  const url = `https://accounts.${domain}/oauth/v2/token`;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  });

  const res = await fetch(url, { method: 'POST', body: params });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`);
  }
  accessTokenCache.token = data.access_token;
  accessTokenCache.expiresAt = Date.now() + data.expires_in * 1000;
  return accessTokenCache.token;
}

// fetch with retries for transient Zoho failures (5xx / 429 / network), with backoff.
async function fetchWithRetry(url, options, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
      if (res.status !== 429 && res.status < 500) return res;
      lastErr = new Error(`Zoho responded ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 1000 * 2 ** i));
  }
  throw lastErr;
}

// Fetches a module's records sorted by sortField desc, stopping pagination as
// soon as a page's oldest record falls before stopBeforeISO (records created
// before the range we care about) — avoids pulling full history every time.
async function fetchRecordsSince(module, fields, { sortField = 'Created_Time', stopBeforeISO = null, maxPages = 1000 } = {}) {
  const records = [];
  let page = 1;
  const perPage = 200;
  const stopBefore = stopBeforeISO ? new Date(stopBeforeISO).getTime() : null;

  while (page <= maxPages) {
    const token = await getAccessToken();
    const url = `${apiBase()}/crm/v2/${module}?fields=${encodeURIComponent(fields.join(','))}&page=${page}&per_page=${perPage}&sort_by=${sortField}&sort_order=desc`;
    const res = await fetchWithRetry(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });

    if (res.status === 204) break;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zoho ${module} fetch failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    const pageRecords = Array.isArray(data.data) ? data.data : [];
    records.push(...pageRecords);

    if (stopBefore !== null && pageRecords.length) {
      const oldestInPage = new Date(pageRecords[pageRecords.length - 1][sortField]).getTime();
      if (oldestInPage < stopBefore) break;
    }

    const more = data.info && data.info.more_records;
    if (!more) break;
    page += 1;
  }

  if (stopBefore !== null) {
    return records.filter(r => new Date(r[sortField]).getTime() >= stopBefore);
  }
  return records;
}

// Fetches specific records by id — for resolving a batch of records (e.g.
// Contacts referenced by a call's Who_Id) without pulling a whole module's
// history. Zoho caps the `ids` param at 100 per call, so this batches automatically.
async function fetchRecordsByIds(module, fields, ids) {
  const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
  if (!uniqueIds.length) return [];

  const records = [];
  const batchSize = 100;
  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);
    const token = await getAccessToken();
    const url = `${apiBase()}/crm/v2/${module}?fields=${encodeURIComponent(fields.join(','))}&ids=${batch.join(',')}`;
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });

    if (res.status === 204) continue;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zoho ${module} fetch-by-ids failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    if (Array.isArray(data.data)) records.push(...data.data);
  }
  return records;
}

module.exports = { getAccessToken, fetchRecordsSince, fetchRecordsByIds };
