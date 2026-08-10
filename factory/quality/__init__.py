"""Quality assurance layer: tests, repair loop, and the audit gates."""

from .score import compute_quality_score, gates_passed

__all__ = ["compute_quality_score", "gates_passed"]