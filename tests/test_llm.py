"""The provider transport.

Every case here fakes `requests.post`, so the suite never opens a socket.
"""

import pytest
import requests

from server import config, llm


class FakeResponse:
    def __init__(self, payload=None, status_code=200, text=""):
        self._payload = payload
        self.status_code = status_code
        self.text = text

    @property
    def ok(self):
        return 200 <= self.status_code < 300

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def completion(content="ok"):
    return FakeResponse({"choices": [{"message": {"role": "assistant", "content": content}}]})


@pytest.fixture
def post(monkeypatch):
    """Capture the outbound call and reply with `reply`."""
    calls = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        return reply

    reply = completion()
    monkeypatch.setattr(llm.requests, "post", fake_post)
    fake_post.calls = calls
    return fake_post


class TestResolveModel:
    def test_known_id_is_accepted(self):
        assert llm.resolve_model("smart") == "smart"

    def test_unknown_id_is_rejected(self):
        # Otherwise the browser could name any upstream model it liked.
        with pytest.raises(llm.LLMError) as excinfo:
            llm.resolve_model("some-other-provider/model")
        assert excinfo.value.status_code == 400

    def test_blank_falls_back_to_the_default(self):
        assert llm.resolve_model("") == config.LLM_MODEL
        assert llm.resolve_model(None) == config.LLM_MODEL

    def test_error_names_the_available_models(self):
        with pytest.raises(llm.LLMError) as excinfo:
            llm.resolve_model("nope")
        assert "fast" in excinfo.value.detail
        assert "smart" in excinfo.value.detail


class TestChat:
    def test_returns_the_assistant_text(self, post):
        assert llm.chat([{"role": "user", "content": "hi"}], "fast") == "ok"

    def test_targets_the_configured_openai_endpoint(self, post):
        llm.chat([{"role": "user", "content": "hi"}], "fast")
        call = post.calls[0]
        assert call["url"] == "https://example.invalid/v1/chat/completions"

    def test_sends_the_key_in_the_authorization_header(self, post):
        llm.chat([{"role": "user", "content": "hi"}], "fast")
        assert post.calls[0]["headers"]["Authorization"] == f"Bearer {config.LLM_API_KEY}"

    def test_does_not_stream(self, post):
        # Streaming dialects differ per provider; one JSON body is the contract.
        llm.chat([{"role": "user", "content": "hi"}], "fast")
        assert post.calls[0]["json"]["stream"] is False

    def test_applies_the_configured_timeout(self, post):
        llm.chat([{"role": "user", "content": "hi"}], "fast")
        assert post.calls[0]["timeout"] == config.LLM_TIMEOUT_SECONDS

    def test_caller_can_override_tokens_and_temperature(self, post):
        llm.chat([{"role": "user", "content": "hi"}], "fast", max_tokens=10, temperature=0.9)
        body = post.calls[0]["json"]
        assert body["max_tokens"] == 10
        assert body["temperature"] == 0.9

    def test_unconfigured_reports_503(self, monkeypatch):
        monkeypatch.setattr(config, "LLM_API_KEY", "")
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert excinfo.value.status_code == 503


