
# FB Ads Library — Active Count Tracker.

Daily snapshot of how many **active ads** a specific Facebook Page is running
in Hong Kong, fetched from the official
[Graph Ad Library API](https://www.facebook.com/ads/library/api/). Diffs over
1 / 7 / 30 / 90 / 365 days are rendered to [`REPORT.md`](./REPORT.md).

Target page: `110379081699089` (HK, ACTIVE, all ad types).

## How it works

```
GitHub Actions cron (02:15 UTC daily)
  └─ scripts/fetch_count.py   → calls Graph API, paginates, returns count
  └─ scripts/update_history.py → upserts today's row into data/history.csv
  └─ scripts/generate_report.py → rewrites REPORT.md with latest diffs
  └─ git commit + push
```

CSV schema: `date,count,fetched_at_utc` (one row per UTC day, append-only).

## Setup — one-time

### 1. Create a Meta app

Go to <https://developers.facebook.com/apps/> → **Create app** →
**"Create an app without a use case"**. You'll land on the App Dashboard with
an **App ID** and **App Secret**.

### 2. Mint a non-expiring app access token

```sh
curl -sG "https://graph.facebook.com/oauth/access_token" \
  --data-urlencode "client_id=YOUR_APP_ID" \
  --data-urlencode "client_secret=YOUR_APP_SECRET" \
  --data-urlencode "grant_type=client_credentials"
```

Response: `{"access_token":"APP_ID|APP_SECRET_DERIVED","token_type":"bearer"}`.
This token does not expire.

### 3. Store the token as a GitHub Actions secret

Repo **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `FB_ACCESS_TOKEN`
- Value: _(the token from step 2)_

### 4. (Optional) Sanity check locally

```sh
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
FB_ACCESS_TOKEN='...' python scripts/fetch_count.py
# → prints a single integer, e.g. 24
```

### 5. Trigger the workflow

Either wait for 02:15 UTC or run it immediately: **Actions → Daily FB Ads
count → Run workflow**.

## Files

| Path | Purpose |
|---|---|
| `.github/workflows/track.yml` | Daily cron + commit step |
| `scripts/fetch_count.py` | Graph API call, pagination, retry |
| `scripts/update_history.py` | CSV upsert (idempotent per UTC day) |
| `scripts/generate_report.py` | Diff math + Markdown render |
| `scripts/lib.py` | Shared CSV / date helpers |
| `data/history.csv` | Append-only snapshot history |
| `REPORT.md` | Always-current rendered summary |

## Notes

- The "~24 results" number shown in the Ad Library UI is **rounded**; this
  tracker records the **exact** API count, which may differ slightly.
- Diffs use a "latest row ≤ (today − N days)" rule, so a single missed cron
  day does not break the report — it just uses the closest earlier snapshot.
- To change the tracked page or country, edit `DEFAULT_PAGE_ID` /
  `DEFAULT_COUNTRY` in `scripts/fetch_count.py`, or pass the page ID as
  `python scripts/fetch_count.py <page_id>` / set `FB_COUNTRY=...`.
