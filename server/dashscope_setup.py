"""Shared DashScope SDK bootstrap.

Every sample in this repo repeats the same api-key / workspace-endpoint
wiring, so it is centralised here.
"""

import dashscope

from . import config


def bootstrap() -> None:
    """Apply api key and rewrite endpoints for workspace-scoped models.

    qwen-audio-3.0-* models live behind a per-workspace host; see
    samples/speech-recognition/recognize_speech_qwen-audio-3.0-asr-flash-streaming-with-vocabulary/python/run.py
    """
    if config.API_KEY:
        dashscope.api_key = config.API_KEY

    if config.WORKSPACE_ID:
        dashscope.base_http_api_url = (
            f"https://{config.WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1"
        )
        dashscope.base_websocket_api_url = (
            f"wss://{config.WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
        )