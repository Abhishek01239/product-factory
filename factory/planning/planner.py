"""Product planner — turns a scored opportunity into a validated build spec.

The AI (Groq) drafts the spec from the trend, prior memory (digest), and a
strict schema. The output is validated and clamped locally: any field the AI
misses or inflates is defaulted/normalized here, so downstream builders can
trust the shape.
"""

from __future__ import annotations

import json
from typing import Any

from ..ai import AIError, AIUnavailable
from ..config import Config
from ..logging_setup import log_event
from ..utils import slugify, write_text

ALLOWED_TYPES = ("static_site", "webapp", "chrome_extension", "api")

REQUIRED = ("name", "tagline", "problem", "product_type")

SPEC_SCHEMA = """You are the Product Strategist of an autonomous software factory.
Design ONE product that directly solves the reported problem. Requirements:
- One clear utility with 1-3 focused features (no feature bloat).
- product_type must be exactly one of: static_site, webapp, chrome_extension, api
- Pages for a static_site: home, about, contact, privacy, terms, disclaimer (tool pages optional).
- Be original, specific, and honest. No hype, no fake stats, no claims you cannot build.
- monetization_model: display ads later / donations / freemium — no paywall for core utility.

Respond with ONLY a JSON object shaped exactly like:
{
  "name": "...",
  "tagline": "...",
  "problem": "...",
  "users": "...",
  "product_type": "static_site",
  "features": [{"name": "...", "description": "..."}],
  "pages": ["home", "about", "contact", "privacy", "terms", "disclaimer"],
  "monetization_model": "...",
  "tech_stack": ["..."],
  "risks": ["..."]
}"""


class Planner:
    def __init__(self, config: Config, client):
        self.config = config
        self.client = client

    def plan(self, opportunity: dict[str, Any], memory_digest: dict[str, Any]) -> dict[str, Any]:
        trend = opportunity["trend"]
        user = (
            f"TOP OPPORTUNITY (trend: {trend.get('source')}):\n"
            f"Title: {trend.get('title')}\nURL: {trend.get('url')}\n"
            f"Summary: {trend.get('summary') or '(none)'}\n"
            f"Opportunity score: {opportunity.get('total')} "
            f"(breakdown: {opportunity.get('scores')})\n\n"
            f"PRIOR FACTORY MEMORY (learn from it):\n{json.dumps(memory_digest, indent=2)}\n\n"
            "Now design the single best product for this opportunity."
        )
        try:
            raw = self.client.complete_json(
                user=user, system=SPEC_SCHEMA, task="plan_spec"
            )
        except (AIError, AIUnavailable) as e:
            log_event("planning", "error", f"AI planning failed: {e}")
            raise

        spec = self._validate(raw, opportunity)
        log_event("planning", "info", f"Product spec: {spec['name']} (type={spec['product_type']})")
        return spec

    def _validate(self, raw: dict[str, Any], opportunity: dict[str, Any]) -> dict[str, Any]:
        """Normalize + clamp the AI output into a buildable spec."""
        trend = opportunity["trend"]
        default_name = slugify(trend.get("title", "utility"), "utility").replace("-", " ").title()
        name = str(raw.get("name") or default_name)[:80]
        spec = {
            "name": name,
            "tagline": str(raw.get("tagline") or f"A focused tool for {trend.get('title')}")[:200],
            "problem": str(raw.get("problem") or trend.get("title") or "…")[:400],
            "users": str(raw.get("users") or "general users")[:200],
            "product_type": raw.get("product_type")
            if raw.get("product_type") in ALLOWED_TYPES
            else "static_site",
            "features": self._features(raw.get("features")),
            "pages": self._pages(raw.get("pages"), raw.get("product_type")),
            "monetization_model": str(raw.get("monetization_model") or "none")[:200],
            "tech_stack": [str(t)[:40] for t in (raw.get("tech_stack") or [])][:10],
            "risks": [str(r)[:200] for r in (raw.get("risks") or [])][:5],
            "trend": {
                "title": trend.get("title"),
                "url": trend.get("url"),
                "source": trend.get("source"),
            },
        }
        for r in REQUIRED:
            if not spec.get(r):
                raise ValueError(f"spec missing required field: {r}")
        return spec

    @staticmethod
    def _features(features: Any) -> list[dict[str, str]]:
        if not isinstance(features, list):
            return [{"name": "Core utility", "description": "The main tool."}]
        out = []
        for f in features[:3]:
            if isinstance(f, dict):
                out.append(
                    {
                        "name": str(f.get("name") or "Tool")[:80],
                        "description": str(f.get("description") or "")[:300],
                    }
                )
        return out or [{"name": "Core utility", "description": "The main tool."}]

    @staticmethod
    def _pages(pages: Any, product_type: Any) -> list[str]:
        base = ["home", "about", "contact", "privacy", "terms", "disclaimer"]
        if product_type != "static_site":
            return base
        if not isinstance(pages, list):
            return base
        extra = []
        for p in pages:
            slug = slugify(str(p), "") if p else ""
            if slug and slug not in base and slug not in extra:
                extra.append(slug)
        return base + extra[:4]


def save_spec(config: Config, run_dir, spec: dict[str, Any]) -> None:
    write_text(run_dir / "spec.json", json.dumps(spec, indent=2, ensure_ascii=False))