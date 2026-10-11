"""Prompt construction and, above all, output sanitisation.

`sanitize` is the security-ish boundary of this feature: an invented `[tag]`
would be read aloud literally by the engine, and a rewritten script would
silently discard the user's work. Both are asserted here.
"""

import pytest

from server import llm, tagger, voices


class CannedLLM:
    """Stand-in for llm.chat that replays a fixed reply and records requests."""

    def __init__(self):
        self.reply = ""
        self.calls = []

    def __call__(self, messages, model, *, max_tokens=None, temperature=None):
        self.calls.append({"messages": messages, "model": model})
        return self.reply


@pytest.fixture
def canned(monkeypatch):
    stub = CannedLLM()
    monkeypatch.setattr(llm, "chat", stub)
    return stub


class TestPrompts:
    def test_tag_prompt_lists_the_catalogue_tags(self):
        # Built from voices, not a hand-written copy: the browser already gets
        # these same tables and the two must not drift.
        system = tagger.build_tag_messages("你好。", "normal", False)[0]["content"]
        for item in voices.CONTROL_TAGS:
            assert item["tag"] in system

    def test_rich_tags_are_offered_only_when_allowed(self):
        without = tagger.build_tag_messages("你好。", "normal", False)[0]["content"]
        with_rich = tagger.build_tag_messages("你好。", "normal", True)[0]["content"]
        assert "[sighing]" not in without
        assert "[sighing]" in with_rich

    def test_prompt_forbids_rewriting(self):
        system = tagger.build_tag_messages("你好。", "normal", False)[0]["content"]
        assert "不得增加、删除、改写" in system

    def test_script_prompt_carries_the_brief(self):
        messages = tagger.build_script_messages(
            "露营", "90 秒", "轻松活泼", "宝妈", "dense", True
        )
        system = messages[0]["content"]
        assert "露营" in system
        assert "90 秒" in system
        assert "轻松活泼" in system
        assert "宝妈" in system

    def test_unknown_density_falls_back_to_normal(self):
        system = tagger.build_tag_messages("你好。", "nonsense", False)[0]["content"]
        assert tagger._DENSITY_RULE["normal"].split("。")[0] in system

    def test_density_changes_the_instruction(self):
        sparse = tagger.build_tag_messages("你好。", "sparse", False)[0]["content"]
        dense = tagger.build_tag_messages("你好。", "dense", False)[0]["content"]
        assert sparse != dense
        assert "250" in sparse
        assert "80" in dense


class TestSanitizeBoilerplate:
    def test_strips_a_code_fence(self):
        result = tagger.sanitize("```text\n[sad]你好。\n```", allow_rich=False)
        assert result.text == "[sad]你好。"

    def test_strips_a_preamble(self):
        result = tagger.sanitize("好的，以下是标注后的文稿：\n[sad]你好。", allow_rich=False)
        assert result.text == "[sad]你好。"

    def test_strips_a_trailing_rule(self):
        result = tagger.sanitize("[sad]你好。\n---", allow_rich=False)
        assert result.text == "[sad]你好。"

    def test_collapses_runs_of_blank_lines(self):
        result = tagger.sanitize("[sad]一。\n\n\n\n二。", allow_rich=False)
        assert result.text == "[sad]一。\n\n二。"

    def test_empty_response_is_reported_not_raised(self):
        result = tagger.sanitize("```\n```", allow_rich=False)
        assert result.text == ""
        assert result.warnings


class TestSanitizeTags:
    def test_keeps_catalogue_tags(self):
        result = tagger.sanitize("[sad]今天很难过。", allow_rich=False)
        assert result.text == "[sad]今天很难过。"
        assert result.inserted == 1

    def test_drops_tags_the_model_invented(self):
        # The engine would read these aloud.
        result = tagger.sanitize("[melancholic][sad]今天很难过。", allow_rich=False)
        assert result.text == "[sad]今天很难过。"

    def test_drops_rich_tags_when_not_requested(self):
        result = tagger.sanitize("[sighing][sad]唉。", allow_rich=False)
        assert result.text == "[sad]唉。"

    def test_keeps_rich_tags_when_requested(self):
        result = tagger.sanitize("[sighing]唉。", allow_rich=True)
        assert result.text == "[sighing]唉。"
        assert result.inserted == 1

    def test_canonicalises_wrong_case(self):
        result = tagger.sanitize("[Sad]唉。", allow_rich=False)
        assert result.text == "[sad]唉。"

    def test_counts_every_kept_tag(self):
        result = tagger.sanitize("[sad]一。[excited]二。[angry]三。", allow_rich=False)
        assert result.inserted == 3

    def test_source_brackets_are_left_alone(self):
        # The user may legitimately have [1] in their script. Deleting it would
        # be data loss, and would also trip the drift check.
        result = tagger.sanitize("参见[1]。[sad]唉。", allow_rich=False, source="参见[1]。唉。")
        assert result.text == "参见[1]。[sad]唉。"
        assert result.inserted == 1

    def test_multi_word_tags_survive(self):
        assert "[deep and loud shouting]" in tagger.sanitize(
            "[deep and loud shouting]喊！", allow_rich=False
        ).text


class TestDriftDetection:
    def test_clean_tagging_reports_no_warnings(self):
        result = tagger.sanitize("[sad]今天很难过。", allow_rich=False, source="今天很难过。")
        assert result.warnings == []

    def test_rewritten_words_are_flagged(self):
        result = tagger.sanitize("[sad]今天真是糟糕透了。", allow_rich=False, source="今天很难过。")
        assert any("改动" in w for w in result.warnings)

    def test_truncation_is_flagged(self):
        result = tagger.sanitize("[sad]唉。", allow_rich=False, source="一二三四五六七八九十。" * 20)
        assert any("截断" in w for w in result.warnings)

    def test_whitespace_reflow_is_not_drift(self):
        # Models rewrap lines; that is not a rewrite.
        result = tagger.sanitize("[sad]今天  很难过。\n", allow_rich=False, source="今天很难过。")
        assert result.warnings == []

    def test_no_source_means_nothing_to_compare(self):
        # Script mode writes new text, so a drift check would be meaningless.
        assert tagger.sanitize("全新的一段稿子。", allow_rich=False).warnings == []


class TestHighLevel:
    def test_tag_text_passes_the_source_through_for_comparison(self, canned):
        canned.reply = "[sad]今天很难过。"
        result = tagger.tag_text("今天很难过。", "normal", False, "fast")
        assert result.text == "[sad]今天很难过。"
        assert canned.calls[0]["messages"][-1]["content"] == "今天很难过。"

    def test_write_script_does_not_compare_against_a_source(self, canned):
        canned.reply = "露营装备清单：帐篷、睡袋、头灯。"
        result = tagger.write_script("露营", "60 秒", "轻松", "宝妈", "normal", False, "fast")
        assert result.warnings == []

    def test_provider_failure_propagates_as_llm_error(self, canned, monkeypatch):
        def boom(*_args, **_kwargs):
            raise llm.LLMError(502, "上游炸了")

        monkeypatch.setattr(llm, "chat", boom)
        with pytest.raises(llm.LLMError):
            tagger.tag_text("你好。", "normal", False, "fast")