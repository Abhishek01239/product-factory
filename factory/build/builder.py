"""Code builder — generates the product from the validated spec.

Security policy for generated code: AI writes *copy* and structure; executable
JavaScript in products is ALWAYS the deterministic whitelisted template below
(generic, dependency-free browser behaviors). AI-generated executable code is
never shipped — it cannot be safely reviewed at factory scale.

The static-site renderer is pure Python (no Node, no build step), so it works
everywhere. The webapp/extension/api templates are minimal but real, and their
tests run in CI where the runtime exists.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from ..ai import AIError, AIUnavailable
from ..config import Config
from ..logging_setup import log_event
from ..utils import gen_id, now_utc, slugify, write_text

PLACEHOLDER_PATTERNS = [
    re.compile(r"\bTODO\b", re.IGNORECASE),
    re.compile(r"\bFIXME\b", re.IGNORECASE),
    re.compile(r"\bPLACEHOLDER\b", re.IGNORECASE),
    re.compile(r"\bLOREM IPSUM\b", re.IGNORECASE),
    re.compile(r"\bXXX\b"),
]

# Deterministic, dependency-free browser behaviors for tool pages.
# Keyed by keyword matched against the feature description/name.
TOOL_JS: dict[str, str] = {
    "json": """
function runTool(input) {
  try {
    const parsed = JSON.parse(input);
    return JSON.stringify(parsed, null, 2);
  } catch (e) {
    return "Invalid JSON: " + e.message;
  }
}
""",
    "case": """
function runTool(input) {
  return [
    "UPPERCASE:", input.toUpperCase(),
    "lowercase:", input.toLowerCase(),
    "Title Case:", input.replace(/\\w\\S*/g, t => t[0].toUpperCase() + t.slice(1).toLowerCase())
  ].join("\\n");
}
""",
    "count": """
function runTool(input) {
  const words = input.trim() ? input.trim().split(/\\s+/).length : 0;
  return "Characters (no spaces): " + input.replace(/\\s/g, "").length +
    "\\nWords: " + words +
    "\\nLines: " + (input ? input.split(/\\n/).length : 0);
}
""",
    "check": """
