"""短视频：把语音工坊的稿子和音色交给内置的 short-video-maker 去渲染。

B 方案里 short-video-maker（Node/Remotion）和这个 FastAPI 应用装在同一个镜像、
同一个容器：渲染器只监听 `127.0.0.1:{VIDEO_RENDERER_PORT}`，浏览器永远只跟
本应用说话。这样做有三个直接后果，下面每个函数都围着它们转：

* 渲染器的 REST 面没有任何鉴权，直接暴露就是"谁能打开端口，谁就能烧你的
  Pexels 配额"。这里全部走会话鉴权，只把需要的那几个动作转发出去。
* 浏览器拿不到渲染器的地址，所以状态轮询、成片下载也由这里代理。下载必须
  流式转发：一条竖屏成片动辄几十 MB，读进内存再回吐会在小内存机器上直接 OOM。
* 渲染器崩了不能让整个应用跟着 500。"不可用"是一种正常状态，/options 会把它
  报给前端，前端据此禁用按钮并说明原因。

音色不走渲染器自带的 Kokoro：渲染器把每场戏的文本 POST 给内置 TTS 桥
（server/tts_bridge.py），桥用和语音合成页同一套 DashScope 音色。所以这里只
需要把用户选的复刻音色 id 原样塞进 `config.voice`。
"""

import json
import re
from typing import Iterable

import requests
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import api_voices, config, llm, redact, storage, voices

router = APIRouter(prefix="/api/video", tags=["video"])

# 渲染器只在本机/同容器里，30 秒足够建任务和查状态；下载单独给更长的读超时。
_CONNECT_TIMEOUT = 5.0

# 请求体上限。一场戏一条语音，20 场已经是 6 分钟以上的片子；再多就是拿这个
# 接口当批量渲染器用了，Pexels 也会先限流。
_MAX_SEARCH_TERMS = 4

_TAG_SET = {
    item["tag"].strip().lower()
    for item in (*voices.CONTROL_TAGS, *voices.RICH_TAGS)
    if item.get("tag")
}
_BRACKET = re.compile(r"\[([^\[\]\n]{0,48})\]")
_SENTENCE_END = re.compile(r"(?<=[。！？!?；;\n])")
_FENCE = re.compile(r"^\s*```[a-zA-Z0-9_-]*\s*\n?|\n?\s*```\s*$")


# ---- 请求体 ----------------------------------------------------------------


class ScenePayload(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    searchTerms: list[str] = Field(default_factory=list, max_length=_MAX_SEARCH_TERMS)
    # 来自语音记录时，这段旁白已经有合成好的 WAV；token 是 `/api/video/audio`
    # 返回的媒体文件名。为空才走渲染器的 TTS。
    audioToken: str = Field(default="", max_length=80)


class RenderPayload(BaseModel):
    # `model:voice`：qwen 的复刻音色加模型前缀能到 91 字符，80 会拦掉合法音色。
    voice: str = Field(default="", max_length=160)
    music: str = Field(default="", max_length=32)
    captionPosition: str = Field(default="bottom", max_length=16)
    orientation: str = Field(default="portrait", max_length=16)
    musicVolume: str = Field(default="low", max_length=16)
    paddingBack: int = Field(default=1500, ge=0, le=10_000)


class CreateVideoPayload(BaseModel):
    scenes: list[ScenePayload] = Field(min_length=1, max_length=config.VIDEO_MAX_SCENES)
    config: RenderPayload = Field(default_factory=RenderPayload)


class ScenesPayload(BaseModel):
    script: str = Field(min_length=1, max_length=config.VIDEO_MAX_SCRIPT_CHARS)
    model: str | None = None


class TermsPayload(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=config.VIDEO_MAX_SCENES)


# ---- 渲染器客户端 ----------------------------------------------------------


def _base() -> str:
    if not config.SVM_BASE_URL:
        raise HTTPException(status_code=503, detail="短视频未启用：没有配置渲染服务")
    return config.SVM_BASE_URL


def _request(method: str, path: str, **kwargs):
    """One call to the renderer, with every network failure made readable.

    `requests` exceptions carry the URL and sometimes a proxy address; neither
    belongs in a browser response, so the detail is fixed text and the original
    goes to the server log through `redact.log_only`.
    """
    url = f"{_base()}{path}"
    kwargs.setdefault(
        "timeout", (_CONNECT_TIMEOUT, config.VIDEO_TIMEOUT_SECONDS)
    )
    try:
        return requests.request(method, url, **kwargs)
    except requests.RequestException as exc:
        redact.log_only("video", exc)
        raise HTTPException(
            status_code=502,
            detail="渲染服务不可用，请检查短视频服务是否在运行",
        ) from exc


def _json(response: requests.Response) -> dict:
    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="渲染服务返回了无法解析的响应") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="渲染服务返回了意外的响应")
    return payload


