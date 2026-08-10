"""Unit tests: every audit gate + final quality scoring."""

from __future__ import annotations

import unittest

from factory.quality.accessibility import AccessibilityAuditor
from factory.quality.adsense import AdSenseReadinessChecker
from factory.quality.legal import LegalAuditor
from factory.quality.runner import run_audits
from factory.quality.score import compute_quality_score, gates_passed
from factory.quality.security import SecurityAuditor
from factory.quality.seo import SEOAuditor
from tests.helpers import CANNED_SPEC, TempWorkspace


class AuditSuite(unittest.TestCase):
    def test_all_gates_pass_on_good_product(self):
        with TempWorkspace() as ws:
            self.assertEqual(SecurityAuditor(ws.config).audit(ws.product_dir)["status"], "pass")
            self.assertEqual(SEOAuditor(ws.config).audit(ws.product_dir)["status"], "pass")
            self.assertEqual(AccessibilityAuditor(ws.config).audit(ws.product_dir)["status"], "pass")
            self.assertEqual(LegalAuditor(ws.config).audit(ws.product_dir, CANNED_SPEC)["status"], "pass")
            ads = AdSenseReadinessChecker(ws.config).check(ws.product_dir)
            self.assertEqual(ads["status"], "pass", str(ads["failed_items"]))
            self.assertIn("subject to Google", ads["note"])

    def test_committed_secret_fails_security(self):
        with TempWorkspace() as ws:
            (ws.product_dir / ".env").write_text("TOKEN=supersecretvalue123", encoding="utf-8")
            result = SecurityAuditor(ws.config).audit(ws.product_dir)
            self.assertEqual(result["status"], "fail")
            self.assertTrue(any(f["severity"] == "high" for f in result["findings"]))
            (ws.product_dir / ".env").unlink()

    def test_eval_pattern_flagged(self):
        with TempWorkspace() as ws:
            (ws.product_dir / "evil.js").write_text("eval(userInput);", encoding="utf-8")
            result = SecurityAuditor(ws.config).audit(ws.product_dir)
            self.assertTrue(any("eval" in f.get("rule", "") for f in result["findings"]))
            (ws.product_dir / "evil.js").unlink()

    def test_legal_rejects_invented_practices(self):
        with TempWorkspace() as ws:
            privacy = ws.product_dir / "privacy.html"
            original = privacy.read_text(encoding="utf-8")
            # Replace the whole policy body with an ASSERTIVE (non-negated) claim.
            import re as _re

            privacy.write_text(_re.sub(r"<section>.*?</section>", "", original, flags=_re.S)
                               + "<section><p>The site uses cookies to remember preferences and "
                                 "third-party analytics to improve the experience.</p></section>")
            result = LegalAuditor(ws.config).audit(ws.product_dir, CANNED_SPEC)
            self.assertEqual(result["status"], "fail")
            privacy.write_text(original, encoding="utf-8")

    def test_seo_missing_title_fails(self):
        with TempWorkspace() as ws:
            page = ws.product_dir / "about.html"
            original = page.read_text(encoding="utf-8")
            page.write_text(original.replace("<title>", "<title>x</title><!--"), encoding="utf-8")
            # Simpler: blank the title element entirely.
            import re

            page.write_text(re.sub(r"<title>.*?</title>", "", original), encoding="utf-8")
            result = SEOAuditor(ws.config).audit(ws.product_dir)
            self.assertEqual(result["status"], "fail")
            page.write_text(original, encoding="utf-8")

    def test_full_battery_and_gates(self):
        with TempWorkspace() as ws:
            gates = run_audits(ws.product_dir, CANNED_SPEC, ws.config)
            eval_ = gates_passed(gates, ws.config.get("gates", "require", []))
            self.assertTrue(eval_["all_pass"], str(eval_["gates"]))

    def test_quality_score_thresholds(self):
        high = {k: 90 for k in ("usefulness", "ux", "security", "seo", "accessibility",
                                "performance", "monetization_readiness", "originality")}
        low = {k: 10 for k in high}
        with TempWorkspace(build=False) as ws:
            self.assertEqual(compute_quality_score(high, ws.config)["verdict"],
                             "ELIGIBLE_FOR_DEPLOYMENT")
            self.assertEqual(compute_quality_score(low, ws.config)["verdict"], "REJECT")


if __name__ == "__main__":
    unittest.main()
