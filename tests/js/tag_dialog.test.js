// The AI dialog shared by the synthesis tab and the clone-generation tab.
//
// One `<dialog>` element, two entry buttons in two panels, and a script box in
// each. Every way that can go wrong here fails quietly, which is why these are
// tested rather than eyeballed:
//
//   * an `apply` that writes into the *other* tab's textarea -- the dialog says
//     "已插入 N 个标签", the text on screen never changes
//   * applying tags after the model was switched to one that reads them aloud
//     literally (418 for the wrong model, 字符串朗读 for cosyvoice)
//   * both tabs wiring the dialog's own buttons, so one click runs the handler
//     twice and races two different target boxes
//
// The DOM comes from tests/js/dom_stub.js, which is why the module has to reach
// for its nodes lazily rather than at import time.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { installDom, stubFetch, uninstallDom } from './dom_stub.js';

// The state singleton, imported directly rather than through app.js: importing
// app.js boots the page, and its async tail would still be running when the
// afterEach removed `document`.
import { state } from '../../static/js/dom.js';

const TAG_DIALOG = '../../static/js/tag_dialog.js';

let counter = 0;

/** Ids the dialog owns. Without them in the DOM, wiring throws at first use. */
const DIALOG_IDS = [
  'tts-ai', 'tts-ai-title', 'tts-ai-form', 'tts-ai-result', 'tts-ai-summary',
  'tts-ai-warnings', 'tts-ai-compare', 'tts-ai-before', 'tts-ai-after',
  'tts-ai-error', 'tts-ai-apply', 'tts-ai-back', 'tts-ai-run', 'tts-ai-close',
  'tts-ai-retry',
  'tts-ai-cancel', 'tts-ai-topic', 'tts-ai-topic-hints', 'tts-ai-duration',
  'tts-ai-tone', 'tts-ai-audience', 'tts-ai-duration-wrap', 'tts-ai-tone-wrap',
  'tts-ai-audience-wrap', 'tts-ai-duration-custom', 'tts-ai-tone-custom',
  'tts-ai-audience-custom',
  'tag-help', 'tag-help-body', 'tag-help-status', 'tag-help-close', 'tag-help-copy',
];

/** The per-panel buttons syncTagActions() greys out. */
const TAG_ACTION_IDS = ['tts-tag-ai', 'tts-tag-fast', 'tts-tag-write', 'tts-tag-note', 'tts-tag-strip'];

const CONFIG = {
  tags: {
    durations: [{ id: '60 秒', name: '60 秒' }, { id: '30 秒', name: '30 秒' }],
    tones: [{ id: '亲切自然', name: '亲切自然' }],
    audiences: [{ id: '宝妈', name: '宝妈' }],
    topic_hints: ['露营装备清单', '早八通勤'],
    rich_levels: [{ id: 'light', name: '少量' }, { id: 'off', name: '不用' }],
    default_rich_level: 'light',
  },
  llm: { models: [{ id: 'qwen-plus', name: 'qwen-plus' }], default_model: 'qwen-plus', configured: true },
};

/**
 * A fresh module instance over a fresh DOM.
 *
 * `tag_dialog` keeps module-level state (the preview it is showing, which entry
 * opened it) and a `wired` flag, so each case needs its own copy -- hence the
 * cache-busting query rather than a plain import.
 */
async function openDialog({ textarea = '', supportsTags = true, label = '文本框', routes = {} } = {}) {
  const dom = installDom({ ids: [...DIALOG_IDS, ...TAG_ACTION_IDS, 'tts-text'] });
  dom.get('tts-text').value = textarea;
  counter += 1;
  const mod = await import(`${TAG_DIALOG}?case=${counter}`);
  state.config = CONFIG;

  const calls = stubFetch({
    '/api/tts/tag': { body: { text: '[excited]太棒了。', inserted: 1, warnings: [] } },
    '/api/tts/script': { body: { text: '[whispers]悄悄说一句。', inserted: 1, warnings: ['口播稿偏短'] } },
    ...routes,
  });

  // A stand-in for the tab's script box: records what was pushed and applied.
  const scriptBox = {
    pushes: [],
    written: [],
    push(text) { this.pushes.push(text); },
    setText(text) { this.written.push(text); dom.get('tts-text').value = text; },
  };
  const reported = [];
  const tagger = mod.createTagTagger({
    textarea: dom.get('tts-text'),
    scriptBox,
    supportsTags: () => supportsTags,
    readOptions: () => ({ model: 'qwen-plus', density: 'normal', rich_level: 'light' }),
    report: (message) => reported.push(message),
    label,
  });
  return { dom, mod, tagger, scriptBox, reported, calls };
}

