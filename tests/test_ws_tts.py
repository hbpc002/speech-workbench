"""Failure handling for the TTS WebSocket.

The SDK's connect wait is a hardcoded five seconds and its error carries no
request id. These tests pin the two things that make that failure actionable:
one safe retry only for a connect timeout, and a scrubbed debug envelope that
names the stage, endpoint, task id and attempt.
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
    monkeypatch.setattr(ws_tts, "TTS_CONNECT_RETRY_DELAY_SECONDS", 0)
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
    def test_a_connect_timeout_is_retried_once(self, monkeypatch):
        created = synthesize(monkeypatch, [CONNECT_TIMEOUT])

        assert len(created) == 2
        assert created[0].closed is True, "the failed connection must be released"
        assert created[1].closed is False

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
        created = install(monkeypatch, [secret_timeout, secret_timeout])

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
        assert debug["attempt"] == 2
        assert debug["attempts_allowed"] == 2
        assert debug["sdk_connect_timeout_seconds"] == 5
        assert debug["elapsed_seconds"] >= 0
        assert debug["attempt_elapsed_seconds"] >= 0
        assert len(created) == 2

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
