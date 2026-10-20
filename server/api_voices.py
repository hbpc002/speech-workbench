"""Tab 6 - voice cloning and voice management.

`VoiceEnrollmentService` needs a URL that DashScope can download, which is why
the original samples tell you to upload to OSS first
(samples/speech-synthesizer/synthesize_speech_from_text_with_cloned_voice/python/record.py:39).
Because this app is itself reachable over public HTTPS, it hosts the clip
instead - see server/storage.py for the two backends.
"""

import random
import re
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout

from dashscope.audio.tts_v2 import VoiceEnrollmentService
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

from . import config, redact, storage
from .errors import DebugHTTPException
from .voices import parse_clone_model, parse_clone_prefix, voice_status_label

router = APIRouter(prefix="/api/voices", tags=["voices"])

# Matches the SDK constraint documented in the clone samples' docstring:
# digits and lowercase letters only, less than 10 characters.
PREFIX_PATTERN = re.compile(r"^[a-z0-9]{1,9}$")

# The SDK's own connect timeout is 300 s, which is also Vercel's per-function
# limit: one unreachable upstream turns into a 504 for the whole invocation.
# Both are env-configurable because the right value depends on where the
# function runs: a Vercel function in Tokyo reaching DashScope in Beijing is a
# different latency budget than a laptop on the same continent.
LIST_TIMEOUT_SECONDS = config._env_float("LIST_TIMEOUT_SECONDS", default=20.0)
LIST_CACHE_SECONDS = config._env_float("LIST_CACHE_SECONDS", default=60.0)

# How long a failed attempt is remembered. Without this every page load pays the
# full timeout again: nothing is cached on failure, so a slow upstream turns
# every reload into another 20 s wait. This is the difference between one slow
# page load and a tab that appears permanently stuck.
LIST_FAIL_RETRY_SECONDS = 15.0

_LIST_CACHE: dict[str, tuple[float, dict]] = {}
_LIST_FAILURES: dict[str, float] = {}

_LIST_TIMEOUT_HINT = "查询音色列表超时（{seconds:.0f}s）。"
_LIST_TIMEOUT_RETRY = "请稍后点「刷新列表」重试。"
_LIST_STALE_WARNING = "显示的是上一次成功获取的列表，可能不是最新。"
_LIST_FAILED_HINT = "查询音色列表失败，请稍后点「刷新列表」重试。"


def _service() -> VoiceEnrollmentService:
    # Falls back to dashscope.api_key, which dashscope_setup.bootstrap() has
    # already populated from DASHSCOPE_API_KEY.
    return VoiceEnrollmentService()


def _stale_or_fail(cache_key: str) -> dict:
    """Serve the last good list, or give up.

    A stale list is far more useful than a hard 504: the operator can still see
    what they cloned, and can still delete something they are done with -- which
    matters because that is the one action with an upstream quota attached.

    With nothing cached there is nothing safe to return. An empty list would be
    a lie ("you have no voices") and the operator could recreate one by accident.
    """
    stale = _LIST_CACHE.get(cache_key)
    if stale:
        return {
            **stale[1],
            "stale": True,
            "warning": _LIST_STALE_WARNING,
        }
    raise DebugHTTPException(
        status_code=504,
        detail=_LIST_TIMEOUT_HINT.format(seconds=LIST_TIMEOUT_SECONDS) + _LIST_TIMEOUT_RETRY,
        debug={
            "operation": "list_voices",
            "timeout_seconds": LIST_TIMEOUT_SECONDS,
            "cached": False,
        },
    )


def _invalidate_list_cache() -> None:
    """Make every cached list stale after a write.

    Cloning or deleting changes what the next list should return, but keeping
    the old payload matters: if DashScope is unreachable immediately afterwards,
    `_stale_or_fail` can still show it instead of an empty tab. Ageing the entry
    past the success window is enough to force a refetch; deleting it would
    throw away the stale fallback.
    """
    expired = time.monotonic() - LIST_CACHE_SECONDS - 1
    for key, (_stamp, payload) in list(_LIST_CACHE.items()):
        _LIST_CACHE[key] = (expired, payload)
    _LIST_FAILURES.clear()


