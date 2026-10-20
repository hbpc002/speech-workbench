"""Credential scrubbing.

The LLM key is a second credential that lives alongside the speech key, and
providers quote the failed request -- Authorization header included -- back in
their error bodies. If only the speech key is scrubbed, switching providers
opens a leak.
"""

from server import config, redact


def test_scrubs_the_llm_key_by_verbatim_match():
    key = config.LLM_API_KEY
    assert key
    body = f"401 Unauthorized, sent header: Bearer {key}"
    scrubbed = redact.scrub(body)
    assert key not in scrubbed
    assert "***" in scrubbed


def test_scrubs_a_key_in_a_format_the_patterns_would_miss():
    # No `sk-` prefix, so only the verbatim replacement can catch it.
    monkey = "Qwen-9f2c81ab44de07"  # not matched by any _PATTERNS entry
    from server import config as cfg

    original = cfg.LLM_API_KEY
    try:
        cfg.LLM_API_KEY = monkey
        assert monkey not in redact.scrub(f"detail: {monkey} is invalid")
    finally:
        cfg.LLM_API_KEY = original


def test_still_scrubs_the_speech_key():
    assert "sk-abc123456" not in redact.scrub("invalid Authorization header: Bearer sk-abc123456")


def test_truncates_long_bodies():
    assert len(redact.scrub("x" * 500)) <= redact.MAX_LEN + 1


def test_debug_detail_keeps_long_envelopes_but_still_scrubs():
    key = config.LLM_API_KEY
    body = f"{'context ' * 60}Authorization: Bearer {key} {'tail ' * 60}"
    out = redact.debug_detail(body)
    assert key not in out
    assert len(out) > redact.MAX_LEN
    assert len(out) <= redact.DEBUG_MAX_LEN + 1