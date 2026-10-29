"""内置 TTS 桥：让 short-video-maker 用上语音工坊的音色。

为什么需要它：渲染器原本用 Kokoro（本地模型），它不认识阿里云复刻音色。渲染器
已经把每个场景的文本交给 `http://127.0.0.1:8101/tts`（镜像里的补丁见
`renderer/patch_dist.js`），这个进程就补上那个端口，用 DashScope 合成 mp3。

为什么不是一个独立容器：它只被渲染器在回环上调用，和主应用共享同一份 Key 和
同一套模型表；拆出去只会多一个要盯的进程。所以它由 `main.py` 在启动时拉一个
守护线程，只绑 `127.0.0.1`，容器外碰不到。

接口刻意做成"渲染器说什么就信什么"的反面：voice 必须能解析成已知模型，文本有
长度上限，输出永远是 mp3 + `x-duration`（渲染器用它排字幕时间轴）。ffprobe 不
在时宁可报错也不返回 0 —— 0 会让整条片子的字幕时间轴塌成 0 秒。
"""

import json
import os
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import dashscope
from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer

from . import config, redact

MAX_TEXT_CHARS = 4000
# 按最长前缀匹配，避免 `cosyvoice-v3-flash` 抢走 `cosyvoice-v3-flash-xxx` 的匹配。
_MODELS_BY_LENGTH = sorted(config.VOICE_CLONE_MODELS, key=len, reverse=True)
_AUDIO_FORMAT = AudioFormat.MP3_24000HZ_MONO_256KBPS


def resolve_voice(name: str) -> tuple[str, str]:
    """把渲染器传来的 voice 解析成 (model, voice_id)。

    复刻音色的 id 形如 `cosyvoice-v3-flash-10222032-<hash>`，模型就是去掉
    末尾两段。解析不出来的一律回落默认音色：渲染器的旧界面还会发 `af_heart`
    这类 Kokoro 名字，让它们失败只会换来一条无解的错误。
    """
    candidate = (name or "").strip()
    for model in _MODELS_BY_LENGTH:
        if candidate.startswith(f"{model}-"):
            return model, candidate
    if candidate in config.VOICE_CLONE_MODELS:
        return candidate, config.TTS_VOICE
    return config.TTS_MODEL, config.TTS_VOICE


def _duration(path: str) -> float:
    binary = shutil.which("ffprobe")
    if not binary:
        raise RuntimeError("ffprobe 不在 PATH 里，无法计算音频时长")
    result = subprocess.run(
        [
            binary,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    value = (result.stdout or "").strip()
    if result.returncode != 0 or not value:
        raise RuntimeError(f"ffprobe 读取时长失败：{result.stderr.strip()[:200]}")
    return round(float(value), 3)


def synthesize(text: str, voice: str) -> tuple[bytes, float, str]:
    model, voice_id = resolve_voice(voice)
    if not config.API_KEY:
        raise RuntimeError("没有配置 DASHSCOPE_API_KEY")
    dashscope.api_key = config.API_KEY
    synthesizer = SpeechSynthesizer(model=model, voice=voice_id, format=_AUDIO_FORMAT)
    audio = synthesizer.call(text)
    if not audio:
        raise RuntimeError("DashScope 返回了空音频")
    handle = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
    try:
        handle.write(audio)
        handle.close()
        return audio, _duration(handle.name), f"{model}:{voice_id}"
    finally:
        try:
            os.unlink(handle.name)
        except OSError:
            pass


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        if self.path == "/health":
            self._json(200, {"status": "ok"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        if self.path != "/tts":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > 200_000:
                raise ValueError("请求体为空或过大")
            payload = json.loads(self.rfile.read(length) or b"{}")
            text = str(payload.get("text") or "").strip()
            if not text:
                raise ValueError("text 为空")
            if len(text) > MAX_TEXT_CHARS:
                raise ValueError(f"text 超过 {MAX_TEXT_CHARS} 字")
            voice = str(payload.get("voice") or "")
            audio, duration, used = synthesize(text, voice)
        except Exception as exc:  # noqa: BLE001 - every failure becomes a readable 500
            redact.log_only("tts_bridge", exc)
            self._json(500, {"error": redact.scrub(exc)})
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-Duration", f"{duration:.3f}")
        self.send_header("X-Voice", used)
        self.end_headers()
        self.wfile.write(audio)
        print(f"[bridge] {used} {duration:.2f}s {len(audio)}B text={text[:24]!r}", flush=True)

    def log_message(self, *args) -> None:  # noqa: D401 - keep the renderer's noise out
        return


def start(port: int) -> threading.Thread:
    """Start the bridge on a daemon thread and return it.

    Daemon on purpose: the app's lifespan shutdown should not wait on a socket
    accept loop that has no clean stop path. The port is loopback-only, so the
    only client is the renderer in this same container.
    """
    server = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, name="tts-bridge", daemon=True)
    thread.start()
    print(f"[boot] TTS bridge on 127.0.0.1:{port}", flush=True)
    return thread
