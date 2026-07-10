// Pure date/diff helpers shared by index.js and the test suite. No IO —
// everything here must stay requireable without starting the server.

const WINDOWS = [
  { label: '1D',  days: 1  },
  { label: '7D',  days: 7  },
  { label: '14D', days: 14 },
  { label: '30D', days: 30 },
  { label: '60D', days: 60 },
];

// ISO week label like "2026-W18" — used to bucket weekly creative snapshots.
function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
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

module.exports = { WINDOWS, isoWeek, subtractDays, findRowOnOrBefore, computeDiffs };
