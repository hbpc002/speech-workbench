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
        "realtime_voices": REALTIME_VOICES,
        "realtime_vad_modes": REALTIME_VAD_MODES,
        "silence_durations": SILENCE_DURATIONS,
        "clone_models": VOICE_CLONE_MODELS,
        "enroll_target_seconds": ENROLL_TARGET_SECONDS,
        "using_workspace_endpoint": bool(WORKSPACE_ID),
    }