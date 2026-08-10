"""Unit tests: builder output, test runner, debugger repair loop."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from factory.ai import MockAIClient
from factory.build import CodeBuilder
from factory.config import Config
from factory.quality.debugger import Debugger
from factory.quality.tests import TestRunner
from tests.helpers import CANNED_SPEC, TempWorkspace


class BuilderTest(unittest.TestCase):
    def test_static_site_complete(self):
        with TempWorkspace() as ws:
            for need in ("index.html", "about.html", "contact.html", "privacy.html",
                         "terms.html", "disclaimer.html", "robots.txt", "sitemap.xml",
                         "favicon.svg"):
                self.assertTrue((ws.product_dir / need).exists(), f"missing {need}")
            blob = "".join(p.read_text(encoding="utf-8") for p in ws.product_dir.glob("*.html")).lower()
            self.assertNotIn("todo", blob)
            self.assertNotIn("lorem", blob)

    def test_tool_page_has_ui(self):
        with TempWorkspace() as ws:
            tool = (ws.product_dir / "json-formatter.html").read_text(encoding="utf-8")
            self.assertIn("tool-input", tool)
            self.assertIn("runOutput", tool)

    def test_webapp_scaffold(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            out = root / "app"
            spec = dict(CANNED_SPEC)
            spec["product_type"] = "webapp"
            CodeBuilder(Config.load(root=root), MockAIClient(Config.load(root=root))).build(spec, out)
            self.assertTrue((out / "app.py").exists())
            self.assertTrue((out / "requirements.txt").exists())
            self.assertTrue((out / "test_app.py").exists())


class TestRunnerTest(unittest.TestCase):
    def test_static_passes(self):
        with TempWorkspace() as ws:
            result = TestRunner(ws.config).run(ws.product_dir, CANNED_SPEC)
            self.assertEqual(result["status"], "pass", str(result.get("details"))[:200])


class DebuggerTest(unittest.TestCase):
    def test_invalid_patch_rejected(self):
        with TempWorkspace() as ws:
            d = Debugger(ws.config, ws.client)

            def always_fail(_dir=None):
                return {"status": "fail", "score": 0, "details": ["boom"]}

            r = d._try_patch(ws.product_dir, {"file": "missing.html", "old": "x", "new": "y"}, always_fail)
            self.assertFalse(r["applied"])
            r2 = d._try_patch(ws.product_dir, {"file": "index.html", "old": "NO_SUCH_STRING",
                                               "new": "y"}, always_fail)
            self.assertFalse(r2["applied"])

    def test_valid_patch_applied_and_verified(self):
        with TempWorkspace() as ws:
            d = Debugger(ws.config, ws.client)
            target = ws.product_dir / "index.html"
            original = target.read_text(encoding="utf-8")

            def pass_when_patched(copy_dir: Path):
                ok = "data-test-patched" in (copy_dir / "index.html").read_text(encoding="utf-8")
                return {"status": "pass" if ok else "fail", "score": 100 if ok else 0, "details": []}

            r = d._try_patch(ws.product_dir, {"file": "index.html", "old": "<nav>",
                                              "new": "<nav data-test-patched='1'>"}, pass_when_patched)
            self.assertTrue(r["applied"])
            self.assertTrue(r["passed"])
            self.assertIn("data-test-patched", target.read_text(encoding="utf-8"))
            target.write_text(original, encoding="utf-8")  # restore


if __name__ == "__main__":
    unittest.main()
