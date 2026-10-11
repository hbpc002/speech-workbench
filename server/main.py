"""FastAPI entrypoint.

One process, one port: static assets, the REST surface and the WebSocket
endpoints live together. Render exposes one port, and Vercel's ASGI middleware
terminates the upgrade at `websocket.accept()`, so a single entrypoint works on
both without a second process or an nginx sidecar.
"""

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import (
    api_tagger,
    api_voices,
    auth,
    config,
    ratelimit,
    storage,
    ws_asr,
    ws_chat,
    ws_tts,
)
from .dashscope_setup import bootstrap

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

PROMPTS = {
    "base_constraints": "你是一个乐于助人的语音助手。请用简洁、口语化的中文回答。",
    "companion": "你是一位温柔的陪伴者，善于倾听，会顺着对方的话题自然地聊下去。",
    "tool": "你是一个智能体。当需要外部信息时，你会主动调用工具获取，然后用自然语言告知用户。",
    "reasoning": "你是一位善于推理的助手。回答前先在心里想清楚，再给出结论和理由。",
}


class LoginPayload(BaseModel):
    password: str = ""


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap()
    storage.purge_local()
    print(f"[boot] storage backend: {storage.backend()}")
    if not config.API_KEY:
        print("[boot] WARNING: DASHSCOPE_API_KEY is not set, requests will fail")
    yield


app = FastAPI(title="语音工坊", lifespan=lifespan, docs_url="/api/docs")


def _deployed_over_https(request: Request | None = None) -> bool:
    """Cookie `Secure` flag. Both Render and Vercel terminate TLS upstream."""
    if os.environ.get("VERCEL") or os.environ.get("RENDER"):
        return True
    if request is not None:
        forwarded = request.headers.get("x-forwarded-proto", "")
        if forwarded:
            return forwarded.split(",")[0].strip() == "https"
    return False


async def _reject_unauthenticated(websocket: WebSocket) -> None:
    await websocket.close(code=1008)


# ---- auth ------------------------------------------------------------------


def require_session(session: str | None = Cookie(default=None, alias=auth.COOKIE_NAME)):
    if not auth.is_authenticated(session):
        raise HTTPException(status_code=401, detail="需要登录")


# ---- public surface --------------------------------------------------------


@app.get("/healthz")
def healthz() -> dict:
    return {
        "status": "ok",
        "auth_enabled": auth.auth_enabled(),
        "has_api_key": bool(config.API_KEY),
        "storage": storage.backend(),
    }


@app.get("/api/config")
def get_config() -> dict:
    return config.public_config()


@app.get("/api/prompts")
def get_prompts() -> dict:
    return PROMPTS


@app.get("/authcheck")
def authcheck(session: str | None = Cookie(default=None, alias=auth.COOKIE_NAME)) -> dict:
    return {"authenticated": auth.is_authenticated(session)}


@app.post("/api/login")
def login(request: Request, response: Response, payload: LoginPayload) -> dict:
    if not auth.auth_enabled():
        return {"ok": True}

    key = ratelimit.client_key(request)
    locked = ratelimit.LOGIN_LIMITER.locked_for(key)
    if locked:
        retry = int(locked) + 1
        raise HTTPException(
            status_code=429,
            detail=f"尝试次数过多，请 {int(locked) // 60 + 1} 分钟后再试",
            headers={"Retry-After": str(retry)},
        )

    if not auth.check_password(payload.password):
        count = ratelimit.LOGIN_LIMITER.fail(key)
        left = max(0, ratelimit.LOGIN_LIMITER.limit - count)
        if left:
            raise HTTPException(status_code=401, detail=f"密码错误，还可尝试 {left} 次")
        raise HTTPException(status_code=429, detail="尝试次数过多，请稍后再试")

    ratelimit.LOGIN_LIMITER.reset(key)
    response.set_cookie(
        auth.COOKIE_NAME,
        auth.make_token(),
        httponly=True,
        samesite="lax",
        secure=_deployed_over_https(request),
        max_age=config.SESSION_TTL_SECONDS,
        path="/",
    )
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return {"ok": True}


# ---- voice cloning ---------------------------------------------------------

app.include_router(api_voices.router, dependencies=[Depends(require_session)])

# ---- automatic emotion tagging ----------------------------------------------

app.include_router(api_tagger.router, dependencies=[Depends(require_session)])


@app.get("/media/{name}")
def media(name: str):
    """Serve an enrollment clip while DashScope downloads it.

    Intentionally unauthenticated: DashScope fetches this URL server-side and
    cannot present a session cookie. The name is a uuid4 hex, so the URL is
    effectively unguessable and only lives for the few seconds enrollment takes.
    Only the local storage backend routes here; on Vercel the clip lives in Blob.
    """
    payload = storage.read_local(name)
    if payload is None:
        raise HTTPException(status_code=404, detail="not found")
    return Response(content=payload, media_type="audio/wav")


# ---- websockets ------------------------------------------------------------


@app.websocket("/ws/chat")
async def ws_chat_endpoint(websocket: WebSocket):
    if not await auth.websocket_authenticated(websocket):
        await _reject_unauthenticated(websocket)
        return
    await ws_chat.handle(websocket)


@app.websocket("/ws/asr")
async def ws_asr_endpoint(websocket: WebSocket):
    if not await auth.websocket_authenticated(websocket):
        await _reject_unauthenticated(websocket)
        return
    await ws_asr.handle(websocket)


@app.websocket("/ws/tts")
async def ws_tts_endpoint(websocket: WebSocket):
    if not await auth.websocket_authenticated(websocket):
        await _reject_unauthenticated(websocket)
        return
    await ws_tts.handle(websocket)



# ---- static ----------------------------------------------------------------

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")