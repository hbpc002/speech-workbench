"""Emotion tag insertion for tab 3, driven by a text model.

`voices.CONTROL_TAGS` and `voices.RICH_TAGS` are the single source of truth for
what the qwen-audio-3.x models understand, and they are already shipped to the
browser through /api/config. The prompts below are built from those same
tables at request time rather than from a hand-written copy, which is how
static/js/voiceover_prompt.js drifted out of sync with the catalogue.

Two jobs, both of which end in `sanitize`:

* `tag_text`     - label a script the user already wrote, without touching a
                   single character of it.
* `write_script` - write a fresh tagged script from a topic, the job the `?`
                   dialog used to delegate to whatever AI the user had open.

`sanitize` is not decoration. Models drift: they invent tags the engine has
never heard of, wrap the answer in a code fence, prepend "好的，以下是…", and
occasionally helpfully rewrite the copy. An invented tag is read aloud
literally, so unknown bracket groups are dropped before anything reaches the
TTS engine.
"""

import re
from dataclasses import dataclass, field

from . import config, llm, voices

_CONTROL_TAGS = [item["tag"] for item in voices.CONTROL_TAGS]
_RICH_TAGS = [item["tag"] for item in voices.RICH_TAGS]

# `[content]` with no newline inside, so a stray "[" cannot swallow the rest.
_BRACKET = re.compile(r"\[([^\[\]\n]{0,48})\]")
_FENCE = re.compile(r"^\s*```[a-zA-Z0-9_-]*\s*\n?|\n?\s*```\s*$")
_PREAMBLE = re.compile(
    r"^\s*(?:好的|当然|没问题|以下是)[，,。！!、\s]*"
    r"(?:以下是|为您写的(?:是)?)?[^：:\n]{0,24}[：:]\s*"
)
_TRAILER = re.compile(r"\n\s*(?:以上(?:就是|是)[^\n]*|---+\s*)\s*$")

# How often a control tag may appear, per 100 characters of script.
_DENSITY_RULE = {
    "sparse": "全篇每 250 字最多一个标签，能不插就不插，整体基调保持一致。",
    "normal": "每 150 字最多一个标签，在情绪真正转折的地方插。",
    "dense": "每 80 字左右一个标签，允许更明显的情绪起伏。",
}
_DEFAULT_DENSITY = "normal"


@dataclass
class SanitizeResult:
    text: str
    inserted: int = 0
    warnings: list[str] = field(default_factory=list)


def densities() -> list[dict]:
    return config.TAGS_DENSITIES


def density_ids() -> set[str]:
    return {item["id"] for item in config.TAGS_DENSITIES}


def _density_rule(density: str) -> str:
    rules = {item["id"]: _DENSITY_RULE.get(item["id"]) for item in config.TAGS_DENSITIES}
    if density in rules and rules[density]:
        return rules[density]
    return _DENSITY_RULE[_DEFAULT_DENSITY]


def _tag_table() -> tuple[str, str]:
    """Human label plus literal spelling, rendered from the voice catalogue."""
    control = " ".join(f"{item['name']} {item['tag']}" for item in voices.CONTROL_TAGS)
    rich = " ".join(f"{item['name']} {item['tag']}" for item in voices.RICH_TAGS)
    return control, rich


def build_tag_messages(text: str, density: str, allow_rich: bool) -> list[dict]:
    """Instructions for labelling text that must come back word-for-word."""
    control, rich = _tag_table()
    rules = [
        "1. 原文一个字都不得增加、删除、改写或调整顺序。它是用户自己写的，只能加标签。",
        "2. 标签只能插在句子的开头，不能插在句子中间，也不能把已有的标签搬走。",
        "3. 方括号里只能填下面列出的标签，不要自创、不要翻译、不要改大小写。",
        "4. 方括号不得有其他用途：正文里如果本来就有 [1]、[注] 这类写法，原样保留。",
        "5. 只输出标注后的全文，不要解释、不要前言、不要总结、不要标题、不要代码块围栏。",
    ]
    if allow_rich:
        rules.append("6. 拟声标签全篇最多 2 个，只放在真正合适的转折或感叹处。")

    sections = [
        "你是一名中文口播稿的情感标注助手。你会收到一段已经写好的口播稿，"
        "你唯一的任务是在句首插入情感标签，让语音合成引擎按标签朗读出正确的情绪。",
        "【铁律】\n" + "\n".join(rules),
        "【可用情感标签】写在标签后会影响其后所有文字，直到遇到下一个情感标签：\n" + control,
    ]
    if allow_rich:
        sections.append(
            "【可用拟声标签】只在标签所在位置插入一次效果，不影响上下文，全篇至多 2 个：\n" + rich
        )
    sections.append("【标签密度】" + _density_rule(density))

    return [
        {"role": "system", "content": "\n\n".join(sections)},
        {"role": "user", "content": text},
    ]


