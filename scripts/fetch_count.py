"""Fetch active-ad count for a Facebook Page via the Ad Library Graph API.

Usage:
    FB_ACCESS_TOKEN=xxx python scripts/fetch_count.py [page_id]

Prints a single integer on success. Exits non-zero on failure.
"""
from __future__ import annotations

import os
import signal
import sys
import time
from urllib.parse import urlparse, urlunparse

import requests

GRAPH_VERSION = "v21.0"
DEFAULT_PAGE_ID = "110379081699089"
DEFAULT_COUNTRY = "HK"
PAGE_SIZE = 500
MAX_PAGES = 50  # hard ceiling: 50 * 500 = 25,000 ads
REQUEST_TIMEOUT_S = 30
OVERALL_TIMEOUT_S = 120
RETRY_DELAYS_S = (2, 4, 8)  # 4 total attempts


def _redact_url(url: str) -> str:
    """Strip query string so access_token never appears in logs."""
    parts = urlparse(url)
    return urlunparse(parts._replace(query="<redacted>"))


def _get_with_retry(url: str, params: dict) -> dict:
    last_err: Exception | None = None
    for attempt, delay in enumerate((0,) + RETRY_DELAYS_S):
        if delay:
            time.sleep(delay)
        try:
            resp = requests.get(url, params=params, timeout=REQUEST_TIMEOUT_S)
        except requests.RequestException as e:
            last_err = e
            print(
                f"[attempt {attempt + 1}] network error: {type(e).__name__}",
                file=sys.stderr,
            )
            continue

        # Surface API version deprecation warnings.
        dep = resp.headers.get("X-Ad-Account-Warning") or resp.headers.get(
            "Facebook-API-Version-Warning"
        )
        if dep:
            print(f"::warning::Graph API deprecation header: {dep}", file=sys.stderr)

        if resp.status_code == 200:
            return resp.json()

        # Retry on 429 + 5xx; fail fast on other 4xx.
        if resp.status_code == 429 or 500 <= resp.status_code < 600:
            last_err = RuntimeError(f"HTTP {resp.status_code}")
            print(
                f"[attempt {attempt + 1}] HTTP {resp.status_code} from {_redact_url(resp.url)}",
                file=sys.stderr,
            )
            continue

        # Non-retryable: raise with sanitized message (no token).
        try:
            err_body = resp.json()
        except ValueError:
            err_body = {"raw": resp.text[:500]}
        raise RuntimeError(
            f"Graph API returned HTTP {resp.status_code}: {err_body}"
        )

    raise RuntimeError(f"All retries exhausted: {last_err}")


def fetch_count(page_id: str, country: str, token: str) -> int:
    base = f"https://graph.facebook.com/{GRAPH_VERSION}/ads_archive"
    params: dict = {
        "search_page_ids": page_id,
        "ad_active_status": "ACTIVE",
        "ad_reached_countries": f'["{country}"]',
        "ad_type": "ALL",
        "fields": "id",
        "limit": PAGE_SIZE,
        "access_token": token,
    }

    total = 0
    url = base
    for page_num in range(1, MAX_PAGES + 1):
        data = _get_with_retry(url, params if page_num == 1 else {})
        batch = data.get("data", [])
        total += len(batch)
        next_url = data.get("paging", {}).get("next")
        if not next_url or not batch:
            return total
        # Subsequent pages: use the full cursor URL (already contains token).
        url = next_url

    raise RuntimeError(
        f"Hit MAX_PAGES={MAX_PAGES} ceiling without exhausting results"
    )


def _timeout_handler(signum, frame):  # noqa: ARG001
    raise TimeoutError(f"Overall fetch exceeded {OVERALL_TIMEOUT_S}s")


def main() -> int:
    token = os.environ.get("FB_ACCESS_TOKEN", "").strip()
    if not token:
        print("ERROR: FB_ACCESS_TOKEN env var is empty.", file=sys.stderr)
        return 2

    page_id = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PAGE_ID
    country = os.environ.get("FB_COUNTRY", DEFAULT_COUNTRY)

    signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(OVERALL_TIMEOUT_S)
    try:
        count = fetch_count(page_id, country, token)
    except Exception as e:
        msg = str(e).replace(token, "***REDACTED***")
        print(f"ERROR: {msg}", file=sys.stderr)
        return 1
    finally:
        signal.alarm(0)

    print(count)
    return 0


if __name__ == "__main__":
    sys.exit(main())
