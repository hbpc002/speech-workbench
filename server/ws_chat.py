"""Tab 1 - end-to-end realtime voice chat.

Transparent relay to the DashScope realtime WebSocket, with two additions over
the upstream sample (samples/conversation/fun-audiochat-realtime/demo_app/web):

1. The api key is injected server-side instead of being embedded anywhere the
   browser can read.
2. `client.replay` is intercepted and translated into a series of
   `conversation.item.create` events so conversation memory survives a dropped
   connection. Vercel Hobby caps a function at 300s, so this is what keeps a
   long chat coherent there.
"""

import asyncio
import json

import websockets
from fastapi import WebSocket

from . import config, redact

REPLAY_TYPE = "client.replay"
HISTORY_REPLAYED = "server.history_replayed"

# DashScope keeps a bounded context of its own; replaying an unbounded history
# would just get truncated at the far end.
MAX_REPLAY_ITEMS = 40


def _content_for(role: str, text: str) -> list[dict]:
    # Per the fun-audiochat client-event reference: user/system use
    # input_text, assistant uses output_text.
    kind = "output_text" if role == "assistant" else "input_text"
    return [{"type": kind, "text": text}]


def build_replay_events(items: list[dict]) -> list[dict]:
    events = []
    for item in items[-MAX_REPLAY_ITEMS:]:
        role = item.get("role")
        text = (item.get("text") or "").strip()
        if role not in ("user", "assistant") or not text:
            continue
        events.append(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": role,
                    "content": _content_for(role, text),
                },
            }
        )
    return events


async def _pump_upstream(browser: WebSocket, upstream) -> None:
    async for message in upstream:
        if isinstance(message, bytes):
            await browser.send_bytes(message)
        else:
            await browser.send_text(message)


async def _pump_browser(browser: WebSocket, upstream) -> int:
    """Forward browser frames upstream.

    Starlette's WebSocket has no `__aiter__`, so this reads with `receive()`
    rather than `async for`.
    """
    replayed = 0
    while True:
        message = await browser.receive()
        if message["type"] == "websocket.disconnect":
            return replayed

        payload = message.get("bytes")
        if payload is not None:
            await upstream.send(payload)
            continue

        text = message.get("text")
        if not text:
            continue

        try:
            event = json.loads(text)
        except json.JSONDecodeError:
            await upstream.send(text)
            continue

        if event.get("type") == REPLAY_TYPE:
            sent = await _replay(upstream, event.get("items") or [])
            replayed += sent
            await browser.send_text(
                json.dumps({"type": HISTORY_REPLAYED, "count": sent})
            )
            continue

        await upstream.send(json.dumps(event))


async def handle(websocket: WebSocket) -> None:
    params = websocket.query_params
    model = params.get("model") or config.REALTIME_MODEL
    upstream_url = f"{config.realtime_base_url()}?model={model}"

    await websocket.accept()
    try:
        async with websockets.connect(
            upstream_url,
            additional_headers={"Authorization": f"Bearer {config.API_KEY}"},
        ) as upstream:
            await websocket.send_text(
                json.dumps({"type": "server.hello", "model": model})
            )

            async def upstream_to_browser() -> None:
                try:
                    await _pump_upstream(websocket, upstream)
                except (websockets.exceptions.ConnectionClosed, RuntimeError):
                    pass

            await asyncio.gather(_pump_browser(websocket, upstream), upstream_to_browser())
    except websockets.exceptions.InvalidStatus as exc:
        await _fail(websocket, f"DashScope 拒绝连接 (HTTP {exc.response.status_code})")
    except Exception as exc:  # noqa: BLE001 - message is scrubbed before sending
        await _fail(websocket, f"连接上游失败: {redact.log_only('chat', exc)}")


async def _replay(upstream, items: list[dict]) -> int:
    """Push history into the fresh upstream session. Returns items injected."""
    events = build_replay_events(items)
    for event in events:
        await upstream.send(json.dumps(event))
    if events:
        await upstream.send(json.dumps({"type": "response.create"}))
    print(f"[chat] replayed {len(events)} history items")
    return len(events)


async def _fail(websocket: WebSocket, message: str) -> None:
    try:
        await websocket.send_text(
            json.dumps({"type": "error", "error": {"message": message}})
        )
        await websocket.close()
    except RuntimeError:
        pass