"""Endpoint wiring for the DashScope SDK.

`DASHSCOPE_WORKSPACE_ID` rewrites every DashScope base URL to a per-workspace
host. A wrong value therefore does not fail loudly -- it produces a hostname that
does not resolve, and every call hangs until the endpoint's own timeout. The
symptom ("上游不可达") points nowhere near the cause.
"""

import pytest

from server import config, dashscope_setup


@pytest.fixture(autouse=True)
def restore_sdk():
    """bootstrap() mutates module-level SDK state; do not leak it between tests."""
    before = (
        dashscope_setup.dashscope.api_key,
        dashscope_setup.dashscope.base_http_api_url,
        dashscope_setup.dashscope.base_websocket_api_url,
    )
    yield
    (
        dashscope_setup.dashscope.api_key,
        dashscope_setup.dashscope.base_http_api_url,
        dashscope_setup.dashscope.base_websocket_api_url,
    ) = before


class TestWorkspaceIdShape:
    @pytest.mark.parametrize(
        "value",
        ["llm-abc123", "llm-0123456789abcdef", "llm-XYZ"],
    )
    def test_accepts_real_looking_ids(self, value):
        assert dashscope_setup.looks_like_workspace_id(value)

    @pytest.mark.parametrize(
        "value",
        [
            "ws-your-workspace-id",   # the placeholder this file used to ship
            "your-workspace-id",
            "llm-",
            "llm",
            "llm_abc",
            "workspace-abc",
            "",
        ],
    )
    def test_rejects_placeholders_and_typos(self, value):
        # These are what turn into an unresolvable hostname.
        assert not dashscope_setup.looks_like_workspace_id(value)


class TestBootstrap:
    def test_public_endpoint_when_unset(self, monkeypatch):
        monkeypatch.setattr(config, "WORKSPACE_ID", "")
        monkeypatch.setattr(config, "API_KEY", "sk-test")
        dashscope_setup.bootstrap()
        assert "maas.aliyuncs.com" not in dashscope_setup.dashscope.base_http_api_url

    def test_rewrites_to_the_workspace_host_when_set(self, monkeypatch):
        monkeypatch.setattr(config, "WORKSPACE_ID", "llm-abc123")
        monkeypatch.setattr(config, "API_KEY", "sk-test")
        dashscope_setup.bootstrap()
        assert dashscope_setup.dashscope.base_http_api_url == (
            "https://llm-abc123.cn-beijing.maas.aliyuncs.com/api/v1"
        )
        assert dashscope_setup.dashscope.base_websocket_api_url.startswith(
            "wss://llm-abc123.cn-beijing.maas.aliyuncs.com/"
        )

    def test_applies_the_api_key(self, monkeypatch):
        monkeypatch.setattr(config, "WORKSPACE_ID", "")
        monkeypatch.setattr(config, "API_KEY", "sk-abc")
        dashscope_setup.bootstrap()
        assert dashscope_setup.dashscope.api_key == "sk-abc"

    def test_warns_about_a_placeholder_id(self, monkeypatch, capsys):
        # The regression this guards: a docs placeholder pasted into the env
        # turns into a hostname that never resolves.
        monkeypatch.setattr(config, "WORKSPACE_ID", "ws-your-workspace-id")
        monkeypatch.setattr(config, "API_KEY", "sk-test")
        dashscope_setup.bootstrap()
        out = capsys.readouterr().out
        assert "WARNING" in out
        assert "ws-your-workspace-id" in out

    def test_does_not_warn_about_a_real_id(self, monkeypatch, capsys):
        monkeypatch.setattr(config, "WORKSPACE_ID", "llm-abc123")
        monkeypatch.setattr(config, "API_KEY", "sk-test")
        dashscope_setup.bootstrap()
        assert "WARNING" not in capsys.readouterr().out

    def test_always_logs_the_resolved_host(self, monkeypatch, capsys):
        # The single most useful line when DashScope calls hang.
        monkeypatch.setattr(config, "WORKSPACE_ID", "llm-abc123")
        monkeypatch.setattr(config, "API_KEY", "sk-test")
        dashscope_setup.bootstrap()
        assert "llm-abc123.cn-beijing.maas.aliyuncs.com" in capsys.readouterr().out

    def test_logs_the_public_host_when_unset(self, monkeypatch, capsys):
        monkeypatch.setattr(config, "WORKSPACE_ID", "")
        monkeypatch.setattr(config, "API_KEY", "sk-test")
        dashscope_setup.bootstrap()
        assert "public endpoint" in capsys.readouterr().out


def test_env_example_does_not_ship_a_fake_workspace_id():
    """A placeholder in .env.example gets pasted into a real deployment.

    That is how `ws-your-workspace-id` could end up as a live hostname, which
    does not resolve and hangs every DashScope call.
    """
    from pathlib import Path

    text = (Path(__file__).resolve().parents[1] / ".env.example").read_text()
    assert "DASHSCOPE_WORKSPACE_ID=ws-" not in text
    line = next(
        l for l in text.splitlines() if l.startswith("DASHSCOPE_WORKSPACE_ID=")
    )
    # Empty, or a real-shaped id -- never a bare placeholder.
    assert line.split("=", 1)[1] == ""