/** The button handlers the module wired on the shared dialog itself. */
function click(dom, id) {
  const handler = dom.get(id).listeners.click?.[0];
  assert.ok(handler, `#${id} has no click handler`);
  handler();
}

// Generous: the tab's own boot() is also in flight in these tests, so the
// microtask queue is not empty.
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

afterEach(() => {
  globalThis.fetch = undefined;
  uninstallDom();
});

describe('tag dialog: fillSelect', () => {
  it('fills a preset list and picks the requested entry', async () => {
    const { dom, mod } = await openDialog();
    const select = dom.get('tts-ai-duration');
    mod.fillSelect(select, CONFIG.tags.durations, '30 秒');
    assert.deepEqual(select.children.map((o) => o.textContent), ['60 秒', '30 秒']);
    assert.equal(select.value, '30 秒');
  });

  it('appends 自定义… only when the field allows free text', async () => {
    // The model picker must not have one: the server validates model ids
    // against a whitelist, so a typed option could only ever be rejected.
    const { dom, mod } = await openDialog();
    mod.fillSelect(dom.get('tts-ai-tone'), CONFIG.tags.tones, '亲切自然', true);
    assert.equal(dom.get('tts-ai-tone').children.at(-1).textContent, '自定义…');

    mod.fillSelect(dom.get('tts-ai-topic-hints'), CONFIG.tags.tones, '亲切自然', false);
    assert.equal(dom.get('tts-ai-topic-hints').children.length, 1);
  });

  it('falls back to the first entry when the remembered one is gone', async () => {
    const { dom, mod } = await openDialog();
    mod.fillSelect(dom.get('tts-ai-duration'), CONFIG.tags.durations, '三小时');
    assert.equal(dom.get('tts-ai-duration').value, '60 秒');
  });

  it('falls back to 自定义… rather than leaving an empty box', async () => {
    const { dom, mod } = await openDialog();
    mod.fillSelect(dom.get('tts-ai-duration'), [], '', true);
    assert.equal(dom.get('tts-ai-duration').value, '__custom__');
  });
});

describe('tag dialog: presets', () => {
  it('fills 时长/语气/听众 from the config', async () => {
    const { dom } = await openDialog();
    assert.equal(dom.get('tts-ai-duration').children.length, 3, 'two durations plus 自定义…');
    assert.equal(dom.get('tts-ai-duration').value, '60 秒');
    assert.equal(dom.get('tts-ai-tone').value, '亲切自然');
    assert.equal(dom.get('tts-ai-audience').value, '宝妈');
  });

  it('reveals the free-text box only while 自定义… is chosen', async () => {
    const { dom } = await openDialog();
    assert.equal(dom.get('tts-ai-duration-wrap').hidden, true);
    dom.get('tts-ai-duration').value = '__custom__';
    dom.get('tts-ai-duration').dispatchEvent({ type: 'change' });
    assert.equal(dom.get('tts-ai-duration-wrap').hidden, false);
  });

  it('lists the topic hints for the datalist', async () => {
    const { dom } = await openDialog();
    assert.deepEqual(dom.get('tts-ai-topic-hints').children.map((o) => o.value), ['露营装备清单', '早八通勤']);
  });
});

describe('tag dialog: 快速标注 (offline)', () => {
  it('previews the local rules and applies them to this tab\'s box', async () => {
    const { dom, tagger, scriptBox } = await openDialog({ textarea: '太棒了，这套装备真的太好用了！' });
    tagger.openFast();
    assert.equal(dom.get('tts-ai').open, true);
    assert.equal(dom.get('tts-ai-title').textContent, '快速标注');
    assert.equal(dom.get('tts-ai-summary').textContent, '已插入 1 个标签');

    click(dom, 'tts-ai-apply');
    assert.deepEqual(scriptBox.written, ['[excited]太棒了，这套装备真的太好用了！']);
    assert.deepEqual(scriptBox.pushes, ['太棒了，这套装备真的太好用了！'], 'and it is undoable');
    assert.equal(dom.get('tts-ai').open, false);
  });

  it('never touches the network', async () => {
    const { tagger, calls } = await openDialog({ textarea: '太棒了！' });
    tagger.openFast();
    await settle();
    assert.deepEqual(calls, []);
  });

  it('says so instead of opening an empty dialog when there is no text', async () => {
    const { dom, tagger, reported } = await openDialog({ textarea: '   ' });
    tagger.openFast();
    assert.equal(dom.get('tts-ai').open, false);
    assert.deepEqual(reported, ['请先输入文本']);
  });

  it('shows the before/after pair so the change can be judged', async () => {
    const { dom, tagger } = await openDialog({ textarea: '唉，太难了。' });
    tagger.openFast();
    assert.equal(dom.get('tts-ai-compare').hidden, false);
    assert.equal(dom.get('tts-ai-before').value, '唉，太难了。');
    assert.match(dom.get('tts-ai-after').value, /^\[sighing\]/);
  });
});

