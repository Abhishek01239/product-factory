"""Unit tests: config, redaction, registry, scoring."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from factory.config import Config
from factory.registry import ProjectRegistry
from factory.trends.scoring import score_trend
from factory.utils import redact, slugify


class ConfigTest(unittest.TestCase):
    def test_defaults(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = Config.load(root=Path(td))
            self.assertEqual(cfg.mode, "approval_required")  # safe default
            self.assertGreaterEqual(cfg.budget("max_ai_requests", 0), 1)
            self.assertIn("security", cfg.get("gates", "require", []))

    def test_env_override(self):
        import os

        os.environ["FACTORY_MAX_AI_REQUESTS"] = "7"
        try:
            with tempfile.TemporaryDirectory() as td:
                cfg = Config.load(root=Path(td))
                self.assertEqual(cfg.budget("max_ai_requests", 0), 7)
        finally:
            del os.environ["FACTORY_MAX_AI_REQUESTS"]


class RedactTest(unittest.TestCase):
    def test_key_value_redacted(self):
        self.assertNotIn("sk-abc123", redact("key=sk-abc123"))
        self.assertNotIn("abcd1234xy", redact("Authorization: Bearer abcd1234xy"))

    def test_plain_text_survives(self):
        self.assertIn("build a tool", redact("today we build a tool"))


class SlugTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Hello World!"), "hello-world")

    def test_fallback(self):
        self.assertEqual(slugify("!!!", "fb"), "fb")


class RegistryTest(unittest.TestCase):
    def test_crud(self):
        with tempfile.TemporaryDirectory() as td:
            reg = ProjectRegistry(Path(td) / "projects.json")
            pid = reg.create({"name": "n", "trend": "t", "product_type": "static_site"})
            self.assertEqual(reg.get(pid)["status"], "trend_selected")
            reg.update(pid, status="deployed", quality_score=95)
            self.assertEqual(reg.get(pid)["quality_score"], 95)
            reg.add_lesson(pid, "a lesson")
            self.assertIn("a lesson", reg.get(pid)["lessons"])
            self.assertEqual(reg.list(), [reg.get(pid)])


class ScoringTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self.config = Config.load(root=Path(self._tmp))

    def tearDown(self):
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_forbidden_content_suppressed(self):
        bad = score_trend({"title": "buy followers and crack accounts", "score_0_100": 99}, self.config)
        self.assertFalse(bad["eligible"])

    def test_legit_tool_eligible(self):
        good = score_trend({"title": "free json formatter tool", "score_0_100": 60}, self.config)
        self.assertTrue(good["eligible"])

    def test_low_score_flagged_not_blocked(self):
        # A weak but legal trend is a *selection* concern, not a safety block:
        # eligible stays True, but it's flagged below the min-score floor so the
        # pipeline logs the heuristic rather than silently starving.
        low = score_trend({"title": "organization roundtable discussion", "score_0_100": 10}, self.config)
        self.assertTrue(low["eligible"])      # safety gate: legal & clean
        self.assertFalse(low["meets_min_score"])
        self.assertLess(low["total"], 45)


if __name__ == "__main__":
    unittest.main()