function runTool(input) {
  const urlLike = /^https?:\\/\\/[^\\s]+$/i.test(input.trim());
  const len = input.trim().length;
  return "Looks like a URL: " + (urlLike ? "yes" : "no") +
    "\\nLength: " + len + " characters";
}
""",
}
DEFAULT_JS = TOOL_JS["count"]

HTML_ESCAPE = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}


def esc(text: Any) -> str:
    return "".join(HTML_ESCAPE.get(c, c) for c in str(text))


class BuildError(Exception):
    pass


class CodeBuilder:
    def __init__(self, config: Config, client):
        self.config = config
        self.client = client
        self.ai_calls = 0

    # ------------------------------------------------------------------ #
    def build(self, spec: dict[str, Any], out_dir: Path) -> Path:
        """Generate the project into ``out_dir`` and return it."""
        out_dir.mkdir(parents=True, exist_ok=True)
        ptype = spec["product_type"]
        try:
            if ptype == "static_site":
                self._build_static(spec, out_dir)
            elif ptype == "webapp":
                self._build_webapp(spec, out_dir)
            elif ptype == "chrome_extension":
                self._build_extension(spec, out_dir)
            elif ptype == "api":
                self._build_api(spec, out_dir)
            else:
                raise BuildError(f"unsupported product_type: {ptype}")
        except (AIError, AIUnavailable) as e:
            raise BuildError(f"AI content generation failed: {e}") from e

        leftovers = self._find_placeholders(out_dir)
        if leftovers:
            raise BuildError(
                "placeholder tokens found in generated files (not allowed): "
                + ", ".join(leftovers[:8])
            )
        write_text(out_dir / "PRODUCT_META.json", json.dumps({
            "name": spec["name"],
            "product_type": ptype,
            "generated_at": now_utc(),
            "ai_provider": self.client.provider,
            "generator": "product-factory",
        }, indent=2))
        log_event("build", "info", f"built {ptype} -> {out_dir.name} ({len(list(out_dir.rglob('*')))} files)")
        return out_dir

    # ------------------------------------------------------------------ #
    # Static site                                                        #
    # ------------------------------------------------------------------ #
    def _build_static(self, spec: dict[str, Any], out: Path) -> None:
        content = self._ai_content(spec)
        legal = self._ai_legal(spec)
        pages = list(spec.get("pages") or ["home", "about", "contact", "privacy", "terms", "disclaimer"])
        site_url = self.config.get("seo", "site_url", "https://example.com").rstrip("/")

        nav = self._nav(pages, spec)
        css = _STYLE_CSS

        for page in pages:
            text = self._render_page(page, spec, content, legal, nav, css, site_url)
            path = out / "index.html" if page == "home" else out / f"{page}.html"
            write_text(path, text)

        # Tool pages (one per feature) appended after standard pages.
        for i, feature in enumerate(spec.get("features", [])[:3]):
            slug = slugify(feature.get("name", f"tool-{i}"), f"tool-{i}")
            self._render_tool_page(out, feature, slug, spec, nav, css, site_url)

        self._write_static_assets(out, spec, site_url)

    def _ai_content(self, spec: dict[str, Any]) -> dict[str, Any]:
        """Page copy from AI. Falls back to clean deterministic copy when the
        AI returns nothing usable (never fabricates)."""
        fallback = _FALLBACK_CONTENT(spec)
        try:
            raw = self.client.complete_json(
                user=(
                    "Write honest, original, useful website copy for this product:\n"
                    + json.dumps({"name": spec["name"], "tagline": spec["tagline"],
                                  "problem": spec["problem"], "users": spec["users"],
                                  "features": spec["features"]}, indent=2)
                    + "\n\nReturn JSON: {\"home\": {\"title\", \"summary\", \"sections\": "
                      "[{\"heading\", \"body\"}]}, \"about\": {...}, \"contact\": {...}}"
                ),
                task="page_content",
            )
        except (AIError, AIUnavailable):
            return fallback
        merged = fallback
        for page, data in raw.items():
            if isinstance(data, dict) and isinstance(merged.get(page), dict):
                merged[page] = data
        return merged

    def _ai_legal(self, spec: dict[str, Any]) -> dict[str, str]:
        """Legal copy from AI, grounded in ACTUAL functionality (features +
        data-handling facts). Falls back to the truthful minimal policy."""
        fallback = _FALLBACK_LEGAL(spec)
        try:
            raw = self.client.complete_json(
                user=(
                    "Write accurate legal/privacy copy for this product. Ground it ONLY in "
                    "the stated functionality — never invent data practices.\nProduct: "
                    + json.dumps({"name": spec["name"], "features": spec["features"],
                                  "data_handling": "All processing happens in the visitor's "
                                  "browser. No accounts, no server-side storage, no cookies, "
                                  "no analytics, no third-party trackers."}, indent=2)
                    + "\n\nReturn JSON: {\"privacy\": \"...\", \"terms\": \"...\", "
                      "\"disclaimer\": \"...\"} — each 150-350 words."
                ),
                task="legal_pages",
            )
        except (AIError, AIUnavailable):
            return fallback
        out = dict(fallback)
        for k in ("privacy", "terms", "disclaimer"):
            if isinstance(raw.get(k), str) and len(raw[k]) > 100:
                out[k] = raw[k]
        return out

    def _render_page(self, page, spec, content, legal, nav, css, site_url: str) -> str:
        c = content.get(page, {})
        title = str(c.get("title") or _DEFAULT_TITLES.get(page, spec["name"]))
        summary = str(c.get("summary") or spec["tagline"])
        sections = c.get("sections") or []

        if page == "privacy":
            body = _legal_html("Privacy Policy", legal["privacy"])
        elif page == "terms":
            body = _legal_html("Terms of Service", legal["terms"])
        elif page == "disclaimer":
            body = _legal_html("Disclaimer", legal["disclaimer"])
        else:
            sections_html = "".join(
                f"<section><h2>{esc(s.get('heading', ''))}</h2>"
                f"<p>{esc(s.get('body', ''))}</p></section>"
                for s in sections
            )
            if page == "home":
                body = (
                    f"<section class='hero'><h1>{esc(spec['name'])}</h1>"
                    f"<p class='tagline'>{esc(spec['tagline'])}</p></section>" + sections_html
                )
            else:
                body = f"<section class='hero'><h1>{esc(title)}</h1></section>" + sections_html

        word_count = len(re.findall(r"\w+", re.sub(r"<[^>]+>", " ", body)))
        title_tag = title if page == "home" else f"{title} — {spec['name']}"
        return _PAGE_TEMPLATE.format(
            lang="en",
            page_title=esc(title_tag),
            meta_description=esc(summary[:155]),
            canonical=esc(f"{site_url}/{'' if page == 'home' else page + '.html'}"),
            og_title=esc(title_tag),
            og_desc=esc(summary[:155]),
            site_name=esc(spec["name"]),
            css=css,
            nav=nav,
            main=body,
            footer=esc(f"{now_utc()[:4]} {spec['name']} — built by the Autonomous Product Factory"),
        )

    def _render_tool_page(self, out: Path, feature: dict[str, Any], slug: str,
                          spec, nav, css, site_url: str) -> None:
        name = slug.replace("-", " ").title()
        js = _pick_tool_js(feature.get("name", "") + " " + feature.get("description", ""))
        body = f"""
