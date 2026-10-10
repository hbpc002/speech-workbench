"""Tab 2 - realtime speech recognition.

Server-side `Recognition` (fun-asr-realtime) with its callback fan-out pushed to
the browser over a WebSocket. Mirrors
samples/gallery/input-audio-out-text-html/python/server.py but drops the local
audio device and the local audio.pcm dump.
"""

import asyncio
import base64
import json

from dashscope.audio.asr import Recognition, RecognitionCallback, RecognitionResult
from fastapi import WebSocket, WebSocketDisconnect

from . import config

STOP = "stop"


class _BrowserRecognitionCallback(RecognitionCallback):
    def __init__(self, websocket: WebSocket, loop: asyncio.AbstractEventLoop) -> None:
        super().__init__()
        self.websocket = websocket
        self.loop = loop
        self.pending: list[asyncio.Future] = []

    def on_open(self) -> None:
        print("[asr] upstream open")

    def on_close(self) -> None:
        print("[asr] upstream closed")

    def on_complete(self) -> None:
        print("[asr] upstream complete")

    def on_error(self, result: RecognitionResult) -> None:
        message = getattr(result, "message", str(result))
        print(f"[asr] upstream error: {message}")
        self._push({"type": "error", "error": {"message": str(message)}})

    def on_event(self, result: RecognitionResult) -> None:
        sentence = result.get_sentence()
        if not isinstance(sentence, dict) or "text" not in sentence:
            return
        self._push(
            {
                "type": "asr.sentence",
                "text": sentence["text"],
                "is_end": RecognitionResult.is_sentence_end(sentence),
            }
        )

    def _push(self, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False)
        self.pending.append(
            asyncio.run_coroutine_threadsafe(
                self.websocket.send_text(body), self.loop
            )
        )


async def _consume(recognition, websocket: WebSocket) -> None:
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return
        text = message.get("text")
        if not text:
            continue

        if text == STOP:
            return

        try:
            frame = json.loads(text)
        except json.JSONDecodeError:
            # Bare base64 PCM frame.
            recognition.send_audio_frame(base64.b64decode(text))
            continue

        kind = frame.get("type")
        if kind == "client.audio":
            recognition.send_audio_frame(base64.b64decode(frame["data"]))
        elif kind == STOP:
            return


async def handle(websocket: WebSocket) -> None:
    params = websocket.query_params
    model = params.get("model") or config.ASR_MODEL
    language = params.get("language") or "zh"

    await websocket.accept()
    loop = asyncio.get_running_loop()
    callback = _BrowserRecognitionCallback(websocket, loop)

    recognition = Recognition(
        model=model,
        format="pcm",
        sample_rate=16000,
        language_hints=[language],
        semantic_punctuation_enabled=False,
        callback=callback,
    )
    recognition.start()
    await websocket.send_text(json.dumps({"type": "server.hello", "model": model}))

    try:
        await _consume(recognition, websocket)
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001 - surfaced to the browser
        print(f"[asr] failed: {exc}")
    finally:
        recognition.stop()
        for future in callback.pending:
            future.cancel()
        try:
            await websocket.send_text(json.dumps({"type": "asr.stopped"}))
        except RuntimeError:
            pass