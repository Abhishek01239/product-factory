"""Translate natural-language GitHub issues into safe factory actions.

Supported commands:
  find/discover/trending problems -> trend discovery
  build/create/ship -> full factory run
  test/verify -> offline self-test
  approve <run_id> -> approve a pending run
  reject <run_id> -> reject a pending run
  status -> show recent local factory runs
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
title = os.getenv("ISSUE_TITLE") or ""
body = os.getenv("ISSUE_BODY") or ""
cmd = f"{title} {body}".strip()
low = cmd.lower()


def run(action: list[str]) -> int:
    print("Factory command:", cmd[:500])
    print("Mapped action:", " ".join(action))
    return subprocess.call([sys.executable, str(ROOT / "agent.py"), *action], cwd=ROOT)


def main() -> int:
    # Approval/rejection is explicit and takes precedence over other words.
    m = re.search(r"\b(approve|reject)\s+([A-Za-z0-9._-]+)", low)
    if m:
        verb, run_id = m.group(1), m.group(2)
        return run(["--approve" if verb == "approve" else "--reject", run_id])

    if re.search(r"\bstatus\b", low):
        runs_dir = ROOT / "runs"
        rows = []
        if runs_dir.exists():
            for p in sorted(runs_dir.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
                if p.is_dir() and (p / "run.json").exists():
                    rows.append((p.name, (p / "run.json").read_text(encoding="utf-8")[:1000]))
                if len(rows) >= 10:
                    break
        print("Recent factory runs:")
        if not rows:
            print("  No persisted runs found.")
        else:
            for run_id, raw in rows:
                print(f"  {run_id}: {raw}")
        return 0

    if any(x in low for x in (
        "find problems", "find opportunities", "discover problems",
        "trending problems", "find trends", "discover trends",
        "find today's problems", "find today problems",
    )):
        return run(["--stage", "trends"])

    if any(x in low for x in (
        "build", "make product", "create product", "build product",
        "ship", "launch product",
    )):
        return run(["--run"])

    if "test" in low or "verify" in low or "selftest" in low:
        return run(["--selftest"])

    # Safe default: discovery only. Unknown commands never trigger a build.
    return run(["--stage", "trends"])


if __name__ == "__main__":
    raise SystemExit(main())