@router.get("")
def list_voices(prefix: str = "", refresh: bool = False) -> dict:
    """List enrolled voices, optionally narrowed to one prefix.

    Cached briefly: this runs on every page load, and each miss is an outbound
    call to DashScope. On a platform where that call can hang (Vercel observed
    a 300 s connect timeout), an uncached endpoint burns the whole function
    budget on every reload.

    Failures are cached too. A successful list is worth keeping; so is the
    knowledge that the last attempt just timed out, because re-paying the full
    timeout on every reload is what makes this feel broken rather than slow.

    `refresh=true` bypasses both caches: it is what the 刷新列表 button sends,
    and a refresh button that cannot refresh is its own bug.
    """
    cache_key = prefix or ""
    cached = _LIST_CACHE.get(cache_key)
    if not refresh and cached and time.monotonic() - cached[0] < LIST_CACHE_SECONDS:
        return cached[1]

    failed_at = _LIST_FAILURES.get(cache_key)
    if not refresh and failed_at is not None and time.monotonic() - failed_at < LIST_FAIL_RETRY_SECONDS:
        # Serve whatever we have rather than hanging again straight away.
        return _stale_or_fail(cache_key)

    service = _service()
    started = time.monotonic()
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        voices = pool.submit(
            service.list_voices, page_index=0, page_size=50, **({"prefix": prefix} if prefix else {})
        ).result(timeout=LIST_TIMEOUT_SECONDS)
    except FuturesTimeout:
        elapsed = time.monotonic() - started
        _LIST_FAILURES[cache_key] = time.monotonic()
        print(f"[voices] list_voices timed out after {elapsed:.1f}s (limit {LIST_TIMEOUT_SECONDS:.0f}s)")
        # Never serve an empty list as if it were the truth.
        return _stale_or_fail(cache_key)
    except Exception as exc:  # noqa: BLE001 - scrubbed before it reaches the browser
        _LIST_FAILURES[cache_key] = time.monotonic()
        redact.log_only("voices", exc)
        raise DebugHTTPException(
            status_code=502,
            detail=_LIST_FAILED_HINT,
            debug=_debug_payload(exc, "list_voices", prefix=prefix or None),
        ) from exc
    finally:
        # wait=False matters: the context manager would block on the hung
        # worker and reintroduce the timeout we just enforced.
        pool.shutdown(wait=False, cancel_futures=True)

    _LIST_FAILURES.pop(cache_key, None)
    payload = {
        "voices": [_describe(entry) for entry in voices],
        "request_id": service.get_last_request_id(),
    }
    _LIST_CACHE[cache_key] = (time.monotonic(), payload)
    return payload


def _describe(entry: dict) -> dict:
    """Add what `list_voice` omits but the UI needs.

    The upstream list carries only voice_id / gmt_create / gmt_modified /
    status. The target model is not among them -- only `query_voice` returns
    it, one round trip per voice -- but it is recoverable from the id, and the
    preview has to send the right one or the synthesis fails with 418.

    `status` is surfaced because a voice still under review, or one that failed
    review, is listed identically to a working one otherwise, and the only
    symptom is that the preview sounds wrong.
    """
    if not isinstance(entry, dict):
        return entry
    voice_id = entry.get("voice_id") or entry.get("voiceId") or ""
    model = entry.get("target_model") or parse_clone_model(voice_id)
    status_label, status_cls = voice_status_label(entry.get("status") or "")
    out = dict(entry)
    if model:
        out["target_model"] = model
    if voice_id:
        out["voice_id"] = voice_id
        out["prefix"] = parse_clone_prefix(voice_id)
    out["status_label"] = status_label
    out["status_class"] = status_cls
    return out


ENROLL_ATTEMPTS = 3
ENROLL_RETRY_SECONDS = 1.5

# The SDK's own connect timeout is 300 s. Bound every attempt and the retry
# loop as a whole so a dead upstream cannot consume the platform's function
# budget or leave the browser waiting forever.
ENROLL_ATTEMPT_TIMEOUT_SECONDS = config._env_float("ENROLL_ATTEMPT_TIMEOUT_SECONDS", default=45.0)
ENROLL_TOTAL_TIMEOUT_SECONDS = config._env_float("ENROLL_TOTAL_TIMEOUT_SECONDS", default=120.0)

# DashScope documents a 10 MB / 60 s maximum and 5 s of real speech.
ENROLL_MAX_BYTES = 10 * 1024 * 1024
ENROLL_SAMPLE_RATE = 24000
ENROLL_MIN_SECONDS = 5.0
ENROLL_MAX_SECONDS = 60.0

