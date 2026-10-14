// Instruct string assembly.
//
// The templates are the whole contract with the upstream API: a wording that
// drifts by a character comes back as a bare 428 that looks like the voice is
// broken. They are duplicated across two tabs if not shared, so they are pinned
// here.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INSTRUCTION_TEMPLATES,
  VOICE_DEPENDENT_KINDS,
  buildInstruction,
  instructionValues,
  isVoiceDependent,
} from '../../static/js/instruct.js';

describe('buildInstruction', () => {
  it('matches the wording server/voices.py documents', () => {
    // Kept in step with build_instruction() in server/voices.py.
    assert.equal(buildInstruction('emotion', 'happy'), '你说话的情感是happy。');
    assert.equal(buildInstruction('scene', '新闻播报'), '你正在进行新闻播报，你说话的情感是neutral。');
    assert.equal(buildInstruction('dialect', '粤语'), '请用粤语表达。');
  });

  it('carries role and identity too', () => {
    assert.equal(buildInstruction('role', '记者'), '你现在说话的角色是记者，你说话的情感是neutral。');
    assert.equal(
      buildInstruction('identity', '老人'),
      '你正在以一个老人的身份说话，你说话的情感是neutral。'
    );
  });

  it('passes custom text through untouched', () => {
    // The user wrote the sentence the API will receive; rewriting it could
    // only get it rejected.
    assert.equal(buildInstruction('custom', '', '请慢一点说。'), '请慢一点说。');
    assert.equal(buildInstruction('custom', 'happy', '请慢一点说。'), '请慢一点说。');
  });

  it('trims custom text', () => {
    assert.equal(buildInstruction('custom', '', '  请慢一点说。  '), '请慢一点说。');
  });

  it('is empty for no kind', () => {
    assert.equal(buildInstruction('', 'happy'), '');
    assert.equal(buildInstruction(null, 'happy'), '');
  });

  it('is empty for a preset kind with no value', () => {
    assert.equal(buildInstruction('emotion', ''), '');
    assert.equal(buildInstruction('emotion', '   '), '');
  });

  it('is empty for custom with nothing typed', () => {
    assert.equal(buildInstruction('custom', '', '   '), '');
  });

  it('is empty for an unknown kind rather than echoing the value', () => {
    // build_instruction() in voices.py returns the bare value in this case,
    // but sending an unstructured value produces an opaque upstream error.
    assert.equal(buildInstruction('nonsense', 'happy'), '');
  });

  it('every template ends with a full stop', () => {
    // The upstream reference requires it; a missing one is a 400 with no
    // useful message.
    for (const [kind, template] of Object.entries(INSTRUCTION_TEMPLATES)) {
      assert.ok(template('x').endsWith('。'), `${kind} is missing the trailing 。`);
    }
  });
});

describe('instructionValues', () => {
  const labels = { happy: '开心', sad: '悲伤' };

  it('labels emotions in Chinese and keeps the English visible', () => {
    const values = instructionValues('emotion', { emotionValues: ['happy', 'sad'], labels });
    assert.deepEqual(values, [
      { value: 'happy', label: '开心（happy）' },
      { value: 'sad', label: '悲伤（sad）' },
    ]);
  });

  it('falls back to the raw value with no label', () => {
    const values = instructionValues('emotion', { emotionValues: ['neutral'] });
    assert.deepEqual(values, [{ value: 'neutral', label: 'neutral' }]);
  });

  it('returns nothing for a kind with no list, such as custom', () => {
    assert.deepEqual(instructionValues('custom', { emotionValues: ['happy'] }), []);
    assert.deepEqual(instructionValues('', {}), []);
  });

  it('returns nothing when the caller supplies no list', () => {
    assert.deepEqual(instructionValues('emotion'), []);
  });
});

describe('isVoiceDependent', () => {
  it('flags the kinds that vary by voice', () => {
    for (const kind of VOICE_DEPENDENT_KINDS) {
      assert.equal(isVoiceDependent(kind), true, `${kind} should be voice dependent`);
    }
  });

  it('does not flag emotion', () => {
    // Emotion is a model-level enum, so it is safe for any voice.
    assert.equal(isVoiceDependent('emotion'), false);
  });
});