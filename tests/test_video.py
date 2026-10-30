"""Short-video proxy: payload normalisation, fallbacks and streaming.

The renderer is faked at the `requests` boundary. What matters here is not the
renderer (it has its own tests upstream) but the contract this app adds:
session auth in front of an unauthenticated service, whitelisted options, and a
scene splitter that still works when the text model does not.
"""

import pytest
from fastapi.testclient import TestClient

from server import api_voices, config, llm, video
from server.main import app


class FakeResponse:
    def __init__(self, status_code=200, payload=None, headers=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.headers = headers or {}
        self.ok = 200 <= status_code < 300
        self.closed = False

    def json(self):
        return self._payload

    def iter_content(self, chunk_size=0):
        yield b"fake-mp4-bytes"

    def close(self):
        self.closed = True


@pytest.fixture(autouse=True)
def temp_meta_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "VIDEO_META_DIR", str(tmp_path / "videos"))


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def no_auth(monkeypatch):
    monkeypatch.setattr(config, "APP_PASSWORD", "")
    monkeypatch.setattr(config, "SESSION_SECRET", "")


@pytest.fixture
def renderer(monkeypatch):
    monkeypatch.setattr(config, "SVM_BASE_URL", "http://renderer.test")
    monkeypatch.setattr(config, "VIDEO_ENABLED", True)
    calls = []

    def fake_request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return FakeResponse(201, {"videoId": "vid-1"})

    monkeypatch.setattr(video.requests, "request", fake_request)
    return calls


def test_create_normalises_and_forwards(client, no_auth, renderer):
    response = client.post(
        "/api/video",
        json={
            "scenes": [
                {"text": "[excited] 今天聊露营。", "searchTerms": ["camping", " forest ", ""]},
            ],
            "config": {"voice": "cosyvoice-v3-flash-1-abc", "music": "chill"},
        },
    )
    assert response.status_code == 200
    assert response.json() == {"videoId": "vid-1"}

    method, url, kwargs = renderer[0]
    assert method == "POST"
    assert url == "http://renderer.test/api/short-video"
    body = kwargs["json"]
    # Known tags never reach the renderer: it would read them aloud and paint
    # them into the caption.
    assert body["scenes"][0]["text"] == "今天聊露营。"
    assert body["scenes"][0]["searchTerms"] == ["camping", "forest"]
    assert body["config"]["voice"] == "cosyvoice-v3-flash-1-abc"
    assert body["config"]["orientation"] == "portrait"
    assert body["config"]["paddingBack"] == 1500


def test_create_rejects_unknown_options(client, no_auth, renderer):
    base = {"scenes": [{"text": "你好", "searchTerms": ["city"]}], "config": {}}
    for field, value in (
        ("music", "dubstep"),
        ("orientation", "square"),
        ("captionPosition", "middle"),
        ("musicVolume", "loud"),
    ):
        body = {**base, "config": {**base["config"], field: value}}
        response = client.post("/api/video", json=body)
        assert response.status_code == 400, field
    assert renderer == []


def test_create_rejects_blank_scene(client, no_auth, renderer):
    response = client.post(
        "/api/video",
        json={"scenes": [{"text": "[sad]", "searchTerms": []}], "config": {}},
    )
    # `[sad]` is a known tag, so the text becomes empty after the strip.
    assert response.status_code == 400
    assert renderer == []


def test_status_maps_url_when_ready(client, no_auth, monkeypatch):
    monkeypatch.setattr(config, "SVM_BASE_URL", "http://renderer.test")
    monkeypatch.setattr(
        video.requests, "request", lambda *a, **k: FakeResponse(200, {"status": "ready"})
    )
    response = client.get("/api/video/abc123")
    assert response.status_code == 200
    assert response.json() == {
        "id": "abc123",
        "status": "ready",
        "progress": None,
        "title": "",
        "createdAt": None,
        "tookMs": None,
        "url": "/api/video/abc123/file",
    }


