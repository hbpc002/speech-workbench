"""Strip credentials out of upstream error text before it reaches a browser.

Upstream SDK errors happily quote the request that produced them, and a
`401` from DashScope comes back as:

    invalid Authorization header: Bearer sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Sending that straight to the WebSocket client leaks the API key to anyone
who opens devtools. Full detail still goes to the server log; the browser
only ever sees a scrubbed, truncated summary.
"""

import re
from . import config

_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_-]{6,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{16,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]{6,}"),
    re.compile(r"(?i)\b([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&\s\"']+"),
    re.compile(r"(?i)([\"']?(?:api[_-]?key|authorization|token|secret)[\"']?\s*[:=]\s*)[\"']?[^\s,;\"'}]+"),
)

MAX_LEN = 200


def scrub(text: object, limit: int = MAX_LEN) -> str:
    """Replace anything credential-shaped with a placeholder."""
    out = str(text)
    for pattern in _PATTERNS:
        if pattern.groups:
            out = pattern.sub(lambda m: m.group(1) + "***", out)
        else:
            out = pattern.sub("***", out)
    # The configured keys may be in an odd format the patterns above miss. The
    # speech key and the LLM key are separate credentials: without listing both
    # here, switching LLM_BASE_URL to another provider leaks the second one.
    for secret in (
        config.API_KEY,
        config.LLM_API_KEY,
        config.BLOB_TOKEN,
        config.WORKSPACE_ID,
    ):
        if secret and len(secret) >= 8:
            out = out.replace(secret, "***")
    # `limit` is set by callers that put the text in front of a human, not into a
    # log: a 200-char cut of a JSON error envelope is a truncated object.
    if limit > 0 and len(out) > limit:
        out = out[:limit] + "…"
    return out


def log_only(label: str, exc: BaseException) -> str:
    """Record the full traceback server-side, return a browser-safe message."""
    print(f"[{label}] {type(exc).__name__}: {exc}")
    return scrub(exc)