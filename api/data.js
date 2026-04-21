const TARGETS = require('./_targets');
const { getKv, isKvConfigured, getHistory, getErrors } = require('./_kv');

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

function computeDiffs(history) {
  if (!history || history.length === 0) {
    return { current: null, diffs: WINDOWS.map(({ label, days }) => ({
      label, days, baseline_date: null, baseline_count: null, diff: null, pct: null,
    })), total_snapshots: 0 };
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
  return { current: latest, diffs, total_snapshots: history.length };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (!isKvConfigured()) {
    return res.status(500).json({
      stage: 'config',
      error: 'KV not configured',
      detail: 'Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.',
    });
  }

  try {
    const kv = getKv();
    const rows = await Promise.all(
      TARGETS.map(async (t) => {
        const history = await getHistory(kv, t.id);
        const diffSet = computeDiffs(history);
        return { id: t.id, name: t.name, ...diffSet };
      })
    );
    const errors = await getErrors(kv);
    return res.status(200).json({
      targets: rows,
      errors: errors.slice(0, 50),
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('data API error:', err.message);
    return res.status(500).json({ error: 'Failed to read history', detail: err.message });
  }
};
