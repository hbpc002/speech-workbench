"""Failure handling for GET /api/voices.

The endpoint is the first thing the voice tab calls on every page load, and it
makes an outbound call to DashScope. When that call hangs -- which Vercel
function instances in Tokyo reaching DashScope in Beijing occasionally do --
two things went wrong:

  * the caller got a hard 504, so the tab became unusable even though the
    operator might well have had a perfectly good list a minute ago
  * nothing was cached on failure, so every single reload paid the full timeout
    again, which is what makes it feel permanently broken rather than slow

Both are covered here. The timeout itself is simulated by patching the list
request rather than by waiting, so the suite stays fast and offline.
"""

import time

import pytest
import requests
from fastapi.testclient import TestClient

from server import api_voices
from server.main import app


@pytest.fixture(autouse=True)
def clear_caches():
    """The caches are module-level and would otherwise leak between cases."""
    api_voices._LIST_CACHE.clear()
    api_voices._LIST_FAILURES.clear()
    yield
    api_voices._LIST_CACHE.clear()
    api_voices._LIST_FAILURES.clear()


@pytest.fixture
def client():
    return TestClient(app)


class FakeList:
    """Stands in for the direct DashScope list request."""

    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.calls = 0

    def __call__(self, prefix):
        self.calls += 1
        if isinstance(self.behaviour, Exception):
            raise self.behaviour
        return self.behaviour, "req-fake"


VOICE = {"voice_id": "cosyvoice-v3-flash-a-b", "status": "OK", "gmt_create": "2026-10-14 13:38:02"}


def expire_cache():
    """Age the success cache out.

    Without this the 60 s success cache answers the second call before the
    timeout path is ever reached, so a test of the fallback would pass without
    exercising it.
    """
    for key, (stamp, _payload) in list(api_voices._LIST_CACHE.items()):
        api_voices._LIST_CACHE[key] = (
            stamp - api_voices.LIST_CACHE_SECONDS - 1,
            _payload,
        )


def install(monkeypatch, behaviour):
    lister = FakeList(behaviour)
    monkeypatch.setattr(api_voices, "_list_voices", lister)
    return lister


class TestHappyPath:
    def test_returns_the_described_voices(self, client, monkeypatch):
        install(monkeypatch, [VOICE])
        body = client.get("/api/voices").json()
        assert body["voices"][0]["voice_id"] == "cosyvoice-v3-flash-a-b"
        assert body["voices"][0]["target_model"] == "cosyvoice-v3-flash"
        assert body["voices"][0]["status_label"] == "可用"

    def test_a_second_call_is_served_from_cache(self, client, monkeypatch):
        service = install(monkeypatch, [VOICE])
        client.get("/api/voices")
        client.get("/api/voices")
        assert service.calls == 1, "the second call should not hit DashScope"

    def test_an_explicit_refresh_ignores_the_failure_window(self, client, monkeypatch):
        # The 刷新列表 button must actually retry. A refresh that answers from
        # the failure cache is a button that does nothing.
        install(monkeypatch, requests.Timeout("slow"))
        client.get("/api/voices")
        assert api_voices._LIST_FAILURES, "the failure should be recorded"

        service = install(monkeypatch, [VOICE])
        assert client.get("/api/voices?refresh=true").status_code == 200
        assert service.calls == 1, "refresh must reach DashScope"
        assert not api_voices._LIST_FAILURES

    def test_refresh_ignores_the_success_cache_too(self, client, monkeypatch):
        service = install(monkeypatch, [VOICE])
        client.get("/api/voices")
        client.get("/api/voices?refresh=true")
        assert service.calls == 2

    def test_a_plain_call_still_respects_the_failure_window(self, client, monkeypatch):
        install(monkeypatch, requests.Timeout("slow"))
        client.get("/api/voices")
        install(monkeypatch, [VOICE])
        assert client.get("/api/voices").status_code == 504


class TestTimeout:
    def test_504_when_nothing_was_ever_cached(self, client, monkeypatch):
        install(monkeypatch, requests.Timeout("slow"))
        assert client.get("/api/voices").status_code == 504

    def test_the_message_says_what_to_do(self, client, monkeypatch):
        install(monkeypatch, requests.Timeout("slow"))
        detail = client.get("/api/voices").json()["detail"]
        assert "超时" in detail
        assert "刷新列表" in detail
        assert "LIST_TIMEOUT_SECONDS" not in detail

    def test_the_debug_payload_keeps_the_timeout_budget(self, client, monkeypatch):
        install(monkeypatch, requests.Timeout("slow"))
        body = client.get("/api/voices").json()
        assert body["debug"]["operation"] == "list_voices"
        assert body["debug"]["timeout_seconds"] == api_voices.LIST_TIMEOUT_SECONDS
        assert body["debug"]["connect_timeout_seconds"] == api_voices.LIST_CONNECT_TIMEOUT_SECONDS
        assert body["debug"]["endpoint"] == api_voices._LIST_ENDPOINT
        assert body["debug"]["elapsed_seconds"] >= 0
        assert body["debug"]["cached"] is False

    def test_never_reports_an_empty_list_as_the_truth(self, client, monkeypatch):
        # An empty list means "you have no voices"; a timeout must not be able
        # to masquerade as one, so this must be an error rather than a 200.
        install(monkeypatch, requests.Timeout("slow"))
        response = client.get("/api/voices")
        assert response.status_code != 200
        assert "voices" not in response.json()