class TestFailureMapping:
    def test_timeout_becomes_504(self, monkeypatch):
        def boom(*_args, **_kwargs):
            raise requests.Timeout()

        monkeypatch.setattr(llm.requests, "post", boom)
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert excinfo.value.status_code == 504

    def test_unreachable_host_becomes_502(self, monkeypatch):
        def boom(*_args, **_kwargs):
            raise requests.ConnectionError("name resolution failed")

        monkeypatch.setattr(llm.requests, "post", boom)
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert excinfo.value.status_code == 502

    def test_upstream_error_body_never_reaches_the_browser(self, monkeypatch):
        # Providers quote the failed request back, header included. A 401 no
        # longer forwards any of it -- but the paths that do quote the provider's
        # own sentence must still scrub it.
        key = config.LLM_API_KEY
        reply = FakeResponse(
            {"error": {"message": f"invalid header Authorization: Bearer {key}"}},
            status_code=401,
        )
        monkeypatch.setattr(llm.requests, "post", lambda *a, **k: reply)
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert excinfo.value.status_code == 502
        assert key not in excinfo.value.detail

    def test_a_quoted_key_is_scrubbed_on_the_fallback_path(self, monkeypatch):
        # An unmapped status hands the provider's sentence to the browser, so the
        # credential patterns still have to run over it.
        key = config.LLM_API_KEY
        monkeypatch.setattr(
            llm.requests,
            "post",
            lambda *a, **k: FakeResponse(
                {"error": {"message": f"rejected Bearer {key} for this key"}}, status_code=418
            ),
        )
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert key not in excinfo.value.detail
        assert "***" in excinfo.value.detail

    def test_unparseable_body_becomes_502(self, monkeypatch):
        monkeypatch.setattr(llm.requests, "post", lambda *a, **k: FakeResponse(None))
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert excinfo.value.status_code == 502

    def test_missing_choices_becomes_502(self, monkeypatch):
        monkeypatch.setattr(
            llm.requests, "post", lambda *a, **k: FakeResponse({"choices": []})
        )
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert excinfo.value.status_code == 502

    def test_non_streaming_shape_is_read(self, monkeypatch):
        reply = completion("   ")
        monkeypatch.setattr(llm.requests, "post", lambda *a, **k: reply)
        assert llm.chat([], "fast") == "   "

def throttle_body():
    """The shape 百炼 answers a rate-limited account with."""
    return {
        "error": {
            "message": "You have exceeded your current request limit. For details, "
            "see: https://help.aliyun.com/zh/model-studio/error-code#rate-limit",
            "type": "limit_requests",
            "param": None,
            "code": "throttling",
        }
    }


def reply_with(monkeypatch, responses):
    """Answer successive calls with `responses`; repeat the last one forever."""
    calls = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append({"url": url, "json": json, "headers": headers})
        reply = responses[min(len(calls) - 1, len(responses) - 1)]
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(llm.requests, "post", fake_post)
    return calls


class TestUpstreamStatusMapping:
    """Every upstream status the operator can actually do something about.

    The browser used to receive `模型 X 调用失败（HTTP 429）: {"error": {...}}` --
    the provider's JSON envelope, truncated mid-structure at a length nobody reads
    past. These assert it now arrives as one actionable sentence.
    """

    def test_rate_limit_is_passed_through_with_a_retry_hint(self, monkeypatch):
        reply_with(monkeypatch, [FakeResponse(throttle_body(), status_code=429)])
        # Retries are on by default, so let them all run out and inspect the last.
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")

        error = excinfo.value
        assert error.status_code == 429, "throttling is the one status worth passing through"
        assert error.retry_after == llm.RETRY_AFTER_SECONDS
        assert "频率限制" in error.detail
        assert "fast" in error.detail
        assert '{"error"' not in error.detail, "the JSON envelope must not reach the browser"

    def test_rate_limit_names_the_alternative_models(self, monkeypatch):
        # The fix is one click away: a different configured model, or no network.
        reply_with(monkeypatch, [FakeResponse(throttle_body(), status_code=429)])
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert "smart" in excinfo.value.detail
        assert "快速标注" in excinfo.value.detail

    def test_rate_limit_without_alternatives_still_offers_the_offline_path(self, monkeypatch):
        monkeypatch.setattr(config, "LLM_MODELS", [{"id": "fast", "name": "快速"}])
        reply_with(monkeypatch, [FakeResponse(throttle_body(), status_code=429)])
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert "快速标注" in excinfo.value.detail

    @pytest.mark.parametrize(
        "status,expected",
        [(401, "LLM_API_KEY"), (403, "权限"), (404, "LLM_MODELS"), (503, "暂时不可用")],
    )
    def test_other_failures_say_what_to_check(self, monkeypatch, status, expected):
        reply_with(monkeypatch, [FakeResponse({"error": {"message": "nope"}}, status_code=status)])
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert excinfo.value.status_code == 502, "only a throttle is 429"
        assert excinfo.value.retry_after is None
        assert expected in excinfo.value.detail

    def test_odd_status_falls_back_to_the_providers_own_sentence(self, monkeypatch):
        reply_with(
            monkeypatch,
            [FakeResponse({"error": {"message": "model is cooling down"}}, status_code=418)],
        )
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert "model is cooling down" in excinfo.value.detail
        assert '{"error"' not in excinfo.value.detail

    def test_the_envelope_is_truncated_not_the_message(self, monkeypatch):
        reply_with(
            monkeypatch,
            [FakeResponse({"error": {"message": "x" * 500}}, status_code=400)],
        )
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        detail = excinfo.value.detail
        assert len(detail) <= 200, "a dialog is not a log file"
        assert detail.endswith("…")


