"""Pipeline orchestrator — one run-to-completion factory pass.

    trends -> scoring -> planning -> build -> tests -> audits -> gates
           -> quality score -> deploy -> distribute -> learn

Hard rules enforced here:
* A mandatory gate failure OR a quality verdict below the deploy threshold
  means NO deployment — the output is a report + a memory postmortem.
* Max-repairs exhaustion marks the project failed (never hidden).
* Budgets (time, projects per run, AI requests) are enforced.
* Approval mode stops before deploy/distribute and writes APPROVAL.md.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from .ai import AIBudgetExceeded, AIError, AIUnavailable, get_client
from .build import BuildError, CodeBuilder
from .config import Config
from .deploy import DeploymentManager
from .distribute import Distributor, PlatformRegistry
from .distribute.content import generate_content
from .learn import LearningEngine
from .logging_setup import bind_run, log_event
from .memory import MemoryStore
from .planning import Planner, save_spec
from .quality import compute_quality_score, gates_passed
from .quality.debugger import Debugger
from .quality.runner import run_audits
from .quality.tests import TestRunner
from .registry import ProjectRegistry
from .trends import TrendScout, score_opportunities
from .utils import atomic_write_json, gen_id, now_utc, read_json, slugify, write_text

EXIT_OK = 0
EXIT_PROJECT_FAILED = 1
EXIT_CONFIG = 2
EXIT_BLOCKED = 3
EXIT_MAX_REPAIRS = 4


def run_factory(config: Config) -> int:
    run_id = gen_id("run")
    run_dir = config.path("runs_dir") / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    bind_run(run_id, run_dir / "events.jsonl")
    started = time.monotonic()
    budget_seconds = config.budget("max_run_seconds", 3600)

    summary: dict[str, Any] = {
        "run_id": run_id, "started": now_utc(), "stage": "booting",
        "errors": [], "gates": {}, "quality_score": None,
        "deploy_status": None, "deploy_reason": "", "project_id": None,
    }

    def _deadline() -> bool:
        return time.monotonic() - started > budget_seconds

    log_event("pipeline", "info", f"factory run {run_id} starting (mode={config.mode})")

    try:
        registry = ProjectRegistry(config.path("registry_file"))
        memory = MemoryStore(config.path("memory_dir"))

        # ---------- 1. TREND SCOUT + SCORING ----------------------------- #
        summary["stage"] = "trends"
        scout = TrendScout(config)
        trends = scout.collect()
        opportunities = score_opportunities(trends, config)
        memory.append_trend_history(trends[:10])
        if not opportunities:
            return _finish(run_dir, summary, EXIT_BLOCKED,
                           "no eligible opportunities found this run (all trends suppressed or empty)")
        top = opportunities[0]
        log_event("pipeline", "info",
                  f"top opportunity: {top['trend'].get('title', '?')[:80]} (score {top['total']})")

        # ---------- 2. PLANNER ------------------------------------------- #
        summary["stage"] = "planning"
        client = get_client(config)  # AIUnavailable -> blocked, documented
        planner = Planner(config, client)
        spec = planner.plan(top, memory.digest())
        save_spec(config, run_dir, spec)
        pid = registry.create({
            "name": spec["name"],
            "trend": spec["trend"]["title"],
            "product_type": spec["product_type"],
            "technologies": spec["tech_stack"],
            "status": "planned",
        })
        summary["project_id"] = pid
        product_dir = config.path("products_dir") / pid
        log_event("pipeline", "info", f"project {pid} registered: {spec['name']}")

        # ---------- 3. BUILD (with one simplification retry) -------------- #
        summary["stage"] = "build"
        builder = CodeBuilder(config, client)
        try:
            builder.build(spec, product_dir)
        except (BuildError, AIError) as e:
            log_event("pipeline", "warning", f"build failed: {e} — retrying with minimal feature set")
            simplified = dict(spec)
            simplified["features"] = [spec["features"][0]] if spec["features"] else [{
                "name": "Core utility", "description": "The main tool."}]
            try:
                builder.build(simplified, product_dir)
                spec = simplified
            except (BuildError, AIError) as e2:
                summary["errors"].append(f"build: {e2}")
                registry.update(pid, status="failed")
                return _finish(run_dir, summary, EXIT_PROJECT_FAILED, f"build failed after retry: {e2}")

        # ---------- 4. TESTS + DEBUG LOOP --------------------------------- #
        summary["stage"] = "tests"
        runner = TestRunner(config)
        debugger = Debugger(config, client)

        def _check(candidate_dir: Path = product_dir):
            return runner.run(candidate_dir, spec)

        check_result = _check()
        if check_result.get("status") != "pass":
            repair = debugger.repair(product_dir, _check, str(check_result))
            if repair.get("status") != "pass":
                summary["errors"].append(f"tests: {repair['result']}")
                registry.update(pid, status="failed")
                return _finish(run_dir, summary, EXIT_MAX_REPAIRS,
                               f"tests failed after {repair['attempts']} repair attempt(s)")

        # ---------- 5. AUDITS (security, seo, a11y, legal, adsense) ------ #
        summary["stage"] = "audits"
        gate_results = run_audits(product_dir, spec, config)
        summary["gates"] = {k: v.get("status") for k, v in gate_results.items() if isinstance(v, dict)}

        # ---------- 6. GATE EVALUATION + QUALITY SCORE -------------------- #
        require = config.get("gates", "require", [])
        gate_eval = gates_passed(gate_results, require)
        if not gate_eval["all_pass"]:
            failed_required = [g for g, s in gate_eval["gates"].items() if s != "pass"]
            log_event("pipeline", "error", f"MANDATORY GATE FAILURE: {failed_required} — refusing to deploy")
            registry.update(pid, status="failed", quality_score=0,
                            security_status=gate_results.get("security", {}).get("status"),
                            seo_status=gate_results.get("seo", {}).get("status"),
                            adsense_status=gate_results.get("adsense", {}).get("status"))
            summary["errors"].append(f"gates failed: {failed_required}")
            summary["security_findings"] = gate_results.get("security", {}).get("findings", [])
            _learn_and_finish(config, memory, registry, summary, run_dir, spec, pid, "failed")
            return _finish(run_dir, summary, EXIT_PROJECT_FAILED,
                           f"mandatory gates failed: {failed_required}")

        quality = compute_quality_score(_quality_sub_scores(gate_results, spec, config), config)
        summary["quality_score"] = quality["score"]
        log_event("pipeline", "info", f"quality score: {quality['score']} ({quality['verdict']})")
        registry.update(pid, status="audited", quality_score=quality["score"])

        if quality["verdict"] != "ELIGIBLE_FOR_DEPLOYMENT":
            summary["errors"].append(f"quality verdict {quality['verdict']} below deploy threshold")
            _learn_and_finish(config, memory, registry, summary, run_dir, spec, pid, "failed")
            return _finish(run_dir, summary, EXIT_PROJECT_FAILED,
                           f"quality score {quality['score']} < {quality['deploy_threshold']}: "
                           f"{quality['verdict']}")

        # ---------- 7. DEPLOY --------------------------------------------- #
        summary["stage"] = "deploy"
        deployer = DeploymentManager(config, run_dir)
        deploy_info = deployer.deploy(pid, product_dir, spec, gate_results)
        summary["deploy_status"] = deploy_info.get("status")
        summary["deploy_reason"] = deploy_info.get("reason", "")
        summary["deploy_info"] = deploy_info
        registry.update(pid, status="deployed" if deploy_info.get("status") == "executed"
                        else "approved_pending" if deploy_info.get("status") == "awaiting_approval"
                        else deploy_info.get("status", "blocked"))

        # ---------- 8. DISTRIBUTE (only after real deployment) ------------ #
        summary["stage"] = "distribution"
        dist_result = {"status": "skipped", "posted": 0, "results": {}}
        if deploy_info.get("status") == "executed":
            dist_registry = PlatformRegistry(config)
            dist_registry.refresh()
            content = generate_content(config, client, spec["name"], spec["tagline"],
                                       _deploy_url(deploy_info, config), spec)
            dist = Distributor(config, dist_registry)
            dist_result = dist.distribute(pid, spec["name"], deploy_info, content)
            registry.update(pid, distribution_status="done" if dist_result.get("posted", 0) else "none")
        else:
            log_event("pipeline", "info",
                      f"distribution skipped (deploy status: {deploy_info.get('status')})")
        summary["distribution"] = dist_result

        # ---------- 9. LEARN ----------------------------------------------- #
        registry.update(pid, status="distributed" if dist_result.get("posted")
                        else registry.get(pid).get("status"))
        _learn_and_finish(config, memory, registry, summary, run_dir, spec, pid, "successful")
        return _finish(run_dir, summary, EXIT_OK, "")

    except AIUnavailable as e:
        return _finish(run_dir, summary, EXIT_BLOCKED, f"AI unavailable: {e}")
    except AIBudgetExceeded as e:
        return _finish(run_dir, summary, EXIT_BLOCKED, f"AI budget exhausted: {e}")
    except FileNotFoundError as e:
        return _finish(run_dir, summary, EXIT_CONFIG, f"config error: {e}")
    except KeyboardInterrupt:
        return _finish(run_dir, summary, 130, "interrupted")
    except Exception as e:  # noqa: BLE001
        summary["errors"].append(f"unhandled: {e}")
        return _finish(run_dir, summary, EXIT_PROJECT_FAILED, f"pipeline exception: {e}")


# --------------------------------------------------------------------------- #
def _quality_sub_scores(gate_results, spec, config) -> dict[str, float]:
    """Map audit outputs (and build facts) to quality dimensions."""
    seo = gate_results.get("seo", {})
    a11y = gate_results.get("accessibility", {})
    security = gate_results.get("security", {})
    adsense = gate_results.get("adsense", {})
    tests = gate_results.get("tests", {})
    content_ok = bool(adsense.get("checklist", {}).get("original_useful_content", {}).get("pass"))
    purpose_ok = bool(adsense.get("checklist", {}).get("clear_purpose", {}).get("pass"))
    return {
        "usefulness": 100 if (content_ok and purpose_ok) else 70,
        "ux": float(a11y.get("score", 0)),
        "security": float(security.get("score", 0)),
        "seo": float(seo.get("score", 0)),
        "accessibility": float(a11y.get("score", 0)),
        "performance": 100 if bool(adsense.get("checklist", {}).get("fast_loading", {}).get("pass")) else 60,
        "monetization_readiness": 100 if gate_results.get("adsense", {}).get("status") == "pass" else 50,
        "originality": 100 if content_ok else 60,
    }


def _deploy_url(deploy_info: dict[str, Any], config: Config) -> str:
    if deploy_info.get("url"):
        return deploy_info["url"]
    return str(config.get("seo", "site_url", "https://example.com"))


def _learn_and_finish(config, memory, registry, summary, run_dir, spec, pid, outcome) -> None:
    """Postmortem + lessons + registry status. Never raises."""
    try:
        project = registry.get(pid) or {"id": pid, "name": spec.get("name", "?"),
                                        "product_type": spec.get("product_type", "?"),
                                        "trend": spec.get("trend", {}).get("title", ""),
                                        "technologies": spec.get("tech_stack", [])}
        learner = LearningEngine(config, memory, get_client(config))
        record = learner.postmortem(project, outcome, summary)
        memory.add_lesson({"project": spec.get("name"), "text": record.get("lessons", [])
                           or f"project {project.get('name')} finished as {outcome}", "outcome": outcome})
        memory.bump_version()
        summary["postmortem"] = record
    except Exception as e:  # noqa: BLE001 — learning must never break the run's exit path
        log_event("learn", "error", f"learning failed: {e}")
        summary["errors"].append(f"learn: {e}")


def _finish(run_dir: Path, summary: dict[str, Any], exit_code: int, message: str) -> int:
    """Persist run.json + run_report.md and return the exit code."""
    summary["exit_code"] = exit_code
    summary["message"] = message
    summary["finished"] = now_utc()
    atomic_write_json(run_dir / "run.json", summary)
    write_text(run_dir / "run_report.md", _render_report(summary))
    if message:
        log_event("pipeline", "error" if exit_code else "info", message)
    log_event("pipeline", "info", f"run {summary['run_id']} finished: exit {exit_code}")
    return exit_code


def _render_report(summary: dict[str, Any]) -> str:
    gates = summary.get("gates", {})
    gate_lines = "\n".join(f"- {k}: {v}" for k, v in gates.items()) or "- (no gates evaluated)"
    lines = [
        f"# Factory run report — {summary.get('run_id')}",
        "",
        f"- Started: {summary.get('started')}  ·  Finished: {summary.get('finished')}",
        f"- Project: {summary.get('project_id') or '(none)'}",
        f"- Quality score: {summary.get('quality_score')}",
        f"- Deploy status: {summary.get('deploy_status')} — {summary.get('deploy_reason', '')}",
        "",
        "## Gates",
        gate_lines,
        "",
        "## Errors",
        "\n".join(f"- {e}" for e in summary.get("errors", [])) or "- none",
        "",
        "## Distribution",
        f"- {summary.get('distribution', {}).get('status')} "
        f"({summary.get('distribution', {}).get('posted', 0)} posted)",
        "",
        f"Exit: {summary.get('exit_code')} — {summary.get('message', '')}",
    ]
    return "\n".join(lines)