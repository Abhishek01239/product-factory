"""Command-driven lifecycle operations over the Product Factory control plane."""
from __future__ import annotations
import re
from pathlib import Path
from .control_plane import ControlPlane

COMMANDS = {"investigate":"investigating","build":"building","test":"testing","launch":"launching","improve":"improving","retire":"retired"}

def execute(root: Path, command: str, target: str | None = None) -> dict:
    cp = ControlPlane(root)
    cmd = command.lower().strip()
    status = COMMANDS.get(cmd)
    if cmd == "status":
        return {"status":"ok","opportunities":cp.list("opportunities"),"projects":cp.list("projects")}
    if not status:
        raise ValueError(f"unsupported lifecycle command: {command}")
    if not target:
        raise ValueError(f"{command} requires an opportunity/project id")
    kind = "projects" if cmd in {"build","test","launch","improve","retire"} else "opportunities"
    if not cp.get(kind, target):
        cp.put(kind, target, {"status":"discovered" if kind=="opportunities" else "planned"})
    return cp.transition(kind, target, status, last_command=cmd)