describe('tag dialog: AI 加情感标签', () => {
  it('sends the script and this tab\'s options, then applies the result', async () => {
    const { dom, tagger, scriptBox, calls } = await openDialog({ textarea: '太棒了！' });
    tagger.openTags();
    await settle();
    assert.equal(dom.get('tts-ai-summary').textContent, '已插入 1 个标签');

    const [call] = calls;
    assert.equal(call.url, '/api/tts/tag');
    assert.deepEqual(JSON.parse(call.options.body), {
      text: '太棒了！',
      model: 'qwen-plus',
      density: 'normal',
      rich_level: 'light',
    });

    click(dom, 'tts-ai-apply');
    assert.deepEqual(scriptBox.written, ['[excited]太棒了。']);
  });

  it('surfaces warnings instead of hiding them', async () => {
    const { dom, tagger } = await openDialog({ textarea: '太棒了！' });
    dom.get('tts-ai-topic').value = '露营装备清单';
    tagger.openScript();
    click(dom, 'tts-ai-run');
    await settle();
    assert.deepEqual(dom.get('tts-ai-warnings').children.map((li) => li.textContent), ['口播稿偏短']);
  });

  it('refuses to apply when the model stopped understanding tags', async () => {
    // Switched to cosyvoice while the dialog was open: the tags would be read
    // out as literal text, so nothing is applied and the reason is shown.
    const dom = installDom({ ids: [...DIALOG_IDS, ...TAG_ACTION_IDS, 'tts-text'] });
    counter += 1;
    const mod = await import(`${TAG_DIALOG}?case=${counter}`);
    state.config = CONFIG;
    stubFetch({ '/api/tts/tag': { body: { text: '[excited]太棒了。', inserted: 1, warnings: [] } } });

    let supported = true;
    dom.get('tts-text').value = '太棒了！';
    const scriptBox = {
      written: [],
      setText(text) { this.written.push(text); },
      push() {},
    };
    const reported = [];
    const tagger = mod.createTagTagger({
      textarea: dom.get('tts-text'),
      scriptBox,
      supportsTags: () => supported,
      readOptions: () => ({ model: 'qwen-plus', density: 'normal', rich_level: 'light' }),
      report: (message) => reported.push(message),
    });

    tagger.openTags();
    await settle();
    supported = false;
    click(dom, 'tts-ai-apply');

    assert.deepEqual(scriptBox.written, [], 'nothing may be written');
    assert.deepEqual(reported, ['当前模型不支持情感标签，未应用']);
    assert.equal(dom.get('tts-ai').open, false);
  });
});

