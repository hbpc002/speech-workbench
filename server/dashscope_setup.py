"""Shared DashScope SDK bootstrap.

Every sample in this repo repeats the same api-key / workspace-endpoint
wiring, so it is centralised here.
"""

import dashscope

from . import config

# Real workspace ids look like `llm-xxxxxxxx`; see the `qwen-audio-3.0` samples
# under samples/speech-recognition/. Anything else is almost certainly a
# placeholder that was pasted in from a docs snippet.
WORKSPACE_ID_PATTERN = r"^llm-[A-Za-z0-9]+$"

PLACEHOLDER_HINT = (
    "看起来不像业务空间 ID（正常形如 llm-xxxxxxxx）。它会被拼成域名 "
    "https://{值}.cn-beijing.maas.aliyuncs.com，这个域名解析不了，"
    "所有 DashScope 调用都会挂到超时为止 —— 表现是「上游不可达」而不是「填错了」。"
    "不需要专属端点就把它留空；在百炼控制台「业务空间 → 业务空间详情」可以查到。"
)


def looks_like_workspace_id(value: str) -> bool:
    import re

    return bool(re.match(WORKSPACE_ID_PATTERN, value or ""))


def bootstrap() -> None:
    """Apply api key and rewrite endpoints for workspace-scoped models.

    qwen-audio-3.0-* models live behind a per-workspace host; see
    samples/speech-recognition/recognize_speech_qwen-audio-3.0-asr-flash-streaming-with-vocabulary/python/run.py:49
    """
    if config.API_KEY:
        dashscope.api_key = config.API_KEY

    if config.WORKSPACE_ID:
        workspace = config.WORKSPACE_ID
        if not looks_like_workspace_id(workspace):
            print(f"[boot] WARNING: DASHSCOPE_WORKSPACE_ID={workspace!r} {PLACEHOLDER_HINT}")
        dashscope.base_http_api_url = (
            f"https://{workspace}.cn-beijing.maas.aliyuncs.com/api/v1"
        )
        dashscope.base_websocket_api_url = (
            f"wss://{workspace}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
        )
        # The resolved host is the single most useful thing when DashScope calls
        # hang, and it is safe to log: the dashboard-only /healthz deliberately
        # does not expose it.
        print(f"[boot] using workspace endpoint: {dashscope.base_http_api_url}")
    else:
        print(f"[boot] using public endpoint: {dashscope.base_http_api_url}")