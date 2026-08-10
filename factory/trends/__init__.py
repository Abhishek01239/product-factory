"""Trend discovery + opportunity scoring."""

from .scout import TrendScout
from .scoring import score_opportunities

__all__ = ["TrendScout", "score_opportunities"]