"""Opportunity scoring — rule-based heuristics, fully transparent.

The scoring model deliberately combines *signal from the trend itself* with
*eligibility signals* (risk penalties), because the factory must prefer the
highest-quality opportunity, not the most viral topic.

Weights come from ``factory.json -> scoring``. All sub-scores are 0-100.
Total = weighted sum of positive dimensions minus risk penalties, then
clamped to 0-100. ``eligible`` is False when legal/security risk is high.
"""

from __future__ import annotations

import re
from typing import Any

from ..config import Config

# Keyword banks (documented heuristics — not claims about real search volume).
_PROBLEM_PATTERNS = [
    r"how do i", r"how to", r"tired of", r"keep getting", r"can't find",
    r"stop (losing|wasting|fighting)", r"help me", r"workaround", r"fix",
    r"annoying", r"pain", r"manage (my|the)", r"organize", r"track",
]
_DEMAND_PATTERNS = [r"alternative", r"free", r"open source", r"vs ", r"compare", r"best "]
_BUILDABLE_PATTERNS = [
    r"tool", r"generator", r"converter", r"checker", r"validator", r"formatter",
    r"tracker", r"dashboard", r"reminder", r"calculator", r"scraper", r"cli",
    r"extension", r"api", r"parser", r"viewer", r"editor",
]
_MONETIZE_PATTERNS = [r"for developers", r"saas", r"productivity", r"business", r"marketing"]
_LONGTERM_PATTERNS = [r"tracker", r"manager", r"library", r"framework", r"template", r"guide"]

# Content that must NEVER be built (legal/compliance risk ⇒ suppression).
_FORBIDDEN = [
    r"crack", r"keygen", r"hack (facebook|instagram|whatsapp|account)", r"stolen",
    r"counterfeit", r"plagiar", r"cheat (exam|test|game)", r"buy (followers|views|likes)",
    r"fake (reviews|news|id)", r"gambl", r"casino", r"loan shark", r"get rich quick",
    r"cryptocurrency invest", r"pump and dump", r"adult ", r"escort", r"anabolic",
    r"steroid", r"weapons", r"cheap (cigarettes|vape)", r"replica",
]
# Higher-risk categories: buildable, but the plan must include mitigations.
_RISKY = [
    r"(collect|scrape|harvest) (emails|personal|data)", r"keylogger", r"spyware",
    r"surveillance", r"bypass (paywall|captcha)", r"unlock (netflix|spotify|premium)",
]
_LEGAL = re.compile(r"|".join(_FORBIDDEN), re.IGNORECASE)
_RISK_RE = re.compile(r"|".join(_RISKY), re.IGNORECASE)


def _hits(text: str, patterns: list[str]) -> int:
    return sum(1 for p in patterns if re.search(p, text, re.IGNORECASE))


def score_trend(trend: dict[str, Any], config: Config) -> dict[str, Any]:
    """Score one normalized trend item. Returns an opportunity dict."""
    title = str(trend.get("title", ""))
    summary = str(trend.get("summary", ""))
    blob = f"{title} {summary}"
    source_heat = int(trend.get("score_0_100") or 40)

    s = config.section("scoring")
    user_need = min(100, 45 + _hits(blob, _PROBLEM_PATTERNS) * 12)
    search_demand = min(100, max(30, source_heat) + _hits(blob, _DEMAND_PATTERNS) * 5)
    competition_gap = min(100, 50 + _hits(blob, _BUILDABLE_PATTERNS) * 6 - source_heat // 20)
    buildability = min(100, 55 + _hits(blob, _BUILDABLE_PATTERNS) * 8)
    monetization = min(100, 35 + _hits(blob, _MONETIZE_PATTERNS) * 12)

    legal_risk = 100 if _LEGAL.search(blob) else 0
    security_risk = 90 if _RISK_RE.search(blob) else 0
    platform_risk = 100 if legal_risk else 0

    positive = (
        user_need * float(s.get("user_need", 0.25))
        + search_demand * float(s.get("search_demand", 0.15))
        + competition_gap * float(s.get("competition_gap", 0.15))
        + buildability * float(s.get("buildability", 0.20))
        + monetization * float(s.get("monetization", 0.10))
    )
    penalties = (
        legal_risk * float(s.get("legal_risk_penalty", 0.20))
        + security_risk * float(s.get("security_risk_penalty", 0.10))
        + platform_risk * float(s.get("platform_risk_penalty", 0.10))
    )
    total = max(0.0, min(100.0, positive - penalties))

    flags: list[str] = []
    if legal_risk:
        flags.append("legal_risk")
    if security_risk:
        flags.append("security_risk")

    return {
        "trend": trend,
        "scores": {
            "user_need": round(user_need, 1),
            "search_demand": round(search_demand, 1),
            "competition_gap": round(competition_gap, 1),
            "buildability": round(buildability, 1),
            "monetization": round(monetization, 1),
            "risk_penalties": round(penalties, 1),
        },
        "total": round(total, 1),
        "eligible": legal_risk == 0,  # legal/security safety gate (not a quality bar)
        "meets_min_score": total >= int(config.get("trends", "min_score", 30)),
        "risk_flags": flags,
    }


def score_opportunities(trends: list[dict[str, Any]], config: Config) -> list[dict[str, Any]]:
    """Score all trends and return opportunities sorted by total score.

    Safety gate: items with legal/security risk are dropped loudly, never
    built. The min-score floor is a *selection* hint, not a hard rejection:
    on a slow day the best opportunity is still returned (flagged) so the
    factory keeps producing rather than starving.
    """
    from ..logging_setup import log_event

    opps = [score_trend(t, config) for t in trends]
    at_floor = [o for o in opps if o["eligible"]]
    below_floor = [o for o in opps if o["eligible"] and not o["meets_min_score"]]
    ineligible = [o for o in opps if not o["eligible"]]
    for o in ineligible:
        log_event(
            "scoring",
            "warning",
            f"Opportunity suppressed (legal-risk): {o['trend'].get('title', '?')[:100]}",
        )
    at_floor.sort(key=lambda o: o["total"], reverse=True)
    selected = at_floor[:1]
    if selected and not selected[0]["meets_min_score"]:
        log_event(
            "scoring",
            "info",
            "Best opportunity is below the min-score floor — proceeding with the "
            "top scorer (heuristic floor, not a safety gate)",
        )
        selected[0]["below_min_score"] = True
    return at_floor