def _fail(response: requests.Response) -> None:
    """Surface the renderer's own validation text, but never its internals."""
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    message = payload.get("message") or payload.get("error") or f"HTTP {response.status_code}"
    raise HTTPException(status_code=502, detail=f"渲染服务拒绝了请求：{message}")


def _check_choice(value: str, allowed: list[str], field: str) -> str:
    if value not in allowed:
        raise HTTPException(status_code=400, detail=f"{field} 取值不合法：{value}")
    return value


# ---- 场景与标签 ------------------------------------------------------------


def strip_known_tags(text: str) -> str:
    """Drop `[excited]`-style tags from a line that is going to be a caption.

    渲染器会把整段文本同时用于 TTS 和字幕；不认识的方括号会被念出来，字幕里
    出现 `[laughing]` 也很怪。只删目录里有的标签，用户自己的方括号内容保留。
    """

    def _replace(match: re.Match[str]) -> str:
        return "" if match.group(0).strip().lower() in _TAG_SET else match.group(0)

    return _BRACKET.sub(_replace, text)


def split_sentences(script: str) -> list[dict]:
    """本地拆分：按句号/问号/换行切，再合并成不超过 60 字的场景。

    LLM 不可用时的降级路径。检索词留空，由用户在场景卡片里补 —— 这里编不出
    来，硬编一个中文词给 Pexels 只会搜出无关素材。
    """
    pieces: list[str] = []
    for chunk in _SENTENCE_END.split(script.replace("\r\n", "\n")):
        cleaned = strip_known_tags(chunk).strip()
        if cleaned:
            pieces.append(cleaned)

    scenes: list[dict] = []
    current = ""
    for piece in pieces:
        if current and len(current) + len(piece) > 60:
            scenes.append({"text": current, "searchTerms": []})
            current = piece
        else:
            current += piece
    if current:
        scenes.append({"text": current, "searchTerms": []})
    return scenes[: config.VIDEO_MAX_SCENES]


_SCENES_PROMPT = """你是短视频分镜师。把下面的口播稿切成适合竖屏短视频的场景。

规则：
- 每场 1–2 句，整场不超过 45 个字，按语义切，不要按字数硬切。
- 每场给 2–3 个英文 Pexels 视频检索词：具体、可视化的名词短语（如 "coffee pouring"、
  "city night traffic"），不要抽象概念、不要人名、不要同一个词反复出现。
- **检索词必须避开人物**：不要出现 man / woman / person / people / hands / face /
  portrait / crowd / worker 这类词，也不要描述有人物动作的场景；只描述空镜、
  物品、自然、纹理、光影。
- 保留原稿的说话顺序和措辞，不要改写、不要增删信息。
- 去掉 [excited] 这类情感标签。

只输出 JSON 数组，不要任何解释、不要代码围栏：
[{"text": "……", "searchTerms": ["…", "…"]}]

口播稿：
"""


_TERMS_PROMPT = """为下面每一段短视频旁白生成 2–3 个英文 Pexels 视频检索词。

要求：
- 具体、可视化的名词短语（如 "coffee pouring"、"forest sunlight"），不要抽象概念。
- **不要人物**：不要出现 man / woman / person / people / hands / face / portrait /
  crowd / worker 等词，也不要描述人物动作；只写空镜、物品、自然、纹理、光影。
- 每段一组，顺序与输入一致，不要改写旁白。

只输出 JSON 数组，长度等于输入段数，每项是字符串数组：
[["coffee pouring", "ceramic cup"], ["forest sunlight"]]

旁白数组：
"""


