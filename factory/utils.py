"""Shared helpers: JSON IO, HTTP (stdlib urllib), redaction, identifiers.

All HTTP goes through ``http_get_json`` / ``http_post_json`` which set a real
browser-ish User-Agent (some CDNs — e.g. Cloudflare in front of Discord webhooks
— return 403 to ``urllib``'s default agent), enforce timeouts, and retry only
transient failures. Secrets are never logged: use ``redact()`` on any string
that may contain credentials before writing it to a log or report.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import re
import string
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 ProductFactory/1.0"
)

# Patterns for values that must never appear in logs/reports.
_SECRET_RE = re.compile(
    r"(?i)\b(?:api[_-]?key|client[_-]?secret|app[_-]?password|access[_-]?token|"
    r"refresh[_-]?token|authorization|bearer|webhook|password|passwd|secret|token|key|"
    r"[a-z0-9]+[_-](?:key|token|secret|password|passwd))\b"
    r"[\"']?\s*[:=]?\s*[\"']?[A-Za-z0-9_\-\./+=]{8,}[\"']?"
)


def now_utc() -> str:
    """ISO-8601 UTC timestamp (second precision)."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(text: str, fallback: str = "item") -> str:
    """URL-safe slug from arbitrary text."""
    s = text.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s[:80] or fallback


def gen_id(prefix: str) -> str:
    """Short unique id: ``<prefix>-<yyyymmddhhmmss>-<rand4>``."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"{prefix}-{stamp}-{''.join(random.choices(string.ascii_lowercase + string.digits, k=4))}"


def read_json(path: str | Path, default: Any = None) -> Any:
    path = Path(path)
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return default


def atomic_write_json(path: str | Path, obj: Any) -> None:
    """Write JSON atomically (tmp file + rename) so a crash never corrupts state."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def write_text(path: str | Path, content: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def read_text(path: str | Path, default: str = "") -> str:
    path = Path(path)
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return default


def redact(text: str) -> str:
    """Mask obvious secret assignments inside arbitrary text."""
    return _SECRET_RE.sub(lambda m: m.group(0)[:12] + "…<redacted>", text)


def env_present(name: str) -> bool:
    """True if env var is set to a non-empty value (never reveals the value)."""
    return bool(os.environ.get(name, "").strip())


def env_bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"} or (
        default and os.environ.get(name, "").strip() == ""
    )


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default


def http_get_json(
    url: str,
    headers: dict[str, str] | None = None,
    timeout: float = 25.0,
    retries: int = 1,
) -> Any:
    """GET and parse JSON with retry on transient errors. Raises HttpError."""
    return _request_json("GET", url, None, headers, timeout, retries)


def http_post_json(
    url: str,
    data: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
    retries: int = 1,
) -> Any:
    """POST (optional JSON body) and parse JSON response."""
    return _request_json("POST", url, data, headers, timeout, retries)


class HttpError(Exception):
    """Raised when an HTTP request ultimately fails."""

    def __init__(self, url: str, status: int, body: str = ""):
        self.url = url
        self.status = status
        self.body = body[:500]
        super().__init__(f"HTTP {status} for {url}: {self.body[:200]}")


def _request_json(
    method: str,
    url: str,
    data: dict[str, Any] | None,
    headers: dict[str, str] | None,
    timeout: float,
    retries: int,
) -> Any:
    hdrs = {
        "User-Agent": DEFAULT_UA,
        "Accept": "application/json",
    }
    if headers:
        hdrs.update(headers)
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")

    last_err: Exception | None = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(1.5 * attempt)
        req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as e:
            last_err = HttpError(url, e.code, e.read().decode("utf-8", "replace"))
            if e.code < 500 and e.code not in (408, 429):
                raise last_err  # client-side errors: no point retrying
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
            last_err = e
    raise HttpError(url, 0, str(last_err))


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, value))