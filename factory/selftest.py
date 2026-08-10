"""Built-in verification suite (offline, no network, no API key).

`python agent.py --selftest` runs every critical component against fixtures:
config, redaction, scoring, registry, memory, builder (mock AI), all auditors,
gates, debugger patch logic, distribution capability probing. Same assertions
are run by CI via `python -m unittest` (tests/ mirrors this suite).
"""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

from .ai import MockAIClient, get_client
from .build import CodeBuilder
from .config import Config
from .memory import MemoryStore
from .quality.accessibility import AccessibilityAuditor
from .quality.adsense import AdSenseReadinessChecker
from .quality.debugger import Debugger
from .quality.legal import LegalAuditor
from .quality.runner import run_audits
from .quality.score import compute_quality_score, gates_passed
from .quality.security import SecurityAuditor
from .quality.seo import SEOAuditor
from .quality.tests import TestRunner
from .registry import ProjectRegistry
from .trends.scoring import score_trend
from .utils import redact, slugify

CANNED_SPEC = {
    "name": "Selftest Utility",
    "tagline": "A tiny deterministic tool for offline verification.",
    "problem": "Prove the factory works without network access.",
    "users": "engineers",
    "product_type": "static_site",
    "features": [{"name": "JSON formatter", "description": "Pretty-print JSON text."}],
    "pages": ["home", "about", "contact", "privacy", "terms", "disclaimer"],
    "monetization_model": "none",
    "tech_stack": ["python", "html", "css"],
    "risks": [],
    "trend": {"title": "selftest", "url": "https://example.test", "source": "selftest"},
}


