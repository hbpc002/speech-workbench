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
        # Providers quote the failed request back, header included.
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