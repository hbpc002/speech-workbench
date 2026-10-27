// 本地规则标注：不联网、不花钱、结果确定。
//
// 与 AI 加标签走同一个预览弹窗，区别只在于文本是这里算出来的还是模型生成的。
// 规则很浅 —— 靠关键词和标点猜情绪，长文本里会显得套路化，所以默认档位
// (适中) 只在关键词命中时动手。只有你在明确需要零延迟时才会用到它。

// 情感标签。查表顺序即优先级：控制标签先于拟声标签，也先于下面的标点兜底。
// 控制标签会一直生效到下一个标签，所以「可惜！」应该是 [sad] 而不是感叹号给的
// [excited]；而「唉」只列在拟声表里，是刻意如此 —— 它是一次性的叹气声，不是情绪。
const CONTROL_RULES = [
  ['[excited]', ['太好了', '太棒', '真棒', '好厉害', '终于', '成功', '恭喜', '惊喜', '最喜欢']],
  ['[amazed]', ['竟然', '居然', '没想到', '不敢相信', '天哪', '不可思议', '太神奇']],
  ['[angry]', ['可气', '生气', '太气', '讨厌', '凭什么', '荒谬', '愤怒', '可恶']],
  ['[sad]', ['可惜', '遗憾', '难过', '失落', '眼泪', '难受', '心酸']],
  ['[curious]', ['为什么', '是不是', '你知道吗', '猜猜', '怎么做到', '什么原理']],
  ['[serious]', ['请注意', '记住', '千万', '必须', '切记', '严肃']],
  ['[panicked]', ['快跑', '危险', '救命', '怎么办', '紧急', '来不及']],
  ['[tired]', ['好累', '疲惫', '熬夜', '撑不住', '精疲力尽']],
  ['[whispers]', ['悄悄', '小声', '偷偷', '别让', '低声']],
];

// 拟声标签。只在句首位置插一次，不影响上下文。
const RICH_RULES = [
  ['[giggles]', ['哈哈', '嘻嘻', '咯咯']],
  ['[laughing]', ['笑死', '大笑', '哈哈大笑']],
  ['[sighing]', ['唉', '哎']],
  ['[gasp]', ['倒吸', '倒抽']],
];

// 标点兜底，只有「适中」和「密集」才启用。
const PUNCTUATION_RULES = [
  ['[excited]', /[！!]{1,}\s*$/],
  ['[curious]', /[？?]\s*$/],
];

/**
 * Tag one sentence.
 *
 * A tag always goes at the very front, because the engine applies a control
 * tag to everything after it and createRecord() carries it across the sentence
 * split. Anything else would be read out at the wrong moment.
 */
function tagSentence(sentence, density, allowRich) {
  if (/^\s*\[/.test(sentence)) return sentence; // already tagged

  const lower = sentence;
  for (const [tag, keywords] of CONTROL_RULES) {
    if (keywords.some((word) => lower.includes(word))) return tag + sentence;
  }
  if (allowRich) {
    for (const [tag, keywords] of RICH_RULES) {
      if (keywords.some((word) => lower.includes(word))) return tag + sentence;
    }
  }
  if (density !== 'sparse') {
    for (const [tag, pattern] of PUNCTUATION_RULES) {
      if (pattern.test(sentence)) return tag + sentence;
    }
  }
  return sentence;
}

/**
 * Tag a whole script.
 *
 * @param {string[]} sentences  already split by splitSentences()
 * @param {string} density      sparse | normal | dense
 * @param {boolean} allowRich
 * @returns {string[]} the tagged sentences, in order
 */
export function tagSentences(sentences, density = 'normal', allowRich = false) {
  return sentences.map((sentence) => tagSentence(sentence, density, allowRich));
}

/**
 * True when the script already contains one of `tags`.
 *
 * @param {string} text
 * @param {string[]} tags  literal tag strings, e.g. ['[sad]', '[sighing]']
 */
export function hasAnyTag(text, tags) {
  const body = text || '';
  return tags.some((tag) => body.includes(tag));
}

/**
 * Every tag string the runtime config knows about, longest first.
 *
 * Longest-first matters to `stripKnownTags`: with `[sad]` before `[sad violin]`,
 * removing the short one leaves a dangling ` violin]` in the text.
 *
 * @param {object} config  the `/api/config` payload
 * @returns {string[]}
 */
export function allTagStrings(config) {
  const control = ((config && config.control_tags) || []).map((item) => item.tag);
  const rich = ((config && config.rich_tags) || []).map((item) => item.tag);
  return [...control, ...rich].sort((a, b) => b.length - a.length);
}

/**
 * The text as it should be *read*, with the emotion tags taken out.
 *
 * Tags steer the synthesis engine; they are not words, and the engine consumes
 * them before speaking. Anything that renders the script as text -- captions,
 * a video title, a download filename -- has to strip them first, or `[sad]`
 * ends up on screen.
 *
 * Only tags the config lists are removed, so an ordinary bracket in the script
 * (`[1]`, `【注】`) survives untouched.
 *
 * @param {string} text
 * @param {string[]} tags
 */
export function captionText(text, tags) {
  if (!tags || !tags.length) return String(text || '').trim();
  return stripKnownTags(text, tags);
}

/**
 * Remove every tag in `tags`, leaving all other bracket groups alone.
 *
 * Tidy-up beyond the deletion itself: runs of spaces collapse and any space
 * left in front of punctuation goes away, because deleting "[sad]" from
 * "[sad] 今天" would otherwise leave a dangling gap. `tags` should be sorted
 * longest-first so multi-word tags are not clipped by a shorter one.
 *
 * @param {string} text
 * @param {string[]} tags
 */
export function stripKnownTags(text, tags) {
  let out = text || '';
  for (const tag of tags) out = out.split(tag).join('');
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([，。！？、；：,.!?])/g, '$1')
    .trim();
}

/**
 * Insert a tag into a script without touching anything else.
 *
 * `sentences` comes from splitSentences(), which trims as it splits, so the
 * walk below copies through the gaps between sentences verbatim -- paragraph
 * breaks, indentation and stray spaces all survive.
 *
 * @param {string} text
 * @param {string[]} sentences  the same script, already split
 * @param {string} density
 * @param {boolean} allowRich
 * @returns {{text: string, inserted: number}}
 */
export function applyRules(text, sentences, density = 'normal', allowRich = false) {
  const tagged = tagSentences(sentences, density, allowRich);
  let out = '';
  let cursor = 0;
  let inserted = 0;

  for (let i = 0; i < sentences.length; i++) {
    const at = text.indexOf(sentences[i], cursor);
    if (at === -1) continue; // defensive: the splitter ran past the text
    out += text.slice(cursor, at) + tagged[i];
    cursor = at + sentences[i].length;
    if (tagged[i] !== sentences[i]) inserted += 1;
  }

  out += text.slice(cursor);
  return { text: out, inserted };
}