class TestRetry:
    def test_a_throttle_is_retried_and_then_succeeds(self, monkeypatch):
        calls = reply_with(
            monkeypatch, [FakeResponse(throttle_body(), status_code=429), completion("recovered")]
        )
        assert llm.chat([], "fast") == "recovered"
        assert len(calls) == 2, "one throttle then a success"

    def test_retry_uses_the_configured_backoff(self, monkeypatch):
        monkeypatch.setattr(config, "LLM_RETRY_BACKOFF_SECONDS", 2.0)
        waits = []
        monkeypatch.setattr(llm.time, "sleep", waits.append)
        reply_with(monkeypatch, [FakeResponse(throttle_body(), status_code=429), completion()])
        llm.chat([], "fast")
        # Doubled, plus up to a second of jitter so two tabs do not march in step.
        assert len(waits) == 1
        assert 2.0 <= waits[0] <= 3.0

    def test_upstream_outage_is_retried_too(self, monkeypatch):
        calls = reply_with(monkeypatch, [FakeResponse(None, status_code=502), completion("ok")])
        assert llm.chat([], "fast") == "ok"
        assert len(calls) == 2

    def test_the_gives_up_message_is_the_last_real_one(self, monkeypatch):
        monkeypatch.setattr(config, "LLM_MAX_RETRIES", 1)
        calls = reply_with(monkeypatch, [FakeResponse(throttle_body(), status_code=429)])
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert len(calls) == 2, "the first try plus one retry"
        assert excinfo.value.status_code == 429
        assert "频率限制" in excinfo.value.detail

    def test_a_bad_request_is_not_retried(self, monkeypatch):
        # Retrying a 401 burns quota that is already scarce, and cannot succeed.
        calls = reply_with(monkeypatch, [FakeResponse(None, status_code=401)])
        with pytest.raises(llm.LLMError):
            llm.chat([], "fast")
        assert len(calls) == 1

    def test_a_timeout_is_not_retried(self, monkeypatch):
        # 120s each, three in a row is 360s, and a Vercel function dies at 300s --
        # the retry would turn a readable error into no response at all.
        calls = reply_with(monkeypatch, [requests.Timeout()])
        with pytest.raises(llm.LLMError) as excinfo:
            llm.chat([], "fast")
        assert len(calls) == 1
        assert excinfo.value.status_code == 504

    def test_a_connection_error_is_retried(self, monkeypatch):
        calls = reply_with(
            monkeypatch, [requests.ConnectionError("reset"), completion("ok")]
        )
        assert llm.chat([], "fast") == "ok"
        assert len(calls) == 2

    def test_retries_can_be_switched_off(self, monkeypatch):
        monkeypatch.setattr(config, "LLM_MAX_RETRIES", 0)
        calls = reply_with(monkeypatch, [FakeResponse(throttle_body(), status_code=429)])
        with pytest.raises(llm.LLMError):
            llm.chat([], "fast")
        assert len(calls) == 1
