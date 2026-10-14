"""Recovering metadata from a cloned voice id.

`list_voice` is the only cheap way to enumerate voices -- one round trip for
all of them -- but it returns just `voice_id`, `gmt_create`, `gmt_modified` and
`status`. The target model, which a voice is permanently bound to and which the
preview has to send, is not among them. It is recoverable from the id, because
the API builds ids as `{target_model}-{prefix}-{unique}`.

Getting this wrong is not cosmetic: sending the wrong model synthesises
something else or fails 418, which reads as a broken voice.
"""

import pytest

from server import voices


class TestParseCloneModel:
    @pytest.mark.parametrize(
        "voice_id,expected",
        [
            ("qwen-audio-3.0-tts-flash-myvoice-8f3a2b1c", "qwen-audio-3.0-tts-flash"),
            ("qwen-audio-3.0-tts-plus-demo-9c1d", "qwen-audio-3.0-tts-plus"),
            ("cosyvoice-v3-flash-zhang-abc123", "cosyvoice-v3-flash"),
        ],
    )
    def test_recovers_the_model(self, voice_id, expected):
        assert voices.parse_clone_model(voice_id) == expected

    def test_longest_prefix_wins(self):
        # Today no two clone models are prefixes of one another, so this is not
        # observable through VOICE_CLONE_MODELS. It becomes observable the day
        # someone adds `qwen-audio-3.0-tts` next to `qwen-audio-3.0-tts-flash`:
        # the shorter one matches the longer id followed by `-` and would win.
        overlapping = ["qwen-audio-3.0-tts", "qwen-audio-3.0-tts-flash"]
        assert voices.parse_clone_model("qwen-audio-3.0-tts-flash-a-1", overlapping) == (
            "qwen-audio-3.0-tts-flash"
        )
        assert voices.parse_clone_model("qwen-audio-3.0-tts-a-1", overlapping) == "qwen-audio-3.0-tts"

    def test_builtin_voice_is_not_mistaken_for_a_clone(self):
        # A built-in id has no target-model segment; returning None is correct,
        # because guessing would produce a 418 instead of a clear absence.
        assert voices.parse_clone_model("longanhuan_v3.1") is None

    def test_unknown_model_prefix_returns_none(self):
        assert voices.parse_clone_model("some-new-model-x-y") is None

    def test_empty_id_returns_none(self):
        assert voices.parse_clone_model("") is None

    def test_requires_a_separator_after_the_model(self):
        # `cosyvoice-v3-flash` alone, with no prefix, is not a cloned voice.
        assert voices.parse_clone_model("cosyvoice-v3-flash") is None


class TestParseClonePrefix:
    def test_drops_the_model_and_the_unique_suffix(self):
        assert voices.parse_clone_prefix("qwen-audio-3.0-tts-flash-myvoice-8f3a2b1c") == "myvoice"

    def test_handles_a_single_trailing_segment(self):
        assert voices.parse_clone_prefix("cosyvoice-v3-flash-demo") == "demo"

    def test_empty_for_an_unrecognised_id(self):
        assert voices.parse_clone_prefix("longanhuan") == ""

    def test_every_clone_model_round_trips(self):
        from server import config

        for model in config.VOICE_CLONE_MODELS:
            voice_id = f"{model}-abc-123456"
            assert voices.parse_clone_model(voice_id) == model
            assert voices.parse_clone_prefix(voice_id) == "abc"


class TestVoiceStatus:
    @pytest.mark.parametrize(
        "status,label,cls",
        [
            ("OK", "可用", "ok"),
            ("DEPLOYING", "审核中", "warn"),
            ("UNDEPLOYED", "审核未通过", "err"),
        ],
    )
    def test_known_statuses(self, status, label, cls):
        assert voices.voice_status_label(status) == (label, cls)

    def test_is_case_insensitive(self):
        assert voices.voice_status_label("ok")[1] == "ok"

    def test_unknown_status_is_shown_verbatim(self):
        # Better than inventing a label that might be wrong.
        assert voices.voice_status_label("SOMETHING_NEW") == ("SOMETHING_NEW", "warn")

    def test_missing_status_is_not_reported_as_healthy(self):
        # An absent status must not read as "可用".
        assert voices.voice_status_label("") == ("未知", "warn")