<section class='hero'><h1>{esc(name)}</h1>
<p class='tagline'>{esc(feature.get('description') or '')}</p></section>
<section>
<label for='tool-input'>Input</label>
<textarea id='tool-input' rows='8' aria-label='Input text'></textarea>
<button type='button' onclick='runOutput()'>Run</button>
<pre id='tool-output' aria-live='polite' tabindex='0'>Output appears here.</pre>
<p class='local-note'>Runs entirely in your browser. Nothing is uploaded or stored.</p>
</section>
<script>
{js}
function runOutput() {{
  const input = document.getElementById('tool-input').value;
  document.getElementById('tool-output').textContent = String(runTool(input));
}}
</script>"""
        page = _PAGE_TEMPLATE.format(
            lang="en",
            page_title=esc(f"{name} — {spec['name']}"),
            meta_description=esc(f"Free {name.lower()} tool. {feature.get('description', '')}"[:155]),
            canonical=esc(f"{site_url}/{slug}.html"),
            og_title=esc(f"{name} — {spec['name']}"),
            og_desc=esc(f"Free {name.lower()} tool that runs in your browser."),
            site_name=esc(spec["name"]),
            css=css,
            nav=nav,
            main=body,
            footer=esc(f"{now_utc()[:4]} {spec['name']}"),
        )
        write_text(out / f"{slug}.html", page)

    def _write_static_assets(self, out: Path, spec: dict[str, Any], site_url: str) -> None:
        pages = list(spec.get("pages") or [])
        # robots.txt
        write_text(out / "robots.txt", "User-agent: *\nAllow: /\nSitemap: {}/sitemap.xml\n".format(site_url))
        # sitemap.xml (home + standard pages + tool pages)
        urls = [site_url + "/", site_url + "/about.html", site_url + "/contact.html"]
        for i, f in enumerate(spec.get("features", [])[:3]):
            urls.append(f"{site_url}/{slugify(f.get('name', f'tool-{i}'), f'tool-{i}')}.html")
        sitemap = (
            '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + "".join(f"  <url><loc>{u}</loc></url>\n" for u in urls)
            + "</urlset>\n"
        )
        write_text(out / "sitemap.xml", sitemap)
        # favicon (inline SVG — no binary assets)
        write_text(out / "favicon.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#4f46e5"/><text x="16" y="22" font-size="14" text-anchor="middle" fill="#fff" font-family="sans-serif">&#9881;</text></svg>')
        write_text(out / "404.html", _PAGE_TEMPLATE.format(
            lang="en", page_title="404 — Not found", meta_description="Page not found",
            canonical=esc(site_url + "/404.html"), og_title="404", og_desc="Page not found",
            site_name=esc(spec["name"]), css=_STYLE_CSS, nav=self._nav(pages, spec),
            main="<section class='hero'><h1>404</h1><p class='tagline'>This page does not exist. <a href='/'>Go home</a>.</p></section>",
            footer="",
        ))
        # manifest (lightweight, no install)
        write_text(out / "manifest.webmanifest", json.dumps({
            "name": spec["name"], "short_name": spec["name"][:12],
            "start_url": "./", "display": "standalone",
            "icons": [{"src": "favicon.svg", "sizes": "any", "type": "image/svg+xml"}],
        }, indent=2))

    def _nav(self, pages: list[str], spec: dict[str, Any]) -> str:
        links = []
        for p in pages:
            label = {"home": "Home", "about": "About", "contact": "Contact",
                     "privacy": "Privacy", "terms": "Terms", "disclaimer": "Disclaimer"}.get(p, p.title())
            href = "./" if p == "home" else f"./{p}.html"
            links.append(f"<a href='{href}'>{esc(label)}</a>")
        for i, f in enumerate(spec.get("features", [])[:3]):
            slug = slugify(f.get("name", f"tool-{i}"), f"tool-{i}")
            links.append(f"<a href='./{slug}.html'>{esc(f.get('name', 'Tool'))}</a>")
        return "".join(links)

    # ------------------------------------------------------------------ #
    # Webapp (FastAPI + SQLite)                                            #
    # ------------------------------------------------------------------ #
    def _build_webapp(self, spec: dict[str, Any], out: Path) -> None:
        app_name = slugify(spec["name"], "app").replace("-", "_")
        write_text(out / "requirements.txt", "fastapi>=0.115,<1\nuvicorn>=0.30,<1\n")
        write_text(out / "app.py", _WEBAPP_APP.format(
            app_name=app_name, name=spec["name"], tagline=spec["tagline"],
            features=json.dumps(spec.get("features", []), indent=2),
        ))
        write_text(out / "test_app.py", _WEBAPP_TEST.format(app_name=app_name))
        write_text(out / "README.md", f"# {spec['name']}\n\n{spec['tagline']}\n\n"
                                      "Run: `pip install -r requirements.txt && uvicorn app:app`\n"
                                      "Test: `python -m unittest test_app -v`\n")
        write_text(out / ".gitignore", "*.db\n__pycache__/\n.env\n")

    # ------------------------------------------------------------------ #
    # Chrome extension (Manifest V3)                                       #
    # ------------------------------------------------------------------ #
    def _build_extension(self, spec: dict[str, Any], out: Path) -> None:
        write_text(out / "manifest.json", json.dumps({
            "manifest_version": 3,
            "name": spec["name"][:50],
            "version": "1.0.0",
            "description": (spec["tagline"] or "A focused browser utility.")[:130],
            "action": {"default_popup": "popup.html", "default_title": spec["name"][:50]},
            "permissions": [],
            "icons": {"128": "icon.svg"},
        }, indent=2))
        write_text(out / "icon.svg", _ICON_SVG)
        write_text(out / "popup.html", """<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Popup</title><style>body{font-family:system-ui,sans-serif;width:280px;padding:12px}
