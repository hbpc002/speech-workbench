"""Tab 3 - automatic emotion tag insertion.

Two jobs, both synchronous from the browser's point of view but blocking on the
provider: tag a script the user already wrote, or write a new one from a topic.
Both return a preview payload rather than writing to the script directly, so
the browser can show the result and let the user decide.

The upstream call itself lives in server/llm.py; this module is only HTTP.
"""

import asyncio

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import config, llm, ratelimit, tagger

router = APIRouter(prefix="/api/tts", tags=["tts"])


class TagRequest(BaseModel):
    text: str = ""
    model: str = ""
    density: str = ""
    rich_level: str = ""


class ScriptRequest(BaseModel):
    topic: str = ""
    duration: str = "60 秒"
    tone: str = "亲切自然"
    audience: str = ""
    model: str = ""
    density: str = ""
    rich_level: str = ""


def _start(request: Request) -> str:
    """Claim one unit of the caller's budget, or refuse."""
    key = ratelimit.client_key(request)
    locked = ratelimit.TAGGER_LIMITER.locked_for(key)
    if locked:
        retry = int(locked) + 1
        raise HTTPException(
            status_code=429,
            detail=f"请求过于频繁，请 {retry} 分钟后再试",
            headers={"Retry-After": str(retry)},
        )
    ratelimit.TAGGER_LIMITER.fail(key)
    return key


def _check_text(text: str) -> str:
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="文本为空")
    if len(text) > config.TAGS_MAX_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"文本过长（{len(text)} 字），请控制在 {config.TAGS_MAX_CHARS} 字以内",
        )
    return text


def _check_density(density: str) -> str:
    density = (density or "").strip()
    if not density:
        return "normal"
    if density not in tagger.density_ids():
        known = "、".join(item["name"] for item in config.TAGS_DENSITIES)
        raise HTTPException(status_code=400, detail=f"未知密度 {density}，可选：{known}")
    return density


def _check_rich_level(level: str) -> str:
    level = (level or "").strip()
    if not level:
        return config.TAGS_DEFAULT_RICH_LEVEL
    if level not in tagger.rich_level_ids():
        known = "、".join(item["name"] for item in config.TAGS_RICH_LEVELS)
        raise HTTPException(status_code=400, detail=f"未知拟声标签档位 {level}，可选：{known}")
    return level


@router.post("/tag")
async def tag_text(payload: TagRequest, request: Request) -> dict:
    """Insert emotion tags into an existing script without rewriting it."""
    _start(request)
    text = _check_text(payload.text)
    density = _check_density(payload.density)
    rich_level = _check_rich_level(payload.rich_level)

    try:
        model = llm.resolve_model(payload.model)
        # requests is blocking; the event loop keeps serving audio meanwhile.
        result = await asyncio.to_thread(
            tagger.tag_text, text, density, rich_level, model
        )
    except llm.LLMError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from None

    return {"text": result.text, "inserted": result.inserted, "warnings": result.warnings}


@router.post("/script")
async def write_script(payload: ScriptRequest, request: Request) -> dict:
    """Write a fresh tagged script from a topic."""
    _start(request)
    topic = _check_text(payload.topic)
    density = _check_density(payload.density)
    rich_level = _check_rich_level(payload.rich_level)

    try:
        model = llm.resolve_model(payload.model)
        result = await asyncio.to_thread(
            tagger.write_script,
            topic,
            (payload.duration or "").strip() or "60 秒",
            (payload.tone or "").strip() or "亲切自然",
            (payload.audience or "").strip() or "普通听众",
            density,
            rich_level,
            model,
        )
    except llm.LLMError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from None

    return {"text": result.text, "inserted": result.inserted, "warnings": result.warnings}