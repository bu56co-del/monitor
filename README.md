# FB Ads Monitor — Competitor Tracker for HKMPM

[![Daily Ad Library Scrape](https://github.com/bu56co-del/monitor/actions/workflows/daily-scrape.yml/badge.svg)](https://github.com/bu56co-del/monitor/actions/workflows/daily-scrape.yml)
[![Weekly creatives + report](https://github.com/bu56co-del/monitor/actions/workflows/weekly-creatives.yml/badge.svg)](https://github.com/bu56co-del/monitor/actions/workflows/weekly-creatives.yml)

Daily snapshot of how many **active ads** each of ~15 competitor Facebook
Pages is running in Hong Kong, plus a weekly AI-narrated digest of which
ads are new / dropped / themed around what.

Data source is the **Meta Ad Library web UI** (scraped via Puppeteer) —
no Graph API access required.

---

## Architecture

```
┌─────────────────────┐    POST /api/trigger?id=<page_id>
│  GitHub Actions     │  ─────────────────────────────────►  ┌───────────────┐
│  cron HKT 13:00     │                                       │ Render        │
│  (daily-scrape.yml) │                                       │ Web Service   │
└─────────────────────┘                                       │               │
                                                              │  Express +    │
┌─────────────────────┐    POST /api/scrape-creatives ...     │  Puppeteer    │
│  GitHub Actions     │  ─────────────────────────────────►   │               │
│  cron Sun HKT 23:00 │    POST /api/admin/weekly-report      │  Reads/writes │
│ (weekly-creatives)  │                                       │  Upstash      │
└─────────────────────┘                                       │  Redis        │
                                                              └───────┬───────┘
                                                                      │
                                                                      ▼
                                                              ┌───────────────┐
                                                              │ Dashboard     │
                                                              │ (login-gated) │
                                                              └───────────────┘
```

The Render web service (this repo's `index.js`) is the only component
that does the actual scraping; GitHub Actions just acts as a scheduler
that pokes Render's HTTP endpoints. Upstash Redis is the source of truth
for all history.

A planned migration replaces the daily GitHub Actions cron with Upstash
QStash calling `POST /api/trigger-all` directly (see PR #36) — frees ~750
GitHub Actions minutes/month. Set up via Upstash console → QStash →
Schedules.

---

## Repo layout

| Path | Purpose |
|---|---|
| `index.js` | Express server: dashboard, all `/api/*` endpoints, auth gate |
| `lib/scraper.js` | Puppeteer scraping — count + per-ad creative detail |
| `lib/storage.js` | Upstash Redis IO (file-fallback for local dev) |
| `lib/batch.js` | In-process scrape batcher (shared browser instance) |
| `lib/auth.js` | Session-cookie auth + brute-force throttle |
| `lib/report.js` | Weekly digest builder + AI narration prompt |
| `lib/ai.js` + `lib/ai/*` | Provider-agnostic AI client (Gemini / Claude / Banana2556) |
| `lib/targets.js` | The 15 competitor Pages being tracked |
| `lib/migrate.js` | Redis namespace migration helper (staging → prod) |
| `public/index.html` | Single-file dashboard (vanilla JS + dark UI) |
| `scripts/scrape-all.js` | Render Cron Job entrypoint (alternative to web cron) |
| `scripts/migrate-namespace.js` | CLI for namespace migration |
| `scripts/screenshot-diff.js` | Compare current vs baseline landing-page screenshots |
| `Dockerfile` | Render container build (Puppeteer base image) |
| `screenshots/` | Baseline landing-page screenshots (committed back by weekly workflow) |
| `.github/workflows/` | Daily + weekly cron schedulers |

---

## Environment variables (set on Render)

| Var | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Redis storage (mandatory in prod) |
| `DASHBOARD_PASSWORD` | Shared password gating the dashboard + API. **If unset, auth is bypassed** (local dev only). |
| `ADMIN_TOKEN` | Bearer token for workflows / scripts to bypass cookie auth |
| `STORAGE_NAMESPACE` | If set, prefixes all Redis keys (e.g. `staging:`). Unset on production. |
| `AI_PROVIDER` | `gemini` (default), `claude`, or `banana2556` |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `BANANA2556_API_KEY` | AI provider credentials |
| `BANANA2556_MODEL` | Override the Banana2556 default. Supported: `claude-sonnet-4-6` (default), `gpt-5.4`, `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-free` |
| `GEMINI_MODEL` / `CLAUDE_MODEL` | Optional per-provider model overrides |
| `RENDER` | Set to `true` to skip in-process cron (Render auto-injects) |
| `RENDER_GIT_COMMIT` | Auto-injected by Render; surfaces in the dashboard version badge |

GitHub Actions secrets used: `RENDER_URL`, `ADMIN_TOKEN`.

---

## Adding a new target

Edit `lib/targets.js`, push to `main`, Render auto-redeploys. Then either
wait for the next daily cron or click **↻ Fetch now** on the dashboard
row to seed initial data.

```js
module.exports = [
  // ... existing entries ...
  { id: '110379081699089', name: 'New Competitor Name' },
];
```

The `id` comes from the `view_all_page_id=` query parameter in a Meta Ad
Library URL.

---

## Local dev

```sh
npm install
DASHBOARD_PASSWORD='' node index.js   # auth bypassed for local
# → http://localhost:3000
```

For a local run that hits real Upstash data, also export
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. Without those, the
server falls back to JSON files under `data/`.
