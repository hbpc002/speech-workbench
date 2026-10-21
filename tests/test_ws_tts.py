"""Failure handling for the TTS WebSocket.

The SDK's connect wait is a hardcoded five seconds and its error carries no
request id. These tests pin the things that make that failure actionable:
bounded retries only for a connect timeout, an exponential backoff, a probe
that says whether DNS/TCP/TLS broke, and a scpubbed debug envelope that names
the stage, endpoint, task id and attempt.
"""

import asyncio
import json
from types import SimpleNamespace

import pytest

from server import config, ws_tts


CONNECT_TIMEOUT = TimeoutError(
    "websocket connection could not established within 5s. "
    "Please check your network connection, firewall settings, or server status."
)


class FakeWebSocket:
    def __init__(self):
        self.sent = []
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def receive(self):
        return {
            "type": "websocket.message",
            "text": json.dumps(
                {
                    "type": "tts.synthesize",
                    "text": "你好",
                    "voice": "cosyvoice-v3-flash-demo-abc",
                    "params": {"model": "cosyvoice-v3-flash"},
                }
            ),
        }

    async def send_text(self, text):
        self.sent.append(json.loads(text))


class FakeCallback:
    def __init__(self, _websocket, _loop):
        self.request_id = None
        self.error = None

    async def wait(self):
        return True

    def cancel_pending(self):
        pass


class FakeSynthesizer:
    def __init__(self, failure):
        self.failure = failure
        self.url = "wss://llm-secret123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
        self.model = "cosyvoice-v3-flash"
        self.request = SimpleNamespace(task_id="task-local-1")
        self.closed = False

    def streaming_call(self, _text):
        if self.failure:
            raise self.failure

    def streaming_complete(self):
        pass

    def close(self):
        self.closed = True


def install(monkeypatch, failures):
    created = []

    def fake_build(_voice, _callback, _params):
        failure = failures.pop(0) if failures else None
        synth = FakeSynthesizer(failure)
        created.append(synth)
        return synth

    monkeypatch.setattr(ws_tts, "WebSocketSynthCallback", FakeCallback)
    monkeypatch.setattr(ws_tts, "build_synthesizer", fake_build)
    monkeypatch.setattr(config, "TTS_CONNECT_ATTEMPTS", 3)
    monkeypatch.setattr(config, "TTS_CONNECT_BACKOFF_SECONDS", 0)
    monkeypatch.setattr(config, "TTS_CONNECT_JITTER_SECONDS", 0)
    monkeypatch.setattr(config, "TTS_PROBE_TIMEOUT_SECONDS", 0)
    return created


def synthesize(monkeypatch, failures):
    created = install(monkeypatch, failures)

    async def run():
        await ws_tts._synthesize(
            FakeWebSocket(),
            asyncio.get_running_loop(),
            "你好",
            "cosyvoice-v3-flash-demo-abc",
            {"model": "cosyvoice-v3-flash"},
        )

    asyncio.run(run())
    return created


class TestConnectRetry:
    def test_a_connect_timeout_is_retried(self, monkeypatch):
        created = synthesize(monkeypatch, [CONNECT_TIMEOUT])

        assert len(created) == 2
        assert created[0].closed is True, "the failed connection must be released"
        assert created[1].closed is False

    def test_all_attempts_are_used_before_giving_up(self, monkeypatch):
        created = install(monkeypatch, [CONNECT_TIMEOUT] * 3)

        async def run():
            await ws_tts._synthesize(
                FakeWebSocket(),
                asyncio.get_running_loop(),
                "你好",
                "cosyvoice-v3-flash-demo-abc",
                {"model": "cosyvoice-v3-flash"},
            )

        with pytest.raises(ws_tts._TTSSynthesisError) as caught:
            asyncio.run(run())

        assert len(created) == 3
        assert all(synth.closed for synth in created)
        assert caught.value.debug()["attempt"] == 3
        assert caught.value.debug()["attempts_allowed"] == 3

    def test_a_non_connect_failure_is_not_retried(self, monkeypatch):
        created = install(monkeypatch, [RuntimeError("model not found")])

        async def run():
            await ws_tts._synthesize(
                FakeWebSocket(),
                asyncio.get_running_loop(),
                "你好",
                "cosyvoice-v3-flash-demo-abc",
                {"model": "cosyvoice-v3-flash"},
            )

        with pytest.raises(ws_tts._TTSSynthesisError) as caught:
            asyncio.run(run())

        assert len(created) == 1
        assert created[0].closed is True
        assert caught.value.debug()["stage"] == "synthesize"
        assert caught.value.debug()["attempt"] == 1


