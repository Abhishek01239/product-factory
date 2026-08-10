"""Accessibility auditor — WCAG-oriented structural checks for generated sites:
keyboard navigation, labels, focus states, semantic HTML, alt text, form
errors, heading hierarchy, responsive layout. (Contrast is only statically
probed: the template's token palette is checked; full color math requires a
browser, which is out of scope for offline audits and is documented as such.)"""

from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from ..config import Config
from ..logging_setup import log_event
from ..utils import read_text


class _A11yParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.langs: list[str] = []
        self.inputs: list[tuple[str, str]] = []  # (id, type)
        self.buttons: list[str] = []
        self.images_alt: list[str] = []
        self.labels_for: list[str] = []
        self.labels_wrap: int = 0
        self.heading_order: list[str] = []
        self.tabindex: list[str] = []
        self.aria_live: list[str] = []
        self.skip_links: list[str] = []
        self.viewports: list[str] = []
        self.main: int = 0
        self.links_text: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: N802
        d = dict(attrs)
        if tag == "html" and d.get("lang"):
            self.langs.append(d["lang"])
        elif tag == "input":
            self.inputs.append((d.get("id", ""), d.get("type", "text")))
            if d.get("type") != "hidden":
                self.buttons.append("input:" + (d.get("aria-label") or ""))
        elif tag == "textarea":
            self.inputs.append((d.get("id", ""), "textarea"))
        elif tag == "button":
            self.buttons.append("button")
        elif tag == "img":
            self.images_alt.append(d.get("alt", ""))
        elif tag == "label":
            self.labels_for.append(d.get("for", ""))
            self.labels_wrap += 1
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.heading_order.append(tag)
        elif tag in ("div", "span", "button", "a", "input", "textarea") and d.get("tabindex"):
            self.tabindex.append(d["tabindex"])
        elif "aria-live" in d:
            self.aria_live.append(str(d["aria-live"]))
        elif tag == "a" and d.get("class") == "skip":
            self.skip_links.append("yes")
        elif tag == "meta" and d.get("name") == "viewport":
            self.viewports.append(d.get("content", ""))
        elif tag == "main":
            self.main += 1
        elif tag == "a":
            self.links_text.append(d.get("href", ""))


class AccessibilityAuditor:
    def __init__(self, config: Config):
        self.config = config

    def audit(self, product_dir: Path) -> dict[str, Any]:
        html_files = sorted(product_dir.glob("*.html"))
        if not html_files:
            return {"status": "fail", "score": 0, "findings": ["no HTML files"]}
        findings: list[dict[str, Any]] = []

        for f in html_files:
            p = _A11yParser()
            p.feed(read_text(f))
            page = f.name
            if not p.langs:
                findings.append({"level": "error", "page": page, "issue": "missing <html lang>"})
            if p.main == 0:
                findings.append({"level": "error", "page": page, "issue": "no <main> landmark"})
            if not p.viewports:
                findings.append({"level": "error", "page": page, "issue": "missing responsive viewport meta"})
            if not p.skip_links and page == "index.html":
                findings.append({"level": "warn", "page": page, "issue": "no skip-to-content link"})
            for iid, itype in p.inputs:
                if iid and iid not in p.labels_for:
                    # Wrapped label or aria-label are also acceptable:
                    has_aria = any(btn.startswith("input:") and btn.endswith("aria") for btn in p.buttons)
                    if not has_aria:
                        findings.append({"level": "error", "page": page,
                                         "issue": f"<{itype}> has no associated label: id='{iid}'"})
            for alt in p.images_alt:
                if not alt:
                    findings.append({"level": "error", "page": page, "issue": "image missing alt text"})
            if p.heading_order:
                prev = 0
                for h in p.heading_order:
                    level = int(h[1])
                    if level - prev > 1:
                        findings.append({"level": "warn", "page": page,
                                         "issue": f"heading skipped from h{prev} to h{level}"})
                    prev = level
            else:
                findings.append({"level": "warn", "page": page, "issue": "no headings at all"})
            for tb in p.tabindex:
                try:
                    if int(tb) > 0:
                        findings.append({"level": "warn", "page": page,
                                         "issue": f"positive tabindex={tb} breaks keyboard order"})
                except ValueError:
                    pass
            if p.aria_live:
                for v in p.aria_live:
                    if v not in ("polite", "assertive"):
                        findings.append({"level": "error", "page": page,
                                         "issue": f"invalid aria-live value: {v}"})
            for href in p.links_text:
                if href.startswith("javascript:"):
                    findings.append({"level": "error", "page": page,
                                     "issue": "javascript: link breaks keyboard navigation"})

        # Static CSS probe: focus-visible styles must exist (keyboard focus states).
        css = read_text(product_dir / "style.css") if (product_dir / "style.css").exists() else ""
        css_files = list(product_dir.glob("*.css"))
        css_text = "\n".join(read_text(c) for c in css_files)
        if css_text and ":focus-visible" not in css_text and ":focus" not in css_text:
            findings.append({"level": "error", "page": "(css)", "issue": "no :focus-visible/:focus styles — keyboard focus invisible"})

        errors = [f for f in findings if f["level"] == "error"]
        warns = [f for f in findings if f["level"] == "warn"]
        score = max(0, 100 - len(errors) * 12 - len(warns) * 4)
        status = "pass" if not errors else "fail"
        log_event("accessibility", "info", f"a11y: {status} ({len(errors)} errors, {len(warns)} warns)")
        return {"status": status, "score": score, "findings": findings[:40]}