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

import random
import time

import requests

from . import config, redact


class LLMError(Exception):
    """An upstream failure already safe to show the browser.

    `status_code` is what the route should pass to HTTPException, `detail` is
    the scrubbed message. The unrounded-up original is in the server log only.
    `retry_after` is the number of seconds the browser should wait, for the ones
    that are worth retrying -- a throttled account above all.
    """

    def __init__(self, status_code: int, detail: str, retry_after: int | None = None) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.retry_after = retry_after


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

    headers = {
        "Authorization": f"Bearer {config.LLM_API_KEY}",
        "Content-Type": "application/json",
    }

    attempts = max(0, config.LLM_MAX_RETRIES) + 1
    for attempt in range(attempts):
        try:
            response = requests.post(
                url,
                json=payload,
                headers=headers,
                timeout=config.LLM_TIMEOUT_SECONDS,
            )
        except requests.Timeout:
            # Not retried on purpose. One timeout already costs
            # LLM_TIMEOUT_SECONDS (120s by default); three in a row is 360s, and
            # a Vercel function dies at 300s -- so the retry would replace a
            # readable error with no response at all.
            raise LLMError(504, f"模型 {model} 响应超时（{config.LLM_TIMEOUT_SECONDS}s）") from None
        except requests.RequestException as exc:
            if attempt + 1 < attempts:
                time.sleep(_backoff(attempt))
                print(f"[llm] {type(exc).__name__} talking to {model}, retry {attempt + 1}/{attempts - 1}")
                continue
            # Unreachable endpoint, DNS failure, TLS error. redact.log_only prints
            # the detail server-side and hands back something browser-safe.
            raise LLMError(502, f"无法连接模型服务: {redact.log_only('llm', exc)}") from None

        # Every provider echoes the request that failed, and that request carries
        # the Authorization header -- so this body must never be forwarded raw.
        if not response.ok:
            error = _friendly_error(model, response)
            wait, again = _plan_retry(attempt, response)
            if again:
                time.sleep(wait)
                print(f"[llm] HTTP {response.status_code} from {model}, retrying in {wait:.1f}s")
                continue
            raise error from None

        try:
            body = response.json()
            return body["choices"][0]["message"]["content"] or ""
        except (ValueError, KeyError, IndexError, TypeError):
            raise LLMError(502, f"模型 {model} 返回了无法解析的响应") from None

    raise LLMError(502, f"模型 {model} 多次调用失败")  # pragma: no cover


# How long to wait before re-asking, doubled each time, plus a little jitter so
# two tabs retrying at once do not march in step.
RETRY_AFTER_SECONDS = 30


def _backoff(attempt: int) -> float:
    base = max(0.0, config.LLM_RETRY_BACKOFF_SECONDS) * (2**attempt)
    return base + random.uniform(0, min(1.0, base))


def _plan_retry(attempt: int, response: requests.Response) -> tuple[float, bool]:
    """How long to wait before asking again, and whether to ask at all.

    The two retryable failures need opposite treatment, which is why this is not
    one rule:

    * **429** -- the account's own budget for this minute is gone. 百炼 restores it
      within a minute, and it also throttles a sudden *surge* even below the RPM
      ceiling. So: exactly one retry, after a long wait. Hammering a throttled
      account with three calls in ten seconds is what deepens the throttle.
    * **5xx** -- the provider is unwell, not us. Retrying is free and often works
      on the second ask.
    * **4xx** other than 429 -- a bad key, a model that does not exist. Retrying
      cannot succeed and burns quota that is already scarce.
    """
    if response.status_code == 429:
        if attempt > 0 or config.LLM_MAX_RETRIES < 1:
            return 0.0, False
        wait = max(0.0, config.LLM_RATE_LIMIT_BACKOFF_SECONDS)
        return wait + random.uniform(0, min(2.0, wait)), True

    if not 500 <= response.status_code < 600:
        return 0.0, False
    if attempt + 1 > max(0, config.LLM_MAX_RETRIES):
        return 0.0, False
    return _backoff(attempt), True


def _friendly_error(model: str, response: requests.Response) -> LLMError:
    """Turn an upstream status into something an operator can act on.

    The browser gets one line of Chinese naming the model and the next step.
    Everything the provider actually said stays in the server log, because that
    text is a JSON envelope (`{"error": {...}}`) that truncates mid-structure at
    a length no human reads past.
    """
    status = response.status_code
    alternatives = "、".join(
        choice["id"] for choice in config.LLM_MODELS if choice["id"] != model
    )
    swap = (
        f"也可以把「标注模型」换成 {alternatives}，不想联网就用「快速标注」（本地规则）"
        if alternatives
        else "也可以用「快速标注」（本地规则，不联网）"
    )

    if status == 429:
        return LLMError(
            429,
            f"模型 {model} 触发请求频率限制（HTTP 429），"
            f"等 {RETRY_AFTER_SECONDS} 秒左右再试；{swap}。",
            retry_after=RETRY_AFTER_SECONDS,
        )
    if status in (401, 403):
        reason = "LLM_API_KEY 无效或已过期" if status == 401 else f"没有 {model} 的调用权限"
        return LLMError(502, f"模型 {model} 拒绝了调用（HTTP {status}）：{reason}。")
    if status == 404:
        return LLMError(502, f"模型 {model} 不存在（HTTP 404），检查 .env 里的 LLM_MODELS。")
    if 500 <= status < 600:
        return LLMError(502, f"模型服务暂时不可用（HTTP {status}），过一会儿再试。")

    # Anything else: the provider's own sentence if it sent one, scrubbed and
    # cut to a length a person will finish reading.
    return LLMError(502, f"模型 {model} 调用失败（HTTP {status}）：{_body_hint(response)}")


def _body_hint(response: requests.Response) -> str:
    """The provider's own sentence, scrubbed -- not the JSON around it.

    `{"error": {"message": "...", "code": "..."}}` is what every OpenAI-compatible
    endpoint returns; the message inside is the only part that says anything, and
    dumping the envelope used to put a truncated JSON object in the dialog.
    """
    try:
        body = response.json()
    except ValueError:
        body = None

    message = ""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            message = error["message"]
        elif isinstance(body.get("message"), str):
            message = body["message"]

    raw = message or response.text or ""
    return redact.scrub(raw, limit=120)