"""Tab 3 - speech synthesis.

Browser sends `{text, voice, params}`, server streams PCM back as binary frames.

Requests are handled strictly one at a time and each gets its own callback: a
shared callback keeps `finished` set after the first completion, so every later
request would return immediately and mis-attribute audio between segments.
"""

import asyncio
import json

from fastapi import WebSocket, WebSocketDisconnect

from . import config, redact
from .tts_support import WebSocketSynthCallback, build_synthesizer


async def _synthesize(websocket, loop, text: str, voice: str, params: dict) -> None:
    callback = WebSocketSynthCallback(websocket, loop)
    try:
        synthesizer = build_synthesizer(voice, callback, params)

        def run() -> None:
            synthesizer.streaming_call(text)
            synthesizer.streaming_complete()

        await asyncio.to_thread(run)
        await callback.wait()
    finally:
        callback.cancel_pending()


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
    except Exception as exc:  # noqa: BLE001 - message is scrubbed before sending
        print(f"[tts] failed: {type(exc).__name__}: {exc}")
        try:
            await websocket.send_text(
                json.dumps({"type": "error", "error": {"message": redact.scrub(exc)}})
            )
        except RuntimeError:
            pass