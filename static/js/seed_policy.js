// 种子策略。
//
// 独立成模块的原因和 tag_rules.js 一样：tab_tts.js 依赖 app.js，而 app.js 在
// 模块顶层就调用 boot() 碰 document，Node 里 import 会直接炸。纯函数才好单测。
//
// 背景：record.params 在 createRecord() 时算好就冻结了，之后每次请求都发同一份。
// 如果不处理，重新生成会返回逐字节相同的音频 —— 按钮点了跟没点一样。

/** 与 server/tts_support.py 的 clamp 保持一致。 */
export const SEED_MAX = 65535;

/** 0–65535 的随机种子。 */
export function randomSeed() {
  return Math.floor(Math.random() * (SEED_MAX + 1));
}

/**
 * 把输入框的值变成一个必定合法的种子。
 *
 * 留空时返回随机值而不是「不发 seed」：占位符写着「随机」，那就真的随机一个，
 * 而且记下来 —— 这样任何一次生成都可复现，用户只要把数字填回种子框就能重来。
 */
export function resolveSeed(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') return randomSeed();

  const parsed = Number(raw);
  // 输入框是 type=number，但粘贴和程序赋值仍可能带来 NaN/Infinity。
  if (!Number.isFinite(parsed)) return randomSeed();
  return Math.min(SEED_MAX, Math.max(0, Math.trunc(parsed)));
}

/**
 * 这一句该用哪个种子。
 *
 * 首次生成沿用记录基线的种子（用户填了就尊重他）；之后每次都换一个新的，
 * 否则「重新生成」拿到的还是同一份音频。
 *
 * 用 `== null` 而不是 `=== undefined`：句子要存进 IndexedDB 再读回来，
 * 字段可能变成 null，两种都算「还没生成过」。
 *
 * 不修改参数，由调用方赋值 `sentence.seed = nextSeed(record, sentence)`。
 */
export function nextSeed(record, sentence) {
  if (sentence.seed == null) return record.params.seed ?? randomSeed();
  return randomSeed();
}