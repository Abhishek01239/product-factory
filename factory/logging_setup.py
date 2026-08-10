"""Logging: console + per-run JSONL event log.

Every pipeline stage emits structured events (``{"ts", "stage", "level",
"message", ...}``) via ``log_event``; they land both on the console and in
``runs/<run_id>/events.jsonl`` so a failed run is always diagnosable.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any

from .utils import now_utc, redact

RUN_ID: str = "local"
EVENT_PATH: Path | None = None


def setup_logger(level: int = logging.INFO) -> None:
    root = logging.getLogger("factory")
    if root.handlers:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s | %(message)s", "%H:%M:%S"))
    root.addHandler(handler)
    root.setLevel(level)


def log_event(stage: str, level: str, message: str, **extra: Any) -> None:
    """Structured event — console line + append to the run's JSONL."""
    event = {
        "ts": now_utc(),
        "stage": stage,
        "level": level,
        "message": redact(message),
        **{k: (redact(str(v)) if isinstance(v, str) else v) for k, v in extra.items()},
    }
    getattr(logging.getLogger("factory"), level.lower(), logging.getLogger("factory").info)(
        "[%s] %s", stage, message
    )
    if EVENT_PATH is not None:
        try:
            with open(EVENT_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=False) + "\n")
        except OSError:
            pass


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"factory.{name}")


def bind_run(run_id: str, events_path: Path | None = None) -> None:
    """Point the event logger at a specific run's artifact file."""
    global RUN_ID, EVENT_PATH
    RUN_ID = run_id
    EVENT_PATH = events_path