"""Self-debugging loop.

On test/build failure:

1. Capture the failure output.
2. Ask the AI for a diagnosis + patch suggestion (JSON: files/old/new).
3. Apply the patch ONLY to a copy of the product so the original is never
   corrupted, re-run the failing check, and accept the patch only when it
   actually passes. Rejected patches are recorded (streak grows).
4. Repeat up to ``max_repair_attempts``; after the limit, the project is
   marked failed with the full repair history saved (never hidden).
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable

from ..ai import AIError, AIUnavailable
from ..config import Config
from ..logging_setup import log_event
from ..utils import write_text

DIAGNOSE_PROMPT = """You are the Debugger of an autonomous software factory. A generated
product failed its check. Return a JSON object:
{"diagnosis": "root cause in 1-2 sentences", "patch": {"file": "relative/path.py", "old": "...exact existing snippet...", "new": "...replacement..."} | null}
Rules: the patch must be a minimal exact string replacement in ONE file, fully quoted.
If you cannot determine a safe exact patch, return "patch": null.

Failure output:
{output}

Product files (relative paths): {files}"""


class Debugger:
    def __init__(self, config: Config, client):
        self.config = config
        self.client = client

    def repair(
        self,
        product_dir: Path,
        check: Callable[[], Any],
        failure_context: str,
        max_attempts: int | None = None,
    ) -> dict[str, Any]:
        """Attempt to make ``check()`` return a dict with status == 'pass'.
        ``check`` re-runs the failing gate against the (possibly patched) dir."""
        attempts = max_attempts or self.config.budget("max_repair_attempts", 5)
        history: list[dict[str, Any]] = []
        last = check()
        attempt = 0
        while last.get("status") != "pass" and attempt < attempts:
            attempt += 1
            suggestion = self._ask_ai(last, product_dir)
            history.append({"attempt": attempt, "suggestion": suggestion})
            if suggestion.get("patch"):
                applied = self._try_patch(product_dir, suggestion["patch"], check)
                history[-1]["patch_applied"] = applied.get("applied", False)
                history[-1]["patch_passed"] = applied.get("passed", False)
                if applied.get("passed"):
                    last = {"status": "pass", "score": 100,
                            "details": [f"repaired by AI patch (attempt {attempt})"]}
                    break
                last = applied.get("result") or last
            else:
                log_event("debug", "info", f"attempt {attempt}: AI suggested no safe patch")
                # No patch available: rebuild context may help; give up fast.
                break
        log_event(
            "debug",
            "info",
            f"repair loop finished: {'pass' if last.get('status') == 'pass' else 'fail'} "
            f"after {attempt} attempt(s)",
        )
        return {"status": "pass" if last.get("status") == "pass" else "fail",
                "result": last, "attempts": attempt, "history": history}

    # ---- internals -------------------------------------------------------
    def _ask_ai(self, last: dict[str, Any], product_dir: Path) -> dict[str, Any]:
        files = ", ".join(sorted(str(p.relative_to(product_dir)) for p in product_dir.rglob("*") if p.is_file()))[:1500]
        output = str(last.get("details", ""))[:2500] or str(last)[:2500]
        try:
            return self.client.complete_json(
                user=DIAGNOSE_PROMPT.format(output=output, files=files),
                task="repair_fix",
            )
        except (AIError, AIUnavailable) as e:
            return {"diagnosis": f"AI unavailable: {e}", "patch": None}

    def _try_patch(self, product_dir: Path, patch: dict[str, Any], check: Callable[[], Any]) -> dict[str, Any]:
        """Apply a patch to a COPY; accept only if the check passes there."""
        fname = str(patch.get("file", "")).lstrip("/\\")
        old = patch.get("old") or ""
        new = patch.get("new") or ""
        target = product_dir / fname
        if not target.is_file():
            return {"applied": False, "passed": False, "result": {"status": "fail", "details": [f"patch target missing: {fname}"]}}
        text = target.read_text(encoding="utf-8")
        if old not in text:
            return {"applied": False, "passed": False,
                    "result": {"status": "fail", "details": [f"patch old-string not found in {fname}"]}}
        if new and not (new.strip()):
            return {"applied": False, "passed": False,
                    "result": {"status": "fail", "details": [f"empty patch replacement for {fname}"]}}

        with tempfile.TemporaryDirectory() as tmp:
            copy_dir = Path(tmp) / "product"
            shutil.copytree(product_dir, copy_dir)
            (copy_dir / fname).write_text(text.replace(old, new, 1), encoding="utf-8")
            result = check(copy_dir)
        if isinstance(result, dict) and result.get("status") == "pass":
            target.write_text(text.replace(old, new, 1), encoding="utf-8")
            return {"applied": True, "passed": True, "result": result}
        return {"applied": False, "passed": False, "result": result}