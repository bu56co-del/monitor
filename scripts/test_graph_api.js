// Test: can we read the FB Ad Library via Graph API with our token?
//
// Usage:
//   FB_ACCESS_TOKEN=EAA... node scripts/test_graph_api.js               # HKMPM
//   FB_ACCESS_TOKEN=EAA... node scripts/test_graph_api.js 89863844963   # NYMG
//
// Prints pagination progress, final count, and elapsed time.
// Redacts the token from any error messages.

const GRAPH_VERSION = 'v21.0';
const DEFAULT_PAGE_ID = '110379081699089';
const COUNTRY = 'HK';
const PAGE_SIZE = 500;
const MAX_PAGES = 50;

const token = (process.env.FB_ACCESS_TOKEN || '').trim();
if (!token) {
  console.error('ERROR: set FB_ACCESS_TOKEN env var');
  console.error('  FB_ACCESS_TOKEN=EAA... node scripts/test_graph_api.js [page_id]');
  process.exit(2);
}

const pageId = process.argv[2] || DEFAULT_PAGE_ID;

function redact(s) {
  return String(s).split(token).join('***REDACTED***');
}

function buildInitialUrl() {
  const params = new URLSearchParams({
    search_page_ids: pageId,
    ad_active_status: 'ACTIVE',
    ad_reached_countries: `["${COUNTRY}"]`,
    ad_type: 'ALL',
    fields: 'id',
    limit: String(PAGE_SIZE),
    access_token: token,
  });
  return `https://graph.facebook.com/${GRAPH_VERSION}/ads_archive?${params.toString()}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  if (!res.ok) {
    const detail = JSON.stringify(body).slice(0, 500);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return body;
}

(async () => {
  console.log(`Testing Graph API for page_id=${pageId} (${COUNTRY}, ACTIVE, ALL)…`);
  const startedAt = Date.now();
  let url = buildInitialUrl();
  let total = 0;
  let page = 0;

  while (url && page < MAX_PAGES) {
    page += 1;
    const data = await fetchJson(url);
    const batch = Array.isArray(data.data) ? data.data : [];
    total += batch.length;
    const next = data.paging && data.paging.next;
    process.stdout.write(`  page ${page}: +${batch.length} (total: ${total})${next ? '' : ' [done]'}\n`);
    if (!next || batch.length === 0) break;
    url = next;
  }

  const tookMs = Date.now() - startedAt;
  console.log('');
  console.log('✅ SUCCESS');
  console.log(`   Count:          ${total}`);
  console.log(`   Pages fetched:  ${page}`);
  console.log(`   Elapsed:        ${tookMs}ms`);
})().catch((err) => {
  console.error('');
  console.error('❌ FAILED');
  console.error('  ' + redact(err.message));
  if (/OAuthException|access_token|token/i.test(err.message)) {
    console.error('');
    console.error('Common causes:');
    console.error('  - Token expired (short-lived: 1-2h, long-lived: 60d)');
    console.error('  - Token missing ads_read / ad_library permission');
    console.error('  - Meta Developer account not ID-verified for Ad Library');
  }
  process.exit(1);
});
