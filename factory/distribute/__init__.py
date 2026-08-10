"""Distribution system."""

from .adapters import ALL_ADAPTERS
from .registry import Distributor, PlatformRegistry

__all__ = ["PlatformRegistry", "Distributor", "ALL_ADAPTERS"]