"""Legal/compliance auditor — checks every public-facing site has truthful,
complete legal pages grounded in ACTUAL functionality.

Critical rule: never invent data practices. For static sites the generated
policy must NOT claim cookies/analytics when the site has none, and must not
claim server-side collection that the code does not do. If the policy text
contradicts the declared data handling, the gate fails.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..config import Config
from ..logging_setup import log_event
from ..utils import read_text

REQUIRED_PAGES = {
    "privacy.html": "Privacy Policy",
    "terms.html": "Terms of Service",
    "disclaimer.html": "Disclaimer",
    "about.html": "About",
    "contact.html": "Contact",
}

# Claims that are only acceptable when the site actually does those things.
INVENTED_PRACTICE_PROBES = [
    ("cookies", r"set cookies|uses cookies|stores cookies"),
    ("analytics", r"third.party analytics|google analytics|counts page views"),
    ("personal data collection", r"collects? (your )?personal (data|information)|stores? personal data"),
]


class LegalAuditor:
    def __init__(self, config: Config):
        self.config = config

    def audit(self, product_dir: Path, spec: dict[str, Any] | None = None) -> dict[str, Any]:
        spec = spec or {}
        data_handling = (
            "All processing happens in the visitor's browser. No accounts, no "
            "server-side storage, no cookies, no analytics, no third-party trackers."
        )
        findings: list[dict[str, Any]] = []

        for page, label in REQUIRED_PAGES.items():
            path = product_dir / page
            if not path.exists():
                findings.append({"level": "error", "page": page, "issue": f"missing {label} page"})
                continue
            text = _visible_text(read_text(path))
            words = len(re.findall(r"\w+", text))
            if words < 80:
                findings.append({"level": "error", "page": page,
                                 "issue": f"{label} too thin ({words} words, want ≥ 80)"})

        # Truthfulness probe: a static site must not claim invented practices.
        privacy = _visible_text(read_text(product_dir / "privacy.html"))
        ptype = spec.get("product_type")
        if ptype in ("static_site", "chrome_extension") and privacy:
            # Probe only ASSERTIVE sentences ("we use cookies"), never negated
            # ones ("we do not set cookies") — the latter are truthful for
            # a static site and are the fallback's normal wording.
            assertive = " ".join(
                s for s in re.split(r"(?<=[.!?])\s+", privacy)
                if not re.search(r"\b(no|not|never|doesn'?t|don'?t)\b", s, re.IGNORECASE)
            )
            for label, pattern in INVENTED_PRACTICE_PROBES:
                if re.search(pattern, assertive, re.IGNORECASE):
                    findings.append({"level": "error", "page": "privacy.html",
                                     "issue": f"policy claims '{label}' but this product does not do that (data_handling: {data_handling})"})

        # Contact info present (a real channel, not just a <p>).
        contact = read_text(product_dir / "contact.html")
        if contact and not re.search(r"href=['\"](mailto:|https?://)", contact):
            findings.append({"level": "warn", "page": "contact.html",
                             "issue": "contact page has no reachable link (mailto/http)"})

        errors = [f for f in findings if f["level"] == "error"]
        score = max(0, 100 - len(errors) * 20 - len([f for f in findings if f["level"] == "warn"]) * 5)
        status = "pass" if not errors else "fail"
        log_event("legal", "info", f"legal: {status} ({len(errors)} errors)")
        return {"status": status, "score": score, "findings": findings[:30]}


def _visible_text(html: str) -> str:
    text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text)).strip()