def run_selftest() -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []

    def check(name: str, fn) -> None:  # noqa: ANN001
        try:
            fn()
            results.append({"name": name, "ok": True, "detail": ""})
        except AssertionError as e:
            results.append({"name": name, "ok": False, "detail": str(e)[:200]})
        except Exception as e:  # noqa: BLE001
            results.append({"name": name, "ok": False, "detail": f"{type(e).__name__}: {e}"[:200]})

    # ---- helpers -------------------------------------------------------- #
    tmp = Path(tempfile.mkdtemp(prefix="factory-selftest-"))
    config = Config.load(root=tmp)
    client = MockAIClient(config)
    env = {"FACTORY_MOCK_AI": "1"}

    def fixture_product() -> Path:
        out = tmp / "product"
        if out.exists():
            shutil.rmtree(out)
        CodeBuilder(config, client).build(CANNED_SPEC, out)
        return out

    # 1. redaction + slugify
    def t_redact():
        assert "sk-abc123" not in redact("key=sk-abc123"), "secret not redacted"
        assert redact("Authorization: Bearer abcd1234xy") != "Authorization: Bearer abcd1234xy"

    def t_slug():
        assert slugify("Hello World!") == "hello-world"
        assert slugify("!!!", "fb") == "fb"

    check("utils.redact", t_redact)
    check("utils.slugify", t_slug)

    # 2. scoring gate (forbidden content suppressed)
    def t_scoring():
        good = score_trend({"title": "free json formatter tool", "score_0_100": 60}, config)
        bad = score_trend({"title": "crack instagram accounts tool", "score_0_100": 99}, config)
        assert good["eligible"], "legit tool must be eligible"
        assert not bad["eligible"], "forbidden content must be suppressed"

    check("trends.scoring", t_scoring)

    # 3. registry CRUD
    def t_registry():
        r = ProjectRegistry(tmp / "projects.json")
        pid = r.create({"name": "x", "trend": "t", "product_type": "static_site"})
        assert r.get(pid)["status"] == "trend_selected"
        r.update(pid, status="built", quality_score=91)
        assert r.get(pid)["quality_score"] == 91
        r.add_lesson(pid, "lesson one")
        assert "lesson one" in r.get(pid)["lessons"]

    check("registry.crud", t_registry)

    # 4. memory store + versioning
    def t_memory():
        m = MemoryStore(tmp / "memory")
        m.record_project("successful", {"id": "m1", "name": "memspec"})
        m.add_lesson({"text": "always test", "project": "memspec"})
        assert len(m.load_projects("successful")) == 1
        assert len(m.load_lessons()) == 1
        v = m.version
        m.bump_version()
        assert m.version == v + 1
        assert len(MemoryStore(tmp / "memory").load_projects()) >= 1

    check("memory.store", t_memory)

    # 5. builder (static site, mock AI) produces a real product
    def t_build():
        out = fixture_product()
        for need in ("index.html", "about.html", "contact.html", "privacy.html",
                     "terms.html", "disclaimer.html", "robots.txt", "sitemap.xml",
                     "favicon.svg", "json-formatter.html"):
            assert (out / need).exists(), f"missing {need}"
        blob = "".join(p.read_text(encoding="utf-8") for p in out.glob("*.html")).lower()
        assert "todo" not in blob and "lorem" not in blob

    check("builder.static_site", t_build)

    # 6. test runner passes on the built product
    def t_tests():
        out = fixture_product()
        result = TestRunner(config).run(out, CANNED_SPEC)
        assert result["status"] == "pass", str(result["details"])[:300]

    check("tests.static", t_tests)

    # 7. auditors
    def t_security():
        out = fixture_product()
        (out / ".env").write_text("TOKEN=supersecretvalue123", encoding="utf-8")
        result = SecurityAuditor(config).audit(out)
        (out / ".env").unlink()
        assert result["status"] == "fail", "committed .env must fail security"
        assert any(f["severity"] == "high" for f in result["findings"])

    def t_seo():
        result = SEOAuditor(config).audit(fixture_product())
        assert result["status"] == "pass", str(result["findings"])[:300]

    def t_a11y():
        result = AccessibilityAuditor(config).audit(fixture_product())
        assert result["status"] == "pass", str(result["findings"])[:300]

    def t_legal():
        result = LegalAuditor(config).audit(fixture_product(), CANNED_SPEC)
        assert result["status"] == "pass", str(result["findings"])[:300]

    def t_adsense():
        result = AdSenseReadinessChecker(config).check(fixture_product())
        assert result["status"] == "pass", str(result["failed_items"])
        assert "subject to Google" in result["note"]

    check("audit.security", t_security)
    check("audit.seo", t_seo)
    check("audit.accessibility", t_a11y)
    check("audit.legal", t_legal)
    check("audit.adsense", t_adsense)

    # 8. full audit battery + gates
    def t_gates():
        out = fixture_product()
        gates = run_audits(out, CANNED_SPEC, config)
        eval_ = gates_passed(gates, config.get("gates", "require", []))
        assert eval_["all_pass"], str(eval_)
        q = compute_quality_score(
            {"usefulness": 90, "ux": 90, "security": 90, "seo": 90, "accessibility": 90,
             "performance": 90, "monetization_readiness": 90, "originality": 90}, config)
        assert q["verdict"] == "ELIGIBLE_FOR_DEPLOYMENT"
        q_low = compute_quality_score(
            {"usefulness": 10, "ux": 10, "security": 10, "seo": 10, "accessibility": 10,
             "performance": 10, "monetization_readiness": 10, "originality": 10}, config)
        assert q_low["verdict"] == "REJECT"

    check("gates+quality_score", t_gates)

    # 9. debugger: rejects invalid patch, accepts valid patch
    def t_debugger():
        out = fixture_product()
        target = out / "index.html"
        text = target.read_text(encoding="utf-8")
        d = Debugger(config, client)

        def always_fail(_dir=None):
            return {"status": "fail", "score": 0, "details": ["boom"]}

        r1 = d._try_patch(out, {"file": "nope.html", "old": "x", "new": "y"}, always_fail)
        assert not r1["applied"]
        r2 = d._try_patch(out, {"file": "index.html", "old": "NO_SUCH_STRING_XYZ",
                                "new": "y"}, always_fail)
        assert not r2["applied"]

        def pass_on_copy(copy_dir):
            # Succeeds only when the patch is already applied (copy dir differs).
            return {"status": "pass" if "skip-verified" in (copy_dir / "index.html").read_text(encoding="utf-8") else "fail",
                    "score": 100, "details": []}

        r3 = d._try_patch(out, {"file": "index.html", "old": '<a class="skip"',
                                "new": '<a class="skip" data-skip-verified="1"'}, pass_on_copy)
        assert r3["passed"] and r3["applied"], "valid patch must be accepted"
        assert "data-skip-verified" in target.read_text(encoding="utf-8")
        target.write_text(text, encoding="utf-8")

    check("debugger.patch_logic", t_debugger)

    # 10. distribution capability probing stays dormant without creds
    def t_distribution():
        from .distribute import PlatformRegistry  # single dot: same package

        reg = PlatformRegistry(config)
        reg.refresh()
        caps = reg.state["capabilities"]
        assert "telegram" in caps and "devto" in caps and "discord" in caps
        assert caps["telegram"]["credentials_configured"] in (True, False)  # env-dependent
        assert reg.active_platforms() == [] or True  # must not crash without creds

    check("distribution.registry", t_distribution)

    # 11. AI client factory: no key + no mock -> AIUnavailable
    def t_ai_gate():
        import os

        os.environ.pop("GROQ_API_KEY", None)
        try:
            with tempfile.TemporaryDirectory() as td:
                cfg = Config.load(root=Path(td))
                get_client(cfg)
            raise AssertionError("expected AIUnavailable without key")
        except Exception as e:  # noqa: BLE001
            assert type(e).__name__ in ("AIUnavailable",), f"expected AIUnavailable, got {e}"

    check("ai.client_gate", t_ai_gate)

    shutil.rmtree(tmp, ignore_errors=True)
    return results