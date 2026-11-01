"""素材库：下载过的 Pexels 片段只下一遍，之后按标签/时长/方向复用。

存储（`LIBRARY_DIR`，挂到 /data 持久化）：
    {pexels_id}.mp4    片段
    {pexels_id}.jpg    缩略图
    {pexels_id}.json   元数据：url/preview/duration/orientation/tags/used/blacklisted

选片顺序：标签匹配的库内片段（优先没用过/最久没用）→ 没有就搜 Pexels，
下载进库再用。黑名单的片段永远不选；删除会同时删 mp4/jpg/json。
"""

import json
import os
import time

import requests

from . import config, clips, people

CACHE_SECONDS = 300


def _root() -> str:
    return config.LIBRARY_DIR


def _path(pexels_id) -> str:
    return os.path.join(_root(), f"{pexels_id}.json")


def _video_path(pexels_id) -> str:
    return os.path.join(_root(), f"{pexels_id}.mp4")


def _thumb_path(pexels_id) -> str:
    return os.path.join(_root(), f"{pexels_id}.jpg")


def _load(pexels_id) -> dict | None:
    try:
        with open(_path(pexels_id), encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, dict) else None
    except (OSError, ValueError):
        return None


def _save(meta: dict) -> None:
    os.makedirs(_root(), exist_ok=True)
    path = _path(meta["id"])
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False)
    os.replace(tmp, path)


def all_clips(*, include_blacklisted: bool = True) -> list[dict]:
    try:
        names = os.listdir(_root())
    except OSError:
        return []
    out = []
    for name in names:
        if not name.endswith(".json"):
            continue
        meta = _load(name.rsplit(".", 1)[0])
        if not meta:
            continue
        if not os.path.isfile(_video_path(meta["id"])):
            continue
        if meta.get("blacklisted") and not include_blacklisted:
            continue
        out.append(meta)
    out.sort(key=lambda item: item.get("addedAt") or 0, reverse=True)
    return out


def _score(meta: dict, terms: set[str]) -> int:
    tags = {str(tag).lower() for tag in meta.get("tags") or []}
    return len(tags & terms)


def choose(terms: list[str], orientation: str, min_duration: float, *, exclude=()) -> dict | None:
    wanted = {term.strip().lower() for term in terms if term and term.strip()}
    minimum = min_duration + 3
    pool = [
        meta
        for meta in all_clips(include_blacklisted=False)
        if meta.get("orientation") == orientation
        and float(meta.get("duration") or 0) >= minimum
        and meta.get("id") not in exclude
    ]
    if pool:
        # 标签越匹配越好；同样匹配时先用得少、最久没用的。
        pool.sort(key=lambda meta: (-_score(meta, wanted), meta.get("usedCount") or 0, meta.get("lastUsedAt") or 0))
        if _score(pool[0], wanted) > 0:
            return pool[0]

    # 库里没有匹配标签的，再搜 Pexels（仍然过人物过滤），下载进库。
    try:
        found = clips.suggest(terms, orientation, min_duration, limit=3)
    except Exception:
        return None
    for clip in found:
        if clip["id"] in exclude:
            continue
        return ensure(clip, tags=terms)
    return None


