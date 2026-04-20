"""Upsert today's count into data/history.csv.

Reads the count from stdin (one integer). Idempotent: rerunning on the same
UTC day overwrites that day's row; never duplicates.
"""
from __future__ import annotations

import sys

from lib import Row, load_history, upsert_row, utc_now_iso, utc_today, write_history


def main() -> int:
    raw = sys.stdin.read().strip()
    if not raw:
        print("ERROR: no count on stdin.", file=sys.stderr)
        return 2
    try:
        count = int(raw)
    except ValueError:
        print(f"ERROR: stdin is not an integer: {raw!r}", file=sys.stderr)
        return 2
    if count < 0:
        print(f"ERROR: negative count: {count}", file=sys.stderr)
        return 2

    rows = load_history()
    new_row = Row(date=utc_today(), count=count, fetched_at_utc=utc_now_iso())
    rows = upsert_row(rows, new_row)
    write_history(rows)
    print(f"Wrote {new_row.date.isoformat()} count={count} ({len(rows)} rows total)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
