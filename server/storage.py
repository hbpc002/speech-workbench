"""Platform-agnostic storage for voice-clone enrollment audio.

`VoiceEnrollmentService.create_voice(url=...)` requires DashScope to download
the sample from the public internet. Two ways to satisfy that:

local  - save to a temp dir and serve it from this app. Works on Render,
         Docker or any host with a stable origin. Single instance only.
blob   - upload to Vercel Blob and hand over the public blob URL. Required on
         Vercel, whose function filesystem is read-only outside /tmp and whose
         instances are not sticky, so a follow-up GET may land elsewhere.

This removes the OSS dependency the original samples require.

Note that `create_voice` returns as soon as the enrollment job is accepted;
DashScope then downloads the sample asynchronously. Deleting the file
immediately after the call returns reliably produces
`BadRequest.InputDownloadFailed`, so clips are kept for a grace period instead.
"""

import os
import shutil
import tempfile
import time
import uuid

from . import config

MEDIA_DIR = os.path.join(tempfile.gettempdir(), "speech-workbench-media")

# DashScope fetches the clip after `create_voice` has already returned, so the
# file has to outlive the call. Anything older than this is safe to drop.
GRACE_SECONDS = 15 * 60


def _ensure_dir() -> None:
    os.makedirs(MEDIA_DIR, exist_ok=True)


def backend() -> str:
    return config.resolve_storage_backend()


async def put(wav_bytes: bytes, suffix: str = ".wav") -> str:
    """Store the clip and return a URL DashScope can fetch."""
    if backend() == "blob":
        return await _put_blob(wav_bytes, suffix)
    return _put_local(wav_bytes, suffix)


def _put_local(wav_bytes: bytes, suffix: str) -> str:
    _ensure_dir()
    name = uuid.uuid4().hex + suffix
    with open(os.path.join(MEDIA_DIR, name), "wb") as handle:
        handle.write(wav_bytes)
    base = config.PUBLIC_BASE_URL
    if not base:
        raise RuntimeError(
            "PUBLIC_BASE_URL is required for local voice-clone storage: "
            "DashScope must download the sample from the public internet."
        )
    return f"{base}/media/{name}"


async def _put_blob(wav_bytes: bytes, suffix: str) -> str:
    try:
        from vercel_blob import put as blob_put
    except ImportError as exc:  # pragma: no cover - depends on deployment target
        raise RuntimeError(
            "vercel-blob is required for blob storage. Install it or set "
            "STORAGE_BACKEND=local together with PUBLIC_BASE_URL."
        ) from exc

    name = uuid.uuid4().hex + suffix
    # vercel-blob >= 0.4: put(path, data, options) — token and addRandomSuffix
    # live inside `options`, and `access` no longer exists (blobs are public).
    # It returns the API response dict, not the URL.
    response = blob_put(name, wav_bytes, options={"token": config.BLOB_TOKEN})
    url = response.get("url") if isinstance(response, dict) else response
    if not url:
        raise RuntimeError(f"vercel-blob did not return a url: {response!r}")
    return url


def read_local(name: str) -> bytes | None:
    """Read a locally stored clip. Returns None for unknown or unsafe names."""
    if backend() != "local":
        return None
    safe = os.path.basename(name)
    path = os.path.join(MEDIA_DIR, safe)
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as handle:
        return handle.read()


def discard(name: str) -> None:
    """Force-remove a clip. Prefer `purge_expired` over calling this."""
    if backend() != "local":
        return
    path = os.path.join(MEDIA_DIR, os.path.basename(name))
    try:
        os.remove(path)
    except OSError:
        pass


def purge_expired(max_age: float = GRACE_SECONDS) -> int:
    """Drop clips older than the grace window. Returns how many were removed."""
    if backend() != "local" or not os.path.isdir(MEDIA_DIR):
        return 0
    cutoff = time.time() - max_age
    removed = 0
    for entry in os.listdir(MEDIA_DIR):
        path = os.path.join(MEDIA_DIR, entry)
        try:
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                os.remove(path)
                removed += 1
        except OSError:
            pass
    return removed


def purge_local() -> None:
    """Drop every leftover clip. Called on startup because /tmp may be stale."""
    if backend() == "local" and os.path.isdir(MEDIA_DIR):
        shutil.rmtree(MEDIA_DIR, ignore_errors=True)