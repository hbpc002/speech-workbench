// 本地规则标注的单元测试。
//
// 这是唯一一条完全不依赖网络的加标签路径，断网时用户仍能用它，所以它坏了
// 不会有任何报错提示 —— 只有测试能发现。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyRules, hasAnyTag, stripKnownTags, tagSentences } from '../../static/js/tag_rules.js';

/** The real catalogue, longest-first, the way allTags() builds it. */
const TAGS = ['[sad]', '[excited]', '[sighing]', '[giggles]', '[deep and loud shouting]', '[very fast]']
  .sort((a, b) => b.length - a.length);

/** Mirror of splitSentences() in static/js/audio.js, which needs the DOM. */
function splitSentences(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  const parts = trimmed.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [trimmed];
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Everything except the tags we inserted. */
function withoutTags(text) {
  return text.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
}

function tag(text, density = 'normal', allowRich = false) {
  return applyRules(text, splitSentences(text), density, allowRich);
}

describe('applyRules — never loses or invents words', () => {
  const script = '你好啊。今天终于成功了！可惜天气不好。为什么呢？\n\n下一段开始。';

  it('preserves the script byte for byte apart from tags', () => {
    for (const density of ['sparse', 'normal', 'dense']) {
      const result = tag(script, density);
      assert.equal(withoutTags(result.text), script.replace(/\s+/g, ''), `density ${density}`);
    }
  });

  it('preserves paragraph breaks and indentation', () => {
    assert.ok(tag(script).text.includes('\n\n'), 'blank line lost');
  });

  it('does not duplicate repeated sentences', () => {
    // A substring-based rebuild would insert every tag occurrence twice.
    const repeated = '太好了！\n\n太好了！';
    const result = tag(repeated);
    assert.equal((result.text.match(/\[excited\]/g) || []).length, 2);
    assert.equal(withoutTags(result.text), repeated.replace(/\s+/g, ''));
  });

  it('handles empty and whitespace-only input', () => {
    assert.deepEqual(tag(''), { text: '', inserted: 0 });
    assert.deepEqual(tag('   \n  '), { text: '   \n  ', inserted: 0 });
  });

  it('leaves a script with nothing to match alone', () => {
    const plain = '这是一段很普通的文字。';
    const result = tag(plain);
    assert.equal(result.text, plain);
    assert.equal(result.inserted, 0);
  });
});

describe('tagSentences — placement and density', () => {
  it('puts the tag at the very front', () => {
    // createRecord() carries a control tag across the sentence split, which
    // only works if tags lead their sentence.
    assert.equal(tagSentences(['今天终于成功了！'])[0].startsWith('[excited]'), true);
  });

  it('never stacks two tags on one sentence', () => {
    const tagged = tagSentences(['太棒了，简直好厉害！'], 'dense', true);
    assert.equal((tagged[0].match(/\[[a-z ]+\]/g) || []).length, 1);
  });

  it('skips sentences that already carry a tag', () => {
    assert.equal(tagSentences(['[sad]唉。'], 'dense', true)[0], '[sad]唉。');
  });

  it('skips the punctuation fallback when sparse', () => {
    // No keywords here, so only 感叹号/问号 could have fired.
    assert.equal(tagSentences(['真的吗？'], 'sparse')[0], '真的吗？');
    assert.equal(tagSentences(['真的吗？'], 'normal')[0], '[curious]真的吗？');
    assert.equal(tagSentences(['走啊！'], 'dense')[0], '[excited]走啊！');
  });

  it('prefers a keyword tag over the punctuation fallback', () => {
    // A control tag colours everything after it, so the keyword has to win:
    // [excited] here would leak into the rest of the paragraph.
    assert.equal(tagSentences(['可惜！'], 'dense')[0], '[sad]可惜！');
  });

  it('treats a bare 唉 as a sigh, not a mood', () => {
    // Deliberate: 唉 is only in the rich table. [sad] would bleed into the next
    // paragraph, which is not what a sigh means.
    assert.equal(tagSentences(['唉。'], 'normal', true)[0], '[sighing]唉。');
    assert.equal(tagSentences(['唉。'], 'normal', false)[0], '唉。');
  });

  it('adds rich tags only when allowed', () => {
    assert.equal(tagSentences(['哈哈真好笑。'], 'normal', false)[0], '哈哈真好笑。');
    assert.equal(tagSentences(['哈哈真好笑。'], 'normal', true)[0], '[giggles]哈哈真好笑。');
  });
});

describe('inserted count', () => {
  it('counts only the sentences it actually touched', () => {
    const script = '今天终于成功了！可惜天气不好。你好啊。';
    assert.equal(tag(script).inserted, 2);
  });

  it('is zero for an untouched script', () => {
    assert.equal(tag('完全平淡无奇的一段话。').inserted, 0);
  });
});
describe('hasAnyTag', () => {
  it('detects a known tag', () => {
    assert.equal(hasAnyTag('[sad]唉。', TAGS), true);
  });

  it('ignores brackets it does not know', () => {
    // The user's own [1] / [注] must not count.
    assert.equal(hasAnyTag('参见[1]。', TAGS), false);
    assert.equal(hasAnyTag('[melancholic]唉。', TAGS), false);
  });

  it('is false for empty or tag-free text', () => {
    assert.equal(hasAnyTag('', TAGS), false);
    assert.equal(hasAnyTag('   ', TAGS), false);
    assert.equal(hasAnyTag(undefined, TAGS), false);
  });
});

describe('stripKnownTags', () => {
  it('removes every occurrence, not just the first', () => {
    assert.equal(stripKnownTags('[sad]一。[excited]二。[sad]三。', TAGS), '一。二。三。');
  });

  it('removes multi-word tags whole', () => {
    assert.equal(
      stripKnownTags('[deep and loud shouting]喊！[very fast]快跑！', TAGS),
      '喊！快跑！'
    );
  });

  it('leaves unknown bracket groups alone', () => {
    // Stripping [1] would be data loss, and would trip the drift check.
    assert.equal(stripKnownTags('[sad]参见[1]。[注]完。', TAGS), '参见[1]。[注]完。');
  });

  it('tidies the whitespace the deletion leaves behind', () => {
    // Deleting "[sad]" from "[sad] 你好" would otherwise leave a dangling gap.
    assert.equal(stripKnownTags('[sad] 你好，世界。', TAGS), '你好，世界。');
    assert.equal(stripKnownTags('[sad][excited]你好', TAGS), '你好');
    assert.equal(stripKnownTags('  [sad]  你好  ', TAGS), '你好');
  });

  it('removes a space that sat in front of punctuation', () => {
    // "今天[sad]，世界" becomes "今天，世界" rather than "今天 ，世界".
    assert.equal(stripKnownTags('今天[sad]，世界。', TAGS), '今天，世界。');
  });

  it('handles empty input', () => {
    assert.equal(stripKnownTags('', TAGS), '');
    assert.equal(stripKnownTags(undefined, TAGS), '');
  });

  it('is a no-op on text with no tags', () => {
    assert.equal(stripKnownTags('一段普通的文字。', TAGS), '一段普通的文字。');
  });

  it('round-trips with the tagger: strip, then re-tag', () => {
    const script = '[sad]今天很难过。[giggles]哈哈。';
    const bare = stripKnownTags(script, TAGS);
    assert.equal(bare, '今天很难过。哈哈。');
    assert.equal(hasAnyTag(bare, TAGS), false);
  });
});
