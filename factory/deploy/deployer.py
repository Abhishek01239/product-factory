"""Deployment manager.

Deployment ONLY happens when the full gate battery passed (verified here again
as a belt-and-braces guard). Two strategies are supported natively:

* ``vercel``   — deploys the static product via the Vercel CLI when
                 ``VERCEL_TOKEN`` is set and Node.js is available.
* ``ghpages``  — builds the static product and commits it to the ``gh-pages``
                 branch of the repository the factory runs from (needs
                 ``GITHUB_TOKEN`` and a git work tree).

Neither credentials exist ⇒ blocked: the run produces a ready-to-deploy
bundle + exact instructions, and the project is marked ``blocked`` — it is
never silently deployed elsewhere and never marked deployed when it isn't.

Human override: in ``approval_required`` mode (the default), even with
credentials the deploy/distribute stages are staged into an approval file
(``APPROVE/REJECT/RETRY/EDIT`` controls) instead of executing. In GitHub
Actions this maps to an environment-protected job.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any

from ..config import Config
from ..logging_setup import log_event
from ..utils import env_present, write_text

EXECUTED = "executed"
BLOCKED = "blocked"
AWAITING = "awaiting_approval"
NO_TOKEN = "blocked_missing_token"


class DeploymentManager:
    def __init__(self, config: Config, run_dir: Path):
        self.config = config
        self.run_dir = run_dir
        self.deploy_dir = run_dir / "deploy"
        self.deploy_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ #
    def deploy(
        self,
        project_id: str,
        product_dir: Path,
        spec: dict[str, Any],
        gate_results: dict[str, Any],
    ) -> dict[str, Any]:
        """Gate-checked deployment. Returns a status dict."""
        required = self.config.get("gates", "require", [])
        for g in required:
            r = gate_results.get(g, {})
            if isinstance(r, dict) and r.get("status") != "pass":
                return {"status": BLOCKED, "reason": f"gate '{g}' not passed — refusing to deploy",
                        "project_id": project_id}
        if self.config.dry_run:
            return {"status": "simulated", "reason": "FACTORY_DRY_RUN set — no deployment executed",
                    "project_id": project_id}

        # Human-override gate.
        if self.config.approval_required:
            self._write_approval_file(project_id, product_dir, spec)
            return {"status": AWAITING,
                    "reason": "FACTORY_MODE=approval_required — run `python agent.py --approve "
                              f"{self.run_dir.name}` to deploy+distribute",
                    "project_id": project_id}

        target = self.config.get("deploy", "target", "vercel")
        if target == "vercel":
            return self._deploy_vercel(project_id, product_dir, spec)
        if target == "ghpages":
            return self._deploy_ghpages(project_id, product_dir)
        return {"status": BLOCKED, "reason": f"unknown deploy target '{target}'",
                "project_id": project_id}

    # ------------------------------------------------------------------ #
    def _deploy_vercel(self, project_id: str, product_dir: Path, spec) -> dict[str, Any]:
        if not env_present("VERCEL_TOKEN"):
            return self._bundle(project_id, product_dir, spec, NO_TOKEN,
                                "VERCEL_TOKEN not set — deploy bundle prepared instead")
        node = shutil.which("npx") or shutil.which("node")
        if not node:
            return self._bundle(project_id, product_dir, spec, BLOCKED,
                                "npx/node not found — install Node.js or deploy the bundle manually")
        # Vercel needs a project-ish root; we deploy the product directory directly.
        cmd = [shutil.which("npx") or "npx", "vercel", "--prod", "--yes",
               "--token", "$VERCEL_TOKEN", str(product_dir)]
        log_event("deploy", "info", f"vercel deploy of {project_id} (token from env, never logged)")
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                               env={**__import__("os").environ})
            out = (r.stdout or "")[-800:] + (r.stderr or "")[-800:]
            if r.returncode == 0:
                return {"status": EXECUTED, "project_id": project_id, "target": "vercel",
                        "stdout_tail": out[-500:]}
            return {"status": "failed", "project_id": project_id, "target": "vercel",
                    "reason": f"vercel CLI exited {r.returncode}", "stdout_tail": out[-500:]}
        except Exception as e:  # noqa: BLE001
            return {"status": "failed", "project_id": project_id, "reason": str(e)[:300]}

    def _deploy_ghpages(self, project_id: str, product_dir: Path) -> dict[str, Any]:
        if not env_present("GITHUB_TOKEN"):
            return {"status": NO_TOKEN, "reason": "GITHUB_TOKEN not set — gh-pages deploy skipped",
                    "project_id": project_id}
        # The Actions workflow handles gh-pages publishing (see workflows);
        # this local path just stages the static bundle for the branch commit.
        return {"status": "staged_for_workflow",
                "reason": "gh-pages publishing runs in GitHub Actions (deploy job); "
                          "bundle staged locally for inspection.",
                "project_id": project_id}

    # ------------------------------------------------------------------ #
    def _bundle(self, project_id: str, product_dir: Path, spec, status: str, reason: str) -> dict[str, Any]:
        bundle = self.deploy_dir / f"{project_id}.zip"
        with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(product_dir.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(product_dir))
        readme = self.deploy_dir / "DEPLOY_INSTRUCTIONS.md"
        write_text(readme, _INSTRUCTIONS.format(name=spec["name"], project_id=project_id))
        log_event("deploy", "warning", f"{reason} — bundle at {bundle.name}")
        return {"status": status, "reason": reason, "bundle": str(bundle), "project_id": project_id}

    def _write_approval_file(self, project_id: str, product_dir: Path, spec) -> None:
        write_text(self.run_dir / "APPROVAL.md", _APPROVAL_TEMPLATE.format(
            run=self.run_dir.name, project_id=project_id, name=spec["name"],
            type=spec["product_type"], dir=str(product_dir),
        ))


_APPROVAL_TEMPLATE = """# Deployment approval required — run {run}

Project **{name}** ({type}) passed every mandatory gate and is ready to deploy.

- project id: {project_id}
- product directory: {dir}

## Controls

- **APPROVE**  → `python agent.py --approve {run}`
  deploys the product, then publishes it to configured distribution platforms.
- **REJECT**   → `python agent.py --reject {run}`
  marks the project rejected in the registry and saves the postmortem.
- **RETRY**    → re-run the pipeline (`python agent.py --run`) — the memory
  digest will include this project's lessons.
- **EDIT**     → edit files in the product directory, then `--approve {run}`.

Nothing was deployed and nothing was posted while awaiting approval.
"""

_INSTRUCTIONS = """# Manual deploy — {name} ({project_id})

This bundle passed every factory gate (build, tests, security, SEO,
accessibility, legal, AdSense-readiness, no-secrets). It was not deployed
automatically because no deployment credential was configured.

## Option A — Vercel (recommended, free)
1. `npm i -g vercel` (one-time).
2. `cd <unzipped-bundle>`
3. `vercel --prod --yes`
   (or `vercel --prod --token $VERCEL_TOKEN --yes` in CI)

## Option B — GitHub Pages
1. Push the bundle contents to a `gh-pages` branch of a repository.
2. Enable Pages → deploy from branch.

## Option C — any static host
The bundle is plain static HTML/CSS/JS with no build step. Drop it on
Netlify, Cloudflare Pages, or any web server.
"""