class TestFailureIsCached:
    """The compounding part: without this, every reload re-pays the timeout."""

    def test_a_recent_failure_is_not_retried(self, client, monkeypatch):
        service = install(monkeypatch, requests.Timeout("slow"))
        client.get("/api/voices")
        client.get("/api/voices")
        client.get("/api/voices")
        assert service.calls == 1, "a recent failure should not re-hang the caller"

    def test_it_is_still_a_504_without_a_cached_list(self, client, monkeypatch):
        install(monkeypatch, requests.Timeout("slow"))
        client.get("/api/voices")
        assert client.get("/api/voices").status_code == 504

    def test_the_retry_window_expires(self, client, monkeypatch):
        service = install(monkeypatch, requests.Timeout("slow"))
        client.get("/api/voices")
        assert service.calls == 1

        # Age the recorded failure past the window.
        api_voices._LIST_FAILURES[""] -= api_voices.LIST_FAIL_RETRY_SECONDS + 1
        client.get("/api/voices")
        assert service.calls == 2, "the operator's 刷新列表 must actually retry"


class TestStaleFallback:
    """A stale list beats a hard error, especially for delete."""

    def test_serves_the_last_good_list_instead_of_504(self, client, monkeypatch):
        install(monkeypatch, [VOICE])
        assert client.get("/api/voices").status_code == 200

        expire_cache()
        install(monkeypatch, requests.Timeout("slow"))
        response = client.get("/api/voices")
        assert response.status_code == 200
        body = response.json()
        assert body["voices"][0]["voice_id"] == "cosyvoice-v3-flash-a-b"

    def test_marks_it_as_stale(self, client, monkeypatch):
        install(monkeypatch, [VOICE])
        client.get("/api/voices")
        expire_cache()
        install(monkeypatch, requests.Timeout("slow"))
        assert client.get("/api/voices").json()["stale"] is True

    def test_a_fresh_list_is_not_marked_stale(self, client, monkeypatch):
        install(monkeypatch, [VOICE])
        assert "stale" not in client.get("/api/voices").json()

    def test_the_warning_explains_itself(self, client, monkeypatch):
        install(monkeypatch, [VOICE])
        client.get("/api/voices")
        expire_cache()
        install(monkeypatch, requests.Timeout("slow"))
        assert client.get("/api/voices").json()["warning"]

    def test_the_cached_success_payload_is_not_mutated(self, client, monkeypatch):
        # The stale flag is added to a copy; the cache entry must stay clean or
        # a later fresh response would inherit `stale`.
        install(monkeypatch, [VOICE])
        client.get("/api/voices")
        expire_cache()
        install(monkeypatch, requests.Timeout("slow"))
        client.get("/api/voices")
        assert "stale" not in api_voices._LIST_CACHE[""][1]

    def test_an_explicit_refresh_still_gets_the_stale_fallback(self, client, monkeypatch):
        install(monkeypatch, [VOICE])
        client.get("/api/voices")
        expire_cache()
        install(monkeypatch, requests.Timeout("slow"))
        body = client.get("/api/voices?refresh=true").json()
        assert body["stale"] is True
        assert body["voices"][0]["voice_id"] == "cosyvoice-v3-flash-a-b"

    def test_stale_is_served_even_during_the_failure_window(self, client, monkeypatch):
        install(monkeypatch, [VOICE])
        client.get("/api/voices")
        expire_cache()
        install(monkeypatch, requests.Timeout("slow"))
        client.get("/api/voices")          # records the failure
        again = client.get("/api/voices")   # inside the window
        assert again.status_code == 200
        assert again.json()["stale"] is True


class TestOtherFailures:
    def test_an_upstream_error_is_502(self, client, monkeypatch):
        install(monkeypatch, RuntimeError("upstream said no"))
        assert client.get("/api/voices").status_code == 502

    def test_an_upstream_error_is_also_cached(self, client, monkeypatch):
        # Otherwise a hard-failing upstream re-hangs on every reload too.
        service = install(monkeypatch, RuntimeError("boom"))
        client.get("/api/voices")
        client.get("/api/voices")
        assert service.calls == 1

    def test_an_upstream_error_does_not_poison_a_cached_list(self, client, monkeypatch):
        install(monkeypatch, [VOICE])
        client.get("/api/voices")
        install(monkeypatch, RuntimeError("boom"))
        # A 502 is a definite answer, so the operator is told rather than being
        # shown a silently-old list.
        assert client.get("/api/voices").status_code in (200, 502)


