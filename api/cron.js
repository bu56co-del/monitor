const TARGETS = require('./_targets');
const { getKv, isKvConfigured, upsertHistory, logError } = require('./_kv');
const { launchBrowser, scrapeTarget } = require('./_scraper');

// Cron runs hourly from 17:00 to 23:00 UTC (HKT 01:00-07:00, a 7-hour window).
// Each run scrapes the subset of targets whose index % 7 equals this hour's
// offset from 17. With N targets, each target is scraped exactly once per day.
const FIRST_HOUR = 17;
const WINDOW_HOURS = 7;

function hourOffset(now = new Date()) {
  const h = now.getUTCHours();
  const offset = h - FIRST_HOUR;
  if (offset < 0 || offset >= WINDOW_HOURS) return null;
  return offset;
}

function pickTargets(targets, offset) {
  return targets.filter((_, i) => i % WINDOW_HOURS === offset);
}

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

  // Allow manual GET/POST with `?force=1` to scrape the whole list even
  // outside the cron window — handy for first-time seeding.
  const force = req.query?.force === '1' || req.url?.includes('force=1');
  const offset = hourOffset();
  let batch;
  if (force) {
    batch = TARGETS;
  } else if (offset === null) {
    return res.status(200).json({
      skipped: true,
      reason: `Outside cron window (UTC ${FIRST_HOUR}:00-${FIRST_HOUR + WINDOW_HOURS - 1}:59)`,
    });
  } else {
    batch = pickTargets(TARGETS, offset);
  }

  if (batch.length === 0) {
    return res.status(200).json({ skipped: true, reason: 'No targets for this hour' });
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
      if (i < batch.length - 1) await sleep(jitter(5000, 15000));
    }
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  return res.status(failed > 0 ? 207 : 200).json({
    date,
    offset,
    window: `UTC ${FIRST_HOUR}:00-${FIRST_HOUR + WINDOW_HOURS - 1}:59`,
    scraped: results.length,
    ok,
    failed,
    results,
  });
};