def ensure(clip: dict, *, tags: list[str] | None = None) -> dict | None:
    """Download a Pexels clip into the library (idempotent)."""
    pexels_id = str(clip["id"])
    existing = _load(pexels_id)
    if existing and os.path.isfile(_video_path(pexels_id)):
        if tags:
            merged = sorted({*(existing.get("tags") or []), *[tag for tag in tags if tag]})
            if merged != existing.get("tags"):
                existing["tags"] = merged
                _save(existing)
        return existing

    os.makedirs(_root(), exist_ok=True)
    try:
        response = requests.get(clip["url"], stream=True, timeout=(5, 60))
        response.raise_for_status()
        with open(_video_path(pexels_id), "wb") as handle:
            for chunk in response.iter_content(chunk_size=256 * 1024):
                if chunk:
                    handle.write(chunk)
        thumb = clip.get("preview") or ""
        if thumb:
            image = requests.get(thumb, timeout=(5, 30))
            if image.ok:
                with open(_thumb_path(pexels_id), "wb") as handle:
                    handle.write(image.content)
    except requests.RequestException:
        for path in (_video_path(pexels_id), _thumb_path(pexels_id)):
            try:
                os.unlink(path)
            except OSError:
                pass
        return None

    meta = {
        "id": pexels_id,
        "url": clip["url"],
        "preview": clip.get("preview") or "",
        "duration": clip.get("duration") or 0,
        "orientation": clip.get("orientation") or "",
        "tags": sorted({tag for tag in (tags or []) if tag}),
        "addedAt": int(time.time() * 1000),
        "usedCount": 0,
        "lastUsedAt": 0,
        "blacklisted": False,
    }
    _save(meta)
    return meta


def candidates(terms: list[str], orientation: str, min_duration: float, *, limit: int = 8, exclude=()) -> list[dict]:
    """Library matches first, then fresh Pexels suggestions (not downloaded yet)."""
    wanted = {term.strip().lower() for term in terms if term and term.strip()}
    minimum = min_duration + 3
    out: list[dict] = []
    seen: set[str] = set()
    for meta in all_clips(include_blacklisted=False):
        if meta.get("orientation") != orientation:
            continue
        if float(meta.get("duration") or 0) < minimum:
            continue
        if meta.get("id") in exclude or meta.get("id") in seen:
            continue
        seen.add(meta["id"])
        out.append(
            {
                "id": meta["id"],
                "preview": f"/api/library/{meta['id']}.jpg",
                "duration": meta.get("duration"),
                "source": "library",
                "tags": meta.get("tags") or [],
                "score": _score(meta, wanted),
            }
        )
    out.sort(key=lambda item: -item["score"])
    if len(out) >= limit:
        return out[:limit]

    try:
        fresh = clips.suggest(terms, orientation, min_duration, limit=limit)
    except Exception:
        fresh = []
    for clip in fresh:
        pexels_id = str(clip["id"])
        if pexels_id in seen or pexels_id in exclude:
            continue
        seen.add(pexels_id)
        out.append(
            {
                "id": pexels_id,
                "preview": clip.get("preview") or "",
                "duration": clip.get("duration"),
                "source": "pexels",
                "url": clip.get("url") or "",
                "tags": terms,
                "score": 0,
            }
        )
        if len(out) >= limit:
            break
    return out[:limit]


def mark_used(pexels_id) -> None:
    meta = _load(pexels_id)
    if not meta:
        return
    meta["usedCount"] = int(meta.get("usedCount") or 0) + 1
    meta["lastUsedAt"] = int(time.time() * 1000)
    _save(meta)


def set_blacklist(pexels_id, blacklisted: bool) -> dict | None:
    meta = _load(pexels_id)
    if not meta:
        return None
    meta["blacklisted"] = bool(blacklisted)
    _save(meta)
    return meta


def delete(pexels_id) -> bool:
    removed = False
    for path in (_path(pexels_id), _video_path(pexels_id), _thumb_path(pexels_id)):
        try:
            os.unlink(path)
            removed = True
        except OSError:
            pass
    return removed


def local_video_url(pexels_id) -> str:
    # 渲染器的下载代码用的是 https.get；回环 http 会直接失败。有公网地址就
    # 用公网 HTTPS（同一台机器，走反代），没有才退回回环（本地开发用）。
    base = config.PUBLIC_BASE_URL or config.VIDEO_AUDIO_BASE_URL
    return f"{base}/api/library/{pexels_id}.mp4"


def local_thumb_url(pexels_id) -> str:
    return f"/api/library/{pexels_id}.jpg"
