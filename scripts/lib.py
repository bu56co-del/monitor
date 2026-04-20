"""Shared utilities: CSV IO, UTC date helpers, history lookup."""
from __future__ import annotations

import csv
import os
import tempfile
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HISTORY_PATH = Path(__file__).resolve().parent.parent / "data" / "history.csv"
REPORT_PATH = Path(__file__).resolve().parent.parent / "REPORT.md"

CSV_HEADER = ["date", "count", "fetched_at_utc"]


@dataclass(frozen=True)
class Row:
    date: date
    count: int
    fetched_at_utc: str


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_history(path: Path = HISTORY_PATH) -> list[Row]:
    if not path.exists():
        return []
    rows: list[Row] = []
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(
                Row(
                    date=date.fromisoformat(r["date"]),
                    count=int(r["count"]),
                    fetched_at_utc=r["fetched_at_utc"],
                )
            )
    rows.sort(key=lambda r: r.date)
    return rows


def write_history(rows: list[Row], path: Path = HISTORY_PATH) -> None:
    """Atomic write: temp file in same dir, then os.replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".history-", suffix=".csv.tmp")
    try:
        with os.fdopen(fd, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(CSV_HEADER)
            for r in sorted(rows, key=lambda x: x.date):
                writer.writerow([r.date.isoformat(), r.count, r.fetched_at_utc])
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def upsert_row(rows: list[Row], new_row: Row) -> list[Row]:
    """Return a new list with new_row replacing any existing row on the same date."""
    return [r for r in rows if r.date != new_row.date] + [new_row]


def find_row_on_or_before(rows: list[Row], target: date) -> Row | None:
    """Latest row whose date <= target. Assumes rows sorted asc."""
    candidate: Row | None = None
    for r in rows:
        if r.date <= target:
            candidate = r
        else:
            break
    return candidate
