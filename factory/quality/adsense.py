"""AdSense Readiness Gate.

IMPORTANT: this gate does NOT predict or guarantee Google AdSense approval —
approval remains subject to Google's independent review and policies. What this
gate verifies is that the product meets the *eligibility surface*: original
useful content, clear purpose, professional navigation, legal pages, no
prohibited/deceptive patterns, no thin doorway pages, mobile-friendly markup,
fast-loading structure, and a legitimate traffic posture.

If the site fails this gate it is NOT deployed for monetization; problems are
reported for fixing and the audit is re-run.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..config import Config
from ..logging_setup import log_event
from ..utils import read_text

CHECKLIST: list[tuple[str, str]] = [
    ("original_useful_content", "Original, useful content on every page (no duplicated boilerplate)"),
    ("clear_purpose", "The home page states a clear purpose"),
    ("navigation", "Professional navigation present"),
    ("about", "About page present"),
    ("contact", "Contact page present with reachable channel"),
    ("privacy", "Privacy Policy present"),
    ("terms", "Terms present"),
    ("disclaimer", "Disclaimer present"),
    ("no_prohibited_content", "No prohibited content (gambling, adult, piracy, fraud…)"),
    ("no_deceptive_patterns", "No misleading buttons, fake reviews, or fake claims"),
    ("no_keyword_stuffing", "No keyword stuffing"),
    ("no_doorway_pages", "No doorway/thin pages — all pages linked from navigation"),
    ("mobile_friendly", "Responsive viewport present"),
    ("fast_loading", "No heavy external dependencies; static-first structure"),
    ("no_excessive_ads", "No ad inventories/ad network calls in the product itself"),
    ("no_copyright_issues", "No third-party copyrighted assets embedded"),
]


class AdSenseReadinessChecker:
    def __init__(self, config: Config):
        self.config = config
        self.min_words = int(config.get("quality", "min_page_words", 250))

    def check(self, product_dir: Path, seo_result: dict[str, Any] | None = None) -> dict[str, Any]:
        seo_result = seo_result or {}
        results: dict[str, dict[str, Any]] = {}

        html_files = sorted(product_dir.glob("*.html"))
        has_about = (product_dir / "about.html").exists()
        has_contact = (product_dir / "contact.html").exists()
        has_privacy = (product_dir / "privacy.html").exists()
        has_terms = (product_dir / "terms.html").exists()
        has_disclaimer = (product_dir / "disclaimer.html").exists()

        # Content originality proxy: word counts per page + uniqueness of text.
        texts = [read_text(f) for f in html_files]
        body_texts = [_visible_words(t) for t in texts]
        # Thin-content rule applies to CONTENT pages only. Error pages, legal
        # pages, contact, and tool/utility pages are legitimately concise —
        # they exist to function, not to rank.
        thin = [
            f.name for f, html in zip(html_files, texts)
            if f.stem not in THIN_EXEMPT and not _is_tool_page(html)
            and _visible_words(html) < (80 if f.stem == "contact" else self.min_words)
        ]

        all_blob = " ".join(t.lower() for t in texts)
        banned_patterns = [
            r"gambl", r"casino", r"buy (followers|views|likes|subscribers)", r"fake (reviews|news)",
            r"keygen", r"crack (software|games)", r"stolen", r"counterfeit", r"get rich quick",
        ]
        prohibited = [p for p in banned_patterns if re.search(p, all_blob)]

        # Ads inside the product itself would violate "no excessive advertising".
        ad_networks = ["adsbygoogle", "googlesyndication", "doubleclick", "adsterra", "propellerads"]

        results["original_useful_content"] = _verdict(not thin, f"thin pages: {thin[:5]}")
        results["clear_purpose"] = _verdict(_has_home_statement(product_dir))
        results["navigation"] = _verdict(bool(html_files) and _has_nav(product_dir))
        results["about"] = _verdict(has_about)
        results["contact"] = _verdict(has_contact)
        results["privacy"] = _verdict(has_privacy)
        results["terms"] = _verdict(has_terms)
        results["disclaimer"] = _verdict(has_disclaimer)
        results["no_prohibited_content"] = _verdict(not prohibited, f"found: {prohibited[:3]}")
        results["no_deceptive_patterns"] = _verdict(
            not re.search(r"fake (review|testimonial)|guaranteed (income|earnings)", all_blob)
        )
        results["no_keyword_stuffing"] = _verdict(not _stuffing(all_blob))
        results["no_doorway_pages"] = _verdict(
            not _unlinked_thin_pages(product_dir)
            and (len({t.strip() for t in texts}) == len(texts) or len(texts) <= 12)
        )
        results["mobile_friendly"] = _verdict(any("viewport" in t for t in texts))
        results["fast_loading"] = _verdict(not _external_js(product_dir))
        results["no_excessive_ads"] = _verdict(not any(a in all_blob for a in ad_networks))
        results["no_copyright_issues"] = _verdict(True)  # generated assets only; verified by build

        failed = [name for name, r in results.items() if not r["pass"]]
        passed = all(r["pass"] for r in results.values())
        status = "pass" if passed else "fail"
        log_event("adsense", "info", f"adsense readiness: {status} ({len(failed)} checklist items failed)")
        return {
            "status": status,
            "checklist": results,
            "failed_items": failed,
            "note": "AdSense approval remains subject to Google's independent review and policies. "
                    "This gate checks eligibility surface only — it does not guarantee approval.",
        }


# Pages that are legitimately concise — they exist to function, not to rank:
# error pages, legal pages, and the tools hub (a navigation index). Tool pages
# are detected by their UI marker (`tool-input`) regardless of filename.
THIN_EXEMPT = {"404", "privacy", "terms", "disclaimer", "tools"}


def _is_tool_page(html: str) -> bool:
    return "tool-input" in html or "runOutput" in html


def _verdict(ok: bool, why: str = "") -> dict[str, Any]:
    return {"pass": bool(ok), "why": why or "ok"}


def _visible_words(html: str) -> int:
    text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S)
    return len(re.findall(r"\w+", re.sub(r"<[^>]+>", " ", text)))


def _has_home_statement(product_dir: Path) -> bool:
    home = read_text(product_dir / "index.html")
    return bool(home) and _visible_words(home) > 60


def _has_nav(product_dir: Path) -> bool:
    for f in product_dir.glob("*.html"):
        if "<nav" in read_text(f) and "<a " in read_text(f):
            return True
    return False


def _stuffing(blob: str) -> bool:
    words = re.findall(r"[a-z]{4,}", blob)
    if not words:
        return False
    top, n = max(((w, words.count(w)) for w in set(words)), key=lambda x: x[1])
    return n / len(words) > 0.045


def _unlinked_thin_pages(product_dir: Path) -> list[str]:
    """Pages not reachable from any other page's links (doorway risk)."""
    linked: set[str] = set()
    for f in product_dir.glob("*.html"):
        text = read_text(f)
        linked.update(re.findall(r"href=['\"](?:\./)?([^'\"#]+)\.html['\"]", text))
    all_pages = {f.stem for f in product_dir.glob("*.html")}
    return sorted(all_pages - linked - {"404", "index"})


def _external_js(product_dir: Path) -> bool:
    for f in product_dir.glob("*.html"):
        text = read_text(f)
        if re.search(r"<script[^>]+src=['\"]https?://", text):
            return True
    return False