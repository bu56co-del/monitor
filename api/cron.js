import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const PAGE_ID = '110379081699089';
const COUNTRY = 'HK';
const GRAPH_VERSION = 'v21.0';
const MAX_PAGES = 50;
const PAGE_SIZE = 500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redact(str, token) {
  return token ? str.replace(token, '***REDACTED***') : str;
}

async function fetchPage(url, token) {
  const delays = [0, 2000, 4000, 8000];
  let lastErr;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      lastErr = e;
      console.error('Network error:', e.message);
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status}`);
      console.error(`HTTP ${res.status}, will retry`);
      continue;
    }
    const body = await res.json().catch(() => ({}));
    throw new Error(redact(`HTTP ${res.status}: ${JSON.stringify(body)}`, token));
  }
  throw new Error(`All retries exhausted: ${lastErr?.message}`);
}

async function fetchCount(token) {
  const params = new URLSearchParams({
    search_page_ids: PAGE_ID,
    ad_active_status: 'ACTIVE',
    ad_reached_countries: JSON.stringify([COUNTRY]),
    ad_type: 'ALL',
    fields: 'id',
    limit: String(PAGE_SIZE),
    access_token: token,
  });

  let url = `https://graph.facebook.com/${GRAPH_VERSION}/ads_archive?${params}`;
  let total = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchPage(url, token);
    const batch = data.data ?? [];
    total += batch.length;
    const next = data.paging?.next;
    if (!next || batch.length === 0) return total;
    url = next;
  }
  throw new Error(`Reached MAX_PAGES (${MAX_PAGES}) ceiling without exhausting results`);
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  // Allow Vercel cron (POST) and manual browser trigger (GET).
  const cronSecret = process.env.CRON_SECRET;
  if (
    cronSecret &&
    req.method === 'POST' &&
    req.headers.authorization !== `Bearer ${cronSecret}`
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = process.env.FB_ACCESS_TOKEN?.trim();
  if (!token) {
    return res.status(500).json({ error: 'FB_ACCESS_TOKEN environment variable is not set' });
  }

  try {
    const count = await fetchCount(token);
    const date = utcToday();
    const fetched_at_utc = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

    const history = (await kv.get('history')) ?? [];
    const updated = history
      .filter((r) => r.date !== date)
      .concat({ date, count, fetched_at_utc })
      .sort((a, b) => a.date.localeCompare(b.date));

    await kv.set('history', updated);

    console.log(`Stored count=${count} for ${date} (${updated.length} total rows)`);
    return res.status(200).json({ date, count, total_rows: updated.length });
  } catch (err) {
    const msg = redact(err.message, process.env.FB_ACCESS_TOKEN);
    console.error('Cron failed:', msg);
    return res.status(500).json({ error: msg });
  }
}
