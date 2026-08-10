"""Distribution adapter interface + capability registry.

Rules locked in from the master spec:
* Only official/documented APIs, legitimate OAuth, and platform-approved
  automation. No scraping, no stolen keys, no fake accounts, no impersonation.
* An adapter is ONLY active when its credentials are configured AND a
  lightweight capability check passes; otherwise it stays dormant in the
  registry with ``api_available``/``credentials_configured`` flags.
* One post per platform per project (dedupe via the posting log in
  ``distribution/posts.json``). Never spam, never duplicate.
"""

from __future__ import annotations

from typing import Any

from ..config import Config
from ..utils import env_present


class Adapter:
    """Base class. Subclasses declare their required env vars and implement
    ``post``; ``check`` may perform a cheap reachability probe."""

    name = "base"
    env_required: tuple[str, ...] = ()

    def __init__(self, config: Config):
        self.config = config

    def configured(self) -> bool:
        return all(env_present(v) for v in self.env_required)

    def check(self) -> dict[str, Any]:
        """Capability probe — must be cheap and non-destructive."""
        return {"api_available": self.configured(), "note": ""}

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Publish one message. Must return {"ok": bool, "id": str|None, "error": str}."""
        raise NotImplementedError


def report_adapter(adapter: Adapter, env_required: tuple[str, ...] | None = None) -> dict[str, Any]:
    """Standard capability-registry entry for an adapter."""
    needed = env_required or adapter.env_required
    result = adapter.check()
    return {
        "platform": adapter.name,
        "api_available": bool(result.get("api_available")),
        "free_tier": True,
        "posting_supported": True,
        "credentials_configured": adapter.configured(),
        "missing_env": [v for v in needed if not env_present(v)],
        "daily_limit": "see platform docs",
        "last_success": None,
        "last_error": None,
        "note": result.get("note", ""),
    }