"""Runtime configuration read from environment variables.

Works unchanged on Vercel, Render, Docker or a bare host. The only platform
specific knob is `storage_backend`, which decides how voice-clone enrollment
audio is exposed to DashScope over the public internet.
"""

import os

from . import voices


def _load_dotenv() -> None:
    """Load a local `.env` file without adding a dependency.

    Existing environment variables always win, so on Render/Vercel/Docker the
    platform-injected values are never shadowed by a stray file.
    """
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


_load_dotenv()


def _env(*names, default=None):
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return default


def _env_int(*names, default):
    try:
        return int(_env(*names, default=default))
    except (TypeError, ValueError):
        return int(default)


def _env_float(*names, default):
    try:
        return float(_env(*names, default=default))
    except (TypeError, ValueError):
        return float(default)


def _parse_models(raw: str) -> list[dict]:
    """Parse `id:显示名,id:显示名` into `{"id", "name"}` pairs.

    The id is what actually gets sent upstream; the name only labels the picker
    in the browser. A chunk without a colon is used as both, so `LLM_MODELS`
    can be a bare list of ids when the ids are readable enough.
    """
    out: list[dict] = []
    seen: set[str] = set()
    for chunk in (raw or "").split(","):
        model_id, _, name = chunk.strip().partition(":")
        model_id = model_id.strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        out.append({"id": model_id, "name": name.strip() or model_id})
    return out


# ---- credentials -----------------------------------------------------------

API_KEY = _env("DASHSCOPE_API_KEY", "REALTIME_API_KEY")

# qwen-audio-3.0-* models are served from a per-workspace endpoint, see
# samples/speech-recognition/recognize_speech_qwen-audio-3.0-asr-flash-streaming-with-vocabulary/python/run.py:49
WORKSPACE_ID = _env("DASHSCOPE_WORKSPACE_ID", "FUN_REALTIME_SPACE_ID")

# Access password for the whole app. Empty disables authentication.
APP_PASSWORD = _env("APP_PASSWORD", default="")

# Secret used to sign the session cookie. Falls back to APP_PASSWORD.
SESSION_SECRET = _env("SESSION_SECRET", default=APP_PASSWORD)

SESSION_TTL_SECONDS = int(_env("SESSION_TTL_SECONDS", default=7 * 24 * 3600))

# Login throttling. In-memory per instance; see server/ratelimit.py for scope.
LOGIN_MAX_ATTEMPTS = int(_env("LOGIN_MAX_ATTEMPTS", default=5))
LOGIN_WINDOW_SECONDS = int(_env("LOGIN_WINDOW_SECONDS", default=600))
LOGIN_LOCKOUT_SECONDS = int(_env("LOGIN_LOCKOUT_SECONDS", default=900))

# ---- voice clone enrollment ------------------------------------------------

# VoiceEnrollmentService.create_voice(url=...) requires a URL that DashScope can
# fetch from the public internet. We therefore need to know our own public
# origin. Render/Docker can serve a file from local disk, Vercel cannot (the
# function filesystem is read-only outside /tmp and instances are not sticky),
# so Vercel uploads to Blob instead.
PUBLIC_BASE_URL = _env("PUBLIC_BASE_URL", default="").rstrip("/")

BLOB_TOKEN = _env("BLOB_READ_WRITE_TOKEN")

# "auto" picks vercel-blob when BLOB_TOKEN is set, otherwise local disk.
STORAGE_BACKEND = _env("STORAGE_BACKEND", default="auto")

VOICE_CLONE_MODELS = ["cosyvoice-v3-flash", "qwen-audio-3.0-tts-flash", "qwen-audio-3.0-tts-plus"]

# Enrollment audio expectations, mirrored from
# samples/speech-synthesizer/synthesize_speech_from_text_with_cloned_voice/python/record.py
ENROLL_SAMPLE_RATE = 16000
ENROLL_TARGET_SECONDS = 10

# ---- platform detection ----------------------------------------------------

def is_vercel() -> bool:
    return bool(os.environ.get("VERCEL"))


def is_render() -> bool:
    return bool(os.environ.get("RENDER"))


def resolve_storage_backend() -> str:
    if STORAGE_BACKEND != "auto":
        return STORAGE_BACKEND
    if BLOB_TOKEN:
        return "blob"
    if is_vercel():
        return "blob"
    return "local"


# ---- model defaults --------------------------------------------------------

REALTIME_MODEL = _env("FUN_REALTIME_MODEL", default="qwen-audio-3.0-realtime-plus")
ASR_MODEL = "fun-asr-realtime"
TTS_MODEL = _env("TTS_MODEL", default="cosyvoice-v3-flash")

TTS_VOICE = _env("TTS_VOICE", default="longanhuan")
TTS_SAMPLE_RATE = 22050

REALTIME_VOICES = [
    "longanlingxin",
    "longanqian",
    "longanlingxi",
    "longanxiaoxin",
    "longanlufeng",
]

