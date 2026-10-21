"""Work out which stage of an outbound WebSocket connect is failing.

The DashScope SDK collapses every failure into the same five-second
`TimeoutError`, so the browser only ever learns "websocket connection could not
established". That message cannot distinguish three very different problems:

    DNS  - the hostname does not resolve (a mistyped DASHSCOPE_WORKSPACE_ID)
    TCP  - the SYN is dropped (a firewall or a blocked cross-border route)
    TLS  - the handshake fails (a proxy or an expired certificate)

This probe runs only after a connect timeout, against the same endpoint the SDK
used, and reports the stage that broke. It is diagnostic, not a retry: nothing
here replaces the SDK's own connection.
"""

import asyncio
import socket
import ssl
import time
from urllib.parse import urlsplit

from . import redact


def _elapsed_ms(started: float) -> float:
    return round((time.monotonic() - started) * 1000, 1)


def _describe(exc: BaseException) -> str:
    return redact.scrub(f"{type(exc).__name__}: {exc}")


async def probe(endpoint: str, timeout: float = 3.0) -> dict:
    """Probe `endpoint` and return a browser-safe stage report.

    Never raises: a diagnostic must not turn a synthesis error into a different
    error. Every exit path returns a dict with at least `ok` and `stage`.
    """
    started = time.monotonic()
    parts = urlsplit(endpoint or "")
    host = parts.hostname
    scheme = (parts.scheme or "wss").lower()
    secure = scheme in ("wss", "https")
    port = parts.port or (443 if secure else 80)

    report: dict = {
        "endpoint": redact.scrub(endpoint),
        "timeout_seconds": timeout,
        "secure": secure,
    }
    if not host:
        return {**report, "ok": False, "stage": "config", "error": "endpoint 里没有主机名"}

    # The workspace host embeds DASHSCOPE_WORKSPACE_ID; keep it out of the
    # browser payload the same way redact does for the full endpoint.
    report["host"] = redact.scrub(host)
    report["port"] = port

    if timeout <= 0:
        return {**report, "ok": False, "stage": "skipped", "error": "探测已关闭"}

    loop = asyncio.get_running_loop()

    # -- DNS ---------------------------------------------------------------
    dns_started = time.monotonic()
    try:
        infos = await asyncio.wait_for(
            loop.getaddrinfo(host, port, type=socket.SOCK_STREAM), timeout
        )
    except asyncio.TimeoutError:
        return {
            **report,
            "ok": False,
            "stage": "dns",
            "dns_ms": _elapsed_ms(dns_started),
            "error": f"DNS 解析超过 {timeout:g}s",
        }
    except OSError as exc:
        return {
            **report,
            "ok": False,
            "stage": "dns",
            "dns_ms": _elapsed_ms(dns_started),
            "error": _describe(exc),
        }

    report["dns_ms"] = _elapsed_ms(dns_started)
    addresses = sorted({info[4][0] for info in infos})
    report["addresses"] = addresses
    if not addresses:
        return {**report, "ok": False, "stage": "dns", "error": "DNS 没有返回地址"}
    address = addresses[0]
    report["address"] = address

    # -- TCP ---------------------------------------------------------------
    tcp_started = time.monotonic()
    try:
        _reader, writer = await asyncio.wait_for(
            asyncio.open_connection(address, port), timeout
        )
    except asyncio.TimeoutError:
        return {
            **report,
            "ok": False,
            "stage": "tcp",
            "tcp_ms": _elapsed_ms(tcp_started),
            "error": f"TCP 握手超过 {timeout:g}s（SYN 被丢弃）",
        }
    except OSError as exc:
        return {
            **report,
            "ok": False,
            "stage": "tcp",
            "tcp_ms": _elapsed_ms(tcp_started),
            "error": _describe(exc),
        }
    report["tcp_ms"] = _elapsed_ms(tcp_started)
    writer.close()
    try:
        await writer.wait_closed()
    except (OSError, RuntimeError):
        pass

    if not secure:
        return {**report, "ok": True, "stage": "ok", "total_ms": _elapsed_ms(started)}

    # -- TLS ---------------------------------------------------------------
    tls_started = time.monotonic()
    context = ssl.create_default_context()
    try:
        _reader, writer = await asyncio.wait_for(
            asyncio.open_connection(
                address, port, ssl=context, server_hostname=host
            ),
            timeout,
        )
    except asyncio.TimeoutError:
        return {
            **report,
            "ok": False,
            "stage": "tls",
            "tls_ms": _elapsed_ms(tls_started),
            "error": f"TLS 握手超过 {timeout:g}s",
        }
    except (OSError, ssl.SSLError) as exc:
        return {
            **report,
            "ok": False,
            "stage": "tls",
            "tls_ms": _elapsed_ms(tls_started),
            "error": _describe(exc),
        }
    report["tls_ms"] = _elapsed_ms(tls_started)
    writer.close()
    try:
        await writer.wait_closed()
    except (OSError, RuntimeError):
        pass

    return {**report, "ok": True, "stage": "ok", "total_ms": _elapsed_ms(started)}
