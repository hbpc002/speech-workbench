"""Tab 6 - voice cloning and voice management.

`VoiceEnrollmentService` needs a URL that DashScope can download, which is why
the original samples tell you to upload to OSS first
(samples/speech-synthesizer/synthesize_speech_from_text_with_cloned_voice/python/record.py:39).
Because this app is itself reachable over public HTTPS, it hosts the clip
instead - see server/storage.py for the two backends.
"""

import re
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout

from dashscope.audio.tts_v2 import VoiceEnrollmentService
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from . import config, redact, storage
from .voices import parse_clone_model, parse_clone_prefix, voice_status_label

router = APIRouter(prefix="/api/voices", tags=["voices"])

# Matches the SDK constraint documented in the clone samples' docstring:
# digits and lowercase letters only, less than 10 characters.
PREFIX_PATTERN = re.compile(r"^[a-z0-9]{1,9}$")

# The SDK's own connect timeout is 300 s, which is also Vercel's per-function
# limit: one unreachable upstream turns into a 504 for the whole invocation.
LIST_TIMEOUT_SECONDS = 20.0
LIST_CACHE_SECONDS = 60.0
_LIST_CACHE: dict[str, tuple[float, dict]] = {}


def _service() -> VoiceEnrollmentService:
    # Falls back to dashscope.api_key, which dashscope_setup.bootstrap() has
    # already populated from DASHSCOPE_API_KEY.
    return VoiceEnrollmentService()


@router.get("")
def list_voices(prefix: str = "") -> dict:
    """List enrolled voices, optionally narrowed to one prefix.

    Cached briefly: this runs on every page load, and each miss is an outbound
    call to DashScope. On a platform where that call can hang (Vercel observed
    a 300 s connect timeout), an uncached endpoint burns the whole function
    budget on every reload.
    """
    service = _service()
    cache_key = prefix or ""
    cached = _LIST_CACHE.get(cache_key)
    if cached and time.monotonic() - cached[0] < LIST_CACHE_SECONDS:
        return cached[1]

    pool = ThreadPoolExecutor(max_workers=1)
    try:
        voices = pool.submit(
            service.list_voices, page_index=0, page_size=50, **({"prefix": prefix} if prefix else {})
        ).result(timeout=LIST_TIMEOUT_SECONDS)
    except FuturesTimeout:
        raise HTTPException(
            status_code=504,
            detail=f"查询音色列表超时（{LIST_TIMEOUT_SECONDS}s），上游可能不可达",
        ) from None
    except Exception as exc:  # noqa: BLE001 - scrubbed before it reaches the browser
        raise HTTPException(
            status_code=502, detail=f"查询音色列表失败: {redact.log_only('voices', exc)}"
        ) from exc
    finally:
        # wait=False matters: the context manager would block on the hung
        # worker and reintroduce the timeout we just enforced.
        pool.shutdown(wait=False, cancel_futures=True)

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
ENROLL_RETRY_SECONDS = 2.0


def _create_voice(public_url: str, prefix: str, target_model: str) -> tuple[str, str]:
    """Enroll, retrying transient download failures.

    DashScope reports `InputDownloadFailed` even when its fetch of the clip
    actually succeeded (visible as a 200 in this app's access log). It is
    noticeably more likely against a slow origin such as a tunnel, so the call
    is retried rather than surfaced as a hard failure.
    """
    last_error: Exception | None = None
    for attempt in range(1, ENROLL_ATTEMPTS + 1):
        service = _service()
        try:
            voice_id = service.create_voice(
                target_model=target_model, prefix=prefix, url=public_url
            )
            return voice_id, service.get_last_request_id()
        except Exception as exc:  # noqa: BLE001 - retried below
            last_error = exc
            if attempt < ENROLL_ATTEMPTS:
                print(f"[voices] attempt {attempt} failed: {exc}; retrying")
                time.sleep(ENROLL_RETRY_SECONDS)
    assert last_error is not None
    raise last_error


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
            detail="本机存储模式下请上传 WAV 文件（16kHz 单声道）",
        )

    try:
        public_url = await storage.put(payload, suffix)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        voice_id, request_id = _create_voice(public_url, prefix, target_model)
    except Exception as exc:  # noqa: BLE001 - scrubbed before it reaches the browser
        raise HTTPException(
            status_code=502, detail=f"音色复刻失败: {redact.log_only('voices.enroll', exc)}"
        ) from exc
    finally:
        # Deliberately not deleting the clip here: DashScope fetches the sample
        # asynchronously, after create_voice has returned. Expiry-based purging
        # in server/storage.py removes it once the fetch has certainly landed.
        storage.purge_expired()

    return {"voice_id": voice_id, "request_id": request_id, "target_model": target_model}


@router.delete("/{voice_id}")
def delete_voice(voice_id: str) -> dict:
    try:
        _service().delete_voice(voice_id)
    except Exception as exc:  # noqa: BLE001 - scrubbed before it reaches the browser
        raise HTTPException(
            status_code=502, detail=f"删除音色失败: {redact.log_only('voices.delete', exc)}"
        ) from exc
    return {"deleted": voice_id}