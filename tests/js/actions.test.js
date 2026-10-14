// History-card action buttons.
//
// The regression worth guarding: `.hactions button` is rendered with
// `font-size: 0` below 760px and repainted from `attr(data-short)`. A button
// missing that attribute is an invisible control with no error anywhere.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SHORT_LABELS, actionButton, shortLabel } from '../../static/js/actions.js';

/** Minimal stand-in for the bits of DOM that actionButton touches. */
function fakeDocument() {
  return (tag) => ({
    tagName: tag,
    dataset: {},
    listeners: {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
  });
}

const build = (label, options = {}) => actionButton(label, { create: fakeDocument(), ...options });

describe('actionButton', () => {
  it('always carries data-short', () => {
    // The whole reason this module exists.
    for (const label of Object.keys(SHORT_LABELS)) {
      const node = build(label);
      assert.ok(node.dataset.short, `${label} has no data-short and would render blank`);
    }
  });

  it('uses the documented short form', () => {
    assert.equal(build('重新生成').dataset.short, '重生');
    assert.equal(build('播放').dataset.short, '播放');
  });

  it('falls back to the label for an unknown action', () => {
    // A long label that wraps is better than an invisible button.
    const node = build('导出为 MP3');
    assert.equal(node.dataset.short, '导出为 MP3');
    assert.ok(node.dataset.short.length > 0);
  });

  it('lets the caller override the short form', () => {
    assert.equal(build('重新生成', { short: '重生2' }).dataset.short, '重生2');
  });

  it('keeps the full label as the text on wide screens', () => {
    assert.equal(build('重新生成').textContent, '重新生成');
  });

  it('defaults to the ghost class', () => {
    assert.equal(build('播放').className, 'ghost');
    assert.equal(build('下载', { className: '' }).className, '');
  });

  it('coerces disabled to a boolean', () => {
    assert.equal(build('播放').disabled, false);
    assert.equal(build('播放', { disabled: 1 }).disabled, true);
  });

  it('omits the title when there is none', () => {
    assert.equal('title' in build('播放'), false);
    assert.equal(build('播放', { title: '说明' }).title, '说明');
  });

  it('registers the click handler', () => {
    let clicked = 0;
    const node = build('播放', { onClick: () => (clicked += 1) });
    node.listeners.click();
    assert.equal(clicked, 1);
  });

  it('tolerates a missing handler', () => {
    assert.doesNotThrow(() => build('播放'));
  });

  it('explains itself when there is no document', () => {
    assert.throws(() => actionButton('播放'), /needs a document/);
  });
});

describe('shortLabel', () => {
  it('covers every action the tabs use', () => {
    for (const label of ['播放', '下载', '重新生成', '删除']) {
      assert.ok(SHORT_LABELS[label], `${label} has no short form`);
    }
  });

  it('is never empty', () => {
    for (const [label, short] of Object.entries(SHORT_LABELS)) {
      assert.ok(short.length > 0, `${label} maps to an empty short form`);
    }
  });

  it('passes unknown labels through', () => {
    assert.equal(shortLabel('清空历史'), '清空历史');
  });
});