def _parse_terms(raw: str, expected: int) -> list[list[str]]:
    text = _FENCE.sub("", raw or "").strip()
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        raise ValueError("响应里没有 JSON 数组")
    payload = json.loads(text[start : end + 1])
    if not isinstance(payload, list):
        raise ValueError("响应不是数组")

    out: list[list[str]] = []
    for item in payload:
        if isinstance(item, str):
            item = [item]
        terms = []
        for term in item if isinstance(item, list) else []:
            term = str(term).strip()
            if term and term.lower() not in {t.lower() for t in terms}:
                terms.append(term[:60])
        out.append(terms[:_MAX_SEARCH_TERMS])

    # 模型少给/多给都按输入段数对齐：少给的补空数组，多给的丢掉，不让前端
    # 因为一个数组长度就对不上场景。
    if len(out) < expected:
        out.extend([[] for _ in range(expected - len(out))])
    return out[:expected]


def _parse_scenes(raw: str) -> list[dict]:
    text = _FENCE.sub("", raw or "").strip()
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        raise ValueError("响应里没有 JSON 数组")
    payload = json.loads(text[start : end + 1])
    if isinstance(payload, dict) and isinstance(payload.get("scenes"), list):
        payload = payload["scenes"]
    if not isinstance(payload, list):
        raise ValueError("响应不是数组")

    scenes: list[dict] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        text_value = strip_known_tags(str(item.get("text") or "")).strip()
        if not text_value:
            continue
        terms = item.get("searchTerms") or item.get("search_terms") or []
        if isinstance(terms, str):
            terms = [terms]
        cleaned_terms = []
        for term in terms if isinstance(terms, list) else []:
            term = str(term).strip()
            if term and term.lower() not in {t.lower() for t in cleaned_terms}:
                cleaned_terms.append(term[:60])
        scenes.append({"text": text_value[:500], "searchTerms": cleaned_terms[:_MAX_SEARCH_TERMS]})

    if not scenes:
        raise ValueError("拆分结果为空")
    return scenes[: config.VIDEO_MAX_SCENES]


# ---- 路由 ------------------------------------------------------------------


@router.get("/options")
def video_options() -> dict:
    """音乐标签、复刻音色和默认值，前端一次拿全。

    渲染器不可达时仍返回 200：enabled=false 让页签显示"服务没起来"，这比让
    请求直接 502、前端只剩一行红字更有用。音色列表失败同理，降级成空列表。
    """
    if not config.SVM_BASE_URL or not config.VIDEO_ENABLED:
        return {"enabled": False, "renderer": "off", "music": [], "voices": [], "defaults": {}}

    music = list(config.VIDEO_MUSIC_TAGS)
    renderer = "down"
    try:
        response = _request("GET", "/api/music-tags")
        if response.ok:
            payload = response.json()
            if isinstance(payload, list) and payload:
                music = [str(item) for item in payload]
            renderer = "ok"
    except HTTPException:
        pass

    voice_list: list[dict] = []
    try:
        payload = api_voices.list_voices("")
        for entry in payload.get("voices", []):
            voice_id = entry.get("voice_id") or entry.get("voiceId") or ""
            if not voice_id:
                continue
            voice_list.append(
                {
                    "id": voice_id,
                    "model": entry.get("target_model") or entry.get("model") or "",
                    "status": entry.get("status") or "",
                    "created": entry.get("gmt_create") or "",
                }
            )
    except Exception as exc:  # noqa: BLE001 - the tab must open even when DashScope is down
        redact.log_only("video", exc)

    return {
        "enabled": True,
        "renderer": renderer,
        "music": music,
        "voices": voice_list,
        "defaults": {
            "voice": config.VIDEO_DEFAULT_VOICE,
            "music": config.VIDEO_DEFAULT_MUSIC,
            "captionPosition": "bottom",
            "orientation": "portrait",
            "musicVolume": "low",
            "paddingBack": 1500,
        },
        "max_scenes": config.VIDEO_MAX_SCENES,
    }


