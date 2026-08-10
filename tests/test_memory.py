"""Unit tests: versioned memory store + learning engine."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from factory.learn import LearningEngine
from factory.memory import MemoryStore


class MemoryTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self.store = MemoryStore(Path(self._tmp) / "memory")

    def tearDown(self):
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_versioning(self):
        self.assertEqual(self.store.version, 1)
        self.store.record_project("successful", {"id": "p1", "name": "demo"})
        self.store.add_lesson({"text": "always test", "project": "demo"})
        self.assertEqual(len(self.store.load_projects("successful")), 1)
        self.assertEqual(len(self.store.load_lessons()), 1)
        v = self.store.version
        self.store.bump_version()
        self.assertEqual(self.store.version, v + 1)
        # Old version preserved (rollback safety).
        self.assertTrue((Path(self._tmp) / "memory" / f"v{v}" / "projects" / "successful").exists())

    def test_postmortem_paths(self):
        self.store.record_project("failed", {"id": "f1", "name": "boom"})
        self.assertEqual(len(self.store.load_projects("failed")), 1)

    def test_trend_history(self):
        self.store.append_trend_history([{"title": "t1", "source": "hn"}])
        self.store.append_trend_history([{"title": "t2", "source": "hn"}])
        hist_file = self.store.current_dir() / "trends" / "history.jsonl"
        self.assertTrue(hist_file.exists())
        self.assertEqual(len(hist_file.read_text(encoding="utf-8").strip().splitlines()), 2)


class LearnerTest(unittest.TestCase):
    def test_postmortem_schema(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            memory = MemoryStore(root / "memory")
            learner = LearningEngine(ConfigStub(), memory, client=None)
            record = learner.postmortem(
                {"id": "p1", "name": "demo", "product_type": "static_site",
                 "trend": "json tools", "technologies": ["html"]},
                "successful",
                {"quality_score": 88, "deploy_status": "executed", "errors": []},
            )
            for key in ("project", "architecture", "technologies", "successful_components",
                        "failed_components", "errors", "solutions", "security_findings",
                        "seo_findings", "performance_results", "deployment_result",
                        "lessons", "recommendations_for_future_projects"):
                self.assertIn(key, record)
            self.assertEqual(record["project"], "demo")


class ConfigStub:
    """Minimal Config-like object for the learner (uses .path() only)."""

    def path(self, key: str) -> Path:  # noqa: N802
        return Path(".") / key.replace("_", "-")


if __name__ == "__main__":
    unittest.main()
