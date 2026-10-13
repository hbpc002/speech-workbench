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

A misconfigured backend is not a crash at boot: `resolve_storage_backend()`
picks `blob` on any Vercel deployment, whether or not the credentials are
there. Cloning therefore failed on the user's click rather than at deploy
time, with an opaque message. `check()` exists to say so up front.
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


def check() -> str | None:
    """自检当前后端能不能真的跑通复刻。

    返回 None 表示一切就绪，否则返回一句中文说明，写到了哪里、缺什么、怎么补。
    存成字符串而不是抛异常，是因为调用方有两种用途：启动时打日志，
    `/healthz` 里只取一个布尔值（那个端点无鉴权，不能把细节抖出去）。
    """
    if backend() == "blob":
        return _check_blob()
    return _check_local()


_LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]")

# 自检和上传失败共用同一套文案：同一个问题，启动时和用户点下去时不该说
# 成两样话，所以集中在这里，不在两处各写一份。
_NO_BLOB_TOKEN = (
    "选择了 blob 存储但没有 BLOB_READ_WRITE_TOKEN。请到 Vercel 项目的 "
    "Storage → Blob store → Projects → Connect to Project，勾选 Production 和 "
    "Preview 把 store 连到项目，Vercel 会自动注入该变量。"
)
_NO_VERCEL_SDK = (
    "选择了 blob 存储但没装 vercel 依赖，请执行 `pip install vercel`；"
    "或改用 STORAGE_BACKEND=local 并同时配置 PUBLIC_BASE_URL。"
)


def _check_local() -> str | None:
    base = config.PUBLIC_BASE_URL
    if not base:
        return (
            "local 存储缺少 PUBLIC_BASE_URL，阿里云无法从公网下载复刻样本，声音复刻会失败。"
        )
    host = base.split("//", 1)[-1].split("/", 1)[0].split(":", 1)[0]
    if host in _LOOPBACK_HOSTS:
        return (
            f"PUBLIC_BASE_URL 指向 {host}，阿里云从公网访问不到本机，声音复刻会失败。"
            "本地开发请用内网穿透给一个公网地址，或部署到有公网域名的平台。"
        )
    return None


def _check_blob() -> str | None:
    try:
        import vercel.blob  # noqa: F401 - 只验证装没装
    except ImportError:
        return _NO_VERCEL_SDK
    if not config.BLOB_TOKEN:
        return _NO_BLOB_TOKEN
    return None


async def put(wav_bytes: bytes, suffix: str = ".wav") -> str:
    """Store the clip and return a URL DashScope can fetch."""
    if backend() == "blob":
        return await _put_blob(wav_bytes, suffix)
    return _put_local(wav_bytes, suffix)


def _put_local(wav_bytes: bytes, suffix: str) -> str:
    # 先验后写：反过来的话每次配置缺失都会在临时目录里留下一个没人会读的孤儿文件。
    base = config.PUBLIC_BASE_URL
    if not base:
        raise RuntimeError(
            "本机存储模式下必须配置 PUBLIC_BASE_URL：阿里云要从公网下载这段复刻样本，"
            "没有公开地址无法完成复刻。"
        )
    _ensure_dir()
    name = uuid.uuid4().hex + suffix
    with open(os.path.join(MEDIA_DIR, name), "wb") as handle:
        handle.write(wav_bytes)
    return f"{base}/media/{name}"


async def _put_blob(wav_bytes: bytes, suffix: str) -> str:
    try:
        from vercel.blob import AsyncBlobClient, BlobError, BlobNoTokenProvidedError
    except ImportError as exc:  # pragma: no cover - vercel 是主依赖，正常不会缺
        raise RuntimeError(_NO_VERCEL_SDK) from exc

    name = uuid.uuid4().hex + suffix
    # access 必须是 public：DashScope 是匿名回源下载这段音频的，不会带任何凭据。
    # token 只在真的拿到了才显式传 —— SDK 的解析顺序是
    # 「显式 token > 环境变量 BLOB_READ_WRITE_TOKEN」，传一个 token=None 进去
    # 会连环境变量那条兜底路径一起短路掉。
    kwargs = {"access": "public"}
    if config.BLOB_TOKEN:
        kwargs["token"] = config.BLOB_TOKEN
    try:
        result = await AsyncBlobClient().put(name, wav_bytes, **kwargs)
    except BlobNoTokenProvidedError as exc:
        # store 建好了但没连到项目，最常见的一种，SDK 的英文原文只说配置变量，
        # 没说去哪儿配。换掉。
        raise RuntimeError(_NO_BLOB_TOKEN) from exc
    except BlobError as exc:
        raise RuntimeError(f"上传到 Vercel Blob 失败：{exc}") from exc
    if not result.url:
        raise RuntimeError("Vercel Blob 上传成功，但没有返回可下载的 url。")
    return result.url


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