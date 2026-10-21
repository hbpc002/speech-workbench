"""Tab 3 - speech synthesis.

Browser sends `{text, voice, params}`, server streams PCM back as binary frames.

Requests are handled strictly one at a time and each gets its own callback: a
shared callback keeps `finished` set after the first completion, so every later
request would return immediately and mis-attribute audio between segments.
"""

import asyncio
import json
import time

from fastapi import WebSocket, WebSocketDisconnect

from . import config, redact
from .tts_support import WebSocketSynthCallback, build_synthesizer

# The SDK hardcodes a five-second WebSocket connect wait. From a functions
# platform that reaches Beijing over the public internet, that occasionally
# expires before the TLS/WS handshake finishes. Nothing has been sent upstream
# at that point, so one fresh attempt is safe and does not duplicate audio.
TTS_CONNECT_RETRY_ATTEMPTS = 2
TTS_CONNECT_RETRY_DELAY_SECONDS = 0.5
SDK_CONNECT_TIMEOUT_SECONDS = 5
_CONNECT_TIMEOUT_MARKER = "websocket connection could not established"


class _TTSSynthesisError(RuntimeError):
    """A failed synthesis with the context the browser log console needs."""

    def __init__(
        self,
        cause: BaseException,
        *,
        stage: str,
        model: str,
        voice: str,
        endpoint: str,
        task_id: str,
        request_id: str | None,
        attempt: int,
        attempts: int,
        total_elapsed: float,
        attempt_elapsed: float,
        text_length: int,
    ) -> None:
        super().__init__(str(cause))
        self.cause = cause
        self.stage = stage
        self.attempt = attempt
        self.attempts = attempts
        self._debug = _debug_payload(
            cause,
            stage=stage,
            model=model,
            voice=voice,
            endpoint=endpoint,
            task_id=task_id,
            request_id=request_id,
            attempt=attempt,
            attempts=attempts,
            total_elapsed=total_elapsed,
            attempt_elapsed=attempt_elapsed,
            text_length=text_length,
        )

    def debug(self) -> dict:
        return self._debug


def _debug_payload(
    exc: BaseException,
    *,
    stage: str,
    model: str,
    voice: str,
    endpoint: str,
    task_id: str,
    request_id: str | None,
    attempt: int,
    attempts: int,
    total_elapsed: float,
    attempt_elapsed: float,
    text_length: int,
) -> dict:
    """Everything useful for an incident, with credentials kept out.

    A connect timeout has no upstream request id because no task was started.
    The locally generated task id, endpoint and attempt count are then the only
    things that can distinguish a bad host from a transient handshake.
    """
    return {
        "operation": "tts.synthesize",
        "stage": stage,
        "type": type(exc).__name__,
        "message": redact.debug_detail(exc),
        "model": model,
        "voice": voice,
        "endpoint": redact.scrub(endpoint),
        "workspace_configured": bool(config.WORKSPACE_ID),
        "task_id": task_id or None,
        "request_id": request_id,
        "attempt": attempt,
        "attempts_allowed": attempts,
        "elapsed_seconds": round(total_elapsed, 3),
        "attempt_elapsed_seconds": round(attempt_elapsed, 3),
        "sdk_connect_timeout_seconds": SDK_CONNECT_TIMEOUT_SECONDS,
        "text_length": text_length,
    }


def _is_connect_timeout(exc: BaseException) -> bool:
    return isinstance(exc, TimeoutError) and _CONNECT_TIMEOUT_MARKER in str(exc).lower()


def _failure_stage(exc: BaseException, phase: str) -> str:
    if phase == "build":
        return "build"
    text = str(exc).lower()
    if _CONNECT_TIMEOUT_MARKER in text:
        return "upstream_connect"
    if "start speech synthesizer failed" in text:
        return "start"
    return "synthesize" if phase == "synthesize" else "stream"


def _close_quietly(synthesizer) -> None:
    if synthesizer is None:
        return
    try:
        synthesizer.close()
    except Exception as exc:  # noqa: BLE001 - cleanup must not mask the real error
        print(f"[tts] close after failure: {type(exc).__name__}: {exc}")