# Error text is the only classification signal the DashScope SDK gives us
# across versions. Keep the lists narrow: retrying an InvalidParameter costs
# three round trips and hides the actionable part of the failure.
_RETRYABLE_MARKERS = (
    "inputdownloadfailed",
    "failed to download the input",
    "download the input file",
    "timed out",
    "timeout",
    "connection reset",
    "connection aborted",
    "connection refused",
    "remote end closed",
    "temporarily unavailable",
    "serviceunavailable",
    "service unavailable",
    "internalerror",
    "internal error",
    "throttling",
    "rate limit",
    "limit_requests",
)
# A subset that really is caused by the uploaded sample/parameters, so the
# browser should see 400 rather than a generic upstream 502. Auth, workspace
# and quota problems stay 429/502: they are deployment state, not user input.
_BAD_REQUEST_MARKERS = (
    "invalidparameter",
    "invalid parameter",
    "file format unsupported",
    "sample rate unsupported",
    "sample rate not supported",
    "silent",
    "valid audio too short",
    "audio too short",
    "durationlimit",
    "duration exceeds",
    "file too large",
    "decoder audio file failed",
    "no segments meet",
)
_NON_RETRYABLE_MARKERS = (
    "invalidparameter",
    "invalid parameter",
    "modelnotfound",
    "model not found",
    "unauthorized",
    "invalid authorization",
    "invalid api",
    "invalidapikey",
    "accessdenied",
    "access denied",
    "permissiondenied",
    "permission denied",
    "quota",
    "file format unsupported",
    "sample rate unsupported",
    "sample rate not supported",
    "silent",
    "valid audio too short",
    "audio too short",
    "durationlimit",
    "duration exceeds",
    "file too large",
    "decoder audio file failed",
    "no segments meet",
)


def _error_text(exc: BaseException) -> str:
    """Everything useful for classifying a DashScope failure, in one string."""
    parts = [str(exc), type(exc).__name__]
    for attribute in ("code", "message", "status_code"):
        value = getattr(exc, attribute, None)
        if value is not None:
            parts.append(str(value))
    return " ".join(parts)


def _request_id(exc: BaseException) -> str:
    """Best-effort request id, whether the SDK exposed it or only printed it."""
    for attribute in ("_request_id", "request_id"):
        value = getattr(exc, attribute, None)
        if value:
            return str(value)
    match = re.search(r"\bRequest:\s*([0-9a-zA-Z-]+)", _error_text(exc))
    return match.group(1) if match else ""


def _debug_payload(exc: BaseException, operation: str, **extra) -> dict:
    """The scrubbed envelope shown in the browser's log console.

    `_friendly_enroll_error` is intentionally short enough to sit under a
    button; this is where the request id and upstream message survive.
    """
    payload = {
        "operation": operation,
        "type": type(exc).__name__,
        "message": redact.debug_detail(_error_text(exc)),
        "status_code": getattr(exc, "status_code", None),
        "code": getattr(exc, "code", None),
        "request_id": _request_id(exc),
    }
    for key, value in extra.items():
        if value is not None:
            payload[key] = value
    return payload


def _is_retryable(exc: BaseException) -> bool:
    """Retry only failures that have a chance of succeeding on the next call."""
    text = _error_text(exc).lower()
    if any(marker in text for marker in _NON_RETRYABLE_MARKERS):
        return False
    if any(marker in text for marker in _RETRYABLE_MARKERS):
        return True
    status = getattr(exc, "status_code", None)
    if status == 429:
        return True
    if isinstance(status, int) and 400 <= status < 500:
        return False
    # Unknown usually means a transport-level failure, which is worth retrying.
    return True


def _retry_delay(attempt: int, exc: BaseException) -> float:
    text = _error_text(exc).lower()
    if "throttl" in text or "rate limit" in text or "429" in text or "limit_requests" in text:
        base = min(15.0, 5.0 * attempt)
    else:
        base = min(8.0, ENROLL_RETRY_SECONDS * (2 ** (attempt - 1)))
    return base + random.uniform(0, 0.3)


def _call_with_timeout(fn, timeout: float):
    """Run a blocking SDK call with a hard deadline.

    `wait=False` is deliberate: waiting for a hung worker would reintroduce the
    timeout we are enforcing. Python cannot kill the thread, but the request no
    longer hangs on it.
    """
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        return pool.submit(fn).result(timeout=timeout)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def _safe_request_id(service) -> str:
    try:
        return service.get_last_request_id() or ""
    except Exception:  # noqa: BLE001 - diagnostics must not mask the real error
        return ""