describe('tag dialog: AI 写口播稿', () => {
  it('opens the brief and asks for a topic', async () => {
    const { dom, tagger } = await openDialog();
    tagger.openScript();
    assert.equal(dom.get('tts-ai').open, true);
    assert.equal(dom.get('tts-ai-form').hidden, false);

    click(dom, 'tts-ai-run');
    assert.equal(dom.get('tts-ai-error').hidden, false);
    assert.equal(dom.get('tts-ai-error').textContent, '请填写主题');
  });

  it('sends topic, duration, tone and audience together', async () => {
    const { dom, tagger, calls } = await openDialog();
    tagger.openScript();
    dom.get('tts-ai-topic').value = '露营装备清单';
    dom.get('tts-ai-duration').value = '30 秒';
    click(dom, 'tts-ai-run');
    await settle();

    assert.deepEqual(JSON.parse(calls[0].options.body), {
      topic: '露营装备清单',
      duration: '30 秒',
      tone: '亲切自然',
      audience: '宝妈',
      model: 'qwen-plus',
      density: 'normal',
      rich_level: 'light',
    });
  });

  it('prefers what was typed when 自定义… was chosen', async () => {
    const { dom, tagger, calls } = await openDialog();
    tagger.openScript();
    dom.get('tts-ai-topic').value = '露营装备清单';
    dom.get('tts-ai-tone').value = '__custom__';
    dom.get('tts-ai-tone-custom').value = '  像老朋友聊天  ';
    click(dom, 'tts-ai-run');
    await settle();
    assert.equal(JSON.parse(calls[0].options.body).tone, '像老朋友聊天');
  });

  it('offers 返回 only from the script form', async () => {
    const { dom, tagger } = await openDialog();
    tagger.openScript();
    click(dom, 'tts-ai-run');
    await settle();
    // There is no earlier screen for the tagging entries, so 返回 there would
    // be a dead button.
    assert.equal(dom.get('tts-ai-back').hidden, false);

    dom.get('tts-text').value = '太棒了！';
    tagger.openTags();
    await settle();
    assert.equal(dom.get('tts-ai-back').hidden, true);
  });

  it('names the box the result goes into', async () => {
    const { dom, tagger } = await openDialog({ label: '生成文本' });
    dom.get('tts-text').value = '太棒了！';
    tagger.openTags();
    await settle();
    assert.equal(dom.get('tts-ai-apply').textContent, '应用到生成文本');
  });
});

describe('tag dialog: one dialog, two tabs', () => {
  it('applies into whichever box opened it', async () => {
    // The failure this module exists to prevent: a shared <dialog> whose apply
    // handler writes into whichever textarea it happened to know about.
    const { dom, mod, scriptBox } = await openDialog();
    const cloneText = { value: '可惜下雨了。' };
    const cloneWrites = [];
    const cloneTagger = mod.createTagTagger({
      textarea: cloneText,
      scriptBox: { push() {}, setText(text) { cloneWrites.push(text); } },
      supportsTags: () => true,
      readOptions: () => ({ model: 'qwen-plus', density: 'normal', rich_level: 'light' }),
      label: '生成文本',
    });

    cloneTagger.openFast();
    click(dom, 'tts-ai-apply');

    assert.deepEqual(cloneWrites, ['[sad]可惜下雨了。'], 'the clone box got it');
    assert.deepEqual(scriptBox.written, [], 'the synthesis box did not');
  });

  it('wires the dialog\'s own buttons exactly once', async () => {
    const { dom, mod, tagger } = await openDialog({ textarea: '太棒了！' });
    // The clone tab creates its tagger at import time; a second wiring would run
    // every handler twice and race two target boxes for one click.
    const second = mod.createTagTagger({
      textarea: dom.get('tts-text'),
      scriptBox: { push() {}, setText() {} },
      supportsTags: () => true,
      readOptions: () => ({ model: 'qwen-plus', density: 'normal', rich_level: 'light' }),
    });
    assert.equal(dom.get('tts-ai-apply').listeners.click.length, 1, 'one click, one handler');
    assert.equal(dom.get('tts-ai-run').listeners.click.length, 1);
    assert.equal(typeof second.openTags, 'function');

    // Both taggers remain usable, and only the last opener owns the dialog.
    tagger.openTags();
    await settle();
    assert.equal(dom.get('tts-ai').open, true);
  });
});

describe('tag dialog: button availability', () => {
  it('offers the AI entries only with a provider configured', async () => {
    const { dom, mod } = await openDialog();
    const ids = { ai: 'tts-tag-ai', fast: 'tts-tag-fast', write: 'tts-tag-write', note: 'tts-tag-note' };
    const stripCalls = [];

    mod.syncTagActions({ ids, supported: true, configured: true, syncStrip: () => stripCalls.push(1) });
    assert.equal(dom.get('tts-tag-ai').disabled, false);
    assert.equal(dom.get('tts-tag-fast').disabled, false);
    assert.equal(dom.get('tts-tag-note').hidden, true);

    mod.syncTagActions({ ids, supported: true, configured: false, syncStrip: () => {} });
    assert.equal(dom.get('tts-tag-ai').disabled, true);
    assert.equal(dom.get('tts-tag-write').disabled, true);
    // 快速标注 is local rules: no provider, no network, still usable.
    assert.equal(dom.get('tts-tag-fast').disabled, false);
    assert.equal(dom.get('tts-tag-note').textContent, '未配置 LLM_API_KEY，AI 功能不可用');

    mod.syncTagActions({ ids, supported: false, configured: true, syncStrip: () => {} });
    assert.equal(dom.get('tts-tag-fast').disabled, true);
    assert.equal(dom.get('tts-tag-note').textContent, '当前模型不支持情感标签');
    assert.deepEqual(stripCalls, [1], 'and 去标签 is re-checked every time');
  });
});

