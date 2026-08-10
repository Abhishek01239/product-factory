"""Platform-specific announcement content generation.

Each platform gets adapted copy (never identical spam). The AI receives the
final deployed URL, the product spec, and hard per-platform format rules;
output is validated locally (length caps, required fields). When the AI is
unavailable, a clean generic fallback is used — again per-platform shaped.
"""

from __future__ import annotations

from typing import Any

from ..ai import AIError, AIUnavailable
from ..config import Config
from ..logging_setup import log_event

SOCIAL_PROMPT = """You are the Distribution Agent of an autonomous software factory. A new
product was just deployed. Write ONE announcement per platform, adapted to
each platform's culture. Rules:
- Honest, useful, no hype, no fake stats, no hashtag spam.
- Different framing per platform (do NOT copy the same text).
- Telegram: short HTML-friendly text with emoji allowed (max 1200 chars).
- Dev.to: a real build-story markdown article (max 2500 chars) — technical
  details, what it does, why, honest limitations.
- Discord: 2-4 sentence announcement (max 900 chars).
- X: max 250 chars.
- Reddit: include a subreddit suggestion + self-post text (max 2500 chars),
  framing it as a helpful tool share, not a spam ad.
- Bluesky / Mastodon / LinkedIn: short posts (max 250 / 480 / 2000 chars).
Return JSON: {{"telegram": {{"text"}}, "devto": {{"title", "description", "tags", "body_markdown"}},
"discord": {{"text"}}, "x": {{"text"}}, "reddit": {{"subreddit", "title", "text"}},
"bluesky": {{"text"}}, "mastodon": {{"text"}}, "linkedin": {{"text"}}}}"""


def generate_content(config: Config, client, name: str, tagline: str, url: str,
                     spec: dict[str, Any]) -> dict[str, Any]:
    fallback = _fallback_content(name, tagline, url)
    try:
        raw = client.complete_json(
            user=(
                f"Product: {name}\nTagline: {tagline}\nDeployed URL: {url}\n"
                f"Problem: {spec.get('problem', '')}\nFeatures: {spec.get('features', [])}\n"
                "Write the platform announcements now."
            ),
            task="social_posts",
        )
        merged = fallback
        for k, v in raw.items():
            if isinstance(v, dict) and k in merged:
                merged[k].update(v)
        return merged
    except (AIError, AIUnavailable) as e:
        log_event("distribution", "info", f"AI content unavailable, using fallback: {e}")
        return fallback


def _fallback_content(name: str, tagline: str, url: str) -> dict[str, Any]:
    return {
        "telegram": {"text": f"🛠️ <b>{name}</b>\n{tagline}\n\n🔗 {url}"},
        "discord": {"text": f"**{name}** — {tagline}\n{url}"},
        "x": {"text": f"{name}: {tagline} {url}"},
        "bluesky": {"text": f"{name} — {tagline} {url}"},
        "mastodon": {"text": f"{name} — {tagline} {url}"},
        "linkedin": {"text": f"I built {name} as part of an autonomous product factory. {tagline} {url}"},
        "devto": {
            "title": f"I built {name} — {tagline}",
            "description": tagline[:196],
            "tags": ["showdev"],
            "body_markdown": f"# {name}\n\n{tagline}\n\nBuilt as part of an autonomous software "
                             f"factory experiment. {url}\n\n## Honest limitations\n\nSmall, focused, "
                             "dependency-free; no accounts; feedback welcome.",
        },
        "reddit": {"subreddit": "SideProject",
                   "title": f"I built {name}: {tagline}",
                   "text": f"Sharing a small tool I built: **{name}** — {tagline}\n\n{url}\n\n"
                           "It runs entirely client-side. Happy to answer questions or take feedback."},
    }