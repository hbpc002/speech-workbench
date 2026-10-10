"""Access-password authentication backed by a signed cookie.

Deliberately stdlib-only: a small HMAC-signed `exp.payload` token. No session
store means it also survives Vercel's lack of sticky instances.
"""

import base64
import hashlib
import hmac
import json
import time

from fastapi import WebSocket

from . import config

COOKIE_NAME = "speech_session"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _secret() -> bytes:
    return (config.SESSION_SECRET or config.APP_PASSWORD or "dev-insecure").encode()


def auth_enabled() -> bool:
    return bool(config.APP_PASSWORD)


def make_token() -> str:
    payload = json.dumps({"exp": int(time.time()) + config.SESSION_TTL_SECONDS})
    encoded = _b64(payload.encode())
    signature = hmac.new(_secret(), encoded.encode(), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def verify_token(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    encoded, signature = token.rsplit(".", 1)
    expected = hmac.new(_secret(), encoded.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return False
    try:
        payload = json.loads(_unb64(encoded))
    except (ValueError, json.JSONDecodeError):
        return False
    return int(payload.get("exp", 0)) > int(time.time())


def check_password(candidate: str | None) -> bool:
    if not candidate or not config.APP_PASSWORD:
        return False
    return hmac.compare_digest(candidate, config.APP_PASSWORD)


def is_authenticated(cookie_token: str | None) -> bool:
    if not auth_enabled():
        return True
    return verify_token(cookie_token)


async def websocket_authenticated(websocket: WebSocket) -> bool:
    """WebSocket upgrade requests carry same-origin cookies, so the cookie is enough.

    A query parameter is accepted as a fallback for clients that cannot send
    cookies, but it is checked against the same signed token.
    """
    if not auth_enabled():
        return True
    cookie_token = websocket.cookies.get(COOKIE_NAME)
    if verify_token(cookie_token):
        return True
    query_token = websocket.query_params.get("token")
    return verify_token(query_token)