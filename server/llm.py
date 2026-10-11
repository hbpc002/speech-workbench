"""Provider-agnostic chat completion over any OpenAI-compatible endpoint.

Tab 3 needs a text model to decide where emotion tags belong, but the app must
not care *which* provider supplies it. So this module speaks plain
`POST {base}/chat/completions` rather than going through a vendor SDK: 百炼's
compatible-mode, DeepSeek, Kimi, GLM, OpenRouter, a one-api gateway or a
self-hosted vLLM all answer the same request.

Everything that is provider-shaped lives here. Prompts, tag cleanup and
endpoint wiring belong to the caller -- see server/tagger.py.

The API key never leaves this process except inside the outbound Authorization
header; see server/config.py for why the base URL is not published either.
"""

import json

import requests

from . import config, redact


class LLMError(Exception):
    """An upstream failure already safe to show the browser.

    `status_code` is what the route should pass to HTTPException, `detail` is
    the scrubbed message. The unrounded-up original is in the server log only.
    """

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def models() -> list[dict]:
    """The model picker, exactly as configured."""
    return config.LLM_MODELS


def default_model() -> str:
    return config.LLM_MODEL


def configured() -> bool:
    """False when no key is available, so the UI can say why it is disabled."""
    return bool(config.LLM_API_KEY)


def resolve_model(model: str | None) -> str:
    """Validate a browser-supplied model id against the configured list.

    The browser must not be able to name an arbitrary upstream model: this is
    the same reasoning as tts_support.normalize_params, which drops unknown
    keys so the caller cannot smuggle arbitrary kwargs into the SDK.
    """
    if not model:
        fallback = config.LLM_MODEL
        if not fallback:
            raise LLMError(400, "未配置可用模型，请设置 LLM_MODEL")
        return fallback

    for choice in config.LLM_MODELS:
        if choice["id"] == model:
            return model

    known = ", ".join(choice["id"] for choice in config.LLM_MODELS) or "（无）"
    raise LLMError(400, f"未知模型 {model}，可用模型：{known}")


def chat(
    messages: list[dict],
    model: str,
    *,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> str:
    """Run one completion and return the assistant's text.

    Blocking: callers on the event loop must wrap this in asyncio.to_thread.
    """
    if not configured():
        raise LLMError(503, "未配置 LLM_API_KEY，文本标注功能不可用")

    model = resolve_model(model)
    url = f"{config.LLM_BASE_URL}/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        # Streaming is deliberately off. Providers disagree on the SSE dialect
        # and this endpoint does not need it; one JSON body is what the
        # sanitizer downstream actually wants.
        "stream": False,
        "max_tokens": max_tokens if max_tokens is not None else config.LLM_MAX_TOKENS,
        "temperature": temperature if temperature is not None else config.LLM_TEMPERATURE,
    }

    try:
        response = requests.post(
            url,
            json=payload,
            headers={
                "Authorization": f"Bearer {config.LLM_API_KEY}",
                "Content-Type": "application/json",
            },
            timeout=config.LLM_TIMEOUT_SECONDS,
        )
    except requests.Timeout:
        raise LLMError(504, f"模型 {model} 响应超时（{config.LLM_TIMEOUT_SECONDS}s）") from None
    except requests.RequestException as exc:
        # Unreachable endpoint, DNS failure, TLS error. redact.log_only prints
        # the detail server-side and hands back something browser-safe.
        raise LLMError(502, f"无法连接模型服务: {redact.log_only('llm', exc)}") from None

    # Every provider echoes the request that failed, and that request carries
    # the Authorization header -- so this body must never be forwarded raw.
    if not response.ok:
        raise LLMError(
            502, f"模型 {model} 调用失败（HTTP {response.status_code}）: {_body_hint(response)}"
        )

    try:
        body = response.json()
        return body["choices"][0]["message"]["content"] or ""
    except (ValueError, KeyError, IndexError, TypeError):
        raise LLMError(502, f"模型 {model} 返回了无法解析的响应") from None


def _body_hint(response: requests.Response) -> str:
    """A short, scrubbed excerpt of an error body, for the operator."""
    try:
        raw = json.dumps(response.json(), ensure_ascii=False)
    except ValueError:
        raw = response.text or ""
    return redact.scrub(raw)