def test_status_rejects_bad_id(client, no_auth):
    assert client.get("/api/video/../../etc/passwd").status_code in (400, 404)
    assert client.get("/api/video/bad id").status_code == 400


def test_options_reports_renderer_down(client, no_auth, monkeypatch):
    monkeypatch.setattr(config, "SVM_BASE_URL", "http://renderer.test")
    monkeypatch.setattr(config, "VIDEO_ENABLED", True)

    def boom(*args, **kwargs):
        raise video.requests.ConnectionError("nope")

    monkeypatch.setattr(video.requests, "request", boom)
    monkeypatch.setattr(api_voices, "list_voices", lambda prefix="": {"voices": []})

    payload = client.get("/api/video/options").json()
    assert payload["enabled"] is True
    assert payload["renderer"] == "down"
    # The built-in table still drives the music picker when the renderer is off.
    assert "chill" in payload["music"]
    assert payload["defaults"]["music"] == config.VIDEO_DEFAULT_MUSIC


def test_options_off_without_renderer(client, no_auth, monkeypatch):
    monkeypatch.setattr(config, "SVM_BASE_URL", "")
    payload = client.get("/api/video/options").json()
    assert payload["enabled"] is False
    assert payload["renderer"] == "off"


def test_scenes_falls_back_without_model(client, no_auth, monkeypatch):
    monkeypatch.setattr(llm, "configured", lambda: False)
    response = client.post(
        "/api/video/scenes",
        json={"script": "第一句。第二句！第三句？"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["scenes"]
    assert "warning" in payload
    assert all(scene["searchTerms"] == [] for scene in payload["scenes"])


def test_scenes_uses_model_when_available(client, no_auth, monkeypatch):
    monkeypatch.setattr(llm, "configured", lambda: True)
    monkeypatch.setattr(
        llm,
        "chat",
        lambda *a, **k: '[{"text":"第一句。","searchTerms":["city night"]}]',
    )
    payload = client.post("/api/video/scenes", json={"script": "第一句。"}).json()
    assert payload["scenes"] == [{"text": "第一句。", "searchTerms": ["city night"]}]
    assert "warning" not in payload


def test_scenes_recovers_from_bad_model_output(client, no_auth, monkeypatch):
    monkeypatch.setattr(llm, "configured", lambda: True)
    monkeypatch.setattr(llm, "chat", lambda *a, **k: "好的，以下是分镜：")
    payload = client.post("/api/video/scenes", json={"script": "第一句。第二句。"}).json()
    assert payload["scenes"]
    assert "已按句子拆分" in payload["warning"]


def test_split_sentences_merges_and_strips():
    parts = video.split_sentences("[laughing] 你好。今天天气不错。我们出去走走吧。")
    assert "".join(part["text"] for part in parts) == "你好。今天天气不错。我们出去走走吧。"
    assert all(len(part["text"]) <= 60 for part in parts)


def test_strip_known_tags_keeps_user_brackets():
    assert video.strip_known_tags("你好 [excited] 世界") == "你好  世界"
    assert video.strip_known_tags("价格 [199元] 起") == "价格 [199元] 起"


def test_file_streams_through(client, no_auth, monkeypatch):
    monkeypatch.setattr(config, "SVM_BASE_URL", "http://renderer.test")

    def fake_get(url, **kwargs):
        assert url == "http://renderer.test/api/short-video/vid-9"
        return FakeResponse(
            200, headers={"content-type": "video/mp4", "content-length": "14"}
        )

    monkeypatch.setattr(video.requests, "get", fake_get)
    response = client.get("/api/video/vid-9/file")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("video/mp4")
    assert response.content == b"fake-mp4-bytes"


def test_file_404_when_not_ready(client, no_auth, monkeypatch):
    monkeypatch.setattr(config, "SVM_BASE_URL", "http://renderer.test")
    monkeypatch.setattr(
        video.requests, "get", lambda *a, **k: FakeResponse(404, {"error": "not ready"})
    )
    assert client.get("/api/video/vid-9/file").status_code == 404


# ---- /api/video/terms -------------------------------------------------------


def test_terms_returns_one_group_per_text(client, no_auth, monkeypatch):
    monkeypatch.setattr(llm, "configured", lambda: True)
    monkeypatch.setattr(
        llm,
        "chat",
        lambda *a, **k: '[["coffee pouring", "ceramic cup"], ["forest sunlight"]]',
    )
    response = client.post("/api/video/terms", json={"texts": ["咖啡", "森林"]})
    assert response.status_code == 200
    assert response.json()["terms"] == [
        ["coffee pouring", "ceramic cup"],
        ["forest sunlight"],
    ]


def test_terms_pads_short_model_output(client, no_auth, monkeypatch):
    monkeypatch.setattr(llm, "configured", lambda: True)
    monkeypatch.setattr(llm, "chat", lambda *a, **k: '[["ocean"]]')
    payload = client.post("/api/video/terms", json={"texts": ["海", "山"]}).json()
    # Missing groups become empty lists instead of shifting the mapping.
    assert payload["terms"] == [["ocean"], []]


def test_terms_accepts_a_flat_string(client, no_auth, monkeypatch):
    monkeypatch.setattr(llm, "configured", lambda: True)
    monkeypatch.setattr(llm, "chat", lambda *a, **k: '["coffee"]')
    payload = client.post("/api/video/terms", json={"texts": ["咖啡"]}).json()
    assert payload["terms"] == [["coffee"]]


def test_terms_requires_a_model(client, no_auth, monkeypatch):
    monkeypatch.setattr(llm, "configured", lambda: False)
    response = client.post("/api/video/terms", json={"texts": ["咖啡"]})
    assert response.status_code == 503


def test_terms_bad_output_is_a_retryable_error(client, no_auth, monkeypatch):
    monkeypatch.setattr(llm, "configured", lambda: True)
    monkeypatch.setattr(llm, "chat", lambda *a, **k: "好的，以下是检索词：")
    response = client.post("/api/video/terms", json={"texts": ["咖啡"]})
    assert response.status_code == 502


def test_terms_keeps_tags_out_of_the_prompt(client, no_auth, monkeypatch):
    seen = {}
    monkeypatch.setattr(llm, "configured", lambda: True)

    def fake_chat(messages, model, **kwargs):
        seen["prompt"] = messages[-1]["content"]
        return '[["coffee"]]'

    monkeypatch.setattr(llm, "chat", fake_chat)
    client.post("/api/video/terms", json={"texts": ["[excited] 咖啡。"]})
    assert "[excited]" not in seen["prompt"]


# ---- 现成音频（语音记录里的 WAV） --------------------------------------------


def make_wav(seconds=0.5, rate=16000):
    import io
    import wave

    out = io.BytesIO()
    with wave.open(out, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\0" * int(seconds * rate) * 2)
    return out.getvalue()


@pytest.fixture
def local_storage(monkeypatch):
    import os

    from server import storage

    monkeypatch.setattr(config, "PUBLIC_BASE_URL", "http://app.test")
    monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
    written = []
    yield written
    for name in written:
        try:
            os.unlink(os.path.join(storage.MEDIA_DIR, name))
        except OSError:
            pass


def test_upload_audio_returns_token_and_duration(client, no_auth, local_storage):
    response = client.post(
        "/api/video/audio",
        files={"file": ("scene.wav", make_wav(0.5), "audio/wav")},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["token"].endswith(".wav")
    assert payload["duration"] == 0.5
    local_storage.append(payload["token"])


def test_upload_audio_rejects_non_wav(client, no_auth, local_storage):
    response = client.post(
        "/api/video/audio",
        files={"file": ("scene.mp3", b"not a wav", "audio/mpeg")},
    )
    assert response.status_code == 400


def test_create_with_audio_token_reuses_the_file(client, no_auth, renderer, local_storage):
    token = client.post(
        "/api/video/audio",
        files={"file": ("scene.wav", make_wav(0.5), "audio/wav")},
    ).json()["token"]
    local_storage.append(token)

    response = client.post(
        "/api/video",
        json={
            "scenes": [{"text": "你好", "searchTerms": ["city"], "audioToken": token}],
            "config": {},
        },
    )
    assert response.status_code == 200

    scene = renderer[-1][2]["json"]["scenes"][0]
    assert scene["audioUrl"] == f"{config.VIDEO_AUDIO_BASE_URL}/media/{token}"
    assert scene["audioDuration"] == 0.5


def test_create_with_expired_audio_token_is_a_readable_error(client, no_auth, renderer):
    response = client.post(
        "/api/video",
        json={
            "scenes": [
                {"text": "你好", "searchTerms": ["city"], "audioToken": "a" * 32 + ".wav"}
            ],
            "config": {},
        },
    )
    assert response.status_code == 400
    assert "过期" in response.json()["detail"]
    assert renderer == []


def test_create_rejects_bad_audio_token(client, no_auth, renderer):
    response = client.post(
        "/api/video",
        json={
            "scenes": [{"text": "你好", "searchTerms": ["city"], "audioToken": "../etc/passwd"}],
            "config": {},
        },
    )
    assert response.status_code == 400
    assert renderer == []


def test_create_accepts_long_model_voice_pairs(client, no_auth, renderer):
    """qwen 的复刻音色加 model: 前缀是 91 字符，旧的 80 上限会误拦。"""
    voice = (
        "qwen-audio-3.0-tts-flash:"
        "qwen-audio-3.0-tts-flash-10282057-683db9a94bbb44709d1d7e86ce169cec"
    )
    assert len(voice) > 80
    response = client.post(
        "/api/video",
        json={
            "scenes": [{"text": "你好", "searchTerms": ["city"]}],
            "config": {"voice": voice},
        },
    )
    assert response.status_code == 200
    assert renderer[-1][2]["json"]["config"]["voice"] == voice


# ---- 记录标题与时间 ---------------------------------------------------------


def test_create_writes_title_and_time(client, no_auth, renderer, tmp_path):
    import json
    import time

    client.post(
        "/api/video",
        json={
            "scenes": [{"text": "今天聊露营装备。", "searchTerms": ["camping"]}],
            "config": {},
        },
    )
    meta = json.loads((tmp_path / "videos" / "vid-1.json").read_text(encoding="utf-8"))
    assert meta["title"] == "今天聊露营装备。"
    assert abs(meta["createdAt"] / 1000 - time.time()) < 10
    assert meta["scenes"] == 1


def test_list_includes_title_and_time(client, no_auth, monkeypatch, tmp_path):
    import json

    monkeypatch.setattr(config, "SVM_BASE_URL", "http://renderer.test")
    (tmp_path / "videos").mkdir(parents=True, exist_ok=True)
    (tmp_path / "videos" / "vid-2.json").write_text(
        json.dumps({"title": "海边的早晨", "createdAt": 1700000000000}, ensure_ascii=False),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        video.requests,
        "request",
        lambda *a, **k: FakeResponse(200, {"videos": [{"id": "vid-2", "status": "ready"}]}),
    )
    payload = client.get("/api/video").json()
    assert payload["videos"][0]["title"] == "海边的早晨"
    assert payload["videos"][0]["createdAt"] == 1700000000000


def test_delete_removes_meta(client, no_auth, monkeypatch, tmp_path):
    import json

    monkeypatch.setattr(config, "SVM_BASE_URL", "http://renderer.test")
    (tmp_path / "videos").mkdir(parents=True, exist_ok=True)
    meta = tmp_path / "videos" / "vid-3.json"
    meta.write_text(json.dumps({"title": "x"}), encoding="utf-8")
    monkeypatch.setattr(video.requests, "request", lambda *a, **k: FakeResponse(200, {"success": True}))
    assert client.delete("/api/video/vid-3").status_code == 200
    assert not meta.exists()
