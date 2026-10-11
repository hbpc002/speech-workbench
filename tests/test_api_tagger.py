"""The two tagging endpoints: auth, limits, validation and error mapping."""

import pytest
from fastapi.testclient import TestClient

from server import config, llm, ratelimit
from server.main import app


@pytest.fixture
def client():
    return TestClient(app)


class CannedLLM:
    """Stand-in for llm.chat that replays a fixed reply and records requests."""

    def __init__(self):
        self.reply = "[sad]今天很难过。"
        self.calls = []

    def __call__(self, messages, model, *, max_tokens=None, temperature=None):
        self.calls.append({"messages": messages, "model": model})
        return self.reply


@pytest.fixture
def canned(monkeypatch):
    stub = CannedLLM()
    monkeypatch.setattr(llm, "chat", stub)
    return stub


@pytest.fixture
def no_auth(monkeypatch):
    monkeypatch.setattr(config, "APP_PASSWORD", "")
    monkeypatch.setattr(config, "SESSION_SECRET", "")


class TestAuth:
    def test_tag_requires_a_session(self, client, monkeypatch, canned):
        monkeypatch.setattr(config, "APP_PASSWORD", "hunter2")
        monkeypatch.setattr(config, "SESSION_SECRET", "hunter2")
        assert client.post("/api/tts/tag", json={"text": "你好。"}).status_code == 401

    def test_script_requires_a_session(self, client, monkeypatch, canned):
        monkeypatch.setattr(config, "APP_PASSWORD", "hunter2")
        monkeypatch.setattr(config, "SESSION_SECRET", "hunter2")
        assert client.post("/api/tts/script", json={"topic": "露营"}).status_code == 401

    def test_login_unlocks_it(self, client, monkeypatch, canned):
        monkeypatch.setattr(config, "APP_PASSWORD", "hunter2")
        monkeypatch.setattr(config, "SESSION_SECRET", "hunter2")
        assert client.post("/api/login", json={"password": "hunter2"}).status_code == 200
        assert client.post("/api/tts/tag", json={"text": "你好。"}).status_code == 200


class TestTagEndpoint:
    def test_returns_the_tagged_script(self, client, no_auth, canned):
        response = client.post("/api/tts/tag", json={"text": "今天很难过。"})
        assert response.status_code == 200
        body = response.json()
        assert body["text"] == "[sad]今天很难过。"
        assert body["inserted"] == 1
        assert body["warnings"] == []

    def test_resolves_the_requested_model(self, client, no_auth, canned):
        client.post("/api/tts/tag", json={"text": "你好。", "model": "smart"})
        assert canned.calls[0]["model"] == "smart"

    def test_rejects_an_unknown_model(self, client, no_auth, canned):
        response = client.post("/api/tts/tag", json={"text": "你好。", "model": "evil"})
        assert response.status_code == 400
        assert not canned.calls

    def test_rejects_empty_text(self, client, no_auth, canned):
        assert client.post("/api/tts/tag", json={"text": "   "}).status_code == 400
        assert not canned.calls

    def test_rejects_an_unknown_density(self, client, no_auth, canned):
        response = client.post("/api/tts/tag", json={"text": "你好。", "density": "max"})
        assert response.status_code == 400
        assert not canned.calls

    def test_rejects_oversized_text(self, client, no_auth, canned, monkeypatch):
        monkeypatch.setattr(config, "TAGS_MAX_CHARS", 10)
        response = client.post("/api/tts/tag", json={"text": "一" * 11})
        assert response.status_code == 400
        assert not canned.calls

    def test_defaults_the_density_when_omitted(self, client, no_auth, canned):
        client.post("/api/tts/tag", json={"text": "你好。"})
        assert "每 150 字" in canned.calls[0]["messages"][0]["content"]

    def test_allow_rich_reaches_the_prompt(self, client, no_auth, canned):
        client.post("/api/tts/tag", json={"text": "你好。", "allow_rich": True})
        assert "[sighing]" in canned.calls[0]["messages"][0]["content"]


