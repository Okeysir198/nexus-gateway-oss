"""Shared fixtures/gating for the nexus-gateway LangChain smoke tests.

Run (from THIS tests/ dir, the edge must be reachable):
    RUN_NEXUS_LIVE=1 NEXUS_API_KEY=<your-virtual-key> uv run pytest -v

Without RUN_NEXUS_LIVE=1 the suite skips. If the edge is unreachable it also
skips (with a clear message) rather than erroring.
"""

import os

import httpx
import pytest

from _client import BASE, KEY

LIVE_ENABLED = os.getenv("RUN_NEXUS_LIVE") == "1"


@pytest.fixture(scope="session")
def proxy():
    """Gate on RUN_NEXUS_LIVE + a fast liveliness probe; yields (base, key)."""
    if not LIVE_ENABLED:
        pytest.skip("Live nexus test — set RUN_NEXUS_LIVE=1 to enable")
    try:
        r = httpx.get(f"{BASE}/health", timeout=5)
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001 — any connection failure ⇒ skip, not error
        pytest.skip(f"nexus-gateway Worker unreachable at {BASE}: {e}")
    return BASE, KEY
