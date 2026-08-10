"""Learning engine — postmortems, structured lessons, self-improvement.

Every completed project produces a structured postmortem (per the master spec
schema) stored in versioned memory (``memory/vN/projects/{successful,failed}``),
plus extracted lessons. The memory version is bumped after each run so any
regression can be rolled back via the VERSION file or git history.
"""

from __future__ import annotations

from typing import Any

from ..ai import AIError, AIUnavailable
from ..config import Config
from ..logging_setup import log_event
from ..memory import MemoryStore
from ..utils import json as _json  # noqa: F401  (re-export convenience)

POSTMORTEM_PROMPT = """You are the Learning Agent of an autonomous software factory. Write a
structured postmortem for the just-finished project. Be brutally honest —
this feeds future builds.

Return JSON:
{"lessons": ["..."], "solutions": ["..."], "should_reuse": ["..."],
"never_repeat": ["..."], "recommendations_for_future_projects": ["..."]}"""


class LearningEngine:
    def __init__(self, config: Config, memory: MemoryStore, client):
        self.config = config
        self.memory = memory
        self.client = client

    def postmortem(self, project: dict[str, Any], outcome: str,
                   run_summary: dict[str, Any]) -> dict[str, Any]:
        """Build + persist the postmortem record."""
        record = {
            "project": project.get("name"),
            "idea": project.get("trend", ""),
            "architecture": "stdlib-only python factory; static-site renderer",
            "technologies": project.get("technologies", []),
            "successful_components": [],
            "failed_components": [],
            "errors": run_summary.get("errors", []),
            "solutions": [],
            "security_findings": [f.get("summary") for f in
                                  [run_summary.get("security")] if isinstance(f, dict) and f.get("findings")],
            "seo_findings": [f.get("issue") for f in
                             (run_summary.get("seo", {}).get("findings") or [])][:10],
            "performance_results": [{"score": run_summary.get("quality_score")}],
            "deployment_result": run_summary.get("deploy_status", "not_deployed"),
            "lessons": [],
            "recommendations_for_future_projects": [],
        }

        try:
            if self.client is None:
                raise AIUnavailable("no AI client available (offline run) — factual record only")
            ai = self.client.complete_json(
                user=(f"Project: {project.get('name')} ({project.get('product_type')})\n"
                      f"Outcome: {outcome}\n"
                      f"Quality score: {run_summary.get('quality_score')}\n"
                      f"Gates: {run_summary.get('gates')}\n"
                      f"Deploy: {run_summary.get('deploy_status')} — {run_summary.get('deploy_reason', '')}\n"
                      f"Errors: {run_summary.get('errors', [])}\n"
                      "Write the postmortem now."),
                task="postmortem",
            )
            for key in ("lessons", "solutions", "should_reuse", "never_repeat",
                        "recommendations_for_future_projects"):
                if isinstance(ai.get(key), list):
                    record[key] = [str(x)[:300] for x in ai[key]][:8]
        except (AIError, AIUnavailable) as e:
            log_event("learn", "info", f"AI postmortem unavailable ({e}); storing factual record")

        record["outcome"] = outcome
        self.memory.record_project(outcome, {**record, "id": project.get("id")})
        for lesson in record["lessons"]:
            self.memory.add_lesson({"project": project.get("name"), "text": lesson,
                                    "outcome": outcome})
        log_event("learn", "info", f"postmortem stored ({outcome}); lessons: {len(record['lessons'])}")
        return record

    def self_improvement_report(self) -> str:
        """Human-readable digest of accumulated knowledge."""
        mem = self.memory.digest()
        lines = [
            f"Projects on record: {mem['project_count']} "
            f"({mem['successful_count']} successful / {mem['failed_count']} failed)",
            f"Memory version: v{self.memory.version}",
        ]
        if mem["recent_lessons"]:
            lines.append("Latest lessons:")
            for l in mem["recent_lessons"][-5:]:
                lines.append(f"  - {l}")
        else:
            lines.append("No lessons yet — first run.")
        return "\n".join(lines)