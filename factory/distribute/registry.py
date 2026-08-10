"""Platform capability registry + distributor.

The registry (``distribution/capabilities.json``) tracks for each platform:
api_available, free_tier, posting_supported, credentials_configured,
daily_limit, last_success, last_error — refreshed on every run. Posting is
deduplicated per project per platform (``distribution/posts.json``) so a
project is never announced twice, and the per-run post cap is enforced.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..config import Config
from ..logging_setup import log_event
from ..utils import atomic_write_json, now_utc, read_json
from .adapters import ALL_ADAPTERS
from .base import Adapter, report_adapter


class PlatformRegistry:
    def __init__(self, config: Config):
        self.config = config
        self.path = config.path("capabilities_file")
        self.posts_path = config.path("workspace_dir") / "distribution" / "posts.json"
        self.state: dict[str, Any] = {"capabilities": {}, "posts": []}

    def load(self) -> dict[str, Any]:
        data = read_json(self.path, {})
        self.state = data if isinstance(data, dict) else {}
        self.state.setdefault("capabilities", {})
        self.state.setdefault("posts", [])
        return self.state

    def refresh(self) -> dict[str, Any]:
        """Probe every adapter (cheap, non-destructive) and persist state."""
        self.load()
        for cls in ALL_ADAPTERS:
            adapter = cls(self.config)
            entry = report_adapter(adapter)
            prev = self.state["capabilities"].get(adapter.name, {})
            entry["last_success"] = prev.get("last_success")
            entry["last_error"] = prev.get("last_error")
            self.state["capabilities"][adapter.name] = entry
        self._save()
        active = [k for k, v in self.state["capabilities"].items()
                  if v.get("credentials_configured") and v.get("api_available")]
        log_event("distribution", "info", f"capability refresh: {len(active)} active platform(s): {active}")
        return self.state

    def active_platforms(self) -> list[str]:
        return [k for k, v in self.state["capabilities"].items()
                if v.get("credentials_configured") and v.get("api_available")]

    def record_result(self, platform: str, ok: bool, error: str | None, post_id: str | None) -> None:
        cap = self.state["capabilities"].get(platform, {})
        if ok:
            cap["last_success"] = now_utc()
        else:
            cap["last_error"] = f"{now_utc()}: {str(error or 'unknown')[:150]}"
        self.state["capabilities"][platform] = cap
        self._save()

    def already_posted(self, project_id: str, platform: str) -> bool:
        return any(p.get("project_id") == project_id and p.get("platform") == platform
                   for p in self.state.get("posts", []))

    def mark_posted(self, project_id: str, platform: str, post_id: str | None) -> None:
        self.state.setdefault("posts", []).append({
            "project_id": project_id, "platform": platform, "post_id": post_id,
            "ts": now_utc(),
        })
        self._save()

    def _save(self) -> None:
        atomic_write_json(self.path, self.state)


class Distributor:
    def __init__(self, config: Config, registry: PlatformRegistry):
        self.config = config
        self.registry = registry

    def distribute(
        self,
        project_id: str,
        name: str,
        deploy_info: dict[str, Any],
        content: dict[str, Any],
    ) -> dict[str, Any]:
        """Post one platform-adapted announcement per active platform."""
        if not self.config.get("distribution", "enabled", True):
            return {"status": "disabled", "results": {}}
        if self.config.dry_run:
            return {"status": "simulated", "results": {
                p: {"ok": True, "id": None, "error": None, "simulated": True}
                for p in self.registry.active_platforms()}}

        cap = int(self.config.get("distribution", "max_posts_per_project", 5))
        results: dict[str, Any] = {}
        active = self.registry.active_platforms()
        for platform in active:
            if self.registry.already_posted(project_id, platform):
                results[platform] = {"ok": True, "skipped": "already posted"}
                continue
            if len([r for r in results.values() if r.get("ok")]) >= cap:
                break
            adapter: Adapter | None = None
            for cls in ALL_ADAPTERS:
                if cls.name == platform:
                    adapter = cls(self.config)
                    break
            if adapter is None:
                continue
            payload = content.get(platform, {"text": f"New tool: {name}"})
            payload.setdefault("text", f"New tool: {name}")
            try:
                result = adapter.post(payload)
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "id": None, "error": str(e)[:200]}
            self.registry.record_result(platform, bool(result.get("ok")), result.get("error"), result.get("id"))
            if result.get("ok"):
                self.registry.mark_posted(project_id, platform, result.get("id"))
            results[platform] = result
            log_event("distribution", "info" if result.get("ok") else "warning",
                      f"{platform}: {'posted' if result.get('ok') else 'failed — ' + str(result.get('error'))[:120]}")

        ok_count = sum(1 for r in results.values() if r.get("ok"))
        return {"status": "done", "posted": ok_count, "results": results}