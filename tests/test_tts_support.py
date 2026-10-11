"""Parameter validation for browser-supplied synthesis options.

`normalize_params` is the only thing standing between a WebSocket frame and
kwargs forwarded to SpeechSynthesizer, so it both clamps ranges and drops
anything it does not recognise.
"""

import pytest

from server.tts_support import DEFAULTS, NUMERIC_PARAMS, normalize_params


class TestClamping:
    def test_defaults_are_not_applied_when_absent(self):
        # The caller only wants a key back when it actually sent one.
        assert normalize_params({}) == {}

    def test_volume_is_clamped(self):
        assert normalize_params({"volume": 500})["volume"] == 100
        assert normalize_params({"volume": -5})["volume"] == 0

    def test_rates_are_clamped(self):
        assert normalize_params({"speech_rate": 9})["speech_rate"] == 2.0
        assert normalize_params({"pitch_rate": 0.01})["pitch_rate"] == 0.5

    def test_seed_is_clamped_to_the_documented_range(self):
        # server/static/js/seed_policy.js picks from the same range.
        assert normalize_params({"seed": 99999})["seed"] == 65535
        assert normalize_params({"seed": -3})["seed"] == 0

    def test_unknown_keys_are_dropped(self):
        out = normalize_params({"model": "cosyvoice-v3-flash", "evil": "payload"})
        assert "evil" not in out


class TestNonFiniteInput:
    """`float("nan")` and `float("inf")` parse fine; `int()` on them does not.

    Without the guard these escaped the try/except below `float()` and turned a
    bad frame into an uncaught 500.
    """

    @pytest.mark.parametrize("bad", ["nan", "inf", "-inf", "NaN", "Infinity"])
    def test_non_finite_seed_is_dropped_not_raised(self, bad):
        assert "seed" not in normalize_params({"seed": bad})

    @pytest.mark.parametrize("bad", ["nan", "inf", "-inf"])
    def test_non_finite_volume_is_dropped_not_raised(self, bad):
        assert "volume" not in normalize_params({"volume": bad})

    @pytest.mark.parametrize("bad", ["nan", "inf"])
    def test_non_finite_rates_are_dropped_not_raised(self, bad):
        out = normalize_params({"speech_rate": bad, "pitch_rate": bad})
        assert "speech_rate" not in out
        assert "pitch_rate" not in out

    def test_finite_numbers_still_pass_through(self):
        assert normalize_params({"seed": 42})["seed"] == 42
        assert normalize_params({"volume": 50})["volume"] == 50

    def test_a_sibling_bad_value_does_not_take_the_good_one_down(self):
        out = normalize_params({"seed": "nan", "volume": 60})
        assert "seed" not in out
        assert out["volume"] == 60


class TestTextOptions:
    def test_instruction_is_trimmed_and_capped(self):
        assert normalize_params({"instruction": "  你开心一点。  "})["instruction"] == "你开心一点。"
        assert len(normalize_params({"instruction": "啊" * 900})["instruction"]) == 500

    def test_blank_instruction_is_dropped(self):
        assert "instruction" not in normalize_params({"instruction": "   "})

    def test_language_becomes_a_hint_list(self):
        assert normalize_params({"language": "zh"})["language_hints"] == ["zh"]

    def test_oversized_language_is_truncated(self):
        assert normalize_params({"language": "x" * 40})["language_hints"] == ["x" * 16]


def test_every_numeric_param_has_a_default():
    # Guards against adding a NUMERIC_PARAMS entry with no DEFAULTS counterpart.
    assert set(NUMERIC_PARAMS) - {"seed"} <= set(DEFAULTS)