def build_script_messages(
    topic: str,
    duration: str,
    tone: str,
    audience: str,
    density: str,
    allow_rich: bool,
) -> list[dict]:
    """Instructions for writing a new tagged script, mirroring the `?` dialog."""
    control, rich = _tag_table()
    sections = [
        "你是一名专业的中文口播稿撰稿人。请写一段可以直接用于语音合成的口播稿。",
        "【重要前提】最终稿会被送入 TTS 引擎朗读，引擎会在文本中识别形如 [标签] 的情感标记。",
        "【可用情感标签】写在标签后会影响其后所有文字，直到遇到下一个情感标签：\n" + control,
    ]
    if allow_rich:
        sections.append(
            "【可用拟声标签】只在标签所在位置插入一次效果，不影响上下文，全篇至多 2 个：\n" + rich
        )
    sections.append(
        "【标签规则】\n"
        "1. 标签只放在句首，不要插在句子中间。\n"
        "2. 开篇第一个标签点明全篇基调。\n"
        "3. 方括号内只能填上面的标签，不要自创；也不要出现 [1]、[注] 这类其他用法。\n"
        "4. " + _density_rule(density)
    )
    sections.append(
        "【文稿要求】\n"
        "1. 口语化，短句为主，适合朗读。\n"
        "2. 不写画面提示，不写“（微笑）”这类表演说明。\n"
        "3. 数字与缩写写成口语形式，如“110”写成“幺幺零”，“20%”写成“百分之二十”。\n"
        "4. 段落之间空行分隔，每段 2–4 句，结尾要有收束。\n"
        "5. 只输出正文，不要标题、不要编号、不要解释、不要代码块围栏。"
    )
    sections.append(
        "【本次任务】\n"
        f"主题：{topic}\n"
        f"时长：{duration}\n"
        f"语气：{tone}\n"
        f"目标听众：{audience}"
    )

    return [{"role": "system", "content": "\n\n".join(sections)}]


def _strip_boilerplate(text: str) -> str:
    text = _FENCE.sub("", text)
    text = _PREAMBLE.sub("", text, count=1)
    text = _TRAILER.sub("", text)
    return text.strip()


def _bracket_allowlist(source: str, allow_rich: bool) -> dict[str, str]:
    """Map lowercased bracket contents to the canonical spelling.

    The provider's own catalogue first. Anything the *source* already contained
    is then allowed through verbatim: the user's script may legitimately hold
    `[1]` or `[注]`, and silently deleting those would be worse than leaving
    them alone -- and would show up as drift.
    """
    allowed = {tag.strip("[]").lower(): tag for tag in _CONTROL_TAGS}
    if allow_rich:
        allowed.update({tag.strip("[]").lower(): tag for tag in _RICH_TAGS})

    for match in _BRACKET.finditer(source or ""):
        allowed.setdefault(match.group(1).strip().lower(), match.group(0))
    return allowed


def _normalize(text: str) -> str:
    """Whitespace-free form, for checking that no *words* changed.

    Models rewrap paragraphs and occasionally double a space. Neither is a
    rewrite, so whitespace is dropped entirely rather than collapsed: the
    question this answers is only whether the wording survived.
    """
    return re.sub(r"\s+", "", text or "")


def sanitize(raw: str, *, allow_rich: bool, source: str = "") -> SanitizeResult:
    """Clean one model response into something safe to synthesize.

    `source` is the text that came back from the user, when tagging an
    existing script. It is used twice: to let through bracket groups the user
    wrote themselves, and to detect whether the model rewrote their words.
    """
    warnings: list[str] = []
    text = _strip_boilerplate(raw or "")
    allowed = _bracket_allowlist(source, allow_rich)
    known = set(_CONTROL_TAGS) | (set(_RICH_TAGS) if allow_rich else set())
    kept = 0

    def replace(match: re.Match) -> str:
        nonlocal kept
        canonical = allowed.get(match.group(1).strip().lower())
        if canonical is None:
            # Not in the catalogue and not in the user's own text: the model
            # invented it. The engine would read it aloud literally.
            return ""
        if canonical not in known:
            # Bracket group the user already had, e.g. [1]. Leave it verbatim.
            return match.group(0)
        kept += 1
        return canonical

    text = _BRACKET.sub(replace, text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    if not text:
        return SanitizeResult("", 0, ["模型没有返回可用文本"])

    baseline = source.strip()
    if baseline:
        # Drift: everything except bracket groups must survive untouched.
        stripped_now = _BRACKET.sub("", text)
        if _normalize(stripped_now) != _normalize(baseline):
            warnings.append("模型改动了原文的部分文字，请对照后确认再应用")
        if len(text) < len(baseline) * 0.6:
            warnings.append("结果明显短于原文，可能被截断")

    return SanitizeResult(text, kept, warnings)


def _call(messages: list[dict], model: str, max_tokens: int | None) -> str:
    return llm.chat(messages, model, max_tokens=max_tokens)


def tag_text(text: str, density: str, allow_rich: bool, model: str) -> SanitizeResult:
    """Insert tags into `text` and prove afterwards that nothing else moved."""
    raw = _call(build_tag_messages(text, density, allow_rich), model, None)
    return sanitize(raw, allow_rich=allow_rich, source=text)


def write_script(
    topic: str,
    duration: str,
    tone: str,
    audience: str,
    density: str,
    allow_rich: bool,
    model: str,
) -> SanitizeResult:
    """Write a fresh script from a topic. No drift check: the text is new."""
    messages = build_script_messages(topic, duration, tone, audience, density, allow_rich)
    raw = _call(messages, model, None)
    return sanitize(raw, allow_rich=allow_rich)