@router.post("/scenes")
async def split_scenes(payload: ScenesPayload) -> dict:
    """把口播稿拆成场景 + 英文检索词。

    先试 LLM；没配模型、超时、输出不是 JSON、场景为空，任何一种情况都退回
    本地按句拆分并带一条 warning。一个"拆场景"按钮不该因为模型抽风就报废。
    """
    import asyncio

    script = payload.script.strip()
    if not script:
        raise HTTPException(status_code=400, detail="稿子是空的")

    if not llm.configured():
        return {"scenes": split_sentences(script), "warning": "未配置文本模型，已按句子拆分，检索词请手动填写"}

    try:
        raw = await asyncio.to_thread(
            llm.chat,
            [
                {"role": "system", "content": "只输出 JSON，不要解释。"},
                {"role": "user", "content": _SCENES_PROMPT + script},
            ],
            payload.model,
            max_tokens=min(config.LLM_MAX_TOKENS, 4000),
            temperature=0.2,
        )
        return {"scenes": _parse_scenes(raw)}
    except Exception as exc:  # noqa: BLE001 - fallback is the feature
        redact.log_only("video", exc)
        message = exc.detail if isinstance(exc, llm.LLMError) else "模型输出无法解析"
        return {
            "scenes": split_sentences(script),
            "warning": f"AI 拆分失败（{message}），已按句子拆分，检索词请手动填写",
        }


@router.post("/audio")
async def upload_audio(file: UploadFile = File(...)) -> dict:
    """收下浏览器里已经合成好的 WAV，给渲染器一个可下载的地址。

    为什么走服务端而不是浏览器直传：渲染器在容器里，浏览器拿不到它的地址；
    而且媒体地址必须能被同容器的 node 用回环访问。文件名是 uuid4，和声音复刻
    的临时样本同一套存储（`/media/{name}` 无鉴权，uuid 不可猜）。
    """
    if storage.backend() != "local":
        raise HTTPException(
            status_code=503,
            detail="现成音频只支持本地存储后端（一体化镜像）",
        )
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="音频为空")
    if len(payload) > config.VIDEO_AUDIO_MAX_BYTES:
        raise HTTPException(status_code=413, detail="音频太大")
    info = api_voices._wav_info(payload)
    if info is None or info[4] <= 0:
        raise HTTPException(status_code=400, detail="不是有效的 PCM WAV")
    try:
        url = await storage.put(payload, ".wav")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=redact.scrub(exc)) from exc
    name = url.rsplit("/", 1)[-1]
    return {"token": name, "duration": round(info[4], 3)}


@router.post("/terms")
async def suggest_terms(payload: TermsPayload) -> dict:
    """只补检索词，不动场景和文本。

    为什么要单独一个接口：「按句拆分」是本地零成本路径，拆出来的场景没有
    检索词；重新跑一次 AI 拆场景会把用户手改过的文本覆盖掉。这个接口只回
    一组词，前端按顺序贴到空位上。
    """
    import asyncio

    texts = [strip_known_tags(str(text)).strip()[:500] for text in payload.texts]
    if not any(texts):
        raise HTTPException(status_code=400, detail="没有可用的旁白")

    if not llm.configured():
        raise HTTPException(status_code=503, detail="未配置文本模型，无法生成检索词")

    try:
        raw = await asyncio.to_thread(
            llm.chat,
            [
                {"role": "system", "content": "只输出 JSON，不要解释。"},
                {
                    "role": "user",
                    "content": _TERMS_PROMPT + json.dumps(texts, ensure_ascii=False),
                },
            ],
            None,
            max_tokens=min(config.LLM_MAX_TOKENS, 2000),
            temperature=0.2,
        )
        return {"terms": _parse_terms(raw, len(texts))}
    except llm.LLMError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except Exception as exc:  # noqa: BLE001 - a bad completion is a retryable user error
        redact.log_only("video", exc)
        raise HTTPException(status_code=502, detail="模型输出无法解析，请重试") from exc