def _create_voice(public_url: str, prefix: str, target_model: str) -> tuple[str, str]:
    """Enroll, retrying only transient failures within a bounded deadline.

    DashScope reports `InputDownloadFailed` even when its fetch of the clip
    actually succeeded (visible as a 200 in this app's access log). It is
    noticeably more likely against a slow origin such as a tunnel, so that
    class of failure is retried. Parameter, quota and auth errors are not: they
    cannot succeed on a second identical call, and retrying them only delays
    the actionable message.
    """
    last_error: Exception | None = None
    attempt_log: list[dict] = []
    started = time.monotonic()

    for attempt in range(1, ENROLL_ATTEMPTS + 1):
        remaining = ENROLL_TOTAL_TIMEOUT_SECONDS - (time.monotonic() - started)
        if remaining <= 0:
            break

        service = _service()
        attempt_started = time.monotonic()
        try:
            voice_id = _call_with_timeout(
                lambda: service.create_voice(
                    target_model=target_model, prefix=prefix, url=public_url
                ),
                min(ENROLL_ATTEMPT_TIMEOUT_SECONDS, remaining),
            )
            elapsed = time.monotonic() - attempt_started
            print(
                f"[voices] enrolled model={target_model} prefix={prefix} "
                f"attempt={attempt} elapsed={elapsed:.1f}s "
                f"request_id={_safe_request_id(service)}"
            )
            return voice_id, _safe_request_id(service)
        except Exception as exc:  # noqa: BLE001 - classified below
            last_error = exc
            elapsed = time.monotonic() - attempt_started
            attempt_log.append(
                {
                    "attempt": attempt,
                    "elapsed_ms": round(elapsed * 1000),
                    "request_id": _safe_request_id(service),
                    "type": type(exc).__name__,
                    "message": redact.scrub(exc, limit=1000),
                }
            )
            print(
                f"[voices] attempt {attempt}/{ENROLL_ATTEMPTS} failed after "
                f"{elapsed:.1f}s model={target_model} prefix={prefix} "
                f"request_id={_safe_request_id(service)}: "
                f"{type(exc).__name__}: {exc}"
            )
            if attempt >= ENROLL_ATTEMPTS or not _is_retryable(exc):
                break
            delay = _retry_delay(attempt, exc)
            if ENROLL_TOTAL_TIMEOUT_SECONDS - (time.monotonic() - started) <= delay:
                break
            time.sleep(delay)

    assert last_error is not None
    # Python exceptions accept attributes, so carry the per-attempt diagnostics
    # to `create_voice` without wrapping the exception type (which the status
    # mapper and its tests rely on).
    try:
        setattr(last_error, "attempt_info", attempt_log)
    except Exception:  # noqa: BLE001 - diagnostics must not mask the real error
        pass
    raise last_error


def _wav_info(payload: bytes) -> tuple[int, int, int, int, float] | None:
    """Return (format, channels, sample_rate, bits, seconds) for a PCM WAV.

    None means "not a WAV at all" (e.g. an MP3 on the blob backend), not
    "malformed" -- the caller distinguishes the two before deciding to reject.
    """
    if len(payload) < 12 or payload[:4] != b"RIFF" or payload[8:12] != b"WAVE":
        return None

    pos = 12
    fmt: tuple[int, int, int, int] | None = None
    data_size: int | None = None
    while pos + 8 <= len(payload):
        chunk_id = payload[pos:pos + 4]
        size = int.from_bytes(payload[pos + 4:pos + 8], "little")
        start = pos + 8
        if chunk_id == b"fmt " and size >= 16 and start + 16 <= len(payload):
            audio_format = int.from_bytes(payload[start:start + 2], "little")
            channels = int.from_bytes(payload[start + 2:start + 4], "little")
            sample_rate = int.from_bytes(payload[start + 4:start + 8], "little")
            bits = int.from_bytes(payload[start + 14:start + 16], "little")
            fmt = (audio_format, channels, sample_rate, bits)
        elif chunk_id == b"data":
            data_size = size
            break
        pos = start + size + (size & 1)

    if fmt is None or data_size is None:
        return None
    audio_format, channels, sample_rate, bits = fmt
    if audio_format != 1 or channels < 1 or sample_rate < 1 or bits < 1:
        return None
    seconds = data_size / (sample_rate * channels * (bits / 8))
    return audio_format, channels, sample_rate, bits, seconds


