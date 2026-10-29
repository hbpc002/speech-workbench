"""Person-free b-roll filter: slug layer, frame layer, cache.

The detector itself is not exercised here (it needs onnxruntime and a 12 MB
model); what is worth pinning down is the decision logic around it -- a slug hit
must short-circuit, one frame with a person must reject the whole clip, and a
result must not be recomputed on every scene.
"""

import pytest

from server import people


@pytest.fixture(autouse=True)
def clear_cache():
    people._cache.clear()
    yield
    people._cache.clear()


def test_slug_words_extracts_title_words():
    assert people.slug_words("https://www.pexels.com/video/man-holding-coffee-123/") == [
        "man",
        "holding",
        "coffee",
        "123",
    ]


def test_slug_has_person_matches_whole_words_only():
    assert people.slug_has_person(".../video/woman-at-the-beach-1/")
    assert people.slug_has_person(".../video/close-up-of-hands-2/")
    # `human` inside `human-made` is a word of its own, still a hit; but
    # `person` inside `personality` is not, because the slug is split first.
    assert not people.slug_has_person(".../video/brand-personality-3/")
    assert not people.slug_has_person(".../video/coffee-pouring-4/")


def test_filter_rejects_slug_and_frames_and_keeps_the_rest(monkeypatch):
    seen = []

    def fake_detect(images):
        seen.append(list(images))
        return any("person" in url for url in images)

    monkeypatch.setattr(people, "_any_person", fake_detect)
    payload = {
        "candidates": [
            {"id": 1, "slug": ".../video/man-holding-a-cup-1/", "images": ["a.jpg"]},
            {"id": 2, "slug": ".../video/coffee-pouring-2/", "images": ["person-2.jpg"]},
            {"id": 3, "slug": ".../video/forest-trees-3/", "images": ["tree-3.jpg"]},
        ]
    }
    result = people.handle(payload)
    assert result["allowed"] == [3]
    assert result["rejected"] == 2
    # The slug hit never reaches the detector: that is the cheap layer.
    assert seen == [["person-2.jpg"], ["tree-3.jpg"]]


def test_cache_skips_the_detector_on_repeat(monkeypatch):
    calls = []

    def fake_detect(images):
        calls.append(images)
        return False

    monkeypatch.setattr(people, "_any_person", fake_detect)
    payload = {"candidates": [{"id": 42, "slug": ".../ocean-42/", "images": ["x.jpg"]}]}
    people.handle(payload)
    people.handle(payload)
    assert len(calls) == 1


def test_candidate_without_images_is_kept(monkeypatch):
    monkeypatch.setattr(people, "_any_person", lambda images: True)
    result = people.handle({"candidates": [{"id": 7, "slug": ".../sky-7/", "images": []}]})
    assert result["allowed"] == [7]


def test_invalid_payload_raises():
    with pytest.raises(ValueError):
        people.handle({"candidates": "nope"})


def test_missing_ids_are_ignored(monkeypatch):
    monkeypatch.setattr(people, "_any_person", lambda images: False)
    result = people.handle({"candidates": [{"slug": ".../ocean/"}, "junk"]})
    assert result["allowed"] == []
    assert result["checked"] == 0
