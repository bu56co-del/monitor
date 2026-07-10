const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeDiffs, isoWeek, subtractDays, findRowOnOrBefore } = require('../lib/diffs');

test('computeDiffs: empty history returns null current and all-null diffs', () => {
  const out = computeDiffs([]);
  assert.equal(out.current, null);
  assert.equal(out.total_snapshots, 0);
  assert.equal(out.diffs.length, 5);
  for (const d of out.diffs) {
    assert.equal(d.baseline_date, null);
    assert.equal(d.diff, null);
    assert.equal(d.pct, null);
  }
});

test('computeDiffs: single row has current but no baselines', () => {
  const out = computeDiffs([{ date: '2026-06-10', count: 42 }]);
  assert.equal(out.current.count, 42);
  assert.equal(out.total_snapshots, 1);
  for (const d of out.diffs) assert.equal(d.baseline_date, null);
});

test('computeDiffs: 1D window diffs against yesterday', () => {
  const out = computeDiffs([
    { date: '2026-06-09', count: 10 },
    { date: '2026-06-10', count: 14 },
  ]);
  const d1 = out.diffs.find((d) => d.label === '1D');
  assert.equal(d1.baseline_date, '2026-06-09');
  assert.equal(d1.diff, 4);
  assert.equal(d1.pct, 40);
});

test('computeDiffs: missed cron day falls back to closest earlier snapshot', () => {
  // No row exactly 7 days before the latest — the rule is "latest row ≤
  // (latest − N days)", so the 7D window should use the 8-day-old row.
  const out = computeDiffs([
    { date: '2026-06-02', count: 20 },
    { date: '2026-06-10', count: 25 },
  ]);
  const d7 = out.diffs.find((d) => d.label === '7D');
  assert.equal(d7.baseline_date, '2026-06-02');
  assert.equal(d7.diff, 5);
  assert.equal(d7.pct, 25);
});

test('computeDiffs: zero baseline yields null pct (no divide-by-zero)', () => {
  const out = computeDiffs([
    { date: '2026-06-09', count: 0 },
    { date: '2026-06-10', count: 5 },
  ]);
  const d1 = out.diffs.find((d) => d.label === '1D');
  assert.equal(d1.diff, 5);
  assert.equal(d1.pct, null);
});

test('computeDiffs: pct rounds to one decimal place', () => {
  const out = computeDiffs([
    { date: '2026-06-09', count: 3 },
    { date: '2026-06-10', count: 4 },
  ]);
  const d1 = out.diffs.find((d) => d.label === '1D');
  assert.equal(d1.pct, 33.3);
});

test('subtractDays crosses month and year boundaries', () => {
  assert.equal(subtractDays('2026-03-01', 1), '2026-02-28');
  assert.equal(subtractDays('2026-01-01', 1), '2025-12-31');
  assert.equal(subtractDays('2026-06-10', 30), '2026-05-11');
});

test('findRowOnOrBefore picks the latest row not after the target date', () => {
  const rows = [
    { date: '2026-06-01' },
    { date: '2026-06-05' },
    { date: '2026-06-09' },
  ];
  assert.equal(findRowOnOrBefore(rows, '2026-06-05').date, '2026-06-05');
  assert.equal(findRowOnOrBefore(rows, '2026-06-07').date, '2026-06-05');
  assert.equal(findRowOnOrBefore(rows, '2026-05-31'), null);
});

test('isoWeek: known ISO-8601 week boundaries', () => {
  // 2026-01-01 is a Thursday → week 1 of 2026.
  assert.equal(isoWeek(new Date(Date.UTC(2026, 0, 1))), '2026-W01');
  // 2024-12-30 is a Monday belonging to 2025's week 1.
  assert.equal(isoWeek(new Date(Date.UTC(2024, 11, 30))), '2025-W01');
  // 2021-01-01 is a Friday belonging to 2020's week 53.
  assert.equal(isoWeek(new Date(Date.UTC(2021, 0, 1))), '2020-W53');
  // Mid-year sanity check.
  assert.equal(isoWeek(new Date(Date.UTC(2026, 5, 10))), '2026-W24');
});