textarea{width:100%;box-sizing:border-box}button{margin-top:8px}</style></head><body>
<h2>%s</h2><label for="in">Input</label><textarea id="in" rows="5"></textarea>
<button id="go">Run</button><pre id="out" aria-live="polite"></pre>
<script src="popup.js"></script></body></html>""" % esc(spec["name"]))
        write_text(out / "popup.js", DEFAULT_JS + """
document.getElementById('go').addEventListener('click', function () {
  const input = document.getElementById('in').value;
  document.getElementById('out').textContent = String(runTool(input));
});
""")
        write_text(out / "README.md", f"# {spec['name']}\n\nLoad via chrome://extensions → Load unpacked.\n"
                                      "Permission model: no host permissions, no data collected.\n")

    # ------------------------------------------------------------------ #
    # API (FastAPI JSON endpoints)                                         #
    # ------------------------------------------------------------------ #
    def _build_api(self, spec: dict[str, Any], out: Path) -> None:
        write_text(out / "requirements.txt", "fastapi>=0.115,<1\nuvicorn>=0.30,<1\n")
        write_text(out / "main.py", _API_APP.format(
            name=spec["name"], tagline=spec["tagline"],
            features=json.dumps([f.get("name") for f in spec.get("features", [])], indent=2),
        ))
        write_text(out / "test_main.py", """import unittest
from unittest.mock import patch

class TestApi(unittest.TestCase):
    def test_importable(self):
        import main
        self.assertTrue(hasattr(main, "app"))

if __name__ == "__main__":
    unittest.main()