class TestDebugEnvelope:
    def test_connect_timeout_carries_context_and_no_credentials(self, monkeypatch):
        monkeypatch.setattr(config, "WORKSPACE_ID", "llm-secret123")
        monkeypatch.setattr(config, "API_KEY", "sk-secret-key-123456")
        secret_timeout = TimeoutError(f"{CONNECT_TIMEOUT} sk-secret-key-123456")
        created = install(monkeypatch, [secret_timeout, secret_timeout, secret_timeout])

        async def run():
            await ws_tts._synthesize(
                FakeWebSocket(),
                asyncio.get_running_loop(),
                "你好",
                "cosyvoice-v3-flash-demo-abc",
                {"model": "cosyvoice-v3-flash"},
            )

        with pytest.raises(ws_tts._TTSSynthesisError) as caught:
            asyncio.run(run())

        debug = caught.value.debug()
        assert debug["operation"] == "tts.synthesize"
        assert debug["stage"] == "upstream_connect"
        assert debug["type"] == "TimeoutError"
        assert debug["model"] == "cosyvoice-v3-flash"
        assert debug["voice"] == "cosyvoice-v3-flash-demo-abc"
        assert debug["task_id"] == "task-local-1"
        assert debug["attempt"] == 3
        assert debug["attempts_allowed"] == 3
        assert debug["sdk_connect_timeout_seconds"] == 5
        assert debug["elapsed_seconds"] >= 0
        assert debug["attempt_elapsed_seconds"] >= 0
        assert len(created) == 3

        serialized = json.dumps(debug, ensure_ascii=False)
        assert "sk-secret-key-123456" not in serialized
        assert "llm-secret123" not in serialized

    def test_the_websocket_error_frame_includes_the_debug(self, monkeypatch):
        error = ws_tts._TTSSynthesisError(
            CONNECT_TIMEOUT,
            stage="upstream_connect",
            model="cosyvoice-v3-flash",
            voice="cosyvoice-v3-flash-demo-abc",
            endpoint="wss://llm-secret123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
            task_id="task-local-1",
            request_id=None,
            attempt=2,
            attempts=2,
            total_elapsed=10.2,
            attempt_elapsed=5.1,
            text_length=2,
        )

        async def boom(*_args, **_kwargs):
            raise error

        monkeypatch.setattr(ws_tts, "_synthesize", boom)
        websocket = FakeWebSocket()

        asyncio.run(ws_tts.handle(websocket))

        assert websocket.accepted is True
        frame = websocket.sent[-1]
        assert frame["type"] == "error"
        assert frame["error"]["debug"]["stage"] == "upstream_connect"
        assert frame["error"]["debug"]["attempt"] == 2
        assert "sk-secret-key" not in json.dumps(frame, ensure_ascii=False)


