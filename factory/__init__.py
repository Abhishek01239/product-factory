"""Autonomous Product Factory — modular, stdlib-only Python package.

Pipeline overview (see factory/pipeline.py for the orchestrator):

    trends  ->  planning  ->  build  ->  quality  ->  deploy  ->  distribute  ->  learn

Every stage writes structured JSON events to ``runs/<run_id>/run.json``.
This package deliberately depends only on the Python standard library so it
runs anywhere (local Windows box, Linux CI runners) with zero installs.
"""

__version__ = "1.0.0"