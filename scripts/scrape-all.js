// Standalone cron entrypoint used by Render Cron Jobs. Scrapes every target
// in lib/targets.js once and exits. Never starts the Express server.
//
// Usage (local):
//   node scripts/scrape-all.js
//
// Render invokes this via `node scripts/scrape-all.js` on its cron schedule.

const TARGETS = require('../lib/targets');
const { runBatch } = require('../lib/batch');

(async () => {
  const reason = process.env.RENDER ? 'render-cron' : 'local-manual';
  try {
    const out = await runBatch(TARGETS, reason);
    console.log('');
    console.log(JSON.stringify({
      date: out.date,
      scraped: out.scraped,
      ok: out.ok,
      failed: out.failed,
    }, null, 2));
    // Non-zero exit if EVERY target failed (so Render marks the run as failed).
    if (out.scraped > 0 && out.ok === 0) process.exit(1);
  } catch (err) {
    console.error('[scrape-all] FATAL:', err.message);
    process.exit(1);
  }
})();