def _validate_enroll_audio(payload: bytes, target_model: str) -> None:
    """Reject samples DashScope will reject, before spending an enrollment call."""
    if len(payload) > ENROLL_MAX_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"音频超过 {ENROLL_MAX_BYTES // (1024 * 1024)} MB，请压缩或裁短后再试",
        )

    is_wav = len(payload) >= 12 and payload[:4] == b"RIFF" and payload[8:12] == b"WAVE"
    info = _wav_info(payload)
    if is_wav and info is None:
        raise HTTPException(
            status_code=400,
            detail="WAV 文件损坏或缺少有效的 fmt/data 块，请重新导出后上传",
        )
    if info is None:
        # The blob backend accepts MP3, whose header we do not decode here.
        return

    _, channels, rate, bits, seconds = info
    if bits != 16:
        raise HTTPException(status_code=400, detail=f"仅支持 16-bit PCM WAV，当前是 {bits}-bit")
    if channels not in (1, 2):
        raise HTTPException(status_code=400, detail="声道数必须是 1 或 2（双声道只取首声道）")

    min_rate = ENROLL_SAMPLE_RATE if target_model.startswith("qwen-audio") else 16000
    if rate < min_rate:
        raise HTTPException(
            status_code=400,
            detail=(
                f"采样率 {rate} Hz 偏低：{target_model} 要求至少 {min_rate} Hz。"
                "浏览器录音和上传转码现在都会输出 24 kHz，请重新录制或重新选择文件。"
            ),
        )
    if seconds < ENROLL_MIN_SECONDS:
        raise HTTPException(
            status_code=400,
            detail=f"有效样本只有 {seconds:.1f} 秒，至少需要 {ENROLL_MIN_SECONDS:.0f} 秒清晰人声",
        )
    if seconds > ENROLL_MAX_SECONDS:
        raise HTTPException(
            status_code=400,
            detail=f"样本 {seconds:.1f} 秒，超过 {ENROLL_MAX_SECONDS:.0f} 秒上限，请裁短后再试",
        )


def _friendly_enroll_error(exc: BaseException, target_model: str) -> str:
    """Turn upstream text into one short, actionable sentence.

    The full upstream envelope goes to `debug` and the server log. Interpolating
    it here made the status line hundreds of characters long, and the useful
    part -- the request id -- was still the least visible part of it.
    """
    text = _error_text(exc)
    low = text.lower()
    attempts = len(getattr(exc, "attempt_info", []) or [])
    action = (
        f"已尝试 {attempts} 次，可稍后重试或改用 CosyVoice"
        if attempts > 1
        else "可稍后重试或改用 CosyVoice"
    )

    if target_model.startswith("qwen-audio") and (
        "internalerror" in low or "internal error" in low or "feat extract missing ph.bin" in low
    ):
        hint = f"千问上游异常（500，非录音问题），{action}"
    elif "inputdownloadfailed" in low or "failed to download the input" in low or "download the input file" in low:
        hint = (
            "阿里云下载不到复刻样本。检查 PUBLIC_BASE_URL 是否为公网可访问地址、"
            "Vercel Blob 是否为 Public，以及音频是否小于 10MB"
        )
    elif "sample rate" in low and ("unsupported" in low or "not supported" in low):
        hint = f"{target_model} 不接受这个采样率；请用 24 kHz 重新录制或上传"
    elif "silent" in low or "audio too short" in low or "valid audio too short" in low or "no segments meet" in low:
        hint = "样本有效人声不足。请录制至少 5 秒连续、清晰的朗读内容后重试"
    elif "file format unsupported" in low or "decoder audio file failed" in low:
        hint = "音频格式无法解码。请上传 16-bit PCM WAV（推荐 24 kHz 单声道）"
    elif "durationlimit" in low or "duration exceeds" in low or "file too large" in low:
        hint = "音频超过时长或大小限制：最长 60 秒、文件不超过 10MB"
    elif "modelnotfound" in low or "model not found" in low:
        hint = "上游找不到复刻模型。检查 DASHSCOPE_WORKSPACE_ID 是否为 llm-xxxxxxxx 且与 API Key 属于同一业务空间"
    elif "quota" in low:
        hint = "音色配额已满。先删除不再使用的音色，再重新复刻"
    elif "throttl" in low or "rate limit" in low or "limit_requests" in low or "429" in low:
        hint = "上游触发限流，请稍等片刻再重试"
    elif "unauthorized" in low or "invalid authorization" in low or "invalid api" in low or "accessdenied" in low or "access denied" in low:
        hint = "API Key 无效、没有该模型权限，或不属于当前业务空间"
    else:
        hint = "上游返回了错误，请稍后重试"
    return f"音色复刻失败：{hint}；详情见「日志」"


