"""Project registry (``projects.json``) — the factory's ledger of every build.

Fields follow the master specification: id, name, trend, product_type,
repository, deployment URL, status, technologies, creation date, quality
score, security/SEO/AdSense statuses, distribution status, analytics, and
lessons learned.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .utils import atomic_write_json, gen_id, now_utc, read_json

STATUSES = ("trend_selected", "planned", "built", "tested", "audited",
            "gates_passed", "deployed", "distributed", "failed", "rejected",
            "blocked", "approved_pending")


class ProjectRegistry:
    def __init__(self, path: str | Path):
        self.path = Path(path)

    def _load(self) -> list[dict[str, Any]]:
        data = read_json(self.path, [])
        return data if isinstance(data, list) else []

    def _save(self, projects: list[dict[str, Any]]) -> None:
        atomic_write_json(self.path, projects)

    # ---- CRUD -------------------------------------------------------------
    def create(self, meta: dict[str, Any]) -> str:
        """Insert a new project; returns its id."""
        projects = self._load()
        pid = meta.get("id") or gen_id("p")
        record = {
            "id": pid,
            "name": meta.get("name", "untitled"),
            "trend": meta.get("trend", ""),
            "product_type": meta.get("product_type", ""),
            "repository": meta.get("repository", ""),
            "deployment_url": "",
            "status": meta.get("status", "trend_selected"),
            "technologies": list(meta.get("technologies", [])),
            "creation_date": now_utc(),
            "quality_score": None,
            "security_status": None,
            "seo_status": None,
            "adsense_status": None,
            "distribution_status": None,
            "analytics": {},
            "lessons": [],
        }
        projects.append(record)
        self._save(projects)
        return pid

    def get(self, pid: str) -> dict[str, Any] | None:
        for p in self._load():
            if p.get("id") == pid:
                return p
        return None

    def update(self, pid: str, **fields: Any) -> dict[str, Any] | None:
        projects = self._load()
        for p in projects:
            if p.get("id") == pid:
                for k, v in fields.items():
                    if k in p or k in (
                        "status", "quality_score", "security_status", "seo_status",
                        "adsense_status", "distribution_status", "deployment_url",
                        "repository", "technologies", "analytics", "lessons",
                    ):
                        p[k] = v
                self._save(projects)
                return p
        return None

    def list(self) -> list[dict[str, Any]]:
        return self._load()

    def recent(self, n: int = 5) -> list[dict[str, Any]]:
        return self._load()[-n:]

    def add_lesson(self, pid: str, lesson: str) -> None:
        p = self.get(pid)
        if p:
            lessons = list(p.get("lessons", []))
            lessons.append(lesson)
            self.update(pid, lessons=lessons)