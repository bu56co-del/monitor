const express = require('express');
const path = require('path');
const os = require('os');
const cron = require('node-cron');

const TARGETS = require('./lib/targets');
const { scrapeTarget } = require('./lib/scraper');
const { getHistory, upsertHistory, getErrors, logError } = require('./lib/storage');
const { runBatch, todayHKT, nowIsoUtc } = require('./lib/batch');

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
