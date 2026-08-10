"""Groq chat-completions client (stdlib urllib) + deterministic mock.

Design notes
------------
* The API key is read from ``os.environ["GROQ_API_KEY"]`` at call time and is
  never stored, logged, or written into any artifact.
* Requests are retried on transient failures (429/5xx/network) with backoff.
* ``json_mode=True`` requests ``response_format={"type":"json_object"}`` so we
  can parse structured specs/reports deterministically.
* A request budget (``config.budget("max_ai_requests")``) hard-caps spend.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

from ..config import Config
from ..utils import http_post_json

JSON_SYSTEM = (
    "You are the engineering brain of an autonomous software factory. "
    "Respond with ONLY a valid JSON object. No markdown, no commentary."
)


class AIError(Exception):
    """Base class for AI-layer failures."""


class AIUnavailable(AIError):
    """No API key configured (and mock mode is off)."""


class AIBudgetExceeded(AIError):
    """Per-run AI request budget exhausted."""


class AIRateLimited(AIError):
    """Provider rate limit with a reset window too long to wait for."""


class GroqAIClient:
    """Minimal Groq client using urllib — no third-party dependencies."""

    provider = "groq"

    def __init__(self, config: Config):
        self.config = config
        self.model = config.get("ai", "model", "llama-3.3-70b-versatile")
        self.base_url = config.get(
            "ai", "base_url", "https://api.groq.com/openai/v1/chat/completions"
        )
        self.timeout = float(config.get("ai", "timeout_seconds", 90))
        self.retries = int(config.get("ai", "retries", 2))
        self.requests_used = 0

    def complete(
        self,
        user: str,
        system: str | None = None,
        json_mode: bool = False,
        max_tokens: int = 4096,
        task: str = "generic",
    ) -> str:
        budget = self.config.budget("max_ai_requests", 30)
        if self.requests_used >= budget:
            raise AIBudgetExceeded(f"AI request budget ({budget}) exhausted for this run")
        self.requests_used += 1

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system or JSON_SYSTEM if json_mode else (system or "")},
                {"role": "user", "content": user},
            ],
            "temperature": 0.4,
            "max_tokens": max_tokens,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        headers = {
            "Authorization": f"Bearer {os.environ['GROQ_API_KEY']}",
            "Content-Type": "application/json",
        }

        last_err: AIError | None = None
        for attempt in range(self.retries + 1):
            try:
                data = http_post_json(self.base_url, payload, headers, self.timeout, retries=0)
                return str(data["choices"][0]["message"]["content"])
            except Exception as e:  # noqa: BLE001 — normalized below
                status = getattr(e, "status", 0)
                body = getattr(e, "body", "") or str(e)
                if status == 429 and "reset" in body.lower():
                    raise AIRateLimited("Groq rate limited with long reset window") from e
                if status in (400, 401, 403):
                    raise AIError(f"Groq rejected request (HTTP {status}) — check API key/model") from e
                last_err = AIError(f"Groq request failed (attempt {attempt + 1}): {body[:200]}")
                if attempt < self.retries:
                    time.sleep(2 * (attempt + 1))
        raise last_err or AIError("Groq request failed")

    def complete_json(
        self, user: str, system: str | None = None, max_tokens: int = 4096, task: str = "generic"
    ) -> dict[str, Any]:
        text = self.complete(user, system=system, json_mode=True, max_tokens=max_tokens, task=task)
        return _parse_json(text, task)


class MockAIClient:
    """Deterministic offline fake. Output is clearly labeled and only used
    for pipeline testing (``FACTORY_MOCK_AI=1``)."""

    provider = "mock"

    def __init__(self, config: Config):
        self.config = config
        self.requests_used = 0

    def complete(
        self,
        user: str,
        system: str | None = None,
        json_mode: bool = False,
        max_tokens: int = 4096,
        task: str = "generic",
    ) -> str:
        budget = self.config.budget("max_ai_requests", 30)
        if self.requests_used >= budget:
            raise AIBudgetExceeded(f"AI request budget ({budget}) exhausted for this run")
        self.requests_used += 1
        if json_mode:
            return json.dumps(_mock_json(task, user))
        return f"[MOCK AI — offline test output for task '{task}'; not real generated content]"

    def complete_json(
        self, user: str, system: str | None = None, max_tokens: int = 4096, task: str = "generic"
    ) -> dict[str, Any]:
        budget = self.config.budget("max_ai_requests", 30)
        if self.requests_used >= budget:
            raise AIBudgetExceeded(f"AI request budget ({budget}) exhausted for this run")
        self.requests_used += 1
        return _mock_json(task, user)


def _mock_json(task: str, user: str) -> dict[str, Any]:
    """Canned-but-valid responses per planner/builder task."""
    if task == "plan_spec":
        return {
            "name": "Dev Toolbox",
            "tagline": "Free browser tools for developers: checkers, converters, and validators.",
            "problem": "Developers switch between many small utility sites that are slow, ad-heavy, and unreliable.",
            "users": "Developers, students, QA engineers",
            "product_type": "static_site",
            "features": [
                {"name": "URL checker", "description": "Validate and normalize a URL."},
                {"name": "Case converter", "description": "Convert text between cases."},
            ],
            "pages": ["home", "tools", "about", "contact", "privacy", "terms", "disclaimer"],
            "monetization_model": "display ads (future) + no paywall",
            "tech_stack": ["python", "html", "css", "js"],
            "risks": ["low differentiation without unique tooling"],
        }
    if task == "page_content":
        return {
            "home": {
                "title": "Dev Toolbox — fast, free developer utilities",
                "summary": "Quick browser tools for everyday developer chores. No sign-up, no tracking, no paywall.",
                "sections": [
                    {"heading": "Why Dev Toolbox",
                     "body": "Small utilities should be instant. Dev Toolbox runs entirely in your browser: "
                             "nothing is uploaded, nothing is stored, and there is no account to create. "
                             "Every tool opens in less than a second and works offline after the page loads. "
                             "Compare that with the typical utility site: slow pages, intrusive ads, and "
                             "download buttons that do not do what they claim. This site exists to make the "
                             "boring, repeatable chores of development take one tab instead of five."},
                    {"heading": "What you can do here",
                     "body": "Check whether a URL is well-formed, convert text between common cases, and "
                             "more. The full list is in the navigation. Each tool shows its input, runs "
                             "instantly, and explains what it is doing, so nothing feels like a black box."},
                    {"heading": "How it works",
                     "body": "All processing happens with plain browser-side code. Open the page, paste "
                             "your input, press Run, and the result appears next to your input. You can "
                             "re-run the same tool on new input as often as you like — there is no queue, "
                             "no quota, and no data leaves your device at any point. Because the logic "
                             "is a few hundred lines of ordinary JavaScript, it is easy to read, easy "
                             "to review, and easy to trust: there is no black-box server deciding what "
                             "you may or may not do with your own data."},
                ],
            },
            "tools": {
                "title": "All tools",
                "summary": "Every browser-side utility available on Dev Toolbox, with a short description of each.",
                "sections": [
                    {"heading": "URL checker",
                     "body": "Validates and normalizes a URL: protocol, host, path, and optional query "
                             "string. Useful before you paste a link into an API call, a config file, or "
                             "a ticket to make sure it is syntactically correct."},
                    {"heading": "Case converter",
                     "body": "Converts pasted text between snake_case, camelCase, kebab-case, UPPER CASE, "
                             "and title case. Handy for renaming variables, generating constants, and "
                             "normalizing data from different sources."},
                    {"heading": "Coming next",
                     "body": "More utilities are added as they become genuinely useful. If there is a "
                             "small, boring task you do several times a week, the contact page is the "
                             "right place to suggest it."},
                ],
            },
            "about": {
                "title": "About Dev Toolbox",
                "summary": "A small, honest utility site built to save developers time.",
                "sections": [
                    {"heading": "What this is",
                     "body": "Dev Toolbox is an independent collection of browser-side developer utilities. "
                             "It was built as a real-world exercise in automated product development: the "
                             "site, its pages, and its tests were generated and verified by an autonomous "
                             "software factory, then reviewed by a human before release. The running site "
                             "is no different from any hand-written utility page — plain HTML, CSS, and "
                             "browser JavaScript, with no frameworks to load and no analytics to inflate "
                             "the page size."},
                    {"heading": "Why it exists",
                     "body": "Most developer utility sites are cluttered, slow, and full of tracking. "
                             "A small tool should load instantly and get out of the way. Everything here "
                             "runs locally in the browser, which is also a privacy win: your input never "
                             "needs to cross the network, so there is nothing to log, leak, or sell."},
                    {"heading": "The maintainers",
                     "body": "This project is maintained as a side effort. Feature requests and bug "
                             "reports are read and answered as time allows, which is also why each tool "
                             "is kept small and reviewable: a tiny codebase is easier to keep correct "
                             "than a sprawling one. Every change is tested before it ships, and the "
                             "tool source is linked from each page so anyone can verify what actually "
                             "runs in their browser. That transparency matters more than scale: a "
                             "utility that cannot be audited is not a utility worth recommending to "
                             "a team."},
                ],
            },
            "contact": {
                "title": "Contact",
                "summary": "Reach the Dev Toolbox maintainer with feedback or bug reports.",
                "sections": [
                    {"heading": "Get in touch",
                     "body": "Feedback and bug reports are welcome. The fastest way is to open an issue "
                             "in the project repository on GitHub, where every suggestion is visible "
                             "and can be tracked to completion. Please include the tool name, your "
                             "browser and version, and a short example of the input that caused the "
                             "problem. Screenshots of odd behavior help too."},
                    {"heading": "What happens next",
                     "body": "Issues are triaged on a best-effort basis. Reproducible bugs affecting "
                             "correctness are prioritized; cosmetic suggestions are batched into "
                             "releases. Since the tools run entirely in the browser, most requests "
                             "never need to wait on server-side changes at all."},
                    {"heading": "Keeping it respectful",
                     "body": "This is a small, free project. Please keep reports factual and constructive. "
                             "Politeness costs nothing and makes maintenance sustainable."},
                ],
            },
        }
    if task == "legal_pages":
        # Intentionally empty: the builder's AI-legal path must fall back to
        # the long, truthful minimal policy — matching what happens when a
        # real AI call fails or returns unusable copy.
        return {}
    if task == "seo_meta":
        return {"description": "Free developer utilities that run in your browser: URL checker, case converter, and more. No sign-up, no tracking."}
    if task == "repair_fix":
        return {"diagnosis": "Mock repair: no issue detected.", "fix": "No change required."}
    if task == "content_review":
        return {"verdict": "pass", "notes": "Content is original and purposeful (mock review)."}
    if task == "postmortem":
        return {"lessons": ["Pipeline works end-to-end in mock mode."], "should_reuse": ["stdlib-only design"]}
    if task == "social_posts":
        return {
            "telegram": "New free developer tool: Dev Toolbox. Fast browser utilities, no sign-up.",
            "devto": "I built a no-dependency static utility site generator as part of an autonomous product factory experiment.",
            "discord": "New: Dev Toolbox — free browser-based developer utilities, no tracking.",
        }
    return {"ok": True, "task": task}


def _parse_json(text: str, task: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
        raise ValueError("expected JSON object")
    except (json.JSONDecodeError, ValueError) as e:
        raise AIError(f"AI returned invalid JSON for task '{task}': {e}") from e


def get_client(config: Config):
    """Factory for the AI client. Raises AIUnavailable when neither a key nor
    mock mode is available — callers must handle that explicitly (the pipeline
    blocks with a clear message instead of guessing)."""
    if config.mock_ai:
        return MockAIClient(config)
    if not config.groq_configured():
        raise AIUnavailable(
            "GROQ_API_KEY is not set. Add it to the environment (or a GitHub "
            "Actions secret) or set FACTORY_MOCK_AI=1 for offline pipeline tests."
        )
    return GroqAIClient(config)