@router.post("")
def create_video(payload: CreateVideoPayload) -> dict:
    voice = payload.config.voice.strip() or config.VIDEO_DEFAULT_VOICE
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", voice):
        raise HTTPException(status_code=400, detail="音色 id 不合法")
    _check_choice(payload.config.captionPosition, config.VIDEO_CAPTION_POSITIONS, "字幕位置")
    _check_choice(payload.config.orientation, config.VIDEO_ORIENTATIONS, "画面方向")
    _check_choice(payload.config.musicVolume, config.VIDEO_MUSIC_VOLUMES, "音乐音量")
    music = payload.config.music or config.VIDEO_DEFAULT_MUSIC
    _check_choice(music, config.VIDEO_MUSIC_TAGS, "音乐")

    scenes = []
    for scene in payload.scenes:
        text = strip_known_tags(scene.text).strip()
        if not text:
            raise HTTPException(status_code=400, detail="每一场都需要文本")
        item = {
            "text": text,
            "searchTerms": [term.strip()[:60] for term in scene.searchTerms if term.strip()][
                :_MAX_SEARCH_TERMS
            ],
        }
        if scene.audioToken:
            if not re.fullmatch(r"[a-f0-9]{32}\.wav", scene.audioToken):
                raise HTTPException(status_code=400, detail="音频 token 不合法")
            stored = storage.read_local(scene.audioToken)
            info = api_voices._wav_info(stored) if stored else None
            if info is None or info[4] <= 0:
                raise HTTPException(
                    status_code=400,
                    detail="这段音频已过期，请从语音记录重新点「生成视频」",
                )
            item["audioUrl"] = f"{config.VIDEO_AUDIO_BASE_URL}/media/{scene.audioToken}"
            item["audioDuration"] = round(info[4], 3)
        scenes.append(item)

    body = {
        "scenes": scenes,
        "config": {
            "voice": voice,
            "music": music,
            "captionPosition": payload.config.captionPosition,
            "orientation": payload.config.orientation,
            "musicVolume": payload.config.musicVolume,
            "paddingBack": payload.config.paddingBack,
        },
    }
    response = _request("POST", "/api/short-video", json=body)
    if response.status_code not in (200, 201):
        _fail(response)
    data = _json(response)
    video_id = data.get("videoId") or data.get("id")
    if not video_id:
        raise HTTPException(status_code=502, detail="渲染服务没有返回任务 id")
    return {"videoId": video_id}


@router.get("")
def list_videos() -> dict:
    response = _request("GET", "/api/short-videos")
    if not response.ok:
        _fail(response)
    payload = _json(response)
    videos = payload.get("videos")
    if not isinstance(videos, list):
        videos = []
    return {
        "videos": [
            {
                "id": item.get("id"),
                "status": item.get("status"),
                "url": f"/api/video/{item.get('id')}/file" if item.get("status") == "ready" else None,
            }
            for item in videos
            if isinstance(item, dict) and item.get("id")
        ]
    }


@router.get("/{video_id}")
def video_status(video_id: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", video_id):
        raise HTTPException(status_code=400, detail="任务 id 不合法")
    response = _request("GET", f"/api/short-video/{video_id}/status")
    if not response.ok:
        _fail(response)
    status = _json(response).get("status") or "unknown"
    return {
        "id": video_id,
        "status": status,
        "url": f"/api/video/{video_id}/file" if status == "ready" else None,
    }


@router.delete("/{video_id}")
def delete_video(video_id: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", video_id):
        raise HTTPException(status_code=400, detail="任务 id 不合法")
    response = _request("DELETE", f"/api/short-video/{video_id}")
    if not response.ok:
        _fail(response)
    return {"ok": True}


def _stream(source: Iterable[bytes]):
    try:
        for chunk in source:
            yield chunk
    finally:
        close = getattr(source, "close", None)
        if callable(close):
            close()


@router.get("/{video_id}/file")
def video_file(video_id: str) -> StreamingResponse:
    """成片原样转发。

    `requests` 只在 iter_content 时才真正读网络，所以这里用生成器把块直接交给
    StreamingResponse，内存占用是一条块的量级，而不是整片的大小。
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", video_id):
        raise HTTPException(status_code=400, detail="任务 id 不合法")
    url = f"{_base()}/api/short-video/{video_id}"
    try:
        upstream = requests.get(
            url,
            stream=True,
            timeout=(_CONNECT_TIMEOUT, config.VIDEO_FILE_TIMEOUT_SECONDS),
        )
    except requests.RequestException as exc:
        redact.log_only("video", exc)
        raise HTTPException(status_code=502, detail="渲染服务不可用") from exc

    if upstream.status_code == 404:
        upstream.close()
        raise HTTPException(status_code=404, detail="视频还没生成好")
    if not upstream.ok:
        upstream.close()
        raise HTTPException(status_code=502, detail=f"渲染服务返回 HTTP {upstream.status_code}")

    headers = {"Content-Disposition": f'inline; filename="{video_id}.mp4"'}
    length = upstream.headers.get("content-length")
    if length:
        headers["Content-Length"] = length
    return StreamingResponse(
        _stream(upstream.iter_content(chunk_size=64 * 1024)),
        media_type=upstream.headers.get("content-type") or "video/mp4",
        headers=headers,
    )
