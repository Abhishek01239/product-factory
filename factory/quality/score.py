"""Final Product Quality Score — aggregates every audit into one number.

Dimensions (each 0-100):
    usefulness, ux, security, seo, accessibility, performance,
    monetization_readiness, originality
Minus a risk deduction. Thresholds from ``factory.json -> quality``:

    0-59        REJECT
    60-79       REVIEW/IMPROVE (may fix and re-run)
    80-100      ELIGIBLE FOR DEPLOYMENT
"""

from __future__ import annotations

from typing import Any

from ..config import Config


def compute_quality_score(
    sub_scores: dict[str, float],
    config: Config,
    risk_deduction: float = 0.0,
) -> dict[str, Any]:
    """Weights: security/a11y/perf weigh more than marketing-ish dimensions
    because the factory's prime directive is quality and safety."""
    weights = {
        "usefulness": 0.15,
        "ux": 0.10,
        "security": 0.20,
        "seo": 0.10,
        "accessibility": 0.10,
        "performance": 0.10,
        "monetization_readiness": 0.10,
        "originality": 0.15,
    }
    total = 0.0
    breakdown: dict[str, Any] = {}
    for dim, w in weights.items():
        score = float(sub_scores.get(dim, 0.0))
        breakdown[dim] = round(score, 1)
        total += score * w
    total = max(0.0, min(100.0, total - risk_deduction))

    deploy_threshold = int(config.get("quality", "deploy_threshold", 80))
    review_threshold = int(config.get("quality", "review_threshold", 60))

    if total >= deploy_threshold:
        verdict = "ELIGIBLE_FOR_DEPLOYMENT"
    elif total >= review_threshold:
        verdict = "REVIEW_IMPROVE"
    else:
        verdict = "REJECT"

    return {
        "score": round(total, 1),
        "verdict": verdict,
        "breakdown": breakdown,
        "risk_deduction": round(risk_deduction, 1),
        "deploy_threshold": deploy_threshold,
        "review_threshold": review_threshold,
    }


def gates_passed(gate_results: dict[str, Any], require: list[str]) -> dict[str, Any]:
    """Evaluate the deployment gate: every *required* gate must be 'pass'."""
    results: dict[str, str] = {}
    for name in require:
        r = gate_results.get(name)
        if isinstance(r, dict):
            results[name] = str(r.get("status", "fail"))
        else:
            results[name] = "fail"
    all_pass = all(v == "pass" for v in results.values())
    return {"all_pass": all_pass, "gates": results}