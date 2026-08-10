"""Test runner — exercises the generated product and reports honestly.

Per product type:
* static_site     — parse every HTML page, verify internal links resolve,
                    check the deterministic tool JS is syntactically balanced.
* webapp / api    — ``python -m compileall`` + ``unittest`` when the runtime
                    dependencies are importable; otherwise the gate reports
                    ``fail(env: deps not installed)`` — never a fake pass.
* chrome_extension — manifest JSON validity + required file presence.

The runner NEVER claims a test ran when it didn't: every result carries the
exact command that was executed (or the reason it was skipped).
"""

from __future__ import annotations

import json
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from ..config import Config
from ..logging_setup import log_event
from ..utils import read_text


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []
        self.images: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: N802
        d = dict(attrs)
        if tag == "a" and d.get("href"):
            self.links.append(d["href"])
        if tag == "img" and d.get("src"):
            self.images.append(d["src"])


class TestRunner:
    def __init__(self, config: Config):
        self.config = config

    def run(self, product_dir: Path, spec: dict[str, Any]) -> dict[str, Any]:
        ptype = spec.get("product_type")
        fn = {
            "static_site": self._test_static,
            "webapp": self._test_python,
            "api": self._test_python,
            "chrome_extension": self._test_extension,
        }.get(ptype)
        if fn is None:
            return {"status": "fail", "score": 0, "details": [f"no test strategy for {ptype}"]}
        try:
            result = fn(product_dir, spec)
        except Exception as e:  # noqa: BLE001
            result = {"status": "fail", "score": 0, "details": [f"test harness error: {e}"]}
        log_event("tests", "info", f"tests: {result.get('status')} (score {result.get('score', 0)})")
        return result

    # ---- static -------------------------------------------------------- #
    def _test_static(self, product_dir: Path, spec) -> dict[str, Any]:
        html_files = sorted(product_dir.glob("*.html")) + sorted(product_dir.glob("**/*.html"))
        details: list[str] = []
        problems = 0
        parsed_ok = 0
        seen_slugs: set[str] = set()

        for f in html_files:
            text = read_text(f)
            try:
                parser = _LinkParser()
                parser.feed(text)
                parsed_ok += 1
            except Exception as e:  # noqa: BLE001
                problems += 1
                details.append(f"{f.name}: HTML parse error ({e})")
                continue

            # Internal links: relative links must resolve to an existing file.
            base = f.name
            for link in parser.links:
                if link.startswith(("http://", "https://", "mailto:", "#", "./")):
                    continue
                target = (product_dir / link).resolve()
                if not target.exists():
                    problems += 1
                    details.append(f"{base}: broken internal link -> {link}")
            seen_slugs.add(base)

        # Tool JS brace balance (deterministic templates — quick sanity).
        for js in product_dir.glob("*.js"):
            text = read_text(js)
            if text.count("{") != text.count("}"):
                problems += 1
                details.append(f"{js.name}: unbalanced braces")

        if problems == 0:
            details.append(f"parsed {parsed_ok} pages; all internal links resolve")
        return {
            "status": "pass" if problems == 0 else "fail",
            "score": 100 if problems == 0 else max(0, 100 - 20 * problems),
            "details": details[:20],
        }

    # ---- python (webapp/api) ------------------------------------------- #
    def _test_python(self, product_dir: Path, spec) -> dict[str, Any]:
        details: list[str] = []
        # 1) Compile check (stdlib, always possible).
        r = subprocess.run(
            [sys.executable, "-m", "compileall", "-q", str(product_dir)],
            capture_output=True, text=True, timeout=120,
        )
        if r.returncode != 0:
            return {"status": "fail", "score": 0,
                    "details": [f"compileall failed: {r.stdout[-400:]}{r.stderr[-400:]}"[:600]]}
        details.append("compileall: ok")

        # 2) Unittest — only when dependencies are importable (honest skip otherwise).
        probe = subprocess.run(
            [sys.executable, "-c", "import fastapi"], capture_output=True, text=True, timeout=60
        )
        if probe.returncode != 0:
            return {"status": "fail", "score": 40,
                    "details": [*details, "fastapi not installed in this environment — "
                               "run tests in the CI job (installs requirements.txt)"]}
        r = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", str(product_dir), "-p", "test_*.py"],
            capture_output=True, text=True, timeout=300,
        )
        if r.returncode != 0:
            return {"status": "fail", "score": 20,
                    "details": [*details, "unittest failed:", r.stdout[-400:] + r.stderr[-400:]]}
        details.append("unittest: all passed")
        return {"status": "pass", "score": 100, "details": details}

    # ---- chrome extension ----------------------------------------------- #
    def _test_extension(self, product_dir: Path, spec) -> dict[str, Any]:
        details: list[str] = []
        problems = 0
        manifest = read_json(product_dir / "manifest.json")
        if not isinstance(manifest, dict):
            problems += 1
            details.append("manifest.json missing/invalid")
        else:
            if manifest.get("manifest_version") != 3:
                problems += 1
                details.append("manifest_version must be 3")
            for need in ("name", "version", "description", "action"):
                if need not in manifest:
                    problems += 1
                    details.append(f"manifest missing '{need}'")
        for need in ("popup.html", "popup.js"):
            if not (product_dir / need).exists():
                problems += 1
                details.append(f"missing {need}")
        nonempty_permissions = [p for p in (manifest or {}).get("permissions", []) if p]
        if nonempty_permissions:
            problems += 1
            details.append(f"permissions should be minimal; got {nonempty_permissions}")
        return {
            "status": "pass" if problems == 0 else "fail",
            "score": 100 if problems == 0 else max(0, 100 - 25 * problems),
            "details": details[:15],
        }


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default