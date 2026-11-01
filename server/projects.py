"""短视频项目：把每场的文本、音频、选中的素材存下来，成片后还能改。

目录放在成片目录下的 `projects/{project_id}/`，随 `/app/data/videos` 挂载持久化。
一个项目可以对应多次渲染（videoIds）；编辑时只换某一场的 clip，音频和其余
素材不动，重新渲染生成一个新 videoId，旧片子保留。

项目 id 是 uuid4，音频 URL 走无鉴权的 `/api/video/projects/{id}/audio/{index}.wav`，
因为渲染器在容器里取它，带不了会话 Cookie；uuid 不可猜，安全水位和复刻样本的
`/media/{uuid}` 一致。
"""

import json
import os
import uuid

from . import config

ID_RE = r"[a-f0-9]{32}"


def new_id() -> str:
    return uuid.uuid4().hex


def _root() -> str:
    return config.PROJECTS_DIR


def _dir(project_id: str) -> str:
    return os.path.join(_root(), project_id)


def save(project: dict) -> None:
    project_id = project["id"]
    os.makedirs(_dir(project_id), exist_ok=True)
    path = os.path.join(_dir(project_id), "project.json")
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(project, handle, ensure_ascii=False)
    os.replace(tmp, path)


def load(project_id: str) -> dict | None:
    try:
        with open(os.path.join(_dir(project_id), "project.json"), encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, dict) else None
    except (OSError, ValueError):
        return None


def write_audio(project_id: str, index: int, payload: bytes) -> None:
    os.makedirs(_dir(project_id), exist_ok=True)
    with open(os.path.join(_dir(project_id), f"audio-{index}.wav"), "wb") as handle:
        handle.write(payload)


def audio_path(project_id: str, index: int) -> str:
    return os.path.join(_dir(project_id), f"audio-{index}.wav")
