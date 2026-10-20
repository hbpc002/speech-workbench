"""Voice-clone endpoints: input validation and, above all, error scrubbing.

The regression here is `api_voices` interpolating the raw upstream exception
into the response `detail`. DashScope answers an invalid key with
`invalid Authorization header: Bearer sk-xxxx`, which reached the browser
verbatim — exactly what `server/redact.py` exists to prevent, and it was
already applied on the sibling list endpoint in the same file.
"""

import io
import wave

import pytest
from fastapi.testclient import TestClient

from server import api_voices, config, storage
from server.main import app

SECRET = "sk-" + "a1b2c3d4e5" + "f6g7h8i9j0"


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def no_auth(monkeypatch):
    monkeypatch.setattr(config, "APP_PASSWORD", "")
    monkeypatch.setattr(config, "SESSION_SECRET", "")


def make_wav(seconds=6.0, rate=24000, channels=1, bits=16, frames=None):
    """A valid PCM WAV, so validation exercises the same shape the UI sends."""
    if frames is None:
        frames = int(seconds * rate)
    out = io.BytesIO()
    with wave.open(out, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(bits // 8)
        handle.setframerate(rate)
        handle.writeframes(b"\0" * frames * channels * (bits // 8))
    return out.getvalue()


@pytest.fixture
def wav_upload():
    return {"audio": ("sample.wav", io.BytesIO(make_wav()), "audio/wav")}


@pytest.fixture
def stored_locally(monkeypatch):
    """Skip the storage layer; these cases are about what happens after it."""
    monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
    calls = []

    async def fake_put(payload, suffix=".wav"):
        calls.append((payload, suffix))
        return "https://app.example/media/abc.wav"

    monkeypatch.setattr(storage, "put", fake_put)
    monkeypatch.setattr(storage, "purge_expired", lambda *a, **k: 0)
    return calls


class TestValidation:
    def test_rejects_a_prefix_the_sdk_would_refuse(self, client, no_auth, wav_upload):
        # The SDK wants [a-z0-9]{1,9}; a mismatch there is an opaque 400.
        response = client.post("/api/voices", data={"prefix": "Bad-Prefix"}, files=wav_upload)
        assert response.status_code == 400
        assert "prefix" in response.json()["detail"]

    def test_rejects_an_unknown_target_model(self, client, no_auth, wav_upload):
        response = client.post("/api/voices", data={"target_model": "nope"}, files=wav_upload)
        assert response.status_code == 400
        assert "target_model" in response.json()["detail"]

    def test_rejects_an_empty_upload(self, client, no_auth):
        response = client.post(
            "/api/voices", files={"audio": ("sample.wav", io.BytesIO(b""), "audio/wav")}
        )
        assert response.status_code == 400

    def test_local_backend_refuses_mp3(self, client, no_auth, monkeypatch):
        # DashScope wants a WAV; an mp3 upstream reports a download error.
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        response = client.post(
            "/api/voices", files={"audio": ("sample.mp3", io.BytesIO(b"ID3"), "audio/mpeg")}
        )
        assert response.status_code == 400
        assert "WAV" in response.json()["detail"]

    def test_requires_a_session(self, client, monkeypatch, wav_upload):
        monkeypatch.setattr(config, "APP_PASSWORD", "hunter2")
        monkeypatch.setattr(config, "SESSION_SECRET", "hunter2")
        assert client.post("/api/voices", files=wav_upload).status_code == 401


class TestAudioValidation:
    def test_qwen_rejects_a_16khz_sample(self, client, no_auth):
        # The old pipeline recorded everything at 16 kHz. Qwen-Audio-TTS
        # rejects that with an upstream error that reads like an outage.
        files = {"audio": ("sample.wav", io.BytesIO(make_wav(rate=16000)), "audio/wav")}
        response = client.post(
            "/api/voices",
            data={"target_model": "qwen-audio-3.0-tts-flash"},
            files=files,
        )
        assert response.status_code == 400
        assert "24000" in response.json()["detail"]

    def test_qwen_accepts_24khz(self, client, no_auth, monkeypatch, stored_locally):
        monkeypatch.setattr(
            api_voices, "_create_voice", lambda *args, **kwargs: ("voice-1", "req-1")
        )
        files = {"audio": ("sample.wav", io.BytesIO(make_wav(rate=24000)), "audio/wav")}
        response = client.post(
            "/api/voices",
            data={"target_model": "qwen-audio-3.0-tts-flash"},
            files=files,
        )
        assert response.status_code == 200
        assert response.json()["voice_id"] == "voice-1"

    def test_cosyvoice_still_accepts_16khz(self, client, no_auth, monkeypatch, stored_locally):
        monkeypatch.setattr(
            api_voices, "_create_voice", lambda *args, **kwargs: ("voice-2", "req-2")
        )
        files = {"audio": ("sample.wav", io.BytesIO(make_wav(rate=16000)), "audio/wav")}
        response = client.post(
            "/api/voices",
            data={"target_model": "cosyvoice-v3-flash"},
            files=files,
        )
        assert response.status_code == 200

    def test_rejects_a_too_short_sample(self, client, no_auth):
        files = {"audio": ("sample.wav", io.BytesIO(make_wav(seconds=3)), "audio/wav")}
        response = client.post("/api/voices", files=files)
        assert response.status_code == 400
        assert "5" in response.json()["detail"]

    def test_rejects_a_sample_over_60_seconds(self, client, no_auth):
        files = {"audio": ("sample.wav", io.BytesIO(make_wav(seconds=61)), "audio/wav")}
        response = client.post("/api/voices", files=files)
        assert response.status_code == 400
        assert "60" in response.json()["detail"]

    def test_rejects_an_oversized_upload(self):
        with pytest.raises(api_voices.HTTPException) as excinfo:
            api_voices._validate_enroll_audio(
                b"x" * (api_voices.ENROLL_MAX_BYTES + 1), "cosyvoice-v3-flash"
            )
        assert excinfo.value.status_code == 400
        assert "10" in excinfo.value.detail


class TestRetryPolicy:
    class FakeService:
        def __init__(self, errors):
            self.errors = list(errors)
            self.calls = 0

        def create_voice(self, **kwargs):
            self.calls += 1
            if self.errors:
                raise self.errors.pop(0)
            return "voice-ok"

        def get_last_request_id(self):
            return "req-ok"

    def test_retries_a_download_failure(self, monkeypatch):
        service = self.FakeService(
            [RuntimeError("BadRequest.InputDownloadFailed: could not fetch clip")]
        )
        waits = []
        monkeypatch.setattr(api_voices, "_service", lambda: service)
        monkeypatch.setattr(api_voices.time, "sleep", waits.append)

        voice_id, request_id = api_voices._create_voice(
            "https://app.example/media/x.wav", "demo", "cosyvoice-v3-flash"
        )

        assert (voice_id, request_id) == ("voice-ok", "req-ok")
        assert service.calls == 2
        assert waits, "the retry should back off instead of hammering upstream"

    def test_does_not_retry_a_permanent_parameter_error(self, monkeypatch):
        service = self.FakeService(
            [RuntimeError("InvalidParameter: target_model does not exist")]
        )
        waits = []
        monkeypatch.setattr(api_voices, "_service", lambda: service)
        monkeypatch.setattr(api_voices.time, "sleep", waits.append)

        with pytest.raises(RuntimeError, match="InvalidParameter"):
            api_voices._create_voice(
                "https://app.example/media/x.wav", "demo", "cosyvoice-v3-flash"
            )

        assert service.calls == 1
        assert waits == []

    def test_is_retryable_recognises_both_sides(self):
        assert api_voices._is_retryable(RuntimeError("BadRequest.InputDownloadFailed"))
        assert api_voices._is_retryable(RuntimeError("Connection reset by peer"))
        assert api_voices._is_retryable(RuntimeError("Throttling: 429"))
        assert not api_voices._is_retryable(RuntimeError("InvalidParameter: prefix"))
        assert not api_voices._is_retryable(RuntimeError("ModelNotFound"))
        assert not api_voices._is_retryable(RuntimeError("QuotaExceeded"))

    def test_reports_the_upstream_reason_in_chinese(self):
        message = api_voices._friendly_enroll_error(
            RuntimeError("File sample rate unsupported"), "qwen-audio-3.0-tts-flash"
        )
        assert message.startswith("音色复刻失败")
        assert "24 kHz" in message

    def test_enroll_status_separates_throttling_and_bad_input(self):
        assert api_voices._enroll_status(RuntimeError("Throttling: 429")) == 429
        assert api_voices._enroll_status(RuntimeError("InvalidParameter")) == 400
        assert api_voices._enroll_status(RuntimeError("socket timeout")) == 502


class TestReadiness:
    def test_reports_not_ready_without_a_workspace(self, client, no_auth, monkeypatch):
        monkeypatch.setattr(config, "API_KEY", "sk-test")
        monkeypatch.setattr(config, "WORKSPACE_ID", "")
        monkeypatch.setattr(storage, "check", lambda: None)

        body = client.get("/api/voices/readiness").json()

        assert body["ready"] is False
        assert "DASHSCOPE_WORKSPACE_ID" in body["reason"]

    def test_reports_storage_problems(self, client, no_auth, monkeypatch):
        monkeypatch.setattr(config, "API_KEY", "sk-test")
        monkeypatch.setattr(config, "WORKSPACE_ID", "llm-abc")
        monkeypatch.setattr(storage, "check", lambda: "PUBLIC_BASE_URL 缺失")

        body = client.get("/api/voices/readiness").json()

        assert body["ready"] is False
        assert body["reason"] == "PUBLIC_BASE_URL 缺失"

    def test_reports_ready_when_everything_is_configured(self, client, no_auth, monkeypatch):
        monkeypatch.setattr(config, "API_KEY", "sk-test")
        monkeypatch.setattr(config, "WORKSPACE_ID", "llm-abc")
        monkeypatch.setattr(storage, "check", lambda: None)

        assert client.get("/api/voices/readiness").json()["ready"] is True


class TestErrorScrubbing:
    """A 401 from DashScope quotes the request that produced it."""

    @pytest.fixture
    def upstream_leaks_the_key(self, monkeypatch, stored_locally):
        def boom(*args, **kwargs):
            raise RuntimeError(f"invalid Authorization header: Bearer {SECRET}")

        monkeypatch.setattr(api_voices, "_create_voice", boom)

    def test_enrollment_error_never_carries_the_api_key(
        self, client, no_auth, wav_upload, upstream_leaks_the_key
    ):
        response = client.post("/api/voices", files=wav_upload)
        assert response.status_code == 502
        assert SECRET not in response.text
        assert "***" in response.json()["detail"]

    def test_enrollment_error_is_still_readable(
        self, client, no_auth, wav_upload, upstream_leaks_the_key
    ):
        detail = client.post("/api/voices", files=wav_upload).json()["detail"]
        assert detail.startswith("音色复刻失败")

    def test_delete_error_never_carries_the_api_key(self, client, no_auth, monkeypatch):
        def boom(*args, **kwargs):
            raise RuntimeError(f"invalid Authorization header: Bearer {SECRET}")

        monkeypatch.setattr(api_voices, "_service", lambda: type("S", (), {
            "delete_voice": staticmethod(boom),
        })())

        response = client.delete("/api/voices/voice-abc")
        assert response.status_code == 502
        assert SECRET not in response.text
        assert "***" in response.json()["detail"]


class TestDescribe:
    """`_describe` fills in what `list_voice` leaves out.

    The regression: the preview needs the voice's target model, `list_voice`
    does not return it, and the tab was reading a field that never existed --
    so it always fell back to the default model and every qwen-cloned voice
    failed with 418.
    """

    def test_recovers_the_target_model_from_the_id(self):
        out = api_voices._describe({"voice_id": "qwen-audio-3.0-tts-flash-me-abc123"})
        assert out["target_model"] == "qwen-audio-3.0-tts-flash"

    def test_recovers_the_prefix(self):
        out = api_voices._describe({"voice_id": "cosyvoice-v3-flash-zhang-abc123"})
        assert out["prefix"] == "zhang"

    def test_prefers_an_explicit_target_model(self):
        out = api_voices._describe(
            {"voice_id": "whatever-x-y", "target_model": "qwen-audio-3.0-tts-plus"}
        )
        assert out["target_model"] == "qwen-audio-3.0-tts-plus"

    def test_does_not_invent_a_model_for_an_unrecognised_id(self):
        # A wrong model is worse than none: it synthesises with a voice that
        # does not exist for it, or fails 418 looking like a broken voice.
        out = api_voices._describe({"voice_id": "legacy-format-xyz"})
        assert "target_model" not in out

    def test_labels_a_reviewing_voice(self):
        # A voice still under review is listed identically to a working one
        # otherwise, and the only symptom is a preview that sounds wrong.
        out = api_voices._describe({"voice_id": "cosyvoice-v3-flash-a-b", "status": "DEPLOYING"})
        assert out["status_label"] == "审核中"
        assert out["status_class"] == "warn"

    def test_labels_a_rejected_voice(self):
        out = api_voices._describe({"voice_id": "cosyvoice-v3-flash-a-b", "status": "UNDEPLOYED"})
        assert out["status_class"] == "err"

    def test_missing_status_is_not_reported_as_usable(self):
        out = api_voices._describe({"voice_id": "cosyvoice-v3-flash-a-b"})
        assert out["status_class"] != "ok"

    def test_preserves_the_upstream_fields(self):
        entry = {
            "voice_id": "cosyvoice-v3-flash-a-b",
            "gmt_create": "2026-10-14 13:38:02",
            "gmt_modified": "2026-10-14 13:38:02",
            "status": "OK",
        }
        out = api_voices._describe(entry)
        for key, value in entry.items():
            assert out[key] == value

    def test_does_not_mutate_the_input(self):
        entry = {"voice_id": "cosyvoice-v3-flash-a-b"}
        api_voices._describe(entry)
        assert entry == {"voice_id": "cosyvoice-v3-flash-a-b"}

    def test_survives_a_non_dict_entry(self):
        # Defensive: the cache holds whatever list_voices returned.
        assert api_voices._describe("unexpected") == "unexpected"


class TestStorageMisconfiguration:
    def test_storage_error_reaches_the_browser_in_chinese(self, client, no_auth, wav_upload, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")

        async def boom(payload, suffix=".wav"):
            raise RuntimeError("本机存储模式下必须配置 PUBLIC_BASE_URL")

        monkeypatch.setattr(storage, "put", boom)

        response = client.post("/api/voices", files=wav_upload)
        assert response.status_code == 500
        assert "PUBLIC_BASE_URL" in response.json()["detail"]


class TestHealthz:
    def test_reports_storage_readiness_without_leaking_details(self, client, no_auth, monkeypatch):
        # Unauthenticated endpoint: it may say whether things are fine, never
        # what is missing or which credentials exist.
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", None)

        response = client.get("/healthz")
        body = response.json()

        assert body["storage"] == "blob"
        assert body["storage_ok"] is False
        assert "BLOB_READ_WRITE_TOKEN" not in response.text
        assert SECRET not in response.text

    def test_healthy_storage_reports_true(self, client, no_auth, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", "https://app.example")
        assert client.get("/healthz").json()["storage_ok"] is True


class TestMediaRoute:
    def test_serves_a_stored_clip(self, client, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        monkeypatch.setattr(storage, "read_local", lambda name: b"RIFFfake")

        response = client.get("/media/abc.wav")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("audio/wav")

    def test_unknown_clip_is_404(self, client, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        monkeypatch.setattr(storage, "read_local", lambda name: None)
        assert client.get("/media/nope.wav").status_code == 404