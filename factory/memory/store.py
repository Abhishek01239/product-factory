"""Persistent, versioned learning memory.

Layout (under ``memory/``)::

    memory/
      VERSION                    # current memory version (int)
      v1/
        projects/successful/*.json
        projects/failed/*.json
        lessons/*.json
        trends/history.jsonl
        security/findings.jsonl

Versioning rule: never overwrite knowledge blindly — a new lesson is written
into the current version dir; ``bump_version()`` snapshots the previous state
so a regression can be rolled back by reverting the VERSION file (git history
of the repo is the authoritative safety net for rollback).
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..utils import atomic_write_json, gen_id, now_utc, read_json


class MemoryStore:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.version_file = root / "VERSION"
        if not self.version_file.exists():
            self.version_file.write_text("1", encoding="utf-8")

    # ---- versioning -----------------------------------------------------
    @property
    def version(self) -> int:
        try:
            return int(self.version_file.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return 1

    def current_dir(self) -> Path:
        d = self.root / f"v{self.version}"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def bump_version(self) -> int:
        new = self.version + 1
        src = self.current_dir()
        dst = self.root / f"v{new}"
        if src.exists():
            shutil.copytree(src, dst, dirs_exist_ok=True)
        dst.mkdir(parents=True, exist_ok=True)
        self.version_file.write_text(str(new), encoding="utf-8")
        return new

    # ---- generic reads/writes ------------------------------------------
    def write(self, namespace: str, name: str, obj: Any) -> Path:
        path = self.current_dir() / namespace / f"{name}.json"
        atomic_write_json(path, obj)
        return path

    def read(self, namespace: str, name: str, default: Any = None) -> Any:
        return read_json(self.current_dir() / namespace / f"{name}.json", default)

    def list_namespace(self, namespace: str) -> list[Path]:
        return sorted(self.current_dir().glob(f"{namespace}/*.json"))

    def list_dir(self, namespace: str, sub: str = "") -> list[Path]:
        base = self.current_dir() / namespace
        if sub:
            base = base / sub
        return sorted(base.glob("*.json"))

    # ---- project postmortems --------------------------------------------
    def record_project(self, outcome: str, payload: dict[str, Any]) -> str:
        """outcome: 'successful' | 'failed'. Returns the memory record id."""
        pid = payload.get("id") or gen_id("proj")
        payload.setdefault("recorded_at", now_utc())
        self.write(f"projects/{outcome}", pid, payload)
        return pid

    def load_projects(self, outcome: str | None = None) -> list[dict[str, Any]]:
        projects: list[dict[str, Any]] = []
        if outcome:
            results = self.list_dir("projects", outcome)
        else:
            results = []
            for p in self.list_dir("projects", "successful"):
                results.append(p)
            for p in self.list_dir("projects", "failed"):
                results.append(p)
        for p in results:
            obj = read_json(p, {})
            if isinstance(obj, dict) and obj:
                obj.setdefault("outcome", outcome or p.parent.name)
                projects.append(obj)
        return projects

    # ---- lessons ---------------------------------------------------------
    def add_lesson(self, lesson: dict[str, Any]) -> str:
        lid = "lesson-" + now_utc().replace(":", "").replace("-", "")[:14]
        lesson.setdefault("id", lid)
        lesson.setdefault("recorded_at", now_utc())
        self.write("lessons", lid, lesson)
        return lid

    def load_lessons(self, limit: int = 50) -> list[dict[str, Any]]:
        lessons: list[dict[str, Any]] = []
        for p in self.list_namespace("lessons"):
            obj = read_json(p, {})
            if isinstance(obj, dict) and obj:
                lessons.append(obj)
        return lessons[-limit:]

    # ---- trend history ---------------------------------------------------
    def append_trend_history(self, trends: list[dict[str, Any]]) -> None:
        path = self.current_dir() / "trends" / "history.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            for t in trends:
                f.write(json.dumps({"ts": now_utc(), **t}, ensure_ascii=False) + "\n")

    def append_security_findings(self, findings: list[dict[str, Any]]) -> None:
        path = self.current_dir() / "security" / "findings.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            for fn in findings:
                f.write(json.dumps({"ts": now_utc(), **fn}, ensure_ascii=False) + "\n")

    # ---- memory digest for the planner -----------------------------------
    def digest(self, limit_projects: int = 5, limit_lessons: int = 8) -> dict[str, Any]:
        """Compact summary of prior experience injected into planning prompts."""
        projects = self.load_projects()
        lessons = self.load_lessons(limit_lessons)
        recent = projects[-limit_projects:]
        return {
            "project_count": len(projects),
            "successful_count": len(self.load_projects("successful")),
            "failed_count": len(self.load_projects("failed")),
            "recent_projects": [
                {
                    "id": p.get("id"),
                    "name": p.get("name"),
                    "product_type": p.get("product_type"),
                    "outcome": p.get("outcome"),
                    "quality_score": p.get("quality_score"),
                }
                for p in recent
            ],
            "recent_lessons": [l.get("text", l.get("lesson", "…")) for l in lessons[-limit_lessons:]],
        }