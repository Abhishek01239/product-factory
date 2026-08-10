"""Unit tests: distribution capability registry (offline) + AI client gate."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from factory.ai import get_client
from factory.config import Config
from factory.distribute import PlatformRegistry


class DistributionRegistryTest(unittest.TestCase):
    def test_capabilities_refresh_offline(self):
        with tempfile.TemporaryDirectory() as td:
            reg = PlatformRegistry(Config.load(root=Path(td)))
            reg.refresh()
            caps = reg.state["capabilities"]
            for platform in ("telegram", "devto", "discord", "bluesky", "mastodon",
                             "reddit", "github", "x", "linkedin", "youtube"):
                self.assertIn(platform, caps, f"missing {platform} in registry")
                entry = caps[platform]
                self.assertIn("credentials_configured", entry)
                self.assertIn("api_available", entry)
            # With no credentials set, nothing is active.
            os.environ.pop("TELEGRAM_BOT_TOKEN", None)
            self.assertEqual(reg.active_platforms(), [])

    def test_state_persists(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = Config.load(root=Path(td))
            reg = PlatformRegistry(cfg)
            reg.refresh()
            reg.state["capabilities"]["telegram"]["last_success"] = "2026-01-01"
            reg._save()
            reg2 = PlatformRegistry(cfg)
            reg2.load()
            self.assertEqual(reg2.state["capabilities"]["telegram"]["last_success"], "2026-01-01")


class AIClientGateTest(unittest.TestCase):
    def test_no_key_raises(self):
        os.environ.pop("GROQ_API_KEY", None)
        os.environ.pop("FACTORY_MOCK_AI", None)
        with tempfile.TemporaryDirectory() as td:
            cfg = Config.load(root=Path(td))
            with self.assertRaises(Exception) as ctx:
                get_client(cfg)
            self.assertEqual(type(ctx.exception).__name__, "AIUnavailable")

    def test_mock_ai_works_without_key(self):
        os.environ.pop("GROQ_API_KEY", None)
        os.environ["FACTORY_MOCK_AI"] = "1"
        try:
            with tempfile.TemporaryDirectory() as td:
                cfg = Config.load(root=Path(td))
                client = get_client(cfg)
                self.assertEqual(client.complete_json(task="plan_spec", user="x")["name"], "Dev Toolbox")
        finally:
            del os.environ["FACTORY_MOCK_AI"]


if __name__ == "__main__":
    unittest.main()
