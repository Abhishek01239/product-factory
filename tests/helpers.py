"""Shared fixtures for the test suite."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from factory.ai import MockAIClient
from factory.build import CodeBuilder
from factory.config import Config

CANNED_SPEC = {
    "name": "Test Utility",
    "tagline": "A deterministic test product for offline verification.",
    "problem": "Prove the factory pipeline works without network access.",
    "users": "engineers",
    "product_type": "static_site",
    "features": [{"name": "JSON formatter", "description": "Pretty-print JSON text."}],
    "pages": ["home", "about", "contact", "privacy", "terms", "disclaimer"],
    "monetization_model": "none",
    "tech_stack": ["python", "html", "css"],
    "risks": [],
    "trend": {"title": "test", "url": "https://example.test", "source": "test"},
}


class TempWorkspace:
    """Context manager: temp dir + config + mock client + built product."""

    def __init__(self, build: bool = True) -> None:
        self._tmp: Path | None = None
        self.build_product = build

    def __enter__(self) -> "TempWorkspace":
        self._tmp = Path(tempfile.mkdtemp(prefix="factory-test-"))
        self.config = Config.load(root=self._tmp)
        self.client = MockAIClient(self.config)
        self.product_dir = self._tmp / "product"
        if self.build_product:
            CodeBuilder(self.config, self.client).build(CANNED_SPEC, self.product_dir)
        return self

    def __exit__(self, *exc) -> None:  # noqa: ANN002
        if self._tmp:
            shutil.rmtree(self._tmp, ignore_errors=True)
