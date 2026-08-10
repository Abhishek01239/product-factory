"""AI inference layer.

Primary provider: Groq (OpenAI-compatible chat completions endpoint).
``FACTORY_MOCK_AI=1`` switches to a deterministic offline fake so the whole
pipeline can be exercised end-to-end without any API key. Mock output is
always labeled in logs and is NEVER used for real production output.
"""

from .client import (
    AIBudgetExceeded,
    AIError,
    AIRateLimited,
    AIUnavailable,
    MockAIClient,
    get_client,
)

__all__ = [
    "get_client",
    "MockAIClient",
    "AIError",
    "AIUnavailable",
    "AIBudgetExceeded",
    "AIRateLimited",
]