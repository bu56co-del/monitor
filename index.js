const express = require('express');
const path = require('path');
const os = require('os');
const cron = require('node-cron');

const TARGETS = require('./lib/targets');
const { scrapeTarget, scrapeCreatives, screenshotUrl } = require('./lib/scraper');
const {
  getHistory, upsertHistory, getErrors, logError,
  getCreatives, saveCreatives, saveWeeklySnapshot,
} = require('./lib/storage');
const { runBatch, todayHKT, nowIsoUtc } = require('./lib/batch');

// ISO week label like "2026-W18" — used to bucket weekly creative snapshots.
function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

const PORT = Number(process.env.PORT) || 3000;
const TZ = 'Asia/Hong_Kong';

// Cron: HKT 09:30-17:30, every hour at :30. Targets are spread across 9 slots
// (hours 9..17 inclusive), each target scraped once per day. Run
// `node index.js` and keep the process alive (pm2, launchd, or a terminal tab).
const FIRST_HOUR = 9;
const WINDOW_HOURS = 9; // 9,10,11,12,13,14,15,16,17 → 9 slots at xx:30

const WINDOWS = [
  { label: '1D',  days: 1  },
  { label: '7D',  days: 7  },
  { label: '14D', days: 14 },
  { label: '30D', days: 30 },
  { label: '60D', days: 60 },
];

function pickTargetsForHour(hkHour) {
  const offset = hkHour - FIRST_HOUR;
  if (offset < 0 || offset >= WINDOW_HOURS) return [];
  return TARGETS.filter((_, i) => i % WINDOW_HOURS === offset);
}

function subtractDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function findRowOnOrBefore(rows, targetDate) {
  let candidate = null;
  for (const row of rows) {
    if (row.date <= targetDate) candidate = row;
    else break;
  }
  return candidate;
}

function computeDiffs(history) {
  if (!history || history.length === 0) {
    return {
      current: null,
      diffs: WINDOWS.map(({ label, days }) => ({
        label, days, baseline_date: null, baseline_count: null, diff: null, pct: null,
      })),
      total_snapshots: 0,
    };
  }
  const latest = history[history.length - 1];
  const prev = history.slice(0, -1);
  const diffs = WINDOWS.map(({ label, days }) => {
    const targetDate = subtractDays(latest.date, days);
    const baseline = findRowOnOrBefore(prev, targetDate);
    if (!baseline) return { label, days, baseline_date: null, baseline_count: null, diff: null, pct: null };
    const diff = latest.count - baseline.count;
    const pct = baseline.count === 0 ? null : Math.round((diff / baseline.count) * 1000) / 10;
    return { label, days, baseline_date: baseline.date, baseline_count: baseline.count, diff, pct };
  });
  return { current: latest, diffs, total_snapshots: history.length };
}

// --- Express server ----------------------------------------------------

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    const rows = await Promise.all(
      TARGETS.map(async (t) => {
        const history = await getHistory(t.id);
        const diffSet = computeDiffs(history);
        return { id: t.id, name: t.name, ...diffSet };
      }),
    );
    const errors = await getErrors();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      targets: rows,
      errors: errors.slice(0, 50),
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read history', detail: err.message });
  }
});

app.post('/api/trigger', async (req, res) => {
  const id = (req.query.id || '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing ?id=<page_id>' });
  const target = TARGETS.find((t) => t.id === id);
  if (!target) return res.status(404).json({ error: `Unknown target id: ${id}` });

  const startedAt = Date.now();
  try {
    const { count, tookMs, url } = await scrapeTarget(target.id);
    await upsertHistory(target.id, { date: todayHKT(), count, fetched_at_utc: nowIsoUtc() });
    res.json({ id: target.id, name: target.name, count, url, tookMs, date: todayHKT() });
  } catch (err) {
    const msg = err.message || String(err);
    await logError({
      page_id: target.id,
      name: target.name,
      stage: 'manual_trigger',
      error: msg,
      took_ms: Date.now() - startedAt,
    });
    res.status(500).json({
      stage: 'scrape',
      id: target.id,
      name: target.name,
      error: msg,
      tookMs: Date.now() - startedAt,
    });
  }
});

