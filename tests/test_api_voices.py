"""Voice-clone endpoints: input validation and, above all, error scrubbing.

The regression here is `api_voices` interpolating the raw upstream exception
into the response `detail`. DashScope answers an invalid key with
`invalid Authorization header: Bearer sk-xxxx`, which reached the browser
verbatim — exactly what `server/redact.py` exists to prevent, and it was
already applied on the sibling list endpoint in the same file.
"""

import io

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


@pytest.fixture
def wav_upload():
    return {"audio": ("sample.wav", io.BytesIO(b"RIFF" + b"\0" * 64), "audio/wav")}


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
        # DashScope wants wav at 16kHz; an mp3 upstream reports a download error.
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