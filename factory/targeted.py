"""Targeted execution for a persisted opportunity.

This is the bridge between the lifecycle control plane and the real factory:
build <opportunity-id> plans and builds that exact opportunity, then runs the
same local test/audit gates used by the full pipeline. Deployment remains
approval-gated by the existing DeploymentManager.
"""
from __future__ import annotations

from pathlib import Path
from .ai import get_client
from .build import CodeBuilder
from .config import Config
from .control_plane import ControlPlane
from .logging_setup import bind_run, log_event
from .memory import MemoryStore
from .planning import Planner, save_spec
from .quality.runner import run_audits
from .quality.tests import TestRunner
from .registry import ProjectRegistry
from .utils import gen_id, now_utc, write_text


def build_opportunity(root: Path, opportunity_id: str) -> dict:
    config = Config.load(root=root)
    cp = ControlPlane(root)
    opportunity = cp.get("opportunities", opportunity_id)
    if not opportunity:
        raise ValueError(f"opportunity not found: {opportunity_id}")
    if not opportunity.get("eligible", False):
        raise ValueError(f"opportunity is not eligible: {opportunity_id}")

    run_id = gen_id("run")
    run_dir = config.path("runs_dir") / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    bind_run(run_id, run_dir / "events.jsonl")
    cp.transition("opportunities", opportunity_id, "building", run_id=run_id)

    trend = {
        "title": opportunity.get("title", ""),
        "source": opportunity.get("source", ""),
        "url": opportunity.get("url", ""),
        "summary": opportunity.get("summary", ""),
    }
    scored = {
        "trend": trend,
        "total": opportunity.get("score", 0),
        "scores": opportunity.get("scores", {}),
        "eligible": True,
        "risk_flags": opportunity.get("risk_flags", []),
    }

    client = get_client(config)
    memory = MemoryStore(config.path("memory_dir"))
    planner = Planner(config, client)
    spec = planner.plan(scored, memory.digest())
    save_spec(config, run_dir, spec)

    registry = ProjectRegistry(config.path("registry_file"))
    pid = registry.create({
        "name": spec["name"],
        "trend": spec["trend"]["title"],
        "product_type": spec["product_type"],
        "technologies": spec["tech_stack"],
        "status": "planned",
    })
    product_dir = config.path("products_dir") / pid
    cp.put("projects", pid, {
        "status": "planned",
        "opportunity_id": opportunity_id,
        "name": spec["name"],
        "product_type": spec["product_type"],
        "run_id": run_id,
    })

    builder = CodeBuilder(config, client)
    builder.build(spec, product_dir)
    registry.update(pid, status="built")
    cp.transition("opportunities", opportunity_id, "built", project_id=pid)

    tests = TestRunner(config).run(product_dir, spec)
    if tests.get("status") != "pass":
        registry.update(pid, status="failed")
        cp.transition("projects", pid, "failed", test_result=tests)
        raise RuntimeError(f"tests failed for {pid}: {tests}")

    registry.update(pid, status="tested")
    cp.transition("projects", pid, "tested", test_result=tests)
    gates = run_audits(product_dir, spec, config)
    failed = [name for name, result in gates.items()
              if isinstance(result, dict) and result.get("status") == "fail"]
    if failed:
        registry.update(pid, status="failed")
        cp.transition("projects", pid, "failed", failed_gates=failed)
        raise RuntimeError(f"quality gates failed for {pid}: {failed}")

    registry.update(pid, status="gates_passed")
    cp.transition("projects", pid, "ready_for_launch", gates={k:v.get("status") for k,v in gates.items() if isinstance(v,dict)})
    log_event("lifecycle", "info", f"opportunity {opportunity_id} built as project {pid}")
    return {"status": "ready_for_launch", "opportunity_id": opportunity_id, "project_id": pid,
            "run_id": run_id, "name": spec["name"], "product_type": spec["product_type"]}


def execute(root: Path, command: str, target: str | None = None) -> dict:
    cp = ControlPlane(root)
    cmd = command.lower().strip()
    if cmd == "status":
        return {"status":"ok","opportunities":cp.list("opportunities"),"projects":cp.list("projects")}
    if cmd == "build":
        if not target:
            raise ValueError("build requires an opportunity id")
        return build_opportunity(root, target)
    status = {"investigate":"investigating","test":"testing","launch":"launching","improve":"improving","retire":"retired"}.get(cmd)
    if not status:
        raise ValueError(f"unsupported lifecycle command: {command}")
    if not target:
        raise ValueError(f"{command} requires an opportunity/project id")
    kind = "opportunities" if cmd == "investigate" else "projects"
    if not cp.get(kind, target):
        raise ValueError(f"{kind[:-1]} not found: {target}")
    return cp.transition(kind, target, status, last_command=cmd)