// One-shot admin endpoint to copy production Redis keys into a namespaced
// copy. Refuses on production (where STORAGE_NAMESPACE is unset) — only the
// staging environment may pull data into its own namespace.
app.post('/api/admin/migrate', async (req, res) => {
  if (!process.env.STORAGE_NAMESPACE) {
    return res.status(403).json({ error: 'Refusing to run on production (STORAGE_NAMESPACE is empty).' });
  }
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return res.status(500).json({ error: 'ADMIN_TOKEN env var not configured.' });
  }
  const provided = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== adminToken) {
    return res.status(403).json({ error: 'Bad or missing token.' });
  }

  const { Redis } = require('@upstash/redis');
  const { migrateNamespace } = require('./lib/migrate');

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'Upstash credentials not configured.' });
  }

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  try {
    const summary = await migrateNamespace(redis, {
      sourceNs: req.query.source || '',
      targetNs: process.env.STORAGE_NAMESPACE,
      force: req.query.force === '1',
    });
    res.json({ ok: true, target_namespace: process.env.STORAGE_NAMESPACE, ...summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scrape per-ad detail (body, image, CTA, landing URL, started date) for one
// target and merge into the persistent creatives store. Captures ad_ids in a
// weekly snapshot so we can diff new vs removed ads later. Same shape as
// /api/trigger but heavier — designed to be called from the weekly workflow.
app.post('/api/scrape-creatives', async (req, res) => {
  const id = (req.query.id || '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing ?id=<page_id>' });
  const target = TARGETS.find((t) => t.id === id);
  if (!target) return res.status(404).json({ error: `Unknown target id: ${id}` });

  const max = Math.min(parseInt(req.query.max, 10) || 50, 100);
  const startedAt = Date.now();
  try {
    const { ads, url, tookMs } = await scrapeCreatives(target.id, { max });

    const existing = await getCreatives(target.id);
    const nowIso = nowIsoUtc();
    const merged = { ...existing };
    let newCount = 0;
    for (const ad of ads) {
      if (!ad || !ad.id) continue;
      if (merged[ad.id]) {
        merged[ad.id] = { ...merged[ad.id], ...ad, last_seen_iso: nowIso };
      } else {
        merged[ad.id] = { ...ad, first_seen_iso: nowIso, last_seen_iso: nowIso };
        newCount += 1;
      }
    }
    await saveCreatives(target.id, merged);
    await saveWeeklySnapshot(target.id, isoWeek(), ads.map((a) => a.id));

    res.json({
      id: target.id,
      name: target.name,
      total_ads: ads.length,
      new_ads: newCount,
      week: isoWeek(),
      url,
      tookMs,
      total_tookMs: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = err.message || String(err);
    await logError({
      page_id: target.id,
      name: target.name,
      stage: 'scrape_creatives',
      error: msg,
      took_ms: Date.now() - startedAt,
    });
    res.status(500).json({
      stage: 'scrape_creatives',
      id: target.id,
      name: target.name,
      error: msg,
      tookMs: Date.now() - startedAt,
    });
  }
});

// Build the weekly competitor-intelligence report. Aggregates per-target
// creative snapshots, asks the configured AI provider to narrate, returns
// stats + HTML body. Designed to be called from a workflow which then
// emails the body. Token-guarded.
app.post('/api/admin/weekly-report', express.json({ limit: '1mb' }), async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(500).json({ error: 'ADMIN_TOKEN env var not configured.' });
  const provided = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== adminToken) return res.status(403).json({ error: 'Bad or missing token.' });

  const { generateReport } = require('./lib/report');
  try {
    const opts = {};
    if (req.query.this_week) opts.thisWeek = req.query.this_week;
    if (req.query.last_week) opts.lastWeek = req.query.last_week;
    if (req.body && Array.isArray(req.body.landing_diffs)) opts.landingDiffs = req.body.landing_diffs;
    const out = await generateReport(opts);
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Public read of the most recent weekly report (cached by the workflow
// when it runs). Returns null if no report has ever been generated.
app.get('/api/weekly-report', async (req, res) => {
  const { getLatestWeeklyReport } = require('./lib/storage');
  try {
    const report = await getLatestWeeklyReport();
    res.setHeader('Cache-Control', 'no-store');
    res.json(report || { ok: false, error: 'No weekly report yet — workflow has not produced one.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Same digest data as weekly-report but without the AI call. Used by the
// workflow before screenshotting so it knows which landing URLs are new.
app.get('/api/admin/digest', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(500).json({ error: 'ADMIN_TOKEN env var not configured.' });
  const provided = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== adminToken) return res.status(403).json({ error: 'Bad or missing token.' });

  const { buildDigest } = require('./lib/report');
  try {
    const opts = {};
    if (req.query.this_week) opts.thisWeek = req.query.this_week;
    if (req.query.last_week) opts.lastWeek = req.query.last_week;
    const digest = await buildDigest(opts);
    res.json({ ok: true, ...digest });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Screenshot a landing URL on the Render host (which has Puppeteer +
// Chromium) and return base64 PNG. The workflow uses this to capture
// landing pages without installing Chromium in the runner.
app.post('/api/admin/screenshot', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(500).json({ error: 'ADMIN_TOKEN env var not configured.' });
  const provided = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== adminToken) return res.status(403).json({ error: 'Bad or missing token.' });

  const url = (req.query.url || '').toString();
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Missing or invalid ?url=' });

  const startedAt = Date.now();
  try {
    const buf = await screenshotUrl(url);
    res.json({ ok: true, url, base64: buf.toString('base64'), bytes: buf.length, tookMs: Date.now() - startedAt });
  } catch (err) {
    res.status(500).json({ ok: false, url, error: err.message, tookMs: Date.now() - startedAt });
  }
});

// Smoke-test endpoint for the AI provider switcher. Token-protected because
// it consumes upstream quota. Available in any environment that has
// ADMIN_TOKEN + GEMINI_API_KEY (or other provider key) configured.
app.post('/api/admin/ai-test', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(500).json({ error: 'ADMIN_TOKEN env var not configured.' });
  const provided = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== adminToken) return res.status(403).json({ error: 'Bad or missing token.' });

  const ai = require('./lib/ai');
  const prompt = req.query.prompt || 'In one short sentence, say hello and confirm you are working.';

  try {
    const out = await ai.chat(prompt, { maxTokens: 200 });
    res.json({ ok: true, provider: out.provider, model: out.model, prompt, response: out.text, usage: out.usage });
  } catch (err) {
    res.status(500).json({ ok: false, provider: ai.provider(), error: err.message });
  }
});

// Force-run all targets right now (bypasses schedule). Used by the
// "Force run all" button and for first-time seeding.
app.get('/api/cron', async (req, res) => {
  const force = req.query.force === '1';
  if (!force) {
    return res.status(400).json({ error: 'Use ?force=1 to run now. The scheduler runs automatically on the hour.' });
  }
  try {
    const out = await runBatch(TARGETS, 'force=1');
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function lanIPs() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

// Bind explicitly to 0.0.0.0 so LAN clients (colleagues on the same office
// WiFi) can reach the dashboard at http://<this-mac's-LAN-ip>:3000.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`FB Ads Monitor listening on:`);
  console.log(`  http://localhost:${PORT}       (this machine)`);
  for (const ip of lanIPs()) {
    console.log(`  http://${ip}:${PORT}  (share with LAN)`);
  }
  console.log(`Timezone: ${TZ}, window: ${FIRST_HOUR}:30-${FIRST_HOUR + WINDOW_HOURS - 1}:30`);
});

// --- Schedule: every hour at :30, HKT 09:30-17:30 ----------------------
//
// On Render, the web service can sleep after 15min of idle (free tier), so
// in-process cron is unreliable. Render runs a separate Cron Job service
// (scripts/scrape-all.js) and sets RENDER=true, so we skip scheduling here
// to avoid double scraping.

if (process.env.RENDER) {
  console.log('[cron] skipped (RENDER=true — Render Cron Job handles scheduling)');
} else {
  cron.schedule('30 9-17 * * *', async () => {
    const hkHour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ })
        .formatToParts(new Date())
        .find((p) => p.type === 'hour').value,
    );
    const batch = pickTargetsForHour(hkHour);
    if (batch.length === 0) {
      console.log(`[cron] HKT ${hkHour}:30 no targets for this slot`);
      return;
    }
    try {
      await runBatch(batch, `HKT ${hkHour}:30`);
    } catch (err) {
      console.error(`[cron] HKT ${hkHour}:30 failed:`, err.message);
    }
  }, { timezone: TZ });
  console.log(`[cron] scheduled: 30 9-17 * * * (${TZ})`);
}
