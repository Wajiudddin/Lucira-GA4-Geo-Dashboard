// One-time setup script: exchanges a Google OAuth consent for a refresh token
// that lets the dashboard pull Google Business Profile data (Performance API +
// Reviews) the same way src/zohoClient.js already pulls Zoho data.
//
// Usage:
//   1. In .env, set GBP_CLIENT_ID and GBP_CLIENT_SECRET (from a Google Cloud
//      OAuth 2.0 "Web application" client, with authorized redirect URI:
//      http://localhost:3001/oauth/callback).
//   2. Run: node scripts/gbp-auth.js
//   3. Open the printed URL in a browser, sign in with the Google account
//      that manages the store listings in Business Profile Manager, and
//      approve access.
//   4. The script captures the redirect, exchanges the code for tokens, and
//      appends GBP_REFRESH_TOKEN to .env automatically. It then lists every
//      location the account can manage so we can map each to a store.
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const ENV_PATH = path.join(__dirname, '..', '.env');

const CLIENT_ID = process.env.GBP_CLIENT_ID;
const CLIENT_SECRET = process.env.GBP_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GBP_CLIENT_ID / GBP_CLIENT_SECRET in .env — add them first, then re-run this script.');
  process.exit(1);
}

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
})}`;

console.log('\nOpen this URL in a browser and sign in with the account that manages the store listings:\n');
console.log(authUrl);
console.log(`\nWaiting for the OAuth redirect on ${REDIRECT_URI} ...\n`);

async function exchangeCodeForTokens(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!data.refresh_token) {
    throw new Error(`Token exchange failed (no refresh_token returned): ${JSON.stringify(data)}`);
  }
  return data;
}

function appendRefreshTokenToEnv(refreshToken) {
  let env = fs.readFileSync(ENV_PATH, 'utf8');
  if (/^GBP_REFRESH_TOKEN=/m.test(env)) {
    env = env.replace(/^GBP_REFRESH_TOKEN=.*$/m, `GBP_REFRESH_TOKEN=${refreshToken}`);
  } else {
    env += (env.endsWith('\n') ? '' : '\n') + `GBP_REFRESH_TOKEN=${refreshToken}\n`;
  }
  fs.writeFileSync(ENV_PATH, env);
}

async function listAccountsAndLocations(accessToken) {
  const acctRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const acctData = await acctRes.json();
  const accounts = acctData.accounts || [];
  console.log(`\nFound ${accounts.length} manageable account(s):`);

  const allLocations = [];
  for (const acct of accounts) {
    console.log(`  - ${acct.name} (${acct.accountName || acct.type})`);
    let pageToken;
    do {
      const params = new URLSearchParams({
        pageSize: '100',
        readMask: 'name,title,storefrontAddress,phoneNumbers',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const locRes = await fetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?${params}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const locData = await locRes.json();
      for (const loc of locData.locations || []) {
        allLocations.push(loc);
        const addr = loc.storefrontAddress ? (loc.storefrontAddress.addressLines || []).join(', ') : '';
        console.log(`      ${loc.name}  |  ${loc.title}  |  ${addr}`);
      }
      pageToken = locData.nextPageToken;
    } while (pageToken);
  }

  fs.writeFileSync(
    path.join(__dirname, 'gbp-locations.json'),
    JSON.stringify(allLocations, null, 2)
  );
  console.log(`\nSaved ${allLocations.length} location(s) to scripts/gbp-locations.json for store mapping.`);
}

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth/callback')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Google returned an error: ${error}`);
    console.error(`Google returned an error: ${error}`);
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Success — you can close this tab. Check the terminal for next steps.');

  try {
    const tokens = await exchangeCodeForTokens(code);
    appendRefreshTokenToEnv(tokens.refresh_token);
    console.log('\nGBP_REFRESH_TOKEN saved to .env.');
    await listAccountsAndLocations(tokens.access_token);
  } catch (err) {
    console.error('\nSetup failed:', err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);
