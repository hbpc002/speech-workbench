"""Stage classification for an unreachable TTS upstream.

The probe only runs after a connect timeout, but when it does it must answer
one question precisely: did DNS, TCP or TLS break? A wrong answer sends the
operator looking in the wrong place (a firewall instead of a mistyped id).
"""

import asyncio
import socket

import pytest

from server import config, upstream_probe

ENDPOINT = "wss://llm-secret123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"


class FakeWriter:
    def close(self):
        pass

    async def wait_closed(self):
        pass


def run(coro):
    return asyncio.run(coro)


def test_an_endpoint_without_a_host_is_a_config_error():
    report = run(upstream_probe.probe("not a url", timeout=1.0))

    assert report["ok"] is False
    assert report["stage"] == "config"


def test_a_disabled_probe_returns_immediately(monkeypatch):
    def explode(*_args, **_kwargs):
        raise AssertionError("the network must not be touched when disabled")

    monkeypatch.setattr(asyncio, "open_connection", explode)

    report = run(upstream_probe.probe(ENDPOINT, timeout=0))

    assert report["ok"] is False
    assert report["stage"] == "skipped"


def test_a_resolution_failure_is_classified_as_dns(monkeypatch):
    class FailingLoop:
        async def getaddrinfo(self, *_args, **_kwargs):
            raise OSError("Name or service not known")

    monkeypatch.setattr(asyncio, "get_running_loop", lambda: FailingLoop())

    report = run(upstream_probe.probe(ENDPOINT, timeout=1.0))

    assert report["ok"] is False
    assert report["stage"] == "dns"
    assert "Name or service not known" in report["error"]


def test_a_dropped_syn_is_classified_as_tcp(monkeypatch):
    class WorkingLoop:
        async def getaddrinfo(self, *_args, **_kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]

    async def refused(*_args, **_kwargs):
        raise OSError(111, "Connection refused")

    monkeypatch.setattr(asyncio, "get_running_loop", lambda: WorkingLoop())
    monkeypatch.setattr(asyncio, "open_connection", refused)

    report = run(upstream_probe.probe(ENDPOINT, timeout=1.0))

    assert report["ok"] is False
    assert report["stage"] == "tcp"
    assert report["address"] == "127.0.0.1"
    assert "Connection refused" in report["error"]


def test_an_etimedout_errno_is_reported_as_a_tcp_timeout(monkeypatch):
    import errno

    class WorkingLoop:
        async def getaddrinfo(self, *_args, **_kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]

    async def timed_out(*_args, **_kwargs):
        # Python maps errno.ETIMEDOUT to the built-in TimeoutError, which is
        # also asyncio.TimeoutError. The probe must still call it TCP.
        raise OSError(errno.ETIMEDOUT, "Connection timed out")

    monkeypatch.setattr(asyncio, "get_running_loop", lambda: WorkingLoop())
    monkeypatch.setattr(asyncio, "open_connection", timed_out)

    report = run(upstream_probe.probe(ENDPOINT, timeout=1.0))

    assert report["ok"] is False
    assert report["stage"] == "tcp"
    assert "SYN" in report["error"]


def test_a_healthy_endpoint_reports_every_stage(monkeypatch):
    class WorkingLoop:
        async def getaddrinfo(self, *_args, **_kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]

    async def connected(*_args, **_kwargs):
        return None, FakeWriter()

    monkeypatch.setattr(asyncio, "get_running_loop", lambda: WorkingLoop())
    monkeypatch.setattr(asyncio, "open_connection", connected)

    report = run(upstream_probe.probe(ENDPOINT, timeout=1.0))

    assert report["ok"] is True
    assert report["stage"] == "ok"
    assert report["port"] == 443
    assert "dns_ms" in report
    assert "tcp_ms" in report
    assert "tls_ms" in report


def test_the_workspace_id_is_not_leaked(monkeypatch):
    monkeypatch.setattr(config, "WORKSPACE_ID", "llm-secret123")

    report = run(upstream_probe.probe(ENDPOINT, timeout=0))

    assert "llm-secret123" not in str(report)