class TestUpstreamProbe:
    def test_a_reproducible_timeout_reports_the_stage_that_broke(self, monkeypatch):
        created = install(monkeypatch, [CONNECT_TIMEOUT] * 3)

        async def fake_probe(_endpoint, _timeout):
            return {
                "ok": False,
                "stage": "tcp",
                "error": "TCP 握手超过 3s（SYN 被丢弃）",
            }

        monkeypatch.setattr(ws_tts.upstream_probe, "probe", fake_probe)

        async def run():
            await ws_tts._synthesize(
                FakeWebSocket(),
                asyncio.get_running_loop(),
                "你好",
                "cosyvoice-v3-flash-demo-abc",
                {"model": "cosyvoice-v3-flash"},
            )

        with pytest.raises(ws_tts._TTSSynthesisError) as caught:
            asyncio.run(run())

        assert len(created) == 3
        assert caught.value.debug()["upstream_probe"]["stage"] == "tcp"

    def test_a_probe_failure_never_masks_the_synthesis_error(self, monkeypatch):
        install(monkeypatch, [CONNECT_TIMEOUT] * 3)

        async def broken_probe(_endpoint, _timeout):
            raise RuntimeError("probe exploded")

        monkeypatch.setattr(ws_tts.upstream_probe, "probe", broken_probe)

        async def run():
            await ws_tts._synthesize(
                FakeWebSocket(),
                asyncio.get_running_loop(),
                "你好",
                "cosyvoice-v3-flash-demo-abc",
                {"model": "cosyvoice-v3-flash"},
            )

        with pytest.raises(ws_tts._TTSSynthesisError) as caught:
            asyncio.run(run())

        probe = caught.value.debug()["upstream_probe"]
        assert probe["stage"] == "probe_failed"
        assert caught.value.debug()["stage"] == "upstream_connect"

    def test_non_connect_failures_are_not_probed(self, monkeypatch):
        install(monkeypatch, [RuntimeError("model not found")])
        calls = []

        async def fake_probe(endpoint, timeout):
            calls.append(endpoint)
            return {"ok": True, "stage": "ok"}

        monkeypatch.setattr(ws_tts.upstream_probe, "probe", fake_probe)

        async def run():
            await ws_tts._synthesize(
                FakeWebSocket(),
                asyncio.get_running_loop(),
                "你好",
                "cosyvoice-v3-flash-demo-abc",
                {"model": "cosyvoice-v3-flash"},
            )

        with pytest.raises(ws_tts._TTSSynthesisError):
            asyncio.run(run())

        assert calls == []


class TestUserMessage:
    def test_a_connect_timeout_is_explained_in_chinese(self):
        error = ws_tts._TTSSynthesisError(
            CONNECT_TIMEOUT,
            stage="upstream_connect",
            model="cosyvoice-v3-flash",
            voice="cosyvoice-v3-flash-demo-abc",
            endpoint="wss://llm-secret123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
            task_id="task-local-1",
            request_id=None,
            attempt=3,
            attempts=3,
            total_elapsed=16.5,
            attempt_elapsed=5.1,
            text_length=2,
        )

        message = ws_tts._user_message(error)

        assert "连不上阿里云语音服务" in message
        assert "已试 3 次" in message
        assert "websocket connection could not established" not in message

    def test_other_failures_keep_the_scrubbed_upstream_text(self):
        exc = RuntimeError(
            "401 invalid Authorization header: Bearer sk-leakme1234567890"
        )

        message = ws_tts._user_message(exc)

        assert "sk-leakme" not in message
        assert "***" in message


class TestRetryDelay:
    def test_backoff_is_exponential_and_capped(self, monkeypatch):
        monkeypatch.setattr(config, "TTS_CONNECT_BACKOFF_SECONDS", 0.5)
        monkeypatch.setattr(config, "TTS_CONNECT_BACKOFF_MAX_SECONDS", 2.0)
        monkeypatch.setattr(config, "TTS_CONNECT_JITTER_SECONDS", 0)

        delays = [round(ws_tts._retry_delay(attempt), 3) for attempt in (1, 2, 3, 4)]

        assert delays == [0.5, 1.0, 2.0, 2.0]

    def test_jitter_stays_within_its_bound(self, monkeypatch):
        monkeypatch.setattr(config, "TTS_CONNECT_BACKOFF_SECONDS", 0.5)
        monkeypatch.setattr(config, "TTS_CONNECT_BACKOFF_MAX_SECONDS", 2.0)
        monkeypatch.setattr(config, "TTS_CONNECT_JITTER_SECONDS", 0.25)

        for _ in range(20):
            assert 0.5 <= ws_tts._retry_delay(1) <= 0.75
