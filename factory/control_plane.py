"""Local durable control plane for opportunities and product lifecycle state."""
from __future__ import annotations
import json, time
from pathlib import Path
from typing import Any

class ControlPlane:
    def __init__(self, root: Path):
        self.root = root
        self.dir = root / "data" / "control_plane"
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, kind: str, ident: str) -> Path:
        return self.dir / kind / f"{ident}.json"

    def put(self, kind: str, ident: str, data: dict[str, Any]) -> dict[str, Any]:
        p = self._path(kind, ident)
        p.parent.mkdir(parents=True, exist_ok=True)
        payload = dict(data)
        payload["id"] = ident
        payload["updated_at"] = int(time.time())
        p.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        return payload

    def get(self, kind: str, ident: str) -> dict[str, Any] | None:
        p = self._path(kind, ident)
        if not p.exists():
            return None
        return json.loads(p.read_text(encoding="utf-8"))

    def list(self, kind: str) -> list[dict[str, Any]]:
        d = self.dir / kind
        if not d.exists():
            return []
        out = []
        for p in sorted(d.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try: out.append(json.loads(p.read_text(encoding="utf-8")))
            except json.JSONDecodeError: continue
        return out

    def transition(self, kind: str, ident: str, status: str, **extra: Any) -> dict[str, Any]:
        current = self.get(kind, ident) or {}
        current.update(extra)
        current["status"] = status
        return self.put(kind, ident, current)