class TestScriptEndpoint:
    def test_returns_the_script(self, client, no_auth, canned):
        canned.reply = "[excited]今天去露营啦！"
        response = client.post("/api/tts/script", json={"topic": "露营"})
        assert response.status_code == 200
        assert response.json()["text"] == "[excited]今天去露营啦！"

    def test_brief_reaches_the_prompt(self, client, no_auth, canned):
        client.post(
            "/api/tts/script",
            json={"topic": "露营", "duration": "90 秒", "tone": "轻松活泼", "audience": "宝妈"},
        )
        system = canned.calls[0]["messages"][0]["content"]
        assert "露营" in system
        assert "90 秒" in system
        assert "宝妈" in system

    def test_missing_brief_fields_get_defaults(self, client, no_auth, canned):
        client.post("/api/tts/script", json={"topic": "露营"})
        system = canned.calls[0]["messages"][0]["content"]
        assert "60 秒" in system
        assert "亲切自然" in system

    def test_rejects_an_empty_topic(self, client, no_auth, canned):
        assert client.post("/api/tts/script", json={"topic": ""}).status_code == 400
        assert not canned.calls

    def test_accepts_values_outside_the_preset_lists(self, client, no_auth, canned):
        # The browser offers 自定义… for all three, so the server must not
        # validate them against the preset ids.
        canned.reply = "[excited]今天去露营啦！"
        response = client.post(
            "/api/tts/script",
            json={
                "topic": "露营",
                "duration": "2 分半",
                "tone": "像老朋友聊天",
                "audience": "对宠物感兴趣的人",
            },
        )
        assert response.status_code == 200
        system = canned.calls[0]["messages"][0]["content"]
        assert "2 分半" in system
        assert "像老朋友聊天" in system
        assert "对宠物感兴趣的人" in system

    def test_blank_brief_fields_use_the_server_defaults(self, client, no_auth, canned):
        # These must stay in step with the ids in config.TAGS_TONES /
        # TAGS_DURATIONS, otherwise the picker and the fallback disagree.
        client.post("/api/tts/script", json={"topic": "露营"})
        system = canned.calls[0]["messages"][0]["content"]
        assert "60 秒" in system
        assert "亲切自然" in system
        assert "普通听众" in system


class TestUpstreamErrors:
    def test_llm_error_status_is_forwarded(self, client, no_auth, monkeypatch):
        def boom(*_args, **_kwargs):
            raise llm.LLMError(503, "未配置 LLM_API_KEY，文本标注功能不可用")

        monkeypatch.setattr(llm, "chat", boom)
        response = client.post("/api/tts/tag", json={"text": "你好。"})
        assert response.status_code == 503
        assert "LLM_API_KEY" in response.json()["detail"]


class TestRateLimit:
    def test_lockout_after_the_configured_attempts(self, client, no_auth, canned, monkeypatch):
        monkeypatch.setattr(
            ratelimit.TAGGER_LIMITER, "limit", 3, raising=False
        )
        for _ in range(3):
            assert client.post("/api/tts/tag", json={"text": "你好。"}).status_code == 200

        blocked = client.post("/api/tts/tag", json={"text": "你好。"})
        assert blocked.status_code == 429
        assert "Retry-After" in blocked.headers

    def test_limit_is_shared_across_both_endpoints(self, client, no_auth, canned, monkeypatch):
        monkeypatch.setattr(ratelimit.TAGGER_LIMITER, "limit", 2, raising=False)
        assert client.post("/api/tts/tag", json={"text": "你好。"}).status_code == 200
        assert client.post("/api/tts/script", json={"topic": "露营"}).status_code == 200
        assert client.post("/api/tts/tag", json={"text": "你好。"}).status_code == 429

    def test_validation_errors_still_charge_the_budget(self, client, no_auth, canned, monkeypatch):
        # A 400 is still a 400: validation happens before the provider call but
        # the budget is charged first.
        monkeypatch.setattr(ratelimit.TAGGER_LIMITER, "limit", 1, raising=False)
        assert client.post("/api/tts/tag", json={"text": ""}).status_code == 400
        assert client.post("/api/tts/tag", json={"text": "你好。"}).status_code == 429


class TestRouteRegistration:
    def test_both_endpoints_are_mounted(self):
        # The included routers are wrapped, so app.routes alone does not show
        # them; the OpenAPI schema does.
        paths = app.openapi()["paths"]
        assert "/api/tts/tag" in paths
        assert "/api/tts/script" in paths

    def test_websocket_endpoints_are_untouched(self):
        paths = {getattr(r, "path", "") for r in app.routes}
        for name in ("/ws/chat", "/ws/asr", "/ws/tts"):
            assert name in paths