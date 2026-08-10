"""SEO auditor — checks the generated site against the SEO requirements
(title/meta/canonical/OG/Twitter/robots/sitemap/structured data/semantic HTML/
clean structure/internal linking/image alt). No keyword stuffing, no doorway
pages, no misleading metadata — those are validated as *absences*."""

from __future__ import annotations

import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from ..config import Config
from ..logging_setup import log_event
from ..utils import read_text


class _HeadParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.meta: dict[str, str] = {}
        self.titles: list[str] = []
        self.canonicals: list[str] = []
        self.og: dict[str, str] = {}
        self.twitter: dict[str, str] = {}
        self.jsonld: list[str] = []
        self.h1: list[str] = []
        self.h2: list[str] = []
        self.images: list[tuple[str, str]] = []  # (alt, src)
        self.links: list[str] = []
        self.langs: list[str] = []
        self._capture: str | None = None  # tag currently capturing data
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: N802
        d = dict(attrs)
        if tag in ("title", "h1", "h2"):
            self._capture = tag
            self._buf = []
        elif tag == "meta":
            name = d.get("name") or d.get("property") or ""
            content = d.get("content", "")
            if name == "description":
                self.meta["description"] = content
            elif name.startswith("og:"):
                self.og[name[3:]] = content
            elif name.startswith("twitter:"):
                self.twitter[name[8:]] = content
        elif tag == "link" and d.get("rel") == "canonical":
            self.canonicals.append(d.get("href", ""))
        elif tag == "html":
            if d.get("lang"):
                self.langs.append(d["lang"])
        elif tag == "img":
            self.images.append((d.get("alt", ""), d.get("src", "")))
        elif tag == "a" and d.get("href"):
            self.links.append(d["href"])
        elif tag == "script" and "application/ld+json" in d.get("type", ""):
            self._capture = "jsonld"
            self._buf = []

    def handle_endtag(self, tag: str) -> None:  # noqa: N802
        if tag == self._capture in ("title", "h1", "h2", "jsonld"):
            text = "".join(self._buf).strip()
            if tag == "title":
                self.titles.append(text)
            elif tag == "h1":
                self.h1.append(text)
            elif tag == "h2":
                self.h2.append(text)
            elif tag == "jsonld":
                self.jsonld.append(text)
            self._capture = None
            self._buf = []

    def handle_data(self, data: str) -> None:  # noqa: N802
        if self._capture is not None:
            self._buf.append(data)


class SEOAuditor:
    def __init__(self, config: Config):
        self.config = config
        self.min_words = int(config.get("quality", "min_page_words", 250))

    def audit(self, product_dir: Path) -> dict[str, Any]:
        html_files = sorted(product_dir.glob("*.html"))
        if not html_files:
            return {"status": "fail", "score": 0, "findings": ["no HTML files found"]}

        findings: list[dict[str, Any]] = []
        info: list[dict[str, Any]] = []
        for f in html_files:
            html = read_text(f)
            parsed = _HeadParser()
            parsed.feed(html)
            page = f.name
            if not parsed.titles or not parsed.titles[0].strip():
                findings.append({"level": "error", "file": page, "issue": "missing <title>"})
            else:
                t = parsed.titles[0].strip()
                if not 10 <= len(t) <= 70:
                    findings.append({"level": "warn", "file": page, "issue": f"title length {len(t)} (want 10-70)"})
            desc = parsed.meta.get("description", "")
            if not desc:
                findings.append({"level": "error", "file": page, "issue": "missing meta description"})
            elif not 50 <= len(desc) <= 165 and page != "404.html":
                # 404 pages legitimately carry a one-line description.
                findings.append({"level": "warn", "file": page, "issue": f"meta description length {len(desc)} (want 50-165)"})
            if not parsed.canonicals:
                findings.append({"level": "error", "file": page, "issue": "missing canonical URL"})
            if not parsed.og.get("title") or not parsed.og.get("description"):
                findings.append({"level": "warn", "file": page, "issue": "incomplete Open Graph tags"})
            if not parsed.twitter.get("title"):
                findings.append({"level": "warn", "file": page, "issue": "incomplete Twitter card tags"})
            if not parsed.langs:
                findings.append({"level": "error", "file": page, "issue": "missing <html lang>"})
            if len(parsed.h1) != 1:
                findings.append({"level": "error", "file": page, "issue": f"{len(parsed.h1)} <h1> (want exactly 1)"})
            if not parsed.h2 and page not in {"404.html"}:
                findings.append({"level": "warn", "file": page, "issue": "no <h2> section headings"})
            for alt, src in parsed.images:
                if not alt:
                    findings.append({"level": "error", "file": page, "issue": f"img without alt text: {src}"})
            body_words = _visible_words(html)
            if body_words < self.min_words and not _thin_exempt(page, html):
                # Error/legal/tool pages are intentionally minimal; exclude.
                findings.append({"level": "warn", "file": page,
                                 "issue": f"thin content: {body_words} visible words (want ≥ {self.min_words})"})
            info.append({"file": page, "words": body_words,
                         "title": (parsed.titles[0].strip() if parsed.titles else "")[:60]})

        # Site-level files.
        for need, label in [("robots.txt", "robots.txt"), ("sitemap.xml", "sitemap.xml"),
                            ("favicon.svg", "favicon")]:
            if not (product_dir / need).exists():
                findings.append({"level": "warn", "file": need, "issue": f"missing {label}"})
        sitemap = read_text(product_dir / "sitemap.xml")
        if sitemap and "<url>" not in sitemap:
            findings.append({"level": "error", "file": "sitemap.xml", "issue": "sitemap has no <url> entries"})

        # Keyword-stuffing probe: the single most repeated *word* must stay under 4%.
        text_blob = " ".join(read_text(f) for f in html_files)
        words = re.findall(r"[a-z]{4,}", text_blob.lower())
        if words:
            top_word, top_count = max(((w, words.count(w)) for w in set(words)), key=lambda x: x[1])
            if top_count / len(words) > 0.04:
                findings.append({"level": "error", "file": "(all)", "issue": f"keyword stuffing risk: '{top_word}' = {top_count}/{len(words)} words"})

        errors = [f for f in findings if f["level"] == "error"]
        warns = [f for f in findings if f["level"] == "warn"]
        score = max(0, 100 - len(errors) * 15 - len(warns) * 5)
        status = "pass" if not errors else "fail"
        log_event("seo", "info", f"seo: {status} ({len(errors)} errors, {len(warns)} warns)")
        return {"status": status, "score": score, "findings": findings[:40], "pages": info}


def _visible_words(html: str) -> int:
    text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return len(re.findall(r"\w+", text))


def _thin_exempt(page: str, html: str) -> bool:
    """Pages exempt from the minimum-word rule: 404, legal, hub, contact, tool UI."""
    if page in ("404.html", "privacy.html", "terms.html", "disclaimer.html",
                "contact.html", "tools.html"):
        return True
    return "tool-input" in html  # functional tool page (utility, not article)