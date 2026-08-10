"""Trend Scout — collects signals from legally accessible public sources.

Sources (all no-auth, no-paywall, no-CAPTCHA):
* Hacker News  — official Firebase API (``https://hacker-news.firebaseio.com``)
* Reddit       — public RSS feeds (never the JSON API; no UA tricks, no scraping)
* Dev.to       — public articles API (``dev.to/api/articles``)
* GitHub       — search API, only when ``GITHUB_TOKEN`` is available in the
  environment (yes: that's the *clean* way to use it — no scraping of the
  trending HTML page)

Everything is normalized to a uniform ``TrendItem`` dict, deduplicated,
age-filtered and capped. If a source is down or blocked, that source is
skipped with a logged warning — the scout never retries aggressively, never
circumvents limits, and never touches private data.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Any

from ..config import Config
from ..logging_setup import log_event
from ..utils import env_present, http_get_json, slugify

HN_TOP = "https://hacker-news.firebaseio.com/v0/topstories.json"
HN_ITEM = "https://hacker-news.firebaseio.com/v0/item/{}.json"
REDDIT_RSS = "https://www.reddit.com/r/{}/.rss"
DEVTO_TOP = "https://dev.to/api/articles?per_page=30&top=7"
GITHUB_SEARCH = (
    "https://api.github.com/search/repositories?q=created:%3E{date}&sort=stars&order=desc&per_page=20"
)


class TrendScout:
    def __init__(self, config: Config):
        self.config = config
        self.timeout = float(config.get("trends", "http_timeout_seconds", 25))
        self.sources = list(config.get("trends", "sources", []))
        self.subreddits = list(config.get("trends", "subreddits", []))
        self.trends: list[dict[str, Any]] = []

    # ---- public API ------------------------------------------------------
    def collect(self) -> list[dict[str, Any]]:
        """Fetch from all configured sources, normalize, dedupe, filter."""
        collected: list[dict[str, Any]] = []
        fetchers = {
            "hackernews": self._fetch_hackernews,
            "reddit": self._fetch_reddit,
            "devto": self._fetch_devto,
            "github": self._fetch_github,
        }
        for name in self.sources:
            fn = fetchers.get(name)
            if not fn:
                log_event("trends", "warning", f"Unknown trend source skipped: {name}")
                continue
            try:
                items = fn()
                log_event("trends", "info", f"{name}: {len(items)} raw signals")
                collected.extend(items)
            except Exception as e:  # noqa: BLE001 — a dead source must not kill the run
                log_event("trends", "warning", f"{name} fetch failed: {str(e)[:200]}")

        self.trends = self._dedupe(collected)
        self.trends = self._filter_age(self.trends)
        cap = self.config.budget("max_trend_items", 60)
        self.trends = self.trends[:cap]
        log_event("trends", "info", f"total normalized trends: {len(self.trends)}")
        return self.trends

    # ---- sources ---------------------------------------------------------
    def _fetch_hackernews(self) -> list[dict[str, Any]]:
        ids = http_get_json(HN_TOP, timeout=self.timeout, retries=1)
        items: list[dict[str, Any]] = []
        for hn_id in (ids or [])[:30]:
            try:
                item = http_get_json(HN_ITEM.format(hn_id), timeout=self.timeout, retries=0)
            except Exception:  # noqa: BLE001
                continue
            if not item or item.get("type") != "story" or not item.get("title"):
                continue
            items.append(
                {
                    "source": "hackernews",
                    "title": item["title"],
                    "url": item.get("url") or f"https://news.ycombinator.com/item?id={hn_id}",
                    "score_0_100": min(100, int(item.get("score") or 0) // 8),
                    "published": _iso_from_ts(item.get("time")),
                    "summary": (item.get("text") or "")[:280] if item.get("text") else "",
                    "tags": ["tech", "startups", "dev"],
                }
            )
            if len(items) >= 20:
                break
        return items

    def _fetch_reddit(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for sub in self.subreddits:
            items.extend(self._reddit_rss_raw(sub))
        return items

    def _reddit_rss_raw(self, sub: str) -> list[dict[str, Any]]:
        import urllib.request

        from ..utils import DEFAULT_UA

        items: list[dict[str, Any]] = []
        try:
            req = urllib.request.Request(
                REDDIT_RSS.format(sub), headers={"User-Agent": DEFAULT_UA}
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
            root = ET.fromstring(raw)
        except Exception as e:  # noqa: BLE001
            log_event("trends", "warning", f"reddit r/{sub} fetch failed: {str(e)[:150]}")
            return items
        for entry in root.iter("{http://www.w3.org/2005/Atom}entry"):
            title_el = entry.find("{http://www.w3.org/2005/Atom}title")
            link_el = entry.find("{http://www.w3.org/2005/Atom}link")
            updated_el = entry.find("{http://www.w3.org/2005/Atom}updated")
            if title_el is None or link_el is None:
                continue
            title = title_el.text or ""
            link = link_el.get("href", "")
            if not title or not link:
                continue
            items.append(
                {
                    "source": "reddit",
                    "title": title,
                    "url": link,
                    "score_0_100": 45,  # RSS has no score; neutral baseline
                    "published": (updated_el.text or "") if updated_el is not None else "",
                    "summary": "",
                    "tags": ["discussion", sub],
                }
            )
        return items[:15]

    def _fetch_devto(self) -> list[dict[str, Any]]:
        items = []
        try:
            articles = http_get_json(DEVTO_TOP, timeout=self.timeout, retries=1)
        except Exception as e:  # noqa: BLE001
            log_event("trends", "warning", f"devto fetch failed: {str(e)[:150]}")
            return items
        for a in (articles or [])[:20]:
            items.append(
                {
                    "source": "devto",
                    "title": a.get("title", ""),
                    "url": a.get("url", ""),
                    "score_0_100": min(100, int(a.get("positive_reactions_count") or 0) // 3),
                    "published": a.get("published_at", ""),
                    "summary": (a.get("description") or "")[:280],
                    "tags": [t for t in (a.get("tag_list") or []) if isinstance(t, str)][:5],
                }
            )
        return items

    def _fetch_github(self) -> list[dict[str, Any]]:
        import os

        if not env_present("GITHUB_TOKEN"):
            log_event("trends", "info", "github source skipped (GITHUB_TOKEN not set — the search API needs it)")
            return []
        days_ago = self.config.get("trends", "hours_window", 48) // 24 + 1
        date = (
            datetime.now(timezone.utc) - timedelta(days=days_ago)
        ).strftime("%Y-%m-%d")
        items = []
        try:
            data = http_get_json(
                GITHUB_SEARCH.format(date=date),
                headers={"Authorization": f"token {os.environ['GITHUB_TOKEN']}"},
                timeout=self.timeout,
                retries=1,
            )
        except Exception as e:  # noqa: BLE001
            log_event("trends", "warning", f"github search failed: {str(e)[:150]}")
            return items
        for r in (data.get("items") or [])[:15]:
            items.append(
                {
                    "source": "github",
                    "title": r.get("description") or r.get("name", ""),
                    "url": r.get("html_url", ""),
                    "score_0_100": min(100, int(r.get("stargazers_count") or 0) // 15),
                    "published": r.get("created_at", ""),
                    "summary": (r.get("description") or "")[:280],
                    "tags": ["repo", (r.get("language") or "code").lower()],
                }
            )
        return items

    # ---- normalization helpers -------------------------------------------
    def _dedupe(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        seen: set[str] = set()
        out: list[dict[str, Any]] = []
        for it in items:
            key = slugify(it.get("title", "")) or it.get("url", "")
            if key in seen:
                continue
            seen.add(key)
            out.append(it)
        return out

    def _filter_age(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        window_h = self.config.get("trends", "hours_window", 48)
        cutoff = datetime.now(timezone.utc).timestamp() - window_h * 3600
        kept: list[dict[str, Any]] = []
        for it in items:
            ts = _parse_iso(it.get("published", ""))
            if ts is not None and ts < cutoff:
                continue  # too old
            kept.append(it)
        return kept


# ---- small parsing helpers -----------------------------------------------
def _iso_from_ts(unix_ts: Any) -> str:
    try:
        return datetime.fromtimestamp(int(unix_ts), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return ""


def _parse_iso(value: str) -> float | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None