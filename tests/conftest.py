"""Shared fixtures.

The tests must never reach the network and must never depend on whatever is in
the developer's `.env`, so every case that touches credentials patches
`config` directly rather than setting environment variables -- `config` reads
the environment at import time and would need a reload.
"""

import pytest

from server import config, ratelimit


@pytest.fixture(autouse=True)
def deterministic_config(monkeypatch):
    """Pin the LLM settings so a stray .env cannot change what runs."""
    monkeypatch.setattr(config, "LLM_BASE_URL", "https://example.invalid/v1")
    monkeypatch.setattr(config, "LLM_API_KEY", "sk-test-" + "b" * 24)
    monkeypatch.setattr(
        config,
        "LLM_MODELS",
        [{"id": "fast", "name": "快速"}, {"id": "smart", "name": "聪明"}],
    )
    monkeypatch.setattr(config, "LLM_MODEL", "fast")
    monkeypatch.setattr(config, "LLM_TIMEOUT_SECONDS", 5)
    # Retries stay on -- they are part of the behaviour -- but the waits between
    # them do not: without this every failure case sleeps through the production
    # backoff (and a throttled one through 20s), and the suite goes from 2s to
    # minutes. The cases that care about a backoff patch llm.time.sleep and assert
    # on what it was asked for.
    monkeypatch.setattr(config, "LLM_RETRY_BACKOFF_SECONDS", 0.0)
    monkeypatch.setattr(config, "LLM_RATE_LIMIT_BACKOFF_SECONDS", 0.0)
    monkeypatch.setattr(config, "LLM_MAX_RETRIES", 2)
    # Storage too: a developer's .env normally carries a real PUBLIC_BASE_URL
    # (often a tunnel) and sometimes a Blob token, both of which would silently
    # decide which backend the storage tests exercise.
    monkeypatch.setattr(config, "PUBLIC_BASE_URL", "")
    monkeypatch.setattr(config, "BLOB_TOKEN", None)
    monkeypatch.setattr(config, "STORAGE_BACKEND", "auto")
    yield


@pytest.fixture(autouse=True)
def clean_rate_limits():
    """The limiters are module-level singletons, shared across tests otherwise."""
    for limiter in (ratelimit.LOGIN_LIMITER, ratelimit.TAGGER_LIMITER):
        limiter._entries.clear()
        limiter._locked_until.clear()
    yield
    for limiter in (ratelimit.LOGIN_LIMITER, ratelimit.TAGGER_LIMITER):
        limiter._entries.clear()
        limiter._locked_until.clear()