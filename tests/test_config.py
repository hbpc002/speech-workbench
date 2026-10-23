"""Config parsing and, more importantly, what must never leave the server."""

import re

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


class TestResolveStorageBackend:
    """The backend decides whether voice cloning works at all.

    Regression: every Vercel deployment resolved to "blob" regardless of whether
    the Blob SDK or a token was present, so cloning failed on the user's click
    with an import error instead of at deploy time.
    """

    def test_auto_falls_back_to_local(self, monkeypatch):
        monkeypatch.delenv("VERCEL", raising=False)
        assert config.resolve_storage_backend() == "local"

    def test_auto_prefers_blob_when_a_token_is_set(self, monkeypatch):
        monkeypatch.delenv("VERCEL", raising=False)
        monkeypatch.setattr(config, "BLOB_TOKEN", "vercel_blob_rw_token")
        assert config.resolve_storage_backend() == "blob"

    def test_auto_prefers_blob_on_vercel(self, monkeypatch):
        # The env var, not the platform SDK, is what we key off.
        monkeypatch.setattr(config, "BLOB_TOKEN", None)
        monkeypatch.setenv("VERCEL", "1")
        assert config.resolve_storage_backend() == "blob"

    def test_explicit_setting_wins_over_everything(self, monkeypatch):
        monkeypatch.setattr(config, "STORAGE_BACKEND", "local")
        monkeypatch.setattr(config, "BLOB_TOKEN", "vercel_blob_rw_token")
        monkeypatch.setenv("VERCEL", "1")
        assert config.resolve_storage_backend() == "local"

    def test_explicit_blob_is_honoured_off_vercel(self, monkeypatch):
        monkeypatch.delenv("VERCEL", raising=False)
        monkeypatch.setattr(config, "STORAGE_BACKEND", "blob")
        assert config.resolve_storage_backend() == "blob"

    def test_render_is_not_treated_as_vercel(self, monkeypatch):
        # Render runs local storage via render.yaml; it must not be pulled to
        # blob just because some other platform variable is set.
        monkeypatch.delenv("VERCEL", raising=False)
        monkeypatch.setenv("RENDER", "1")
        assert config.resolve_storage_backend() == "local"

    def test_public_base_url_has_no_trailing_slash(self):
        # _put_local concatenates "/media/{name}" onto it directly.
        assert not config.PUBLIC_BASE_URL.endswith("/")


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
        # Guard on the key being set *before* the membership check: when
        # config.API_KEY is None (no .env), `None not in "..."` raises
        # TypeError before `or` gets a chance to short-circuit.
        assert not config.API_KEY or config.API_KEY not in repr(payload)

    def test_never_contains_the_base_url(self):
        # /healthz is unauthenticated and a self-hosted vLLM origin is not
        # public information.
        assert config.LLM_BASE_URL not in repr(config.public_config())

    def test_never_contains_storage_secrets(self, monkeypatch):
        # A Blob token written into an upstream error would be scrubbed by
        # redact, but it has no business being in a config payload at all.
        monkeypatch.setattr(config, "BLOB_TOKEN", "vercel_blob_rw_secretvalue")
        monkeypatch.setattr(config, "PUBLIC_BASE_URL", "https://internal.example")
        assert config.BLOB_TOKEN not in repr(config.public_config())

    def test_publishes_tag_limits(self):
        payload = config.public_config()
        assert payload["tags"]["max_chars"] == config.TAGS_MAX_CHARS
        assert {"sparse", "normal", "dense"} <= {
            item["id"] for item in payload["tags"]["densities"]
        }

    def test_publishes_the_script_presets(self):
        tags = config.public_config()["tags"]
        assert tags["durations"] == config.TAGS_DURATIONS
        assert tags["tones"] == config.TAGS_TONES
        assert tags["audiences"] == config.TAGS_AUDIENCES
        assert tags["topic_hints"] == config.TAGS_TOPIC_HINTS

    @pytest.mark.parametrize("name", ["durations", "tones", "audiences"])
    def test_presets_are_non_empty_and_unique(self, name):
        # A duplicate id would show twice in the picker and silently make the
        # first one unreachable.
        items = config.public_config()["tags"][name]
        assert items, f"{name} is empty"
        ids = [item["id"] for item in items]
        assert len(ids) == len(set(ids)), f"{name} has duplicate ids"

    def test_topic_hints_are_unique_strings(self):
        # A plain list, not {id, name}: they feed a <datalist>.
        hints = config.public_config()["tags"]["topic_hints"]
        assert hints
        assert all(isinstance(hint, str) and hint.strip() for hint in hints)
        assert len(hints) == len(set(hints))

    def test_default_presets_exist_in_the_lists(self):
        # The browser preselects these and api_tagger falls back to them when a
        # field is blank; a missing entry would make the two disagree.
        tags = config.public_config()["tags"]
        assert "60 秒" in [item["id"] for item in tags["durations"]]
        assert "亲切自然" in [item["id"] for item in tags["tones"]]
        assert "宝妈" in [item["id"] for item in tags["audiences"]]

    def test_presets_carry_a_display_name(self):
        # tab_tts.js reads item.name; an entry without one renders as blank.
        for name in ("durations", "tones", "audiences"):
            for item in config.public_config()["tags"][name]:
                assert item["name"], f"{name} entry {item} has no name"


@pytest.mark.parametrize("raw", ["", "  ", ",,,"])
def test_parse_models_never_raises(raw):
    config._parse_models(raw)

class TestDefaultLlmModel:
    """The shipped default, not just the parsing.

    A typo in `LLM_MODELS` is invisible until someone clicks a button: the picker
    is filled from the same list the picker validates against, so the bad id is
    accepted locally and only fails upstream as "模型 X 不存在". These are the
    checks that catch it in CI instead.
    """

    def test_the_default_is_the_first_entry(self):
        # The browser sends the model id it was given; anything else would send an
        # id that resolve_model() may not know.
        assert config.LLM_MODELS
        assert config.LLM_MODEL == config.LLM_MODELS[0]["id"]

    def test_every_shipped_id_looks_like_an_upstream_model_id(self):
        for item in config.LLM_MODELS:
            assert re.fullmatch(r"[a-z0-9][a-z0-9.-]*", item["id"]), item

    def test_every_entry_is_labelled(self):
        # tab_tts.js and tab_voice.js both render item.name in a <select>; a blank
        # one is an unclickable row.
        for item in config.LLM_MODELS:
            assert item["name"], item

    def test_the_default_is_not_a_retired_model(self):
        # 百炼 retires models on a schedule and states that a retiring model's
        # QPM/TPM "will gradually decrease" from the notice date -- which looks
        # exactly like random 429s. If this fails, the model went into a
        # deprecation batch and LLM_MODEL needs to move.
        retired = {"qwen-turbo"}  # 下线公告日 2026-10-10
        assert config.LLM_MODEL not in retired
