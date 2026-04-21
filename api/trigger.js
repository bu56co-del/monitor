const TARGETS = require('./_targets');
const { getKv, isKvConfigured, upsertHistory, logError } = require('./_kv');
const { scrapeTarget } = require('./_scraper');

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

function fetchedAtUtc() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

// Manual on-demand scrape of a single target, invoked from the dashboard
// "Fetch now" button. POST /api/trigger?id=<page_id>
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isKvConfigured()) {
    return res.status(500).json({
      stage: 'config',
      error: 'KV not configured',
    });
  }

  const id = (req.query?.id || '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing ?id=<page_id>' });

  const target = TARGETS.find((t) => t.id === id);
  if (!target) {
    return res.status(404).json({ error: `Unknown target id: ${id}` });
  }

  const kv = getKv();
  const startedAt = Date.now();
  try {
    const { count, tookMs, url } = await scrapeTarget(target.id);
    await upsertHistory(kv, target.id, {
      date: utcToday(),
      count,
      fetched_at_utc: fetchedAtUtc(),
    });
    return res.status(200).json({
      id: target.id,
      name: target.name,
      count,
      url,
      tookMs,
      date: utcToday(),
    });
  } catch (err) {
    const msg = err.message || String(err);
    await logError(kv, {
      page_id: target.id,
      name: target.name,
      stage: 'manual_trigger',
      error: msg,
      took_ms: Date.now() - startedAt,
    }).catch(() => {});
    return res.status(500).json({
      stage: 'scrape',
      id: target.id,
      name: target.name,
      error: msg,
      tookMs: Date.now() - startedAt,
    });
  }
};
