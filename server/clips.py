"""Pexels 素材搜索：给工作台自己选片用。

为什么要工作台选片：渲染器是随机挑一条，挑完就忘，成片出来没法知道每场用了
什么，也就没法只换其中一场。工作台选片后把 clip 存进项目，编辑时能显示缩略图、
换掉其中一场，再把明确的 videoUrl 交给渲染器（渲染器跳过自己的搜索）。

筛选和渲染器一致：竖屏 1080x1920 / 横屏 1920x1080 的 hd 文件、时长至少比这段
音频多 3 秒；再过一遍 server/people.py 的 slug + YOLOv8n 过滤，不放人物。
"""

import time

import requests

from . import config, people

SIZES = {"portrait": (1080, 1920), "landscape": (1920, 1080)}
SAFE_TERMS = ["nature", "abstract", "forest", "ocean", "sky", "texture"]
CACHE_SECONDS = 300
MAX_CANDIDATES = 24

_cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}


def _hd_file(video: dict, width: int, height: int) -> dict | None:
    for item in video.get("video_files") or []:
        if item.get("quality") == "hd" and item.get("width") == width and item.get("height") == height:
            return item
    return None


def _duration(video: dict) -> float:
    files = video.get("video_files") or []
    fps = (files[0].get("fps") if files else None) or 25
    duration = float(video.get("duration") or 0)
    return duration * (fps / 25) if fps < 25 else duration


def _fetch(term: str, orientation: str) -> list[dict]:
    width, height = SIZES.get(orientation, SIZES["portrait"])
    key = (term, orientation)
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
        return cached[1]

    response = requests.get(
        "https://api.pexels.com/videos/search",
        headers={"Authorization": config.PEXELS_API_KEY},
        params={
            "query": term,
            "orientation": orientation,
            "size": "medium",
            "per_page": 40,
        },
        timeout=20,
    )
    response.raise_for_status()
    videos = (response.json() or {}).get("videos") or []

    candidates = []
    for video in videos:
        file = _hd_file(video, width, height)
        if not file:
            continue
        pictures = [item.get("picture") for item in (video.get("video_pictures") or [])[:2]]
        candidates.append(
            {
                "id": video.get("id"),
                "slug": video.get("url") or "",
                "url": file.get("link") or "",
                "preview": video.get("image") or (pictures[0] if pictures else ""),
                "duration": round(_duration(video), 2),
                "images": [url for url in [video.get("image"), *pictures] if url],
            }
        )
    candidates = [item for item in candidates if item["url"] and item["preview"]][:MAX_CANDIDATES]

    if candidates:
        filtered = people.filter_candidates(candidates)
        allowed = set(filtered["allowed"])
        candidates = [item for item in candidates if int(item["id"]) in allowed]

    for item in candidates:
        item.pop("images", None)

    _cache[key] = (time.monotonic(), candidates)
    return candidates


def suggest(
    terms: list[str],
    orientation: str,
    min_duration: float,
    *,
    limit: int = 6,
    fallback: bool = True,
) -> list[dict]:
    """Return up to `limit` person-free clips long enough for the scene."""
    if not config.PEXELS_API_KEY:
        raise RuntimeError("未配置 PEXELS_API_KEY，无法搜索素材")
    wanted = [term.strip() for term in terms if term and term.strip()]
    if fallback:
        wanted += [term for term in SAFE_TERMS if term not in wanted]

    seen: set[int] = set()
    out: list[dict] = []
    for term in wanted:
        try:
            candidates = _fetch(term, orientation)
        except requests.RequestException:
            continue
        for item in candidates:
            if item["id"] in seen or item["duration"] < min_duration + 3:
                continue
            seen.add(item["id"])
            out.append(
                {
                    "id": item["id"],
                    "url": item["url"],
                    "preview": item["preview"],
                    "duration": item["duration"],
                }
            )
            if len(out) >= limit:
                return out
        if out and not fallback:
            break
    return out


def pick(terms: list[str], orientation: str, min_duration: float) -> dict | None:
    clips = suggest(terms, orientation, min_duration, limit=1)
    return clips[0] if clips else None
