"""Configuration: ``factory.json`` + environment overrides.

Priority (low -> high):

1. Built-in defaults (DEFAULTS below, mirrors factory.json).
2. ``factory.json`` (or ``--config PATH``).
3. Environment variables (FACTORY_* overrides and secret-env lookups).

Secrets are NEVER read here into memory structures that get persisted — they
stay in ``os.environ`` and are consumed at call time by each integration.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .utils import env_bool, env_int, env_present

DEFAULTS: dict[str, Any] = {
    "factory": {
        "name": "Autonomous Product Factory",
        "version": "1.0.0",
        "mode": "approval_required",
        "timezone": "UTC",
        "runs_dir": "runs",
        "workspace_dir": "workspace",
        "products_dir": "products",
        "registry_file": "projects.json",
        "capabilities_file": "distribution/capabilities.json",
        "memory_dir": "memory",
    },
    "budgets": {
        "max_projects_per_run": 1,
        "max_repair_attempts": 5,
        "max_ai_requests": 30,
        "max_build_seconds": 900,
        "max_run_seconds": 3600,
        "max_trend_items": 60,
        "max_stored_projects": 50,
    },
    "ai": {
        "provider": "groq",
        "model": "llama-3.3-70b-versatile",
        "base_url": "https://api.groq.com/openai/v1/chat/completions",
        "timeout_seconds": 90,
        "retries": 2,
        "max_tokens": 4096,
    },
    "trends": {
        "sources": ["hackernews", "reddit", "devto", "github"],
        "subreddits": ["programming", "webdev", "SideProject", "SaaS", "MachineLearning"],
        "hours_window": 48,
        "min_score": 45,
        "http_timeout_seconds": 25,
    },
    "scoring": {
        "user_need": 0.25,
        "search_demand": 0.15,
        "competition_gap": 0.15,
        "buildability": 0.20,
        "monetization": 0.10,
        "long_term_value": 0.10,
        "legal_risk_penalty": 0.20,
        "security_risk_penalty": 0.10,
        "platform_risk_penalty": 0.10,
    },
    "quality": {"deploy_threshold": 80, "review_threshold": 60, "min_page_words": 250},
    "gates": {
        "require": ["build", "tests", "security", "seo", "accessibility", "legal", "adsense", "secrets"]
    },
    "deploy": {"target": "vercel", "vercel_project_scope": "", "dry_run": False},
    "distribution": {"enabled": True, "max_posts_per_project": 5},
    "seo": {"site_url": "https://example.com", "author": "Product Factory"},
}


def _deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


class Config:
    """Typed-ish accessor over the merged configuration."""

    def __init__(self, root: Path, data: dict[str, Any]):
        self.root = root
        self.data = data

    @classmethod
    def load(cls, config_path: str | Path | None = None, root: str | Path | None = None) -> "Config":
        cwd = Path.cwd()
        root_ = Path(root) if root else cwd
        data: dict[str, Any] = {}
        if config_path:
            p = Path(config_path)
            if not p.exists():
                raise FileNotFoundError(f"Config file not found: {p}")
            data = json.loads(p.read_text(encoding="utf-8"))
        else:
            p = root_ / "factory.json"
            if p.exists():
                data = json.loads(p.read_text(encoding="utf-8"))
        merged = _deep_merge(DEFAULTS, data)

        # Environment overrides for budget knobs.
        merged["budgets"]["max_projects_per_run"] = env_int(
            "FACTORY_MAX_PROJECTS_PER_RUN", merged["budgets"]["max_projects_per_run"]
        )
        merged["budgets"]["max_repair_attempts"] = env_int(
            "FACTORY_MAX_REPAIR_ATTEMPTS", merged["budgets"]["max_repair_attempts"]
        )
        merged["budgets"]["max_ai_requests"] = env_int(
            "FACTORY_MAX_AI_REQUESTS", merged["budgets"]["max_ai_requests"]
        )
        if os.environ.get("FACTORY_MODE", "").strip():
            merged["factory"]["mode"] = os.environ["FACTORY_MODE"].strip()
        if os.environ.get("GROQ_MODEL", "").strip():
            merged["ai"]["model"] = os.environ["GROQ_MODEL"].strip()
        if env_bool("FACTORY_DRY_RUN", False):
            merged["deploy"]["dry_run"] = True
        return cls(root_, merged)

    def section(self, name: str) -> dict[str, Any]:
        return dict(self.data.get(name, {}) or {})

    def get(self, section: str, key: str, default: Any = None) -> Any:
        return self.section(section).get(key, default)

    def budget(self, name: str, default: int = 0) -> int:
        return int(self.section("budgets").get(name, default))

    @property
    def mode(self) -> str:
        return str(self.data.get("factory", {}).get("mode", "approval_required"))

    @property
    def approval_required(self) -> bool:
        return self.mode != "autonomous"

    @property
    def dry_run(self) -> bool:
        return bool(self.data.get("deploy", {}).get("dry_run", False))

    @property
    def mock_ai(self) -> bool:
        """Offline mode: deterministic fake AI. Never used for real output."""
        return env_bool("FACTORY_MOCK_AI", False)

    def path(self, key: str) -> Path:
        """Resolve a relative path from config against the repo root."""
        value = str(self.data.get("factory", {}).get(key, key))
        p = Path(value)
        return p if p.is_absolute() else self.root / p

    def groq_configured(self) -> bool:
        return env_present("GROQ_API_KEY")