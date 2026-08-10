"""Autonomous Product Factory — entry point.

``python agent.py`` performs ONE full factory pass (run-to-completion) and
exits — CI/cron friendly:

    trends -> planning -> build -> tests -> audits -> gates -> deploy -> distribute -> learn

Exit codes:
    0   all good (deployed and/or awaiting approval)
    1   project failed a mandatory gate / build / tests
    2   configuration error
    3   blocked (no API key, no eligible trends, budget exhausted)
    4   tests failed after max repair attempts
    130 interrupted

Options
-------
--config PATH      config file (default: factory.json next to agent.py)
--run              full pipeline (default when no other action given)
--stage NAME       run a single early stage (currently: trends)
--selftest         offline verification suite (no network, no API key)
--dry-run          simulate all deploy/distribute side effects
--mock-ai          force the deterministic offline AI (FACTORY_MOCK_AI=1)
--approve RUN_ID   HUMAN OVERRIDE: approve a pending deployment from a
                   previous run (re-verifies gates, then deploys + distributes)
--reject RUN_ID    HUMAN OVERRIDE: reject a pending project (postmortem saved)
--version          print version
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from factory import __version__  # noqa: E402
from factory.ai import get_client  # noqa: E402
from factory.config import Config  # noqa: E402
from factory.deploy import DeploymentManager  # noqa: E402
from factory.distribute import Distributor, PlatformRegistry  # noqa: E402
from factory.distribute.content import generate_content  # noqa: E402
from factory.logging_setup import bind_run, log_event, setup_logger  # noqa: E402
from factory.learn import LearningEngine  # noqa: E402
from factory.memory import MemoryStore  # noqa: E402
from factory.pipeline import (  # noqa: E402
    EXIT_BLOCKED,
    EXIT_CONFIG,
    EXIT_PROJECT_FAILED,
    run_factory,
)
from factory.quality.runner import run_audits  # noqa: E402
from factory.registry import ProjectRegistry  # noqa: E402
from factory.utils import atomic_write_json, read_json, write_text  # noqa: E402

EXIT_OK = 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="agent.py",
        description="Autonomous Product Factory — run-to-completion product pipeline.",
    )
    p.add_argument("--config", help="path to factory.json")
    p.add_argument("--run", action="store_true", help="run the full pipeline (default)")
    p.add_argument("--stage", metavar="NAME", help="run a single stage (currently: trends)")
    p.add_argument("--selftest", action="store_true", help="run offline verification suite")
    p.add_argument("--dry-run", action="store_true", help="simulate deploy/distribute side effects")
    p.add_argument("--mock-ai", action="store_true", help="force deterministic offline AI")
    p.add_argument("--approve", metavar="RUN_ID", help="approve a pending deployment")
    p.add_argument("--reject", metavar="RUN_ID", help="reject a pending project")
    p.add_argument("--version", action="store_true", help="print version and exit")
    return p


def _load_config(args: argparse.Namespace) -> Config:
    config = Config.load(config_path=args.config, root=ROOT)
    if args.dry_run:
        os.environ.setdefault("FACTORY_DRY_RUN", "1")
        config = Config.load(config_path=args.config, root=ROOT)
    if args.mock_ai:
        os.environ["FACTORY_MOCK_AI"] = "1"
        config = Config.load(config_path=args.config, root=ROOT)
    return config


def _stage_trends(config: Config) -> int:
    from factory.trends import TrendScout, score_opportunities

    setup_logger()
    print("== Trend Scout ==")
    scout = TrendScout(config)
    trends = scout.collect()
    print(f"\n{len(trends)} normalized trends from live public sources.\n")
    opps = score_opportunities(trends, config)
    print("Top opportunities:")
    for i, o in enumerate(opps[:5], 1):
        t = o["trend"]
        print(f"  {i}. [{t.get('source')}] {t.get('title')[:90]}  (score {o['total']})")
        print(f"     {t.get('url', '')}")
    if not opps:
        print("No eligible opportunities this run.")
        return EXIT_BLOCKED
    return EXIT_OK


# --------------------------------------------------------------------------- #
# Human override flow: --approve / --reject                                     #
# --------------------------------------------------------------------------- #
def _approve(config: Config, run_id: str) -> int:
    run_dir = config.path("runs_dir") / run_id
    summary = read_json(run_dir / "run.json")
    if not summary:
        print(f"ERROR: no run state at {run_dir / 'run.json'}")
        return EXIT_CONFIG
    pid = summary.get("project_id")
    if not pid:
        print("ERROR: run has no project id to approve")
        return EXIT_PROJECT_FAILED
    bind_run(run_id, run_dir / "events.jsonl")
    setup_logger()
    log_event("approval", "info", f"human APPROVE for run {run_id}, project {pid}")

    registry = ProjectRegistry(config.path("registry_file"))
    project = registry.get(pid)
    if not project:
        print(f"ERROR: project {pid} not in registry")
        return EXIT_CONFIG
    spec = read_json(run_dir / "spec.json")
    if not spec:
        print("ERROR: spec.json missing for this run")
        return EXIT_CONFIG
    product_dir = config.path("products_dir") / pid

    # Re-verify every gate at approval time (fresh evidence, not stored claims).
    print(f"Re-running audit battery on {product_dir} …")
    gates = run_audits(product_dir, spec, config)
    failed = [g for g, r in gates.items() if isinstance(r, dict) and r.get("status") != "pass"]
    if failed:
        print(f"GATES FAILED at approval time: {failed} — deployment refused. "
              "Fix the product or REJECT the run.")
        return EXIT_PROJECT_FAILED
    print("Gates re-verified: all pass.")

    summary["approval"] = "approved"
    atomic_write_json(run_dir / "run.json", summary)

    deployer = DeploymentManager(config, run_dir)
    deploy_info = deployer.deploy(pid, product_dir, spec, gates)
    print(f"Deploy: {deploy_info.get('status')} — {deploy_info.get('reason', '')}")
    if deploy_info.get("status") == "executed":
        try:
            client = get_client(config)
        except Exception as e:  # noqa: BLE001
            client = None
        dist_reg = PlatformRegistry(config)
        dist_reg.refresh()
        if client is not None:
            content = generate_content(config, client, spec["name"], spec["tagline"],
                                       deploy_info.get("url") or config.get("seo", "site_url"), spec)
            dist = Distributor(config, dist_reg)
            dist_result = dist.distribute(pid, spec["name"], deploy_info, content)
            print(f"Distribution: {dist_result.get('status')} ({dist_result.get('posted', 0)} posted)")
            registry.update(pid, distribution_status="done" if dist_result.get("posted", 0) else "none")
        else:
            print("Distribution: skipped (no AI client — set GROQ_API_KEY for content generation)")
    elif deploy_info.get("status") == "awaiting_approval":
        print("NOTE: still in approval mode — reviewed and re-verified; flip FACTORY_MODE=autonomous "
              "or deploy the bundle manually (see run report).")
    registry.update(pid, status="deployed" if deploy_info.get("status") == "executed"
                    else "approved_pending")
    _record_learning(config, registry, pid, spec, "successful")
    return EXIT_OK


def _reject(config: Config, run_id: str) -> int:
    run_dir = config.path("runs_dir") / run_id
    summary = read_json(run_dir / "run.json")
    if not summary:
        print(f"ERROR: no run state at {run_dir / 'run.json'}")
        return EXIT_CONFIG
    pid = summary.get("project_id")
    registry = ProjectRegistry(config.path("registry_file"))
    if pid:
        registry.update(pid, status="rejected")
        spec = read_json(run_dir / "spec.json") or {}
        _record_learning(config, registry, pid, spec, "failed")
        print(f"Project {pid} marked rejected; postmortem saved to memory.")
    summary["approval"] = "rejected"
    atomic_write_json(run_dir / "run.json", summary)
    return EXIT_OK


def _record_learning(config: Config, registry: ProjectRegistry, pid: str,
                     spec: dict[str, Any], outcome: str) -> None:
    memory = MemoryStore(config.path("memory_dir"))
    project = registry.get(pid) or {}
    learner = LearningEngine(config, memory, get_client(config))
    try:
        learner.postmortem(project, outcome, {"quality_score": project.get("quality_score"),
                                              "deploy_status": outcome})
    except Exception as e:  # noqa: BLE001
        log_event("learn", "warning", f"postmortem skipped: {e}")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.version:
        print(f"Autonomous Product Factory v{__version__}")
        return EXIT_OK

    if args.selftest:
        setup_logger()
        from factory.selftest import run_selftest

        results = run_selftest()
        failed = [r for r in results if not r["ok"]]
        print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
        for r in results:
            mark = "PASS" if r["ok"] else "FAIL"
            print(f"  [{mark}] {r['name']}" + (f"  -> {r['detail']}" if not r["ok"] else ""))
        return EXIT_PROJECT_FAILED if failed else EXIT_OK

    config = _load_config(args)

    if args.stage:
        if args.stage == "trends":
            return _stage_trends(config)
        print(f"ERROR: unknown stage '{args.stage}' (supported: trends)")
        return EXIT_CONFIG

    if args.approve:
        return _approve(config, args.approve)
    if args.reject:
        return _reject(config, args.reject)

    setup_logger()
    log_event("cli", "info", f"factory v{__version__} starting (mock_ai={config.mock_ai})")
    return run_factory(config)


if __name__ == "__main__":
    sys.exit(main())