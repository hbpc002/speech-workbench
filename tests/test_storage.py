"""Storage backends for voice-clone enrollment audio.

These cases exist because the blob path used to be both untested and broken on
every Vercel deployment: `vercel-blob` was declared as an optional dependency,
which Vercel's Python builder never installs, so cloning always died with
"vercel-blob is required". Nothing here touches the network — the SDK resolves
credentials before it opens a connection, so a missing token fails offline.
"""

import asyncio
import os
import sys
import time
import types

import pytest

from server import config, storage


@pytest.fixture(autouse=True)
def isolated_media_dir(monkeypatch, tmp_path):
    """Never touch the real temp dir; a stray clip would survive the test run."""
    monkeypatch.setattr(storage, "MEDIA_DIR", str(tmp_path / "media"))
    monkeypatch.delenv("VERCEL", raising=False)
    return storage.MEDIA_DIR


def run(coro):
    return asyncio.run(coro)


class TestPutLocal:
    def test_writes_the_clip_and_returns_a_media_url(self, monkeypatch):
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", "https://app.example")
        url = storage._put_local(b"RIFFfake", ".wav")
        name = url.rsplit("/", 1)[-1]
        assert url == f"https://app.example/media/{name}"
        with open(os.path.join(storage.MEDIA_DIR, name), "rb") as handle:
            assert handle.read() == b"RIFFfake"

    def test_each_clip_gets_a_distinct_name(self, monkeypatch):
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", "https://app.example")
        urls = {storage._put_local(b"a", ".wav") for _ in range(5)}
        assert len(urls) == 5

    def test_suffix_is_preserved(self, monkeypatch):
        # DashScope picks its decoder from the extension.
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", "https://app.example")
        assert storage._put_local(b"a", ".mp3").endswith(".mp3")

    def test_missing_public_base_url_raises_chinese_error(self, monkeypatch):
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", "")
        with pytest.raises(RuntimeError) as excinfo:
            storage._put_local(b"a", ".wav")
        message = str(excinfo.value)
        assert "PUBLIC_BASE_URL" in message
        # The UI is Chinese; an English sentence here is what the user saw.
        assert "必须配置" in message

    def test_failed_put_leaves_no_orphan_file(self, monkeypatch):
        # Validation must come before the write, or every misconfigured
        # attempt leaks a clip nothing will ever read.
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", "")
        with pytest.raises(RuntimeError):
            storage._put_local(b"a", ".wav")
        assert not os.path.isdir(storage.MEDIA_DIR) or os.listdir(storage.MEDIA_DIR) == []


