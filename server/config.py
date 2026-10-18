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

# Vercel Blob 的 token 有两个变量名，官方 SDK 两个都认，两个都读省事。
BLOB_TOKEN = _env("BLOB_READ_WRITE_TOKEN", "VERCEL_BLOB_READ_WRITE_TOKEN")

# "auto" picks Vercel Blob when BLOB_TOKEN is set or the app runs on Vercel,
# otherwise local disk. Note this decides the backend, not whether the backend
# actually works -- server/storage.py check() is what verifies that.
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
#
# 默认是 qwen-flash 而不是 qwen-turbo：后者已被百炼列入下线批次（公告日 2026-10-10），
# 而官方下线机制写明「下线公告发布后 QPM/TPM 会逐步下降」—— 症状就是用着用着突然
# 429。qwen-flash 同属 Flash 档、标注这种活够用，限额反而宽出一个量级
# （RPM 30000 / TPM 1000 万，对比 turbo 的 1200 / 500 万），单价也更低。
# qwen-turbo 留在列表最后：还能用，但要清楚它随时会消失。
LLM_MODELS = _parse_models(
    _env(
        "LLM_MODELS",
        default="qwen-flash:均衡,qwen3.8-flash:最新,qwen-plus:较强,qwen-turbo:旧版待下线",
    )
)
LLM_MODEL = _env("LLM_MODEL", default=LLM_MODELS[0]["id"] if LLM_MODELS else "")

# 拟声标签是让口播听起来像真人说话的关键，所以默认就开着，且用量给得比较宽。
# 逐字率控制疏密，上限只是防模型无视逐字率时的兜底 —— 脚本越长上限越该放得开。
TAGS_RICH_LEVELS = [
    {"id": "off", "name": "关"},
    {"id": "light", "name": "少 · 自然点缀"},
    {"id": "heavy", "name": "多 · 真人感更强"},
]
TAGS_DEFAULT_RICH_LEVEL = "light"

# 上限的是给到 15 分钟（约 3750 字）留的余量：中文大约一 token 一字，
# 3750 字成稿要 4000+ token，3000 会被截断。这是上限不是预留，费用按实际生成
# 计，所以调高不会多花钱，只是允许更长的稿子。
LLM_TIMEOUT_SECONDS = _env_int("LLM_TIMEOUT_SECONDS", default=120)
LLM_MAX_TOKENS = _env_int("LLM_MAX_TOKENS", default=6000)
LLM_TEMPERATURE = _env_float("LLM_TEMPERATURE", default=0.3)

# 429（账号被限流）和 5xx 重试几次，退避按这个秒数翻倍。
#
# 两者的等待时间必须分开：百炼的限流按主账号合并计算、通常一分钟内恢复，而且还有
# 一条「请求量突增触发了稳定性保护，即使 RPM/TPM 未超限」。被限流后 3 秒再打一次
# 只会加深限流，所以 429 只重试一次、且等这么久；5xx 是对方服务抖动，短退避重试。
#
# 超时故意不重试：一次已经 120s，两次就是 240s，再多就撞穿 Vercel 300s 的函数预算，
# 那样报错都发不回去。
LLM_MAX_RETRIES = _env_int("LLM_MAX_RETRIES", default=2)
LLM_RETRY_BACKOFF_SECONDS = _env_float("LLM_RETRY_BACKOFF_SECONDS", default=3.0)
LLM_RATE_LIMIT_BACKOFF_SECONDS = _env_float("LLM_RATE_LIMIT_BACKOFF_SECONDS", default=20.0)

# 一次标注的输入上限。跟着最长时长一起放宽，否则长稿只能写、不能标。
TAGS_MAX_CHARS = _env_int("TAGS_MAX_CHARS", default=4000)

TAGS_DENSITIES = [
    {"id": "sparse", "name": "稀疏"},
    {"id": "normal", "name": "适中"},
    {"id": "dense", "name": "密集"},
]

# 「AI 写口播稿」表单的预制选项。id 是真正发给模型的值，name 只用于显示。
#
# 时长的显示名带上大致字数，是因为「90 秒」对写稿的人没有直观概念；换算按
# 约 250 字/分钟的中文口播语速。
TAGS_DURATIONS = [
    {"id": "30 秒", "name": "30 秒 · 约 120 字"},
    {"id": "60 秒", "name": "60 秒 · 约 250 字"},
    {"id": "90 秒", "name": "90 秒 · 约 380 字"},
    {"id": "3 分钟", "name": "3 分钟 · 约 750 字"},
    {"id": "5 分钟", "name": "5 分钟 · 约 1250 字"},
    {"id": "10 分钟", "name": "10 分钟 · 约 2500 字"},
    {"id": "15 分钟", "name": "15 分钟 · 约 3750 字"},
]

TAGS_TONES = [
    # 「亲切自然」排在最前：它既是前端的预选项，也是 api_tagger 在 tone 留空时
    # 用的兜底值，列表里没有它的话下拉会静默落到第二项。
    {"id": "亲切自然", "name": "亲切自然"},
    {"id": "亲切推荐", "name": "亲切推荐"},
    {"id": "严肃科普", "name": "严肃科普"},
    {"id": "轻松活泼", "name": "轻松活泼"},
    {"id": "深情叙述", "name": "深情叙述"},
    {"id": "紧张解说", "name": "紧张解说"},
    {"id": "幽默调侃", "name": "幽默调侃"},
    {"id": "温柔治愈", "name": "温柔治愈"},
    {"id": "干脆利落", "name": "干脆利落"},
]

TAGS_AUDIENCES = [
    {"id": "宝妈", "name": "宝妈"},
    {"id": "数码爱好者", "name": "数码爱好者"},
    {"id": "职场新人", "name": "职场新人"},
    {"id": "中小学生", "name": "中小学生"},
    {"id": "大学生", "name": "大学生"},
    {"id": "车主", "name": "车主"},
    {"id": "中老年人", "name": "中老年人"},
    {"id": "户外爱好者", "name": "户外爱好者"},
]

# 主题本质上是自由输入，锁成下拉会把人挡住，所以只给 datalist 提示。
TAGS_TOPIC_HINTS = [
    "产品功能介绍",
    "新品发布预告",
    "活动促销通知",
    "知识科普讲解",
    "开箱测评",
    "课程招生简章",
    "门店开业公告",
    "周末景点推荐",
]

# 标注接口的本地限流。两个作用：防刷接口烧 token，以及——更要紧的——不让自己的
# 上游额度被自己打爆。百炼的限流按主账号合并计算，还要叠加一层「请求量突增触发的
# 稳定性保护」，所以这个数字必须明显低于上游额度，而不是一个「随便点」的量。
# 正常用一次标注要好几秒，一分钟里点 8 次已经是不像人话了。
TAGS_LIMIT_MAX_ATTEMPTS = _env_int("TAGS_LIMIT_MAX_ATTEMPTS", default=8)
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
            "durations": TAGS_DURATIONS,
            "tones": TAGS_TONES,
            "audiences": TAGS_AUDIENCES,
            "topic_hints": TAGS_TOPIC_HINTS,
            "rich_levels": TAGS_RICH_LEVELS,
            "default_rich_level": TAGS_DEFAULT_RICH_LEVEL,
        },
        "realtime_voices": REALTIME_VOICES,
        "realtime_vad_modes": REALTIME_VAD_MODES,
        "silence_durations": SILENCE_DURATIONS,
        "clone_models": VOICE_CLONE_MODELS,
        "enroll_target_seconds": ENROLL_TARGET_SECONDS,
        "using_workspace_endpoint": bool(WORKSPACE_ID),
    }