""")
        write_text(out / "README.md", f"# {spec['name']} API\n\n{spec['tagline']}\n\n"
                                      "Run: `uvicorn main:app` — docs at /docs.\n")

    # ------------------------------------------------------------------ #
    def _find_placeholders(self, out: Path) -> list[str]:
        hits: list[str] = []
        for f in out.rglob("*"):
            if f.is_file() and f.suffix in {".html", ".js", ".py", ".css", ".md", ".json"}:
                try:
                    text = f.read_text(encoding="utf-8")
                except (OSError, UnicodeDecodeError):
                    continue
                for pat in PLACEHOLDER_PATTERNS:
                    if pat.search(text):
                        hits.append(f"{f.name} ({pat.pattern})")
                        break
        return hits


def _pick_tool_js(feature_text: str) -> str:
    blob = feature_text.lower()
    for key in ("json", "case", "count", "check"):
        if key in blob:
            return TOOL_JS[key]
    return DEFAULT_JS


def _legal_html(title: str, body: str) -> str:
    paras = "".join(f"<p>{esc(p.strip())}</p>" for p in str(body).split("\n") if p.strip())
    return f"<section class='hero'><h1>{esc(title)}</h1></section><section>{paras}</section>"


def _FALLBACK_CONTENT(spec: dict[str, Any]) -> dict[str, Any]:
    name = spec["name"]
    return {
        "home": {
            "title": f"{name} — {spec['tagline']}",
            "summary": spec["tagline"],
            "sections": [
                {"heading": "What this is", "body": f"{name} is a focused, dependency-free utility "
                 f"built directly for {spec['problem']} It works entirely in your browser."},
                {"heading": "How it works", "body": "Open any tool page, paste your input, and run. "
                 "No account, no uploads, no tracking — the computation happens locally."},
            ],
        },
        "about": {
            "title": f"About {name}",
            "summary": f"What {name} is and why it exists.",
            "sections": [
                {"heading": "Why this exists", "body": f"{name} was created because {spec['problem']}"},
                {"heading": "Principles", "body": "Fast, accessible, private, and honest. No dark patterns, no fake claims."},
            ],
        },
        "contact": {
            "title": "Contact",
            "summary": "How to reach us.",
            "sections": [
                {"heading": "Feedback", "body": "Found a bug or have a feature request? "
                 "Open an issue on the project repository (see footer). Please include the tool name and browser version."},
            ],
        },
        "tools": {
            "title": f"{name} tools",
            "summary": "The utility toolbox — every tool runs locally in your browser.",
            "sections": [
                {"heading": "The toolbox",
                 "body": "Every tool below is free to use, runs entirely in your browser, and needs no "
                         "account, no upload, and no data collection. Open a tool, paste or type your "
                         "input, and run — the result appears instantly and never leaves your machine."},
                *[
                    {"heading": f.get("name") or f"Tool {i}",
                     "body": f.get("description") or "A small browser-side utility."}
                    for i, f in enumerate(spec.get("features") or [])
                ],
            ],
        },
    }


def _FALLBACK_LEGAL(spec: dict[str, Any]) -> dict[str, str]:
    name = spec["name"]
    return {
        "privacy": (f"{name} is a static website whose tools run entirely in the visitor's browser. "
                    "The site does not set cookies and does not use third-party analytics, advertising, "
                    "or tracking services. It does not collect, store, or transmit any personal data: "
                    "there are no accounts, no comment systems, and no forms that send information to a "
                    "server. Because nothing is uploaded, there is nothing to retain or delete. If data "
                    "practices change in the future, this policy will be updated before the change takes "
                    "effect, and the update date will be noted here. Questions about privacy can be sent "
                    "through the contact page."),
        "terms": (f"By using {name} you agree to these terms. The service is provided free of charge on "
                  "an 'as is' and 'as available' basis, without warranties of any kind, express or "
                  "implied. You use the tools at your own discretion and are responsible for verifying "
                  "any output before relying on it. The maintainer is not liable for any damages "
                  "arising from the use of, or the inability to use, this site, including indirect or "
                  "consequential losses. The maintainer may change, suspend, or discontinue any part "
                  "of the service at any time without notice. These terms are governed by the laws of "
                  "the jurisdiction where the maintainer resides."),
        "disclaimer": "The tools on this site compute results locally in your browser, but no tool is "
                      "infallible. Outputs should be independently verified before being used in "
                      "important workflows, and this site does not provide professional, legal, "
                      "financial, or medical advice. Nothing on this site creates a relationship "
                      "between you and the maintainer beyond ordinary use of a free web utility. "
                      "Third-party sites linked from here have their own policies; we are not "
                      "responsible for their content. If you find an error, please report it through "
                      "the contact page so it can be corrected.",
    }


_DEFAULT_TITLES = {
    "about": "About", "contact": "Contact", "privacy": "Privacy Policy",
    "terms": "Terms of Service", "disclaimer": "Disclaimer",
}

_PAGE_TEMPLATE = """<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{page_title}</title>
<meta name="description" content="{meta_description}">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="website">
<meta property="og:title" content="{og_title}">
<meta property="og:description" content="{og_desc}">
<meta property="og:site_name" content="{site_name}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{og_title}">
<meta name="twitter:description" content="{og_desc}">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<style>{css}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header><nav>{nav}</nav></header>
<main id="main">{main}</main>
<footer><p>{footer}</p></footer>
</body>
</html>"""

_STYLE_CSS = """
:root{--bg:#f8fafc;--fg:#0f172a;--accent:#4f46e5;--muted:#64748b;--card:#ffffff;--border:#e2e8f0}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
background:var(--bg);color:var(--fg);line-height:1.6}
.skip{position:absolute;left:-9999px;top:0;background:var(--accent);color:#fff;padding:.5rem 1rem;z-index:10}
.skip:focus{left:0}
header{background:var(--card);border-bottom:1px solid var(--border);position:sticky;top:0}
nav{max-width:960px;margin:0 auto;padding:.75rem 1rem;display:flex;flex-wrap:wrap;gap:.25rem 1rem}
nav a{color:var(--fg);text-decoration:none;font-weight:500;padding:.25rem 0}
nav a:hover{color:var(--accent);text-decoration:underline}
main{max-width:960px;margin:2rem auto;padding:0 1rem}
.hero{padding:2rem 0 1rem}
h1{font-size:2rem;margin:0 0 .5rem}h2{font-size:1.35rem;margin-top:2rem}
.tagline{font-size:1.15rem;color:var(--muted);margin:0}
section{margin:1.5rem 0}
label{display:block;font-weight:600;margin-bottom:.35rem}
textarea{width:100%;min-height:120px;padding:.6rem;border:1px solid var(--border);border-radius:8px;
font:inherit;background:#fff}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:.6rem 1.4rem;
font:inherit;font-weight:600;cursor:pointer;margin:.5rem 0}
button:hover{filter:brightness(1.1)}button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
pre{background:#0f172a;color:#e2e8f0;padding:1rem;border-radius:8px;overflow:auto;min-height:60px}
.local-note{color:var(--muted);font-size:.9rem}
footer{border-top:1px solid var(--border);margin-top:3rem;padding:1.5rem 1rem;text-align:center;color:var(--muted)}
footer p{margin:0;font-size:.9rem}
@media (max-width:640px){h1{font-size:1.6rem}}
"""

_WEBAPP_APP = '''"""Generated by the Autonomous Product Factory — {name}."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from fastapi import FastAPI, HTTPException

app = FastAPI(title="{name}", description="{tagline}")
DB = Path("__appname__.db")


def _conn() -> sqlite3.Connection:
    con = sqlite3.connect(DB)
    con.execute("CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT)")
    return con


FEATURES = {features}


@app.get("/")
def home():
    return {{"name": "{name}", "tagline": "{tagline}", "features": FEATURES}}


@app.get("/health")
def health():
    return {{"status": "ok"}}


@app.post("/api/usage")
def record_usage():
    con = _conn()
    con.execute("INSERT INTO usage (ts) VALUES (datetime('now'))")
    con.commit()
    con.close()
    return {{"ok": True}}


@app.get("/api/usage/count")
def usage_count():
    con = _conn()
    row = con.execute("SELECT COUNT(*) FROM usage").fetchone()
    con.close()
    return {{"count": row[0] if row else 0}}
'''

_WEBAPP_TEST = '''import unittest
import tempfile
import os

os.environ.setdefault("TESTING", "1")


class TestWebapp(unittest.TestCase):
    def test_app_imports_and_routes(self):
        import app as product_app
        self.assertTrue(hasattr(product_app, "app"))
        routes = {{getattr(r, "path", "") for r in product_app.app.routes}}
        self.assertIn("/", routes)
        self.assertIn("/health", routes)


if __name__ == "__main__":
    unittest.main()
'''

_API_APP = '''"""Generated API — {name}."""
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI(title="{name}", description="{tagline}")
FEATURES = {features}


@app.get("/")
def index():
    return {{"name": "{name}", "features": FEATURES}}


@app.get("/health")
def health():
    return {{"status": "ok"}}


@app.get("/api/echo")
def echo(text: str = ""):
    return {{"length": len(text), "text": text[:500]}}
'''

_ICON_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
             '<rect width="128" height="128" rx="24" fill="#4f46e5"/>'
             '<text x="64" y="84" font-size="56" text-anchor="middle" fill="#fff" font-family="sans-serif">&#9881;</text>'
             '</svg>')