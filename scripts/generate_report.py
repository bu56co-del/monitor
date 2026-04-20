"""Regenerate REPORT.md from data/history.csv.

Pure-python, no network. Computes diffs over 1/7/30/90/365 days using a
closest-row-on-or-before rule so missed cron runs don't break the report.
"""
from __future__ import annotations

import sys
from datetime import timedelta

from lib import REPORT_PATH, find_row_on_or_before, load_history, utc_now_iso

WINDOWS = [
    ("Daily", 1),
    ("Weekly", 7),
    ("Monthly", 30),
    ("Quarterly", 90),
    ("Yearly", 365),
]


def _fmt_diff(now: int, then: int) -> str:
    diff = now - then
    sign = "+" if diff > 0 else ""
    if then == 0:
        pct = "n/a" if diff == 0 else "∞"
    else:
        pct = f"{(diff / then) * 100:+.1f}%"
    return f"{sign}{diff} ({pct})"


def render(rows: list) -> str:
    if not rows:
        return (
            "# FB Ads Library Tracker\n\n"
            "_No data yet. The daily cron will populate `data/history.csv` on its "
            "next run._\n"
        )

    latest = rows[-1]
    lines = [
        "# FB Ads Library Tracker",
        "",
        f"**Page:** [110379081699089](https://www.facebook.com/ads/library/"
        f"?active_status=active&ad_type=all&country=HK"
        f"&view_all_page_id=110379081699089)  ",
        f"**Current active-ad count:** **{latest.count}**  ",
        f"**As of:** {latest.date.isoformat()} (UTC, fetched "
        f"{latest.fetched_at_utc})  ",
        f"**Report generated:** {utc_now_iso()}",
        "",
        "_Count comes from the Graph Ad Library API (exact). The FB UI rounds "
        "this number._",
        "",
        "## Changes",
        "",
        "| Window | Baseline date | Baseline count | Current | Diff |",
        "|---|---|---|---|---|",
    ]

    for label, days in WINDOWS:
        target = latest.date - timedelta(days=days)
        baseline = find_row_on_or_before(rows[:-1], target)
        if baseline is None:
            lines.append(
                f"| {label} ({days}d) | _n/a_ | _n/a_ | {latest.count} | "
                f"_need more history_ |"
            )
        else:
            lines.append(
                f"| {label} ({days}d) | {baseline.date.isoformat()} | "
                f"{baseline.count} | {latest.count} | "
                f"{_fmt_diff(latest.count, baseline.count)} |"
            )

    lines += [
        "",
        f"_{len(rows)} total snapshot(s) in `data/history.csv`._",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    rows = load_history()
    REPORT_PATH.write_text(render(rows), encoding="utf-8")
    print(f"Wrote {REPORT_PATH} ({len(rows)} rows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