REALTIME_VAD_MODES = ["server_vad", "smart_turn"]

SILENCE_DURATIONS = [600, 1000, 1200, 1500, 2000]


# ---- 文本标注用的 LLM -------------------------------------------------------
#
# 任意 OpenAI 兼容端点：百炼 compatible-mode、DeepSeek、Kimi、GLM、OpenRouter、
# one-api 聚合网关、自建 vLLM 都可以。默认指向百炼的兼容模式，所以不配任何东西
# 时也能直接用现有的 DASHSCOPE_API_KEY。换厂商只改下面三项，前后端代码不动。
#
# 刻意走裸 HTTP 而不是 dashscope.Generation：那个 SDK 只会打百炼。
LLM_BASE_URL = _env(
    "LLM_BASE_URL", default="https://dashscope.aliyuncs.com/compatible-mode/v1"
).rstrip("/")

# 可以和语音服务用不同的 Key。不设时复用 DASHSCOPE_API_KEY。
LLM_API_KEY = _env("LLM_API_KEY", default=API_KEY)

# "id:显示名,id:显示名"，显示名只给前端下拉用，id 才是发给上游的。
LLM_MODELS = _parse_models(_env("LLM_MODELS", default="qwen-turbo:快速,qwen-plus:均衡"))
LLM_MODEL = _env("LLM_MODEL", default=LLM_MODELS[0]["id"] if LLM_MODELS else "")

# SDK 默认 300s 太长：Vercel 的函数上限正好也是 300s，一个卡住的上游会把整个
# 函数的预算耗光。自己卡到 60s。
LLM_TIMEOUT_SECONDS = _env_int("LLM_TIMEOUT_SECONDS", default=60)
LLM_MAX_TOKENS = _env_int("LLM_MAX_TOKENS", default=3000)
LLM_TEMPERATURE = _env_float("LLM_TEMPERATURE", default=0.3)

# 一次标注的输入上限。超长文本既慢又贵，超了就让用户分段。
TAGS_MAX_CHARS = _env_int("TAGS_MAX_CHARS", default=2000)

TAGS_DENSITIES = [
    {"id": "sparse", "name": "稀疏"},
    {"id": "normal", "name": "适中"},
    {"id": "dense", "name": "密集"},
]

TAGS_LIMIT_MAX_ATTEMPTS = _env_int("TAGS_LIMIT_MAX_ATTEMPTS", default=20)
TAGS_LIMIT_WINDOW_SECONDS = _env_int("TAGS_LIMIT_WINDOW_SECONDS", default=60)
TAGS_LIMIT_LOCKOUT_SECONDS = _env_int("TAGS_LIMIT_LOCKOUT_SECONDS", default=120)


def realtime_base_url() -> str:
    """WebSocket endpoint for the qwen-audio realtime model."""
    explicit = _env("FUN_REALTIME_BASE_URL")
    if explicit:
        return explicit
    if WORKSPACE_ID:
        return f"wss://{WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime"
    return "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"


def public_config() -> dict:
    """Config safe to hand to the browser (contains no secrets)."""
    return {
        "realtime_model": REALTIME_MODEL,
        "tts_sample_rate": TTS_SAMPLE_RATE,
        "asr_model": ASR_MODEL,
        "tts_models": voices.catalogue(),
        "instruct_profiles": {
            vid: voices.instruction_kinds_for(vid) for vid in voices.INSTRUCT_PROFILES
        },
        "voice_capabilities": {
            vid: voices.capabilities_for(vid) for vid in voices.INSTRUCT_PROFILES
        },
        "instruct_value_map": {
            f"{vid}|{kind['id']}": voices.instruction_values_for(vid, kind["id"])
            for vid in voices.INSTRUCT_PROFILES
            for kind in voices.instruction_kinds_for(vid)
            if kind["id"]
        },
        "tts_default_model": voices.DEFAULT_MODEL,
        "emotion_labels": voices.EMOTION_LABELS,
        "control_tags": voices.CONTROL_TAGS,
        "rich_tags": voices.RICH_TAGS,
        "tag_models": sorted(voices.TAG_MODELS),
        # Only ids and display names: LLM_API_KEY and LLM_BASE_URL must never
        # reach the browser, the former because it is a credential and the
        # latter because a self-hosted vLLM origin is not public information.
        "llm": {
            "models": LLM_MODELS,
            "default_model": LLM_MODEL,
            "configured": bool(LLM_API_KEY),
        },
        "tags": {
            "max_chars": TAGS_MAX_CHARS,
            "densities": TAGS_DENSITIES,
        },
        "realtime_voices": REALTIME_VOICES,
        "realtime_vad_modes": REALTIME_VAD_MODES,
        "silence_durations": SILENCE_DURATIONS,
        "clone_models": VOICE_CLONE_MODELS,
        "enroll_target_seconds": ENROLL_TARGET_SECONDS,
        "using_workspace_endpoint": bool(WORKSPACE_ID),
    }