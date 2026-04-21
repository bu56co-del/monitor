const { scrapeTarget, launchBrowser } = require('./scraper');
const { upsertHistory, logError } = require('./storage');

function todayHKT() {
  const now = new Date();
  const hkMs = now.getTime() + (8 * 60 - now.getTimezoneOffset()) * 60 * 1000;
  return new Date(hkMs).toISOString().slice(0, 10);
}

function nowIsoUtc() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(minMs, maxMs) { return Math.floor(minMs + Math.random() * (maxMs - minMs)); }

// Module-level lock prevents two overlapping cron ticks from both launching
// browsers and double-writing the same date.
let cronLock = false;

async function runBatch(targets, reason) {
  if (cronLock) {
    console.log(`[batch] skip (${reason}) — previous run still active`);
    return { skipped: true, reason: 'locked' };
  }
  cronLock = true;
  console.log(`[batch] ${reason}: ${targets.length} target(s)`);
  const date = todayHKT();
  const results = [];
  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    await logError({ stage: 'browser_launch', error: err.message });
    cronLock = false;
    throw err;
  }

  try {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const startedAt = Date.now();
      try {
        const { count, tookMs } = await scrapeTarget(target.id, { browser });
        await upsertHistory(target.id, { date, count, fetched_at_utc: nowIsoUtc() });
        results.push({ id: target.id, name: target.name, count, tookMs, ok: true });
        console.log(`  [${target.name}] count=${count} (${tookMs}ms)`);
      } catch (err) {
        const msg = err.message || String(err);
        console.error(`  [${target.name}] FAILED:`, msg);
        await logError({
          page_id: target.id,
          name: target.name,
          stage: 'scrape',
          error: msg,
          took_ms: Date.now() - startedAt,
        });
        results.push({ id: target.id, name: target.name, ok: false, error: msg });
      }
      if (i < targets.length - 1) await sleep(jitter(3000, 8000));
    }
  } finally {
    try { await browser.close(); } catch {}
    cronLock = false;
  }
  return {
    date,
    scraped: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

module.exports = { runBatch, todayHKT, nowIsoUtc };
