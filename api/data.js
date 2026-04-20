const { Redis } = require('@upstash/redis');

const KV_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const WINDOWS = [
  { label: 'Daily',     days: 1   },
  { label: 'Weekly',    days: 7   },
  { label: 'Monthly',   days: 30  },
  { label: 'Quarterly', days: 90  },
  { label: 'Yearly',    days: 365 },
];

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  if (!KV_URL || !KV_TOKEN) {
    return res.status(500).json({
      error: 'KV not configured',
      detail: 'Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN). Attach an Upstash Redis database in Vercel → Storage, then redeploy.',
    });
  }

  try {
    const kv = new Redis({ url: KV_URL, token: KV_TOKEN });
    let history = (await kv.get('history')) ?? [];

    if (typeof history === 'string') {
      try { history = JSON.parse(history); } catch { history = []; }
    }
    if (!Array.isArray(history)) history = [];

    if (history.length === 0) {
      return res.status(200).json({ current: null, diffs: [], total_snapshots: 0 });
    }

    const latest = history[history.length - 1];
    const prev = history.slice(0, -1);

    const diffs = WINDOWS.map(({ label, days }) => {
      const targetDate = subtractDays(latest.date, days);
      const baseline = findRowOnOrBefore(prev, targetDate);

      if (!baseline) {
        return { label, days, baseline_date: null, baseline_count: null, diff: null, pct: null };
      }

      const diff = latest.count - baseline.count;
      const pct = baseline.count === 0
        ? null
        : Math.round((diff / baseline.count) * 1000) / 10;

      return { label, days, baseline_date: baseline.date, baseline_count: baseline.count, diff, pct };
    });

    return res.status(200).json({ current: latest, diffs, total_snapshots: history.length });
  } catch (err) {
    console.error('data API error:', err.message);
    return res.status(500).json({ error: 'Failed to read history', detail: err.message });
  }
};
