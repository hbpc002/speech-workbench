"""Shared plumbing for streaming PCM synthesis over a WebSocket.

Both tab 3 (plain TTS) and the voice-clone preview drive `SpeechSynthesizer`,
whose callbacks fire on SDK worker threads while the browser socket is asyncio.
The thread hop and the completion handshake live here so neither caller has to
repeat them. Audio goes out as binary frames; control messages go out as text.
"""

import asyncio

from dashscope.audio.tts_v2 import AudioFormat, ResultCallback, SpeechSynthesizer

from . import config, voices

AUDIO_FORMAT = AudioFormat.PCM_22050HZ_MONO_16BIT

# Parameter names accepted from the browser. The SDK spells them
# `speech_rate` / `pitch_rate`, not `rate` / `pitch`.
NUMERIC_PARAMS = ("volume", "speech_rate", "pitch_rate", "seed")

DEFAULTS = {"volume": 50, "speech_rate": 1.0, "pitch_rate": 1.0}


class WebSocketSynthCallback(ResultCallback):
    """Fans SDK callbacks out to a browser WebSocket.

    Text frames are JSON control messages (`tts.started`, `tts.done`,
    `error`, ...); binary frames are raw PCM the browser plays back.
    """

    def __init__(self, websocket, loop: asyncio.AbstractEventLoop) -> None:
        self.websocket = websocket
        self.loop = loop
        self.finished = asyncio.Event()
        self.pending: list[asyncio.Future] = []
        self._outcome = {"ok": True, "error": None}

    # -- control channel ---------------------------------------------------

    def _send_text(self, payload: dict) -> None:
        import json

        body = json.dumps(payload, ensure_ascii=False)
        self.pending.append(
            asyncio.run_coroutine_threadsafe(
                self.websocket.send_text(body), self.loop
            )
        )

    # -- ResultCallback ----------------------------------------------------

    def on_open(self) -> None:
        print("[tts] upstream open")

    def on_close(self) -> None:
        print("[tts] upstream closed")

    def on_complete(self) -> None:
        self._send_text({"type": "tts.done"})
        self.finished.set()

    def on_error(self, message: str) -> None:
        detail = getattr(message, "message", str(message))
        print(f"[tts] upstream error: {detail}")
        self._outcome = {"ok": False, "error": str(detail)}
        self._send_text({"type": "error", "error": {"message": str(detail)}})
        # Release the caller even on failure, otherwise it waits forever.
        self.finished.set()

    def on_event(self, message) -> None:
        pass

    def on_data(self, data: bytes) -> None:
        self.pending.append(
            asyncio.run_coroutine_threadsafe(
                self.websocket.send_bytes(data), self.loop
            )
        )

    # -- lifecycle ---------------------------------------------------------

    @property
    def failed(self) -> bool:
        return not self._outcome["ok"]

    async def wait(self, timeout: float = 60.0) -> bool:
        try:
            await asyncio.wait_for(self.finished.wait(), timeout)
        except asyncio.TimeoutError:
            return False
        return not self.failed

    def cancel_pending(self) -> None:
        for future in self.pending:
            future.cancel()


def normalize_params(params: dict | None) -> dict:
    """Validate the browser's synthesis parameters.

    Anything out of range is clamped rather than rejected, and unknown keys are
    dropped so the caller cannot smuggle arbitrary kwargs into the SDK. The
    model is read from the payload and checked against the known catalogue,
    because voices are bound to their model -- sending a v2 voice to the v3
    model fails with error 418.
    """
    params = params or {}
    out: dict = {}

    model = params.get("model")
    if model in voices.MODELS and model != config.TTS_MODEL:
        out["model"] = model

    for name in NUMERIC_PARAMS:
        if name not in params:
            continue
        try:
            value = float(params[name])
        except (TypeError, ValueError):
            continue
        if name == "volume":
            out["volume"] = max(0, min(100, int(value)))
        elif name == "speech_rate":
            out["speech_rate"] = max(0.5, min(2.0, value))
        elif name == "pitch_rate":
            out["pitch_rate"] = max(0.5, min(2.0, value))
        elif name == "seed":
            out["seed"] = max(0, min(65535, int(value)))

    instruction = (params.get("instruction") or "").strip()
    if instruction:
        out["instruction"] = instruction[:500]

    language = params.get("language")
    if language:
        out["language_hints"] = [str(language)[:16]]

    return out


def build_synthesizer(
    voice: str,
    callback: WebSocketSynthCallback,
    params: dict | None = None,
) -> SpeechSynthesizer:
    options = {"model": config.TTS_MODEL}
    options.update(normalize_params(params))
    return SpeechSynthesizer(
        voice=voice or config.TTS_VOICE,
        format=AUDIO_FORMAT,
        callback=callback,
        **options,
    )