async def _synthesize(websocket, loop, text: str, voice: str, params: dict) -> None:
    attempts = TTS_CONNECT_RETRY_ATTEMPTS
    total_started = time.monotonic()

    for attempt in range(1, attempts + 1):
        callback = WebSocketSynthCallback(websocket, loop)
        synthesizer = None
        endpoint = ""
        task_id = ""
        model = params.get("model") or config.TTS_MODEL
        voice_id = voice or config.TTS_VOICE
        phase = "build"
        attempt_started = time.monotonic()

        try:
            synthesizer = build_synthesizer(voice_id, callback, params)
            model = getattr(synthesizer, "model", model)
            endpoint = getattr(synthesizer, "url", "") or ""
            request = getattr(synthesizer, "request", None)
            task_id = str(getattr(request, "task_id", "") or "")

            def run() -> None:
                synthesizer.streaming_call(text)
                synthesizer.streaming_complete()

            phase = "synthesize"
            await asyncio.to_thread(run)
            phase = "stream"
            if await callback.wait():
                return

            if callback.error:
                raise RuntimeError(callback.error)
            raise TimeoutError("等待合成完成超时（60s）")
        except Exception as exc:
            attempt_elapsed = time.monotonic() - attempt_started
            stage = _failure_stage(exc, phase)
            retrying = _is_connect_timeout(exc) and attempt < attempts

            _close_quietly(synthesizer)

            if retrying:
                print(
                    f"[tts] upstream connect timed out "
                    f"(attempt {attempt}/{attempts}); retrying in "
                    f"{TTS_CONNECT_RETRY_DELAY_SECONDS:.1f}s"
                )
                await asyncio.sleep(TTS_CONNECT_RETRY_DELAY_SECONDS)
                continue

            raise _TTSSynthesisError(
                exc,
                stage=stage,
                model=model,
                voice=voice_id,
                endpoint=endpoint,
                task_id=task_id,
                request_id=callback.request_id,
                attempt=attempt,
                attempts=attempts,
                total_elapsed=time.monotonic() - total_started,
                attempt_elapsed=attempt_elapsed,
                text_length=len(text),
            ) from exc
        finally:
            callback.cancel_pending()


async def _send_error(websocket, exc: BaseException, debug: dict) -> None:
    try:
        await websocket.send_text(
            json.dumps(
                {
                    "type": "error",
                    "error": {
                        "message": redact.scrub(exc),
                        "debug": debug,
                    },
                },
                ensure_ascii=False,
            )
        )
    except (RuntimeError, WebSocketDisconnect):
        pass


async def handle(websocket: WebSocket) -> None:
    await websocket.accept()
    loop = asyncio.get_running_loop()

    await websocket.send_text(
        json.dumps(
            {
                "type": "server.hello",
                "default_model": config.TTS_MODEL,
                "sample_rate": config.TTS_SAMPLE_RATE,
            }
        )
    )

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            raw = message.get("text")
            if not raw:
                continue

            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if frame.get("type") != "tts.synthesize":
                continue

            text = (frame.get("text") or "").strip()
            if not text:
                continue
            voice = frame.get("voice") or config.TTS_VOICE
            params = frame.get("params") or {}

            await websocket.send_text(
                json.dumps(
                    {
                        "type": "tts.started",
                        "text": text,
                        "model": params.get("model") or config.TTS_MODEL,
                    },
                    ensure_ascii=False,
                )
            )
            await _synthesize(websocket, loop, text, voice, params)
    except WebSocketDisconnect:
        pass
    except _TTSSynthesisError as exc:
        print(f"[tts] failed: {json.dumps(exc.debug(), ensure_ascii=False)}")
        await _send_error(websocket, exc, exc.debug())
    except Exception as exc:  # noqa: BLE001 - message is scrubbed before sending
        debug = _debug_payload(
            exc,
            stage="handler",
            model=config.TTS_MODEL,
            voice=config.TTS_VOICE,
            endpoint="",
            task_id="",
            request_id=None,
            attempt=0,
            attempts=TTS_CONNECT_RETRY_ATTEMPTS,
            total_elapsed=0.0,
            attempt_elapsed=0.0,
            text_length=0,
        )
        print(f"[tts] failed: {json.dumps(debug, ensure_ascii=False)}")
        await _send_error(websocket, exc, debug)
