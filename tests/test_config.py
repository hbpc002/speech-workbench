"""Config parsing and, more importantly, what must never leave the server."""

import pytest

from server import config


class TestParseModels:
    def test_id_and_display_name(self):
        parsed = config._parse_models("a:甲,b:乙")
        assert parsed == [{"id": "a", "name": "甲"}, {"id": "b", "name": "乙"}]

    def test_bare_id_is_its_own_label(self):
        assert config._parse_models("gpt-4o") == [{"id": "gpt-4o", "name": "gpt-4o"}]

    def test_blank_and_empty_chunks_are_dropped(self):
        assert config._parse_models(" a , ,b:乙,") == [
            {"id": "a", "name": "a"},
            {"id": "b", "name": "乙"},
        ]

    def test_duplicate_ids_collapse(self):
        # Otherwise the picker shows the same model twice.
        assert config._parse_models("a:甲,a:乙") == [{"id": "a", "name": "甲"}]

    def test_empty_string_yields_nothing(self):
        # Must not raise: a typo in the env var should not break startup.
        assert config._parse_models("") == []


class TestEnvCoercion:
    def test_int_helper_falls_back_on_garbage(self, monkeypatch):
        monkeypatch.setenv("TAGS_TEST_INT", "not-a-number")
        assert config._env_int("TAGS_TEST_INT", default=7) == 7

    def test_float_helper_falls_back_on_garbage(self, monkeypatch):
        monkeypatch.setenv("TAGS_TEST_FLOAT", "x")
        assert config._env_float("TAGS_TEST_FLOAT", default=0.3) == 0.3

    def test_helpers_read_valid_values(self, monkeypatch):
        monkeypatch.setenv("TAGS_TEST_INT", "12")
        assert config._env_int("TAGS_TEST_INT", default=7) == 12


class TestPublicConfig:
    def test_publishes_llm_model_ids_but_not_the_key(self):
        payload = config.public_config()
        assert payload["llm"]["models"] == config.LLM_MODELS
        assert payload["llm"]["default_model"] == config.LLM_MODEL
        assert payload["llm"]["configured"] is bool(config.LLM_API_KEY)

    def test_never_contains_the_credential(self):
        # The regression that matters: a second key existed and only one was
        # being filtered.
        payload = config.public_config()
        assert config.LLM_API_KEY not in repr(payload)
        assert config.API_KEY not in repr(payload) or not config.API_KEY

    def test_never_contains_the_base_url(self):
        # /healthz is unauthenticated and a self-hosted vLLM origin is not
        # public information.
        assert config.LLM_BASE_URL not in repr(config.public_config())

    def test_publishes_tag_limits(self):
        payload = config.public_config()
        assert payload["tags"]["max_chars"] == config.TAGS_MAX_CHARS
        assert {"sparse", "normal", "dense"} <= {
            item["id"] for item in payload["tags"]["densities"]
        }


@pytest.mark.parametrize("raw", ["", "  ", ",,,"])
def test_parse_models_never_raises(raw):
    config._parse_models(raw)