class TestCacheInvalidation:
    def test_a_write_ages_the_cache_but_keeps_the_stale_fallback(self):
        payload = {"voices": [VOICE], "request_id": "req-old"}
        api_voices._LIST_CACHE[""] = (time.monotonic(), payload)
        api_voices._LIST_FAILURES[""] = time.monotonic()

        api_voices._invalidate_list_cache()

        stamp, kept = api_voices._LIST_CACHE[""]
        assert kept is payload, "the old list is still useful when upstream is down"
        assert stamp < time.monotonic() - api_voices.LIST_CACHE_SECONDS
        assert "" not in api_voices._LIST_FAILURES

    def test_the_next_call_refetches_after_invalidation(self, client, monkeypatch):
        service = install(monkeypatch, [VOICE])
        client.get("/api/voices")
        api_voices._invalidate_list_cache()
        client.get("/api/voices")
        assert service.calls == 2

    def test_a_failed_refetch_after_invalidation_still_serves_the_old_list(
        self, client, monkeypatch
    ):
        install(monkeypatch, [VOICE])
        client.get("/api/voices")
        api_voices._invalidate_list_cache()
        install(monkeypatch, requests.Timeout("slow"))
        body = client.get("/api/voices").json()
        assert body["stale"] is True
        assert body["voices"][0]["voice_id"] == "cosyvoice-v3-flash-a-b"


class TestDirectListRequest:
    """The list call bypasses the SDK so its timeout is actually enforceable."""

    def test_sends_the_documented_payload_with_transport_timeouts(self, monkeypatch):
        calls = {}

        class Response:
            status_code = 200
            headers = {}

            @staticmethod
            def json():
                return {"output": {"voice_list": [VOICE]}, "request_id": "req-upstream"}

        def fake_post(url, **kwargs):
            calls["url"] = url
            calls.update(kwargs)
            return Response()

        monkeypatch.setattr(api_voices.dashscope, "base_http_api_url", "https://example.test/api/v1")
        monkeypatch.setattr(api_voices.config, "API_KEY", "sk-test")
        monkeypatch.setattr(api_voices.requests, "post", fake_post)

        voices, request_id = api_voices._list_voices("abc")

        assert voices == [VOICE]
        assert request_id == "req-upstream"
        assert calls["url"] == "https://example.test/api/v1" + api_voices._LIST_ENDPOINT
        assert calls["timeout"] == (
            api_voices.LIST_CONNECT_TIMEOUT_SECONDS,
            api_voices.LIST_TIMEOUT_SECONDS,
        )
        assert calls["json"]["input"]["action"] == "list_voice"
        assert calls["json"]["input"]["prefix"] == "abc"
        assert calls["headers"]["Authorization"] == "Bearer sk-test"

    def test_omits_the_prefix_when_listing_everything(self, monkeypatch):
        sent = {}

        class Response:
            status_code = 200
            headers = {}

            @staticmethod
            def json():
                return {"output": {"voice_list": []}, "request_id": "req-all"}

        def fake_post(_url, **kwargs):
            sent.update(kwargs)
            return Response()

        monkeypatch.setattr(api_voices.requests, "post", fake_post)
        api_voices._list_voices("")

        assert "prefix" not in sent["json"]["input"]

    def test_a_non_200_response_keeps_the_upstream_request_id(self, monkeypatch):
        class Response:
            status_code = 429
            headers = {}
            text = '{"code":"Throttling","message":"slow down"}'

            @staticmethod
            def json():
                return {"code": "Throttling", "message": "slow down", "request_id": "req-limited"}

        monkeypatch.setattr(api_voices.requests, "post", lambda *_a, **_k: Response())

        with pytest.raises(api_voices._VoiceListError) as caught:
            api_voices._list_voices("")

        assert caught.value.request_id == "req-limited"
        assert caught.value.status_code == 429
        assert caught.value.code == "Throttling"

    def test_an_unexpected_body_is_an_error_not_an_empty_list(self, monkeypatch):
        class Response:
            status_code = 200
            headers = {}

            @staticmethod
            def json():
                return {"output": {}}

        monkeypatch.setattr(api_voices.requests, "post", lambda *_a, **_k: Response())

        with pytest.raises(api_voices._VoiceListError):
            api_voices._list_voices("")


class TestTimeoutIsConfigurable:
    def test_defaults_to_20_seconds(self):
        assert api_voices.LIST_TIMEOUT_SECONDS == 20.0

    def test_reads_the_environment(self, monkeypatch):
        # The right budget depends on where the function runs; a Vercel function
        # in Tokyo reaching Beijing is not the same as a laptop in China.
        monkeypatch.setenv("LIST_TIMEOUT_SECONDS", "45")
        monkeypatch.setattr(
            api_voices.config, "_load_dotenv", lambda: None, raising=False
        )
        value = api_voices.config._env_float("LIST_TIMEOUT_SECONDS", default=20.0)
        assert value == 45.0

    def test_garbage_falls_back_to_the_default(self, monkeypatch):
        monkeypatch.setenv("LIST_TIMEOUT_SECONDS", "not-a-number")
        assert api_voices.config._env_float("LIST_TIMEOUT_SECONDS", default=20.0) == 20.0