class TestPutBlob:
    """The blob call convention is the whole point of these.

    Two traps, both of which silently break cloning:
      * `access` must be public — DashScope fetches the URL with no credentials.
      * `token` must be omitted, not passed as None. The SDK resolves
        "explicit token" before the environment, so an explicit None would
        short-circuit BLOB_READ_WRITE_TOKEN instead of falling back to it.
    """

    @staticmethod
    def _fake_sdk(monkeypatch, recorder):
        module = types.ModuleType("vercel.blob")

        class BlobError(Exception):
            pass

        class BlobNoTokenProvidedError(BlobError):
            pass

        class FakeResult:
            url = "https://store.public.blob.vercel-storage.com/deadbeef.wav"

        class FakeClient:
            async def put(self, path, body, **kwargs):
                recorder["path"] = path
                recorder["body"] = body
                recorder["kwargs"] = kwargs
                return FakeResult()

        module.BlobError = BlobError
        module.BlobNoTokenProvidedError = BlobNoTokenProvidedError
        module.AsyncBlobClient = FakeClient
        monkeypatch.setitem(sys.modules, "vercel", types.ModuleType("vercel"))
        monkeypatch.setitem(sys.modules, "vercel.blob", module)
        return module

    def test_uploads_as_a_public_blob(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", "vercel_blob_rw_token")
        recorder = {}
        self._fake_sdk(monkeypatch, recorder)

        url = run(storage.put(b"RIFFfake", ".wav"))

        assert url == "https://store.public.blob.vercel-storage.com/deadbeef.wav"
        assert recorder["kwargs"]["access"] == "public"
        assert recorder["body"] == b"RIFFfake"
        assert recorder["path"].endswith(".wav")

    def test_passes_the_configured_token(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", "vercel_blob_rw_token")
        recorder = {}
        self._fake_sdk(monkeypatch, recorder)

        run(storage.put(b"x", ".wav"))

        assert recorder["kwargs"]["token"] == "vercel_blob_rw_token"

    def test_omits_token_entirely_when_absent(self, monkeypatch):
        # Passing token=None would beat the env fallback and defeat the
        # BLOB_READ_WRITE_TOKEN Vercel injects.
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", None)
        monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "from-env")
        recorder = {}
        self._fake_sdk(monkeypatch, recorder)

        run(storage.put(b"x", ".wav"))

        assert "token" not in recorder["kwargs"]

    def test_sdk_failure_becomes_a_readable_error(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", "vercel_blob_rw_token")
        module = self._fake_sdk(monkeypatch, {})

        async def boom(self, path, body, **kwargs):
            raise module.BlobError("store suspended")

        module.AsyncBlobClient.put = boom

        with pytest.raises(RuntimeError) as excinfo:
            run(storage.put(b"x", ".wav"))
        assert "store suspended" in str(excinfo.value)

    def test_sdk_no_token_error_is_rewritten_in_chinese(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", "vercel_blob_rw_token")
        module = self._fake_sdk(monkeypatch, {})

        async def no_token(self, path, body, **kwargs):
            raise module.BlobNoTokenProvidedError()

        module.AsyncBlobClient.put = no_token

        with pytest.raises(RuntimeError) as excinfo:
            run(storage.put(b"x", ".wav"))
        assert "No token found" not in str(excinfo.value)
        assert "Connect to Project" in str(excinfo.value)

    def test_private_store_is_explained_with_the_actual_fix(self, monkeypatch):
        # A private store rejects public puts. Its URLs need auth on every
        # read, and DashScope reads anonymously, so there is no code-side way
        # around it -- the store has to be recreated as Public.
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", "vercel_blob_rw_token")
        module = self._fake_sdk(monkeypatch, {})

        async def private_store(self, path, body, **kwargs):
            raise module.BlobError(
                "Cannot use public access on a private store. "
                "The store is configured with private access."
            )

        module.AsyncBlobClient.put = private_store

        with pytest.raises(RuntimeError) as excinfo:
            run(storage.put(b"x", ".wav"))
        message = str(excinfo.value)
        assert "Cannot use public access" not in message
        assert "--access public" in message
        assert "Connect to Project" in message
        # It must say the store cannot be reconfigured, or the reader will go
        # hunting for an access toggle that does not exist.
        assert "改不了" in message

    def test_unrelated_blob_errors_are_not_reported_as_config_problems(
        self, monkeypatch
    ):
        # Only the private-store text is special-cased; everything else must
        # still surface the upstream detail.
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", "vercel_blob_rw_token")
        module = self._fake_sdk(monkeypatch, {})

        async def suspended(self, path, body, **kwargs):
            raise module.BlobError("store suspended")

        module.AsyncBlobClient.put = suspended

        with pytest.raises(RuntimeError) as excinfo:
            run(storage.put(b"x", ".wav"))
        assert "store suspended" in str(excinfo.value)
        assert "--access public" not in str(excinfo.value)

    def test_never_downgrades_to_private_access(self, monkeypatch):
        # Retrying with access="private" would upload fine and then fail later
        # as an opaque InputDownloadFailed from DashScope, which reads like an
        # upstream outage. Failing loudly at upload is the better trade.
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", "vercel_blob_rw_token")
        recorder = {}
        self._fake_sdk(monkeypatch, recorder)

        run(storage.put(b"x", ".wav"))

        assert recorder["kwargs"]["access"] == "public"
        assert "private" not in recorder["kwargs"].values()

    def test_missing_token_is_caught_before_any_request(self, monkeypatch):
        # The real SDK, so this also pins that credentials resolve offline.
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", None)
        monkeypatch.delenv("BLOB_READ_WRITE_TOKEN", raising=False)
        monkeypatch.delenv("VERCEL_BLOB_READ_WRITE_TOKEN", raising=False)
        for name in ("vercel", "vercel.blob"):
            monkeypatch.delitem(sys.modules, name, raising=False)

        with pytest.raises(RuntimeError) as excinfo:
            run(storage.put(b"x", ".wav"))
        message = str(excinfo.value)
        assert "BLOB_READ_WRITE_TOKEN" in message
        # The SDK's own text only says "configure the variable" and never
        # says where; a Blob store exists but is not connected to the project
        # is by far the most common cause.
        assert "Connect to Project" in message

    def test_upload_error_message_matches_the_startup_check(self, monkeypatch):
        # Same problem, so same words — the boot log and the UI must not
        # describe it two different ways.
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", None)
        monkeypatch.delenv("BLOB_READ_WRITE_TOKEN", raising=False)
        monkeypatch.delenv("VERCEL_BLOB_READ_WRITE_TOKEN", raising=False)
        for name in ("vercel", "vercel.blob"):
            monkeypatch.delitem(sys.modules, name, raising=False)

        with pytest.raises(RuntimeError) as excinfo:
            run(storage.put(b"x", ".wav"))
        assert str(excinfo.value) == storage.check()


class TestBackendDispatch:
    def test_local_backend_never_imports_the_sdk(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", "https://app.example")
        for name in ("vercel", "vercel.blob"):
            monkeypatch.delitem(sys.modules, name, raising=False)
        assert storage.backend() == "local"
        assert storage.put.__doc__  # sanity: module loaded
        assert storage._put_local(b"a", ".wav").startswith("https://app.example/media/")

    def test_blob_backend_is_selected_on_vercel(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "auto")
        monkeypatch.setenv("VERCEL", "1")
        assert storage.backend() == "blob"


class TestCheck:
    """Fail fast at boot instead of at the user's click."""

    def test_local_with_a_public_origin_is_healthy(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", "https://app.example")
        assert storage.check() is None

    def test_local_without_a_base_url_is_reported(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", "")
        assert "PUBLIC_BASE_URL" in storage.check()

    @pytest.mark.parametrize(
        "base",
        [
            "http://localhost:8080",
            "https://localhost",
            "http://127.0.0.1:8080",
            "http://0.0.0.0:8080",
        ],
    )
    def test_loopback_origin_is_reported(self, monkeypatch, base):
        # DashScope cannot reach the developer's machine, so this fails late
        # with a download error that looks like an upstream bug.
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", base)
        problem = storage.check()
        assert problem and "公网" in problem

    def test_a_port_on_a_real_host_is_not_mistaken_for_loopback(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", "https://app.example:8443")
        assert storage.check() is None

    def test_blob_without_a_token_is_reported(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", None)
        problem = storage.check()
        assert "BLOB_READ_WRITE_TOKEN" in problem
        # Point at the actual fix, not just the symptom.
        assert "Connect to Project" in problem

    def test_blob_with_a_token_is_healthy(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", "vercel_blob_rw_token")
        assert storage.check() is None

    def test_message_never_echoes_the_token(self, monkeypatch):
        # It lands in logs and in the /healthz call chain.
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        monkeypatch.setattr(config, "BLOB_TOKEN", "vercel_blob_rw_supersecret")
        assert "supersecret" not in (storage.check() or "")


class TestReadLocal:
    def test_round_trips_a_stored_clip(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", "https://app.example")
        name = storage._put_local(b"RIFFfake", ".wav").rsplit("/", 1)[-1]
        assert storage.read_local(name) == b"RIFFfake"

    def test_unknown_name_is_none(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        assert storage.read_local("nope.wav") is None

    @pytest.mark.parametrize(
        "name",
        ["../../etc/passwd", "..%2f..%2fetc%2fpasswd", "/etc/passwd"],
    )
    def test_paths_outside_the_media_dir_are_refused(self, monkeypatch, name):
        # /media/{name} is unauthenticated: DashScope fetches it with no
        # session, so traversal here is a file-disclosure hole.
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        assert storage.read_local(name) is None

    def test_blob_backend_never_reads_local(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        assert storage.read_local("anything.wav") is None


class TestPurge:
    def _age(self, path, seconds):
        stamp = time.time() - seconds
        os.utime(path, (stamp, stamp))

    def test_expired_clips_are_dropped_and_fresh_ones_kept(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        os.makedirs(storage.MEDIA_DIR, exist_ok=True)
        stale = os.path.join(storage.MEDIA_DIR, "stale.wav")
        fresh = os.path.join(storage.MEDIA_DIR, "fresh.wav")
        for path in (stale, fresh):
            with open(path, "wb") as handle:
                handle.write(b"x")
        self._age(stale, storage.GRACE_SECONDS + 60)
        self._age(fresh, 5)

        assert storage.purge_expired() == 1
        assert not os.path.exists(stale)
        assert os.path.exists(fresh)

    def test_grace_period_outlives_an_enrollment_call(self):
        # DashScope downloads the sample after create_voice has returned;
        # too short a window produces BadRequest.InputDownloadFailed.
        assert storage.GRACE_SECONDS >= 300

    def test_discard_is_a_noop_on_the_blob_backend(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        storage.discard("anything.wav")

    def test_purge_local_clears_everything_on_startup(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        os.makedirs(storage.MEDIA_DIR, exist_ok=True)
        with open(os.path.join(storage.MEDIA_DIR, "left.wav"), "wb") as handle:
            handle.write(b"x")

        storage.purge_local()

        assert not os.path.isdir(storage.MEDIA_DIR)

    def test_purge_local_keeps_the_blob_store(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        os.makedirs(storage.MEDIA_DIR, exist_ok=True)
        storage.purge_local()
        assert os.path.isdir(storage.MEDIA_DIR)