"""Tab 6 - voice cloning and voice management.

`VoiceEnrollmentService` needs a URL that DashScope can download, which is why
the original samples tell you to upload to OSS first
(samples/speech-synthesizer/synthesize_speech_from_text_with_cloned_voice/python/record.py:39).
Because this app is itself reachable over public HTTPS, it hosts the clip
instead - see server/storage.py for the two backends.
"""

import re
import time

from dashscope.audio.tts_v2 import VoiceEnrollmentService
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from . import config, storage

router = APIRouter(prefix="/api/voices", tags=["voices"])

# Matches the SDK constraint documented in the clone samples' docstring:
# digits and lowercase letters only, less than 10 characters.
PREFIX_PATTERN = re.compile(r"^[a-z0-9]{1,9}$")


def _service() -> VoiceEnrollmentService:
    # Falls back to dashscope.api_key, which dashscope_setup.bootstrap() has
    # already populated from DASHSCOPE_API_KEY.
    return VoiceEnrollmentService()


@router.get("")
def list_voices(prefix: str = "") -> dict:
    """List enrolled voices, optionally narrowed to one prefix."""
    service = _service()
    try:
        kwargs = {"page_index": 0, "page_size": 50}
        if prefix:
            kwargs["prefix"] = prefix
        voices = service.list_voices(**kwargs)
    except Exception as exc:  # noqa: BLE001 - reported to the operator
        raise HTTPException(status_code=502, detail=f"查询音色列表失败: {exc}") from exc
    return {"voices": voices, "request_id": service.get_last_request_id()}


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
    except Exception as exc:  # noqa: BLE001 - reported to the operator
        raise HTTPException(status_code=502, detail=f"音色复刻失败: {exc}") from exc
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
    except Exception as exc:  # noqa: BLE001 - reported to the operator
        raise HTTPException(status_code=502, detail=f"删除音色失败: {exc}") from exc
    return {"deleted": voice_id}