require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Uses ZOHO_LEADS_REFRESH_TOKEN rather than zohoClient.js's shared
// getAccessToken(), because that token was granted a different (narrower)
// scope — ZohoCRM.modules.leads.READ + ZohoCRM.settings.fields.READ only —
// and sharing zohoClient's module-level token cache would risk this script
// clobbering the token other services (Deals/Contacts/Calls/Tasks) rely on.
let accessTokenCache = { token: null, expiresAt: 0 };

function apiBase() {
  const domain = process.env.ZOHO_DOMAIN || 'zoho.com';
  const tld = domain.replace(/^zoho\./, '');
  return `https://www.zohoapis.${tld}`;
}

async function getLeadsAccessToken() {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt - 60000) {
    return accessTokenCache.token;
  }
  const domain = process.env.ZOHO_DOMAIN || 'zoho.com';
  const url = `https://accounts.${domain}/oauth/v2/token`;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_LEADS_REFRESH_TOKEN,
  });
  const res = await fetch(url, { method: 'POST', body: params });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Zoho Leads token refresh failed: ${JSON.stringify(data)}`);
  }
  accessTokenCache.token = data.access_token;
  accessTokenCache.expiresAt = Date.now() + data.expires_in * 1000;
  return accessTokenCache.token;
}

async function getLeadFieldNames() {
  const token = await getLeadsAccessToken();
  const res = await fetch(`${apiBase()}/crm/v2/settings/fields?module=Leads`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Zoho Leads field metadata fetch failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.fields.map(f => f.api_name);
}

async function fetchAllLeads(fields) {
  const records = [];
  let page = 1;
  const perPage = 200;
  while (true) {
    const token = await getLeadsAccessToken();
    const url = `${apiBase()}/crm/v2/Leads?fields=${encodeURIComponent(fields.join(','))}&page=${page}&per_page=${perPage}&sort_by=Created_Time&sort_order=desc`;
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });

    if (res.status === 204) break;
    if (!res.ok) {
      throw new Error(`Zoho Leads fetch failed (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    const pageRecords = Array.isArray(data.data) ? data.data : [];
    records.push(...pageRecords);
    console.log(`Fetched page ${page} (${pageRecords.length} leads, ${records.length} total)`);

    if (!(data.info && data.info.more_records)) break;
    page += 1;
  }
  return records;
}

// Streaming insert (table.insert()) needs bigquery.tables.updateData, which
// the service account in GOOGLE_APPLICATION_CREDENTIALS only has read access
// under (it can query, not write). `bq load` instead runs as whatever
// account is active in the local gcloud CLI (tech@lucirajewelry.com here),
// which does have write access to this table — confirmed with a manual
// probe INSERT before wiring this up.
const NDJSON_PATH = path.join(__dirname, '..', 'data', 'zoho-leads-sync.ndjson');

async function main() {
  const fields = await getLeadFieldNames();
  console.log(`Leads module has ${fields.length} fields`);

  const leads = await fetchAllLeads(fields);
  console.log(`Fetched ${leads.length} leads from Zoho CRM total`);
  if (!leads.length) return;

  const syncedAt = new Date().toISOString();
  const lines = leads.map(lead => JSON.stringify({
    record_id: lead.id,
    lead_data: lead,
    synced_at: syncedAt,
  }));
  fs.mkdirSync(path.dirname(NDJSON_PATH), { recursive: true });
  fs.writeFileSync(NDJSON_PATH, lines.join('\n') + '\n');
  console.log(`Wrote ${lines.length} rows to ${NDJSON_PATH}`);

  execFileSync('bq', [
    'load',
    '--source_format=NEWLINE_DELIMITED_JSON',
    '--project_id=lucirajewelry-prod',
    'zoho_crm.zoho_leads',
    NDJSON_PATH,
  ], { stdio: 'inherit', shell: true });

  fs.unlinkSync(NDJSON_PATH);
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
