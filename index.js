const express = require('express');
const path = require('path');
const os = require('os');
const cron = require('node-cron');

const TARGETS = require('./lib/targets');
const { scrapeTarget, scrapeCreatives, screenshotUrl } = require('./lib/scraper');
const {
  getHistory, upsertHistory, getErrors, logError,
  getCreatives, saveCreatives, saveWeeklySnapshot,
  getTriggerAllStatus, saveTriggerAllStatus,
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

// Render terminates TLS at its proxy, so the client IP arrives in
// X-Forwarded-For. Trust one proxy hop so req.ip is the real visitor —
// needed for the per-IP login throttle below.
app.set('trust proxy', 1);

// --- Auth (no-op if DASHBOARD_PASSWORD is unset) ----------------------
const {
  requireAuth,
  issueSession,
  setSessionCookie,
  clearSessionCookie,
  parseCookie,
  verifySession,
  COOKIE_NAME,
  timingSafeEqual,
  safeNextPath,
  isLockedOut,
  recordFailedLogin,
  clearLoginAttempts,
  loginRetryAfterSeconds,
} = require('./lib/auth');

// Public routes (no auth gate). Defined BEFORE the auth middleware so
// the login page itself remains reachable when locked out.
app.get('/login', (req, res) => {
  // Already logged in? Bounce home.
  if (verifySession(parseCookie(req, COOKIE_NAME))) return res.redirect('/');
  const error = req.query.error === '1' ? 'Wrong password.'
    : req.query.error === 'locked' ? 'Too many attempts. Try again later.' : '';
  const safeNext = safeNextPath(req.query.next);
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Login · FB Ads Monitor</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0d0d0d; color: #e8e8e8; min-height: 100vh; margin: 0;
    display: flex; align-items: center; justify-content: center; padding: 1rem; }
  .login-card { background: #161616; border: 1px solid #222; border-radius: 14px;
    padding: 2rem; max-width: 380px; width: 100%; }
  h1 { font-size: 0.85rem; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase; color: #888; margin: 0 0 1.5rem; }
  label { display: block; font-size: 0.72rem; color: #777;
    text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.4rem; }
  input[type=password] { width: 100%; padding: 0.7rem 0.9rem;
    background: #0a0a0a; border: 1px solid #333; border-radius: 8px;
    color: #fff; font-size: 0.95rem; font-family: inherit; outline: none; }
  input[type=password]:focus { border-color: #4a5; }
  button { width: 100%; margin-top: 1rem; padding: 0.7rem;
    background: #1a2a1a; border: 1px solid #4a5; border-radius: 8px;
    color: #cfd; font-size: 0.9rem; cursor: pointer; font-family: inherit; }
  button:hover { background: #233823; }
  .err { color: #f87171; font-size: 0.78rem; margin-top: 0.8rem; }
</style>
</head>
<body>
<form class="login-card" method="POST" action="/auth/login">
  <h1>FB Ads Monitor</h1>
  <label for="pw">Password</label>
  <input id="pw" type="password" name="password" autofocus required autocomplete="current-password" />
  <input type="hidden" name="next" value="${safeNext.replace(/"/g, '&quot;')}" />
  <button type="submit">Sign in</button>
  ${error ? `<div class="err">${error}</div>` : ''}
</form>
</body>
</html>`);
});

app.post('/auth/login', express.urlencoded({ extended: false }), (req, res) => {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return res.status(500).send('DASHBOARD_PASSWORD not configured');
  const ip = req.ip || 'unknown';
  const next = safeNextPath(req.body && req.body.next);

  // Brute-force throttle: refuse while locked out, regardless of password.
  if (isLockedOut(ip)) {
    res.setHeader('Retry-After', String(loginRetryAfterSeconds(ip)));
    return res.redirect(`/login?error=locked&next=${encodeURIComponent(next)}`);
  }

  const provided = (req.body && req.body.password) || '';
  if (!timingSafeEqual(provided, expected)) {
    recordFailedLogin(ip);
    const err = isLockedOut(ip) ? 'locked' : '1';
    return res.redirect(`/login?error=${err}&next=${encodeURIComponent(next)}`);
  }
  clearLoginAttempts(ip);
  const session = issueSession();
  if (!session) return res.status(500).send('Failed to issue session');
  setSessionCookie(res, session);
  res.redirect(next);
});

app.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/login');
});

// Apply the auth gate to everything below — static dashboard files + API.
app.use(requireAuth);

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
    const triggerAllStatus = await getTriggerAllStatus();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      targets: rows,
      errors: errors.slice(0, 50),
      // Render injects RENDER_GIT_COMMIT for every deploy. Surface the short
      // SHA so the dashboard can show "v1d94cc7" — easy way to verify a
      // redeploy actually picked up the latest commit.
      version: (process.env.RENDER_GIT_COMMIT || 'dev').slice(0, 7),
      trigger_all: triggerAllStatus,
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

  // Server-side max cap. The default-no-query value (200) keeps casual
  // single-call hits bounded; the upper hard cap (2000) is generous
  // enough that the weekly workflow's max=1000 passes through. Below
  // 100 was clipping every target (e.g. Perle ~180 only got 100 ads),
  // leaving us with incomplete creatives maps.
  const max = Math.min(parseInt(req.query.max, 10) || 200, 2000);
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

// Full cumulative creatives map for a single target — every ad we've
// captured for this page, sorted newest-first by first_seen. Used by the
// dashboard's "📋 Ads" modal so the user can scan through everything we
// hold for a competitor and sanity-check coverage. Includes the latest
// daily count so the UI can show "captured X of Y FB-reported ads".
app.get('/api/creatives', async (req, res) => {
  const id = (req.query.id || '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing ?id=<page_id>' });
  const target = TARGETS.find((t) => t.id === id);
  if (!target) return res.status(404).json({ error: `Unknown target id: ${id}` });

  try {
    const [creatives, history] = await Promise.all([
      getCreatives(target.id),
      getHistory(target.id),
    ]);
    const ads = Object.entries(creatives || {}).map(([adId, ad]) => ({ ad_id: adId, ...ad }));
    ads.sort((a, b) => {
      const aSeen = a.first_seen_iso || '';
      const bSeen = b.first_seen_iso || '';
      if (aSeen === bSeen) return 0;
      return aSeen < bSeen ? 1 : -1;
    });
    const sortedHist = (history || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const latest = sortedHist[sortedHist.length - 1] || null;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      id: target.id,
      name: target.name,
      total_captured: ads.length,
      fb_total: latest ? latest.count : null,
      fb_total_date: latest ? latest.date : null,
      ads,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full daily snapshot history for a single target. Used by the dashboard
// "history" modal to plot every recorded count point since the target was
// added.
app.get('/api/history', async (req, res) => {
  const id = (req.query.id || '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing ?id=<page_id>' });
  const target = TARGETS.find((t) => t.id === id);
  if (!target) return res.status(404).json({ error: `Unknown target id: ${id}` });
  try {
    const history = await getHistory(target.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ id: target.id, name: target.name, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// Public regenerate — re-runs the AI against creatives already in storage
// (no re-scrape) and updates weekly_report:latest. Open by design so the
// dashboard's "🔄 Regenerate now" button works without prompting for a
// token; trade-off is anyone with the URL can burn Gemini quota. The full
// /api/admin/weekly-report sibling stays token-guarded for the workflow.
app.post('/api/weekly-report/regenerate', express.json({ limit: '1mb' }), async (req, res) => {
  const { generateReport } = require('./lib/report');
  try {
    const opts = {};
    if (req.body && Array.isArray(req.body.landing_diffs)) opts.landingDiffs = req.body.landing_diffs;
    // Optional ?provider= overrides AI_PROVIDER for this call — lets the
    // dashboard have a backup button that uses a different provider.
    if (req.query.provider) opts.provider = String(req.query.provider).toLowerCase();
    const out = await generateReport(opts);
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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

// SSRF guard for the screenshot endpoint. Refuses URLs that point at
// localhost, private, or link-local/metadata addresses so a caller can't
// make the Render host fetch internal services or cloud metadata
// (169.254.169.254). The route is already token-gated; this is
// defence-in-depth. Note: hostnames are checked literally — a public
// hostname that *resolves* to a private IP (DNS rebinding) is not covered.
function screenshotUrlBlockReason(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return 'invalid URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http(s) allowed';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' || host.endsWith('.localhost') ||
    host.endsWith('.local') || host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) return 'host not allowed';
  if (host === '::1') return 'host not allowed';
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return 'host not allowed';
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return 'invalid IP';
    const [a, b] = o;
    const isPrivate =
      a === 0 || a === 127 || a === 10 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
    if (isPrivate) return 'private IP not allowed';
  }
  return null;
}

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
  const blockReason = screenshotUrlBlockReason(url);
  if (blockReason) return res.status(400).json({ error: `URL blocked: ${blockReason}` });

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

// --- Self-loop trigger-all (for external cron like Upstash QStash) -----
//
// Replaces the old GitHub Actions daily-scrape workflow. External cron
// (QStash) fires one HTTP POST → we respond 202 immediately → background
// loop scrapes all 15 targets one by one, exactly like the workflow did
// (launch fresh browser per target, 90s sleep between). GH Actions quota
// drops to zero; QStash free tier handles 500 messages/day.
//
// Lock prevents overlapping runs (e.g. if QStash retries while a run is
// still going). Progress + final summary written to trigger_all:status
// so the dashboard can show "last run: 13/15 OK at HKT 13:21".
//
// Auth: ADMIN_TOKEN via ?token= or Authorization: Bearer. When configuring
// QStash, paste the URL as:
//   https://<your-render-host>/api/trigger-all?token=<ADMIN_TOKEN>
let triggerAllRunning = false;
const TRIGGER_ALL_SLEEP_MS = 90 * 1000;

async function runTriggerAll(reason) {
  const startedAt = nowIsoUtc();
  const results = [];
  await saveTriggerAllStatus({
    started_at: startedAt, finished_at: null, reason,
    total: TARGETS.length, current_index: 0, current_id: null,
    ok: 0, failed: 0, results,
  });
  console.log(`[trigger-all] start (${reason}): ${TARGETS.length} target(s)`);

  for (let i = 0; i < TARGETS.length; i++) {
    const target = TARGETS[i];
    const tStart = Date.now();
    await saveTriggerAllStatus({
      started_at: startedAt, finished_at: null, reason,
      total: TARGETS.length, current_index: i, current_id: target.id,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
    try {
      const { count, tookMs } = await scrapeTarget(target.id);
      await upsertHistory(target.id, { date: todayHKT(), count, fetched_at_utc: nowIsoUtc() });
      results.push({ id: target.id, name: target.name, ok: true, count, tookMs });
      console.log(`[trigger-all]   [${target.name}] count=${count} (${tookMs}ms)`);
    } catch (err) {
      const msg = err.message || String(err);
      console.error(`[trigger-all]   [${target.name}] FAILED:`, msg);
      await logError({
        page_id: target.id, name: target.name,
        stage: 'trigger_all', error: msg, took_ms: Date.now() - tStart,
      });
      results.push({ id: target.id, name: target.name, ok: false, error: msg });
    }
    if (i < TARGETS.length - 1) {
      await new Promise((r) => setTimeout(r, TRIGGER_ALL_SLEEP_MS));
    }
  }

  const finished = {
    started_at: startedAt, finished_at: nowIsoUtc(), reason,
    total: TARGETS.length, current_index: TARGETS.length, current_id: null,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
  await saveTriggerAllStatus(finished);
  console.log(`[trigger-all] done: ${finished.ok}/${finished.total} OK, ${finished.failed} failed`);
  return finished;
}

app.post('/api/trigger-all', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(500).json({ error: 'ADMIN_TOKEN env var not configured.' });
  const provided = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== adminToken) return res.status(403).json({ error: 'Bad or missing token.' });

  if (triggerAllRunning) {
    return res.status(409).json({ error: 'A trigger-all run is already in progress.' });
  }
  triggerAllRunning = true;
  const reason = (req.query.reason || 'external_cron').toString().slice(0, 64);

  res.status(202).json({
    ok: true,
    started: true,
    total_targets: TARGETS.length,
    estimated_minutes: Math.ceil((TARGETS.length * TRIGGER_ALL_SLEEP_MS) / 60000),
    poll: '/api/data (trigger_all field)',
  });

  // Fire-and-forget background loop. Lock is released in finally so a
  // crash mid-run doesn't permanently block future runs.
  runTriggerAll(reason)
    .catch((err) => console.error('[trigger-all] uncaught:', err))
    .finally(() => { triggerAllRunning = false; });
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
