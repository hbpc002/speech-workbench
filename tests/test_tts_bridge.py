"""Voice resolution for the renderer's TTS bridge.

Three shapes arrive here: a cloned voice id (what the short-video tab sends), a
`model:voice` pair (what a synthesis record sends), and a Kokoro name (what the
renderer's own UI would send if someone opened it). Only the first two may pick
a model; anything unknown falls back to the configured default.
"""

from server import config, tts_bridge


def test_clone_id_keeps_its_model():
    voice = "cosyvoice-v3-flash-10222032-c9a2f7cd776841b4bf1a6aeb72fd9bd8"
    assert tts_bridge.resolve_voice(voice) == ("cosyvoice-v3-flash", voice)


def test_model_voice_pair_is_accepted():
    assert tts_bridge.resolve_voice("cosyvoice-v2:longanhuan") == (
        "cosyvoice-v2",
        "longanhuan",
    )


def test_unknown_model_pair_falls_back():
    assert tts_bridge.resolve_voice("not-a-model:longanhuan") == (
        config.TTS_MODEL,
        config.TTS_VOICE,
    )


def test_kokoro_name_falls_back():
    assert tts_bridge.resolve_voice("af_heart") == (config.TTS_MODEL, config.TTS_VOICE)


def test_empty_voice_falls_back():
    assert tts_bridge.resolve_voice("") == (config.TTS_MODEL, config.TTS_VOICE)
