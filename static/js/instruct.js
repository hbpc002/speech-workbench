// Instruct string assembly.
//
// The upstream API does not take `emotion: happy`. It takes one natural-language
// string per call, and the wording matters: `请用粤语表达。` works and
// `用粤语说。` does not. Both tabs that can issue an instruction therefore share
// one builder, because a template that differs by a character between the
// synthesis tab and the voice-clone tab produces an error that looks like the
// voice is at fault.
//
// The templates mirror server/voices.py build_instruction() for the three kinds
// it covers, plus role and identity which the browser has always offered.

export const INSTRUCTION_TEMPLATES = {
  emotion: (value) => `你说话的情感是${value}。`,
  scene: (value) => `你正在进行${value}，你说话的情感是neutral。`,
  role: (value) => `你现在说话的角色是${value}，你说话的情感是neutral。`,
  identity: (value) => `你正在以一个${value}的身份说话，你说话的情感是neutral。`,
  dialect: (value) => `请用${value}表达。`,
};

/**
 * Builds the instruction string, or '' when there is nothing to say.
 *
 * `custom` passes the user's text through untouched: they wrote the sentence
 * the API will receive, and rewriting it would only get it rejected.
 */
export function buildInstruction(kind, value, custom = '') {
  const trimmedValue = (value || '').trim();
  const trimmedCustom = (custom || '').trim();
  if (kind === 'custom') return trimmedCustom;
  const template = INSTRUCTION_TEMPLATES[kind];
  if (!template || !trimmedValue) return '';
  return template(trimmedValue);
}

/**
 * Scene and dialect acceptance is per voice, and a cloned voice is not in
 * server/voices.py's capability table, so these cannot be filtered up front.
 * The caller is expected to show a warning rather than hide the options.
 */
export const VOICE_DEPENDENT_KINDS = ['scene', 'dialect', 'role', 'identity'];

/**
 * Values offered for a kind.
 *
 * `emotionValues` and `sceneValues` and `dialectValues` come from the server so
 * the lists stay in step with the catalogue; the defaults below are only used
 * for a cloned voice, where the server has no per-voice entry to offer.
 */
export function instructionValues(kind, {
  emotionValues = [],
  sceneValues = [],
  dialectValues = [],
  labels = {},
} = {}) {
  const raw =
    kind === 'emotion' ? emotionValues
    : kind === 'scene' ? sceneValues
    : kind === 'dialect' ? dialectValues
    : [];
  // Emotion values are English enums. Show the Chinese first and keep the
  // English on screen so anyone debugging knows what actually gets sent.
  return raw.map((value) => ({ value, label: labels[value] ? `${labels[value]}（${value}）` : value }));
}

/** Is this kind's acceptance dependent on the specific voice? */
export function isVoiceDependent(kind) {
  return VOICE_DEPENDENT_KINDS.includes(kind);
}