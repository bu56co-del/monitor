const TARGETS = require('./_targets');
const { getKv, isKvConfigured, upsertHistory, logError } = require('./_kv');
const { launchBrowser, scrapeTarget } = require('./_scraper');

// Vercel Hobby plan only permits once-per-day cron. We run at 17:00 UTC
// (HKT 01:00 — local middle of the night) and scrape every target in one
// sequential pass, with short random delays between each to avoid looking
// like a synchronous burst.

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

function fetchedAtUtc() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(minMs, maxMs) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isKvConfigured()) {
    return res.status(500).json({
      stage: 'config',
      error: 'KV not configured',
      detail: 'Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.',
    });
  }

  const batch = TARGETS;
  if (batch.length === 0) {
    return res.status(200).json({ skipped: true, reason: 'No targets configured' });
  }

  const kv = getKv();
  const date = utcToday();
  const results = [];

  // Share one browser across the batch to amortise cold-start cost.
  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    await logError(kv, {
      stage: 'browser_launch',
      error: err.message,
    }).catch(() => {});
    return res.status(500).json({ stage: 'browser_launch', error: err.message });
  }

  try {
    for (let i = 0; i < batch.length; i++) {
      const target = batch[i];
      const startedAt = Date.now();
      try {
        const { count, tookMs } = await scrapeTarget(target.id, { browser });
        await upsertHistory(kv, target.id, {
          date,
          count,
          fetched_at_utc: fetchedAtUtc(),
        });
        results.push({ id: target.id, name: target.name, count, tookMs, ok: true });
        console.log(`[${target.name}] count=${count} (${tookMs}ms)`);
      } catch (err) {
        const msg = err.message || String(err);
        console.error(`[${target.name}] FAILED:`, msg);
        await logError(kv, {
          page_id: target.id,
          name: target.name,
          stage: 'scrape',
          error: msg,
          took_ms: Date.now() - startedAt,
        }).catch(() => {});
        results.push({ id: target.id, name: target.name, ok: false, error: msg });
      }

      // Randomised delay between targets to avoid looking like a burst.
      // Kept tight (2-6s) because we must finish all targets within the
      // 300s serverless maxDuration.
      if (i < batch.length - 1) await sleep(jitter(2000, 6000));
    }
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  return res.status(failed > 0 ? 207 : 200).json({
    date,
    scraped: results.length,
    ok,
    failed,
    results,
  });
};