describe('tag dialog: when the model refuses', () => {
  // A throttled 百炼 account answers 429. The server now sends one actionable
  // sentence and a Retry-After; what the dialog owes the operator is a way to
  // send the same request again without retyping the brief.
  const THROTTLED = {
    status: 429,
    body: { detail: '模型 qwen-turbo 触发请求频率限制（HTTP 429），等 30 秒左右再试；也可以把「标注模型」换成 qwen-plus，不想联网就用「快速标注」（本地规则）。' },
  };

  it('shows the reason and offers a retry, with nothing to apply', async () => {
    const { dom, tagger } = await openDialog({
      textarea: '太棒了！',
      routes: { '/api/tts/tag': THROTTLED },
    });
    tagger.openTags();
    await settle();

    assert.equal(dom.get('tts-ai').open, true, 'the dialog stays open');
    assert.equal(dom.get('tts-ai-error').hidden, false);
    assert.match(dom.get('tts-ai-error').textContent, /频率限制/);
    assert.equal(dom.get('tts-ai-retry').hidden, false);
    // There is no result, so the apply button could only be a button that does
    // nothing -- which is worse than no button at all.
    assert.equal(dom.get('tts-ai-apply').hidden, true);
    assert.equal(dom.get('tts-ai-summary').textContent, '');
  });

  it('resends the same request on 重试, and applies once it works', async () => {
    let throttled = true;
    const { dom, tagger, scriptBox, calls } = await openDialog({ textarea: '太棒了！' });
    // The route changes under the dialog between the two attempts.
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/tts/tag' && throttled) {
        return { ok: false, status: 429, json: async () => THROTTLED.body };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: '[excited]太棒了。', inserted: 1, warnings: [] }),
      };
    };

    tagger.openTags();
    await settle();
    assert.equal(dom.get('tts-ai-retry').hidden, false);

    throttled = false;
    click(dom, 'tts-ai-retry');
    await settle();

    assert.equal(dom.get('tts-ai-retry').hidden, true, 'no retry once there is a result');
    assert.equal(dom.get('tts-ai-apply').hidden, false);
    assert.equal(dom.get('tts-ai-error').hidden, true);

    click(dom, 'tts-ai-apply');
    assert.deepEqual(scriptBox.written, ['[excited]太棒了。']);
    assert.equal(calls.filter((c) => c.url === '/api/tts/tag').length, 2);
  });

  it('keeps the brief so a retried 写口播稿 does not need retyping', async () => {
    const { dom, tagger, calls } = await openDialog({ routes: { '/api/tts/script': THROTTLED } });
    tagger.openScript();
    dom.get('tts-ai-topic').value = '露营装备清单';
    dom.get('tts-ai-duration').value = '30 秒';
    click(dom, 'tts-ai-run');
    await settle();
    assert.equal(dom.get('tts-ai-retry').hidden, false);
    assert.equal(dom.get('tts-ai-topic').value, '露营装备清单');

    click(dom, 'tts-ai-retry');
    await settle();
    const scripts = calls.filter((c) => c.url === '/api/tts/script');
    assert.equal(scripts.length, 2);
    assert.deepEqual(JSON.parse(scripts[1].options.body), JSON.parse(scripts[0].options.body));
  });

  it('forgets the failed request when the dialog is closed', async () => {
    const { dom, tagger, calls } = await openDialog({
      textarea: '太棒了！',
      routes: { '/api/tts/tag': THROTTLED },
    });
    tagger.openTags();
    await settle();
    click(dom, 'tts-ai-close');

    click(dom, 'tts-ai-retry');
    await settle();
    assert.equal(calls.filter((c) => c.url === '/api/tts/tag').length, 1, 'no resend after closing');
  });

  it('never offers 重试 for the offline path', async () => {
    // There is nothing to retry: the local rules cannot be throttled.
    const { dom, tagger } = await openDialog({ textarea: '太棒了！' });
    tagger.openFast();
    assert.equal(dom.get('tts-ai-retry').hidden, true);
    assert.equal(dom.get('tts-ai-apply').hidden, false);
  });
});