def _enroll_status(exc: BaseException) -> int:
    text = _error_text(exc).lower()
    if "throttl" in text or "rate limit" in text or "limit_requests" in text or "429" in text:
        return 429
    if any(marker in text for marker in _BAD_REQUEST_MARKERS):
        return 400
    return 502


@router.get("/readiness")
def clone_readiness() -> dict:
    """Whether voice enrollment can work on this deployment, and why not.

    Authenticated (the router carries `require_session`), so the reason may
    name the missing variable. The alternative is letting the operator record a
    ten-second clip only to fail on submit with the same information.
    """
    problem = storage.check()
    if problem is None and not config.API_KEY:
        problem = "未配置 DASHSCOPE_API_KEY"
    if problem is None and not config.WORKSPACE_ID:
        problem = "未配置 DASHSCOPE_WORKSPACE_ID（声音复刻只认业务空间端点）"
    return {"ready": problem is None, "reason": problem or ""}


@router.post("")
async def create_voice(
    audio: UploadFile = File(...),
    prefix: str = Form("demo"),
    target_model: str = Form("cosyvoice-v3-flash"),
) -> dict:
    """Enroll a new voice from a recorded or uploaded clip."""
    if not PREFIX_PATTERN.match(prefix or ""):
        raise HTTPException(
            status_code=400,
            detail="prefix 只能包含小写字母和数字，且长度必须小于 10",
        )
    if target_model not in config.VOICE_CLONE_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"target_model 必须是 {config.VOICE_CLONE_MODELS} 之一",
        )

    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="音频为空")

    suffix = ".wav" if (audio.filename or "").lower().endswith(".wav") else ".mp3"
    if storage.backend() == "local" and suffix != ".wav":
        raise HTTPException(
            status_code=400,
            detail="本机存储模式下请上传 WAV 文件（16-bit PCM，推荐 24kHz 单声道）",
        )

    _validate_enroll_audio(payload, target_model)

    try:
        public_url = await storage.put(payload, suffix)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        # The DashScope SDK is blocking. Running it directly in this async
        # handler stalled every other request on the instance for the whole
        # enrollment call (up to minutes on a bad upstream).
        voice_id, request_id = await run_in_threadpool(
            _create_voice, public_url, prefix, target_model
        )
    except Exception as exc:  # noqa: BLE001 - scrubbed before it reaches the browser
        redact.log_only("voices.enroll", exc)
        status = _enroll_status(exc)
        headers = {"Retry-After": "20"} if status == 429 else None
        debug = _debug_payload(
            exc, "create_voice", model=target_model, prefix=prefix
        )
        attempt_info = getattr(exc, "attempt_info", None)
        if attempt_info:
            debug["attempts"] = attempt_info
        raise DebugHTTPException(
            status_code=status,
            detail=_friendly_enroll_error(exc, target_model),
            debug=debug,
            headers=headers,
        ) from exc
    finally:
        # Deliberately not deleting the clip here: DashScope fetches the sample
        # asynchronously, after create_voice has returned. Expiry-based purging
        # in server/storage.py removes it once the fetch has certainly landed.
        storage.purge_expired()

    # The list the tab fetched on page load predates this voice. Ageing it here
    # means the immediate follow-up refresh sees the new voice instead of the
    # cache, while still leaving a stale fallback if DashScope is down.
    _invalidate_list_cache()
    return {"voice_id": voice_id, "request_id": request_id, "target_model": target_model}


@router.delete("/{voice_id}")
def delete_voice(voice_id: str) -> dict:
    try:
        _service().delete_voice(voice_id)
    except Exception as exc:  # noqa: BLE001 - scrubbed before it reaches the browser
        redact.log_only("voices.delete", exc)
        raise DebugHTTPException(
            status_code=502,
            detail="删除音色失败，请稍后重试；详情见「日志」。",
            debug=_debug_payload(exc, "delete_voice", voice_id=voice_id),
        ) from exc
    _invalidate_list_cache()
    return {"deleted": voice_id}
